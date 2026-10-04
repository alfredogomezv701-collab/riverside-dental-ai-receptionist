// Demo step 4 ("Race and fallback") needs a slot that's already taken before the live call asks
// for it - normally a second caller, but only one phone number is verified on this account (see
// docs/LEARNINGS.md, the D61 finding). This fakes the "someone else booked it first" side of the
// race with a free, no-inference direct MCP call, so the whole demo runs off one phone.
//
// Booking (the default, no args needed) clears BOTH phones' reservations first, then books the
// decoy slot - so the SAME no-params command runs twice in the demo: once before Call 1 (clean
// slate) and once before Call 3 (clears whatever Call 1/2 left behind, then sets up the race) -
// always the same Thursday 9am slot, so you always know what to say on the call without checking
// anything. `--reset` is also available standalone for ad-hoc cleanup of one number.
//
//   from repo root:
//   node scripts/book-test-slot.mjs                                            # reset both phones, book next Thursday 9am
//   node scripts/book-test-slot.mjs <date YYYY-MM-DD> <start HH:MM> [service]  # same, but a specific slot instead of the default
//   node scripts/book-test-slot.mjs --reset <phone>                            # cancel everything on file for one number, nothing else
//
// Booking prints the appointmentId - cancel it with --reset if you don't do it live on the call.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MCP_URL, webhookUrl } from '../assistants/config.mjs';

// Load .env / .env.local ourselves (repo root, one level up from this file) instead of requiring
// the caller's shell to source them - bash and PowerShell disagree on that syntax, and this way
// neither matters. Never overrides a value already set in the environment; silently skips a
// missing file (fine for CI or a shell that already exported everything).
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
for (const name of ['.env', '.env.local']) {
  let text;
  try {
    text = readFileSync(`${repoRoot}${name}`, 'utf8');
  } catch {
    continue;
  }
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].trim();
  }
}

const DEMO_PHONE = '+10005550100';
const DECOY_PHONE = '+15555550199';
const CLINIC_TZ = 'America/Chicago';

/** The next Thursday (clinic-local), today included, as YYYY-MM-DD. */
function nextThursday() {
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: CLINIC_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = todayStr.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  while (probe.getUTCDay() !== 4) probe.setUTCDate(probe.getUTCDate() + 1); // 4 = Thursday
  return probe.toISOString().slice(0, 10);
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
  await reset(DEMO_PHONE);
  await reset(DECOY_PHONE);

  const result = await mcp('book_appointment', {
    service,
    date,
    start,
    patientName: 'Demo Decoy',
    patientPhone: DECOY_PHONE,
  });
  if (!result.confirmed) {
    console.error('Pre-book failed - pick a different slot:', result);
    process.exit(1);
  }
  console.log(`Booked ${date} ${start} under the decoy patient. appointmentId: ${result.appointment.appointmentId}`);
  console.log('Now call and ask for this exact slot - expect slot_already_booked + fresh-availability fallback.');
  console.log(`Cancel afterward: node scripts/book-test-slot.mjs --reset ${DECOY_PHONE}`);
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
  if (args.length > 0 && !(date && start)) {
    console.error(
      'Usage: node scripts/book-test-slot.mjs                                           (defaults: next Thursday, 9am)\n' +
        '   or: node scripts/book-test-slot.mjs <date YYYY-MM-DD> <start HH:MM> [service]\n' +
        '   or: node scripts/book-test-slot.mjs --reset <phone>',
    );
    process.exit(1);
  }
  await book(date ?? nextThursday(), start ?? '09:00', service);
}
