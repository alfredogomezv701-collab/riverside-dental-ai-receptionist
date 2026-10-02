import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  joinWaitlistInputSchema,
  JOIN_WAITLIST_TOOL_NAME,
  WAITLIST_KEY,
} from '../src/tools/join_waitlist.js';
import { runJoinWaitlist } from '../src/tools/join_waitlist_handler.js';
import { PATIENT_KEY, digitsOf } from '../src/patients.js';
import { MockKvNamespace } from './mock_kv.js';
import { MON, TUE, WED, SAT, PHONE, PHONE_B, kvCtx, TODAY } from './fixtures.js';

const waitlistInput = (over: Record<string, unknown> = {}) => ({
  date: TUE,
  service: 'cleaning',
  patientName: 'Ada Lovelace',
  patientPhone: PHONE,
  ...over,
});

describe('join_waitlist - constants and keys', () => {
  it('exposes the expected tool name', () => assert.equal(JOIN_WAITLIST_TOOL_NAME, 'join_waitlist'));

  it('builds the waitlist key from the characters Telnyx KV allows, keyed on the last 10 digits', () => {
    assert.equal(WAITLIST_KEY('2026-10-06', '+1 (555) 123-4567'), 'waitlist/2026-10-06/5551234567');
    assert.equal(WAITLIST_KEY('2026-10-06', '555-123-4567'), 'waitlist/2026-10-06/5551234567');
    assert.equal(digitsOf(PHONE).slice(-10), '5551234567');
    // No ':' anywhere in the key (KV rejects them, error 10015).
    assert.doesNotMatch(WAITLIST_KEY('2026-10-06', PHONE), /:/);
  });

  it('uses a key shape consistent with the existing patient/ and booking/ conventions', () => {
    assert.equal(PATIENT_KEY(PHONE), 'patient/5551234567');
    assert.equal(WAITLIST_KEY(TUE, PHONE), 'waitlist/2026-10-06/5551234567');
  });
});

describe('join_waitlist - input schema', () => {
  it('accepts valid input, with the phone in any common format', () => {
    for (const phone of ['+15551234567', '555-123-4567', '(555) 123 4567', '5551234567']) {
      assert.doesNotThrow(() => joinWaitlistInputSchema.parse(waitlistInput({ patientPhone: phone })), phone);
    }
  });

  it('rejects a malformed date', () => {
    for (const date of ['2026-1-1', '10/06/2026', 'tomorrow', '']) {
      assert.throws(() => joinWaitlistInputSchema.parse(waitlistInput({ date })), String(date));
    }
  });

  it('rejects a missing patient name', () => assert.throws(() => joinWaitlistInputSchema.parse(waitlistInput({ patientName: '' }))));

  it('rejects phones without a full number: words, 7 digits, no area code', () => {
    for (const patientPhone of ['unknown', 'this number', '555-1234', '1234567', '', '+1']) {
      assert.throws(() => joinWaitlistInputSchema.parse(waitlistInput({ patientPhone })), String(patientPhone));
    }
  });
});

describe('runJoinWaitlist - date validation (nothing is written for a bad date)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['a weekend', { date: SAT }],
    ['a past date', { date: '2026-08-03' }],
    ['a date that does not exist', { date: '2027-99-99' }],
  ];
  for (const [name, over] of cases) {
    it(`rejects ${name} and writes nothing`, async () => {
      const kv = new MockKvNamespace();
      const res = await runJoinWaitlist(waitlistInput(over) as never, kvCtx(kv));
      assert.equal(res.queued, false);
      assert.equal(res.entry, undefined);
      assert.equal(kv.puts.length, 0);
    });
  }
});

describe('runJoinWaitlist - happy path', () => {
  it('persists a waitlist entry under waitlist/{date}/{phone10}', async () => {
    const kv = new MockKvNamespace();
    const input = waitlistInput();
    const result = await runJoinWaitlist(input as never, kvCtx(kv));

    assert.equal(result.queued, true);
    const entry = result.entry!;
    assert.equal(entry.date, TUE);
    assert.equal(entry.service, 'cleaning');
    assert.equal(entry.patientName, 'Ada Lovelace');
    assert.equal(entry.patientPhone, PHONE);
    assert.ok(entry.entryId.length > 0);
    assert.ok(Date.parse(entry.joinedAt) > 0, 'joinedAt is an ISO timestamp');

    const stored = await kv.get(WAITLIST_KEY(TUE, PHONE), { type: 'json' });
    assert.deepEqual(stored, entry);
    assert.equal(kv.puts.length, 1, 'exactly one KV put');
  });

  it('two different callers for the same day both get queued (separate keys)', async () => {
    const kv = new MockKvNamespace();
    const a = await runJoinWaitlist(waitlistInput() as never, kvCtx(kv));
    const b = await runJoinWaitlist(waitlistInput({ patientName: 'Bob', patientPhone: PHONE_B }) as never, kvCtx(kv));

    assert.equal(a.queued, true);
    assert.equal(b.queued, true);
    assert.notEqual(a.entry!.entryId, b.entry!.entryId);
    assert.equal((await kv.list({ prefix: `waitlist/${TUE}/` })).keys.length, 2);
  });

  it('the same caller for a different date is a separate entry, not a duplicate', async () => {
    const kv = new MockKvNamespace();
    const tue = await runJoinWaitlist(waitlistInput() as never, kvCtx(kv));
    const wed = await runJoinWaitlist(waitlistInput({ date: WED }) as never, kvCtx(kv));

    assert.equal(tue.queued, true);
    assert.equal(wed.queued, true);
    assert.notEqual(tue.entry!.entryId, wed.entry!.entryId);
    assert.equal((await kv.list({ prefix: 'waitlist/' })).keys.length, 2);
  });
});

describe('runJoinWaitlist - idempotent retry', () => {
  it('a second join for the same caller+date returns the existing entry UNCHANGED (no service/name update)', async () => {
    const kv = new MockKvNamespace();
    const first = await runJoinWaitlist(waitlistInput() as never, kvCtx(kv));

    // The model retries on a flaky turn — same phone in a different format, but with a DIFFERENT
    // name and service. The retry returns the ORIGINAL entry unchanged: join_waitlist does not
    // edit a queued entry (the comment on WAITLIST_KEY documents this; the handler returns the
    // stored record verbatim, not a merge of the new arguments over the old record).
    const again = await runJoinWaitlist(
      waitlistInput({ patientPhone: '555-123-4567', patientName: 'Bob Changed', service: 'exam' }) as never,
      kvCtx(kv),
    );

    assert.equal(again.queued, true);
    assert.equal(again.alreadyQueuedByYou, true);
    assert.equal(again.entry!.entryId, first.entry!.entryId, 'same entry id');
    assert.equal(again.entry!.patientName, 'Ada Lovelace', 'the stored name is the ORIGINAL, not the retry');
    assert.equal(again.entry!.service, 'cleaning', 'the stored service is the ORIGINAL, not the retry');
    assert.equal((await kv.list({ prefix: `waitlist/${TUE}/` })).keys.length, 1, 'not a duplicate row');
    assert.equal(kv.puts.length, 1, 'the retry wrote nothing new');
  });
});

describe('runJoinWaitlist - failure modes', () => {
  it('without a KV binding, returns queued false and does not claim to have queued', async () => {
    const res = await runJoinWaitlist(waitlistInput() as never, { kv: undefined, today: TODAY });
    assert.equal(res.queued, false);
    assert.equal(res.entry, undefined);
  });

  it('a KV put failure surfaces (the caller is not told they were queued when the write failed)', async () => {
    const kv = new MockKvNamespace();
    kv.failPutsMatching = /^waitlist\//;
    await assert.rejects(() => runJoinWaitlist(waitlistInput() as never, kvCtx(kv)), /injected/);
  });
});

describe('runJoinWaitlist - leaves KV in a clean state', () => {
  it('does not touch patient/ or booking/ records (the waitlist is independent of bookings)', async () => {
    const kv = new MockKvNamespace();
    await runJoinWaitlist(waitlistInput() as never, kvCtx(kv));
    assert.equal((await kv.list({ prefix: 'patient/' })).keys.length, 0);
    assert.equal((await kv.list({ prefix: 'booking/' })).keys.length, 0);
  });
});
