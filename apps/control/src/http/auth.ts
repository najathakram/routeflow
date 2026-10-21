/** Password hash, signed session cookie, login page. Constant-time compares throughout. */
import { createHmac, scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { esc } from "../render/esc";

const b64 = (b: Buffer): string => b.toString("base64url");

export function hashPassword(
  pw: string,
  salt: Buffer = randomBytes(16),
): { salt: Buffer; hash: Buffer } {
  return { salt, hash: scryptSync(pw, salt, 32) };
}

export function verifyPassword(pw: string, h: { salt: Buffer; hash: Buffer }): boolean {
  const c = scryptSync(pw, h.salt, 32);
  return c.length === h.hash.length && timingSafeEqual(c, h.hash);
}

export interface Session {
  iat: number;
  exp: number;
  nonce: string;
}

export function signSession(secret: string, now: number): string {
  const payload = b64(
    Buffer.from(JSON.stringify({ iat: now, exp: now + 12 * 3600_000, nonce: b64(randomBytes(8)) })),
  );
  return `${payload}.${b64(createHmac("sha256", secret).update(payload).digest())}`;
}

export function readSession(
  secret: string,
  cookie: string | undefined,
  now: number,
): Session | null {
  const parts = (cookie ?? "").split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;
  const want = b64(createHmac("sha256", secret).update(payload).digest());
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) {
    return null;
  }
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as Partial<Session>;
    if (typeof s.exp !== "number" || typeof s.iat !== "number" || typeof s.nonce !== "string") {
      return null;
    }
    return s.exp > now ? (s as Session) : null;
  } catch {
    return null;
  }
}

export const COOKIE = (v: string, secure: boolean): string =>
  `ctl_session=${v}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Strict; Path=/; Max-Age=43200`;

export const CLEAR_COOKIE = (secure: boolean): string =>
  `ctl_session=; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Strict; Path=/; Max-Age=0`;

const COOKIE_VALUE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The `ctl_session` cookie value of a request, or undefined (malformed values are dropped). */
export function sessionCookie(req: IncomingMessage): string | undefined {
  const raw = req.headers.cookie;
  if (typeof raw !== "string") return undefined;
  for (const part of raw.split(";")) {
    const p = part.trim();
    if (p.startsWith("ctl_session=")) {
      const v = p.slice("ctl_session=".length);
      return COOKIE_VALUE.test(v) ? v : undefined;
    }
  }
  return undefined;
}

/** The login page: no inline script, no inline handlers; the stylesheet is the same-origin asset. */
export function loginPage(error: string | null): string {
  const msg = error ? `<p class="err" role="alert">${esc(error)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<title>RouteFlow Control: sign in</title>
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
<main class="login" style="max-width:22rem;margin:12vh auto;padding:0 1rem">
<h1>RouteFlow Control</h1>
${msg}
<form method="post" action="/login">
<p><label for="pw">Password</label><br>
<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus style="width:100%"></p>
<p><button type="submit" class="btn">Sign in</button></p>
</form>
</main>
</body>
</html>
`;
}
