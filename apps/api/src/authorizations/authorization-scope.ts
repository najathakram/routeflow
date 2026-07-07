/**
 * Phase 4 (W6): pure helpers for the license guard — override-scope parsing and
 * category geo-scope matching. No I/O so they're trivially unit-testable.
 */

/**
 * Is an §8 override scope active for the given context?
 *   "ORDER:<id>"  → active iff orderId matches.
 *   "UNTIL:<iso>" → active iff now < iso.
 * FAIL-CLOSED: an empty/unparseable scope (or a bad date) is INACTIVE, so a
 * malformed override can never fail open and let an unlicensed sale through.
 */
export function isScopeActive(scope: string, ctx: { orderId?: string; now: Date }): boolean {
  if (!scope) return false;
  const idx = scope.indexOf(":");
  if (idx < 0) return false;
  const kind = scope.slice(0, idx);
  const value = scope.slice(idx + 1);
  if (kind === "ORDER") return !!ctx.orderId && value === ctx.orderId;
  if (kind === "UNTIL") {
    const until = new Date(value);
    return !Number.isNaN(until.getTime()) && ctx.now < until;
  }
  return false;
}

/**
 * Does a category's `appliesScope` (e.g. {cities:["Oakland"]}) apply to this sale?
 * A category with a city filter gates sales delivered to those cities. FAIL-CLOSED:
 * if the delivery city is UNKNOWN we still gate (return true) — a license-required
 * sale we can't positively place OUTSIDE the scoped area must not silently slip
 * through. We only skip gating when we KNOW the city and it's not in the list. A
 * scope with no city filter applies everywhere.
 */
export function scopeApplies(appliesScope: unknown, deliveryCity?: string | null): boolean {
  const cities = (appliesScope as { cities?: unknown } | null)?.cities;
  if (Array.isArray(cities) && cities.length > 0) {
    if (!deliveryCity) return true; // unknown city → fail closed (gate it)
    const target = deliveryCity.trim().toLowerCase();
    return cities.some((c) => typeof c === "string" && c.trim().toLowerCase() === target);
  }
  return true;
}
