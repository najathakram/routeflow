/**
 * S4 (units-and-pricing): data rules for NEW products under `flag.units_prices_v2`.
 *
 * Every helper RETURNS A VALUE (never an object to spread), so each write block keeps its literal
 * column keys (family-price-writer-tripwire / pack-write-path read those literals).
 *   - flagged: no SKU is invented, and a tier nobody priced is "0" instead of a copy of Retail.
 *   - unflagged: master's behaviour, unchanged.
 */
export const UNITS_PRICES_V2_FLAG = "flag.units_prices_v2";

const FLAG_CACHE_TTL_MS = 30_000;
const FLAG_CACHE_MAX = 1000;

/** Master invents a SKU for a blank one; a flagged tenant keeps it empty. */
export function mayInventSku(flagged: boolean): boolean {
  return !flagged;
}

/** The value of a tier column neither the caller nor a parent priced: "0" flagged, the Retail price otherwise. */
export function newProductTierFallback(flagged: boolean, retail: string): string {
  return flagged ? "0" : retail;
}

/**
 * A family variant's tier column: a family price record's value is copied as today; with only a plain price
 * string given, a flagged tenant stores "0" and master copies the plain price.
 */
export function variantTierValue(
  flagged: boolean,
  copied: string | undefined,
  own: string,
): string {
  if (copied !== undefined) return copied;
  return flagged ? "0" : own;
}

type FlagReader = { hasFlag(tenantId: string, flagKey: string): Promise<boolean> };

/**
 * One `flag.units_prices_v2` read per tenant per 30 s. Call it BEFORE a transaction opens, never inside
 * one. It fails to OFF (master's behaviour) on a missing reader/tenant or a throwing read, and never
 * caches a failure.
 */
export class UnitsPricesV2FlagCache {
  private readonly cache = new Map<string, { value: boolean; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async isOn(
    entitlements: FlagReader | undefined,
    tenantId: string | null | undefined,
  ): Promise<boolean> {
    if (!entitlements || !tenantId) return false;
    const now = this.now();
    const hit = this.cache.get(tenantId);
    if (hit && hit.expiresAt > now) return hit.value;
    try {
      const value = (await entitlements.hasFlag(tenantId, UNITS_PRICES_V2_FLAG)) === true;
      if (this.cache.size >= FLAG_CACHE_MAX) this.cache.clear();
      this.cache.set(tenantId, { value, expiresAt: now + FLAG_CACHE_TTL_MS });
      return value;
    } catch {
      return false;
    }
  }
}
