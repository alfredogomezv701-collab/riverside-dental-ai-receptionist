import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KvNamespace } from '@telnyx/edge-runtime';
import type { DaySlotNamespace } from '../actors/day_slot_binding.js';
import { findConflict, loadDayBookings, validateSlot } from '../calendar.js';
import { logToolCall } from '../log.js';
import { digitsOf, PATIENT_KEY, readPatient, withAppointment, writePatient } from '../patients.js';
import {
  BOOK_APPOINTMENT_TOOL_NAME,
  BOOK_APPOINTMENT_TOOL_DESCRIPTION,
  BOOKING_KEY,
  APPOINTMENT_KEY,
  bookAppointmentInputSchema,
  type BookAppointmentInput,
  type BookAppointmentResult,
  type AppointmentRecord,
} from './book_appointment.js';

export interface ToolContext {
  kv: KvNamespace | undefined;
  daySlot: DaySlotNamespace | undefined;
  requestId?: string;
  /** Clinic-local "today" (YYYY-MM-DD); injectable so tests don't rot as the calendar moves. */
  today?: string;
}

const samePhone = (a: string, b: string) => digitsOf(a).slice(-10) === digitsOf(b).slice(-10);

export async function runBookAppointment(
  input: BookAppointmentInput,
  ctx: ToolContext,
): Promise<BookAppointmentResult> {
  const bad = validateSlot(input.service, input.date, input.start, ctx.today);
  if (bad) return { confirmed: false, reason: bad.reason, detail: bad.detail };

  const bookingKey = BOOKING_KEY(input.date, input.start);
  const stub = ctx.daySlot?.idFromName(input.date);

  // Independent reads/claims go out together (each is a network round trip): the day's existing
  // bookings, this patient's record, and - the race-safe part - the actor hold for this exact start.
  const [dayBookings, patient, hold] = await Promise.all([
    ctx.kv ? loadDayBookings(ctx.kv, input.date) : Promise.resolve([]),
    ctx.kv ? readPatient(ctx.kv, input.patientPhone, APPOINTMENT_KEY) : Promise.resolve(null),
    stub ? stub.holdSlot(input.start, input.patientPhone) : Promise.resolve(undefined),
  ]);
  const held = hold?.success === true;
  const release = async () => {
    if (held && stub) await stub.releaseSlot(input.start, input.patientPhone).catch(() => undefined);
  };

  // Idempotent retry: the same patient asking again for the exact slot they already hold gets the
  // existing appointment back, not "someone else took it" (the model retries on flaky turns).
  const mine = dayBookings.find(
    (b) => b.start === input.start && b.service === input.service && b.patientPhone && samePhone(b.patientPhone, input.patientPhone),
  );
  if (mine?.appointmentId) {
    await release();
    return { confirmed: true, alreadyBookedByYou: true, appointment: mine as AppointmentRecord };
  }

  if (stub && !held) return { confirmed: false, reason: 'slot_already_booked' };

  // The actor only sees identical start times; overlap between different-length appointments
  // (a 90-minute root canal vs a cleaning inside it) is caught here.
  const clash = findConflict({ service: input.service, start: input.start }, dayBookings);
  if (clash) {
    await release();
    return {
      confirmed: false,
      reason: 'slot_already_booked',
      detail: `overlaps an existing ${clash.service} appointment at ${clash.start}`,
    };
  }

  if (stub) {
    const confirm = await stub.confirmSlot(input.start, input.patientPhone);
    if (!confirm.success) {
      // Shouldn't happen right after our own successful hold; fail closed and free the hold so it
      // doesn't block other callers until the alarm sweeps it.
      await release();
      return { confirmed: false, reason: 'slot_already_booked' };
    }
  }

  const appointment: AppointmentRecord = {
    appointmentId: crypto.randomUUID(),
    service: input.service,
    date: input.date,
    start: input.start,
    patientName: input.patientName,
    patientPhone: input.patientPhone,
  };

  if (ctx.kv) {
    const record = JSON.stringify(appointment);
    const kv = ctx.kv;
    // Independent writes: issue them together, but wait for ALL of them - Promise.all would return on
    // the first failure while the others are still landing, and we must know exactly what to undo.
    const writes = await Promise.allSettled([
      kv.put(bookingKey, record),
      kv.put(APPOINTMENT_KEY(appointment.appointmentId), record),
      writePatient(
        kv,
        input.patientPhone,
        withAppointment(patient, input.patientName, {
          appointmentId: appointment.appointmentId,
          service: input.service,
          date: input.date,
          start: input.start,
        }),
      ),
    ]);
    const failed = writes.find((w): w is PromiseRejectedResult => w.status === 'rejected');
    if (failed) {
      // The actor already confirmed (a confirmed slot has no expiry). Without a full record it would be
      // booked forever with nobody holding an appointment for it: give it back, undo whichever writes
      // did land (including the patient record), then surface the error.
      if (stub) await stub.releaseSlot(input.start, input.patientPhone).catch(() => undefined);
      await Promise.allSettled([
        kv.delete(bookingKey),
        kv.delete(APPOINTMENT_KEY(appointment.appointmentId)),
        patient ? writePatient(kv, input.patientPhone, patient) : kv.delete(PATIENT_KEY(input.patientPhone)),
      ]);
      throw failed.reason;
    }
  }

  return { confirmed: true, appointment };
}

export function registerBookAppointment(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    BOOK_APPOINTMENT_TOOL_NAME,
    {
      description: BOOK_APPOINTMENT_TOOL_DESCRIPTION,
      inputSchema: bookAppointmentInputSchema.shape,
    },
    async (input: BookAppointmentInput) => {
      const result = await logToolCall(BOOK_APPOINTMENT_TOOL_NAME, ctx.requestId, { caller: input.patientPhone }, () =>
        runBookAppointment(input, ctx),
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
