import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KvNamespace } from '@telnyx/edge-runtime';
import { dateProblem, findConflict, KNOWN_SERVICES, loadDayBookings, slotGrid, SERVICE_DURATION_MINUTES } from '../calendar.js';
import { logToolCall } from '../log.js';
import {
  CHECK_AVAILABILITY_TOOL_NAME,
  CHECK_AVAILABILITY_TOOL_DESCRIPTION,
  checkAvailabilityInputSchema,
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
 * The grid for the service minus everything already booked that day. Deliberately NOT cached: a
 * cached answer goes stale the moment someone books, which is exactly when the next caller asks.
 * Costs one KV list plus the day's booking reads (issued together) per call.
 */
export async function runCheckAvailability(
  input: CheckAvailabilityInput,
  ctx: ToolContext,
): Promise<CheckAvailabilityResult> {
  if (!SERVICE_DURATION_MINUTES[input.service]) {
    return { service: input.service, date: input.date, slots: [], note: `unknown service; use one of: ${KNOWN_SERVICES.join(', ')}` };
  }
  const bad = dateProblem(input.date, ctx.today);
  if (bad) return { service: input.service, date: input.date, slots: [], note: bad };

  const booked = ctx.kv ? await loadDayBookings(ctx.kv, input.date) : [];
  const slots = slotGrid(input.service, input.date).map((s) => ({
    ...s,
    available: s.available && !findConflict({ service: input.service, start: s.start }, booked),
  }));
  return { service: input.service, date: input.date, slots };
}

export function registerCheckAvailability(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    CHECK_AVAILABILITY_TOOL_NAME,
    {
      description: CHECK_AVAILABILITY_TOOL_DESCRIPTION,
      inputSchema: checkAvailabilityInputSchema.shape,
    },
    async (input: CheckAvailabilityInput) => {
      const result = await logToolCall(CHECK_AVAILABILITY_TOOL_NAME, ctx.requestId, { service: input.service, date: input.date }, () =>
        runCheckAvailability(input, ctx),
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
