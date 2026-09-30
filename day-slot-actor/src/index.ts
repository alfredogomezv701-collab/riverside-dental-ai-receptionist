// Re-export the actor class from the entry point so it is bundled and shipped
// with the function (the runtime resolves the [[actors]] type here; the
// exported class name must equal the type).
export { DaySlotActor } from './day_slot_actor.js';

export default {
  async fetch(_req: Request, _env: Env): Promise<Response> {
    // This actor has no direct public HTTP surface — it's called via its
    // stub (env.DAY_SLOT.idFromName(date).holdSlot(...) etc.) from
    // receptionist-mcp and receptionist-webhook, once those bind it.
    return new Response('day-slot-actor: call via actor stub, not HTTP', { status: 404 });
  },
};
