// Demo step 4 ("Race and fallback") needs a slot that's already taken before the live call asks
// for it - normally a second caller, but only one phone number is verified on this account (see
// docs/LEARNINGS.md, the D61 finding). This fakes the "someone else booked it first" side of the
// race with a free, no-inference direct MCP call, so the whole demo runs off one phone.
//
//   from repo root:  set -a; . .env; . .env.local; set +a
//   node scripts/book-test-slot.mjs <date YYYY-MM-DD> <start HH:MM> [service]
//
// Prints the appointmentId - cancel it after the demo with cancel_or_reschedule_appointment.
import { MCP_URL } from '../assistants/config.mjs';

const [date, start, service = 'cleaning'] = process.argv.slice(2);
if (!date || !start) {
  console.error('Usage: node scripts/book-test-slot.mjs <date YYYY-MM-DD> <start HH:MM> [service]');
  process.exit(1);
}

const MCP_SECRET = process.env.MCP_SHARED_SECRET;
if (!MCP_SECRET) {
  console.error('Set MCP_SHARED_SECRET first.');
  process.exit(1);
}

async function mcpRpc(method, params) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${MCP_SECRET}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  const data = text.split('\n').find((l) => l.startsWith('data:'));
  if (!data) throw new Error(`Unexpected response (HTTP ${res.status}): ${text}`);
  return JSON.parse(data.slice(5)).result;
}
const mcp = async (tool, args) => JSON.parse((await mcpRpc('tools/call', { name: tool, arguments: args })).content[0].text);

const result = await mcp('book_appointment', {
  service,
  date,
  start,
  patientName: 'Demo Decoy',
  patientPhone: '+15555550199',
});

if (!result.confirmed) {
  console.error('Pre-book failed - pick a different slot:', result);
  process.exit(1);
}
console.log(`Booked ${date} ${start} under the decoy patient. appointmentId: ${result.appointment.appointmentId}`);
console.log('Now call and ask for this exact slot - expect slot_already_booked + fresh-availability fallback.');
console.log(`Cancel afterward: mcp('cancel_or_reschedule_appointment', { appointmentId: '${result.appointment.appointmentId}', action: 'cancel' })`);
