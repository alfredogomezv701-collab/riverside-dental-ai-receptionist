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
  cursor: z
    .string()
    .optional()
    .describe(
      'Opaque pagination cursor from a previous call\'s next_cursor. ' +
      'Pass it to fetch the next page of open slots (the first call omits it).',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Maximum number of open slots to return in this page (default 3, max 100). ' +
      'Use a large value (e.g. 100) only when you need every open slot at once; ' +
      'for offering a caller a few choices, leave the default and page with next_cursor.',
    ),
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
  /** Only slots with available: true, sliced to `limit` starting after `cursor`. */
  slots: AvailabilitySlot[];
  /** Total open slots for the day (across all pages) — lets the model mention "5 more openings". */
  total_available: number;
  /** Present when there is another page; pass its value as cursor on the next call. */
  next_cursor?: string;
  /** Present when no slots are offered, saying why (past date, weekend, unknown service...). */
  note?: string;
}

export const CHECK_AVAILABILITY_TOOL_NAME = 'check_availability';

export const DEFAULT_PAGE_SIZE = 3;
export const MAX_PAGE_SIZE = 100;

export const CHECK_AVAILABILITY_TOOL_DESCRIPTION =
  'Check available appointment slots for a dental service (cleaning, exam, filling, extraction, ' +
  'root-canal) on a future weekday. Slots already booked - including ones overlapping a longer ' +
  'appointment - are excluded from the response entirely: every slot in the response is bookable, ' +
  'so what you offer matches what book_appointment will accept. Results are PAGINATED: each call ' +
  `returns up to ${DEFAULT_PAGE_SIZE} open slots (override with limit, up to ${MAX_PAGE_SIZE}) plus ` +
  'a next_cursor when more are available; call again with that cursor to fetch the next page. ' +
  'Offer the slots from one page to the caller; if none suit them, either call again with ' +
  'next_cursor for more open slots on the same day, or ask for a different date and call without a ' +
  'cursor. Pass each offered slot\'s start time unchanged to book_appointment.';
