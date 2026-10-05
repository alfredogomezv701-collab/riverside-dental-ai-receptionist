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
    // \r? before $: CRLF line endings (this repo's .env has them) otherwise make the whole line
    // fail to match at all (`.` doesn't consume \r, and `$` without /m only matches true end of
    // string or before a final \n) - not just leave a trailing \r on the value. Silently losing an
    // entire var is worse than a stray \r, which is why this needs calling out, not just trimming.
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\r?$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].trim();
  }
}

// The real verified demo number - not hardcoded, so it's never committed to source. Set it in
// .env.local (gitignored), same place as the other secrets this script already loads.
const DEMO_PHONE = process.env.DEMO_PHONE;
if (!DEMO_PHONE) {
  console.error('Set DEMO_PHONE in .env.local first (the verified number you demo from).');
  process.exit(1);
}
const DECOY_PHONE = '+15555550199';
const CLINIC_TZ = 'America/Chicago';
const KV_NAMESPACE = '3c826291-8337-4141-821c-080f0bb32c28';
const digitsOf = (phone) => phone.replace(/\D/g, '').slice(-10);

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

// Waitlist entries aren't reachable through the webhook/MCP (no "my waitlist entries" lookup
// exists), via the same REST API `telnyx-edge storage kv` itself calls under the hood.
async function listWaitlistKeys() {
  const key = process.env.TELNYX_API_KEY;
  if (!key) return [];
  const res = await fetch(`https://api.telnyx.com/v2/storage/kvs/${KV_NAMESPACE}/keys?prefix=waitlist/&limit=1000`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!res.ok) return [];
  const { data } = await res.json();
  return data || [];
}
async function deleteWaitlistKeys(keys) {
  const key = process.env.TELNYX_API_KEY;
  for (const k of keys) {
    await fetch(`https://api.telnyx.com/v2/storage/kvs/${KV_NAMESPACE}/keys/${k.key}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${key}` },
    });
  }
  return keys.length;
}
// The key is waitlist/{date}/{phone10} - date-prefixed, so it can't be constructed without
// knowing the date. Used by the standalone --reset <phone>, scoped to that one number.
async function clearWaitlist(phone) {
  const suffix = `/${digitsOf(phone)}`;
  return deleteWaitlistKeys((await listWaitlistKeys()).filter((k) => k.key.endsWith(suffix)));
}
// Used by the default book() reset: third-party bookings (booking for a brother, a kid, etc.) land
// under whatever phone number the caller gave mid-call, not a demo/decoy number anyone can list in
// advance - so the default reset wipes every waitlist entry, not just the two known numbers'. This
// is a demo account with no real waitlist to protect, so that's fine.
async function clearAllWaitlist() {
  return deleteWaitlistKeys(await listWaitlistKeys());
}

async function reset(phone) {
  let cancelled = 0;
  for (;;) {
    const id = await nextAppointmentId(phone);
    if (!id) break;
    await mcp('cancel_or_reschedule_appointment', { appointmentId: id, action: 'cancel' });
    cancelled++;
  }
  const waitlisted = await clearWaitlist(phone);
  const parts = [];
  if (cancelled) parts.push(`${cancelled} appointment(s)`);
  if (waitlisted) parts.push(`${waitlisted} waitlist entry(ies)`);
  console.log(parts.length ? `Cancelled ${parts.join(' and ')} for ${phone}.` : `Nothing on file for ${phone} - already clean.`);
}

async function book(date, start, service) {
  await reset(DEMO_PHONE);
  await reset(DECOY_PHONE);
  const wiped = await clearAllWaitlist();
  if (wiped) console.log(`Wiped ${wiped} waitlist entry(ies) (every number, not just the two known ones).`);

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
