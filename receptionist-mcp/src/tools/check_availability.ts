import { z } from 'zod';

export const checkAvailabilityInputSchema = z.object({
  service: z
    .string()
    .min(1)
    .describe('The dental service to check availability for (e.g. "cleaning", "exam", "root-canal").'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .describe('The clinic date to check, in YYYY-MM-DD format.'),
});

export type CheckAvailabilityInput = z.infer<typeof checkAvailabilityInputSchema>;

export interface AvailabilitySlot {
  start: string;
  end: string;
  available: boolean;
}

export interface CheckAvailabilityResult {
  service: string;
  date: string;
  slots: AvailabilitySlot[];
  /** Present when no slots are offered, saying why (past date, weekend, unknown service...). */
  note?: string;
}

export const CHECK_AVAILABILITY_TOOL_NAME = 'check_availability';

export const CHECK_AVAILABILITY_TOOL_DESCRIPTION =
  'Check available appointment slots for a dental service (cleaning, exam, filling, extraction, ' +
  'root-canal) on a future weekday. Slots already booked - including ones overlapping a longer ' +
  'appointment - are reported as unavailable, so what you offer matches what book_appointment ' +
  'will accept. Offer only slots with available: true, and pass their start time unchanged to book_appointment.';
