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
