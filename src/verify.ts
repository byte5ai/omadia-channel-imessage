import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Timing-safe string equality. Both inputs are SHA-256-hashed first so
 * `timingSafeEqual` always compares equal-length buffers (it throws on
 * length mismatch) and so the comparison time leaks nothing about how many
 * leading characters matched.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/** Header bag as Express exposes it (lower-cased names). */
export type HeaderBag = Record<string, string | string[] | number | undefined>;

/**
 * Verify an inbound Sendblue webhook request.
 *
 * Sendblue has NO HMAC signing — it can only send a configured plaintext
 * secret in a request header whose exact name is undocumented. Strategy:
 *
 *  1. The webhook path carries the secret as its last segment
 *     (`POST /api/imessage/webhook/:token`) — a token match alone is
 *     sufficient.
 *  2. Additionally accept the request if ANY header VALUE equals the secret
 *     (covers the undocumented Sendblue header, future-proof).
 *
 * All comparisons are timing-safe (see {@link safeEqual}).
 */
export function verifyWebhookAuth(
  secret: string,
  token: string | undefined,
  headers: HeaderBag,
): boolean {
  if (secret.length === 0) return false;
  if (typeof token === 'string' && token.length > 0 && safeEqual(token, secret)) {
    return true;
  }
  for (const value of Object.values(headers)) {
    if (typeof value === 'string') {
      if (safeEqual(value, secret)) return true;
    } else if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === 'string' && safeEqual(v, secret)) return true;
      }
    }
  }
  return false;
}
