import { ROUTE_HITS_UNMATCHED } from "./route-hits.constants";

/**
 * `GET /api/v1/customers/:id`: the HTTP method plus the Express route TEMPLATE (`req.route.path`, which
 * already carries the global prefix once the route is matched). Never the raw URL, so ids collapse and the
 * key set is bounded by the number of routes. A request that matched no route is `UNMATCHED`.
 */
export function routeHitKey(
  req: { method?: string; route?: { path?: unknown } } | undefined,
): string {
  const path = req?.route?.path;
  if (typeof path !== "string" || path.length === 0) return ROUTE_HITS_UNMATCHED;
  return `${(req?.method ?? "GET").toUpperCase()} ${path}`;
}
