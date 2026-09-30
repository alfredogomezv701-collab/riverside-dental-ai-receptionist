import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bookAppointmentInputSchema,
  BOOK_APPOINTMENT_TOOL_NAME,
  BOOKING_KEY,
  APPOINTMENT_KEY,
} from '../src/tools/book_appointment.js';
import { runBookAppointment } from '../src/tools/book_appointment_handler.js';
import { slotGrid } from '../src/calendar.js';
import { PATIENT_KEY, type PatientRecord } from '../src/patients.js';
import { MockKvNamespace } from './mock_kv.js';
import { MON, TUE, WED, SAT, PHONE, PHONE_B, bookInput, kvCtx, openSlot } from './fixtures.js';

describe('book_appointment - constants and keys', () => {
  it('exposes the expected tool name', () => assert.equal(BOOK_APPOINTMENT_TOOL_NAME, 'book_appointment'));

  it('builds booking and appointment keys from the characters Telnyx KV allows', () => {
    assert.equal(BOOKING_KEY('2026-10-01', '09:00'), 'booking/2026-10-01/0900');
    assert.equal(APPOINTMENT_KEY('abc-123'), 'appointment/abc-123');
    assert.equal(PATIENT_KEY('+1 (555) 123-4567'), 'patient/5551234567');
  });
});

describe('book_appointment - input schema', () => {
  it('accepts valid input, with the phone in any common format', () => {
    for (const phone of ['+15551234567', '555-123-4567', '(555) 123 4567', '5551234567']) {
      assert.doesNotThrow(() => bookAppointmentInputSchema.parse(bookInput({ patientPhone: phone })), phone);
    }
  });

  it('rejects a malformed start time', () => {
    for (const start of ['9:00', '9am', '09:0']) assert.throws(() => bookAppointmentInputSchema.parse(bookInput({ start })), start);
  });

  it('rejects a missing patient name', () => assert.throws(() => bookAppointmentInputSchema.parse(bookInput({ patientName: '' }))));

  // A non-dialable "phone" used to map to the key patient/ (empty digits), which the webhook also
  // read for anonymous callers - so one junk booking leaked a name across unrelated callers.
  it('rejects phones without a full number: words, 7 digits, no area code', () => {
    for (const patientPhone of ['unknown', 'this number', '555-1234', '1234567', '', '+1']) {
      assert.throws(() => bookAppointmentInputSchema.parse(bookInput({ patientPhone })), String(patientPhone));
    }
  });
});

describe('runBookAppointment - slot validation (nothing is written for a bad slot)', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['unknown service', { service: 'whitening' }, 'invalid_slot'],
    ['a weekend', { date: SAT }, 'invalid_slot'],
    ['a past date', { date: '2026-08-03' }, 'invalid_slot'],
    ['a date that does not exist', { date: '2027-99-99' }, 'invalid_slot'],
    ['a 3am start', { start: '03:00' }, 'invalid_slot'],
    ['a start that is off the grid', { start: '09:10' }, 'invalid_slot'],
  ];
  for (const [name, over, reason] of cases) {
    it(`rejects ${name}`, async () => {
      const kv = new MockKvNamespace();
      const res = await runBookAppointment(bookInput(over) as never, kvCtx(kv));
      assert.equal(res.confirmed, false);
      assert.equal(res.reason, reason);
      assert.ok(res.detail);
      assert.equal(kv.puts.length, 0);
    });
  }

  it('rejects a slot the calendar marks busy, as slot_unavailable', async () => {
    const busy = slotGrid('cleaning', TUE).find((s) => !s.available)!.start;
    const res = await runBookAppointment(bookInput({ start: busy }) as never, kvCtx());
    assert.equal(res.reason, 'slot_unavailable');
  });
});

describe('runBookAppointment - no actor bound (KV-only fallback, not race-safe)', () => {
  it('confirms a booking and writes the booking, appointment and patient records', async () => {
    const kv = new MockKvNamespace();
    const input = bookInput();
    const result = await runBookAppointment(input as never, kvCtx(kv));

    assert.equal(result.confirmed, true);
    const a = result.appointment!;
    assert.equal(a.service, 'cleaning');
    assert.equal(a.date, TUE);
    assert.equal(a.start, input.start);
    assert.ok(a.appointmentId.length > 0);
    assert.deepEqual(await kv.get(BOOKING_KEY(TUE, input.start), { type: 'json' }), a);
    assert.deepEqual(await kv.get(APPOINTMENT_KEY(a.appointmentId), { type: 'json' }), a);
    const patient = await kv.get<PatientRecord>(PATIENT_KEY(PHONE), { type: 'json' });
    assert.equal(patient?.patientName, 'Ada Lovelace');
    assert.deepEqual(patient?.appointments, [{ appointmentId: a.appointmentId, service: 'cleaning', date: TUE, start: input.start }]);
  });

  it('rejects a second booking for the same slot', async () => {
    const kv = new MockKvNamespace();
    await runBookAppointment(bookInput() as never, kvCtx(kv));
    const second = await runBookAppointment(bookInput({ patientName: 'Bob', patientPhone: PHONE_B }) as never, kvCtx(kv));
    assert.equal(second.confirmed, false);
    assert.equal(second.reason, 'slot_already_booked');
    assert.equal(await kv.get(PATIENT_KEY(PHONE_B)), null, 'a rejected booking must not create a patient record');
  });

  it('rejects an appointment that overlaps a longer one, though the start times differ', async () => {
    const kv = new MockKvNamespace();
    // A 90-minute root canal 10:30-12:00 (seeded directly; its own slot needn't be "open" for this test).
    await kv.put(BOOKING_KEY(TUE, '10:30'), JSON.stringify({ service: 'root-canal', start: '10:30', appointmentId: 'x', patientPhone: PHONE_B }));

    const inside = await runBookAppointment(bookInput({ start: '11:00' }) as never, kvCtx(kv));
    assert.equal(inside.confirmed, false);
    assert.equal(inside.reason, 'slot_already_booked');
    assert.match(inside.detail!, /root-canal/);

    const touching = await runBookAppointment(bookInput({ start: '12:00' }) as never, kvCtx(kv));
    assert.equal(touching.confirmed, true, 'starting exactly when the root canal ends is fine');
  });

  it('is idempotent: retrying the same booking returns the existing appointment, not "someone else took it"', async () => {
    const kv = new MockKvNamespace();
    const first = await runBookAppointment(bookInput() as never, kvCtx(kv));

    const again = await runBookAppointment(bookInput({ patientPhone: '555-123-4567' }) as never, kvCtx(kv));

    assert.equal(again.confirmed, true);
    assert.equal(again.alreadyBookedByYou, true);
    assert.equal(again.appointment?.appointmentId, first.appointment?.appointmentId);
    assert.equal((await kv.list({ prefix: 'appointment/' })).keys.length, 1);
  });

  it('a different patient asking for that slot is still refused', async () => {
    const kv = new MockKvNamespace();
    await runBookAppointment(bookInput() as never, kvCtx(kv));
    const other = await runBookAppointment(bookInput({ patientPhone: PHONE_B }) as never, kvCtx(kv));
    assert.equal(other.confirmed, false);
    assert.notEqual(other.alreadyBookedByYou, true);
  });

  it('keeps every appointment on the patient record, soonest first', async () => {
    const kv = new MockKvNamespace();
    const later = await runBookAppointment(bookInput({ date: WED, start: openSlot('cleaning', WED, 1) }) as never, kvCtx(kv));
    const sooner = await runBookAppointment(bookInput({ date: MON, start: openSlot('cleaning', MON, 2) }) as never, kvCtx(kv));

    const patient = await kv.get<PatientRecord>(PATIENT_KEY(PHONE), { type: 'json' });
    assert.deepEqual(patient?.appointments.map((a) => a.appointmentId), [sooner.appointment!.appointmentId, later.appointment!.appointmentId]);
  });
});

describe('runBookAppointment - a failed write undoes the writes that did land', () => {
  it('removes the booking and appointment records and restores the patient record it changed', async () => {
    const kv = new MockKvNamespace();
    const first = await runBookAppointment(bookInput({ date: MON, start: openSlot('cleaning', MON) }) as never, kvCtx(kv));
    const before = await kv.get(PATIENT_KEY(PHONE));
    kv.failPutsMatching = /^patient\//; // booking + appointment puts succeed, the patient write fails

    await assert.rejects(() => runBookAppointment(bookInput({ date: WED, start: openSlot('cleaning', WED) }) as never, kvCtx(kv)), /injected/);

    kv.failPutsMatching = undefined;
    assert.deepEqual((await kv.list({ prefix: `booking/${WED}/` })).keys, []);
    assert.equal((await kv.list({ prefix: 'appointment/' })).keys.length, 1, 'only the first appointment remains');
    assert.equal(await kv.get(PATIENT_KEY(PHONE)), before, 'patient record unchanged');
    assert.ok(first.confirmed);
  });
});
