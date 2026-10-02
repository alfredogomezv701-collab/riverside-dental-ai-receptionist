import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KvNamespace } from '@telnyx/edge-runtime';
import { logToolCall } from '../log.js';
import { dateProblem } from '../calendar.js';
import {
  JOIN_WAITLIST_TOOL_NAME,
  JOIN_WAITLIST_TOOL_DESCRIPTION,
  joinWaitlistInputSchema,
  WAITLIST_KEY,
  type JoinWaitlistInput,
  type JoinWaitlistResult,
  type WaitlistEntry,
} from './join_waitlist.js';
import { digitsOf } from '../patients.js';

export interface ToolContext {
  kv: KvNamespace | undefined;
  requestId?: string;
  /** Clinic-local "today" (YYYY-MM-DD); injectable so tests don't rot as the calendar moves. */
  today?: string;
}

const samePhone = (a: string, b: string) => digitsOf(a).slice(-10) === digitsOf(b).slice(-10);

export async function runJoinWaitlist(
  input: JoinWaitlistInput,
  ctx: ToolContext,
): Promise<JoinWaitlistResult> {
  // Reject a bad date up front so we never persist a waitlist entry for a day nobody can ever be
  // booked into (past date, weekend, junk). The service is accepted as-is because the waitlist is
  // a free-form request, not a booked slot; if the service name is bogus the team will catch it.
  const bad = dateProblem(input.date, ctx.today);
  if (bad) return { queued: false };

  if (!ctx.kv) {
    // No KV bound (local dev without env.CACHE): cannot persist, so do not claim to.
    return { queued: false };
  }
  const kv = ctx.kv;
  const key = WAITLIST_KEY(input.date, input.patientPhone);

  // Idempotent retry: if the same caller is already on the waitlist for this date, return the
  // existing entry — not a duplicate, and not "we lost your request". (The model retries on flaky
  // turns; a second join_waitlist for the same phone+date must be a no-op, not a second row.)
  const existing = await kv.get<WaitlistEntry>(key, { type: 'json' });
  if (existing && samePhone(existing.patientPhone, input.patientPhone)) {
    return { queued: true, alreadyQueuedByYou: true, entry: existing };
  }

  const entry: WaitlistEntry = {
    entryId: crypto.randomUUID(),
    date: input.date,
    service: input.service,
    patientName: input.patientName,
    patientPhone: input.patientPhone,
    joinedAt: new Date().toISOString(),
  };

  try {
    await kv.put(key, JSON.stringify(entry));
  } catch (err) {
    // KV write failed: do not tell the caller they were queued.
    throw err;
  }

  return { queued: true, entry };
}

export function registerJoinWaitlist(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    JOIN_WAITLIST_TOOL_NAME,
    {
      description: JOIN_WAITLIST_TOOL_DESCRIPTION,
      inputSchema: joinWaitlistInputSchema.shape,
    },
    async (input: JoinWaitlistInput) => {
      const result = await logToolCall(JOIN_WAITLIST_TOOL_NAME, ctx.requestId, { caller: input.patientPhone }, () =>
        runJoinWaitlist(input, ctx),
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
