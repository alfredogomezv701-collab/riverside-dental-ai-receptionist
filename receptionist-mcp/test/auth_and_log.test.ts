import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bearerMatches } from '../src/auth.js';
import { logToolCall, maskPhone, outcomeOf } from '../src/log.js';

describe('bearerMatches (MCP bearer auth)', () => {
  it('accepts the exact bearer token', () => assert.equal(bearerMatches('Bearer s3cret', 's3cret'), true));
  it('rejects a wrong token, a prefix of it, an extension of it, and the wrong scheme', () => {
    for (const h of ['Bearer s3cre', 'Bearer s3cret!', 'Bearer nope', 's3cret', 'Basic s3cret', 'bearer s3cret', '']) {
      assert.equal(bearerMatches(h, 's3cret'), false, h);
    }
  });
  it('rejects a missing header', () => assert.equal(bearerMatches(undefined, 's3cret'), false));
  it('never matches when no secret is configured, even for an empty or "Bearer " header (fail closed)', () => {
    for (const h of ['', 'Bearer ', 'Bearer undefined', undefined]) {
      assert.equal(bearerMatches(h, undefined), false, String(h));
      assert.equal(bearerMatches(h, ''), false, String(h));
    }
  });
});

describe('tool-call logging', () => {
  it('masks all but the last four digits of a phone', () => {
    assert.equal(maskPhone('+1 (555) 123-4567'), '***4567');
    assert.equal(maskPhone('12'), '****');
    assert.equal(maskPhone(undefined), undefined);
  });

  it('derives an outcome a dashboard can group by', () => {
    assert.equal(outcomeOf({ confirmed: true }), 'ok');
    assert.equal(outcomeOf({ success: true }), 'ok');
    assert.equal(outcomeOf({ confirmed: false, reason: 'slot_already_booked' }), 'slot_already_booked');
    assert.equal(outcomeOf({ success: false }), 'rejected');
    assert.equal(outcomeOf({ slots: [] }), 'ok');
  });

  it('logs one JSON line with the request id, masked caller, outcome and latency - never the raw number', async () => {
    const lines: string[] = [];
    const result = await logToolCall('book_appointment', 'req-9', { caller: '+15551234567' }, async () => ({ confirmed: true }), (l) => lines.push(l));

    assert.deepEqual(result, { confirmed: true });
    const log = JSON.parse(lines[0]);
    assert.equal(log.request_id, 'req-9');
    assert.equal(log.tool, 'book_appointment');
    assert.equal(log.caller, '***4567');
    assert.equal(log.outcome, 'ok');
    assert.equal(typeof log.latency_ms, 'number');
    assert.ok(!lines[0].includes('5551234567'));
  });

  it('logs failures with outcome "error" and rethrows', async () => {
    const lines: string[] = [];
    await assert.rejects(
      () => logToolCall('book_appointment', 'req-10', {}, async () => { throw new Error('kv down'); }, (l) => lines.push(l)),
      /kv down/,
    );
    const log = JSON.parse(lines[0]);
    assert.equal(log.outcome, 'error');
    assert.equal(log.error, 'kv down');
  });
});
