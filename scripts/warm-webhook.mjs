// Manual pre-demo step: fire one throwaway dynamic-variables lookup at the live webhook so the
// container and the KV round-trip it needs are both warm before the real demo call comes in.
// Hitting /health instead would only warm the container - that handler never touches KV, and KV's
// own round-trip (not cold start) is the latency we actually measured. A junk phone number that
// matches no patient record exercises the exact same code path (lookupPatient) as a real call,
// read-only, so nothing needs cleanup afterward.
//
//   from repo root:  set -a; . .env; . .env.local; set +a; node scripts/warm-webhook.mjs
//
import { webhookUrl } from '../assistants/config.mjs';

const JUNK_PHONE = '+10000000000';

const started = Date.now();
const res = await fetch(webhookUrl(), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ data: { payload: { telnyx_end_user_target: JUNK_PHONE } } }),
});
const latencyMs = Date.now() - started;
const body = await res.json().catch(() => undefined);

if (!res.ok) {
  console.error(`Warm-up call failed: HTTP ${res.status}`, body);
  process.exit(1);
}
console.log(`Warm-up ok in ${latencyMs}ms - dial the demo number now.`);
