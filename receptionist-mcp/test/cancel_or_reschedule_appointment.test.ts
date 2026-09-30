import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelOrRescheduleInputSchema,
  CANCEL_OR_RESCHEDULE_TOOL_NAME,
} from '../src/tools/cancel_or_reschedule_appointment.js';
import { runCancelOrReschedule } from '../src/tools/cancel_or_reschedule_appointment_handler.js';
import { runBookAppointment } from '../src/tools/book_appointment_handler.js';
import { BOOKING_KEY, APPOINTMENT_KEY } from '../src/tools/book_appointment.js';
import { PATIENT_KEY, type PatientRecord } from '../src/patients.js';
import { slotGrid } from '../src/calendar.js';
import { MockKvNamespace } from './mock_kv.js';
import { MON, TUE, WED, SAT, PHONE, PHONE_B, bookInput, kvCtx, openSlot } from './fixtures.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

describe('cancel_or_reschedule_appointment - constants and schema', () => {
  it('exposes the expected tool name', () => assert.equal(CANCEL_OR_RESCHEDULE_TOOL_NAME, 'cancel_or_reschedule_appointment'));

  it('accepts a valid cancel and a valid reschedule', () => {
    assert.doesNotThrow(() => cancelOrRescheduleInputSchema.parse({ appointmentId: UUID, action: 'cancel' }));
    assert.doesNotThrow(() =>
      cancelOrRescheduleInputSchema.parse({ appointmentId: UUID, action: 'reschedule', newDate: '2026-10-06', newStart: '11:00' }),
    );
  });

  it('rejects a non-uuid id, an unknown action and malformed new slot fields', () => {
    assert.throws(() => cancelOrRescheduleInputSchema.parse({ appointmentId: 'nope', action: 'cancel' }));
    assert.throws(() => cancelOrRescheduleInputSchema.parse({ appointmentId: UUID, action: 'delete' }));
    assert.throws(() => cancelOrRescheduleInputSchema.parse({ appointmentId: UUID, action: 'reschedule', newDate: '10/06/2026' }));
    assert.throws(() => cancelOrRescheduleInputSchema.parse({ appointmentId: UUID, action: 'reschedule', newStart: '9am' }));
  });
});

async function bookOne(kv: MockKvNamespace, over: Record<string, unknown> = {}) {
  const booked = await runBookAppointment(bookInput(over) as never, kvCtx(kv));
  if (!booked.confirmed || !booked.appointment) throw new Error('setup booking failed');
  return booked.appointment;
}
const patientOf = (kv: MockKvNamespace, phone = PHONE) => kv.get<PatientRecord>(PATIENT_KEY(phone), { type: 'json' });

describe('cancel', () => {
  it('reports an unknown appointment', async () => {
    const res = await runCancelOrReschedule({ appointmentId: UUID, action: 'cancel' }, kvCtx());
    assert.deepEqual([res.success, res.reason], [false, 'appointment_not_found']);
  });

  it('deletes the booking, the appointment and (as it was the last one) the patient record', async () => {
    const kv = new MockKvNamespace();
    const a = await bookOne(kv);

    const res = await runCancelOrReschedule({ appointmentId: a.appointmentId, action: 'cancel' }, kvCtx(kv));

    assert.equal(res.success, true);
    assert.equal(await kv.get(APPOINTMENT_KEY(a.appointmentId)), null);
    assert.equal(await kv.get(BOOKING_KEY(a.date, a.start)), null);
    assert.equal(await patientOf(kv), null);
  });

  it('frees the slot for someone else', async () => {
    const kv = new MockKvNamespace();
    const a = await bookOne(kv);
    await runCancelOrReschedule({ appointmentId: a.appointmentId, action: 'cancel' }, kvCtx(kv));
    const rebooked = await runBookAppointment(bookInput({ start: a.start, patientPhone: PHONE_B, patientName: 'Bob' }) as never, kvCtx(kv));
    assert.equal(rebooked.confirmed, true);
  });

  // The earlier single-slot record made this destructive: cancelling the newer booking deleted the
  // record, so the patient was "new" and could never cancel the older one by voice.
  it('cancelling one of two appointments keeps the patient and the other appointment', async () => {
    const kv = new MockKvNamespace();
    const first = await bookOne(kv, { date: MON, start: openSlot('cleaning', MON, 1) });
    const second = await bookOne(kv, { date: WED, start: openSlot('cleaning', WED, 1) });

    await runCancelOrReschedule({ appointmentId: second.appointmentId, action: 'cancel' }, kvCtx(kv));

    const patient = await patientOf(kv);
    assert.equal(patient?.patientName, 'Ada Lovelace');
    assert.deepEqual(patient?.appointments.map((x) => x.appointmentId), [first.appointmentId]);
  });

  it('cancelling the older of two appointments leaves the newer one', async () => {
    const kv = new MockKvNamespace();
    const first = await bookOne(kv, { date: MON, start: openSlot('cleaning', MON, 1) });
    const second = await bookOne(kv, { date: WED, start: openSlot('cleaning', WED, 1) });

    await runCancelOrReschedule({ appointmentId: first.appointmentId, action: 'cancel' }, kvCtx(kv));

    assert.deepEqual((await patientOf(kv))?.appointments.map((x) => x.appointmentId), [second.appointmentId]);
  });
});

describe('reschedule', () => {
  it('moves the booking, updates the appointment and the patient summary, and frees the old slot', async () => {
    const kv = new MockKvNamespace();
    const a = await bookOne(kv);
    const newStart = openSlot('cleaning', WED, 3);

    const res = await runCancelOrReschedule({ appointmentId: a.appointmentId, action: 'reschedule', newDate: WED, newStart }, kvCtx(kv));

    assert.equal(res.success, true);
    assert.equal(await kv.get(BOOKING_KEY(a.date, a.start)), null);
    assert.ok(await kv.get(BOOKING_KEY(WED, newStart)));
    const stored = await kv.get<{ date: string; start: string }>(APPOINTMENT_KEY(a.appointmentId), { type: 'json' });
    assert.deepEqual([stored?.date, stored?.start], [WED, newStart]);
    assert.deepEqual((await patientOf(kv))?.appointments, [{ appointmentId: a.appointmentId, service: 'cleaning', date: WED, start: newStart }]);
  });

  it('requires a new date and start', async () => {
    const kv = new MockKvNamespace();
    const a = await bookOne(kv);
    const res = await runCancelOrReschedule({ appointmentId: a.appointmentId, action: 'reschedule' }, kvCtx(kv));
    assert.equal(res.reason, 'missing_new_slot');
  });

  it('refuses an invalid new slot (weekend, off-grid, busy) and leaves everything as it was', async () => {
    const kv = new MockKvNamespace();
    const a = await bookOne(kv);
    const busy = slotGrid('cleaning', WED).find((s) => !s.available)!.start;
    for (const [newDate, newStart, reason] of [
      [SAT, '10:00', 'invalid_slot'],
      [WED, '09:10', 'invalid_slot'],
      [WED, busy, 'slot_unavailable'],
    ] as const) {
      const res = await runCancelOrReschedule({ appointmentId: a.appointmentId, action: 'reschedule', newDate, newStart }, kvCtx(kv));
      assert.equal(res.success, false);
      assert.equal(res.reason, reason, `${newDate} ${newStart}`);
    }
    assert.ok(await kv.get(BOOKING_KEY(a.date, a.start)));
  });

  it('refuses a new slot that overlaps someone else\'s appointment, keeping the original booking', async () => {
    const kv = new MockKvNamespace();
    const a = await bookOne(kv);
    await bookOne(kv, { date: WED, start: openSlot('cleaning', WED, 0), patientPhone: PHONE_B, patientName: 'Bob' });

    const res = await runCancelOrReschedule(
      { appointmentId: a.appointmentId, action: 'reschedule', newDate: WED, newStart: openSlot('cleaning', WED, 0) },
      kvCtx(kv),
    );

    assert.equal(res.success, false);
    assert.equal(res.reason, 'new_slot_already_booked');
    assert.ok(await kv.get(BOOKING_KEY(a.date, a.start)));
    assert.deepEqual((await patientOf(kv))?.appointments.map((x) => x.date), [TUE]);
  });

  it('treats "move to where I already am" as a no-op success', async () => {
    const kv = new MockKvNamespace();
    const a = await bookOne(kv);
    const res = await runCancelOrReschedule({ appointmentId: a.appointmentId, action: 'reschedule', newDate: a.date, newStart: a.start }, kvCtx(kv));
    assert.equal(res.success, true);
    assert.ok(await kv.get(BOOKING_KEY(a.date, a.start)));
  });

  it('can move within the same day without colliding with itself', async () => {
    const kv = new MockKvNamespace();
    const a = await bookOne(kv);
    const later = openSlot('cleaning', TUE, 4);
    const res = await runCancelOrReschedule({ appointmentId: a.appointmentId, action: 'reschedule', newDate: TUE, newStart: later }, kvCtx(kv));
    assert.equal(res.success, true);
    assert.equal(await kv.get(BOOKING_KEY(TUE, a.start)), null);
  });

  it('a reschedule whose writes fail leaves the original booking in place', async () => {
    const kv = new MockKvNamespace();
    const a = await bookOne(kv);
    kv.failPutsMatching = /^appointment\//;

    await assert.rejects(() =>
      runCancelOrReschedule({ appointmentId: a.appointmentId, action: 'reschedule', newDate: WED, newStart: openSlot('cleaning', WED, 5) }, kvCtx(kv)),
    );

    assert.ok(await kv.get(BOOKING_KEY(a.date, a.start)), 'original booking record must still exist');
    assert.equal((await kv.get<{ date: string }>(APPOINTMENT_KEY(a.appointmentId), { type: 'json' }))?.date, TUE);
  });
});
