// Demo step 4 ("Race and fallback") needs a slot that's already taken before the live call asks
// for it - normally a second caller, but only one phone number is verified on this account (see
// docs/LEARNINGS.md, the D61 finding). This fakes the "someone else booked it first" side of the
// race with a free, no-inference direct MCP call, so the whole demo runs off one phone.
//
// Also doubles as the between-rehearsals reset for the REAL demo number: Call 1 of the demo
// script books a real appointment on it, and leaving that in place turns Call 1's "new caller"
// moment into a returning-caller one on the next run-through. `--reset` clears it.
//
//   from repo root:  set -a; . .env; . .env.local; set +a
//   node scripts/book-test-slot.mjs <date YYYY-MM-DD> <start HH:MM> [service]   # book the decoy slot
//   node scripts/book-test-slot.mjs --reset <phone, e.g. +10005550100>          # cancel everything on file for a number
//
// Booking prints the appointmentId - cancel it with --reset if you don't do it live on the call.
import { MCP_URL, webhookUrl } from '../assistants/config.mjs';

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

// Same lookup the assistants use for dynamic variables - only exposes the SOONEST appointment per
// call, so a phone with several on file needs one cancel-and-relookup pass per appointment.
async function nextAppointmentId(phone) {
  const res = await fetch(webhookUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { payload: { telnyx_end_user_target: phone } } }),
  });
  if (!res.ok) throw new Error(`webhook lookup failed: HTTP ${res.status}`);
  const { dynamic_variables } = await res.json();
  return dynamic_variables.next_appointment_id || undefined;
}

async function reset(phone) {
  let cancelled = 0;
  for (;;) {
    const id = await nextAppointmentId(phone);
    if (!id) break;
    await mcp('cancel_or_reschedule_appointment', { appointmentId: id, action: 'cancel' });
    cancelled++;
  }
  console.log(cancelled ? `Cancelled ${cancelled} appointment(s) for ${phone}.` : `Nothing on file for ${phone} - already clean.`);
}

async function book(date, start, service) {
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
  console.log(`Cancel afterward: node scripts/book-test-slot.mjs --reset +15555550199`);
}

const args = process.argv.slice(2);
if (args[0] === '--reset') {
  const phone = args[1];
  if (!phone) {
    console.error('Usage: node scripts/book-test-slot.mjs --reset <phone>');
    process.exit(1);
  }
  await reset(phone);
} else {
  const [date, start, service = 'cleaning'] = args;
  if (!date || !start) {
    console.error(
      'Usage: node scripts/book-test-slot.mjs <date YYYY-MM-DD> <start HH:MM> [service]\n' +
        '   or: node scripts/book-test-slot.mjs --reset <phone>',
    );
    process.exit(1);
  }
  await book(date, start, service);
}
