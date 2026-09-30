import { createHash, timingSafeEqual } from 'node:crypto';

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/**
 * Constant-time check of an `Authorization: Bearer <secret>` header. Both sides are hashed first so
 * timingSafeEqual always compares equal-length buffers (no length leak), and an empty/missing secret
 * never matches anything - callers must treat "no secret configured" as a hard failure, not a bypass.
 */
export function bearerMatches(header: string | undefined, secret: string | undefined): boolean {
  if (!secret) return false;
  return timingSafeEqual(sha256(header ?? ''), sha256(`Bearer ${secret}`));
}
