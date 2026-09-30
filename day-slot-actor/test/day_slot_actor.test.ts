import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DaySlotActor, DEFAULT_HOLD_DURATION_MS } from '../src/day_slot_actor.js';
import { createMockActorContext } from './mock_actor_context.js';

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
    await actor.holdSlot('09:00', 'caller-a', -1); // already expired

    const result = await actor.holdSlot('09:00', 'caller-b');

    assert.equal(result.success, true);
  });

  it('tracks independent slots separately, alarm follows the earliest expiry', async () => {
    const { actor, ctx } = makeActor();

    const first = await actor.holdSlot('09:00', 'caller-a', 5000);
    const second = await actor.holdSlot('10:00', 'caller-b', 1000);

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
    await actor.holdSlot('09:00', 'caller-a', -1);

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
    await actor.holdSlot('09:00', 'caller-a', -1); // expired
    await actor.holdSlot('10:00', 'caller-b', 60_000); // still live
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
    await actor.holdSlot('09:00', 'caller-a', -1);

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
