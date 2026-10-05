import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DaySlotActor, DEFAULT_HOLD_DURATION_MS } from '../src/day_slot_actor.js';
import { createMockActorContext } from './mock_actor_context.js';
import entry from '../src/index.js';

function makeActor() {
  const ctx = createMockActorContext('2026-10-01');
  const actor = new DaySlotActor(ctx, {} as Env);
  return { actor, ctx };
}

describe('holdSlot', () => {
  it('succeeds on an open slot and sets the alarm to the hold expiry', async () => {
    const { actor, ctx } = makeActor();
    const before = Date.now();

    const result = await actor.holdSlot('09:00', 'caller-a');

    assert.equal(result.success, true);
    assert.ok(result.holdExpiresAt! >= before + DEFAULT_HOLD_DURATION_MS);
    assert.equal(await ctx.storage.getAlarm(), result.holdExpiresAt);
  });

  it('rejects a second caller holding the same open slot', async () => {
    const { actor } = makeActor();
    await actor.holdSlot('09:00', 'caller-a');

    const result = await actor.holdSlot('09:00', 'caller-b');

    assert.equal(result.success, false);
    assert.equal(result.reason, 'already_held_by_other');
  });

  it('allows the same caller to refresh their own hold', async () => {
    const { actor } = makeActor();
    await actor.holdSlot('09:00', 'caller-a');

    const result = await actor.holdSlot('09:00', 'caller-a');

    assert.equal(result.success, true);
  });

  it('rejects holding an already-booked slot', async () => {
    const { actor } = makeActor();
    await actor.holdSlot('09:00', 'caller-a');
    await actor.confirmSlot('09:00', 'caller-a');

    const result = await actor.holdSlot('09:00', 'caller-b');

    assert.equal(result.success, false);
    assert.equal(result.reason, 'already_booked');
  });

  it('allows a new hold once a prior hold from another caller has expired', async () => {
    const { actor } = makeActor();
    await actor.holdSlot('09:00', 'caller-a', 30, -1); // already expired

    const result = await actor.holdSlot('09:00', 'caller-b');

    assert.equal(result.success, true);
  });

  it('tracks independent slots separately, alarm follows the earliest expiry', async () => {
    const { actor, ctx } = makeActor();

    const first = await actor.holdSlot('09:00', 'caller-a', 30, 5000);
    const second = await actor.holdSlot('10:00', 'caller-b', 30, 1000);

    assert.equal(await ctx.storage.getAlarm(), second.holdExpiresAt);
    assert.ok(second.holdExpiresAt! < first.holdExpiresAt!);
  });
});

describe('confirmSlot', () => {
  it('confirms a hold owned by the same caller', async () => {
    const { actor } = makeActor();
    await actor.holdSlot('09:00', 'caller-a');

    const result = await actor.confirmSlot('09:00', 'caller-a');

    assert.equal(result.success, true);
    const slot = await actor.getSlot('09:00');
    assert.equal(slot?.status, 'booked');
  });

  it('rejects confirming a slot with no hold', async () => {
    const { actor } = makeActor();
    const result = await actor.confirmSlot('09:00', 'caller-a');
    assert.equal(result.success, false);
    assert.equal(result.reason, 'not_held');
  });

  it('rejects confirming a hold owned by a different caller', async () => {
    const { actor } = makeActor();
    await actor.holdSlot('09:00', 'caller-a');

    const result = await actor.confirmSlot('09:00', 'caller-b');

    assert.equal(result.success, false);
    assert.equal(result.reason, 'held_by_other');
  });

  it('rejects confirming an expired hold and clears it', async () => {
    const { actor } = makeActor();
    await actor.holdSlot('09:00', 'caller-a', 30, -1);

    const result = await actor.confirmSlot('09:00', 'caller-a');

    assert.equal(result.success, false);
    assert.equal(result.reason, 'hold_expired');
    assert.equal(await actor.getSlot('09:00'), undefined);
  });

  it('clears the alarm once the only pending hold is confirmed', async () => {
    const { actor, ctx } = makeActor();
    await actor.holdSlot('09:00', 'caller-a');
    assert.notEqual(await ctx.storage.getAlarm(), null);

    await actor.confirmSlot('09:00', 'caller-a');

    assert.equal(await ctx.storage.getAlarm(), null);
  });
});

describe('releaseSlot', () => {
  it('releases a hold owned by the caller', async () => {
    const { actor } = makeActor();
    await actor.holdSlot('09:00', 'caller-a');

    const result = await actor.releaseSlot('09:00', 'caller-a');

    assert.equal(result.success, true);
    assert.equal(await actor.getSlot('09:00'), undefined);
  });

  it('rejects releasing a slot not held by the caller', async () => {
    const { actor } = makeActor();
    await actor.holdSlot('09:00', 'caller-a');

    const result = await actor.releaseSlot('09:00', 'caller-b');

    assert.equal(result.success, false);
    assert.equal(result.reason, 'not_held_by_caller');
  });

  it('releasing a booked slot works too (cancellation)', async () => {
    const { actor } = makeActor();
    await actor.holdSlot('09:00', 'caller-a');
    await actor.confirmSlot('09:00', 'caller-a');

    const result = await actor.releaseSlot('09:00', 'caller-a');

    assert.equal(result.success, true);
    assert.equal(await actor.getSlot('09:00'), undefined);
  });
});

describe('alarm — the race the actor exists to prevent', () => {
  it('sweeps only expired holds, leaves live holds and booked slots alone', async () => {
    const { actor, ctx } = makeActor();
    await actor.holdSlot('09:00', 'caller-a', 30, -1); // expired
    await actor.holdSlot('10:00', 'caller-b', 30, 60_000); // still live
    await actor.holdSlot('11:00', 'caller-c');
    await actor.confirmSlot('11:00', 'caller-c'); // booked

    await actor.alarm({ retryCount: 0, isRetry: false });

    assert.equal(await actor.getSlot('09:00'), undefined);
    assert.equal((await actor.getSlot('10:00'))?.status, 'held');
    assert.equal((await actor.getSlot('11:00'))?.status, 'booked');
    // Alarm reschedules to the remaining live hold's expiry, not cleared.
    assert.notEqual(await ctx.storage.getAlarm(), null);
  });

  it('clears the alarm when nothing remains held after the sweep', async () => {
    const { actor, ctx } = makeActor();
    await actor.holdSlot('09:00', 'caller-a', 30, -1);

    await actor.alarm({ retryCount: 0, isRetry: false });

    assert.equal(await ctx.storage.getAlarm(), null);
  });

  it('two callers racing for the same slot: only one wins, even if both check first', async () => {
    const { actor } = makeActor();

    // Simulates the race: both hold attempts happen before either confirms.
    const a = await actor.holdSlot('09:00', 'caller-a');
    const b = await actor.holdSlot('09:00', 'caller-b');

    assert.equal(a.success, true);
    assert.equal(b.success, false);

    const confirmA = await actor.confirmSlot('09:00', 'caller-a');
    assert.equal(confirmA.success, true);
  });
});

describe('multi-quantum holds', () => {
  it('a 90-minute appointment holds 3 quantums atomically', async () => {
    const { actor } = makeActor();

    const result = await actor.holdSlot('09:00', 'caller-a', 90);
    assert.equal(result.success, true);

    assert.equal((await actor.getSlot('09:00'))?.status, 'held');
    assert.equal((await actor.getSlot('09:30'))?.status, 'held');
    assert.equal((await actor.getSlot('10:00'))?.status, 'held');
  });

  it('a rival cannot hold any quantum of a multi-quantum hold', async () => {
    const { actor } = makeActor();
    await actor.holdSlot('09:00', 'caller-a', 90);

    assert.equal((await actor.holdSlot('09:00', 'caller-b')).success, false);
    assert.equal((await actor.holdSlot('09:30', 'caller-b')).success, false);
    assert.equal((await actor.holdSlot('10:00', 'caller-b')).success, false);
  });

  it('confirming a multi-quantum hold books all quantums', async () => {
    const { actor } = makeActor();
    await actor.holdSlot('09:00', 'caller-a', 90);

    const confirm = await actor.confirmSlot('09:00', 'caller-a');
    assert.equal(confirm.success, true);

    assert.equal((await actor.getSlot('09:00'))?.status, 'booked');
    assert.equal((await actor.getSlot('09:30'))?.status, 'booked');
    assert.equal((await actor.getSlot('10:00'))?.status, 'booked');
  });

  it('releasing a multi-quantum hold frees all quantums', async () => {
    const { actor } = makeActor();
    await actor.holdSlot('09:00', 'caller-a', 90);
    await actor.confirmSlot('09:00', 'caller-a');

    const release = await actor.releaseSlot('09:00', 'caller-a');
    assert.equal(release.success, true);

    assert.equal(await actor.getSlot('09:00'), undefined);
    assert.equal(await actor.getSlot('09:30'), undefined);
    assert.equal(await actor.getSlot('10:00'), undefined);
  });

  it('an overlapping multi-quantum hold is rejected if any quantum is taken', async () => {
    const { actor } = makeActor();
    await actor.holdSlot('09:30', 'caller-a', 30);

    const result = await actor.holdSlot('09:00', 'caller-b', 90);
    assert.equal(result.success, false);
    assert.equal(result.reason, 'already_held_by_other');
  });

  it('alarm sweeps all quantums of an expired multi-quantum hold, counts one expiration', async () => {
    const { actor, ctx } = makeActor();
    await actor.holdSlot('09:00', 'caller-a', 90, -1);

    await actor.alarm({ retryCount: 0, isRetry: false });

    assert.equal(await actor.getSlot('09:00'), undefined);
    assert.equal(await actor.getSlot('09:30'), undefined);
    assert.equal(await actor.getSlot('10:00'), undefined);

    const stats = await actor.getStats();
    assert.equal(stats.expirations, 1);
    assert.equal(stats.conversions, 0);
  });
});

describe('metrics', () => {
  it('counts a conversion when a hold is confirmed', async () => {
    const { actor } = makeActor();
    await actor.holdSlot('09:00', 'caller-a');
    await actor.confirmSlot('09:00', 'caller-a');

    const stats = await actor.getStats();
    assert.equal(stats.conversions, 1);
    assert.equal(stats.expirations, 0);
    assert.equal(stats.conversionRate, '100.00%');
  });

  it('counts an expiration when a hold is swept by the alarm', async () => {
    const { actor } = makeActor();
    await actor.holdSlot('09:00', 'caller-a', 30, -1);

    await actor.alarm({ retryCount: 0, isRetry: false });

    const stats = await actor.getStats();
    assert.equal(stats.conversions, 0);
    assert.equal(stats.expirations, 1);
    assert.equal(stats.conversionRate, '0.00%');
  });

  it('explicit release does not count as either conversion or expiration', async () => {
    const { actor } = makeActor();
    await actor.holdSlot('09:00', 'caller-a');
    await actor.releaseSlot('09:00', 'caller-a');

    const stats = await actor.getStats();
    assert.equal(stats.conversions, 0);
    assert.equal(stats.expirations, 0);
    assert.equal(stats.conversionRate, '0.00%');
  });

  it('conversion rate is correct with mixed outcomes', async () => {
    const { actor } = makeActor();
    // 2 conversions
    await actor.holdSlot('09:00', 'a'); await actor.confirmSlot('09:00', 'a');
    await actor.holdSlot('10:00', 'b'); await actor.confirmSlot('10:00', 'b');
    // 1 expiration
    await actor.holdSlot('11:00', 'c', 30, -1);
    await actor.alarm({ retryCount: 0, isRetry: false });
    // 1 explicit release (not counted)
    await actor.holdSlot('12:00', 'd');
    await actor.releaseSlot('12:00', 'd');

    const stats = await actor.getStats();
    assert.equal(stats.conversions, 2);
    assert.equal(stats.expirations, 1);
    assert.equal(stats.conversionRate, '66.67%');
  });
});

describe('http surface', () => {
  it('returns 404 for non-health non-stats routes', async () => {
    const res = await entry.fetch(new Request('https://x.test/anything'), {} as Env);
    assert.equal(res.status, 404);
  });

  it('/health returns ok, version and empty secrets', async () => {
    const res = await entry.fetch(new Request('https://x.test/health'), {} as Env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(typeof body.version === 'string');
    assert.deepEqual(body.secrets, {});
  });

  function statsEnv(actor: DaySlotActor, secret = 'correct-secret') {
    return {
      DAY_SLOT: {
        idFromName: () => ({ getStats: () => actor.getStats() }),
      },
      SECRETS: { get: async () => secret },
    } as unknown as Env;
  }

  it('/actor/stats returns metrics for a given date, with the correct bearer', async () => {
    // We need an env with a real DAY_SLOT binding that routes to an actual actor instance.
    // The mock context approach doesn't give us a typed Env, so we simulate the binding.
    const actor = new DaySlotActor(createMockActorContext('2026-10-05'), {} as Env);
    await actor.holdSlot('09:00', 'caller-a');
    await actor.confirmSlot('09:00', 'caller-a');

    const res = await entry.fetch(
      new Request('https://x.test/actor/stats?date=2026-10-05', { headers: { authorization: 'Bearer correct-secret' } }),
      statsEnv(actor),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.conversions, 1);
    assert.equal(body.expirations, 0);
    assert.equal(body.conversionRate, '100.00%');
  });

  it('/actor/stats rejects a missing bearer', async () => {
    const actor = new DaySlotActor(createMockActorContext('2026-10-05'), {} as Env);
    const res = await entry.fetch(new Request('https://x.test/actor/stats?date=2026-10-05'), statsEnv(actor));
    assert.equal(res.status, 401);
  });

  it('/actor/stats rejects a wrong bearer', async () => {
    const actor = new DaySlotActor(createMockActorContext('2026-10-05'), {} as Env);
    const res = await entry.fetch(
      new Request('https://x.test/actor/stats?date=2026-10-05', { headers: { authorization: 'Bearer wrong' } }),
      statsEnv(actor),
    );
    assert.equal(res.status, 401);
  });

  it('/actor/stats fails closed when the secret was never created', async () => {
    const actor = new DaySlotActor(createMockActorContext('2026-10-05'), {} as Env);
    const env = {
      DAY_SLOT: { idFromName: () => ({ getStats: () => actor.getStats() }) },
      SECRETS: { get: async () => { throw new Error('secret not found'); } },
    } as unknown as Env;
    const res = await entry.fetch(
      new Request('https://x.test/actor/stats?date=2026-10-05', { headers: { authorization: 'Bearer anything' } }),
      env,
    );
    assert.equal(res.status, 401);
  });

  it('/actor/stats rejects an invalid date, even with a correct bearer', async () => {
    const actor = new DaySlotActor(createMockActorContext('2026-10-05'), {} as Env);
    const res = await entry.fetch(
      new Request('https://x.test/actor/stats?date=tomorrow', { headers: { authorization: 'Bearer correct-secret' } }),
      statsEnv(actor),
    );
    assert.equal(res.status, 400);
  });
});
