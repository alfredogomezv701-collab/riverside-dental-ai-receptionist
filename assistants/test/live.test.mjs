// Live checks against the deployed system. Opt-in: needs TELNYX_API_KEY, MCP_SHARED_SECRET and
// WEBHOOK_TOKEN; costs a little inference credit and must leave no data behind (every booking a test
// creates is cancelled in `after`, and dates/phones are random so a crashed run can't poison the next).
//
//   from assistants/:  set -a; . ../.env; . ../.env.local; set +a; npm run test:live
//
// Conversation tests assert on *tool calls, routing and side effects*, not on exact wording, and
// retry once because the model is nondeterministic.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chatClient } from './chat_client.mjs';
import { billingAssistant, schedulingAssistant, frontDeskAssistant } from '../definitions.mjs';
import { WEBHOOK_BASE as WEBHOOK, MCP_URL as MCP, ACTOR_BASE as ACTOR, webhookUrl } from '../config.mjs';

const KEY = process.env.TELNYX_API_KEY;
const MCP_SECRET = process.env.MCP_SHARED_SECRET;
const TOKEN = process.env.WEBHOOK_TOKEN;
const ids = JSON.parse(readFileSync(new URL('../ids.json', import.meta.url)));
const skip = KEY ? false : 'TELNYX_API_KEY not set';
const skipMcp = KEY && MCP_SECRET ? false : 'MCP_SHARED_SECRET not set';
const skipToken = KEY && TOKEN ? false : 'WEBHOOK_TOKEN not set';
const skipAll = skipMcp || skipToken;

const api = KEY ? chatClient(KEY) : null;

async function retry(times, fn) {
  let last;
  for (let i = 0; i < times; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function mcpRpc(method, params) {
  const res = await fetch(MCP, {
    method: 'POST',
    headers: { authorization: `Bearer ${MCP_SECRET}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = (await res.text()).split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(data.slice(5)).result;
}
const mcp = async (tool, args) => JSON.parse((await mcpRpc('tools/call', { name: tool, arguments: args })).content[0].text);

// `token` defaults to the real one; pass null to send NO token (undefined would fall back to the default).
const dvRequest = (phone, token = TOKEN) =>
  fetch(`${WEBHOOK}/${token === null ? '' : `?token=${token}`}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { payload: { telnyx_end_user_target: phone } } }),
  });
const dynVars = async (phone) => (await (await dvRequest(phone)).json()).dynamic_variables;

/** A random future weekday, so runs never share a slot and a leaked booking can't break later runs. */
function randomWeekday() {
  for (;;) {
    const d = new Date(Date.UTC(2027, 2, 1 + Math.floor(Math.random() * 300)));
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) return d.toISOString().slice(0, 10);
  }
}
const randomPhone = () => `+1555${String(Math.floor(1000000 + Math.random() * 8999999))}`;

// Every appointment any test creates is cancelled here, pass or fail.
const cleanup = new Set();
after(async () => {
  if (!MCP_SECRET) return;
  for (const id of cleanup) await mcp('cancel_or_reschedule_appointment', { appointmentId: id, action: 'cancel' }).catch(() => {});
});

// ---------------------------------------------------------------------------------------
describe('deployed assistants match definitions.mjs', { skip: skip || skipToken }, () => {
  const stored = {};
  let hangupToolId;
  before(async () => {
    for (const k of ['frontDesk', 'scheduling', 'billing']) {
      const r = await api.json('GET', `/assistants/${ids[k]}`);
      stored[k] = r.data ?? r;
    }
    hangupToolId = stored.frontDesk.conversation_flow.nodes.find((n) => n.id === 'n_hangup').shared_tool_id;
  });

  const expected = () => {
    const c = { webhookUrl: webhookUrl(), hangupToolId, mcpServerId: ids.mcpServer, frontDeskId: ids.frontDesk, schedulingId: ids.scheduling, billingId: ids.billing };
    return { frontDesk: frontDeskAssistant(c), scheduling: schedulingAssistant(c), billing: billingAssistant(c) };
  };

  for (const k of ['frontDesk', 'scheduling', 'billing']) {
    it(`${k}: stored flow has the same nodes and edges as the definition`, () => {
      const want = expected()[k].conversation_flow;
      const got = stored[k].conversation_flow;
      assert.equal(got.start_node_id, want.start_node_id);
      const nodeSig = (n) => ({ id: n.id, type: n.type, text: n.message ?? n.instructions ?? n.shared_tool_id });
      assert.deepEqual(got.nodes.map(nodeSig), want.nodes.map(nodeSig));
      const edgeSig = (e) => ({
        id: e.id,
        from: e.start_node_id,
        to: e.target.node_id ?? e.target.assistant_id,
        cond: e.condition.type,
        expr: e.condition.expression && JSON.stringify(e.condition.expression),
      });
      assert.deepEqual(got.edges.map(edgeSig), want.edges.map(edgeSig));
    });

    // Without the token in the configured URL every dynamic-variables call would get a 401 and the
    // assistant would silently treat every caller as new. (Compared, never printed: it carries the token.)
    it(`${k}: is configured with the token-carrying webhook URL`, () => {
      assert.ok(stored[k].dynamic_variables_webhook_url === webhookUrl(), 'stored webhook URL differs from the expected tokenised URL - run update.mjs --apply');
    });
  }

  it('scheduling hands back to the real Front Desk, and billing can hand to the real Scheduling', () => {
    assert.equal(stored.scheduling.conversation_flow.edges.find((e) => e.id === 'e_collect_desk').target.assistant_id, ids.frontDesk);
    assert.equal(stored.billing.conversation_flow.edges.find((e) => e.id === 'e_billing_sched').target.assistant_id, ids.scheduling);
  });

  it('front desk hands off to the real Scheduling and Billing assistants', () => {
    const to = new Set(stored.frontDesk.conversation_flow.edges.filter((e) => e.target.type === 'assistant').map((e) => e.target.assistant_id));
    assert.deepEqual([...to].sort(), [ids.billing, ids.scheduling].sort());
  });

  it('only Scheduling carries the MCP server, with the three-tool allowlist', () => {
    assert.equal(stored.scheduling.mcp_servers[0].id, ids.mcpServer);
    assert.equal(stored.scheduling.mcp_servers[0].allowed_tools.length, 3);
    assert.deepEqual(stored.frontDesk.mcp_servers ?? [], []);
    assert.deepEqual(stored.billing.mcp_servers ?? [], []);
  });

  it('MCP server registration points at the deployed URL with the bearer secret ref', async () => {
    const s = await api.json('GET', `/mcp_servers/${ids.mcpServer}`);
    const srv = s.data ?? s;
    assert.equal(srv.url, MCP);
    assert.equal(srv.type, 'http');
    assert.equal(srv.api_key_ref, 'receptionist_mcp_token');
  });
});

// ---------------------------------------------------------------------------------------
describe('deployed edge functions', { skip }, () => {
  it('webhook refuses requests without the token, or with a wrong one, and reveals nothing', async () => {
    for (const token of [null, '', 'nope', `${TOKEN ?? 'x'}x`]) {
      const res = await dvRequest('+15551234567', token);
      assert.equal(res.status, 401, `token ${token === null ? '(none)' : JSON.stringify(token).slice(0, 6)}`);
      assert.doesNotMatch(await res.text(), /dynamic_variables|patient_name/);
    }
  });

  it('webhook answers a Telnyx-shaped assistant.initialization event with string variables', { skip: skipToken }, async () => {
    const v = await dynVars('+15550009999');
    assert.equal(v.is_returning_patient, 'false');
    for (const k of ['patient_name', 'next_appointment', 'next_appointment_id', 'appointment_count', 'waitlist_mode']) assert.equal(typeof v[k], 'string', k);
  });

  it('webhook never treats a non-dialable caller ID as a patient (no cross-caller leak via the bare key)', { skip: skipToken }, async () => {
    for (const phone of ['anonymous', 'unknown', '', '+1', '555-1234']) assert.equal((await dynVars(phone)).is_returning_patient, 'false', phone);
  });

  it('webhook latency has headroom under the 3000ms dynamic-variables timeout (median of 5 warm calls)', { skip: skipToken }, async () => {
    await dynVars('+15550003333'); // warm up
    const times = [];
    for (let i = 0; i < 5; i++) {
      const t = Date.now();
      await dynVars('+15550003333');
      times.push(Date.now() - t);
    }
    times.sort((a, b) => a - b);
    // Includes our network round trip to the edge, so this is an upper bound on handler time.
    assert.ok(times[2] < 2000, `median ${times[2]}ms (all: ${times.join(', ')})`);
  });

  it('webhook survives an empty body (no caller number) and stays fast', { skip: skipToken }, async () => {
    const t = Date.now();
    const res = await fetch(`${WEBHOOK}/?token=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200);
    assert.ok(Date.now() - t < 3000, 'must beat the 3000ms dynamic-variables timeout configured on the assistants');
  });

  it('actor proxy rejects unauthenticated requests', async () => {
    const res = await fetch(`${WEBHOOK}/actor/hold`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"date":"2027-01-04","start":"09:00","callerId":"x"}' });
    assert.equal(res.status, 401);
  });

  it('MCP endpoint rejects unauthenticated requests, on every method', async () => {
    assert.equal((await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(MCP, { method: 'GET' })).status, 401);
    assert.equal((await fetch(MCP, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{}' })).status, 401);
  });

  it('MCP lists exactly the three tools the Scheduling allowlist expects', { skip: skipMcp }, async () => {
    const tools = (await mcpRpc('tools/list', {})).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['book_appointment', 'cancel_or_reschedule_appointment', 'check_availability']);
  });

  it('health endpoints on all functions return ok, version and secret presence', async () => {
    for (const [name, url] of [['webhook', WEBHOOK], ['mcp', MCP.replace('/mcp', '')], ['actor', ACTOR]]) {
      const res = await fetch(`${url}/health`);
      assert.equal(res.status, 200, `${name} /health status`);
      const body = await res.json();
      assert.equal(body.status, 'ok', `${name} /health body.status`);
      assert.ok(typeof body.version === 'string' && body.version.length > 0, `${name} /health body.version`);
      assert.ok(typeof body.secrets === 'object' && body.secrets !== null, `${name} /health body.secrets`);
      // Verify no secret VALUES are leaked
      for (const [k, v] of Object.entries(body.secrets)) {
        assert.equal(typeof v, 'boolean', `${name} /health secrets.${k} must be boolean, never the value`);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------
// No LLM: the whole backend (MCP -> webhook -> actor -> KV, and back out through the dynamic-variables
// webhook) driven directly. Deterministic and cheap, so it carries the correctness claims; the chat tests
// below only prove the assistants wire into it.
describe('backend end to end, no LLM', { skip: skipAll, timeout: 180000 }, () => {
  const date = randomWeekday();
  const phone = randomPhone();
  const other = randomPhone();
  const booking = { service: 'cleaning', date, start: '10:00', patientName: 'Backend Tester', patientPhone: phone };
  const slotOf = async (start) => (await mcp('check_availability', { service: 'cleaning', date })).slots.find((s) => s.start === start);

  it('rejects slots that are not real, without writing anything', async () => {
    for (const [over, reason] of [
      [{ date: '2027-03-06' }, 'invalid_slot'], // a Saturday
      [{ date: '2027-99-99' }, 'invalid_slot'],
      [{ date: '2019-01-07' }, 'invalid_slot'], // the past
      [{ start: '03:00' }, 'invalid_slot'],
      [{ service: 'whitening' }, 'invalid_slot'],
    ]) {
      const res = await mcp('book_appointment', { ...booking, ...over });
      assert.deepEqual([res.confirmed, res.reason], [false, reason], JSON.stringify(over));
    }
    assert.equal((await slotOf('10:00')).available, true, 'a rejected booking must not consume the slot');
  });

  it('refuses a phone that is not a full number at the schema level', async () => {
    const res = await mpcSafe(() => mcpRpc('tools/call', { name: 'book_appointment', arguments: { ...booking, patientPhone: 'this number' } }));
    assert.ok(res.isError || /phone|digits|invalid/i.test(JSON.stringify(res)), JSON.stringify(res).slice(0, 200));
  });

  it('books, then availability, the webhook and a rival caller all see it', async () => {
    const first = await mcp('book_appointment', booking);
    assert.equal(first.confirmed, true, JSON.stringify(first));
    cleanup.add(first.appointment.appointmentId);

    assert.equal((await slotOf('10:00')).available, false, 'availability must reflect the booking');
    const v = await dynVars(phone);
    assert.equal(v.is_returning_patient, 'true');
    assert.equal(v.patient_name, 'Backend Tester');
    assert.equal(v.next_appointment, `cleaning on ${date} at 10:00`);
    assert.equal(v.next_appointment_id, first.appointment.appointmentId);
    assert.equal(v.appointment_count, '1');

    const rival = await mcp('book_appointment', { ...booking, patientName: 'Rival', patientPhone: other });
    assert.equal(rival.confirmed, false);
    assert.equal(rival.reason, 'slot_already_booked');
    assert.equal((await dynVars(other)).is_returning_patient, 'false', 'a rejected rival must not become a patient');
  });

  it('a retry of the same booking returns the existing appointment instead of "someone else took it"', async () => {
    const again = await mcp('book_appointment', booking);
    assert.equal(again.confirmed, true);
    assert.equal(again.alreadyBookedByYou, true);
  });

  it('a longer appointment hides the slots it overlaps for other services', async () => {
    const root = await mcp('book_appointment', { ...booking, service: 'root-canal', start: '13:30', patientName: 'Backend Tester', patientPhone: other });
    assert.equal(root.confirmed, true, JSON.stringify(root));
    cleanup.add(root.appointment.appointmentId);
    // 13:30 + 90 min = 15:00: everything starting inside that range is blocked, the slot that starts at 15:00 is not.
    for (const start of ['13:30', '14:00', '14:30']) assert.equal((await slotOf(start)).available, false, start);
    assert.equal((await slotOf('15:00')).available, true, 'a slot starting exactly when the appointment ends is fine');
    const clash = await mcp('book_appointment', { ...booking, start: '14:30', patientName: 'Clash', patientPhone: randomPhone() });
    assert.equal(clash.confirmed, false);
    assert.match(clash.detail ?? '', /overlap/i);
  });

  it('a second appointment for the same patient is remembered alongside the first', async () => {
    const second = await mcp('book_appointment', { ...booking, start: '11:00' });
    assert.equal(second.confirmed, true, JSON.stringify(second));
    cleanup.add(second.appointment.appointmentId);
    assert.equal((await dynVars(phone)).appointment_count, '2');
    // Cancelling the newer one must leave the older one (and the patient) intact.
    await mcp('cancel_or_reschedule_appointment', { appointmentId: second.appointment.appointmentId, action: 'cancel' });
    const v = await dynVars(phone);
    assert.equal(v.is_returning_patient, 'true');
    assert.equal(v.appointment_count, '1');
    assert.equal(v.next_appointment, `cleaning on ${date} at 10:00`);
  });

  it('cancelling frees the slot and, when it was the last appointment, the caller is new again', async () => {
    const v = await dynVars(phone);
    const cancelled = await mcp('cancel_or_reschedule_appointment', { appointmentId: v.next_appointment_id, action: 'cancel' });
    assert.equal(cancelled.success, true);
    assert.equal((await slotOf('10:00')).available, true);
    assert.equal((await dynVars(phone)).is_returning_patient, 'false');
    assert.equal((await mcp('cancel_or_reschedule_appointment', { appointmentId: v.next_appointment_id, action: 'cancel' })).reason, 'appointment_not_found');
  });
});

async function mpcSafe(fn) {
  try {
    return await fn();
  } catch (e) {
    return { isError: true, error: String(e) };
  }
}

// ---------------------------------------------------------------------------------------
// DELIBERATELY TRIMMED: conversation tests that validate routing/FAQ/tool-calls are now
// covered by Telnyx Portal AI Tests (see scripts/create-telnyx-tests.mjs) OR by the
// zero-cost offline suite in flow.test.mjs.  The only remaining LLM-based test is the
// end-to-end booking flow, which validates that the assistant can hold a multi-turn
// conversation and reach a real booking.
//
// Removed from here:
//   - "greets with verbatim disclosure, answers hours" → Portal test + flow.test node asserts
//   - "hands booking to Scheduling" → Portal test + flow.test edge assert
//   - "hands insurance to Billing" → Portal test + flow.test edge assert
//   - "does not invent availability" → backend end-to-end direct MCP call
//
// To recreate in Portal: scripts/create-telnyx-tests.mjs
// ---------------------------------------------------------------------------------------
describe('conversation end to end (real LLM, real tools)', { skip, timeout: 240000 }, () => {
  it('books through chat and every backend view agrees', { skip: skipAll }, async () => {
    const phone = randomPhone();
    const date = randomWeekday();
    let booked;
    await retry(2, async () => {
      const c = await api.start(ids.frontDesk, { name: 'autotest-book', phone });
      try {
        await c.say('Hi');
        await c.say(`I would like to book a cleaning on ${date} at 10:00 in the morning`);
        await c.say(`My name is Testy McTestface and my number is ${phone}. Please book 10:00.`);
        for (let i = 0; i < 4 && !(await c.toolResults('book_appointment')).some((r) => r.confirmed); i++) {
          await c.say('Yes, that is correct, please go ahead and book it.');
        }
        booked = (await c.toolResults('book_appointment')).find((r) => r.confirmed)?.appointment;
        assert.ok(booked, `no confirmed booking; transcript: ${JSON.stringify(c.transcript.map((t) => t.assistant.slice(0, 80)))}`);
        assert.equal(booked.date, date);
        assert.equal(booked.service, 'cleaning');
        assert.equal(c.activeAssistant, ids.scheduling);
      } finally {
        // Harvest EVERY confirmed booking before asserting on it, so a failed assertion or a retry can
        // never leak a real appointment into production KV (it did once).
        for (const r of await c.toolResults('book_appointment')) if (r.confirmed) cleanup.add(r.appointment.appointmentId);
        await c.end();
      }
    });

    // The booking must be visible to the *other* function: same KV, different code path.
    const v = await dynVars(phone);
    assert.equal(v.is_returning_patient, 'true', `webhook did not recognise ${phone}; booking was made under ${booked.patientPhone} / ${booked.patientName}`);
    assert.equal(v.patient_name, 'Testy McTestface');
    assert.match(v.next_appointment, new RegExp(`${date} at ${booked.start}`));
    assert.equal(v.next_appointment_id, booked.appointmentId);
    const slot = (await mcp('check_availability', { service: 'cleaning', date })).slots.find((s) => s.start === booked.start);
    assert.equal(slot.available, false);
  });
});
