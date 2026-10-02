import type { DaySlotNamespace, DaySlotStub, DaySlotHoldResult, DaySlotConfirmResult, DaySlotReleaseResult } from './day_slot_binding.js';

/**
 * HTTP-based implementation of DaySlotNamespace, talking to
 * receptionist-webhook's /actor/* routes instead of a native actor binding.
 *
 * Why: `telnyx-edge types` refuses to type (and the platform refuses to run)
 * an `[[actors]]` binding inside a "classic" (func.toml) project — actors
 * only work in telnyx.toml/worker-style projects. receptionist-mcp has to
 * stay classic (Express + the MCP SDK's StreamableHTTPServerTransport need
 * a real Node server, which the worker/fetch-handler model doesn't give
 * you cleanly). So the DAY_SLOT actor binding lives in receptionist-webhook
 * (telnyx.toml, no server-framework constraint) instead, and this client
 * reaches it the same way any other edge function calls another: an
 * authenticated HTTP request. See docs/ARCHITECTURE.md, "Cross-function
 * actor access."
 *
 * Callers (book_appointment_handler.ts, cancel_or_reschedule_appointment_handler.ts)
 * are written against the DaySlotNamespace/DaySlotStub interface only — they
 * do not know or care whether it's backed by a native binding or HTTP.
 */
export function createHttpDaySlotNamespace(baseUrl: string, sharedSecret: string, requestId?: string): DaySlotNamespace {
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(new URL(path, baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sharedSecret}`,
        // Correlates this hop with the webhook's /actor/* log line (same id as the MCP tool-call log).
        ...(requestId ? { 'x-request-id': requestId } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`actor proxy ${path} responded ${res.status}`);
    }
    return (await res.json()) as T;
  };

  return {
    idFromName(name: string): DaySlotStub {
      return {
        id: name,
        holdSlot: (start, callerId, durationMinutes, holdDurationMs) =>
          post<DaySlotHoldResult>('/actor/hold', { date: name, start, callerId, durationMinutes, holdDurationMs }),
        confirmSlot: (start, callerId) =>
          post<DaySlotConfirmResult>('/actor/confirm', { date: name, start, callerId }),
        releaseSlot: (start, callerId) =>
          post<DaySlotReleaseResult>('/actor/release', { date: name, start, callerId }),
        getStats: async () => {
          // /actor/stats is a GET route on the actor's own HTTP surface, not proxied via POST.
          const res = await fetch(new URL(`/actor/stats?date=${encodeURIComponent(name)}`, baseUrl), {
            headers: { authorization: `Bearer ${sharedSecret}`, ...(requestId ? { 'x-request-id': requestId } : {}) },
          });
          if (!res.ok) throw new Error(`actor proxy /actor/stats responded ${res.status}`);
          return (await res.json()) as { conversions: number; expirations: number; conversionRate: string };
        },
      };
    },
  };
}
