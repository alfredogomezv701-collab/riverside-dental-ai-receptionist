/**
 * One JSON line per MCP tool call, correlated by request_id with the webhook's /actor/* log lines
 * (the id is generated per /mcp request in index.ts and forwarded as x-request-id to the actor
 * proxy), so a single booking can be traced MCP -> webhook -> actor from logs alone.
 */
export const maskPhone = (phone: string | undefined): string | undefined => {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 4 ? '****' : `***${digits.slice(-4)}`;
};

interface Outcomeful {
  confirmed?: boolean;
  success?: boolean;
  reason?: string;
  cached?: boolean;
}

/** Error text can embed a KV key such as patient/5551234567; never let full phone digits reach the logs. */
export const redact = (text: string): string => text.replace(/\d{7,}/g, '***');

export const outcomeOf = (r: unknown): string => {
  const x = (r ?? {}) as Outcomeful;
  if (x.reason) return x.reason;
  if (x.confirmed === true || x.success === true) return 'ok';
  if (x.confirmed === false || x.success === false) return 'rejected';
  return 'ok';
};

/** Lets a wrapped tool call attach extra fields (e.g. a KV-read count/timing breakdown) to its own
 *  log line, reported during execution rather than known upfront. Optional — existing zero-arg
 *  callers are unaffected (JS/TS both allow a `() => Promise<T>` where `(report) => Promise<T>` is
 *  expected; the extra parameter is simply never passed to them). */
export type ReportExtra = (extra: Record<string, unknown>) => void;

export async function logToolCall<T>(
  tool: string,
  requestId: string | undefined,
  fields: { caller?: string } & Record<string, unknown>,
  fn: (report: ReportExtra) => Promise<T>,
  sink: (line: string) => void = console.log,
): Promise<T> {
  const started = Date.now();
  const { caller, ...rest } = fields;
  let extra: Record<string, unknown> = {};
  const report: ReportExtra = (fields) => {
    extra = { ...extra, ...fields };
  };
  const base = () => ({ ts: new Date().toISOString(), service: 'receptionist-mcp', request_id: requestId, tool, caller: maskPhone(caller), ...rest, ...extra });
  try {
    const result = await fn(report);
    sink(JSON.stringify({ ...base(), outcome: outcomeOf(result), latency_ms: Date.now() - started }));
    return result;
  } catch (err) {
    sink(JSON.stringify({ ...base(), outcome: 'error', error: redact(err instanceof Error ? err.message : String(err)), latency_ms: Date.now() - started }));
    throw err;
  }
}
