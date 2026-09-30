import { slotGrid } from '../src/calendar.js';
import type { DaySlotNamespace } from '../src/actors/day_slot_binding.js';
import { MockKvNamespace } from './mock_kv.js';

/** Fixed clinic "today" so tests don't rot as the real calendar moves. Oct 5-9 2026 are Mon-Fri. */
export const TODAY = '2026-09-01';
export const MON = '2026-10-05';
export const TUE = '2026-10-06';
export const WED = '2026-10-07';
export const SAT = '2026-10-10';
export const SUN = '2026-10-04';

export const PHONE = '+15551234567';
export const PHONE_B = '+15559998888';

/** The n-th start time the mock calendar marks open for this service (0 = first). */
export function openSlot(service: string, date: string, n = 0): string {
  const open = slotGrid(service, date).filter((s) => s.available);
  if (!open[n]) throw new Error(`fixture: no open slot #${n} for ${service} on ${date}`);
  return open[n].start;
}

export const bookInput = (over: Record<string, unknown> = {}) => ({
  service: 'cleaning',
  date: TUE,
  start: openSlot('cleaning', TUE),
  patientName: 'Ada Lovelace',
  patientPhone: PHONE,
  ...over,
});

export const kvCtx = (kv = new MockKvNamespace(), daySlot?: DaySlotNamespace) => ({ kv, daySlot, today: TODAY });

/** A start time that is open on the mock calendar for BOTH services (so a same-start collision is the only obstacle). */
export function commonOpenSlot(a: string, b: string, date: string, n = 0): string {
  const inB = new Set(slotGrid(b, date).filter((s) => s.available).map((s) => s.start));
  const both = slotGrid(a, date).filter((s) => s.available && inB.has(s.start));
  if (!both[n]) throw new Error(`fixture: no common open slot #${n} for ${a}/${b} on ${date}`);
  return both[n].start;
}
