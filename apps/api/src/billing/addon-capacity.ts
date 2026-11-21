import type { MeterKey } from "@prisma/client";
import { addonSkuCode } from "./plan-catalog.constants";

/** The slice of a catalog add-on SKU the capacity sum reads. */
export interface CapacitySku {
  meteredKey?: string | null;
  capacityPerUnit?: number | null;
}
/** The slice of an active TenantAddon row the capacity sum reads. */
export interface CapacityRow {
  addonKey: string;
  sku?: string | null;
  quantity: number;
}

/**
 * B1371 (SA-1175 R1 K3), one copy: the extra meter capacity a tenant's active add-ons grant, `quantity x
 * capacityPerUnit` per metered SKU (e.g. +100 customers per Customer pack). `skuOf` resolves a row's code the caller's
 * way: entitlements uses the pinned catalog, else the published one. Unknown codes grant nothing.
 */
export function meterCapacity(
  rows: readonly CapacityRow[],
  skuOf: (code: string) => CapacitySku | undefined,
): Record<string, number> {
  // Record<MeterKey, …>: the compiler keeps the keys equal to the Prisma enum (SA-1049 G-2).
  const capacity: Record<MeterKey, number> = {
    SEATS: 0,
    ROUTES: 0,
    SCANS: 0,
    MSGS: 0,
    CUSTOMERS: 0,
  };
  const sums: Record<string, number> = capacity;
  for (const row of rows) {
    const code = addonSkuCode(row);
    const meta = code ? skuOf(code) : undefined;
    if (meta?.meteredKey && meta.capacityPerUnit) {
      sums[meta.meteredKey] = (sums[meta.meteredKey] ?? 0) + row.quantity * meta.capacityPerUnit;
    }
  }
  return sums;
}

/** What `caps.customers` is on `def` with these add-ons: included plus Customer-pack capacity; null = unlimited. */
export function customerAllowanceOf(
  def: { customersIncluded?: number | null },
  rows: readonly CapacityRow[],
  skuOf: (code: string) => CapacitySku | undefined,
): number | null {
  if (def.customersIncluded == null) return null;
  return def.customersIncluded + meterCapacity(rows, skuOf).CUSTOMERS;
}
