/**
 * W3 route call counter: shared constants. Counts are per UTC day in one Redis hash per day
 * (`rf:route-hits:YYYY-MM-DD`, field = `METHOD /api/v1/<route template>`, value = hits). TENANT-AGNOSTIC:
 * a route template and a count, never a tenant, user, IP, URL, query, header or body.
 */
export const ROUTE_HITS_KEY_PREFIX = "rf:route-hits:";
/** Field of each day's hash that counts keys the bounded buffer had to drop (a visible loss, not a silent one). */
export const ROUTE_HITS_DROPPED_FIELD = "__DROPPED__";
/** Cap on distinct route keys held between flushes (the app has ~800 route templates; 2,000 is headroom). */
export const ROUTE_HITS_MAX_KEYS = 2000;
export const ROUTE_HITS_FLUSH_MS = 10_000;
/** A bucket outlives the 14-day observation window the report reads, with room for a longer look. */
export const ROUTE_HITS_TTL_SECONDS = 45 * 24 * 60 * 60;
/** The key for a request that matched no route (404s collapse here, never to a raw URL). */
export const ROUTE_HITS_UNMATCHED = "UNMATCHED";

/** `rf:route-hits:2026-10-02` for the UTC day of `now`. */
export function routeHitsDayKey(now: Date): string {
  return `${ROUTE_HITS_KEY_PREFIX}${now.toISOString().slice(0, 10)}`;
}

/**
 * ON in prod and dev by default; OFF under Jest unless a spec asks for it. `ROUTE_HITS_ENABLED=false`
 * is the kill switch, `=true` forces it on.
 */
export function routeHitsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ROUTE_HITS_ENABLED === "false") return false;
  if (env.ROUTE_HITS_ENABLED === "true") return true;
  return env.JEST_WORKER_ID === undefined;
}
