import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KvNamespace } from '@telnyx/edge-runtime';
import { dateProblem, findConflict, KNOWN_SERVICES, loadDayBookings, slotGrid, SERVICE_DURATION_MINUTES } from '../calendar.js';
import { logToolCall, type ReportExtra } from '../log.js';
import {
  CHECK_AVAILABILITY_TOOL_NAME,
  CHECK_AVAILABILITY_TOOL_DESCRIPTION,
  checkAvailabilityInputSchema,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type CheckAvailabilityInput,
  type CheckAvailabilityResult,
} from './check_availability.js';

interface ToolContext {
  kv: KvNamespace | undefined;
  requestId?: string;
  /** Clinic-local "today" (YYYY-MM-DD); injectable so tests don't rot as the calendar moves. */
  today?: string;
}

/**
 * Opaque cursor: base64url of the last slot's start time that the caller already saw, so the next
 * page begins strictly after it. base64 (not the raw "HH:MM") so the model treats it as a token
 * rather than something to interpret, and so an invalid cursor from a stale/pasted run is caught
 * by decode+validation rather than silently producing an empty or duplicated page.
 */
export function encodeCursor(start: string): string {
  return Buffer.from(start, 'utf8').toString('base64url');
}
export function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

/**
 * Paginate the already-computed full-day availability into one page. Only slots with
 * `available: true` are returned — the AI never sees unavailable ones, so it can neither offer
 * them nor be tempted to "explain" them. Cursor is an opaque base64url of the last returned
 * slot's `start`; the next page is the open slots strictly after that start.
 *
 * Why cursor rather than page number: between two pages a slot can be booked (turning true->false)
 * or freed (false->true). A page number is an offset into a list that has changed; a cursor keyed
 * to "give me things after X" still returns a correct, non-overlapping, non-gapped view even when
 * the underlying set shifts — the worst case is one slot near the cursor boundary that the caller
 * sees twice (booked-then-freed) or not at all (freed-then-booked), and the booking tool still
 * catches any double-claim at write time.
 */
export function paginateSlots(
  allSlots: readonly { start: string; end: string; available: boolean }[],
  cursor: string | undefined,
  limit: number,
): { slots: { start: string; end: string; available: boolean }[]; next_cursor?: string } {
  const open = allSlots.filter((s) => s.available);
  let fromIndex = 0;
  if (cursor) {
    let afterStart: string;
    try {
      afterStart = decodeCursor(cursor);
    } catch {
      // A cursor that doesn't base64-decode is stale/garbage — reset to the first page rather than
      // erroring, so a confused model turn doesn't strand the caller.
      afterStart = '';
    }
    if (!/^\d{2}:\d{2}$/.test(afterStart)) afterStart = '';
    fromIndex = open.findIndex((s) => s.start > afterStart);
    if (fromIndex === -1) fromIndex = open.length; // cursor past everything: empty page, no next
  }
  const page = open.slice(fromIndex, fromIndex + limit);
  const nextIndex = fromIndex + page.length;
  const next_cursor = nextIndex < open.length ? encodeCursor(page[page.length - 1].start) : undefined;
  return { slots: page, next_cursor };
}

/**
 * The grid for the service minus everything already booked that day. Deliberately NOT cached: a
 * cached answer goes stale the moment someone books, which is exactly when the next caller asks.
 * Costs one KV list plus the day's booking reads (issued together) per call.
 */
export async function runCheckAvailability(
  input: CheckAvailabilityInput,
  ctx: ToolContext,
  report?: ReportExtra,
): Promise<CheckAvailabilityResult> {
  if (!SERVICE_DURATION_MINUTES[input.service]) {
    return { service: input.service, date: input.date, slots: [], total_available: 0, note: `unknown service; use one of: ${KNOWN_SERVICES.join(', ')}` };
  }
  const bad = dateProblem(input.date, ctx.today);
  if (bad) return { service: input.service, date: input.date, slots: [], total_available: 0, note: bad };

  // Timed and counted separately from the rest of the function so a slow call can be attributed to
  // this specific KV work (one `list` plus one `get` per booking found) rather than lumped into the
  // tool's total latency_ms — see docs/LEARNINGS.md, the check_availability latency investigation.
  const lookupStart = Date.now();
  const booked = ctx.kv ? await loadDayBookings(ctx.kv, input.date) : [];
  report?.({ kv_reads: ctx.kv ? 1 + booked.length : 0, lookup_ms: Date.now() - lookupStart });
  const all = slotGrid(input.service, input.date).map((s) => ({
    ...s,
    available: s.available && !findConflict({ service: input.service, start: s.start }, booked),
  }));
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const { slots, next_cursor } = paginateSlots(all, input.cursor, limit);
  const total_available = all.filter((s) => s.available).length;
  const result: CheckAvailabilityResult = { service: input.service, date: input.date, slots, total_available };
  if (next_cursor) result.next_cursor = next_cursor;
  return result;
}

export function registerCheckAvailability(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    CHECK_AVAILABILITY_TOOL_NAME,
    {
      description: CHECK_AVAILABILITY_TOOL_DESCRIPTION,
      inputSchema: checkAvailabilityInputSchema.shape,
    },
    async (input: CheckAvailabilityInput) => {
      const result = await logToolCall(CHECK_AVAILABILITY_TOOL_NAME, ctx.requestId, { service: input.service, date: input.date, cursor: input.cursor, limit: input.limit ?? DEFAULT_PAGE_SIZE }, (report) =>
        runCheckAvailability(input, ctx, report),
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );
}
