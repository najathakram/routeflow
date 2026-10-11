/**
 * What the Redis `oauth:nonce:<nonce>` entry holds for a Google sign-in.
 *
 * The signed `state` that travels through the browser carries only the nonce (a reference). Anything
 * secret that the callback needs, such as an invite token, is kept here, server-side, next to the
 * hash that binds the nonce to its payload.
 *
 * - No secret: the bare payload hash (the original format, still read and still written).
 * - With a secret: a small JSON object `{ h, i }`.
 */
export interface NonceValue {
  payloadHash: string;
  inviteSecret?: string;
}

export function encodeNonceValue(payloadHash: string, inviteSecret?: string): string {
  return inviteSecret ? JSON.stringify({ h: payloadHash, i: inviteSecret }) : payloadHash;
}

export function decodeNonceValue(stored: string): NonceValue {
  if (!stored.startsWith("{")) return { payloadHash: stored };
  try {
    const parsed = JSON.parse(stored) as { h?: unknown; i?: unknown };
    if (typeof parsed.h !== "string") return { payloadHash: "" };
    return {
      payloadHash: parsed.h,
      ...(typeof parsed.i === "string" && parsed.i ? { inviteSecret: parsed.i } : {}),
    };
  } catch {
    // Unreadable: an empty hash can never equal the presented one, so the callback fails closed.
    return { payloadHash: "" };
  }
}
