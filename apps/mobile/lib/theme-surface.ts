import type { LedgerSurface } from "@routeflow/ui/ledger";

/**
 * Which web surface a route belongs to (#2330). The `(customer)` group is the buyer portal
 * (web `.surface-buyer`, emerald). Every other group (driver, operator, tenant, auth) is the
 * operator surface, which follows the tenant brand.
 */
export function surfaceForSegments(segments: readonly string[]): LedgerSurface {
  return segments[0] === "(customer)" ? "buyer" : "operator";
}
