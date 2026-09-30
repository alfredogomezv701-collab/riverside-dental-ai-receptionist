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
const strip = (o) => JSON.parse(JSON.stringify(o));

async function currentHangupToolId() {
  const a = await fetch(`https://api.telnyx.com/v2/ai/assistants/${ids.frontDesk}`, {
    headers: { authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
  }).then((r) => r.json());
  return (a.data ?? a).conversation_flow.nodes.find((n) => n.id === 'n_hangup').shared_tool_id;
}
const hangupToolId = apply ? hangup ?? (await currentHangupToolId()) : '<hangup-tool-id>';
const common = { webhookUrl: WEBHOOK_URL, hangupToolId, mcpServerId: ids.mcpServer, frontDeskId: ids.frontDesk, schedulingId: ids.scheduling, billingId: ids.billing };

for (const [name, body] of [
  ['billing', billingAssistant(common)],
  ['scheduling', schedulingAssistant(common)],
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
