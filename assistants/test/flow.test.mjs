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
const mcpToolNames = ['check_availability', 'book_appointment', 'cancel_or_reschedule_appointment', 'join_waitlist'];

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

  it('attaches exactly the four real MCP tools (booking, availability, cancel/reschedule, waitlist)', () => {
    assert.deepEqual(s.mcp_servers[0].allowed_tools.slice().sort(), mcpToolNames.slice().sort());
  });

  it('allowlist matches the tool names the MCP server source actually registers', () => {
    const registered = mcpToolNames.map((n) => {
      const src = readFileSync(new URL(`../../receptionist-mcp/src/tools/${n}.ts`, import.meta.url), 'utf8');
      return src.match(/TOOL_NAME\s*=\s*'([a-z_]+)'/)[1];
    });
    assert.deepEqual(registered.sort(), s.mcp_servers[0].allowed_tools.slice().sort());
  });

  it('routes waitlist_mode == "true" (KV flag) to the waitlist JOIN node (collects name/phone, persists, THEN speaks), on the new-booking path only', () => {
    const e = s.conversation_flow.edges.find((x) => x.id === 'e_offer_waitlist');
    assert.equal(e.start_node_id, 'n_offer');
    assert.equal(e.condition.expression.left.name, 'waitlist_mode');
    assert.equal(e.condition.expression.right.value, 'true');
    // The flag path no longer jumps straight to the speak node — it routes through n_waitlist_join,
    // which collects name+phone and calls join_waitlist before reaching the message. Without this,
    // the n_waitlist speak node (which says the request was noted) fires before any persistence
    // has happened, since the flag path skips n_confirm/n_book entirely. See docs/LEARNINGS.md
    // "Say what you store".
    assert.equal(e.target.node_id, 'n_waitlist_join');
  });

  it('n_waitlist_join is a prompt node that instructs the model to call join_waitlist before reaching the waitlist message', () => {
    const j = s.conversation_flow.nodes.find((n) => n.id === 'n_waitlist_join');
    assert.ok(j, 'n_waitlist_join node missing');
    assert.equal(j.type, 'prompt');
    assert.match(j.instructions, /join_waitlist/, 'n_waitlist_join must instruct the model to call join_waitlist');
  });

  it('every inbound path to the n_waitlist speak node is honest about persistence (the message claims the request was "noted")', () => {
    // Two paths can reach n_waitlist: (a) the attempt_count >= 3 edge from n_book, where n_book's
    // instructions call join_waitlist first; (b) the queued:true edge from n_waitlist_join (the
    // flag path). Both require join_waitlist to have returned queued:true before the message is
    // spoken. Asserting the contract:
    //   1. n_book instructions reference join_waitlist AND should_waitlist:true;
    //   2. n_waitlist_join instructions reference join_waitlist AND queued:true;
    //   3. n_waitlist_join has an outbound edge to n_waitlist gated on join_waitlist succeeding,
    //      and a separate honest-failure edge for the queued:false case.
    const msg = (id) => s.conversation_flow.nodes.find((n) => n.id === id).message;
    assert.match(msg('n_waitlist'), /noted/i, 'the waitlist message claims the request was noted');
    const book = s.conversation_flow.nodes.find((n) => n.id === 'n_book').instructions;
    assert.match(book, /join_waitlist/, 'attempt_count path: n_book instructions must tell the model to call join_waitlist before reaching the waitlist message');
    assert.match(book, /should_waitlist.*true/, 'n_book instructions must reference the should_waitlist:true signal');
    const join = s.conversation_flow.nodes.find((n) => n.id === 'n_waitlist_join').instructions;
    assert.match(join, /join_waitlist/, 'flag path: n_waitlist_join instructions must tell the model to call join_waitlist');
    assert.match(join, /queued.*true/, 'n_waitlist_join instructions must gate the waitlist message on join_waitlist returning queued:true');

    const out = s.conversation_flow.edges.filter((e) => e.start_node_id === 'n_waitlist_join');
    assert.ok(out.some((e) => e.id === 'e_waitlist_join_done' && e.target.node_id === 'n_waitlist'), 'queued:true path -> n_waitlist');
    assert.ok(out.some((e) => e.id === 'e_waitlist_join_fail' && e.target.node_id === 'n_escalate'), 'queued:false path -> n_escalate (not the truth-only message)');
    // Reachability check: every inbound path to n_waitlist must come from a node that calls
    // join_waitlist first (n_book or n_waitlist_join). No path from n_offer, n_collect, n_confirm,
    // etc. should jump directly to n_waitlist — those would skip persistence.
    const inbound = s.conversation_flow.edges.filter((e) => e.target.node_id === 'n_waitlist');
    assert.deepEqual(inbound.map((e) => e.start_node_id).sort(), ['n_book', 'n_waitlist_join'], 'only the two persistence-first paths reach the waitlist speak node');
  });

  // The second variable-comparison edge required by docs/REQUIREMENTS.md: `attempt_count >= 3 -> waitlist`.
  it('has an attempt_count >= 3 -> waitlist variable-comparison edge on n_book (mirrors durationOver)', () => {
    const e = s.conversation_flow.edges.find((x) => x.id === 'e_book_waitlist');
    assert.ok(e, 'e_book_waitlist edge missing');
    assert.equal(e.start_node_id, 'n_book');
    assert.equal(e.target.node_id, 'n_waitlist');
    assert.equal(e.condition.type, 'expression');
    assert.equal(e.condition.expression.type, 'comparison');
    assert.equal(e.condition.expression.op, '>=');
    assert.equal(e.condition.expression.left.type, 'variable');
    assert.equal(e.condition.expression.left.name, 'attempt_count');
    assert.equal(e.condition.expression.right.type, 'number_literal');
    assert.equal(e.condition.expression.right.value, 3);
  });

  it('declares e_book_waitlist after the duration edge but before the LLM edges on n_book (variable-comparison precedence: duration escalation > attempt threshold > LLM)', () => {
    const out = s.conversation_flow.edges.filter((e) => e.start_node_id === 'n_book');
    const idxWaitlist = out.findIndex((e) => e.id === 'e_book_waitlist');
    const idxSlow = out.findIndex((e) => e.condition.type === 'expression' && e.condition.expression.left.name === 'telnyx_conversation_duration_secs');
    const firstLlm = out.findIndex((e) => e.condition.type === 'llm');
    assert.ok(idxSlow >= 0 && idxWaitlist > idxSlow, 'duration escalation must be checked before attempt threshold (a 5-min call escalates regardless of attempts)');
    assert.ok(firstLlm >= 0 && idxWaitlist < firstLlm, 'attempt threshold (variable comparison) must be checked before any LLM edge on voice');
    // No other variable-comparison edge on n_book — the only two deterministic edges are duration and attempts.
    const varEdges = out.filter((e) => e.condition.type === 'expression');
    assert.equal(varEdges.length, 2, 'exactly two variable-comparison edges on n_book (duration + attempt_count)');
    assert.deepEqual(varEdges.map((e) => e.id).sort(), ['e_book_slow', 'e_book_waitlist']);
  });

  it('declares attempt_count default of "0" so the edge has a defined left-hand side at conversation start', () => {
    assert.equal(s.dynamic_variables.attempt_count, '0');
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

  it('does not say "see you" after a cancellation; the waitlist message claims recording ONLY because join_waitlist is called first', () => {
    const msg = (id) => s.conversation_flow.nodes.find((n) => n.id === id).message;
    assert.match(msg('n_closing'), /see you/i);
    assert.doesNotMatch(msg('n_closing_manage'), /see you/i);
    // The waitlist message now says the request was "noted" — this is only truthful because every
    // inbound path to n_waitlist requires book_appointment to have returned should_waitlist:true
    // (3 failed attempts) AND the n_book instructions direct the model to call join_waitlist first,
    // which persists waitlist/{date}/{phone10} to KV. Asserting that contract:
    //   1. the message is allowed to claim not only "noted" but also that the team will follow up;
    //   2. the n_book instructions MUST mention join_waitlist (so the persistence actually happens
    //      before the speak node runs — see docs/LEARNINGS.md "Say what you store").
    assert.match(msg('n_waitlist'), /noted/i);
    assert.match(msg('n_waitlist'), /team will be in touch/i);
    const book = s.conversation_flow.nodes.find((n) => n.id === 'n_book').instructions;
    assert.match(book, /join_waitlist/, 'n_book instructions must tell the model to call join_waitlist before reaching the waitlist message');
    assert.match(book, /should_waitlist.*true/, 'n_book instructions must reference the should_waitlist:true signal from book_appointment');
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

  it('the webhook returns exactly the variables the assistants declare defaults for, except attempt_count (set mid-call by the update_dynamic_variables tool)', () => {
    // The assistant defaults and the webhook return shape are kept in sync for the conversation-start
    // variables. attempt_count is the deliberate exception: it starts at "0" (declared here as a
    // default so the variable-comparison edge has a defined left-hand side) and is then updated
    // mid-call by the update_dynamic_variables shared tool — the webhook never returns it.
    assert.deepEqual(
      Object.keys(all.frontDesk.dynamic_variables).sort(),
      ['appointment_count', 'attempt_count', 'is_returning_patient', 'next_appointment', 'next_appointment_id', 'patient_name', 'waitlist_mode'],
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

describe('edge-case fallback edges (deterministic so callers never get stuck)', () => {
  const fd = flows.frontDesk.conversation_flow;
  const sched = flows.scheduling.conversation_flow;
  const bill = flows.billing.conversation_flow;
  const out = (fl, id) => fl.edges.filter((e) => e.start_node_id === id);
  const hasLlmFallback = (fl, from) => out(fl, from).some((e) => e.condition.type === 'llm');
  const llmFallbackTarget = (fl, from) => out(fl, from).find((e) => e.condition.type === 'llm' && e.condition.prompt.includes('does not match any other'))?.target;

  it('Front Desk intent nodes have an LLM fallback to n_clarify for ambiguous input', () => {
    for (const n of ['n_intent', 'n_intent_returning']) {
      assert.ok(hasLlmFallback(fd, n), `${n} missing LLM fallback edge`);
      const t = llmFallbackTarget(fd, n);
      assert.equal(t.node_id, 'n_clarify', `${n} LLM fallback should route to clarify node`);
    }
  });

  it('Front Desk FAQ node has an LLM fallback to n_clarify for off-script follow-ups', () => {
    assert.ok(hasLlmFallback(fd, 'n_faq'), 'n_faq missing LLM fallback edge');
    const t = llmFallbackTarget(fd, 'n_faq');
    assert.equal(t.node_id, 'n_clarify', 'n_faq LLM fallback should route to clarify node');
  });

  it('Scheduling n_book has an LLM fallback to n_offer for unexpected tool errors', () => {
    assert.ok(hasLlmFallback(sched, 'n_book'), 'n_book missing LLM fallback edge');
    const t = llmFallbackTarget(sched, 'n_book');
    assert.equal(t.node_id, 'n_offer', 'n_book LLM fallback should return to fresh availability');
  });

  it('Scheduling n_manage has an LLM fallback to n_collect for changed topic or unexpected errors', () => {
    assert.ok(hasLlmFallback(sched, 'n_manage'), 'n_manage missing LLM fallback edge');
    const t = llmFallbackTarget(sched, 'n_manage');
    assert.equal(t.node_id, 'n_collect', 'n_manage LLM fallback should restart intent collection');
  });

  it('Billing n_billing has an LLM hand-off to Front Desk for general questions', () => {
    assert.ok(hasLlmFallback(bill, 'n_billing'), 'n_billing missing LLM fallback edge');
    const t = llmFallbackTarget(bill, 'n_billing');
    assert.equal(t.type, 'assistant', 'n_billing LLM fallback should hand off to another assistant');
    assert.equal(t.assistant_id, ids.frontDeskId, 'n_billing LLM fallback should go to Front Desk');
    assert.equal(t.voice_mode, 'unified', 'hand-off should use unified voice mode');
  });

  it('every prompt-only node in all assistants now has at least one fallback way forward', () => {
    // Default edges are only valid on speak/tool nodes; prompt nodes must use
    // LLM fallback edges instead. Each prompt node should have either an LLM
    // fallback edge OR an expression edge (e.g. duration) so callers never stall.
    for (const [name, a] of Object.entries(flows)) {
      const fl = a.conversation_flow;
      for (const n of fl.nodes.filter((x) => x.type === 'prompt')) {
        const edges = out(fl, n.id);
        const hasFallback = edges.some((e) => (e.condition.type === 'llm' && e.condition.prompt?.includes('does not match any other')) || e.condition.type === 'expression');
        assert.ok(hasFallback, `${name}/${n.id} has no fallback edge`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AI-driven routing verification (REQUIRES LLM API KEY — DO NOT RUN)
// ---------------------------------------------------------------------------
// These tests send caller utterances to a real LLM alongside each edge's
// classification prompt, asserting the model routes to the expected edge.
//
// To run manually when credits are available:
//   LLM_API_KEY=$KEY LLM_BASE_URL=https://api.openai.com/v1 LLM_MODEL=gpt-4o-mini \n//     node --test test/flow.test.mjs
//
// Or point at Telnyx's hosted model endpoint:
//   LLM_API_KEY=$TELNYX_KEY LLM_BASE_URL=https://api.telnyx.com/v2/ai \n//     LLM_MODEL=moonshotai/Kimi-K2.6 node --test test/flow.test.mjs
//
// Estimated cost per run: ~$0.05–0.15 (small classification prompts).
describe.skip('AI routing verification against edge conditions', () => {
  const API_KEY = process.env.LLM_API_KEY;
  const BASE_URL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

  // Hard-bail so these never execute even if someone un-skips the suite.
  if (!API_KEY) {
    it('SKIPPED — Set LLM_API_KEY to enable AI routing tests', () => { assert.ok(true); });
    return;
  }

  async function classify(callerUtterance, edgePrompt) {
    const system = `You are a call-routing classifier. Given a caller's utterance and a routing condition, reply with ONLY "YES" if the condition matches, or "NO" if it does not. Be strict — if the utterance is ambiguous or does not clearly satisfy the condition, reply "NO".\n\nCondition: ${edgePrompt}`;
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Caller said: "${callerUtterance}"` },
        ],
        temperature: 0,
        max_tokens: 10,
      }),
    });
    if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices[0].message.content.trim().toUpperCase();
  }

  // Collect every LLM-conditioned edge across all assistants.
  const llmEdges = [];
  for (const [name, a] of Object.entries(flows)) {
    const fl = a.conversation_flow;
    for (const e of fl.edges) {
      if (e.condition.type === 'llm') {
        llmEdges.push({
          assistant: name,
          edgeId: e.id,
          from: e.start_node_id,
          to: e.target.node_id ?? e.target.assistant_id,
          prompt: e.condition.prompt,
        });
      }
    }
  }

  it('has edges to test', () => {
    assert.ok(llmEdges.length > 0, 'no LLM edges found in flows');
  });

  const cases = [
    // Front Desk intent routing
    { utterance: 'I want to book a cleaning', expectYes: ['e_n_intent_sched', 'e_n_intent_returning_sched'] },
    { utterance: 'I have a billing question', expectYes: ['e_n_intent_bill', 'e_n_intent_returning_bill'] },
    { utterance: 'What are your hours?', expectYes: ['e_n_intent_faq', 'e_n_intent_returning_faq'] },
    { utterance: 'I need a human', expectYes: ['e_n_intent_human', 'e_n_intent_returning_human'] },
    { utterance: 'I am not sure what I need', expectYes: [] }, // ambiguous — none should match

    // Front Desk FAQ routing
    { utterance: 'Actually I want to schedule', expectYes: ['e_faq_sched'] },
    { utterance: 'Never mind, thanks', expectYes: ['e_faq_done'] },
    { utterance: 'Tell me about your services', expectYes: [] }, // off-script, should hit default (none of the LLM edges)

    // Scheduling collect routing
    { utterance: 'I need a new appointment', expectYes: ['e_collect_offer'] },
    { utterance: 'I want to cancel', expectYes: ['e_collect_manage'] },
    { utterance: 'Do you take insurance?', expectYes: ['e_collect_desk'] },

    // Scheduling confirm routing
    { utterance: 'Yes book it', expectYes: ['e_confirm_book'] },
    { utterance: 'No, change the date', expectYes: ['e_confirm_back'] },
    { utterance: 'Maybe?', expectYes: [] }, // ambiguous — default edge should catch

    // Scheduling book routing (non-error paths)
    { utterance: 'confirmed', expectYes: ['e_book_done'] },
    { utterance: 'slot already booked', expectYes: ['e_book_retry'] },

    // Scheduling manage routing
    { utterance: 'done', expectYes: ['e_manage_done'] },
    { utterance: 'try another time', expectYes: ['e_manage_retry'] },
    { utterance: 'I changed my mind', expectYes: ['e_manage_back'] },
    { utterance: 'that appointment is not mine', expectYes: ['e_manage_notfound'] },

    // Billing routing
    { utterance: 'I want to book', expectYes: ['e_billing_sched'] },
    { utterance: 'thanks bye', expectYes: ['e_billing_done'] },
    { utterance: 'What are your hours?', expectYes: [] }, // should default to Front Desk (no LLM edge matches)
  ];

  for (const { utterance, expectYes } of cases) {
    it(`classifies "${utterance}"`, async () => {
      const results = [];
      for (const edge of llmEdges) {
        const answer = await classify(utterance, edge.prompt);
        if (answer === 'YES') results.push(edge.edgeId);
      }
      // Every edge in expectYes MUST classify YES; all others should classify NO.
      for (const id of expectYes) {
        assert.ok(results.includes(id), `expected ${id} to match for "${utterance}" but got: ${results.join(', ')}`);
      }
      for (const id of results) {
        assert.ok(expectYes.includes(id), `unexpected match ${id} for "${utterance}"`);
      }
    });
  }

  // Smoke test for each new fallback LLM catch-all edge.
  const fallbackEdges = [
    { assistant: 'frontDesk', node: 'n_intent', edge: 'e_n_intent_unclear' },
    { assistant: 'frontDesk', node: 'n_intent_returning', edge: 'e_n_intent_returning_unclear' },
    { assistant: 'frontDesk', node: 'n_faq', edge: 'e_faq_unclear' },
    { assistant: 'scheduling', node: 'n_book', edge: 'e_book_unclear' },
    { assistant: 'scheduling', node: 'n_manage', edge: 'e_manage_unclear' },
    { assistant: 'billing', node: 'n_billing', edge: 'e_billing_faq' },
  ];

  for (const { assistant, node, edge } of fallbackEdges) {
    it(`fallback edge ${edge} exists on ${assistant}.${node}`, () => {
      const fl = flows[assistant].conversation_flow;
      const e = fl.edges.find((x) => x.id === edge);
      assert.ok(e, `${edge} not found`);
      assert.equal(e.condition.type, 'llm');
      assert.equal(e.start_node_id, node);
    });
  }
});
