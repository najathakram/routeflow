/**
 * The ONE place that decides the public web base (the dashboard origin) for every link the API hands to a person or to
 * Stripe: Checkout success and cancel URLs, billing-portal returns, verification and welcome emails.
 *
 * Why it exists: billing used `process.env.FRONTEND_URL ?? "http://localhost:3001"` while the rest of the app read
 * WEB_URL. Production had only WEB_URL, so a live tenant who paid through Checkout was sent to localhost. A silent
 * localhost default is acceptable on a developer machine and never in production, so:
 *   - WEB_URL wins, then FRONTEND_URL (the legacy name);
 *   - outside production the local default stays;
 *   - in production a missing, loopback or non-http(s) value THROWS (at boot via `assertWebBaseUrlAtBoot`, and again at
 *     any call site), it never defaults.
 */
const LOCAL_DEFAULT = "http://localhost:3001";

const isLoopbackHost = (host: string): boolean => {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "127.0.0.1" ||
    h.startsWith("127.") ||
    h === "0.0.0.0" ||
    h === "::1" ||
    h === "::"
  );
};

export function webBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = [env.WEB_URL, env.FRONTEND_URL].map((v) => (v ?? "").trim()).find((v) => v !== "");
  const production = env.NODE_ENV === "production";
  if (!raw) {
    if (production) {
      throw new Error(
        "WEB_URL must be set in production (the public web origin, e.g. https://www.example.com); FRONTEND_URL is accepted as a legacy name. Billing, email and OAuth links are never built on a localhost default.",
      );
    }
    return LOCAL_DEFAULT;
  }
  const base = raw.replace(/\/+$/, "");
  if (production) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(base);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      throw new Error(`WEB_URL must be an absolute http(s) URL in production (got "${raw}").`);
    }
    if (isLoopbackHost(parsed.hostname)) {
      throw new Error(
        `WEB_URL points at localhost/loopback ("${raw}") in production: links would send people to a dead address.`,
      );
    }
  }
  return base;
}

/**
 * Boot check: resolve the base once (throws in production when it is missing or loopback) and export it into WEB_URL, so
 * every reader of `WEB_URL` (ConfigService, `process.env`) sees the same value even when only the legacy FRONTEND_URL is set.
 */
export function assertWebBaseUrlAtBoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = webBaseUrl(env);
  if (env.NODE_ENV === "production") env.WEB_URL = base;
  return base;
}
