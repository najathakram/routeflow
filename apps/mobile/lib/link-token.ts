/**
 * Single-use account links (password reset / set-password) carry their token in the URL
 * FRAGMENT: `https://<mobile web>/reset-password#t=<token>`. A fragment is never sent to a
 * server, never written to an access log and never carried in a Referer header.
 *
 * Pure — no React/native imports — so it is Jest-testable. The reset screen reads the token once,
 * scrubs it from the address bar (web), keeps it in memory and POSTs it in a request BODY.
 *
 * Links emailed before the fragment format carry `?token=`: the web screen keeps reading that
 * until the longest link lifetime (the 72h set-password link) has passed since the cutover. A
 * native deep link is not an HTTP request: it keeps handing the token over as a route param.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Longest lifetime of a legacy link this screen serves (set-password, 72h; self-service reset is 15 min). */
export const LEGACY_QUERY_TTL_MS = 72 * HOUR_MS;

/**
 * When the API started emailing fragment links. Set to (or after) the real deploy time: a later
 * value only lengthens the legacy window; an earlier one would drop live legacy links.
 */
export const LINK_FORMAT_CUTOVER_AT_MS = Date.parse("2026-10-14T00:00:00Z");

export function legacyQueryTokenAccepted(now: number = Date.now()): boolean {
  return now < LINK_FORMAT_CUTOVER_AT_MS + LEGACY_QUERY_TTL_MS;
}

const MAX_TOKEN_LENGTH = 512;

function clean(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  return v.length > 0 && v.length <= MAX_TOKEN_LENGTH ? v : "";
}

/** `#t=<token>` / `t=<token>` → token (empty string when absent). */
export function tokenFromFragment(fragment: string | null | undefined): string {
  if (!fragment) return "";
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  return clean(new URLSearchParams(raw).get("t"));
}

export interface LinkTokenSources {
  platform: "web" | "native";
  /** expo-router keeps the fragment in the route params under the key "#" (without the "#"). */
  fragmentParam?: string | null;
  /** `window.location.hash` (web only). */
  locationHash?: string | null;
  /** The `token` route/query param. */
  queryToken?: string | null;
  now?: number;
}

/**
 * Fragment `t` first (web), else the `token` param: always on native (a deep link is not an HTTP
 * request), and on web only while the legacy window is open.
 */
export function resolveLinkToken(src: LinkTokenSources): string {
  if (src.platform === "web") {
    const fromFragment =
      tokenFromFragment(src.fragmentParam) || tokenFromFragment(src.locationHash);
    if (fromFragment) return fromFragment;
    if (!legacyQueryTokenAccepted(src.now)) return "";
  }
  return clean(src.queryToken);
}

/** Drops the fragment and the `token` query param from the address bar (other params stay). */
export function scrubLinkTokenFromUrl(win: {
  location: { pathname: string; search: string; hash: string };
  history: { replaceState: (data: unknown, unused: string, url?: string | null) => void };
}): void {
  const { pathname, search, hash } = win.location;
  if (!hash && !search) return;
  const params = new URLSearchParams(search);
  params.delete("token");
  const rest = params.toString();
  win.history.replaceState(null, "", rest ? `${pathname}?${rest}` : pathname);
}

interface MetaLike {
  name: string;
  content: string;
  setAttribute?: (k: string, v: string) => void;
  parentNode?: { removeChild: (n: unknown) => unknown } | null;
}
interface DocLike {
  head: { appendChild: (n: unknown) => unknown };
  querySelector: (sel: string) => MetaLike | null;
  createElement: (tag: "meta") => MetaLike;
}

/**
 * Sets `<meta name="referrer" content="no-referrer">` for the life of the screen (web), so a
 * legacy `?token=` link that is still being read never leaks through a Referer header. Returns a
 * cleanup that restores the previous value, or removes the tag if this call created it.
 */
export function applyNoReferrerMeta(doc: DocLike): () => void {
  const existing = doc.querySelector('meta[name="referrer"]');
  if (existing) {
    const previous = existing.content;
    existing.content = "no-referrer";
    return () => {
      existing.content = previous;
    };
  }
  const meta = doc.createElement("meta");
  meta.name = "referrer";
  meta.content = "no-referrer";
  doc.head.appendChild(meta);
  return () => {
    meta.parentNode?.removeChild(meta);
  };
}
