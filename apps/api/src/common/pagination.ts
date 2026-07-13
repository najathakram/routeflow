/**
 * Shared pagination bounds (security F9-001/002/003).
 *
 * List endpoints must cap `limit` so a single request can't force an unbounded
 * scan / memory blow-up. `MAX_LIST_LIMIT` is deliberately generous — well above
 * every real UI call (the dashboard's largest "fetch-all" idiom is ~999) but far
 * below anything that could exhaust memory. Product/supplier lists keep their own,
 * higher, purpose-built caps (the product picker relies on larger pages) declared
 * on their own DTOs.
 */
export const MAX_LIST_LIMIT = 1000;

/**
 * Normalize a raw, untrusted page-size into a safe `take`. Used by controllers
 * that read `limit` straight off the query string (no DTO validation) — DTO-based
 * lists enforce the same ceiling with `@Max(MAX_LIST_LIMIT)` instead.
 *
 * Returns `fallback` for missing/NaN/<1 input; otherwise the floored value capped
 * at `max`.
 */
export function clampLimit(
  limit: number | undefined | null,
  fallback: number,
  max: number = MAX_LIST_LIMIT,
): number {
  if (limit == null || !Number.isFinite(limit) || limit < 1) return fallback;
  return Math.min(Math.floor(limit), max);
}
