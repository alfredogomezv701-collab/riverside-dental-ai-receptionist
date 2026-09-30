// Deployed endpoints shared by setup.mjs, update.mjs and the live tests.
export const WEBHOOK_BASE = 'https://receptionist-webhook-baaf7d07-b.telnyxcompute.com';
export const MCP_URL = 'https://receptionist-mcp-f366a7db-0.telnyxcompute.com/mcp';

/**
 * The dynamic-variables webhook URL the assistants are configured with. It carries `?token=` because
 * that route returns a patient's name and appointment id for any number it is asked about and must not
 * be public; the token is the WEBHOOK_TOKEN secret on receptionist-webhook. Pass `dryRun` to get a
 * placeholder instead of requiring the real value.
 */
export function webhookUrl({ dryRun = false } = {}) {
  const token = process.env.WEBHOOK_TOKEN;
  if (!token && !dryRun) throw new Error('Set WEBHOOK_TOKEN (the value of the WEBHOOK_TOKEN secret on receptionist-webhook)');
  return `${WEBHOOK_BASE}/?token=${token || '<WEBHOOK_TOKEN>'}`;
}
