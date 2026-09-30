// Offline checks on the assistant definitions: no network, no credit. `npm test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  billingAssistant,
  schedulingAssistant,
  frontDeskAssistant,
  ESCALATION_SECS,
  CLINIC_TZ,
  CLINIC_FACTS,
} from '../definitions.mjs';

const ids = {
  webhookUrl: 'https://w.test',
  mcpServerId: 'mcp-1',
  hangupToolId: 'tool-h',
  frontDeskId: 'a-fd',
  schedulingId: 'a-sched',
  billingId: 'a-bill',
};
const flows = {
  scheduling: schedulingAssistant(ids),
  frontDesk: frontDeskAssistant(ids),
  billing: billingAssistant(ids),
};
const mcpToolNames = ['check_availability', 'book_appointment', 'cancel_or_reschedule_appointment'];

for (const [name, a] of Object.entries(flows)) {
  const fl = a.conversation_flow;
  const nodeIds = fl.nodes.map((n) => n.id);
  const out = (id) => fl.edges.filter((e) => e.start_node_id === id);

  describe(`${name} flow graph`, () => {
    it('has unique node and edge ids and a real start node', () => {
      assert.equal(new Set(nodeIds).size, nodeIds.length);
      assert.equal(new Set(fl.edges.map((e) => e.id)).size, fl.edges.length);
      assert.ok(nodeIds.includes(fl.start_node_id));
    });

    it('has no dangling edges', () => {
      for (const e of fl.edges) {
        assert.ok(nodeIds.includes(e.start_node_id), `edge ${e.id} starts at unknown node`);
        if (e.target.type === 'node') assert.ok(nodeIds.includes(e.target.node_id), `edge ${e.id} targets unknown node`);
      }
    });

    it('reaches every node from the start node', () => {
      const seen = new Set([fl.start_node_id]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const e of fl.edges) {
          if (seen.has(e.start_node_id) && e.target.type === 'node' && !seen.has(e.target.node_id)) {
            seen.add(e.target.node_id);
            grew = true;
          }
        }
      }
      assert.deepEqual(nodeIds.filter((n) => !seen.has(n)), []);
    });

    it('gives every speak node exactly one default edge, and hangup nodes none', () => {
      for (const n of fl.nodes) {
        if (n.type === 'speak') assert.equal(out(n.id).filter((e) => e.condition.type === 'default').length, 1, n.id);
        if (n.type === 'tool') assert.equal(out(n.id).length, 0, `${n.id} must be terminal`);
      }
    });

    it('never dead-ends a prompt node', () => {
      for (const n of fl.nodes.filter((x) => x.type === 'prompt')) assert.ok(out(n.id).length > 0, n.id);
    });

    it('meets the challenge rubric: prompt + speak nodes, LLM + variable-comparison edges', () => {
      const types = new Set(fl.nodes.map((n) => n.type));
      assert.ok(types.has('prompt') && types.has('speak'));
      const conds = new Set(fl.edges.map((e) => e.condition.type));
      assert.ok(conds.has('llm') && conds.has('expression'));
    });

    it(`escalates deterministically after ${ESCALATION_SECS}s from every conversational node`, () => {
      const looping = fl.nodes.filter((n) => n.type === 'prompt'); // no exemptions: n_book and n_manage escalate too
      for (const n of looping) {
        const slow = out(n.id).find(
          (e) => e.condition.type === 'expression' && e.condition.expression.left.name === 'telnyx_conversation_duration_secs',
        );
        assert.ok(slow, `${n.id} has no duration escalation edge`);
        assert.equal(slow.condition.expression.op, '>=');
        assert.equal(slow.condition.expression.right.value, ESCALATION_SECS);
        assert.equal(slow.condition.expression.right.type, 'number_literal');
      }
    });
  });
}

describe('front desk', () => {
  const fd = flows.frontDesk;

  it('opens with a verbatim speak node that carries the AI/recording disclosure', () => {
    const start = fd.conversation_flow.nodes.find((n) => n.id === fd.conversation_flow.start_node_id);
    assert.equal(start.type, 'speak');
    assert.match(start.message, /AI receptionist/i);
    assert.match(start.message, /recorded/i);
    assert.doesNotMatch(start.message, /\{\{/, 'disclosure must not depend on variables that may fail to resolve');
  });

  it('splits returning vs new callers on the webhook variable, with a default fallback', () => {
    const edges = fd.conversation_flow.edges.filter((e) => e.start_node_id === 'n_greeting');
    const ret = edges.find((e) => e.condition.type === 'expression');
    assert.equal(ret.condition.expression.left.name, 'is_returning_patient');
    assert.equal(ret.condition.expression.right.value, 'true'); // dynamic variables are strings
    assert.ok(edges.some((e) => e.condition.type === 'default'));
  });

  it('routes to both specialists by assistant id, with distinct voices', () => {
    const targets = fd.conversation_flow.edges.filter((e) => e.target.type === 'assistant');
    assert.deepEqual([...new Set(targets.map((e) => e.target.assistant_id))].sort(), ['a-bill', 'a-sched']);
    assert.ok(targets.every((e) => e.target.voice_mode === 'distinct'));
  });

  it('keeps clinic facts at assistant level so the node a transition leaves can still answer', () => {
    assert.ok(fd.instructions.includes(CLINIC_FACTS));
  });

  it('has no MCP tools of its own', () => {
    assert.equal(fd.mcp_servers, undefined);
  });
});

describe('scheduling assistant', () => {
  const s = flows.scheduling;

  it('attaches exactly the three real MCP tools', () => {
    assert.deepEqual(s.mcp_servers[0].allowed_tools.slice().sort(), mcpToolNames.slice().sort());
  });

  it('allowlist matches the tool names the MCP server source actually registers', () => {
    const registered = mcpToolNames.map((n) => {
      const src = readFileSync(new URL(`../../receptionist-mcp/src/tools/${n}.ts`, import.meta.url), 'utf8');
      return src.match(/TOOL_NAME\s*=\s*'([a-z_]+)'/)[1];
    });
    assert.deepEqual(registered.sort(), s.mcp_servers[0].allowed_tools.slice().sort());
  });

  it('routes waitlist_mode == "true" (KV flag) to the waitlist node, on the new-booking path only', () => {
    const e = s.conversation_flow.edges.find((x) => x.id === 'e_offer_waitlist');
    assert.equal(e.start_node_id, 'n_offer');
    assert.equal(e.condition.expression.left.name, 'waitlist_mode');
    assert.equal(e.condition.expression.right.value, 'true');
    assert.equal(e.target.node_id, 'n_waitlist');
  });

  // n_collect is where cancel/reschedule intent is gathered too: a waitlist edge there told people
  // calling to cancel "we're fully booked" and hung up on them.
  it('never sends a cancel/reschedule caller to the waitlist', () => {
    const edges = s.conversation_flow.edges;
    for (const n of ['n_collect', 'n_manage', 'n_closing_manage']) {
      assert.ok(!edges.some((e) => e.start_node_id === n && e.target.node_id === 'n_waitlist'), n + ' must not reach the waitlist directly');
    }
    const manage = edges.find((e) => e.id === 'e_collect_manage');
    assert.equal(manage.target.node_id, 'n_manage');
    assert.equal(edges.find((e) => e.id === 'e_manage_done').target.node_id, 'n_closing_manage');
  });

  it('does not say "see you" after a cancellation, and does not claim to have recorded a waitlist request', () => {
    const msg = (id) => s.conversation_flow.nodes.find((n) => n.id === id).message;
    assert.match(msg('n_closing'), /see you/i);
    assert.doesNotMatch(msg('n_closing_manage'), /see you/i);
    assert.doesNotMatch(msg('n_waitlist'), /noted|recorded|added you|call you as soon/i);
  });

  it('lets callers out of every dead end: failed reschedule, unknown appointment, changed mind at the offer', () => {
    const from = (n) => s.conversation_flow.edges.filter((e) => e.start_node_id === n).map((e) => e.target.node_id ?? e.target.assistant_id);
    assert.ok(from('n_manage').includes('n_offer') && from('n_manage').includes('n_collect'));
    assert.ok(from('n_offer').includes('n_collect'));
  });

  it('tells the model the caller-ID number, so "use this number" works, and to insist on a full number', () => {
    const confirm = s.conversation_flow.nodes.find((n) => n.id === 'n_confirm').instructions;
    assert.match(confirm, /\{\{telnyx_end_user_target\}\}/);
    assert.match(confirm, /area code/);
  });

  it('handles several appointments honestly: the assistant is told only the soonest is on file', () => {
    const manage = s.conversation_flow.nodes.find((n) => n.id === 'n_manage').instructions;
    assert.match(manage, /\{\{appointment_count\}\}/);
    assert.match(manage, /only the soonest/i);
  });

  it('recovers from a lost slot race by looping back to fresh availability', () => {
    const e = s.conversation_flow.edges.find((x) => x.start_node_id === 'n_book' && x.target.node_id === 'n_offer');
    assert.match(e.condition.prompt, /slot_already_booked/);
  });

  it('cannot reach Book without passing Confirm', () => {
    const edges = s.conversation_flow.edges;
    assert.ok(edges.some((e) => e.start_node_id === 'n_confirm' && e.target.node_id === 'n_book'));
    const intoBook = edges.filter((e) => e.target.node_id === 'n_book');
    assert.deepEqual(intoBook.map((e) => e.start_node_id), ['n_confirm']);
  });

  it('pins the clinic timezone and tells the model how to handle other zones', () => {
    assert.equal(CLINIC_TZ, 'America/Chicago');
    assert.match(s.instructions, new RegExp(`telnyx_current_time_${CLINIC_TZ}`));
    assert.match(s.instructions, /Central/);
    assert.match(s.instructions, /ask which timezone/i);
  });
});

describe('all assistants', () => {
  const all = { ...flows, billing: billingAssistant(ids) };

  it('use the deployed dynamic-variables webhook with fail-safe defaults and a timeout inside the 10s cap', () => {
    for (const [n, a] of Object.entries(all)) {
      assert.ok(a.dynamic_variables_webhook_url.startsWith('https://'), n);
      assert.ok(a.dynamic_variables_webhook_timeout_ms <= 10000, n);
      assert.equal(a.dynamic_variables.is_returning_patient, 'false', n); // unknown caller if webhook times out
      assert.equal(a.dynamic_variables.waitlist_mode, 'false', n);
    }
  });

  // The Portal's "Call me" form is pre-filled from these defaults and renders "" as null, which the
  // outbound-call API rejects ("Value for key 'next_appointment' must be a boolean, string, or integer").
  it('never declares an empty default variable (the Portal would send null and the call API would refuse it)', () => {
    for (const [n, a] of Object.entries(all)) {
      for (const [k, v] of Object.entries(a.dynamic_variables)) {
        assert.ok(typeof v === 'string' && v.trim() !== '', `${n}: default for ${k} is empty`);
      }
    }
  });

  it('use distinct voices per persona', () => {
    const voices = Object.values(all).map((a) => a.voice_settings.voice);
    assert.equal(new Set(voices).size, voices.length);
  });

  it('every {{variable}} in a prompt or spoken message is one the webhook supplies (or a Telnyx system variable)', () => {
    const known = new Set(Object.keys(all.frontDesk.dynamic_variables));
    const isSystem = (v) => /^telnyx_/.test(v) || v === 'call_control_id';
    for (const [name, a] of Object.entries(all)) {
      const texts = [a.instructions, ...(a.conversation_flow?.nodes ?? []).flatMap((n) => [n.instructions, n.message])].filter(Boolean);
      for (const t of texts) for (const m of t.matchAll(/\{\{([^}]+)\}\}/g)) assert.ok(known.has(m[1]) || isSystem(m[1]), `${name}: unknown variable {{${m[1]}}}`);
    }
  });

  it('every variable an edge compares is defined, so a typo cannot silently never fire', () => {
    const known = new Set([...Object.keys(all.frontDesk.dynamic_variables), 'telnyx_conversation_duration_secs']);
    for (const [name, a] of Object.entries(all)) {
      for (const e of a.conversation_flow?.edges ?? []) {
        if (e.condition.type === 'expression') assert.ok(known.has(e.condition.expression.left.name), `${name}/${e.id}: ${e.condition.expression.left.name}`);
      }
    }
  });

  it('the webhook returns exactly the variables the assistants declare defaults for', () => {
    assert.deepEqual(
      Object.keys(all.frontDesk.dynamic_variables).sort(),
      ['appointment_count', 'is_returning_patient', 'next_appointment', 'next_appointment_id', 'patient_name', 'waitlist_mode'],
    );
  });

  it('billing hands a caller who also wants an appointment to Scheduling, and is prompt-only when created without ids', () => {
    const toSched = all.billing.conversation_flow.edges.find((e) => e.target.type === 'assistant');
    assert.equal(toSched.target.assistant_id, 'a-sched');
    assert.equal(billingAssistant({ webhookUrl: 'https://w.test' }).conversation_flow, undefined);
  });

  it('billing has no tools and says it cannot look up accounts', () => {
    assert.equal(all.billing.mcp_servers, undefined);
    assert.match(all.billing.instructions, /cannot look up accounts/i);
  });
});
