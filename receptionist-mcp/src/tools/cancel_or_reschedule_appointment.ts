import { z } from 'zod';

export const cancelOrRescheduleInputSchema = z.object({
  appointmentId: z.string().uuid().describe('The appointment ID returned by book_appointment.'),
  action: z.enum(['cancel', 'reschedule']).describe('Whether to cancel the appointment outright or move it to a new slot.'),
  newDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'newDate must be YYYY-MM-DD')
    .optional()
    .describe('Required when action is "reschedule": the new date, YYYY-MM-DD.'),
  newStart: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'newStart must be HH:MM (24h)')
    .optional()
    .describe('Required when action is "reschedule": the new slot start time, HH:MM.'),
});

export type CancelOrRescheduleInput = z.infer<typeof cancelOrRescheduleInputSchema>;

export interface CancelOrRescheduleResult {
  success: boolean;
  action: 'cancel' | 'reschedule';
  appointmentId: string;
  newDate?: string;
  newStart?: string;
  reason?:
    | 'appointment_not_found'
    | 'missing_new_slot'
    | 'new_slot_already_booked'
    | 'invalid_slot'
    | 'slot_unavailable';
  detail?: string;
}

export const CANCEL_OR_RESCHEDULE_TOOL_NAME = 'cancel_or_reschedule_appointment';

export const CANCEL_OR_RESCHEDULE_TOOL_DESCRIPTION =
  'Cancel an existing appointment, or move it to a new date/time. For reschedule, pass ' +
  'newDate and newStart (call check_availability first to confirm the new slot is open). ' +
  'Same race-safety caveat as book_appointment — see that tool\'s description.';
