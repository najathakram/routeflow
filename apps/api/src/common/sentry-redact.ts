import { redactPath } from "./redacted-route";

/**
 * Payment Idempotency-Keys are secrets-adjacent identifiers (SA-824): no Sentry surface may carry one. Pure and
 * dependency-free so `instrument.ts` can import it before anything else boots. Routing is case-insensitive in
 * Nest/Express, so every match here is too.
 */
const BY_KEY_SEGMENT = /(\/by-key\/)[^/?#]+/gi;
const HAS_BY_KEY = /\/by-key\//i;

/** The `by-key` route shape with the key replaced by `:key`; the query string goes too. */
export function redactKeyPath(url: string): string {
  return url.split("?")[0].replace(BY_KEY_SEGMENT, "$1:key");
}

type RedactableEvent = {
  transaction?: string;
  tags?: Record<string, unknown>;
  request?: {
    url?: string;
    query_string?: unknown;
    headers?: Record<string, string>;
    data?: unknown;
    cookies?: unknown;
  };
};

/**
 * `beforeSend` / `beforeSendTransaction` hook: redacts the key from `request.url`, `transaction` and the `path` tag,
 * blanks any `Idempotency-Key` request header, and drops the request body (`request.data`). A single-use link token in
 * a path segment is redacted the same way (`redactPath`), and the query string, cookies and credential headers go
 * whole on every event. Mutates and returns the event.
 */
export function redactSentryEvent<T extends RedactableEvent>(event: T): T {
  const req = event.request;
  const byKey =
    (typeof req?.url === "string" && HAS_BY_KEY.test(req.url)) ||
    (typeof event.transaction === "string" && HAS_BY_KEY.test(event.transaction));
  if (byKey) {
    if (req) {
      if (typeof req.url === "string") req.url = redactUrl(req.url);
      delete req.query_string;
    }
    if (typeof event.transaction === "string") event.transaction = redactKeyPath(event.transaction);
  }
  // lock-conflict.filter falls back to the raw originalUrl for its `path` tag when req.route is missing.
  const pathTag = event.tags?.path;
  if (typeof pathTag === "string" && HAS_BY_KEY.test(pathTag))
    event.tags!.path = redactKeyPath(pathTag);
  // SA-1084: the Node SDK keeps an incoming request body (up to 10 KB) on an error event. A body can carry a tax ID,
  // a license number or a password, and a list of keys grows, so the body goes whole; URL, route and stack stay.
  if (req) delete req.data;
  // A path segment or a query value can carry a single-use link token, and a header or cookie a credential: the URL
  // keeps its origin and a path with every secret-shaped segment redacted, the query string and cookies go whole.
  if (req) {
    if (typeof req.url === "string") req.url = redactEventUrl(req.url);
    delete req.query_string;
    delete req.cookies;
  }
  if (typeof event.transaction === "string")
    event.transaction = redactTransactionName(event.transaction);
  if (typeof pathTag === "string") event.tags!.path = redactPath(event.tags!.path as string);
  if (req?.headers && typeof req.headers === "object") {
    for (const name of Object.keys(req.headers)) {
      const lower = name.toLowerCase();
      if (lower === "idempotency-key") req.headers[name] = "[Filtered]";
      else if (SECRET_HEADERS.has(lower)) delete req.headers[name];
    }
  }
  return event;
}

/** An absolute or relative URL, key and query removed (the origin is kept). */
function redactUrl(url: string): string {
  return url.split("?")[0].split("#")[0].replace(BY_KEY_SEGMENT, "$1:key");
}

/** Request headers that carry a credential; compared lower-cased. */
const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
]);

/** `https://host/api/v1/x/<token>?q=1#f` -> `https://host/api/v1/x/:redacted`; a bare path works too. */
function redactEventUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${redactPath(parsed.pathname)}`;
  } catch {
    return redactPath(url);
  }
}

/** `GET /api/v1/x/<token>?q=1` -> `GET /api/v1/x/:redacted`; text that holds no path is returned as is. */
function redactTransactionName(name: string): string {
  const at = name.indexOf("/");
  if (at < 0) return name;
  return `${name.slice(0, at)}${redactPath(name.slice(at))}`;
}
