// Pushes the current definitions.mjs to the assistants recorded in ids.json (no re-create).
//   node assistants/update.mjs            dry run (prints which assistants it would update)
//   node assistants/update.mjs --apply    needs TELNYX_API_KEY and WEBHOOK_TOKEN
import { readFileSync } from 'node:fs';
import { billingAssistant, schedulingAssistant, frontDeskAssistant } from './definitions.mjs';
import { webhookUrl } from './config.mjs';

const ids = JSON.parse(readFileSync(new URL('./ids.json', import.meta.url)));
const apply = process.argv.includes('--apply');
const WEBHOOK_URL = webhookUrl({ dryRun: !apply }); // needs WEBHOOK_TOKEN when applying
const hangup = process.env.HANGUP_TOOL_ID; // only needed to rebuild flows
// The `update_dynamic_variables` shared tool id (for the attempt_count -> waitlist edge). Only
// Scheduling uses it. Created by setup.mjs; here, prefer an env override, else scrape the live
// Scheduling assistant's tool_ids for an update_dynamic_variables tool.
const attemptCounter = process.env.ATTEMPT_COUNTER_TOOL_ID;
const strip = (o) => JSON.parse(JSON.stringify(o));

async function currentHangupToolId() {
  const a = await fetch(`https://api.telnyx.com/v2/ai/assistants/${ids.frontDesk}`, {
    headers: { authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
  }).then((r) => r.json());
  return (a.data ?? a).conversation_flow.nodes.find((n) => n.id === 'n_hangup').shared_tool_id;
}
const hangupToolId = apply ? hangup ?? (await currentHangupToolId()) : '<hangup-tool-id>';

async function currentAttemptCounterToolId() {
  // Read the live Scheduling assistant and find the shared update_dynamic_variables tool. NOTE:
  // despite POST accepting `tool_ids` (an array of bare id strings) to attach a shared tool, GET
  // does NOT echo that field back — it returns the fully resolved `tools` array instead (each
  // entry already carrying `type` and `tool_id`, no follow-up /ai/tools fetch needed). Confirmed
  // empirically: a live assistant with a tool attached via `tool_ids` shows `tool_ids: undefined`
  // and the attached tool under `tools` on GET. Mirror currentHangupToolId's read-the-live-resource
  // pattern, just against the field this API actually returns.
  const a = await fetch(`https://api.telnyx.com/v2/ai/assistants/${ids.scheduling}`, {
    headers: { authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
  }).then((r) => r.json());
  const tool = ((a.data ?? a).tools ?? []).find((t) => t.type === 'update_dynamic_variables');
  if (!tool) throw new Error('No update_dynamic_variables tool attached to Scheduling. Run setup.mjs --apply, or set ATTEMPT_COUNTER_TOOL_ID.');
  return tool.tool_id;
}
const attemptCounterToolId = apply ? attemptCounter ?? (await currentAttemptCounterToolId()) : '<attempt-counter-tool-id>';
const schedulingCommon = { webhookUrl: WEBHOOK_URL, hangupToolId, mcpServerId: ids.mcpServer, attemptCounterToolId, frontDeskId: ids.frontDesk, schedulingId: ids.scheduling, billingId: ids.billing };
const common = { webhookUrl: WEBHOOK_URL, hangupToolId, mcpServerId: ids.mcpServer, frontDeskId: ids.frontDesk, schedulingId: ids.scheduling, billingId: ids.billing };

for (const [name, body] of [
  ['billing', billingAssistant(common)],
  ['scheduling', schedulingAssistant(schedulingCommon)],
  ['frontDesk', frontDeskAssistant(common)],
]) {
  if (!apply) { console.log(`would update ${name} (${ids[name]})`); continue; }
  const res = await fetch(`https://api.telnyx.com/v2/ai/assistants/${ids[name]}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.TELNYX_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(strip(body)),
  });
  if (!res.ok) throw new Error(`update ${name} -> ${res.status}: ${(await res.text()).slice(0, 600)}`);
  console.log(`updated ${name}`);
}

// Sync the MCP server's server-level allowed_tools with what definitions.mjs declares for
// Scheduling. This is a SEPARATE resource from the assistant-level mcp_servers[].allowed_tools
// (which the assistant update above just sent): the MCP server resource has its own allowlist,
// and Telnyx gates tools/list against THAT field. The two were previously maintained by hand and
// drifted — join_waitlist landed in the assistant-level allowlist but never on the server-level
// resource, so Scheduling could not actually call it in production despite having it declared.
// Update it the same way the assistant update works: PUT the resource by its known id (from
// ids.json). This is an UPDATE of an existing resource, not a create — no duplication risk, no
// setup.mjs re-run needed. The body preserves every existing field (url, name, type, api_key_ref)
// by reading the live resource first via GET, then only swapping in the new allowed_tools —
// exactly the GET-first-then-write pattern used for the hangup tool above. Definitions.mjs is the
// source of truth for the tool list (taken from schedulingAssistant's mcp_servers[0].allowed_tools),
// so this PUT keeps the live server-level allowlist in sync rather than being a separately
// maintained, drift-prone field.
if (apply) {
  const schedulingBody = schedulingAssistant(schedulingCommon);
  const serverEntry = schedulingBody.mcp_servers[0];
  if (serverEntry) {
    // GET first: read the live MCP server so we preserve its url/name/type/api_key_ref (which the
    // PUT replaces wholesale — sending an empty url would blank it; we send back what we read).
    const getRes = await fetch(`https://api.telnyx.com/v2/ai/mcp_servers/${ids.mcpServer}`, {
      headers: { authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
    });
    if (!getRes.ok) throw new Error(`get mcp_server ${ids.mcpServer} -> ${getRes.status}: ${(await getRes.text()).slice(0, 600)}`);
    // Unlike /ai/assistants/{id}, this single-resource GET does NOT wrap the result in `.data` —
    // confirmed empirically (a real API inconsistency, see docs/LEARNINGS.md). Defensive fallback
    // matches the `.data ?? ...` pattern already used everywhere else in this codebase.
    const getJson = await getRes.json();
    const liveServer = getJson.data ?? getJson;
    const putRes = await fetch(`https://api.telnyx.com/v2/ai/mcp_servers/${ids.mcpServer}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${process.env.TELNYX_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: liveServer.name,
        type: liveServer.type,
        url: liveServer.url,
        api_key_ref: liveServer.api_key_ref,
        allowed_tools: serverEntry.allowed_tools,
      }),
    });
    if (!putRes.ok) throw new Error(`update mcp_server ${ids.mcpServer} -> ${putRes.status}: ${(await putRes.text()).slice(0, 600)}`);
    const putJson = await putRes.json();
    const echoed = (putJson.data ?? putJson).allowed_tools;
    console.log(`updated mcp_server ${ids.mcpServer} allowed_tools -> ${(echoed ?? []).join(', ') || '(empty)'}`);
    // Sanity check: the server echoed back exactly what we sent. A drift here means the PUT
    // partially applied, or the server side dropped/added something — both worth surfacing.
    if (JSON.stringify(echoed) !== JSON.stringify(serverEntry.allowed_tools)) {
      throw new Error(`mcp_server allowed_tools mismatch after PUT: sent ${JSON.stringify(serverEntry.allowed_tools)}, server echoed ${JSON.stringify(echoed)}`);
    }
  }
} else {
  console.log(`would update mcp_server ${ids.mcpServer} allowed_tools (apply-time PUT to sync with definitions.mjs)`);
}
