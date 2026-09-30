import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runBookAppointment } from '../src/tools/book_appointment_handler.js';
import { runCancelOrReschedule } from '../src/tools/cancel_or_reschedule_appointment_handler.js';
import { BOOKING_KEY, APPOINTMENT_KEY } from '../src/tools/book_appointment.js';
import { createHttpDaySlotNamespace } from '../src/actors/day_slot_http_client.js';
import { MockKvNamespace } from './mock_kv.js';
import { TODAY, MON, TUE, WED, PHONE, PHONE_B, bookInput, openSlot, commonOpenSlot } from './fixtures.js';

// Real code, not a hand-rolled fake: the actual DaySlotActor class this project's DaySlotNamespace
// contract is hand-written to match, AND the actual createHttpDaySlotNamespace client production code
// uses. See src/actors/day_slot_http_client.ts for why this is HTTP at all: receptionist-mcp is a
// classic (func.toml) project and can't hold the DAY_SLOT actor binding directly, so it reaches
// receptionist-webhook (which holds the real binding) over HTTP. This test stands up a tiny local HTTP
// server that plays receptionist-webhook's part - real DaySlotActor behind real /actor/* routes - so
// what's exercised is handler -> HTTP client -> HTTP server -> actor, not an in-process method call.
import { DaySlotActor } from '../../day-slot-actor/src/day_slot_actor.js';
import { createMockActorContext } from '../../day-slot-actor/test/mock_actor_context.js';

const PROXY_SECRET = 'test-shared-secret';

interface Proxy {
  url: string;
  close: () => Promise<void>;
  requestIds: string[];
  failNext: (path: string) => void;
}

function startActorProxyServer(): Promise<Proxy> {
  const instances = new Map<string, { actor: DaySlotActor; tail: Promise<unknown> }>();
  const entryFor = (date: string) => {
    let e = instances.get(date);
    if (!e) {
      e = { actor: new DaySlotActor(createMockActorContext(date), {} as Env), tail: Promise.resolve() };
      instances.set(date, e);
    }
    return e;
  };
  const requestIds: string[] = [];
  const failures = new Set<string>();

  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${PROXY_SECRET}`) {
      res.writeHead(401).end();
      return;
    }
    if (typeof req.headers['x-request-id'] === 'string') requestIds.push(req.headers['x-request-id']);
    if (req.url && failures.delete(req.url)) {
      res.writeHead(500).end('injected actor failure');
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const { date, start, callerId, holdDurationMs } = JSON.parse(body || '{}');
        const e = entryFor(date);
        // The platform runs one call at a time per actor; a bare in-process instance doesn't, so
        // queue per date to reproduce that guarantee (what's under test is our handlers, not the scheduler).
        const run = e.tail.then(async () => {
          if (req.url === '/actor/hold') return e.actor.holdSlot(start, callerId, holdDurationMs);
          if (req.url === '/actor/confirm') return e.actor.confirmSlot(start, callerId);
          if (req.url === '/actor/release') return e.actor.releaseSlot(start, callerId);
          return undefined;
        });
        e.tail = run.catch(() => undefined);
        const result = await run;
        if (result === undefined) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500).end(String(err));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        requestIds,
        failNext: (path) => failures.add(path),
      });
    });
  });
}

let proxy: Proxy;
before(async () => {
  proxy = await startActorProxyServer();
});
after(async () => {
  await proxy.close();
});

const daySlotClient = (requestId?: string) => createHttpDaySlotNamespace(proxy.url, PROXY_SECRET, requestId);
const ctxWith = (kv: MockKvNamespace, daySlot = daySlotClient()) => ({ kv, daySlot, today: TODAY });

describe('book_appointment + DaySlotActor over HTTP - real handler, real client, real actor', () => {
  it('confirms a booking via a real HTTP round trip to the actor', async () => {
    const kv = new MockKvNamespace();
    const daySlot = daySlotClient();
    const input = bookInput({ date: MON, start: openSlot('cleaning', MON) });

    const result = await runBookAppointment(input, ctxWith(kv, daySlot));

    assert.equal(result.confirmed, true);
    const actorView = await daySlot.idFromName(MON).holdSlot(input.start, PHONE);
    assert.equal(actorView.success, false);
    assert.equal(actorView.reason, 'already_booked');
  });

  it('rejects an unauthenticated proxy call (wrong secret)', async () => {
    const badClient = createHttpDaySlotNamespace(proxy.url, 'wrong-secret');
    await assert.rejects(() => badClient.idFromName(MON).holdSlot('09:00', PHONE));
  });

  it('the actor rejects a second caller for the same start, reached through the handler + HTTP client', async () => {
    const kv = new MockKvNamespace();
    const start = commonOpenSlot('cleaning', 'exam', TUE);

    const first = await runBookAppointment(bookInput({ date: TUE, start }), ctxWith(kv));
    assert.equal(first.confirmed, true);
    const second = await runBookAppointment(
      bookInput({ service: 'exam', date: TUE, start, patientName: 'Other Patient', patientPhone: PHONE_B }),
      ctxWith(kv),
    );

    assert.equal(second.confirmed, false);
    assert.equal(second.reason, 'slot_already_booked');
    assert.ok(await kv.get(BOOKING_KEY(TUE, start), { type: 'json' }));
  });

  it('two concurrent booking attempts over HTTP for the same slot - only one wins', async () => {
    const kv = new MockKvNamespace();
    const start = openSlot('cleaning', WED, 1);
    const attempt = (patientPhone: string) =>
      runBookAppointment(bookInput({ date: WED, start, patientName: 'X', patientPhone }), ctxWith(kv));

    const [a, b] = await Promise.all([attempt('+15551111111'), attempt('+15552222222')]);

    assert.equal([a, b].filter((r) => r.confirmed).length, 1);
    assert.equal((await kv.list({ prefix: `booking/${WED}/` })).keys.length, 1);
  });

  it('forwards the request id so the webhook log line can be correlated with the MCP tool-call log', async () => {
    proxy.requestIds.length = 0;
    const kv = new MockKvNamespace();
    await runBookAppointment(bookInput({ date: MON, start: openSlot('cleaning', MON, 2) }), ctxWith(kv, daySlotClient('req-trace-1')));
    // hold + confirm both carried it
    assert.deepEqual(proxy.requestIds, ['req-trace-1', 'req-trace-1']);
  });

  it('gives the slot back when the KV writes fail after the actor confirmed it (no booked-with-no-owner slot)', async () => {
    const kv = new MockKvNamespace();
    const daySlot = daySlotClient();
    const start = openSlot('cleaning', MON, 3);
    kv.failPutsMatching = /^appointment\//;

    await assert.rejects(() => runBookAppointment(bookInput({ date: MON, start }), ctxWith(kv, daySlot)), /injected KV put failure/);

    kv.failPutsMatching = undefined;
    const retry = await runBookAppointment(bookInput({ date: MON, start, patientPhone: PHONE_B, patientName: 'Retry' }), ctxWith(kv, daySlot));
    assert.equal(retry.confirmed, true, 'slot must be bookable again after the failed attempt');
    assert.equal((await kv.list({ prefix: `booking/${MON}/` })).keys.length, 1);
  });

  it('surfaces an actor outage as an error rather than a fake booking, leaving KV untouched', async () => {
    const kv = new MockKvNamespace();
    proxy.failNext('/actor/hold');

    await assert.rejects(() => runBookAppointment(bookInput({ date: TUE, start: openSlot('cleaning', TUE, 4) }), ctxWith(kv)));

    assert.equal(kv.puts.length, 0);
  });
});

describe('cancel_or_reschedule_appointment + DaySlotActor over HTTP', () => {
  async function bookOne(kv: MockKvNamespace, date: string, n = 0) {
    const booked = await runBookAppointment(bookInput({ date, start: openSlot('cleaning', date, n) }), ctxWith(kv));
    if (!booked.confirmed || !booked.appointment) throw new Error('setup booking failed');
    return booked.appointment;
  }

  it('cancel releases the actor slot over HTTP - a new caller can then book it', async () => {
    const kv = new MockKvNamespace();
    const appointment = await bookOne(kv, MON, 5);

    const cancelled = await runCancelOrReschedule({ appointmentId: appointment.appointmentId, action: 'cancel' }, ctxWith(kv));
    assert.equal(cancelled.success, true);

    const rebooked = await runBookAppointment(
      bookInput({ date: MON, start: appointment.start, patientName: 'New Patient', patientPhone: '+15553334444' }),
      ctxWith(kv),
    );
    assert.equal(rebooked.confirmed, true);
  });

  it('cancel retried after a failed KV delete still succeeds (releasing twice is harmless)', async () => {
    const kv = new MockKvNamespace();
    const appointment = await bookOne(kv, TUE, 6);
    const realDelete = kv.delete.bind(kv);
    let failures = 1;
    kv.delete = async (key: string) => {
      if (failures-- > 0) throw new Error('injected KV delete failure');
      return realDelete(key);
    };

    await assert.rejects(() => runCancelOrReschedule({ appointmentId: appointment.appointmentId, action: 'cancel' }, ctxWith(kv)));
    const retry = await runCancelOrReschedule({ appointmentId: appointment.appointmentId, action: 'cancel' }, ctxWith(kv));

    assert.equal(retry.success, true);
    assert.equal(await kv.get(APPOINTMENT_KEY(appointment.appointmentId)), null);
  });

  it('reschedule moves the actor hold over HTTP: old slot free, new slot booked', async () => {
    const kv = new MockKvNamespace();
    const daySlot = daySlotClient();
    const appointment = await bookOne(kv, MON, 7);
    const newStart = openSlot('cleaning', WED, 8);

    const result = await runCancelOrReschedule(
      { appointmentId: appointment.appointmentId, action: 'reschedule', newDate: WED, newStart },
      ctxWith(kv, daySlot),
    );
    assert.equal(result.success, true);

    assert.equal((await daySlot.idFromName(MON).holdSlot(appointment.start, PHONE_B)).success, true);
    const taken = await daySlot.idFromName(WED).holdSlot(newStart, PHONE_B);
    assert.equal(taken.success, false);
    assert.equal(taken.reason, 'already_booked');
  });

  it('reschedule fails without losing the original booking when the new slot is taken', async () => {
    const kv = new MockKvNamespace();
    const daySlot = daySlotClient();
    const appointment = await bookOne(kv, TUE, 9);
    const target = openSlot('cleaning', MON, 9);
    await runBookAppointment(bookInput({ date: MON, start: target, patientName: 'Someone Else', patientPhone: PHONE_B }), ctxWith(kv, daySlot));

    const result = await runCancelOrReschedule(
      { appointmentId: appointment.appointmentId, action: 'reschedule', newDate: MON, newStart: target },
      ctxWith(kv, daySlot),
    );

    assert.equal(result.success, false);
    assert.equal(result.reason, 'new_slot_already_booked');
    assert.ok(await kv.get(APPOINTMENT_KEY(appointment.appointmentId), { type: 'json' }));
    const original = await daySlot.idFromName(TUE).holdSlot(appointment.start, PHONE_B);
    assert.equal(original.reason, 'already_booked');
  });

  it('a reschedule whose KV writes fail releases the NEW slot and leaves the original booking intact', async () => {
    const kv = new MockKvNamespace();
    const daySlot = daySlotClient();
    const appointment = await bookOne(kv, WED, 10);
    const newStart = openSlot('cleaning', MON, 10);
    kv.failPutsMatching = new RegExp(`^booking/${MON}/`);

    await assert.rejects(() =>
      runCancelOrReschedule({ appointmentId: appointment.appointmentId, action: 'reschedule', newDate: MON, newStart }, ctxWith(kv, daySlot)),
    );

    kv.failPutsMatching = undefined;
    assert.equal((await daySlot.idFromName(MON).holdSlot(newStart, PHONE_B)).success, true, 'new slot must not stay locked');
    assert.equal((await daySlot.idFromName(WED).holdSlot(appointment.start, PHONE_B)).reason, 'already_booked', 'original untouched');
    const stored = await kv.get<{ date: string }>(APPOINTMENT_KEY(appointment.appointmentId), { type: 'json' });
    assert.equal(stored?.date, WED);
  });
});
