/** The security header set of spec section 6, sent on every response (including 304, 4xx, SSE). */
import type { ServerResponse } from "node:http";

const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'";

export function securityHeaders(): Record<string, string> {
  return {
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Cache-Control": "no-store",
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  };
}

/** Set every security header on `res` (before writeHead, so no code path can skip them). */
export function applyHeaders(res: ServerResponse): void {
  for (const [k, v] of Object.entries(securityHeaders())) res.setHeader(k, v);
}
