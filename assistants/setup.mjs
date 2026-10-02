// Creates the Riverside Dental assistants on Telnyx.
//
//   node assistants/setup.mjs              dry run: prints every request body, no network
//   node assistants/setup.mjs --apply      creates everything (needs env vars below)
//
// IDEMPOTENT: a re-run after a partial success (or a re-run purely to pick up a new tool) must
// never create duplicate live resources. Every create below is wrapped in a find-or-create:
//   - integration secret: list /integration_secrets, reuse if `receptionist_mcp_token` exists
//   - MCP server:          list /ai/mcp_servers, reuse one with the same `name`
//   - hangup tool:         list /ai/tools, reuse one whose type==hangup AND display_name=="Hang up"
//   - attempt counter:     list /ai/tools, reuse one whose type==update_dynamic_variables AND
//                          display_name=="Update attempt counter"
//   - assistants:          list /ai/assistants, reuse one whose name matches the definitions' name
// This mirrors update.mjs's currentHangupToolId() pattern (read the live resource first, never
// blindly POST a duplicate) and applies it to every resource setup.mjs creates, not just the
// hangup tool. The stable discriminator for /ai/tools is (type, display_name) since Telnyx does
// not expose a caller-supplied tool id; for /ai/mcp_servers and /ai/assistants it is `name`
// (the human-readable string the definitions set).
//
// env (apply only): TELNYX_API_KEY, MCP_SHARED_SECRET (same value as the SHARED_SECRET secret on
// receptionist-mcp), WEBHOOK_TOKEN (value of the WEBHOOK_TOKEN secret on receptionist-webhook). Never printed.
import { billingAssistant, schedulingAssistant, frontDeskAssistant } from './definitions.mjs';
import { MCP_URL, webhookUrl } from './config.mjs';
const SECRET_ID = 'receptionist_mcp_token';
// The docs don't enumerate valid `type` values for /ai/mcp_servers; probing the live API
// showed only 'http' and 'sse' are accepted. Our server is Streamable HTTP => 'http'.
const MCP_TYPE = 'http';

// Stable display names for the shared /ai/tools resources, so find-or-create can match them
// across runs by (type, display_name) — Telnyx assigns the id, we own the name.
const HANGUP_TOOL_DISPLAY_NAME = 'Hang up';
const ATTEMPT_COUNTER_TOOL_DISPLAY_NAME = 'Update attempt counter';

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

// --- find-or-create helpers (apply only; dry run falls through to call()) ----------------
// Each lists a collection, matches by a stable discriminator, and reuses the existing resource
// if found — never POSTing a duplicate. The discriminator is (type, display_name) for /ai/tools
// (Telnyx owns the id), and `name` for /ai/mcp_servers and /ai/assistants (we own the name).

/** GET a list endpoint and return its `data` array (or []). */
async function listResources(path) {
  if (!apply) return [];
  const r = await fetch(API + path, { headers: { authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }).then((r) => r.json());
  return r.data ?? [];
}

/**
 * Find-or-create a shared tool (/ai/tools). Match by (type, display_name), since Telnyx assigns
 * the id and the same tool created twice is a duplicate, not an update. The body is the same as
 * the create body when a new one is needed; nothing is patched when an existing one is found.
 */
async function findOrCreateTool(type, displayName, createBody) {
  if (!apply) return idOf(await call('POST', '/ai/tools', createBody));
  const tools = await listResources('/ai/tools');
  const existing = tools.find((t) => t.type === type && t.display_name === displayName);
  if (existing) {
    console.log(`tool exists, reusing: ${type} "${displayName}" (${existing.id})`);
    return existing.id;
  }
  const created = await call('POST', '/ai/tools', createBody);
  return idOf(created);
}

/** Find-or-create an MCP server (/ai/mcp_servers), matched by `name`. */
async function findOrCreateMcpServer(name, createBody) {
  if (!apply) return idOf(await call('POST', '/ai/mcp_servers', createBody));
  const servers = await listResources('/ai/mcp_servers');
  const existing = servers.find((s) => s.name === name);
  if (existing) {
    console.log(`mcp_server exists, reusing: "${name}" (${existing.id})`);
    return existing.id;
  }
  const created = await call('POST', '/ai/mcp_servers', createBody);
  return idOf(created);
}

/** Find-or-create an assistant (/ai/assistants), matched by `name`. */
async function findOrCreateAssistant(name, createBody) {
  if (!apply) return idOf(await call('POST', '/ai/assistants', createBody));
  const assistants = await listResources('/ai/assistants');
  const existing = assistants.find((a) => a.name === name);
  if (existing) {
    console.log(`assistant exists, reusing: "${name}" (${existing.id})`);
    return existing.id;
  }
  const created = await call('POST', '/ai/assistants', createBody);
  return idOf(created);
}

// Idempotent: a re-run after a partial failure must not die on the existing secret.
if (apply) {
  const existing = await fetch(API + '/integration_secrets', { headers: { authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }).then((r) => r.json());
  if ((existing.data ?? []).some((x) => x.identifier === SECRET_ID)) console.log('secret exists, reusing:', SECRET_ID);
  else await call('POST', '/integration_secrets', { identifier: SECRET_ID, type: 'bearer', token: process.env.MCP_SHARED_SECRET });
} else {
  await call('POST', '/integration_secrets', { identifier: SECRET_ID, type: 'bearer', token: '<redacted>' });
}

const mcpServerId = await findOrCreateMcpServer('receptionist-mcp', {
  name: 'receptionist-mcp',
  type: MCP_TYPE,
  url: MCP_URL,
  api_key_ref: SECRET_ID,
  // Keeping join_waitlist in the server-level allowlist too (Fix 3) — this is the resource Telnyx
  // gates tools/list against. update.mjs keeps it in sync post-create; setup just seeds it.
  allowed_tools: ['check_availability', 'book_appointment', 'cancel_or_reschedule_appointment', 'join_waitlist'],
});

const hangupToolId = await findOrCreateTool('hangup', HANGUP_TOOL_DISPLAY_NAME, {
  type: 'hangup',
  display_name: HANGUP_TOOL_DISPLAY_NAME,
  hangup: { description: 'Ends the call.' },
});

// The `update_dynamic_variables` built-in shared tool: lets the assistant write values into the
// conversation's dynamic-variable store mid-call; those updated variables are then available to
// flow edge conditions (this is the mechanism that makes the `attempt_count >= 3 -> waitlist`
// variable-comparison edge fire mid-conversation). The assistant is allowed to write exactly one
// variable: `attempt_count`, the failed-booking counter that book_appointment returns and the
// n_book instructions tell the model to mirror here via this tool.
const attemptCounterToolId = await findOrCreateTool('update_dynamic_variables', ATTEMPT_COUNTER_TOOL_DISPLAY_NAME, {
  type: 'update_dynamic_variables',
  display_name: ATTEMPT_COUNTER_TOOL_DISPLAY_NAME,
  update_dynamic_variables: {
    name: 'update_attempt_count',
    description: 'Set the attempt_count conversation variable to the attempt_count number returned by the last book_appointment tool call. Call this after every book_appointment result that includes an attempt_count field.',
    updatable_variables: [
      { name: 'attempt_count', type: 'string', description: 'How many times this caller has now hit slot_already_booked for the current date (a non-negative integer as a string).' },
    ],
  },
});

const strip = (o) => JSON.parse(JSON.stringify(o)); // drop undefined (e.g. unpinned model)

// Each findOrCreateAssistant matches by the `name` field the definitions set, so an existing
// assistant (named e.g. "Riverside Dental — Scheduling Specialist") is reused, not duplicated.
const billingBody = strip(billingAssistant({ webhookUrl: WEBHOOK_URL }));
const billingId = await findOrCreateAssistant(billingBody.name, billingBody);

// Scheduling needs the Front Desk id for its "something else" hand-back edge, and Front Desk
// needs Scheduling's id: create Scheduling first without that edge target, then patch it in.
const schedulingBody = strip(schedulingAssistant({ webhookUrl: WEBHOOK_URL, mcpServerId, hangupToolId, attemptCounterToolId, frontDeskId: billingId }));
const schedulingId = await findOrCreateAssistant(schedulingBody.name, schedulingBody);

const frontDeskBody = strip(frontDeskAssistant({ webhookUrl: WEBHOOK_URL, hangupToolId, schedulingId, billingId }));
const frontDeskId = await findOrCreateAssistant(frontDeskBody.name, frontDeskBody);

// Second pass, now that every id exists: point Scheduling's hand-back edge at the real Front Desk
// (placeholder above) and give Billing its flow (it needs Scheduling's id to hand callers over).
// These are POST updates to existing resources (findOrCreateAssistant returned the existing id),
// not creates — so they are safe to re-run too.
await call('POST', `/ai/assistants/${schedulingId}`, strip(schedulingAssistant({
  webhookUrl: WEBHOOK_URL, mcpServerId, hangupToolId, attemptCounterToolId, frontDeskId,
})));
await call('POST', `/ai/assistants/${billingId}`, strip(billingAssistant({
  webhookUrl: WEBHOOK_URL, hangupToolId, schedulingId, frontDeskId,
})));

console.log(`\n${apply ? 'Created/verified' : 'Would create'}: front desk=${frontDeskId} scheduling=${schedulingId} billing=${billingId}`);
if (apply) console.log('Next: assign a phone number to the Front Desk assistant in the Portal.');
