import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  bookAppointmentInputSchema,
  BOOK_APPOINTMENT_TOOL_NAME,
  BOOKING_KEY,
  APPOINTMENT_KEY,
  WAITLIST_ATTEMPTS_KEY,
  WAITLIST_THRESHOLD,
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

describe('runBookAppointment - failed-attempt counter (server-side, for the waitlist edge)', () => {
  it('bumps attempt_count on each slot_already_booked and signals should_waitlist at the threshold', async () => {
    const kv = new MockKvNamespace();
    // Pre-seed a booking so the same slot returns slot_already_booked for a different caller.
    await runBookAppointment(bookInput() as never, kvCtx(kv));

    let count = 0;
    for (let i = 1; i <= WAITLIST_THRESHOLD; i++) {
      const r = await runBookAppointment(bookInput({ patientName: `Bob ${i}`, patientPhone: PHONE_B }) as never, kvCtx(kv));
      assert.equal(r.confirmed, false, `attempt ${i}`);
      assert.equal(r.reason, 'slot_already_booked');
      assert.equal(r.attempt_count, i, `attempt_count is the running total`);
      assert.equal(r.should_waitlist, i >= WAITLIST_THRESHOLD, `should_waitlist flips at the threshold`);
      count = i;
    }
    assert.equal(count, WAITLIST_THRESHOLD);
    // The counter is persisted under waitlist_attempts/{date}/{phone10} so the next book sees it.
    const stored = await kv.get(WAITLIST_ATTEMPTS_KEY(TUE, PHONE_B));
    assert.equal(stored, String(WAITLIST_THRESHOLD));
  });

  it("does NOT bump the counter on invalid_slot (validation errors are the caller's fault, not a fully-booked day)", async () => {
    const kv = new MockKvNamespace();
    const r = await runBookAppointment(bookInput({ service: 'whitening' }) as never, kvCtx(kv));
    assert.equal(r.confirmed, false);
    assert.equal(r.reason, 'invalid_slot');
    assert.equal(r.attempt_count, undefined, 'invalid_slot does not carry attempt_count');
    assert.equal(r.should_waitlist, undefined);
    assert.equal(await kv.get(WAITLIST_ATTEMPTS_KEY(TUE, PHONE)), null, 'no counter written');
  });

  it('resets the counter to 0 on a successful confirm (a future booking effort starts fresh)', async () => {
    const kv = new MockKvNamespace();
    // Bump a couple of times first by failing to book the same slot someone else holds.
    await runBookAppointment(bookInput() as never, kvCtx(kv)); // seed
    await runBookAppointment(bookInput({ patientPhone: PHONE_B }) as never, kvCtx(kv)); // fail 1
    await runBookAppointment(bookInput({ patientPhone: PHONE_B, start: openSlot('cleaning', TUE, 1) } as never) as never, kvCtx(kv)); // succeed on a different open slot
    assert.equal(await kv.get(WAITLIST_ATTEMPTS_KEY(TUE, PHONE_B)), null, 'counter cleared on success');
  });

  it('counter errors are swallowed (a KV failure never blocks a booking decision)', async () => {
    const kv = new MockKvNamespace();
    await runBookAppointment(bookInput() as never, kvCtx(kv)); // seed
    // Make the counter write fail; the booking must still return slot_already_booked.
    kv.failPutsMatching = /^waitlist_attempts\//;
    const r = await runBookAppointment(bookInput({ patientPhone: PHONE_B }) as never, kvCtx(kv));
    assert.equal(r.confirmed, false);
    assert.equal(r.reason, 'slot_already_booked');
    assert.equal(r.attempt_count, 1, 'the in-memory count is still 1 even though the put failed');
    assert.equal(r.should_waitlist, false, '1 < 3 so no waitlist signal');
  });

  it('counter is scoped by phone+date: a different date is a separate count', async () => {
    const kv = new MockKvNamespace();
    // Fail twice on TUE for PHONE_B, then once on WED: the WED attempt should be 1, not 3.
    await runBookAppointment(bookInput() as never, kvCtx(kv)); // seed on TUE
    await runBookAppointment(bookInput({ patientPhone: PHONE_B }) as never, kvCtx(kv)); // TUE fail 1
    const tue2 = await runBookAppointment(bookInput({ patientPhone: PHONE_B }) as never, kvCtx(kv));
    assert.equal(tue2.attempt_count, 2);

    // Seeded booking on WED is needed so WED can fail; book a slot PHOBE_B can collide with.
    await runBookAppointment(bookInput({ date: WED, start: openSlot('cleaning', WED, 0) }) as never, kvCtx(kv));
    const wed1 = await runBookAppointment(bookInput({ date: WED, start: openSlot('cleaning', WED, 0), patientPhone: PHONE_B }) as never, kvCtx(kv));
    assert.equal(wed1.confirmed, false);
    assert.equal(wed1.attempt_count, 1, 'WED count is independent of TUE');
  });
});

describe('book_appointment - confirmation SMS (fire-and-forget, never affects the booking result)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const smsCtx = (kv = new MockKvNamespace()) => ({ ...kvCtx(kv), telnyxApiKey: 'KEY123', smsFromNumber: '+12185069277' });

  it('sends a confirmation SMS to the patient on a new successful booking', async () => {
    const calls: { url: string; body: unknown }[] = [];
    global.fetch = (async (url: string, init: { body: string }) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ data: { id: 'msg-1' } }), { status: 200 });
    }) as typeof fetch;

    const reports: Record<string, unknown>[] = [];
    const r = await runBookAppointment(bookInput() as never, smsCtx(), (extra) => reports.push(extra));

    assert.equal(r.confirmed, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.telnyx.com/v2/messages');
    assert.equal((calls[0].body as { from: string }).from, '+12185069277');
    assert.equal((calls[0].body as { to: string }).to, PHONE);
    assert.match((calls[0].body as { text: string }).text, /Jamie|confirmed|cleaning/i);
    assert.ok(reports.some((e) => e.sms_sent === true));
  });

  it('does not call Telnyx at all when telnyxApiKey/smsFromNumber are not configured', async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const r = await runBookAppointment(bookInput() as never, kvCtx());
    assert.equal(r.confirmed, true);
    assert.equal(called, false);
  });

  it('does not send a second SMS on the idempotent "already booked by you" retry path', async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ data: { id: 'msg-1' } }), { status: 200 });
    }) as typeof fetch;

    const kv = new MockKvNamespace();
    const first = await runBookAppointment(bookInput() as never, smsCtx(kv));
    assert.equal(first.confirmed, true);
    assert.equal(calls, 1);

    const retry = await runBookAppointment(bookInput() as never, smsCtx(kv));
    assert.equal(retry.confirmed, true);
    assert.equal((retry as { alreadyBookedByYou?: boolean }).alreadyBookedByYou, true);
    assert.equal(calls, 1, 'no second text for a retry of the same booking');
  });

  it('a non-2xx Telnyx response is reported but does not fail the booking', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ detail: 'from number has no messaging profile' }] }), { status: 422 })) as typeof fetch;

    const reports: Record<string, unknown>[] = [];
    const r = await runBookAppointment(bookInput() as never, smsCtx(), (extra) => reports.push(extra));

    assert.equal(r.confirmed, true, 'booking succeeds regardless of SMS outcome');
    assert.ok(reports.some((e) => e.sms_sent === false && typeof e.sms_error === 'string'));
  });

  it('a network-level throw from fetch is caught and reported, not propagated', async () => {
    global.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;

    const reports: Record<string, unknown>[] = [];
    const r = await runBookAppointment(bookInput() as never, smsCtx(), (extra) => reports.push(extra));

    assert.equal(r.confirmed, true);
    assert.ok(reports.some((e) => e.sms_sent === false && /network down/.test(String(e.sms_error))));
  });
});
