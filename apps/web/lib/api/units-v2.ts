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
