// Creates the Riverside Dental assistants on Telnyx.
//
//   node assistants/setup.mjs              dry run: prints every request body, no network
//   node assistants/setup.mjs --apply      creates everything (needs env vars below)
//
// env (apply only): TELNYX_API_KEY, MCP_SHARED_SECRET (same value as the SHARED_SECRET secret on
// receptionist-mcp), WEBHOOK_TOKEN (value of the WEBHOOK_TOKEN secret on receptionist-webhook). Never printed.
import { billingAssistant, schedulingAssistant, frontDeskAssistant } from './definitions.mjs';
import { MCP_URL, webhookUrl } from './config.mjs';
const SECRET_ID = 'receptionist_mcp_token';
// The docs don't enumerate valid `type` values for /ai/mcp_servers; probing the live API
// showed only 'http' and 'sse' are accepted. Our server is Streamable HTTP => 'http'.
const MCP_TYPE = 'http';

const apply = process.argv.includes('--apply');
const WEBHOOK_URL = webhookUrl({ dryRun: !apply });
const API = 'https://api.telnyx.com/v2';

async function call(method, path, body) {
  if (!apply) {
    console.log(`\n--- ${method} ${path}\n${JSON.stringify(body, null, 2)}`);
    return { data: { id: `<${path.split('/').pop()}-id>` }, id: `<${path.split('/').pop()}-id>` };
  }
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${process.env.TELNYX_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 800)}`);
  return JSON.parse(text);
}
const idOf = (r) => r.data?.id ?? r.id;

if (apply && (!process.env.TELNYX_API_KEY || !process.env.MCP_SHARED_SECRET)) {
  throw new Error('Set TELNYX_API_KEY and MCP_SHARED_SECRET');
}

// Idempotent: a re-run after a partial failure must not die on the existing secret.
if (apply) {
  const existing = await fetch(API + '/integration_secrets', { headers: { authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }).then((r) => r.json());
  if ((existing.data ?? []).some((x) => x.identifier === SECRET_ID)) console.log('secret exists, reusing:', SECRET_ID);
  else await call('POST', '/integration_secrets', { identifier: SECRET_ID, type: 'bearer', token: process.env.MCP_SHARED_SECRET });
} else {
  await call('POST', '/integration_secrets', { identifier: SECRET_ID, type: 'bearer', token: '<redacted>' });
}

const mcpServerId = idOf(await call('POST', '/ai/mcp_servers', {
  name: 'receptionist-mcp',
  type: MCP_TYPE,
  url: MCP_URL,
  api_key_ref: SECRET_ID,
  allowed_tools: ['check_availability', 'book_appointment', 'cancel_or_reschedule_appointment'],
}));

const hangupToolId = idOf(await call('POST', '/ai/tools', {
  type: 'hangup',
  display_name: 'Hang up',
  hangup: { description: 'Ends the call.' },
}));

const strip = (o) => JSON.parse(JSON.stringify(o)); // drop undefined (e.g. unpinned model)

const billingId = idOf(await call('POST', '/ai/assistants', strip(billingAssistant({ webhookUrl: WEBHOOK_URL }))));

// Scheduling needs the Front Desk id for its "something else" hand-back edge, and Front Desk
// needs Scheduling's id: create Scheduling first without that edge target, then patch it in.
const schedulingBody = strip(schedulingAssistant({ webhookUrl: WEBHOOK_URL, mcpServerId, hangupToolId, frontDeskId: billingId }));
const schedulingId = idOf(await call('POST', '/ai/assistants', schedulingBody));

const frontDeskId = idOf(await call('POST', '/ai/assistants', strip(frontDeskAssistant({
  webhookUrl: WEBHOOK_URL, hangupToolId, schedulingId, billingId,
}))));

// Second pass, now that every id exists: point Scheduling's hand-back edge at the real Front Desk
// (placeholder above) and give Billing its flow (it needs Scheduling's id to hand callers over).
await call('POST', `/ai/assistants/${schedulingId}`, strip(schedulingAssistant({
  webhookUrl: WEBHOOK_URL, mcpServerId, hangupToolId, frontDeskId,
})));
await call('POST', `/ai/assistants/${billingId}`, strip(billingAssistant({
  webhookUrl: WEBHOOK_URL, hangupToolId, schedulingId,
})));

console.log(`\n${apply ? 'Created' : 'Would create'}: front desk=${frontDeskId} scheduling=${schedulingId} billing=${billingId}`);
if (apply) console.log('Next: assign a phone number to the Front Desk assistant in the Portal.');
