// Create Telnyx AI Assistant tests via API from a local JSON definition file.
// These tests live in the Telnyx Portal and can be run manually or via API.
// They complement (not replace) the offline flow.test.mjs — they validate assistant
// _behavior_ rather than _structure_.
//
// Usage:
//   node scripts/create-telnyx-tests.mjs --dry-run       # preview what would be created
//   node scripts/create-telnyx-tests.mjs --apply         # create/update tests via API (needs TELNYX_API_KEY)
//
// Costs: each test RUN costs inference credits.  Creating the test definition is free.
import { readFileSync } from 'node:fs';

const API = 'https://api.telnyx.com/v2';
const KEY = process.env.TELNYX_API_KEY;
const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run') || !apply;

if (!KEY && apply) throw new Error('Set TELNYX_API_KEY to create tests');

const ids = JSON.parse(readFileSync(new URL('../assistants/ids.json', import.meta.url)));

// Test definitions: each becomes a test in the Telnyx Portal.
// Criteria are evaluated against the assistant's response after the test conversation.
// These map the conversation tests we removed from live.test.mjs.
const tests = [
  {
    name: 'Front Desk: Disclosure + Hours FAQ',
    description: 'Greeting contains the verbatim AI/recording disclosure; FAQ about hours returns Mon-Fri 9-5 without saying "not certain"',
    assistant_id: ids.frontDesk,
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'user', content: 'What time do you open and close?' },
    ],
    criteria: [
      { name: 'disclosure_present', type: 'response_contains', value: 'AI receptionist' },
      { name: 'hours_mon_fri', type: 'response_contains', value: '9' },
      { name: 'no_uncertainty', type: 'response_does_not_contain', value: 'not certain' },
    ],
  },
  {
    name: 'Front Desk: Route booking to Scheduling',
    description: 'When caller asks to book, the active assistant switches to Scheduling',
    assistant_id: ids.frontDesk,
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'user', content: 'I would like to book a cleaning please' },
    ],
    criteria: [
      { name: 'hands_to_scheduling', type: 'assistant_changed', value: ids.scheduling },
    ],
  },
  {
    name: 'Front Desk: Route insurance to Billing',
    description: 'When caller asks about insurance, the active assistant switches to Billing and does not call booking tools',
    assistant_id: ids.frontDesk,
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'user', content: 'Do you take Delta Dental insurance?' },
    ],
    criteria: [
      { name: 'hands_to_billing', type: 'assistant_changed', value: ids.billing },
      { name: 'no_booking_tools', type: 'tool_not_called', value: 'book_appointment' },
    ],
  },
  {
    name: 'Scheduling: Availability from tool, not hallucinated',
    description: 'When asked for open slots, the assistant calls check_availability and offers real slots',
    assistant_id: ids.scheduling,
    messages: [
      { role: 'user', content: 'I need a cleaning next Tuesday, what is open?' },
    ],
    criteria: [
      { name: 'calls_check_availability', type: 'tool_called', value: 'check_availability' },
      { name: 'mentions_slots', type: 'response_contains', value: ':' }, // time format hint
    ],
  },
];

async function apiCall(method, path, body) {
  const url = `${API}${path}`;
  if (dryRun) {
    console.log(`\n[DRY RUN] ${method} ${url}`);
    if (body) console.log(JSON.stringify(body, null, 2));
    return { data: { id: '<test-id>' } };
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

console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}\nTests to sync: ${tests.length}\n`);

for (const t of tests) {
  const body = {
    name: t.name,
    description: t.description,
    assistant_id: t.assistant_id,
    test_messages: t.messages,
    success_criteria: t.criteria,
  };

  try {
    const result = await apiCall('POST', '/ai/tests', body);
    console.log(`✓ ${t.name} ${dryRun ? '(would create)' : `-> ${result.data?.id ?? result.id}`}`);
  } catch (err) {
    console.error(`✗ ${t.name}: ${err.message}`);
  }
}

console.log(`\n${dryRun ? 'Run with --apply to create these in the Portal' : 'Done'}`);
