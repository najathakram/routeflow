import { isLoopbackHost, webBaseUrl } from "./web-base-url";

/**
 * WP2A.0: the EXTRA web origins the app is also served on, beside the one web base (`WEB_URL`, see web-base-url.ts).
 *
 * `WEB_ORIGINS` is a comma-separated list of origins (e.g. `https://www.example.com,https://app.example.com`). It is
 * empty by default, and an empty list changes nothing anywhere: every helper below then returns exactly what the code
 * returned before WP2A.0.
 *
 * What the list allows, and nothing more:
 *   - a Google sign-in (tenant and platform), a Google account link, a mailbox connect and a Stripe Connect link that
 *     STARTED on one of these origins returns to that origin instead of `WEB_URL`;
 *   - a subscription checkout, the billing portal, the catch-up payment and a buyer card payment started on one of
 *     these origins return there;
 *   - an open catch-up Checkout session whose return URL is on one of these origins is not expired as "off base".
 * Links in emails and every other out-of-session link keep `WEB_URL`.
 *
 * Matching is EXACT (`===`) on the normalized origin (scheme + host + port, as `new URL(x).origin` prints it) — never a
 * prefix, suffix or wildcard match, so `https://www.example.com.evil.test` never matches `https://www.example.com`.
 * The candidate is typically the browser's `Origin` request header. A non-browser caller can forge that header, but it
 * can only ever pick another origin from this same list.
 *
 * Parsed like `webBaseUrl()`: each entry is trimmed and loses a trailing `/`; a blank entry is skipped. An entry that
 * is not an absolute http(s) URL, or (in production) points at localhost/loopback, THROWS in production (the config
 * module evaluates this at boot, so a typo fails the deploy loudly instead of silently expiring payers' sessions) and
 * is dropped outside production.
 */

/** Canonicalize an origin through the URL parser (`https://Example.com:443/x` → `https://example.com`). */
export function normalizeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function parseWebOrigins(raw: string | undefined, nodeEnv: string | undefined): string[] {
  const production = nodeEnv === "production";
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const entry = part.trim().replace(/\/+$/, "");
    if (entry === "") continue;
    let parsed: URL | null = null;
    try {
      parsed = new URL(entry);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      if (production) {
        throw new Error(
          `WEB_ORIGINS entry "${entry}" must be an absolute http(s) origin in production (e.g. https://www.example.com).`,
        );
      }
      continue;
    }
    if (production && isLoopbackHost(parsed.hostname)) {
      throw new Error(
        `WEB_ORIGINS entry "${entry}" points at localhost/loopback in production: links would send people to a dead address.`,
      );
    }
    const origin = normalizeOrigin(entry);
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

/** The parsed `WEB_ORIGINS` list (empty by default). */
export function extraWebOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseWebOrigins(env.WEB_ORIGINS, env.NODE_ENV);
}

/**
 * `candidate` when it is a string EXACTLY equal (`===`) to one of `origins`; otherwise `fallback`. Never logs (the
 * candidate is usually an `Origin` header, and a request from `WEB_URL` itself or a business sub-domain is normal).
 */
export function pickFromOrigins(
  candidate: unknown,
  origins: readonly string[],
  fallback: string,
): string {
  return typeof candidate === "string" && origins.includes(candidate) ? candidate : fallback;
}

/** `pickFromOrigins` against the `WEB_ORIGINS` list read now. */
export function pickWebOrigin(
  candidate: unknown,
  fallback: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return pickFromOrigins(candidate, extraWebOrigins(env), fallback);
}

/**
 * The base a payment return URL is built on: the request's own origin when it is on the `WEB_ORIGINS` list, else
 * `webBaseUrl()` (unchanged from before WP2A.0).
 */
export function webReturnBase(candidate: unknown, env: NodeJS.ProcessEnv = process.env): string {
  return pickWebOrigin(candidate, webBaseUrl(env), env);
}

/**
 * True when `url` is on the web base or on one of the `WEB_ORIGINS`: for each allowed base `o`, `url === o` or
 * `url.startsWith(o + "/")` — the same form the catch-up off-base guard always used for the single base.
 */
export function isOnAllowedWebBase(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const bases = [webBaseUrl(env), ...extraWebOrigins(env)];
  return bases.some((o) => url === o || url.startsWith(`${o}/`));
}
