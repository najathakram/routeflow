import { redactPath } from "./redacted-route";

/**
 * Strips request detail from a Sentry event before it leaves the box.
 *
 * The SDK attaches the request URL (path and query string), cookies, headers and, for incoming
 * requests, a copy of the body. A path segment, a query value or a JSON field can carry a
 * single-use link token, and a header can carry a credential, so none of those may be shipped.
 * What is kept: the origin and the path with every token-shaped segment replaced (`redactPath`),
 * which is enough to tell which route failed.
 *
 * Pure and in-place: the same event is returned so it can be used directly as `beforeSend` and
 * `beforeSendTransaction`. It never throws; an event it does not understand passes through.
 */

type Bag = Record<string, unknown>;

/** Request headers that carry a credential; compared lower-cased. */
const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
]);

/** Span / trace attributes that hold a URL or path (rewritten) or a query / fragment (dropped). */
const URL_ATTRIBUTES = ["url", "url.full", "http.url", "url.path", "http.target"];
const QUERY_ATTRIBUTES = ["url.query", "http.query", "url.fragment", "http.fragment"];

function isBag(value: unknown): value is Bag {
  return typeof value === "object" && value !== null;
}

/** `https://host/api/v1/x/<token>?q=1#f` -> `https://host/api/v1/x/:redacted`; a bare path works too. */
export function redactUrl(url: string): string {
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

function scrubAttributes(bag: unknown): void {
  if (!isBag(bag)) return;
  for (const key of QUERY_ATTRIBUTES) delete bag[key];
  for (const key of URL_ATTRIBUTES) {
    if (typeof bag[key] === "string") bag[key] = redactUrl(bag[key]);
  }
}

export function scrubSentryEvent<T extends object>(event: T): T {
  try {
    const e = event as Bag;

    const request = e.request;
    if (isBag(request)) {
      if (typeof request.url === "string") request.url = redactUrl(request.url);
      delete request.query_string;
      delete request.data;
      delete request.cookies;
      if (isBag(request.headers)) {
        for (const name of Object.keys(request.headers)) {
          if (SECRET_HEADERS.has(name.toLowerCase())) delete request.headers[name];
        }
      }
    }

    if (typeof e.transaction === "string") e.transaction = redactTransactionName(e.transaction);

    const contexts = e.contexts;
    if (isBag(contexts) && isBag(contexts.trace)) scrubAttributes(contexts.trace.data);

    if (Array.isArray(e.spans)) {
      for (const span of e.spans) {
        if (!isBag(span)) continue;
        if (typeof span.description === "string") {
          span.description = redactTransactionName(span.description);
        }
        scrubAttributes(span.data);
      }
    }
  } catch {
    // A scrubber failure must never lose or crash the report path.
  }
  return event;
}
