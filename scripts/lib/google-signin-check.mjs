/**
 * Google sign-in reachability check (dev-pipeline WP1, 2026-09-11-google-signin-monitor,
 * OPS-23/DECIDE-29). Pure — no process.exit, no console — the caller (smoke.mjs,
 * post-deploy-check.mjs, google-signin-monitor.mjs) prints and decides exit codes.
 *
 * checkGoogleSignIn probes both Google OAuth "doors" (platform-admin and tenant) by
 * fetching the API's redirect endpoint, then following the consent URL it returns with one
 * unauthenticated GET. It never signs in and never touches Google credentials/cookies.
 *
 * checkApexDns is a separate, unrelated DNS reachability check for the apex domain
 * (DECIDE-29 item) — kept in this module because both feed the same post-deploy report
 * sections and the same monitor script.
 */

import { lookup as dnsLookup } from "node:dns/promises";

export const ERROR_MARKERS = [
  "deleted_client",
  "invalid_client",
  "redirect_uri_mismatch",
  "access_denied",
  "restricted to the test users",
  "Access blocked",
];

/**
 * Marker -> reason name. A marker absent from this map (currently only "Access blocked")
 * still fails, but on the catch-all oauth_error reason.
 */
const MARKER_REASONS = new Map([
  ["deleted_client", "deleted_client"],
  ["invalid_client", "invalid_client"],
  ["redirect_uri_mismatch", "redirect_uri_mismatch"],
  ["access_denied", "access_denied"],
  // Google's Testing-audience refusal wording — same triage branch as access_denied.
  ["restricted to the test users", "access_denied"],
]);

/**
 * The body scan is only a FALLBACK. Google's real /signin/oauth/error document is ~800 KB
 * and carries no marker inside the first 64 KB, so the authoritative signal is the
 * base64url `authError` query parameter (see decodeAuthError) — the cap stays at 64 KB
 * deliberately rather than growing to chase a marker that sits ~700 KB in.
 */
const MAX_BODY_BYTES = 64 * 1024;

/** Final pathnames that positively identify a live Google sign-in/consent surface (D2). */
const OK_PATH_PREFIXES = [
  "/o/oauth2/",
  "/signin/oauth/",
  "/v3/signin/",
  "/AccountChooser",
  "/ServiceLogin",
];

/** Body strings that positively identify a live account chooser / sign-in form (D2). */
const OK_BODY_MARKERS = ["Choose an account", "identifier"];

/**
 * Returns the scannable text carried by a final URL's error parameters: for each
 * `authError`/`error` value, the raw value plus its base64url decoding (Google encodes a
 * protobuf-ish blob whose first field is the error name, e.g. "deleted_client"). Returns ""
 * for an unparseable URL or when no such parameter is present; never throws.
 */
export function decodeAuthError(url) {
  let params;
  try {
    params = new URL(url).searchParams;
  } catch {
    return "";
  }
  const parts = [];
  for (const key of ["authError", "error"]) {
    for (const value of params.getAll(key)) {
      if (!value) continue;
      parts.push(value);
      try {
        parts.push(
          Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1"),
        );
      } catch {
        // Not base64url — the raw value above is still scanned.
      }
    }
  }
  return parts.join("\n");
}

export const DOORS = (tenant) => [
  { name: "platform-admin", path: "/api/v1/platform-admin/auth/google" },
  { name: "tenant", path: `/api/v1/auth/google?tenant=${encodeURIComponent(tenant)}` },
];

/**
 * Default `required` for checkGoogleSignIn: true unless the base URL host is
 * localhost/127.0.0.1 (local compose has no Google client configured), overridable via
 * SMOKE_GOOGLE_REQUIRED=0/1.
 */
export function resolveRequired(baseUrl, envValue) {
  if (envValue === "1") return true;
  if (envValue === "0") return false;
  try {
    const { hostname } = new URL(baseUrl);
    if (hostname === "localhost" || hostname === "127.0.0.1") return false;
  } catch {
    // Unparseable base URL: fall through to the safe default (required).
  }
  return true;
}

/** Default `required` for checkApexDns: not required unless SMOKE_APEX_REQUIRED=1. */
export function resolveApexRequired(envValue) {
  return envValue === "1";
}

const classifyFetchError = (err) => (err?.name === "AbortError" ? "timeout" : "network");

/** Reads up to MAX_BODY_BYTES of a Response body as text; falls back to res.text(). */
async function readBodyLimited(res, limit = MAX_BODY_BYTES) {
  if (!res.body || typeof res.body.getReader !== "function") {
    return res.text();
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best-effort cleanup only
    }
  }
  return text;
}

async function probeDoor({ baseUrl, door, fetchImpl, expectedHost, required, signal }) {
  const { name, path } = door;

  let doorRes;
  try {
    doorRes = await fetchImpl(`${baseUrl}${path}`, { signal });
  } catch (err) {
    return { name, status: "fail", reason: classifyFetchError(err) };
  }

  if (doorRes.status === 503) {
    return required
      ? { name, status: "fail", reason: "not_configured" }
      : { name, status: "skipped", reason: "not_configured" };
  }

  let body = null;
  if (doorRes.ok) {
    try {
      body = await doorRes.json();
    } catch (err) {
      // Only a COMPLETE but unusable 2xx body may fall through to door_http_<status>.
      // A timeout or transport failure while reading it is a timeout/network failure.
      if (err?.name !== "SyntaxError") {
        return { name, status: "fail", reason: classifyFetchError(err) };
      }
      body = null;
    }
  }

  if (!doorRes.ok || !body?.url) {
    return { name, status: "fail", reason: `door_http_${doorRes.status}` };
  }

  let consentRes;
  try {
    consentRes = await fetchImpl(body.url, { signal, redirect: "follow" });
  } catch (err) {
    return { name, status: "fail", reason: classifyFetchError(err) };
  }

  const finalUrl = consentRes.url;
  let hostname = "";
  let pathname = "";
  let search = "";
  let finalPage = finalUrl;
  try {
    const parsed = new URL(finalUrl);
    hostname = parsed.hostname;
    pathname = parsed.pathname;
    search = parsed.search;
    // Logged form (D4): origin + pathname only — the query carries the client id and state.
    finalPage = `${parsed.origin}${parsed.pathname}`;
  } catch {
    // finalUrl unparseable — hostname check below fails closed as wrong_host.
  }

  // Host check happens BEFORE the body is read (R2).
  if (!hostname.endsWith(expectedHost)) {
    return { name, status: "fail", reason: "wrong_host", finalUrl, finalPage };
  }

  // URL-first classification (D1): the decoded authError parameter is the only place the
  // real error page names its cause within a bounded read.
  const urlHaystack = `${search}\n${decodeAuthError(finalUrl)}`;
  const urlMarker = ERROR_MARKERS.find((m) => urlHaystack.includes(m));
  if (urlMarker && MARKER_REASONS.has(urlMarker)) {
    return { name, status: "fail", reason: MARKER_REASONS.get(urlMarker), finalUrl, finalPage };
  }

  let bodyText;
  try {
    bodyText = await readBodyLimited(consentRes);
  } catch (err) {
    // The shared abort firing mid-body (or a socket reset) must not reject out of
    // checkGoogleSignIn — that would discard the other door's result too. Keep finalUrl:
    // the host check above already passed.
    return { name, status: "fail", reason: classifyFetchError(err), finalUrl, finalPage };
  }
  // urlMarker can only be an UNNAMED marker here (a named one returned above), so a named
  // body marker still wins over it.
  const marker = ERROR_MARKERS.find((m) => bodyText.includes(m)) ?? urlMarker;

  if (marker && MARKER_REASONS.has(marker)) {
    return { name, status: "fail", reason: MARKER_REASONS.get(marker), finalUrl, finalPage };
  }
  if (pathname.includes("/signin/oauth/error") || marker === "Access blocked") {
    return { name, status: "fail", reason: "oauth_error", finalUrl, finalPage };
  }

  // "ok" needs a POSITIVE signal (D2): a known sign-in pathname, or chooser/sign-in body
  // text. Anything else — an interstitial, a marketing page, a silent redirect — is
  // unexpected_page, never a pass by absence of evidence.
  const positive =
    OK_PATH_PREFIXES.some((p) => pathname.startsWith(p)) ||
    OK_BODY_MARKERS.some((m) => bodyText.includes(m));
  if (!positive) {
    return { name, status: "fail", reason: "unexpected_page", finalUrl, finalPage };
  }

  return { name, status: "ok", finalUrl, finalPage };
}

/**
 * Probes both Google OAuth doors and returns { ok, doors }. Never throws — every failure
 * mode (timeout, network error, door HTTP error, not-configured, wrong host, Google's own
 * error page) resolves into a door result with a `reason`. Door results carry both
 * `finalUrl` (full, for programmatic callers) and `finalPage` (origin + pathname, the only
 * form a caller may log — the query string carries the client id and OAuth state).
 */
export async function checkGoogleSignIn({
  baseUrl,
  tenant,
  fetchImpl = fetch,
  timeoutMs = 15000,
  expectedHost = "accounts.google.com",
  required,
} = {}) {
  const resolvedRequired = required ?? resolveRequired(baseUrl, process.env.SMOKE_GOOGLE_REQUIRED);

  // One AbortController budget shared by all four fetches (2 doors x door+consent) — L-077.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const doors = await Promise.all(
      DOORS(tenant).map((door) =>
        probeDoor({
          baseUrl,
          door,
          fetchImpl,
          expectedHost,
          required: resolvedRequired,
          signal: controller.signal,
        }),
      ),
    );
    const ok = doors.every((d) => d.status !== "fail");
    return { ok, doors };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves `hostname` (default the apex domain) via `lookupImpl` (default node:dns/promises
 * lookup). ENOTFOUND/EAI_AGAIN warn unless `required`, in which case they fail.
 */
export async function checkApexDns({ hostname, lookupImpl = dnsLookup, required = false } = {}) {
  try {
    const result = await lookupImpl(hostname);
    return { ok: true, status: "ok", address: result?.address };
  } catch (err) {
    const reason = err?.code ?? "ENOTFOUND";
    return required ? { ok: false, status: "fail", reason } : { ok: true, status: "warn", reason };
  }
}
