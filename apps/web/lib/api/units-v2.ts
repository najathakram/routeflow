export const PRICES_V2_FLAG = "flag.units_prices_v2";

// STUB (red commit): always true so the flag-hook test fails on its assertions.
export function usePricesV2Enabled(_opts?: { enabled?: boolean }): boolean {
  return true;
}
