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

type SlotStatus = 'held' | 'booked';

interface SlotRecord {
  status: SlotStatus;
  callerId: string;
  holdExpiresAt?: number; // ms epoch; only present while status === 'held'
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

const slotKey = (start: string) => `slot:${start}`;
const SLOT_KEY_PREFIX = 'slot:';

export class DaySlotActor extends StatefulActor {
  async holdSlot(
    start: string,
    callerId: string,
    holdDurationMs: number = DEFAULT_HOLD_DURATION_MS,
  ): Promise<HoldSlotResult> {
    const key = slotKey(start);
    const existing = await this.ctx.storage.get<SlotRecord>(key);
    const now = Date.now();

    if (existing?.status === 'booked') {
      return { success: false, reason: 'already_booked' };
    }
    if (existing?.status === 'held' && existing.callerId !== callerId && (existing.holdExpiresAt ?? 0) > now) {
      return { success: false, reason: 'already_held_by_other' };
    }

    const holdExpiresAt = now + holdDurationMs;
    await this.ctx.storage.put<SlotRecord>(key, { status: 'held', callerId, holdExpiresAt });
    await this.rescheduleAlarm();

    return { success: true, holdExpiresAt };
  }

  async confirmSlot(start: string, callerId: string): Promise<ConfirmSlotResult> {
    const key = slotKey(start);
    const existing = await this.ctx.storage.get<SlotRecord>(key);
    const now = Date.now();

    if (!existing || existing.status !== 'held') {
      return { success: false, reason: 'not_held' };
    }
    if (existing.callerId !== callerId) {
      return { success: false, reason: 'held_by_other' };
    }
    if ((existing.holdExpiresAt ?? 0) <= now) {
      // Already expired; the alarm just hasn't swept it yet. Treat as gone.
      await this.ctx.storage.delete(key);
      await this.rescheduleAlarm();
      return { success: false, reason: 'hold_expired' };
    }

    await this.ctx.storage.put<SlotRecord>(key, { status: 'booked', callerId });
    await this.rescheduleAlarm();

    return { success: true };
  }

  async releaseSlot(start: string, callerId: string): Promise<ReleaseSlotResult> {
    const key = slotKey(start);
    const existing = await this.ctx.storage.get<SlotRecord>(key);

    if (!existing || existing.callerId !== callerId) {
      return { success: false, reason: 'not_held_by_caller' };
    }

    await this.ctx.storage.delete(key);
    await this.rescheduleAlarm();

    return { success: true };
  }

  async getSlot(start: string): Promise<SlotRecord | undefined> {
    return this.ctx.storage.get<SlotRecord>(slotKey(start));
  }

  /** At-least-once delivery — sweeping an already-expired/removed hold is a safe no-op. */
  override async alarm(_alarmInfo: AlarmInfo): Promise<void> {
    const now = Date.now();
    const slots = await this.ctx.storage.list<SlotRecord>({ prefix: SLOT_KEY_PREFIX });

    for (const [key, record] of slots) {
      if (record.status === 'held' && (record.holdExpiresAt ?? 0) <= now) {
        await this.ctx.storage.delete(key);
      }
    }

    await this.rescheduleAlarm();
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
