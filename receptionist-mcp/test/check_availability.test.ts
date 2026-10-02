import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAvailabilityInputSchema,
  CHECK_AVAILABILITY_TOOL_NAME,
  CHECK_AVAILABILITY_TOOL_DESCRIPTION,
  DEFAULT_PAGE_SIZE,
} from '../src/tools/check_availability.js';
import { runCheckAvailability, encodeCursor, decodeCursor, paginateSlots } from '../src/tools/check_availability_handler.js';
import { runBookAppointment } from '../src/tools/book_appointment_handler.js';
import { runCancelOrReschedule } from '../src/tools/cancel_or_reschedule_appointment_handler.js';
import { BOOKING_KEY } from '../src/tools/book_appointment.js';
import { MockKvNamespace } from './mock_kv.js';
import { TODAY, TUE, SAT, bookInput, kvCtx, openSlot } from './fixtures.js';

describe('check_availability - constants and schema', () => {
  it('exposes the expected tool name and a description that explains pagination', () => {
    assert.equal(CHECK_AVAILABILITY_TOOL_NAME, 'check_availability');
    assert.match(CHECK_AVAILABILITY_TOOL_DESCRIPTION, /PAGINATED/);
    assert.match(CHECK_AVAILABILITY_TOOL_DESCRIPTION, /next_cursor/);
  });

  it('accepts a valid service + date and rejects malformed input', () => {
    assert.doesNotThrow(() => checkAvailabilityInputSchema.parse({ service: 'cleaning', date: TUE }));
    assert.doesNotThrow(() => checkAvailabilityInputSchema.parse({ service: 'cleaning', date: TUE, cursor: 'MDk6MDA=', limit: 5 }));
    const bad = [
      { service: '', date: TUE },
      { service: 'cleaning', date: '10/01/2026' },
      { service: 'cleaning', date: '2026-10-1' },
      { service: 'cleaning' },
      { date: TUE },
      {},
      { service: 'cleaning', date: TUE, limit: 0 },
      { service: 'cleaning', date: TUE, limit: 101 },
      { service: 'cleaning', date: TUE, limit: 1.5 },
    ];
    for (const b of bad) assert.throws(() => checkAvailabilityInputSchema.parse(b), JSON.stringify(b));
  });
});

describe('runCheckAvailability', () => {
  it('returns the first page of open slots on an empty day (default page size), within clinic hours', async () => {
    const res = await runCheckAvailability({ service: 'cleaning', date: TUE }, kvCtx());
    assert.equal(res.slots.length, DEFAULT_PAGE_SIZE);
    assert.equal(res.slots[0].start, '09:00');
    assert.ok(res.slots.every((s) => s.end <= '17:00'));
    assert.ok(res.slots.every((s) => s.available), 'paged view contains only available:true slots');
    assert.equal(res.note, undefined);
    assert.ok(res.next_cursor, 'a partial page carries a next_cursor');
    assert.equal(res.total_available, 13);
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
      assert.equal(res.total_available, 0);
      assert.equal(res.next_cursor, undefined);
      assert.match(res.note!, re);
    }
  });

  // The bug this replaces: availability was a synthetic grid that never looked at bookings, so a
  // caller was offered a slot another caller had just taken and only found out at booking time.
  it('reports a slot as unavailable by OMITTING it: a just-booked slot drops out of the page', async () => {
    const kv = new MockKvNamespace();
    const start = openSlot('cleaning', TUE); // first open slot, 09:00
    const before = await runCheckAvailability({ service: 'cleaning', date: TUE, limit: 100 }, kvCtx(kv));
    assert.equal(before.slots.find((s) => s.start === start)!.available, true);
    const beforeTotal = before.total_available;

    await runBookAppointment(bookInput({ start }) as never, kvCtx(kv));

    const after = await runCheckAvailability({ service: 'cleaning', date: TUE, limit: 100 }, kvCtx(kv));
    assert.equal(after.slots.find((s) => s.start === start), undefined, 'a booked slot is not in the response at all');
    assert.equal(after.total_available, beforeTotal - 1);
  });

  it('reports it as available again once the appointment is cancelled (it reappears)', async () => {
    const kv = new MockKvNamespace();
    const start = openSlot('cleaning', TUE);
    const booked = await runBookAppointment(bookInput({ start }) as never, kvCtx(kv));
    await runCancelOrReschedule({ appointmentId: booked.appointment!.appointmentId, action: 'cancel' }, kvCtx(kv));

    const res = await runCheckAvailability({ service: 'cleaning', date: TUE, limit: 100 }, kvCtx(kv));
    assert.equal(res.slots.find((s) => s.start === start)!.available, true);
  });

  it('hides every slot that overlaps a longer appointment, for every service', async () => {
    const kv = new MockKvNamespace();
    await kv.put(BOOKING_KEY(TUE, '10:30'), JSON.stringify({ service: 'root-canal', start: '10:30' })); // 10:30-12:00
    const cleaning = await runCheckAvailability({ service: 'cleaning', date: TUE, limit: 100 }, kvCtx(kv));
    // Read side just omits overlapping slots; the booking-time validateSlot/findConflict still
    // enforces them. Verify the omission and that the touching slot is still offered.
    for (const s of cleaning.slots.filter((x) => x.start >= '10:30' && x.start < '12:00')) {
      assert.fail(`overlapping slot ${s.start} leaked into the response`);
    }
    assert.equal(cleaning.slots.find((s) => s.start === '12:00')!.available, true, 'touching the end is fine');
    const exam = await runCheckAvailability({ service: 'exam', date: TUE, limit: 100 }, kvCtx(kv));
    assert.equal(exam.slots.find((s) => s.start === '11:00'), undefined, 'an overlapping exam slot is omitted, not marked false');
  });

  it('only counts the requested day', async () => {
    const kv = new MockKvNamespace();
    await kv.put(BOOKING_KEY('2026-10-07', '10:00'), JSON.stringify({ service: 'cleaning', start: '10:00' }));
    const res = await runCheckAvailability({ service: 'cleaning', date: TUE, limit: 100 }, kvCtx(kv));
    assert.equal(res.slots.find((s) => s.start === '10:00')!.available, true);
  });

  it('never caches: a stale answer is wrong the moment someone books (no KV writes on a read)', async () => {
    const kv = new MockKvNamespace();
    await runCheckAvailability({ service: 'cleaning', date: TUE }, kvCtx(kv));
    await runCheckAvailability({ service: 'cleaning', date: TUE }, kvCtx(kv));
    assert.equal(kv.puts.length, 0);
  });

  it('still answers without KV (local dev): a paged view of the bare grid', async () => {
    const res = await runCheckAvailability({ service: 'cleaning', date: TUE }, { kv: undefined, today: TODAY });
    assert.ok(res.slots.length > 0);
    assert.ok(res.slots.length <= DEFAULT_PAGE_SIZE);
  });
});

describe('check_availability pagination', () => {
  // Fixtures for the pure pagination slice. 13 open slots for cleaning on TUE:
  // 09:00,10:00,10:30,11:00,11:30,12:00,12:30,13:30,14:00,14:30,15:00,15:30,16:00
  // (09:30, 13:00, 16:30 are the seed-busy ones the grid marks unavailable.)
  const OPEN_TUE = [
    { start: '09:00', end: '09:30', available: true },
    { start: '10:00', end: '10:30', available: true },
    { start: '10:30', end: '11:00', available: true },
    { start: '11:00', end: '11:30', available: true },
    { start: '11:30', end: '12:00', available: true },
    { start: '12:00', end: '12:30', available: true },
    { start: '12:30', end: '13:00', available: true },
    { start: '13:30', end: '14:00', available: true },
    { start: '14:00', end: '14:30', available: true },
    { start: '14:30', end: '15:00', available: true },
    { start: '15:00', end: '15:30', available: true },
    { start: '15:30', end: '16:00', available: true },
    { start: '16:00', end: '16:30', available: true },
  ];

  it('base64url cursor round-trips a start time and is opaque-looking', () => {
    assert.equal(decodeCursor(encodeCursor('16:30')), '16:30');
    assert.ok(!/:\d\d/.test(encodeCursor('16:30')), 'cursor must not contain the raw HH:MM');
  });

  it('serves the first page when no cursor is given, sized to limit', () => {
    const out = paginateSlots(OPEN_TUE, undefined, 3);
    assert.deepEqual(out.slots.map((s) => s.start), ['09:00', '10:00', '10:30']);
    assert.equal(out.next_cursor, encodeCursor('10:30'));
  });

  it('walks every page with the returned cursor and ends with next_cursor undefined', () => {
    let cursor: string | undefined;
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const out = paginateSlots(OPEN_TUE, cursor, 5);
      seen.push(...out.slots.map((s) => s.start));
      cursor = out.next_cursor;
      if (!cursor) break;
    }
    assert.deepEqual(seen, OPEN_TUE.map((s) => s.start));
  });

  it('respects the cursor: page 2 starts strictly after the cursor and never repeats', () => {
    const p1 = paginateSlots(OPEN_TUE, undefined, 3);
    const p2 = paginateSlots(OPEN_TUE, p1.next_cursor, 3);
    assert.deepEqual(p1.slots.map((s) => s.start), ['09:00', '10:00', '10:30']);
    assert.deepEqual(p2.slots.map((s) => s.start), ['11:00', '11:30', '12:00']);
    const seen = new Set([...p1.slots, ...p2.slots].map((s) => s.start));
    assert.equal(seen.size, 6, 'no overlap between pages');
  });

  it('returns an empty page (no next_cursor) when the cursor is past the last open slot', () => {
    const out = paginateSlots(OPEN_TUE, encodeCursor('16:00'), 3);
    assert.deepEqual(out.slots, []);
    assert.equal(out.next_cursor, undefined);
  });

  it('clamps an out-of-range cursor back to the first page instead of erroring', () => {
    const out = paginateSlots(OPEN_TUE, 'not-valid-base64ữ', 3);
    assert.deepEqual(out.slots.map((s) => s.start), ['09:00', '10:00', '10:30']);
  });

  it('clamps a cursor that decodes to a non-HH:MM string back to the first page', () => {
    const out = paginateSlots(OPEN_TUE, encodeCursor('not-a-time'), 3);
    assert.deepEqual(out.slots.map((s) => s.start), ['09:00', '10:00', '10:30']);
  });

  it('never returns an unavailable slot, even when cursor sits on a busy one', () => {
    // The grid has 09:30, 13:00, 16:30 as available:false. A cursor at 09:00 must skip 09:30.
    const full = [
      ...OPEN_TUE.slice(0, 1),
      { start: '09:30', end: '10:00', available: false },
      ...OPEN_TUE.slice(1, 6),
      { start: '13:00', end: '13:30', available: false },
      ...OPEN_TUE.slice(6, 11),
      { start: '16:30', end: '17:00', available: false },
    ];
    const out = paginateSlots(full, encodeCursor('09:00'), 3);
    assert.deepEqual(out.slots.map((s) => s.start), ['10:00', '10:30', '11:00']);
    assert.ok(out.slots.every((s) => s.available));
  });

  it('a booking made between page 1 and page 2 cannot show a stale slot as available', async () => {
    const kv = new MockKvNamespace();
    const p1 = await runCheckAvailability({ service: 'cleaning', date: TUE, limit: 3 }, kvCtx(kv));
    // Book a slot that was on page 2 (index 4, 11:00).
    const victim = p1.next_cursor ? decodeCursor(p1.next_cursor) : '';
    // Book the slot just past the cursor (11:00) — it should NOT reappear on page 2.
    await runBookAppointment(bookInput({ start: '11:00' }) as never, kvCtx(kv));
    const p2 = await runCheckAvailability({ service: 'cleaning', date: TUE, cursor: p1.next_cursor, limit: 3 }, kvCtx(kv));
    assert.equal(p2.slots.find((s) => s.start === '11:00'), undefined, 'a slot booked between pages must not appear as available');
    void victim;
  });
});
