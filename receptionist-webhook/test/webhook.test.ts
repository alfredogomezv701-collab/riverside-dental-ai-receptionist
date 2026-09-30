import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { KvNamespace } from '@telnyx/edge-runtime';
import { DaySlotActor } from '../../day-slot-actor/src/day_slot_actor.js';
import { createMockActorContext } from '../../day-slot-actor/test/mock_actor_context.js';
import { handleRequest, type WebhookEnv } from '../src/index.js';
import type { DaySlotNamespace } from '../src/day_slot_binding.js';
import { resetFlagCache, todayAtClinic } from '../src/patient_lookup.js';
import { redact, maskPhone } from '../src/log.js';

const ACTOR_SECRET = 's3cret';
const TOKEN = 'wh-token';

function fakeKv(seed: Record<string, unknown> = {}) {
  const store = new Map<string, string>(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const puts: Array<{ key: string; ttl?: number }> = [];
  const keysRead: string[] = [];
  const stats = { gets: 0, inFlight: 0, peakInFlight: 0 };
  // Telnyx KV rejects any other character (error 10015) - a ':' separator once got past unit tests.
  const checkKey = (key: string) => {
    if (!/^[a-zA-Z0-9\-_/=.]+$/.test(key)) throw new Error(`KV 10015 Invalid key format: ${key}`);
  };
  const kv = {
    async get(key: string, opts?: { type?: string }) {
      checkKey(key);
      keysRead.push(key);
      stats.gets++;
      stats.peakInFlight = Math.max(stats.peakInFlight, ++stats.inFlight);
      await new Promise((r) => setTimeout(r, 2)); // a real read is a network round trip
      stats.inFlight--;
      const v = store.get(key);
      if (v === undefined) return null;
      return opts?.type === 'json' ? JSON.parse(v) : v;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      checkKey(key);
      store.set(key, value);
      puts.push({ key, ttl: opts?.expirationTtl });
    },
  } as unknown as KvNamespace;
  return { kv, store, puts, stats, keysRead };
}

/**
 * Real DaySlotActor instances, one per date - same routing the platform does by name.
 * The platform runs each actor's calls one at a time; a bare in-process instance
 * doesn't, so calls are queued per actor here to reproduce that guarantee (the
 * thing under test is the proxy + actor logic, not the runtime's scheduler).
 */
function realActorNamespace(): DaySlotNamespace {
  const actors = new Map<string, { actor: DaySlotActor; tail: Promise<unknown> }>();
  const serial = <A extends unknown[], R>(entry: { tail: Promise<unknown> }, fn: (...a: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      const run = entry.tail.then(() => fn(...args));
      entry.tail = run.catch(() => undefined);
      return run;
    };
  return {
    idFromName(name: string) {
      if (!actors.has(name)) {
        actors.set(name, { actor: new DaySlotActor(createMockActorContext(name), {} as Env), tail: Promise.resolve() });
      }
      const e = actors.get(name)!;
      return {
        holdSlot: serial(e, (s: string, c: string, d?: number) => e.actor.holdSlot(s, c, d)),
        confirmSlot: serial(e, (s: string, c: string) => e.actor.confirmSlot(s, c)),
        releaseSlot: serial(e, (s: string, c: string) => e.actor.releaseSlot(s, c)),
      };
    },
  };
}

/** `secrets` maps handle -> value; a handle that is absent behaves like a secret that was never created (get() throws). */
function makeEnv(seed: Record<string, unknown> = {}, secrets: Record<string, string> = { ACTOR_PROXY_SECRET: ACTOR_SECRET, WEBHOOK_TOKEN: TOKEN }) {
  resetFlagCache(); // module-level 5s flag cache must not leak between tests
  const k = fakeKv(seed);
  const env: WebhookEnv = {
    CACHE: k.kv,
    DAY_SLOT: realActorNamespace(),
    SECRETS: {
      get: async (h: string) => {
        if (!(h in secrets)) throw new Error(`secret ${h} not found`);
        return secrets[h];
      },
    },
  };
  return { env, ...k };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://x.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const authed = { authorization: `Bearer ${ACTOR_SECRET}` };
const DV = `/?token=${TOKEN}`;
const initEvent = (phone: string) => ({
  data: { event_type: 'assistant.initialization', payload: { telnyx_end_user_target: phone, call_control_id: 'v3:abc' } },
});
const vars = async (env: WebhookEnv, phone: string) =>
  ((await (await handleRequest(post(DV, initEvent(phone)), env)).json()) as any).dynamic_variables;
const appt = (id: string, date: string, start = '10:00', service = 'cleaning') => ({ appointmentId: id, service, date, start });
const FUTURE = '2099-01-05';
const FUTURE2 = '2099-02-09';
const PAST = '2001-01-01';

function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (l: string) => lines.push(l);
  return fn().then(
    (result) => ({ result, lines }),
  ).finally(() => {
    console.log = orig;
  });
}

describe('dynamic variables webhook - authentication', () => {
  // The route returns a patient's name and appointment id for whatever number it is asked about.
  const body = initEvent('+15551234567');
  const seeded = { 'patient/5551234567': { patientName: 'Ada', appointments: [appt('a1', FUTURE)] } };

  it('refuses a request with no token, and reveals nothing', async () => {
    const { env, stats } = makeEnv(seeded);
    const res = await handleRequest(post('/', body), env);
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.doesNotMatch(text, /Ada|a1|dynamic_variables/);
    assert.equal(stats.gets, 0, 'must not touch KV before authenticating');
  });

  it('refuses a wrong token, a truncated token, an extended token and an empty token', async () => {
    for (const t of ['nope', TOKEN.slice(0, -1), TOKEN + 'x', '']) {
      const { env } = makeEnv(seeded);
      assert.equal((await handleRequest(post(`/?token=${t}`, body), env)).status, 401, `token "${t}"`);
    }
  });

  it('accepts the right token', async () => {
    const { env } = makeEnv(seeded);
    const res = await handleRequest(post(DV, body), env);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).dynamic_variables.patient_name, 'Ada');
  });

  it('fails closed when the WEBHOOK_TOKEN secret was never created, even for an empty token', async () => {
    for (const path of ['/', '/?token=', `/?token=${TOKEN}`]) {
      const { env } = makeEnv(seeded, { ACTOR_PROXY_SECRET: ACTOR_SECRET });
      assert.equal((await handleRequest(post(path, body), env)).status, 401, path);
    }
  });

  it('fails closed when the WEBHOOK_TOKEN secret is empty', async () => {
    const { env } = makeEnv(seeded, { ACTOR_PROXY_SECRET: ACTOR_SECRET, WEBHOOK_TOKEN: '' });
    assert.equal((await handleRequest(post('/?token=', body), env)).status, 401);
  });

  it('does not accept the actor-proxy bearer secret as a webhook token (secrets are not interchangeable)', async () => {
    const { env } = makeEnv(seeded);
    assert.equal((await handleRequest(post(`/?token=${ACTOR_SECRET}`, body), env)).status, 401);
    assert.equal((await handleRequest(post('/', body, authed), env)).status, 401);
  });

  it('never writes the token, or the caller number, to the logs', async () => {
    const { env } = makeEnv(seeded);
    const { lines } = await captureLogs(async () => {
      await handleRequest(post(DV, body), env);
      await handleRequest(post('/?token=wrong', body), env);
    });
    for (const l of lines) {
      assert.ok(!l.includes(TOKEN) && !l.includes('wrong'), 'token leaked into logs');
      assert.ok(!l.includes('5551234567'), 'full phone number leaked into logs');
    }
    assert.equal(JSON.parse(lines[1]).outcome, 'unauthorized');
  });
});

describe('dynamic variables webhook - lookup', () => {
  it('returns new-caller defaults for an unknown number', async () => {
    const { env } = makeEnv();
    const v = await vars(env, '+15550001111');
    assert.deepEqual(v, {
      is_returning_patient: 'false',
      patient_name: '',
      next_appointment: '',
      next_appointment_id: '',
      appointment_count: '0',
      waitlist_mode: 'false',
    });
  });

  it('recognises a returning patient by the last 10 digits, whatever the number format', async () => {
    const { env } = makeEnv({ 'patient/5551234567': { patientName: 'Ada Lovelace', appointments: [appt('a1', FUTURE, '10:00')] } });
    for (const phone of ['+15551234567', '555-123-4567', '(555) 123 4567']) {
      const v = await vars(env, phone);
      assert.equal(v.is_returning_patient, 'true', phone);
      assert.equal(v.patient_name, 'Ada Lovelace');
      assert.equal(v.next_appointment, `cleaning on ${FUTURE} at 10:00`);
      assert.equal(v.next_appointment_id, 'a1');
      assert.equal(v.appointment_count, '1');
    }
  });

  // Anonymous / blocked / junk caller IDs used to collapse to the key "patient/" (empty digits), so one
  // junk booking leaked a name and appointment to every unidentified caller.
  it('never looks up a caller ID that is not a dialable number, and never reads the bare "patient/" key', async () => {
    const { env, keysRead } = makeEnv({
      'patient/': { patientName: 'Leaked Person', appointments: [appt('x', FUTURE)] },
      'patient/5551234': { patientName: 'Short Number', appointments: [appt('y', FUTURE)] },
    });
    for (const phone of ['anonymous', 'unknown', 'Restricted', '', '+1', '555-1234', '1234567', 'sip:user@example.com']) {
      const v = await vars(env, phone);
      assert.equal(v.is_returning_patient, 'false', `"${phone}"`);
      assert.equal(v.patient_name, '');
    }
    assert.equal((await vars(env, undefined as unknown as string)).is_returning_patient, 'false');
    assert.ok(!keysRead.some((k) => k.startsWith('patient/')), `patient keys read: ${keysRead.filter((k) => k.startsWith('patient/'))}`);
  });

  it('picks the soonest upcoming appointment and counts them; past ones are ignored', async () => {
    const { env } = makeEnv({
      'patient/5551234567': { patientName: 'Ada', appointments: [appt('past', PAST), appt('later', FUTURE2), appt('soon', FUTURE, '09:00')] },
    });
    const v = await vars(env, '+15551234567');
    assert.equal(v.next_appointment_id, 'soon');
    assert.equal(v.appointment_count, '2');
  });

  it('is a returning patient with nothing upcoming when every appointment has passed', async () => {
    const { env } = makeEnv({ 'patient/5551234567': { patientName: 'Ada', appointments: [appt('past', PAST)] } });
    const v = await vars(env, '+15551234567');
    assert.deepEqual([v.is_returning_patient, v.next_appointment, v.next_appointment_id, v.appointment_count], ['true', '', '', '0']);
  });

  it('todayAtClinic follows Central time, not UTC', () => {
    assert.equal(todayAtClinic(new Date('2026-10-06T03:00:00Z')), '2026-10-05');
  });

  // Latency: this handler blocks the start of every conversation and each KV read is a network round
  // trip, so what matters is the number of *sequential* round trips.
  it('answers a known caller in ONE round trip: flag and patient record are read concurrently', async () => {
    const { env, stats } = makeEnv({ 'patient/5551234567': { patientName: 'Ada', appointments: [appt('a1', FUTURE)] } });
    await vars(env, '+15551234567');
    assert.equal(stats.gets, 2);
    assert.equal(stats.peakInFlight, 2, 'reads must overlap, not run one after another');
  });

  it('answers an unknown caller in one round trip too', async () => {
    const { env, stats } = makeEnv();
    await vars(env, '+15550001111');
    assert.equal(stats.peakInFlight, 2);
    assert.equal(stats.gets, 2);
  });

  it('never writes to KV on the request path', async () => {
    const { env, puts } = makeEnv({ 'patient/5551234567': { patientName: 'Ada', appointments: [appt('a1', FUTURE)] } });
    await vars(env, '+15551234567');
    await vars(env, '+15550001111');
    assert.equal(puts.length, 0);
  });

  it('sees a booking made right after an unknown-caller lookup (no stale "new caller")', async () => {
    const { env, store } = makeEnv();
    assert.equal((await vars(env, '+15551234567')).is_returning_patient, 'false');
    store.set('patient/5551234567', JSON.stringify({ patientName: 'Ada', appointments: [appt('a1', FUTURE)] }));
    assert.equal((await vars(env, '+15551234567')).is_returning_patient, 'true');
  });

  it('after the last appointment is cancelled (record removed) the caller is greeted as new again', async () => {
    const { env, store } = makeEnv({ 'patient/5551234567': { patientName: 'Ada', appointments: [appt('a1', FUTURE)] } });
    store.delete('patient/5551234567');
    assert.equal((await vars(env, '+15551234567')).is_returning_patient, 'false');
  });

  it('still understands the older record shapes: with a summary string (one read) and id-only (one extra read)', async () => {
    const summary = makeEnv({ 'patient/5551234567': { patientName: 'Ada', appointmentId: 'a1', nextAppointment: 'cleaning on 2026-10-05 at 10:00' } });
    const s = await vars(summary.env, '+15551234567');
    assert.equal(s.next_appointment, 'cleaning on 2026-10-05 at 10:00');
    assert.equal(s.next_appointment_id, 'a1');
    assert.equal(summary.stats.gets, 2);

    const idOnly = makeEnv({
      'patient/5551234567': { patientName: 'Ada', appointmentId: 'a1' },
      'appointment/a1': { service: 'cleaning', date: '2026-10-05', start: '10:00' },
    });
    assert.equal((await vars(idOnly.env, '+15551234567')).next_appointment, 'cleaning on 2026-10-05 at 10:00');
    assert.equal(idOnly.stats.gets, 3);
  });

  it('flips waitlist_mode without a redeploy, within the flag cache window', async () => {
    const { env, store } = makeEnv();
    assert.equal((await vars(env, '+15550001111')).waitlist_mode, 'false');
    store.set('flag/waitlist_mode', 'on');
    assert.equal((await vars(env, '+15550001111')).waitlist_mode, 'false', 'inside the 5s window the cached value is served');
    resetFlagCache(); // = the window elapsing
    assert.equal((await vars(env, '+15550001111')).waitlist_mode, 'true');
  });

  it('serves repeat calls from the flag cache: only the patient read hits KV', async () => {
    const { env, stats } = makeEnv();
    await vars(env, '+15550001111');
    stats.gets = 0;
    await vars(env, '+15550001111');
    assert.equal(stats.gets, 1);
  });

  it('degrades gracefully when the payload has no caller number', async () => {
    const { env } = makeEnv();
    const res = await handleRequest(post(DV, {}), env);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).dynamic_variables.is_returning_patient, 'false');
  });

  it('logs one structured line with masked caller, request id and outcome', async () => {
    const { env } = makeEnv();
    const { result: res, lines } = await captureLogs(() =>
      handleRequest(post(DV, initEvent('+15551234567'), { 'x-request-id': 'req-1' }), env),
    );
    const log = JSON.parse(lines[0]);
    assert.equal(log.request_id, 'req-1');
    assert.equal(res.headers.get('x-request-id'), 'req-1');
    assert.equal(log.caller, '***4567');
    assert.equal(log.node, 'identify_caller');
    assert.equal(log.outcome, 'new_caller');
    assert.equal(typeof log.latency_ms, 'number');
    assert.equal(log.kv_reads, 1);
  });

  it('redacts phone digits out of error text (a KV error can quote the key patient/5551234567)', async () => {
    const { env } = makeEnv();
    (env.CACHE as unknown as { get: () => Promise<never> }).get = async () => {
      throw new Error('KV get("patient/5551234567") failed: HTTP 500');
    };
    const { result: res, lines } = await captureLogs(() => handleRequest(post(DV, initEvent('+15551234567')), env));
    assert.equal(res.status, 500);
    assert.ok(!lines[0].includes('5551234567'), lines[0]);
    assert.match(JSON.parse(lines[0]).error, /patient\/\*\*\*/);
    assert.equal(redact('call 15551234567 or 555'), 'call *** or 555');
    assert.equal(maskPhone('+15551234567'), '***4567');
  });
});

describe('actor proxy', () => {
  const slot = { date: '2026-10-05', start: '09:00' };

  it('rejects requests without the shared secret', async () => {
    const { env } = makeEnv();
    const res = await handleRequest(post('/actor/hold', { ...slot, callerId: 'a' }), env);
    assert.equal(res.status, 401);
    const wrong = await handleRequest(post('/actor/hold', { ...slot, callerId: 'a' }, { authorization: 'Bearer nope' }), env);
    assert.equal(wrong.status, 401);
  });

  it('fails closed when no secret is configured, even with an empty bearer', async () => {
    const { env } = makeEnv({}, {});
    for (const authorization of ['Bearer ', 'Bearer', '']) {
      const res = await handleRequest(post('/actor/hold', { ...slot, callerId: 'a' }, { authorization }), env);
      assert.equal(res.status, 401, JSON.stringify(authorization));
    }
  });

  it('does not accept the webhook token as an actor-proxy secret', async () => {
    const { env } = makeEnv();
    const res = await handleRequest(post('/actor/hold', { ...slot, callerId: 'a' }, { authorization: `Bearer ${TOKEN}` }), env);
    assert.equal(res.status, 401);
  });

  it('hold -> confirm -> second caller is rejected, all through the real actor', async () => {
    const { env } = makeEnv();
    const hold = (await (await handleRequest(post('/actor/hold', { ...slot, callerId: 'a' }, authed), env)).json()) as any;
    assert.equal(hold.success, true);
    const rival = (await (await handleRequest(post('/actor/hold', { ...slot, callerId: 'b' }, authed), env)).json()) as any;
    assert.deepEqual([rival.success, rival.reason], [false, 'already_held_by_other']);
    const confirm = (await (await handleRequest(post('/actor/confirm', { ...slot, callerId: 'a' }, authed), env)).json()) as any;
    assert.equal(confirm.success, true);
    const late = (await (await handleRequest(post('/actor/hold', { ...slot, callerId: 'b' }, authed), env)).json()) as any;
    assert.equal(late.reason, 'already_booked');
  });

  it('release frees the slot for another caller', async () => {
    const { env } = makeEnv();
    await handleRequest(post('/actor/hold', { ...slot, callerId: 'a' }, authed), env);
    const rel = (await (await handleRequest(post('/actor/release', { ...slot, callerId: 'a' }, authed), env)).json()) as any;
    assert.equal(rel.success, true);
    const next = (await (await handleRequest(post('/actor/hold', { ...slot, callerId: 'b' }, authed), env)).json()) as any;
    assert.equal(next.success, true);
  });

  it('exactly one of two concurrent holds wins', async () => {
    const { env } = makeEnv();
    const [a, b] = await Promise.all(
      ['a', 'b'].map(async (callerId) =>
        ((await (await handleRequest(post('/actor/hold', { ...slot, callerId }, authed), env)).json()) as any).success,
      ),
    );
    assert.equal([a, b].filter(Boolean).length, 1);
  });

  it('isolates state per clinic-day', async () => {
    const { env } = makeEnv();
    await handleRequest(post('/actor/hold', { ...slot, callerId: 'a' }, authed), env);
    const other = (await (await handleRequest(post('/actor/hold', { date: '2026-10-06', start: '09:00', callerId: 'b' }, authed), env)).json()) as any;
    assert.equal(other.success, true);
  });

  it('400s on a malformed body and 404s on an unknown action', async () => {
    const { env } = makeEnv();
    assert.equal((await handleRequest(post('/actor/hold', { date: 'tomorrow', start: '9am', callerId: 'a' }, authed), env)).status, 400);
    assert.equal((await handleRequest(post('/actor/explode', { ...slot, callerId: 'a' }, authed), env)).status, 404);
  });

  it('logs outcome as the actor rejection reason, with the caller masked and the MCP request id', async () => {
    const { env } = makeEnv();
    await handleRequest(post('/actor/hold', { ...slot, callerId: '+15551234567' }, authed), env);
    const { lines } = await captureLogs(() =>
      handleRequest(post('/actor/hold', { ...slot, callerId: '+15559998888' }, { ...authed, 'x-request-id': 'req-trace-7' }), env),
    );
    const log = JSON.parse(lines[0]);
    assert.equal(log.route, 'actor/hold');
    assert.equal(log.outcome, 'already_held_by_other');
    assert.equal(log.slot, '2026-10-05T09:00');
    assert.equal(log.request_id, 'req-trace-7');
    assert.equal(log.caller, '***8888');
    assert.ok(!lines[0].includes('5559998888'));
  });
});

describe('misc', () => {
  it('serves /health and 404s unknown routes', async () => {
    const { env } = makeEnv();
    assert.equal((await handleRequest(new Request('https://x.test/health'), env)).status, 200);
    assert.equal((await handleRequest(new Request('https://x.test/nope'), env)).status, 404);
  });
});
