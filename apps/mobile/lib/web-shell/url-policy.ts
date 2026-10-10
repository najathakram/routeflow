/**
 * #2653 — which navigations the hybrid WebShell may load in-app. Pure (no RN imports) and
 * Jest-pinned. The WebView loads ONLY the RouteFlow web origin; every other http(s) URL goes to the
 * system browser; everything else (file:, javascript:, data:, intent:, a custom scheme…) is
 * refused outright, so a page can never reach the device's files or run a scheme handler through
 * the shell.
 */

export type NavigationDecision = "load" | "external" | "block";

/** Normalised `scheme://host[:port]` of a URL, or null when it is not a parsable http(s) URL. */
export function httpOrigin(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return u.origin.toLowerCase();
}

/** http://localhost, loopback, the Android emulator host, or an RFC 1918 private address. */
export function isLocalHttpOrigin(origin: string): boolean {
  const m = /^http:\/\/([^/:]+)(:\d+)?$/.exec(origin);
  if (!m) return false;
  const host = m[1]!;
  if (host === "localhost" || host === "127.0.0.1" || host === "10.0.2.2") return true;
  const oct = host.split(".").map(Number);
  if (oct.length !== 4 || oct.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = oct as [number, number, number, number];
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * The origins the shell may load. Only the web base URL's own origin (and optional extras, e.g.
 * the API origin if the Q1 handoff needs it). An unparsable or non-https base yields an empty
 * list — callers treat that as "shell off" rather than loading anything.
 */
export function allowedOrigins(webBaseUrl: string, extra: readonly string[] = []): string[] {
  return [webBaseUrl, ...extra]
    .map((u) => {
      const o = httpOrigin(u);
      // Store shells load https only; plain http is tolerated for a local / private-LAN dev host
      // alone (the development and preview EAS profiles point at a LAN web, see eas.json).
      if (!o) return null;
      if (o.startsWith("https://")) return o;
      return isLocalHttpOrigin(o) ? o : null;
    })
    .filter((o): o is string => o !== null);
}

/**
 * `isTopFrame` is false for iframe loads. An iframe on an allowlisted page may load its own
 * sub-resources (the web embeds nothing cross-origin today, so a non-allowlisted iframe is blocked,
 * never bounced out to the browser behind the user's back).
 */
export function classifyNavigation(
  url: string,
  allowed: readonly string[],
  opts: { isTopFrame?: boolean } = {},
): NavigationDecision {
  const isTopFrame = opts.isTopFrame ?? true;
  if (url === "about:blank") return "load"; // WebView's own initial document
  const origin = httpOrigin(url);
  if (!origin) return "block";
  if (allowed.includes(origin)) return "load";
  return isTopFrame ? "external" : "block";
}
