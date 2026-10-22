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
  request?: {
    url?: string;
    query_string?: unknown;
    headers?: Record<string, string>;
  };
};

/**
 * `beforeSend` / `beforeSendTransaction` hook: redacts the key from `request.url` and `transaction`, drops
 * `request.query_string` on by-key paths, and blanks any `Idempotency-Key` request header. Mutates and returns
 * the event; events that touch no by-key route and carry no such header are returned unchanged.
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
  if (req?.headers) {
    for (const name of Object.keys(req.headers)) {
      if (name.toLowerCase() === "idempotency-key") req.headers[name] = "[Filtered]";
    }
  }
  return event;
}

/** An absolute or relative URL, key and query removed (the origin is kept). */
function redactUrl(url: string): string {
  return url.split("?")[0].split("#")[0].replace(BY_KEY_SEGMENT, "$1:key");
}
