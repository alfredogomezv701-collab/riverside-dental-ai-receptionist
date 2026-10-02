import type { DaySlotNamespace } from './day_slot_binding.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

/**
 * POST /actor/{hold,confirm,release} — the HTTP face of DaySlotActor for
 * receptionist-mcp, which can't hold the binding itself (classic project).
 * Body shapes match receptionist-mcp/src/actors/day_slot_http_client.ts.
 * The actor's result is returned as-is with 200, so a lost race is
 * `{success:false, reason}`, not an HTTP error.
 */
export async function handleActorRoute(
  action: string,
  body: unknown,
  daySlot: DaySlotNamespace,
): Promise<{ status: number; json: unknown }> {
  const { date, start, callerId, durationMinutes, holdDurationMs } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof date !== 'string' || !DATE_RE.test(date) ||
    typeof start !== 'string' || !TIME_RE.test(start) ||
    typeof callerId !== 'string' || callerId.length === 0 ||
    (durationMinutes !== undefined && (typeof durationMinutes !== 'number' || !(durationMinutes > 0))) ||
    (holdDurationMs !== undefined && (typeof holdDurationMs !== 'number' || !(holdDurationMs > 0)))
  ) {
    return { status: 400, json: { error: 'invalid body: need date YYYY-MM-DD, start HH:MM, callerId' } };
  }
  const stub = daySlot.idFromName(date);
  switch (action) {
    case 'hold':
      return { status: 200, json: await stub.holdSlot(start, callerId, durationMinutes as number | undefined, holdDurationMs as number | undefined) };
    case 'confirm':
      return { status: 200, json: await stub.confirmSlot(start, callerId) };
    case 'release':
      return { status: 200, json: await stub.releaseSlot(start, callerId) };
    default:
      return { status: 404, json: { error: `unknown actor action: ${action}` } };
  }
}
