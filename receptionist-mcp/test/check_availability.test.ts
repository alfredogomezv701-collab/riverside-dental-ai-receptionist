import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAvailabilityInputSchema,
  CHECK_AVAILABILITY_TOOL_NAME,
  CHECK_AVAILABILITY_TOOL_DESCRIPTION,
} from '../src/tools/check_availability.js';
import { runCheckAvailability } from '../src/tools/check_availability_handler.js';
import { runBookAppointment } from '../src/tools/book_appointment_handler.js';
import { runCancelOrReschedule } from '../src/tools/cancel_or_reschedule_appointment_handler.js';
import { BOOKING_KEY } from '../src/tools/book_appointment.js';
import { MockKvNamespace } from './mock_kv.js';
import { TODAY, TUE, SAT, bookInput, kvCtx, openSlot } from './fixtures.js';

describe('check_availability - constants and schema', () => {
  it('exposes the expected tool name and a description that says what to offer', () => {
    assert.equal(CHECK_AVAILABILITY_TOOL_NAME, 'check_availability');
    assert.match(CHECK_AVAILABILITY_TOOL_DESCRIPTION, /available: true/);
  });

  it('accepts a valid service + date and rejects malformed input', () => {
    assert.doesNotThrow(() => checkAvailabilityInputSchema.parse({ service: 'cleaning', date: TUE }));
    const bad = [{ service: '', date: TUE }, { service: 'cleaning', date: '10/01/2026' }, { service: 'cleaning', date: '2026-10-1' }, { service: 'cleaning' }, { date: TUE }, {}];
    for (const b of bad) assert.throws(() => checkAvailabilityInputSchema.parse(b), JSON.stringify(b));
  });
});

describe('runCheckAvailability', () => {
  it('offers the full service grid on an empty day, within clinic hours', async () => {
    const res = await runCheckAvailability({ service: 'cleaning', date: TUE }, kvCtx());
    assert.equal(res.slots[0].start, '09:00');
    assert.ok(res.slots.every((s) => s.end <= '17:00'));
    assert.ok(res.slots.some((s) => s.available));
    assert.equal(res.note, undefined);
  });

  it('explains itself instead of returning a grid for a weekend, a past date, a fake date or an unknown service', async () => {
    const cases = [
      ['cleaning', SAT, /weekend/],
      ['cleaning', '2026-08-03', /past/],
      ['cleaning', '2027-99-99', /real calendar date/],
      ['whitening', TUE, /unknown service.*cleaning/],
    ] as const;
    for (const [service, date, re] of cases) {
      const res = await runCheckAvailability({ service, date }, kvCtx());
      assert.deepEqual(res.slots, [], `${service} ${date}`);
      assert.match(res.note!, re);
    }
  });

  // The bug this replaces: availability was a synthetic grid that never looked at bookings, so a
  // caller was offered a slot another caller had just taken and only found out at booking time.
  it('reports a slot as unavailable as soon as it is booked', async () => {
    const kv = new MockKvNamespace();
    const start = openSlot('cleaning', TUE);
    const before = await runCheckAvailability({ service: 'cleaning', date: TUE }, kvCtx(kv));
    assert.equal(before.slots.find((s) => s.start === start)!.available, true);

    await runBookAppointment(bookInput({ start }) as never, kvCtx(kv));

    const after = await runCheckAvailability({ service: 'cleaning', date: TUE }, kvCtx(kv));
    assert.equal(after.slots.find((s) => s.start === start)!.available, false);
  });

  it('reports it as available again once the appointment is cancelled', async () => {
    const kv = new MockKvNamespace();
    const start = openSlot('cleaning', TUE);
    const booked = await runBookAppointment(bookInput({ start }) as never, kvCtx(kv));
    await runCancelOrReschedule({ appointmentId: booked.appointment!.appointmentId, action: 'cancel' }, kvCtx(kv));

    const res = await runCheckAvailability({ service: 'cleaning', date: TUE }, kvCtx(kv));
    assert.equal(res.slots.find((s) => s.start === start)!.available, true);
  });

  it('hides every slot that overlaps a longer appointment, for every service', async () => {
    const kv = new MockKvNamespace();
    await kv.put(BOOKING_KEY(TUE, '10:30'), JSON.stringify({ service: 'root-canal', start: '10:30' })); // 10:30-12:00
    const cleaning = await runCheckAvailability({ service: 'cleaning', date: TUE }, kvCtx(kv));
    for (const s of cleaning.slots.filter((x) => x.start >= '10:30' && x.start < '12:00')) assert.equal(s.available, false, s.start);
    assert.equal(cleaning.slots.find((s) => s.start === '12:00')!.available, true, 'touching the end is fine');
    const exam = await runCheckAvailability({ service: 'exam', date: TUE }, kvCtx(kv));
    assert.equal(exam.slots.find((s) => s.start === '11:00')!.available, false);
  });

  it('only counts the requested day', async () => {
    const kv = new MockKvNamespace();
    await kv.put(BOOKING_KEY('2026-10-07', '10:00'), JSON.stringify({ service: 'cleaning', start: '10:00' }));
    const res = await runCheckAvailability({ service: 'cleaning', date: TUE }, kvCtx(kv));
    assert.equal(res.slots.find((s) => s.start === '10:00')!.available, true);
  });

  it('never caches: a stale answer is wrong the moment someone books (no KV writes on a read)', async () => {
    const kv = new MockKvNamespace();
    await runCheckAvailability({ service: 'cleaning', date: TUE }, kvCtx(kv));
    await runCheckAvailability({ service: 'cleaning', date: TUE }, kvCtx(kv));
    assert.equal(kv.puts.length, 0);
  });

  it('still answers without KV (local dev): the bare grid', async () => {
    const res = await runCheckAvailability({ service: 'cleaning', date: TUE }, { kv: undefined, today: TODAY });
    assert.ok(res.slots.length > 0);
  });
});
