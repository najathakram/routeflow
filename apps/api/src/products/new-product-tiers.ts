// STUB (red phase): returns master's behaviour so the specs fail on the value, not on a missing import.
export const UNITS_PRICES_V2_FLAG = "flag.units_prices_v2";

export function mayInventSku(_flagged: boolean): boolean {
  return true;
}

export function newProductTierFallback(_flagged: boolean, retail: string): string {
  return retail;
}

export function variantTierValue(
  _flagged: boolean,
  copied: string | undefined,
  own: string,
): string {
  return copied ?? own;
}

type FlagReader = { hasFlag(tenantId: string, flagKey: string): Promise<boolean> };

export class UnitsPricesV2FlagCache {
  isOn(
    _entitlements: FlagReader | undefined,
    _tenantId: string | null | undefined,
  ): Promise<boolean> {
    return Promise.resolve(false);
  }
}
