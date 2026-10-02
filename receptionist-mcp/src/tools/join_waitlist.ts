import { z } from 'zod';
import { isDialablePhone } from '../patients.js';

export const joinWaitlistInputSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .describe('The clinic date the caller wants an appointment for, in YYYY-MM-DD format.'),
  service: z
    .string()
    .min(1)
    .describe('The dental service being requested: cleaning, exam, filling, extraction or root-canal.'),
  patientName: z.string().min(1).describe("The patient's full name."),
  patientPhone: z
    .string()
    .refine(isDialablePhone, 'patientPhone must contain at least 10 digits (include the area code)')
    .describe(
      "The patient's callback phone number with area code (at least 10 digits). If the caller says " +
        '"this number", use the caller\'s own number from the conversation context.',
    ),
});

export type JoinWaitlistInput = z.infer<typeof joinWaitlistInputSchema>;

export interface WaitlistEntry {
  entryId: string;
  date: string;
  service: string;
  patientName: string;
  patientPhone: string;
  joinedAt: string;
}

export interface JoinWaitlistResult {
  /** True when a waitlist entry was persisted for this caller and date. */
  queued: boolean;
  entry?: WaitlistEntry;
  /** True when this caller is already on the waitlist for this date (safe retry). */
  alreadyQueuedByYou?: boolean;
}

export const JOIN_WAITLIST_TOOL_NAME = 'join_waitlist';

export const JOIN_WAITLIST_TOOL_DESCRIPTION =
  'Add the caller to the waitlist for a fully-booked appointment date. Call this only after the ' +
  'caller has tried and failed to book a slot at least three times in this conversation (each ' +
  'booking attempt returned slot_already_booked), and they have agreed to be put on the waitlist. ' +
  'Persists the request under waitlist/{date}/{phone10} in KV, so it can be retrieved by the team ' +
  'later. Returns queued true once the request is actually recorded.';

// KV key charset is a-zA-Z0-9 - _ / = . ( Telnyx KV rejects ':' with error 10015 ). The phone is
// reduced to its last 10 digits so "+15551234567" and "555-123-4567" map to the same key — same
// convention as patient/{phone10}. One entry per caller per date: a retry for an already-queued
// caller+date returns the ORIGINAL entry unchanged (no update to service/name — see handler).
// A caller wanting to change their waitlist service would have to be removed and re-added, which
// the current tools don't expose; the team-side workflow can edit the KV key directly if needed.
export const WAITLIST_KEY = (date: string, phone: string) => {
  const digits = phone.replace(/\D/g, '').slice(-10);
  return `waitlist/${date}/${digits}`;
};
