import { StatefulActor, type AlarmInfo } from '@telnyx/edge-runtime';

/**
 * One instance per clinic-day (actor id = "YYYY-MM-DD"). Owns that day's slot
 * map so two callers racing for the same start time can't both win — the
 * actor's single-threaded per-instance execution serializes holdSlot calls,
 * which is exactly the read-check-write the MCP server's own KV-based booking
 * (receptionist-mcp) can't do safely on its own. See docs/ARCHITECTURE.md.
 *
 * Slot lifecycle: held (with an expiry) -> booked, or held -> expired (swept
 * by the alarm) -> gone. A booked slot only leaves via releaseSlot.
 *
 * IMPORTANT: the runtime gives each actor exactly one alarm (ctx.setAlarm),
 * not one per pending hold. Every call that changes a hold's expiry must
 * recompute and reschedule the single alarm to the earliest pending
 * expiration across all held slots in this actor.
 */

export const DEFAULT_HOLD_DURATION_MS = 3 * 60 * 1000; // 3 minutes, per ARCHITECTURE.md
export const QUANTUM_MINUTES = 30;

type SlotStatus = 'held' | 'booked';

interface SlotRecord {
  status: SlotStatus;
  callerId: string;
  holdExpiresAt?: number; // ms epoch; only present while status === 'held'
  durationMinutes?: number; // appointment duration; stored on all quantums for consistency
  isPrimary?: boolean; // true on the primary quantum (the start slot)
}

export interface HoldSlotResult {
  success: boolean;
  holdExpiresAt?: number;
  reason?: 'already_booked' | 'already_held_by_other';
}

export interface ConfirmSlotResult {
  success: boolean;
  reason?: 'not_held' | 'held_by_other' | 'hold_expired';
}

export interface ReleaseSlotResult {
  success: boolean;
  reason?: 'not_held_by_caller';
}

export interface StatsResult {
  conversions: number;
  expirations: number;
  conversionRate: string;
}

const slotKey = (start: string) => `slot:${start}`;
const SLOT_KEY_PREFIX = 'slot:';
const STATS_KEY = 'stats';

/** Parse "HH:MM" into total minutes from midnight. */
function parseTime(start: string): number {
  const [h, m] = start.split(':').map((s) => parseInt(s, 10));
  return h * 60 + m;
}

/** Format minutes from midnight back to "HH:MM". */
function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Return every 30-min quantum start time covered by an appointment of `durationMinutes` starting at `start`. */
function quantumStarts(start: string, durationMinutes: number): string[] {
  const starts: string[] = [];
  const startMin = parseTime(start);
  const quantums = Math.max(1, Math.ceil(durationMinutes / QUANTUM_MINUTES));
  for (let i = 0; i < quantums; i++) {
    starts.push(formatTime(startMin + i * QUANTUM_MINUTES));
  }
  return starts;
}

export class DaySlotActor extends StatefulActor {
  async holdSlot(
    start: string,
    callerId: string,
    durationMinutes: number = QUANTUM_MINUTES,
    holdDurationMs: number = DEFAULT_HOLD_DURATION_MS,
  ): Promise<HoldSlotResult> {
    const quantums = quantumStarts(start, durationMinutes);
    const now = Date.now();

    // Phase 1: read-check every quantum before writing any.
    for (const q of quantums) {
      const existing = await this.ctx.storage.get<SlotRecord>(slotKey(q));
      if (existing?.status === 'booked') {
        return { success: false, reason: 'already_booked' };
      }
      if (existing?.status === 'held' && existing.callerId !== callerId && (existing.holdExpiresAt ?? 0) > now) {
        return { success: false, reason: 'already_held_by_other' };
      }
    }

    // Phase 2: atomically write all quantums.
    const holdExpiresAt = now + holdDurationMs;
    for (let i = 0; i < quantums.length; i++) {
      await this.ctx.storage.put<SlotRecord>(slotKey(quantums[i]), {
        status: 'held',
        callerId,
        holdExpiresAt,
        durationMinutes,
        isPrimary: i === 0,
      });
    }
    await this.rescheduleAlarm();

    return { success: true, holdExpiresAt };
  }

  async confirmSlot(start: string, callerId: string): Promise<ConfirmSlotResult> {
    const primaryKey = slotKey(start);
    const primary = await this.ctx.storage.get<SlotRecord>(primaryKey);
    const now = Date.now();

    if (!primary || primary.status !== 'held') {
      return { success: false, reason: 'not_held' };
    }
    if (primary.callerId !== callerId) {
      return { success: false, reason: 'held_by_other' };
    }
    if ((primary.holdExpiresAt ?? 0) <= now) {
      await this.ctx.storage.delete(primaryKey);
      await this.rescheduleAlarm();
      return { success: false, reason: 'hold_expired' };
    }

    const quantums = quantumStarts(start, primary.durationMinutes ?? QUANTUM_MINUTES);
    for (const q of quantums) {
      await this.ctx.storage.put<SlotRecord>(slotKey(q), { status: 'booked', callerId, durationMinutes: primary.durationMinutes });
    }

    // Count conversion
    await this.incrementStat('conversions');
    await this.rescheduleAlarm();

    return { success: true };
  }

  async releaseSlot(start: string, callerId: string): Promise<ReleaseSlotResult> {
    const primaryKey = slotKey(start);
    const primary = await this.ctx.storage.get<SlotRecord>(primaryKey);

    if (!primary || primary.callerId !== callerId) {
      return { success: false, reason: 'not_held_by_caller' };
    }

    const quantums = quantumStarts(start, primary.durationMinutes ?? QUANTUM_MINUTES);
    for (const q of quantums) {
      await this.ctx.storage.delete(slotKey(q));
    }
    await this.rescheduleAlarm();

    return { success: true };
  }

  async getSlot(start: string): Promise<SlotRecord | undefined> {
    return this.ctx.storage.get<SlotRecord>(slotKey(start));
  }

  async getStats(): Promise<StatsResult> {
    const stats = await this.ctx.storage.get<{ conversions: number; expirations: number }>(STATS_KEY);
    const conversions = stats?.conversions ?? 0;
    const expirations = stats?.expirations ?? 0;
    const total = conversions + expirations;
    const rate = total === 0 ? '0.00%' : `${((conversions / total) * 100).toFixed(2)}%`;
    return { conversions, expirations, conversionRate: rate };
  }

  /** At-least-once delivery — sweeping an already-expired/removed hold is a safe no-op. */
  override async alarm(_alarmInfo: AlarmInfo): Promise<void> {
    const now = Date.now();
    const slots = await this.ctx.storage.list<SlotRecord>({ prefix: SLOT_KEY_PREFIX });

    for (const [key, record] of slots) {
      if (record.status === 'held' && (record.holdExpiresAt ?? 0) <= now) {
        await this.ctx.storage.delete(key);
        // Only count expiration on the primary quantum (one logical hold).
        if (record.isPrimary) {
          await this.incrementStat('expirations');
        }
      }
    }

    await this.rescheduleAlarm();
  }

  private async incrementStat(field: 'conversions' | 'expirations'): Promise<void> {
    const current = await this.ctx.storage.get<{ conversions: number; expirations: number }>(STATS_KEY);
    const next = { conversions: current?.conversions ?? 0, expirations: current?.expirations ?? 0 };
    next[field]++;
    await this.ctx.storage.put(STATS_KEY, next);
  }

  private async rescheduleAlarm(): Promise<void> {
    const slots = await this.ctx.storage.list<SlotRecord>({ prefix: SLOT_KEY_PREFIX });

    let earliest: number | undefined;
    for (const record of slots.values()) {
      if (record.status === 'held' && record.holdExpiresAt !== undefined) {
        earliest = earliest === undefined ? record.holdExpiresAt : Math.min(earliest, record.holdExpiresAt);
      }
    }

    if (earliest === undefined) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(earliest);
    }
  }
}
