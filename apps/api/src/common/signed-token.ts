import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed bearer tokens for link-style access (demo-booking manage links, onboarding intake
 * links). Shape: `<random>.<hmac>`.
 *
 * - The HMAC lets an obviously forged token be rejected WITHOUT a database round trip
 *   (`verifySignedToken` is pure).
 * - Only `hashSignedToken(token)` (SHA-256 of the WHOLE token) is ever stored, so a database
 *   read alone can never act on anyone's behalf.
 * - Comparison is constant-time.
 *
 * Callers pass their own secret — each surface has its own (DEMO_BOOKING_TOKEN_SECRET,
 * ONBOARDING_TOKEN_SECRET), so a leaked secret for one never forges the other.
 */
export function mintSignedToken(secret: string): string {
  assertSecret(secret);
  const nonce = randomBytes(24).toString("base64url");
  return `${nonce}.${sign(nonce, secret)}`;
}

export function verifySignedToken(token: string, secret: string): boolean {
  if (typeof token !== "string" || !secret) return false;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return false;
  const nonce = token.slice(0, separator);
  const provided = Buffer.from(token.slice(separator + 1));
  const expected = Buffer.from(sign(nonce, secret));
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export function hashSignedToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sign(nonce: string, secret: string): string {
  return createHmac("sha256", secret).update(nonce).digest("base64url");
}

function assertSecret(secret: string): void {
  if (!secret || secret.length < 16) {
    throw new Error("signed-token: refusing to mint with a missing or short (< 16 chars) secret");
  }
}
