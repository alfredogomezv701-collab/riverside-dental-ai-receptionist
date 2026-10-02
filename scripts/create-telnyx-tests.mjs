// Create Telnyx AI Assistant tests via API from local definitions.
// These tests live in the Telnyx Portal and can be run manually or via API.
// They complement (not replace) the offline flow.test.mjs — they validate assistant
// _behavior_ rather than _structure_.
//
// Usage:
//   node scripts/create-telnyx-tests.mjs --dry-run       # preview what would be created
//   node scripts/create-telnyx-tests.mjs --apply         # create tests via API (needs TELNYX_API_KEY)
//
// Costs: creating a test definition is FREE. Each test RUN (POST .../runs) consumes
// inference credits — roughly the same as one short assistant conversation. Running a test
// is a separate, deliberate step the user takes from the Portal ("Run") or via the API;
// this script only creates definitions.
//
// Schema: CreateAssistantTestRequest @ POST /v2/ai/assistants/tests (Telnyx OpenAPI,
// spec3.json). Required: name, destination, instructions, rubric. Each rubric item is
// {name, criteria} (additionalProperties: false) — a qualitative LLM-judged criterion,
// NOT keyword matching. `instructions` is a persona/scenario for an AI agent to roleplay
// as the caller, NOT a fixed list of messages. There is no `assistant_id` field: the test
// targets whatever assistant is bound to `destination`.
//
// Channel choice: we use `phone_call` with E.164 destination `+12185069277` (the clinic's
// Front Desk line, per README.md; the assistants have `enabled_features: ['telephony']` so
// a phone channel is the natural fit for disclosure / hand-off / tool-calling behaviors).
// AMBIGUITY: the Telnyx conversation-keying docs list `web_call` as "Assistant test runs
// executed from the portal test simulator", which suggests the Portal test runner may
// simulate the conversation over `web_call` regardless of the channel set on the test
// definition. It is unclear from the public spec/docs whether a test definition with
// `phone_call` triggers a real outbound call on run, or whether the simulator always
// wraps the conversation. Until confirmed against a live run, treat the channel as "what
// the definition claims" and review the first run's `telnyx_conversation_channel` in the
// run response before scheduling many runs.
const API = 'https://api.telnyx.com/v2';
const KEY = process.env.TELNYX_API_KEY;
const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run') || !apply;

if (!KEY && apply) throw new Error('Set TELNYX_API_KEY to create tests');

// Clinic's phone number in E.164 (the Front Desk line — Front Desk owns the number and
// routes to Scheduling / Billing via the handoff tool, so all four tests target it).
// README.md shows `+1 (218) 506-9277`; normalized to `+12185069277` to match the OpenAPI
// example format (`+15551234567`).
const CLINIC_NUMBER = '+12185069277';
const TEST_SUITE = 'riverside-dental-receptionist';

// Test definitions — each becomes a test in the Telnyx Portal.
//
// `instructions` is a persona/scenario for an AI caller to roleplay (NOT a fixed script),
// and `rubric` is a set of qualitative LLM-judged criteria (NOT keyword/substring matching).
// These map the conversation tests we removed from live.test.mjs onto the real Telnyx
// Tests schema. Each rubric criterion is phrased as observable behavior so the LLM grader
// can judge the transcript without ambiguity; the original criterion names are kept as the
// rubric item `name`s where the old script had them, so grader output stays greppable.
const tests = [
  {
    name: 'Front Desk: Disclosure + Hours FAQ',
    description:
      "Greeting contains the verbatim AI/recording disclosure; an FAQ about hours returns Mon-Fri 9am-5pm without the assistant expressing uncertainty ('not certain', 'not sure').",
    instructions:
      "Act as a first-time dental patient calling Riverside Dental. Be polite and brief, like a real caller on a phone line. " +
      "1) Say only 'Hi' and wait for the assistant's greeting. " +
      "2) After the greeting, ask 'What time do you open and close?' and listen to the answer. " +
      "Do not introduce yourself by name or mention any other topic. Stay in character as an ordinary caller; do not test, audit, or prompt the assistant for anything beyond the hours question.",
    rubric: [
      {
        name: 'disclosure_present',
        criteria:
          "The assistant's opening greeting (first assistant turn) contains the verbatim disclosure that it is an AI / receptionist and that the call may be recorded. " +
          "The disclosure phrase 'I'm the clinic's AI receptionist, and this call may be recorded' (or a word-for-word equivalent that names both the AI nature and the recording) must appear — a vague 'this call may be recorded' alone is a fail.",
      },
      {
        name: 'hours_mon_fri',
        criteria:
          "When asked the opening/closing hours, the assistant states Monday through Friday, 9am to 5pm (closed weekends). All four facts — days (Mon-Fri), open at 9, close at 5, and weekends closed — must be present in the answer.",
      },
      {
        name: 'no_uncertainty',
        criteria:
          "While answering the hours question, the assistant does not express uncertainty about the hours — phrases like 'I'm not certain', 'not sure', 'I think', 'I believe', or 'let me check' about the hours all fail this criterion. A confident, direct answer with no hedging passes.",
      },
    ],
  },
  {
    name: 'Front Desk: Route booking to Scheduling',
    description:
      "When a caller asks to book an appointment, the active assistant hands off to the Scheduling specialist (the voice/identity or context changes as the Scheduling specialist takes over).",
    instructions:
      "Act as a first-time caller who wants to book a dental cleaning. Be polite and brief, like a real caller on a phone line. " +
      "1) Say 'Hi' and wait for the greeting. " +
      "2) Then say 'I would like to book a cleaning please' and wait. " +
      "3) If the assistant asks for a date or more details, give a specific one ('next Tuesday morning if possible') and continue briefly until the conversation reaches a booking step or confirms a specialist has taken over. " +
      "Do not raise any billing, insurance, or other topics. Stay in character as an ordinary caller.",
    rubric: [
      {
        name: 'hands_to_scheduling',
        criteria:
          "After the caller asks to book, the conversation moves to the Scheduling specialist. Indicators the hand-off occurred: a change of assistant identity/voice or an explicit introduction of the scheduling specialist, and the subsequent turns being about collecting booking details (service, date, time). The test passes if a scheduling-specialist conversation clearly takes over; it fails if Front Desk keeps handling booking itself or routes anywhere other than Scheduling.",
      },
    ],
  },
  {
    name: 'Front Desk: Route insurance to Billing',
    description:
      "When a caller asks about insurance, the active assistant hands off to the Billing specialist, and no booking tools (book_appointment / cancel_or_reschedule_appointment) are invoked during the conversation.",
    instructions:
      "Act as a first-time caller who wants to know what dental insurance the clinic takes. Be polite and brief, like a real caller on a phone line. " +
      "1) Say 'Hi' and wait for the greeting. " +
      "2) Then ask 'Do you take Delta Dental insurance?' and wait for the answer. " +
      "3) If a specialist asks follow-up questions, answer them briefly (e.g. 'no, I just want to know about insurance for now'). " +
      "Do not ask to book, change, or cancel an appointment at any point. Stay in character as an ordinary caller.",
    rubric: [
      {
        name: 'hands_to_billing',
        criteria:
          "After the caller asks about insurance, the conversation moves to the Billing specialist. Indicators the hand-off occurred: a change of assistant identity/voice or an explicit introduction of the billing specialist, and the subsequent turns being about billing/insurance. If Front Desk keeps answering the insurance question itself, or routes to Scheduling instead, this criterion fails.",
      },
      {
        name: 'no_booking_tools',
        criteria:
          "Throughout the entire conversation, no booking tool is invoked — neither 'book_appointment' nor 'cancel_or_reschedule_appointment' should appear in the tool-call record of the transcript. (The 'check_availability' tool is also a booking-related tool and should not be called.) Any booking-related tool call from either Front Desk or Billing fails this criterion.",
      },
    ],
  },
  {
    name: 'Scheduling: Availability from tool, not hallucinated',
    description:
      "When asked for an open slot, the Scheduling specialist actually calls the check_availability tool and offers real slots returned by it (not invented times).",
    instructions:
      "Act as a first-time caller who wants a cleaning next Tuesday. Be polite and brief, like a real caller on a phone line. " +
      "1) Say 'I need a cleaning next Tuesday, what is open?' and wait. " +
      "2) Listen to the offered slots. If the assistant offers a specific time, respond 'Yes, that works' or 'No, is there anything earlier?' naturally — do not invent times yourself. " +
      "3) If the assistant asks clarifying questions about the service or date, answer briefly. " +
      "Do not mention billing, insurance, or cancellation. Do not ask the assistant to skip tool calls or to just 'make up' a time. Stay in character as an ordinary caller.",
    rubric: [
      {
        name: 'calls_check_availability',
        criteria:
          "The Scheduling specialist invokes the 'check_availability' tool during the conversation. The tool call must be visible in the transcript's tool-call record, with arguments that include the requested service and a YYYY-MM-DD date (or a date inferred from 'next Tuesday'). If no check_availability tool call appears, or if a different tool is called instead, this criterion fails.",
      },
      {
        name: 'mentions_real_slots',
        criteria:
          "The slots the assistant offers to the caller match real return values from the check_availability tool call (i.e. the offered times correspond to slots in the tool's response), and the assistant does not invent specific times that did not come from the tool. An assistant that says 'we have 10am, 11:30, and 2pm' without a tool response backing those exact times fails; one that offers times traceable to the tool's output passes.",
      },
    ],
  },
];

function makeBody(t) {
  const body = {
    name: t.name,
    description: t.description,
    telnyx_conversation_channel: 'phone_call',
    destination: CLINIC_NUMBER,
    test_suite: TEST_SUITE,
    max_duration_seconds: 180,
    instructions: t.instructions,
    rubric: t.rubric,
  };
  return body;
}

async function apiCall(method, path, body) {
  const url = `${API}${path}`;
  if (dryRun) {
    console.log(`\n[DRY RUN] ${method} ${url}`);
    if (body) console.log(JSON.stringify(body, null, 2));
    return { data: { test_id: '<test-id>' } };
  }
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
console.log(`Endpoint: POST ${API}/ai/assistants/tests`);
console.log(`Channel: phone_call  Destination: ${CLINIC_NUMBER}  Test suite: ${TEST_SUITE}`);
console.log(`Tests to sync: ${tests.length}\n`);

let ok = 0;
let fail = 0;
for (const t of tests) {
  const body = makeBody(t);
  try {
    const result = await apiCall('POST', '/ai/assistants/tests', body);
    const id = result?.data?.test_id ?? result?.test_id ?? result?.data?.id;
    console.log(`\n✓ ${t.name} ${dryRun ? '(would create)' : `-> ${id}`}`);
    ok++;
  } catch (err) {
    console.error(`\n✗ ${t.name}: ${err.message}`);
    fail++;
  }
}

console.log(`\n${ok}/${tests.length} tests ${dryRun ? 'would be created' : 'created'}` + (fail ? `, ${fail} failed` : ''));
console.log(dryRun ? 'Run with --apply to create these in the Portal.' : 'Done.');
console.log('Note: creating tests is free; running them (Portal "Run" or POST .../runs) costs inference.');
