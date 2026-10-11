/**
 * The one way a request's route may be written to a log line, a Sentry tag or a guard message.
 *
 * A raw URL can carry a single-use secret in a path segment (an invite, verification or reset
 * link), so a raw path must never reach a sink that is stored or shipped off the box. This helper
 * builds `METHOD /template` instead:
 *
 *  - When Express matched a route, `req.route.path` is the TEMPLATE (`/buyer/invites/:token/accept`),
 *    known before the handler runs, so a failing request is written exactly like a succeeding one.
 *    The global prefix is removed, as the audit trail does.
 *  - When no template exists (the request matched no route, or something ran before routing) the
 *    raw path is kept but every token-shaped segment is replaced by `:redacted`.
 *
 * The query string is never part of the result. `deriveAuditTarget` (audit.interceptor.ts) shares
 * the template logic below, so the audit trail and the logs can never disagree about what a
 * template is.
 */

/** The global prefix Nest bakes into every route template (main.ts `setGlobalPrefix`). */
export const GLOBAL_PREFIX = /^\/api\/v1(?=\/|$)/;

/** Written in place of a path segment that looks like a secret. */
export const REDACTED_SEGMENT = ":redacted";

/** The request fields this helper reads; a full Express `Request` satisfies it. */
export interface RouteRequestLike {
  method?: string;
  route?: { path?: unknown } | null;
  originalUrl?: string;
  url?: string;
  path?: string;
}

/** A canonical UUID is an ordinary id, never a secret (36 chars, so it would trip the length rule). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** base64url / hex alphabet. */
const TOKEN_ALPHABET = /^[A-Za-z0-9_-]+$/;
/** A readable lower-case word chain (`scan-invoice`, `bulk-update-product-status`) is a route name. */
const WORD_CHAIN = /^[a-z]+(?:-[a-z]+)*$/;
/** Shortest base64url / hex run treated as a secret on its own. */
const MIN_TOKEN_CHARS = 20;
/** A segment named like this makes the NEXT segment a secret (`/invites/<x>`, `/verify/<x>`). */
const SECRET_BEARING_NAME = /token|invite|verify|confirm|reset/i;

function isTokenShaped(segment: string): boolean {
  if (UUID.test(segment)) return false;
  return (
    segment.length >= MIN_TOKEN_CHARS && TOKEN_ALPHABET.test(segment) && !WORD_CHAIN.test(segment)
  );
}

/** The route template with the global prefix removed, split into segments; `null` when unmatched. */
export function matchedTemplateParts(req: RouteRequestLike): string[] | null {
  const template = typeof req.route?.path === "string" ? req.route.path : null;
  if (template === null) return null;
  return template.replace(GLOBAL_PREFIX, "").split("/").filter(Boolean);
}

/** The raw request path (query string removed), for a request that has no route template. */
export function rawPath(req: RouteRequestLike): string {
  return (req.originalUrl ?? req.url ?? req.path ?? "").split("?")[0].split("#")[0];
}

/**
 * The path with every token-shaped segment replaced by `:redacted`. Short ids and UUIDs stay;
 * the leading `/api/v1` and literal route names stay.
 */
export function redactPath(path: string): string {
  const cleaned = path.split("?")[0].split("#")[0];
  const leadingSlash = cleaned.startsWith("/");
  let previous = "";
  const out = cleaned.split("/").map((segment) => {
    const afterSecretName = previous !== "" && SECRET_BEARING_NAME.test(previous);
    previous = segment;
    if (segment === "") return segment;
    if (UUID.test(segment)) return segment;
    if (isTokenShaped(segment) || afterSecretName) return REDACTED_SEGMENT;
    return segment;
  });
  const joined = out.join("/");
  return leadingSlash && !joined.startsWith("/") ? `/${joined}` : joined;
}

/** `METHOD /template` (prefix removed), or `METHOD <redacted raw path>` when nothing matched. */
export function redactedRoute(req: RouteRequestLike): string {
  const method = String(req.method ?? "?").toUpperCase();
  const parts = matchedTemplateParts(req);
  if (parts !== null) return `${method} /${parts.join("/")}`;
  return `${method} ${redactPath(rawPath(req)) || "?"}`;
}
