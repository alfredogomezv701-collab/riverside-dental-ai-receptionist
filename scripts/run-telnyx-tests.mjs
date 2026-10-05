// Run the four assistant behavior tests ourselves, against the live assistants' own
// text-chat API, instead of relying on Telnyx's Portal Test Framework (Cekura, not in the
// public REST API) or the AI-Assistant-Tests rubric workflow (gated on an account default
// model we cannot set via API — see the 10027 notes in the commit history of the predecessor
// scripts/create-telnyx-tests.mjs).
//
// Why this exists alongside assistants/test/live.test.mjs (the trimmed live suite):
//   live.test.mjs has ONE LLM-based test ("books through chat and every backend view agrees")
//   whose purpose is cross-function side-effect integrity: the booking is visible to the
//   webhook, the MCP layer, and KV. It deliberately removed the four behavioral scenario
//   tests (greeting+hours, booking route, insurance route, hallucinated slots) — see the
//   "DELIBERATELY TRIMMED" comment at assistants/test/live.test.mjs:312 — because they were
//   meant to be covered by the Portal AI Tests (the predecessor script). With the Portal AI
//   Tests API-gated (10027) and the Test Framework not in the public API, those four
//   scenarios had NO coverage. This script restores it.
//
//   The ONE genuine overlap is test #2's handoff-to-Scheduling assertion, which live.test.mjs
//   checks incidentally as `c.activeAssistant === ids.scheduling` at live.test.mjs:345 inside
//   the E2E booking flow. Here it's the primary assertion for a routing-only test (no booking
//   is completed), checked for its own sake. Same boolean, different intent; the duplication
//   is benign and removing either side would lose a stated guarantee.
//
//   The distinct, demo-worthy angle this script adds that live.test.mjs has no analogue for:
//   it uses Telnyx's own /ai/chat/completions (model moonshotai/Kimi-K2.6, in-account, no
//   external API key) as an LLM grader of *assistant behavior quality* — does the phrasing
//   contain hedging, do offered slots trace to the tool's actual return values, etc. That is
//   a "we dogfood Telnyx inference as the grader of Telnyx inference" story the cross-function
//   integrity suite doesn't have.
//
// What this does:
//   - Drives each test's conversation through POST /ai/assistants/{id}/chat (a real run of the
//     assistant: workflow, LLM, MCP tools). After a handoff it reads metadata.assistant_id from
//     the conversation and sends subsequent turns to the *active* assistant — see the quirk note
//     in assistants/test/chat_client.mjs / docs/LEARNINGS.md.
//   - Asserts the hard criteria mechanically from ConversationMessage metadata and tool_calls
//     (disclosure substring, handoff to the right assistant_id, which tools were called).
//   - Uses Telnyx's own /ai/chat/completions (model moonshotai/Kimi-K2.6, in-account, no external
//     API key needed) as an LLM grader for the qualitative rubric items (hours content, no
//     hedging, slots traceable to the tool's output).
//   - Prints a per-criterion pass/fail report with the transcript attached on failure.
//
// Usage:
//   node scripts/run-telnyx-tests.mjs --dry-run       # print the test plan only (no API calls)
//   node scripts/run-telnyx-tests.mjs --apply         # run against the live assistants (costs inference)
//
// Costs: each --apply run uses one short chat conversation per test plus a few tiny grader
// completions. Real measured cost is about $0.08 per full run (4 tests + 3 grader calls), so
// $18 of credit funds ~225 runs. No phone minutes are consumed — conversations are web_chat,
// not phone_call. Conversations are NOT deleted at the end of the run (the cost of leaving
// them is negligible); they stay visible in the Portal's Conversation History tab and
// queryable via GET /ai/conversations/{id} until the account's retention_in_hours reaps them.
// Each run also fetches the /audit_events the run produced, as a demo artefact of the API
// calls made. (Reinstate `await conversation.end()` in runOne if you want zero residue instead.)
import { readFileSync } from 'node:fs';
import { chatClient } from '../assistants/test/chat_client.mjs';

const API = 'https://api.telnyx.com/v2';
const KEY = process.env.TELNYX_API_KEY;
const MCP_SECRET = process.env.MCP_SHARED_SECRET; // for booking-test cleanup
const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run') || !apply;
// Optional substring filter so a single test can be re-run (case-insensitive, matches name).
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length) : process.argv[process.argv.indexOf('--only') + 1];
const onlyRe = only ? new RegExp(only, 'i') : null;

if (!KEY && apply) throw new Error('Set TELNYX_API_KEY to run tests');
if (apply && !MCP_SECRET) throw new Error('Set MCP_SHARED_SECRET so the booking test can cancel any appointment it creates');

const ids = JSON.parse(readFileSync(new URL('../assistants/ids.json', import.meta.url)));
const GRADER_MODEL = 'moonshotai/Kimi-K2.6';

// Disclosure string the Front Desk Greeting speak node (n_greeting) delivers verbatim - see
// definitions.mjs (no line number: it moves every time the file is edited above it).
// Rubric judgment requires this phrase (or a word-for-word equivalent naming both AI nature
// AND recording) — a bare "this call may be recorded" fails.
const DISCLOSURE_NEEDLE = "I'm the clinic's AI receptionist, and this call may be recorded";

// --- helpers ---------------------------------------------------------------------------

/** A random future weekday so two runs never share a slot and a leaked booking can't break the next. */
function randomWeekday() {
  for (;;) {
    const d = new Date(Date.UTC(2027, 2, 1 + Math.floor(Math.random() * 300)));
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) return d.toISOString().slice(0, 10);
  }
}
const randomPhone = () => `+1555${String(Math.floor(1000000 + Math.random() * 8999999))}`;

/** Call Telnyx's OpenAI-compatible chat completions as an LLM grader. Returns the text answer. */
async function grade({ system, user }) {
  const res = await fetch(`${API}/ai/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: GRADER_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`grader -> ${res.status}: ${text.slice(0, 400)}`);
  const j = JSON.parse(text);
  return (j.choices?.[0]?.message?.content ?? '').trim();
}

/** Ask the grader for a strict PASS/FAIL verdict on a single rubric criterion against the transcript. */
async function judgeCriterion({ name, criteria, transcript, assistantText }) {
  const system =
    'You are a strict test grader for a dental clinic receptionist AI. You are given ONE rubric ' +
    "criterion and a conversation transcript. Decide whether the assistant's behavior satisfies the " +
    'criterion. Reply with exactly one line in the form: PASS or FAIL — then a single short sentence ' +
    '(max 20 words) quoting or paraphrasing the specific turn that decided it. Do not hedge; pick one.';
  const user =
    `CRITERION NAME: ${name}\nCRITERION: ${criteria}\n\n` +
    `ASSISTANT REPLY UNDER TEST:\n"""${assistantText}"""\n\n` +
    `FULL TRANSCRIPT (user/assistant pairs, oldest first):\n${transcript}\n\n` +
    'PASS or FAIL?';
  const out = await grade({ system, user });
  const pass = /^\s*pass\b/i.test(out);
  return { pass, raw: out };
}

/** Pretty-print a transcript as user/assistant pairs from the chat_client transcript array. */
const fmtTranscript = (t) => t.map((x, i) => `  ${i + 1}. user: ${x.user}\n     asst: ${x.assistant}`).join('\n');

// --- test definitions ------------------------------------------------------------------
// Each: { name, description, run(cx) -> drives the conversation, returns {transcript, asserts} }
// `asserts` is a list of {name, criteria, manual: bool|result, qualitative: bool} — the runner
// resolves manual ones inline (already-computed booleans) and sends qualitative ones to the grader.

function greetingText(t) {
  return (t[0]?.assistant ?? '').trim();
}

// Each test has: name, description, plan (the criteria, for dry-run printing), and run()
// which drives the conversation and returns {transcript, assistantText, asserts}. Each assert
// is either {name, criteria, manual: boolean} (mechanical, computed from the conversation) or
// {name, criteria, qualitative: true, assistantText, toolSlots?} (sent to the LLM grader).
const tests = [
  {
    name: 'Front Desk: Disclosure + Hours FAQ',
    description:
      "Greeting contains the verbatim AI/recording disclosure; an FAQ about hours returns Mon-Fri 9am-5pm without the assistant expressing uncertainty.",
    plan: [
      { name: 'disclosure_present', kind: 'assert', criteria: "Greeting contains the verbatim disclosure ('AI receptionist' AND 'call may be recorded'). 'This call may be recorded' alone fails." },
      { name: 'hours_mon_fri', kind: 'LLM judge', criteria: 'When asked the hours, the assistant states Mon-Fri, 9am-5pm, closed weekends — all four facts.' },
      { name: 'no_uncertainty', kind: 'LLM judge', criteria: "While answering the hours question, the assistant does not hedge ('I'm not certain', 'not sure', 'I think', etc.)." },
    ],
    async run(cx) {
      const c = await cx.start(ids.frontDesk, { name: 'autotest-disclosure', phone: cx.phone() });
      await c.say('Hi');
      const greeting = await c.say('What time do you open and close?');
      return {
        conversation: c,
        transcript: c.transcript,
        assistantText: greeting,
        asserts: [
          {
            name: 'disclosure_present',
            criteria: this.plan[0].criteria,
            manual: greetingText(c.transcript).includes(DISCLOSURE_NEEDLE),
          },
          {
            name: 'hours_mon_fri',
            criteria: this.plan[1].criteria,
            qualitative: true,
            assistantText: greeting,
          },
          {
            name: 'no_uncertainty',
            criteria: this.plan[2].criteria,
            qualitative: true,
            assistantText: greeting,
          },
        ],
      };
    },
  },
  {
    name: 'Front Desk: Route booking to Scheduling',
    description: "When a caller asks to book, the active assistant hands off to the Scheduling specialist.",
    plan: [
      { name: 'hands_to_scheduling', kind: 'assert', criteria: "After 'I want to book', the active assistant (conversation metadata.assistant_id) equals the Scheduling assistant_id. Fails if Front Desk keeps handling booking, or routes anywhere other than Scheduling." },
    ],
    async run(cx) {
      const c = await cx.start(ids.frontDesk, { name: 'autotest-route-sched', phone: cx.phone() });
      await c.say('Hi');
      await c.say('I would like to book a cleaning please');
      // If the handoff fired, the active assistant is now Scheduling and it will ask for a date.
      // One nudge to give the conversation a chance to hand off (the model is nondeterministic).
      if (c.activeAssistant === ids.frontDesk) {
        await c.say('next Tuesday morning if possible');
      }
      return {
        conversation: c,
        transcript: c.transcript,
        assistantText: c.transcript.at(-1)?.assistant ?? '',
        asserts: [
          {
            name: 'hands_to_scheduling',
            criteria: this.plan[0].criteria,
            manual: c.activeAssistant === ids.scheduling,
          },
        ],
      };
    },
  },
  {
    name: 'Front Desk: Route insurance to Billing',
    description:
      "When a caller asks about insurance, the active assistant hands off to the Billing specialist, and no booking tools are invoked.",
    plan: [
      { name: 'hands_to_billing', kind: 'assert', criteria: "After an insurance question, the active assistant equals the Billing assistant_id. Fails if Front Desk keeps answering itself or routes to Scheduling." },
      { name: 'no_booking_tools', kind: 'assert', criteria: "No booking-related tool is invoked anywhere in the conversation: not book_appointment, cancel_or_reschedule_appointment, or check_availability." },
    ],
    async run(cx) {
      const c = await cx.start(ids.frontDesk, { name: 'autotest-route-billing', phone: cx.phone() });
      await c.say('Hi');
      await c.say('Do you take Delta Dental insurance?');
      if (c.activeAssistant === ids.frontDesk) {
        await c.say('no, I just want to know about insurance for now');
      }
      const messages = await c.messages();
      const toolNames = messages.flatMap((m) => (m.tool_calls ?? []).map((x) => x.function?.name));
      return {
        conversation: c,
        transcript: c.transcript,
        assistantText: c.transcript.at(-1)?.assistant ?? '',
        asserts: [
          {
            name: 'hands_to_billing',
            criteria: this.plan[0].criteria,
            manual: c.activeAssistant === ids.billing,
          },
          {
            name: 'no_booking_tools',
            criteria: this.plan[1].criteria,
            manual: !toolNames.some((n) => ['book_appointment', 'cancel_or_reschedule_appointment', 'check_availability'].includes(n)),
          },
        ],
      };
    },
  },
  {
    name: 'Scheduling: Availability from tool, not hallucinated',
    description:
      "When asked for an open slot, the Scheduling specialist actually calls check_availability and offers real slots returned by it (not invented times).",
    plan: [
      { name: 'calls_check_availability', kind: 'assert', criteria: "The Scheduling specialist invokes the 'check_availability' tool during the conversation (visible in the tool-call record)." },
      { name: 'mentions_real_slots', kind: 'LLM judge', criteria: "The slots the assistant offers match real return values from check_availability — no invented times that don't trace to the tool response." },
    ],
    async run(cx) {
      // Start directly on Scheduling — this test is about Scheduling's tool-use, not the handoff
      // (which is covered by test #2). Starting on Scheduling avoids Front Desk's greeting node.
      const c = await cx.start(ids.scheduling, { name: 'autotest-slots', phone: cx.phone() });
      const date = randomWeekday();
      const first = await c.say(`I need a cleaning on ${date}, what is open?`);
      let last = first;
      for (let i = 0; i < 3 && /\b(what|which|service|you said|mean)\b/i.test(last) && !last.includes(':'); i++) {
        last = await c.say('Just a cleaning, please. What times do you have?');
      }
      const toolResults = await c.toolResults('check_availability');
      const checkCalled = toolResults.length > 0;
      const slotTimes = !checkCalled ? [] : toolResults.flatMap((r) => (r.slots ?? [])).map((s) => s.start);
      return {
        conversation: c,
        transcript: c.transcript,
        assistantText: last,
        asserts: [
          {
            name: 'calls_check_availability',
            criteria: this.plan[0].criteria,
            manual: checkCalled,
          },
          {
            name: 'mentions_real_slots',
            criteria: this.plan[1].criteria,
            qualitative: true,
            toolSlots: slotTimes,
            assistantText: last,
          },
        ],
      };
    },
  },
];

// --- runner ----------------------------------------------------------------------------

async function runOne(test, cx) {
  // test.run drives the conversation. We deliberately DO NOT call c.end() here — at ~$0.02/run
  // the cost is negligible, and keeping the conversation means it stays visible in the Portal's
  // Conversation History tab and queryable via GET /ai/conversations/{id} for forensics. The
  // tradeoff: a few short test conversations accumulate on the account until Telnyx's
  // retention_in_hours schedule reaps them. (If you want zero residue instead, reinstate the
  // `await conversation.end().catch(() => {})` line that was previously in this finally block.)
  const { conversation, transcript, assistantText, asserts } = await test.run(cx);
  const results = [];
  for (const a of asserts) {
    if (a.qualitative) {
      const transcriptText = fmtTranscript(transcript);
      const userText =
        'ASSISTANT REPLY UNDER TEST:\n"""' + a.assistantText + '"""\n\n' +
        (a.toolSlots ? `TOOL RETURNED SLOTS: ${JSON.stringify(a.toolSlots)}\n\n` : '') +
        `FULL TRANSCRIPT:\n${transcriptText}`;
      results.push({ name: a.name, ...(await judgeCriterion({ name: a.name, criteria: a.criteria, transcript: transcriptText, assistantText: userText })) });
    } else {
      results.push({ name: a.name, pass: !!a.manual, raw: 'mechanical assertion' });
    }
  }
  const allPass = results.every((r) => r.pass);
  return { name: test.name, pass: allPass, results, transcript, conversationId: conversation.id };
}

// --- main ------------------------------------------------------------------------------

console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
console.log(`Endpoint: POST ${API}/ai/assistants/{id}/chat`);
console.log(`Grader: ${API}/ai/chat/completions  (model ${GRADER_MODEL})`);
console.log(`Front Desk:  ${ids.frontDesk}`);
console.log(`Scheduling:  ${ids.scheduling}`);
console.log(`Billing:     ${ids.billing}`);
console.log(`Tests: ${tests.length}\n`);

const selected = onlyRe ? tests.filter((t) => onlyRe.test(t.name)) : tests;
if (onlyRe && !selected.length) {
  console.log(`No tests match --only "${only}". Available:\n${tests.map((t) => `  - ${t.name}`).join('\n')}`);
  process.exit(2);
}
if (onlyRe) {
  console.log(`Filter --only "${only}" -> ${selected.length} of ${tests.length} test(s) will run.\n`);
}

if (dryRun) {
  for (const t of selected) {
    console.log(`# ${t.name}`);
    console.log(`  ${t.description}`);
    console.log(`  criteria:`);
    for (const a of t.plan) {
      const c = a.criteria.length > 130 ? a.criteria.slice(0, 127) + '...' : a.criteria;
      console.log(`    - [${a.kind === 'LLM judge' ? 'LLM judge' : 'assert'}] ${a.name}: ${c}`);
    }
    console.log('');
  }
  console.log('Run with --apply to drive these against the live assistants (costs inference, no phone minutes).');
  process.exit(0);
}

if (!selected.length) throw new Error('No tests selected');

// Provide a small helper object so tests don't each repeat start() boilerplate.
const cx = {
  start: (assistantId, opts) => chatClient(KEY).start(assistantId, { ...opts, metadata: { test_run: 'run-telnyx-tests' } }),
  phone: randomPhone,
};

let passed = 0;
let failed = 0;
const failedTranscripts = [];
const conversationIds = [];
const runStartedAt = new Date(Date.now() - 60 * 1000); // small back-dated window so the audit fetch catches the run
for (const t of selected) {
  process.stdout.write(`- ${t.name} ... `);
  try {
    const r = await runOne(t, cx);
    if (r.conversationId) conversationIds.push({ test: t.name, id: r.conversationId, pass: r.pass });
    if (r.pass) {
      passed++;
      console.log('PASS');
      for (const cr of r.results) if (!cr.pass) console.log(`    ! ${cr.name}: ${cr.raw}`);
    } else {
      failed++;
      console.log('FAIL');
      for (const cr of r.results) console.log(`    ${cr.pass ? '✓' : '✗'} ${cr.name}: ${cr.raw}`);
      failedTranscripts.push({ name: t.name, transcript: r.transcript });
    }
  } catch (e) {
    failed++;
    console.log('ERROR');
    console.log(`    ${e.message}`);
  }
}

console.log(`\n${passed}/${selected.length} tests passed` + (failed ? `, ${failed} failed` : ''));

// Conversations are kept (not end()'d) so they remain visible in the Portal's Conversation
// History tab and queryable via GET /ai/conversations/{id}. List their IDs for forensics.
if (conversationIds.length) {
  console.log('\n=== conversations created (kept live in the Portal) ===');
  for (const { test, id, pass } of conversationIds) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${test}\n         ${id}`);
  }
}

if (failedTranscripts.length) {
  console.log('\n=== failing transcripts ===');
  for (const { name, transcript } of failedTranscripts) {
    console.log(`\n--- ${name} ---`);
    console.log(fmtTranscript(transcript));
  }
}

// Audit trail: fetch the API calls this run made from the account-level audit log. Useful as a
// demo artefact ("here's the audit trail of the test run") and for cost forensics.
//
// Note: audit_events are keyed per resource (resource_type + change_type + resource_id), not per
// HTTP call. We see Conversation create/delete events here (one per chat the script opened),
// but per-turn /ai/assistants/{id}/chat POSTs are NOT individually audited — the conversation is.
// Similarly the grader's /ai/chat/completions calls don't show as audit events (they're
// inference calls, not resource mutations). So this is a partial audit trail: it proves which
// conversations the test created and when, which is enough to demonstrate the run happened.
console.log('\n=== audit events from this run (from GET /audit_events) ===');
try {
  const sinceIso = runStartedAt.toISOString();
  const params = new URLSearchParams({ 'page[size]': '50', 'filter[created_at][gte]': sinceIso });
  const r = await fetch(`${API}/audit_events?${params}`, { headers: { authorization: `Bearer ${KEY}` } });
  const j = await r.json();
  const events = (j.data ?? []).filter((e) => {
    if (e.resource_type === 'Conversation' && conversationIds.some((c) => c.id === e.resource_id)) return true;
    return false;
  });
  if (!events.length) {
    console.log(`  (no matched events since ${sinceIso}; total in window: ${(j.data ?? []).length})`);
  } else {
    for (const e of events) {
      const which = conversationIds.find((c) => c.id === e.resource_id);
      console.log(`  ${e.created_at}  ${String(e.change_type).padEnd(8)} ${e.resource_type}  ${(which?.test ?? '').padEnd(50)}  ${e.resource_id}`);
    }
    console.log(`  (${events.length} matched event(s) of ${(j.data ?? []).length} total in window)`);
  }
} catch (e) {
  console.log(`  audit fetch failed: ${e.message}`);
}
