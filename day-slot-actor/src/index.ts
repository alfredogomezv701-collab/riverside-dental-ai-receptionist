// Re-export the actor class from the entry point so it is bundled and shipped
// with the function (the runtime resolves the [[actors]] type here; the
// exported class name must equal the type).
export { DaySlotActor } from './day_slot_actor.js';

const VERSION = process.env.VERSION || 'dev';

/** Constant-time string compare: both sides are hashed so lengths never leak and buffers always match in size. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const xb = new Uint8Array(x);
  const yb = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xb.length; i++) diff |= xb[i] ^ yb[i];
  return diff === 0;
}

/** True only when the secret is configured AND the presented value matches it. A missing secret never authenticates. */
async function authorised(env: Env, presented: string): Promise<boolean> {
  let secret = '';
  try {
    secret = await env.SECRETS.get('ACTOR_PROXY_SECRET');
  } catch {
    secret = ''; // secret not created: fail closed
  }
  return secret !== '' && (await safeEqual(presented, secret));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ status: 'ok', version: VERSION, secrets: {} });
    }

    if (req.method === 'GET' && url.pathname === '/actor/stats') {
      // Same bearer receptionist-webhook's own /actor/stats requires - this route is low
      // sensitivity (aggregate counts, no patient data) but was previously open to anyone who
      // found this function's URL, inconsistent with the equivalent authenticated route elsewhere.
      const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (!(await authorised(env, bearer))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const date = url.searchParams.get('date');
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return Response.json({ error: 'invalid date' }, { status: 400 });
      }
      const stats = await env.DAY_SLOT.idFromName(date).getStats();
      return Response.json(stats);
    }

    // Everything except health and the authenticated stats route above goes through the actor
    // stub (env.DAY_SLOT.idFromName(date).holdSlot(...) etc.) from receptionist-mcp and
    // receptionist-webhook, once those bind it - not a bare HTTP call to this function.
    return new Response('day-slot-actor: call via actor stub, not HTTP', { status: 404 });
  },
};
