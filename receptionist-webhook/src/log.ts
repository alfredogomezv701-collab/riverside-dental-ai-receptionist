/** One JSON line per event; `telnyx-edge logs --type runtime` shows these. */
export function logEvent(
  fields: { request_id: string; route: string; outcome: string } & Record<string, unknown>,
  sink: (line: string) => void = console.log,
): void {
  sink(JSON.stringify({ ts: new Date().toISOString(), service: 'receptionist-webhook', ...fields }));
}

/** Error text can embed a KV key such as patient/5551234567; never let full phone digits reach the logs. */
export const redact = (text: string): string => text.replace(/\d{7,}/g, '***');

/** Masks all but the last 4 digits so logs can correlate callers without storing full numbers. */
export function maskPhone(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 4 ? '****' : `***${digits.slice(-4)}`;
}
