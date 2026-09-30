import type { KvNamespace } from '@telnyx/edge-runtime';

/**
 * The clinic's (mock) calendar: which slots exist, whether a request is a real bookable slot, and
 * whether it collides with bookings already made. `check_availability`, `book_appointment` and
 * `cancel_or_reschedule_appointment` all go through here so the read side (what we offer) and the
 * write side (what we accept) can never disagree.
 *
 * The DaySlotActor still owns race-safety for the exact same start time; this module adds what the
 * actor can't see (it keys holds by start time only): real-calendar validity and overlap between
 * appointments of different lengths.
 */

export const CLINIC_TZ = 'America/Chicago';
export const CLINIC_OPEN_MINUTES = 9 * 60;
export const CLINIC_CLOSE_MINUTES = 17 * 60;

export const SERVICE_DURATION_MINUTES: Readonly<Record<string, number>> = {
  cleaning: 30,
  exam: 30,
  'root-canal': 90,
  filling: 60,
  extraction: 45,
};
export const KNOWN_SERVICES = Object.keys(SERVICE_DURATION_MINUTES);

export interface Slot {
  start: string;
  end: string;
  available: boolean;
}

/** A booking/{date}/{HHMM} record; only service + start are needed for collision checks. */
export interface BookedAppointment {
  service: string;
  start: string;
  appointmentId?: string;
  patientName?: string;
  patientPhone?: string;
  date?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const toHHMM = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Today's date (YYYY-MM-DD) at the clinic, not in UTC. */
export function todayAtClinic(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CLINIC_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** null when `date` is a bookable clinic day, otherwise why not. */
export function dateProblem(date: string, today: string = todayAtClinic()): string | null {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return 'not a real calendar date';
  if (date < today) return 'that date is in the past';
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return 'the clinic is closed on weekends';
  return null;
}

/** Back-to-back slots of the service's length across opening hours; none run past closing time. */
export function slotGrid(service: string, date: string): Slot[] {
  const duration = SERVICE_DURATION_MINUTES[service];
  if (!duration) return [];
  const slots: Slot[] = [];
  for (let t = CLINIC_OPEN_MINUTES; t + duration <= CLINIC_CLOSE_MINUTES; t += duration) {
    // Deterministic stand-in for "the calendar backend says this one is busy".
    const seed = (t + service.length + date.length) % 7;
    slots.push({ start: toHHMM(t), end: toHHMM(t + duration), available: seed !== 0 });
  }
  return slots;
}

/** Two appointments collide when their time ranges overlap (touching end-to-start is fine). */
export function overlaps(a: { service: string; start: string }, b: { service: string; start: string }): boolean {
  const aStart = toMinutes(a.start);
  const bStart = toMinutes(b.start);
  const aEnd = aStart + (SERVICE_DURATION_MINUTES[a.service] ?? 30);
  const bEnd = bStart + (SERVICE_DURATION_MINUTES[b.service] ?? 30);
  return aStart < bEnd && bStart < aEnd;
}

export type SlotProblem =
  | { reason: 'invalid_slot'; detail: string }
  | { reason: 'slot_unavailable'; detail: string }
  | { reason: 'slot_already_booked'; detail: string };

/**
 * Pure checks: known service, real future weekday, and a start time that is on that service's grid
 * and not marked busy. (Collisions with existing bookings are checked separately, against KV.)
 */
export function validateSlot(service: string, date: string, start: string, today?: string): SlotProblem | null {
  if (!SERVICE_DURATION_MINUTES[service]) {
    return { reason: 'invalid_slot', detail: `unknown service "${service}"; use one of: ${KNOWN_SERVICES.join(', ')}` };
  }
  const bad = dateProblem(date, today);
  if (bad) return { reason: 'invalid_slot', detail: bad };
  const slot = slotGrid(service, date).find((s) => s.start === start);
  if (!slot) return { reason: 'invalid_slot', detail: `${start} is not a ${service} start time; call check_availability for valid slots` };
  if (!slot.available) return { reason: 'slot_unavailable', detail: `${start} is not available` };
  return null;
}

export const bookingPrefix = (date: string) => `booking/${date}/`;

/** Every appointment already booked on `date` (booking/{date}/{HHMM} records). */
export async function loadDayBookings(kv: KvNamespace, date: string): Promise<BookedAppointment[]> {
  const listed = await kv.list({ prefix: bookingPrefix(date) });
  const records = await Promise.all(
    listed.keys.map((k) => kv.get<BookedAppointment>(k.name, { type: 'json' })),
  );
  return records.filter((r): r is BookedAppointment => !!r && typeof r.start === 'string' && typeof r.service === 'string');
}

/** The first existing booking that collides with the requested one, if any. */
export function findConflict(
  wanted: { service: string; start: string },
  booked: BookedAppointment[],
  ignore?: { service: string; start: string },
): BookedAppointment | undefined {
  return booked.find((b) => !(ignore && b.start === ignore.start && b.service === ignore.service) && overlaps(wanted, b));
}
