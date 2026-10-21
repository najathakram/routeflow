import { useSubscription } from "./billing";

/** The plan flag that gates the units v2 prices grid on the product page. */
export const PRICES_V2_FLAG = "flag.units_prices_v2";

/**
 * Does the tenant's subscription serve `flag.units_prices_v2`? FAIL-CLOSED like
 * `useUnitsEnabled`: an unknown answer keeps the v2 surface hidden. `enabled: false` (non-operator
 * roles) never fires the billing request.
 */
export function usePricesV2Enabled(opts?: { enabled?: boolean }): boolean {
  const q = useSubscription({ staleTime: 60_000, ...opts });
  return (q.data?.flags ?? []).includes(PRICES_V2_FLAG);
}

/**
 * K14 FE1: is the flag still UNKNOWN (the subscription has not answered yet)? The entitlement itself is unchanged
 * (`usePricesV2Enabled` stays fail-closed); this only lets a page wait for the answer instead of mounting the flag-off
 * layout and swapping it a moment later (a ~740 px shift at 390). An errored query is "known": it stays off.
 */
export function usePricesV2Pending(opts?: { enabled?: boolean }): boolean {
  const q = useSubscription({ staleTime: 60_000, ...opts });
  return opts?.enabled !== false && q.isPending;
}
