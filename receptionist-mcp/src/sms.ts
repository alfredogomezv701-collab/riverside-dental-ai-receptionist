/**
 * Appointment-confirmation SMS via Telnyx's Messaging API. Best-effort: a failure here must never
 * fail the booking itself (the appointment is already real by the time this runs) — the caller
 * swallows errors and just logs them. Needs TELNYX_API_KEY (a real Telnyx API call, unlike every
 * other secret this project uses, which are our own bearer tokens between our own functions) and
 * CLINIC_SMS_FROM_NUMBER (a Telnyx number with a messaging profile attached — a voice-only number
 * returns a clear error from this endpoint, not a silent failure).
 */

export interface BookingConfirmationDetails {
  patientName: string;
  service: string;
  date: string;
  start: string;
}

function formatConfirmationText(details: BookingConfirmationDetails): string {
  return `Riverside Dental: Hi ${details.patientName}, your ${details.service} appointment is confirmed for ${details.date} at ${details.start}. Reply or call us if you need to change it.`;
}

/**
 * Sends the SMS; resolves `true`/`false` rather than throwing on a non-2xx Telnyx response, so a
 * caller can log without needing its own try/catch for the "API said no" case (a thrown error is
 * still possible for network-level failures — callers should catch regardless).
 */
export async function sendBookingConfirmationSms(
  apiKey: string,
  fromNumber: string,
  toPhone: string,
  details: BookingConfirmationDetails,
): Promise<{ sent: boolean; messageId?: string; error?: string }> {
  const res = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: fromNumber, to: toPhone, text: formatConfirmationText(details) }),
  });
  const body = (await res.json().catch(() => undefined)) as { data?: { id?: string }; errors?: { detail?: string }[] } | undefined;
  if (!res.ok) {
    return { sent: false, error: body?.errors?.[0]?.detail ?? `HTTP ${res.status}` };
  }
  return { sent: true, messageId: body?.data?.id };
}
