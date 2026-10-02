import { z } from 'zod';
import { isDialablePhone } from '../patients.js';

export const bookAppointmentInputSchema = z.object({
  service: z
    .string()
    .min(1)
    .describe('The dental service being booked: cleaning, exam, filling, extraction or root-canal.'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .describe('The clinic date to book, in YYYY-MM-DD format (a future weekday).'),
  start: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'start must be HH:MM (24h)')
    .describe('The slot start time, in 24h HH:MM format, exactly as returned by check_availability.'),
  patientName: z.string().min(1).describe("The patient's full name."),
  patientPhone: z
    .string()
    .refine(isDialablePhone, 'patientPhone must contain at least 10 digits (include the area code)')
    .describe(
      "The patient's callback phone number with area code (at least 10 digits). If the caller says " +
        '"this number", use the caller\'s own number from the conversation context.',
    ),
});

export type BookAppointmentInput = z.infer<typeof bookAppointmentInputSchema>;

export interface AppointmentRecord {
  appointmentId: string;
  service: string;
  date: string;
  start: string;
  patientName: string;
  patientPhone: string;
}

export interface BookAppointmentResult {
  confirmed: boolean;
  appointment?: AppointmentRecord;
  /**
   * slot_already_booked: someone else holds that time (or an overlapping appointment does).
   * invalid_slot: not a real bookable slot (unknown service, past/weekend/invalid date, off-grid time).
   * slot_unavailable: on the grid but marked busy.
   */
  reason?: 'slot_already_booked' | 'invalid_slot' | 'slot_unavailable';
  detail?: string;
  /** True when this exact booking already existed for this patient (safe retry). */
  alreadyBookedByYou?: boolean;
  /**
   * How many times this caller has now hit slot_already_booked for this date during the current
   * booking effort (server-side counter, incremented on each slot_already_booked return, reset to 0
   * on a successful confirm). The assistant is told to mirror this into the `attempt_count`
   * conversation variable (via the update_dynamic_variables tool) so the n_book -> n_waitlist edge's
   * `attempt_count >= 3` comparison can fire. 0 on success or non-booking-failure paths.
   */
  attempt_count?: number;
  /**
   * True when attempt_count has reached the waitlist threshold (3) on this call, signalling the
   * assistant should join the caller to the waitlist and move to the waitlist node. Set together
   * with attempt_count so the assistant has a deterministic flag, not just a count to compare.
   */
  should_waitlist?: boolean;
}

export const BOOK_APPOINTMENT_TOOL_NAME = 'book_appointment';

export const BOOK_APPOINTMENT_TOOL_DESCRIPTION =
  'Book a specific appointment slot for a patient. Call check_availability first and pass a ' +
  'start time exactly as it returned it. The slot is validated (real future weekday, on the ' +
  "service's grid, not overlapping another appointment) and conflict-safety for the exact start " +
  'time is owned by the DAY_SLOT Stateful Actor (one instance per clinic day, serializing ' +
  'hold+confirm) - two callers racing for the same slot cannot both win. Retrying an identical ' +
  'booking for the same phone returns the existing appointment. If DAY_SLOT is not bound ' +
  '(local dev) this falls back to a best-effort KV check that is NOT race-safe.';

export const BOOKING_KEY = (date: string, start: string) => `booking/${date}/${start.replace(/:/g, '')}`;
export const APPOINTMENT_KEY = (appointmentId: string) => `appointment/${appointmentId}`;

// Per-caller, per-date failed-booking counter. Incremented every time book_appointment returns
// slot_already_booked, reset to 0 on a successful confirm. Scoped by phone+date so the count is for
// the specific day the caller is fighting for; a past date's counter is naturally irrelevant. This
// is the server-side source of truth the attempt_count variable the n_book -> n_waitlist edge reads
// is meant to mirror (the assistant copies it into the conversation variable via the
// update_dynamic_variables tool after each book_appointment result that includes attempt_count).
export const WAITLIST_ATTEMPTS_KEY = (date: string, phone: string) =>
  `waitlist_attempts/${date}/${phone.replace(/\D/g, '').slice(-10)}`;

/** The threshold at which the waitlist edge should fire. Kept here so tests and the flow align. */
export const WAITLIST_THRESHOLD = 3;
