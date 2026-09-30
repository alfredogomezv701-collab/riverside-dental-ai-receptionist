import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dateProblem,
  findConflict,
  KNOWN_SERVICES,
  loadDayBookings,
  overlaps,
  SERVICE_DURATION_MINUTES,
  slotGrid,
  todayAtClinic,
  toMinutes,
  validateSlot,
} from '../src/calendar.js';
import { MockKvNamespace } from './mock_kv.js';
import { TODAY, MON, TUE, SAT, SUN, openSlot } from './fixtures.js';

describe('dateProblem', () => {
  it('accepts a future weekday', () => assert.equal(dateProblem(TUE, TODAY), null));
  it('accepts today itself', () => assert.equal(dateProblem('2026-09-01', '2026-09-01'), null));
  it('rejects the past', () => assert.match(dateProblem('2026-08-31', TODAY)!, /past/));
  it('rejects weekends', () => {
    assert.match(dateProblem(SAT, TODAY)!, /weekend/);
    assert.match(dateProblem(SUN, TODAY)!, /weekend/);
  });
  it('rejects dates that do not exist, which the YYYY-MM-DD regex alone lets through', () => {
    for (const d of ['2027-99-99', '2027-02-30', '2027-13-01', '2027-00-10']) assert.match(dateProblem(d, TODAY)!, /real calendar date/, d);
  });
});

describe('todayAtClinic', () => {
  it('uses Central time, not UTC', () => {
    // 03:00 UTC on Oct 6 is still the evening of Oct 5 in Chicago (CDT, UTC-5).
    assert.equal(todayAtClinic(new Date('2026-10-06T03:00:00Z')), '2026-10-05');
    assert.equal(todayAtClinic(new Date('2026-10-06T06:00:00Z')), '2026-10-06');
  });
});

describe('slotGrid', () => {
  for (const service of KNOWN_SERVICES) {
    it(`${service}: back-to-back slots of ${SERVICE_DURATION_MINUTES[service]} min inside 09:00-17:00, none overlapping`, () => {
      const slots = slotGrid(service, TUE);
      assert.ok(slots.length > 0);
      assert.equal(slots[0].start, '09:00');
      for (const s of slots) {
        assert.equal(toMinutes(s.end) - toMinutes(s.start), SERVICE_DURATION_MINUTES[service]);
        assert.ok(toMinutes(s.end) <= 17 * 60, `${s.start}-${s.end} runs past closing`);
      }
      for (let i = 1; i < slots.length; i++) assert.equal(slots[i].start, slots[i - 1].end);
    });
  }

  it('returns nothing for an unknown service', () => assert.deepEqual(slotGrid('teleportation', TUE), []));
  it('marks some slots busy (the mock calendar backend), deterministically', () => {
    const a = slotGrid('cleaning', TUE);
    assert.ok(a.some((s) => !s.available));
    assert.ok(a.some((s) => s.available));
    assert.deepEqual(a, slotGrid('cleaning', TUE));
  });
});

describe('overlaps', () => {
  it('detects an appointment inside a longer one', () => {
    assert.equal(overlaps({ service: 'root-canal', start: '10:30' }, { service: 'cleaning', start: '11:00' }), true);
  });
  it('is symmetric', () => {
    assert.equal(overlaps({ service: 'cleaning', start: '11:00' }, { service: 'root-canal', start: '10:30' }), true);
  });
  it('lets back-to-back appointments touch', () => {
    assert.equal(overlaps({ service: 'root-canal', start: '10:30' }, { service: 'cleaning', start: '12:00' }), false);
    assert.equal(overlaps({ service: 'cleaning', start: '10:00' }, { service: 'cleaning', start: '10:30' }), false);
  });
  it('treats the same start as a collision whatever the lengths', () => {
    assert.equal(overlaps({ service: 'exam', start: '10:00' }, { service: 'cleaning', start: '10:00' }), true);
  });
});

describe('validateSlot', () => {
  const start = openSlot('cleaning', TUE);
  it('passes an open slot on a future weekday', () => assert.equal(validateSlot('cleaning', TUE, start, TODAY), null));
  it('rejects an unknown service and names the valid ones', () => {
    const p = validateSlot('whitening', TUE, '09:00', TODAY)!;
    assert.equal(p.reason, 'invalid_slot');
    assert.match(p.detail, /cleaning/);
  });
  it('rejects a weekend, a past date and a non-date', () => {
    for (const d of [SAT, '2026-08-01', '2027-99-99']) assert.equal(validateSlot('cleaning', d, '10:00', TODAY)!.reason, 'invalid_slot', d);
  });
  it('rejects a time that is not on the service grid (03:00, 09:10, after closing)', () => {
    for (const t of ['03:00', '09:10', '16:45', '17:00', '23:30']) assert.equal(validateSlot('cleaning', TUE, t, TODAY)!.reason, 'invalid_slot', t);
  });
  it('reports a busy slot as unavailable, not invalid', () => {
    const busy = slotGrid('cleaning', TUE).find((s) => !s.available)!.start;
    assert.equal(validateSlot('cleaning', TUE, busy, TODAY)!.reason, 'slot_unavailable');
  });
});

describe('loadDayBookings / findConflict', () => {
  it('reads only that day\'s bookings, ignoring other days and unrelated keys', async () => {
    const kv = new MockKvNamespace();
    await kv.put(`booking/${TUE}/1000`, JSON.stringify({ service: 'cleaning', start: '10:00' }));
    await kv.put(`booking/${MON}/1000`, JSON.stringify({ service: 'exam', start: '10:00' }));
    await kv.put(`appointment/abc`, JSON.stringify({ service: 'exam', start: '10:00' }));
    await kv.put(`booking/${TUE}/junk`, JSON.stringify({ nope: true }));

    const booked = await loadDayBookings(kv, TUE);

    assert.deepEqual(booked.map((b) => `${b.service}@${b.start}`), ['cleaning@10:00']);
  });

  it('findConflict can ignore the appointment being moved', () => {
    const booked = [{ service: 'cleaning', start: '10:00' }];
    assert.ok(findConflict({ service: 'cleaning', start: '10:00' }, booked));
    assert.equal(findConflict({ service: 'cleaning', start: '10:00' }, booked, { service: 'cleaning', start: '10:00' }), undefined);
  });
});
