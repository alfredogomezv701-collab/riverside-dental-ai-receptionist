import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KvNamespace } from '@telnyx/edge-runtime';
import type { DaySlotNamespace } from '../actors/day_slot_binding.js';
import { findConflict, loadDayBookings, validateSlot } from '../calendar.js';
import { logToolCall } from '../log.js';
import { readPatient, withMovedAppointment, withoutAppointment, writePatient } from '../patients.js';
import {
  CANCEL_OR_RESCHEDULE_TOOL_NAME,
  CANCEL_OR_RESCHEDULE_TOOL_DESCRIPTION,
  cancelOrRescheduleInputSchema,
  type CancelOrRescheduleInput,
  type CancelOrRescheduleResult,
} from './cancel_or_reschedule_appointment.js';
import { BOOKING_KEY, APPOINTMENT_KEY, type AppointmentRecord } from './book_appointment.js';

export interface ToolContext {
  kv: KvNamespace | undefined;
  daySlot: DaySlotNamespace | undefined;
  requestId?: string;
  /** Clinic-local "today" (YYYY-MM-DD); injectable so tests don't rot as the calendar moves. */
  today?: string;
}

export async function runCancelOrReschedule(
  input: CancelOrRescheduleInput,
  ctx: ToolContext,
): Promise<CancelOrRescheduleResult> {
  const notFound = (action: 'cancel' | 'reschedule'): CancelOrRescheduleResult => ({
    success: false,
    action,
    appointmentId: input.appointmentId,
    reason: 'appointment_not_found',
  });

  if (!ctx.kv) return notFound(input.action);
  const kv = ctx.kv;

  const existing = await kv.get<AppointmentRecord>(APPOINTMENT_KEY(input.appointmentId), { type: 'json' });
  if (!existing) return notFound(input.action);

  if (input.action === 'cancel') {
    // Free the slot first, then drop the records. If a delete fails the call errors and a retry is
    // safe: releasing an already-released slot is a harmless no-op, and the appointment still exists.
    const [patient] = await Promise.all([
      readPatient(kv, existing.patientPhone, APPOINTMENT_KEY),
      // Best-effort: even if the actor no longer has this slot (e.g. an expired hold was swept), the
      // appointment is still cancelled from the patient's point of view - the KV deletes are authoritative.
      ctx.daySlot?.idFromName(existing.date).releaseSlot(existing.start, existing.patientPhone),
    ]);
    await Promise.all([
      kv.delete(APPOINTMENT_KEY(input.appointmentId)),
      kv.delete(BOOKING_KEY(existing.date, existing.start)),
      writePatient(kv, existing.patientPhone, withoutAppointment(patient, input.appointmentId) ?? { patientName: '', appointments: [] }),
    ]);
    return { success: true, action: 'cancel', appointmentId: input.appointmentId };
  }

  if (!input.newDate || !input.newStart) {
    return { success: false, action: 'reschedule', appointmentId: input.appointmentId, reason: 'missing_new_slot' };
  }
  const { newDate, newStart } = input;
  const fail = (reason: NonNullable<CancelOrRescheduleResult['reason']>, detail?: string): CancelOrRescheduleResult => ({
    success: false,
    action: 'reschedule',
    appointmentId: input.appointmentId,
    reason,
    ...(detail ? { detail } : {}),
  });

  if (newDate === existing.date && newStart === existing.start) {
    return { success: true, action: 'reschedule', appointmentId: input.appointmentId, newDate, newStart };
  }
  const bad = validateSlot(existing.service, newDate, newStart, ctx.today);
  if (bad) return fail(bad.reason === 'slot_already_booked' ? 'new_slot_already_booked' : bad.reason, bad.detail);

  // Secure the NEW slot before touching the old one - a failed reschedule must leave the patient's
  // original booking intact, not lose it.
  const newStub = ctx.daySlot?.idFromName(newDate);
  const [dayBookings, patient, hold] = await Promise.all([
    loadDayBookings(kv, newDate),
    readPatient(kv, existing.patientPhone, APPOINTMENT_KEY),
    newStub ? newStub.holdSlot(newStart, existing.patientPhone) : Promise.resolve(undefined),
  ]);
  const held = hold?.success === true;
  const releaseNew = async () => {
    if (held && newStub) await newStub.releaseSlot(newStart, existing.patientPhone).catch(() => undefined);
  };
  if (newStub && !held) return fail('new_slot_already_booked');

  const sameDay = newDate === existing.date ? { service: existing.service, start: existing.start } : undefined;
  const clash = findConflict({ service: existing.service, start: newStart }, dayBookings, sameDay);
  if (clash) {
    await releaseNew();
    return fail('new_slot_already_booked', `overlaps an existing ${clash.service} appointment at ${clash.start}`);
  }

  if (newStub) {
    const confirm = await newStub.confirmSlot(newStart, existing.patientPhone);
    if (!confirm.success) {
      await releaseNew();
      return fail('new_slot_already_booked');
    }
  }

  const updated: AppointmentRecord = { ...existing, date: newDate, start: newStart };
  const record = JSON.stringify(updated);
  // Wait for ALL the writes (not Promise.all, which returns on the first failure while the rest are
  // still landing) so that on a failure we know exactly what to undo.
  const writes = await Promise.allSettled([
    kv.put(BOOKING_KEY(newDate, newStart), record),
    kv.put(APPOINTMENT_KEY(input.appointmentId), record),
    writePatient(
      kv,
      existing.patientPhone,
      withMovedAppointment(patient, {
        appointmentId: input.appointmentId,
        service: existing.service,
        date: newDate,
        start: newStart,
      }) ?? { patientName: existing.patientName, appointments: [] },
    ),
  ]);
  const failed = writes.find((w): w is PromiseRejectedResult => w.status === 'rejected');
  if (failed) {
    // The new slot is confirmed but the records didn't all land. Give it back so it isn't
    // booked-with-no-owner, and restore whatever did land so the patient still has exactly the
    // appointment they had (the old booking record and old slot were never touched).
    await releaseNew();
    await Promise.allSettled([
      kv.delete(BOOKING_KEY(newDate, newStart)),
      kv.put(APPOINTMENT_KEY(input.appointmentId), JSON.stringify(existing)),
      patient ? writePatient(kv, existing.patientPhone, patient) : Promise.resolve(),
    ]);
    throw failed.reason;
  }

  // Only now let go of the old slot. Failures here leave a stale busy marker, never a lost booking.
  await Promise.allSettled([
    kv.delete(BOOKING_KEY(existing.date, existing.start)),
    ctx.daySlot?.idFromName(existing.date).releaseSlot(existing.start, existing.patientPhone),
  ]);

  return { success: true, action: 'reschedule', appointmentId: input.appointmentId, newDate, newStart };
}

export function registerCancelOrReschedule(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    CANCEL_OR_RESCHEDULE_TOOL_NAME,
    {
      description: CANCEL_OR_RESCHEDULE_TOOL_DESCRIPTION,
      inputSchema: cancelOrRescheduleInputSchema.shape,
    },
    async (input: CancelOrRescheduleInput) => {
      const result = await logToolCall(CANCEL_OR_RESCHEDULE_TOOL_NAME, ctx.requestId, { action: input.action }, () =>
        runCancelOrReschedule(input, ctx),
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );
}
