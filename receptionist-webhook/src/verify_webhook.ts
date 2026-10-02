/**
 * Verify Telnyx webhook Ed25519 signature.
 *
 * Telnyx signs webhook POST requests with:
 *   - Header `telnyx-signature-ed25519`: hex-encoded Ed25519 signature
 *   - Header `telnyx-timestamp`: Unix timestamp (seconds) as a string
 *
 * The signed payload is: `<timestamp>.<raw_body>`
 *
 * We use WebCrypto (subtle.verify with Ed25519) so this works in both the
 * Telnyx Edge runtime and in Node test runners (Node >= 18 supports Ed25519).
 *
 * The public key is supplied as a PEM/SPKI string; we import it once and cache
 * the CryptoKey. A missing or malformed public key causes verification to fail
 * closed (return false).
 */

const KEY_CACHE = new Map<string, CryptoKey>();

const ED25519_SIGNATURE_HEX_LENGTH = 128; // 64 bytes

function hexToBuf(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes.buffer;
}

function pemToDer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function importPublicKey(pem: string): Promise<CryptoKey | undefined> {
  const cached = KEY_CACHE.get(pem);
  if (cached) return cached;
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      pemToDer(pem),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    KEY_CACHE.set(pem, key);
    return key;
  } catch {
    return undefined;
  }
}

export interface VerifyResult {
  valid: boolean;
  reason?: 'missing_headers' | 'stale' | 'invalid_signature' | 'no_key';
}

/**
 * Verify a Telnyx webhook Ed25519 signature.
 *
 * @param publicKeyPem - Public key in PEM/SPKI format (e.g. from TELNYX_WEBHOOK_PUBLIC_KEY secret)
 * @param body         - Raw request body (ArrayBuffer or Uint8Array)
 * @param signatureHex - Value of `telnyx-signature-ed25519` header
 * @param timestampSec - Value of `telnyx-timestamp` header
 * @param maxAgeMs     - Maximum age of the timestamp before rejecting as stale (default 5 minutes)
 */
export async function verifyTelnyxWebhook(
  publicKeyPem: string,
  body: ArrayBuffer | Uint8Array,
  signatureHex: string | null,
  timestampSec: string | null,
  maxAgeMs: number = 5 * 60 * 1000,
): Promise<VerifyResult> {
  if (!signatureHex || !timestampSec) {
    return { valid: false, reason: 'missing_headers' };
  }

  if (!/^[0-9a-fA-F]+$/.test(signatureHex) || signatureHex.length !== ED25519_SIGNATURE_HEX_LENGTH) {
    return { valid: false, reason: 'invalid_signature' };
  }

  const ts = parseInt(timestampSec, 10);
  if (!Number.isFinite(ts)) {
    return { valid: false, reason: 'missing_headers' };
  }

  const nowMs = Date.now();
  const tsMs = ts * 1000;
  const FUTURE_TOLERANCE_MS = 60_000;
  if (nowMs - tsMs > maxAgeMs || tsMs > nowMs + FUTURE_TOLERANCE_MS) {
    return { valid: false, reason: 'stale' };
  }

  const key = await importPublicKey(publicKeyPem);
  if (!key) {
    return { valid: false, reason: 'no_key' };
  }

  const payloadBytes = new TextEncoder().encode(`${timestampSec}.`);
  const bodyBytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
  const signedData = new Uint8Array(payloadBytes.length + bodyBytes.length);
  signedData.set(payloadBytes, 0);
  signedData.set(bodyBytes, payloadBytes.length);

  let signature: ArrayBuffer;
  try {
    signature = hexToBuf(signatureHex);
    if (signature.byteLength !== 64) {
      return { valid: false, reason: 'invalid_signature' };
    }
  } catch {
    return { valid: false, reason: 'invalid_signature' };
  }

  try {
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, signedData.buffer);
    if (!ok) return { valid: false, reason: 'invalid_signature' };
    return { valid: true };
  } catch {
    return { valid: false, reason: 'invalid_signature' };
  }
}
