// Re-export the actor class from the entry point so it is bundled and shipped
// with the function (the runtime resolves the [[actors]] type here; the
// exported class name must equal the type).
export { DaySlotActor } from './day_slot_actor.js';

const VERSION = process.env.VERSION || 'dev';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ status: 'ok', version: VERSION, secrets: {} });
    }

    if (req.method === 'GET' && url.pathname === '/actor/stats') {
      const date = url.searchParams.get('date');
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return Response.json({ error: 'invalid date' }, { status: 400 });
      }
      const stats = await env.DAY_SLOT.idFromName(date).getStats();
      return Response.json(stats);
    }

    // This actor has no direct public HTTP surface — it's called via its
    // stub (env.DAY_SLOT.idFromName(date).holdSlot(...) etc.) from
    // receptionist-mcp and receptionist-webhook, once those bind it.
    return new Response('day-slot-actor: call via actor stub, not HTTP', { status: 404 });
  },
};
