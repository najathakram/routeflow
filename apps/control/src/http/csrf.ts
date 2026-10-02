/** Per-session CSRF token (derived from the session nonce) and the write-back request check. */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const b64 = (b: Buffer): string => b.toString("base64url");

/** Constant-time string equality (length is not secret). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const csrfFor = (secret: string, nonce: string): string =>
  b64(createHmac("sha256", secret).update(`csrf:${nonce}`).digest());

/** 0 = ok; 401 no session; 403 bad Origin or token; 415 not JSON. Checked in that order. */
export function checkWrite(
  req: Pick<IncomingMessage, "headers">,
  session: { nonce: string } | null,
  servedOrigin: string,
  secret: string,
): 0 | 401 | 403 | 415 {
  if (!session) return 401;
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !safeEqual(origin, servedOrigin)) return 403;
  const token = req.headers["x-control-token"];
  if (typeof token !== "string" || !safeEqual(token, csrfFor(secret, session.nonce))) return 403;
  const ct = req.headers["content-type"];
  if (!/^application\/json\b/.test(typeof ct === "string" ? ct : "")) return 415;
  return 0;
}
