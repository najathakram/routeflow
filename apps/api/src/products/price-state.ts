import { createHash } from "node:crypto";

/** A money column as the fingerprint sees it: a fixed two-decimal string, or null. Decimal/string/number all agree. */
const cents = (v: unknown): string | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : null;
};

export interface PriceStateProduct {
  pricePerUnit: unknown;
  priceTier2: unknown;
  priceTier3: unknown;
  priceTier4: unknown;
  priceTier5: unknown;
  packAuto?: number | null;
  orderUnitRef?: string | null;
}

export interface PriceStateUnit {
  id: string;
  factorToBase: number;
  price?: unknown;
  priceTier2?: unknown;
  priceTier3?: unknown;
  priceTier4?: unknown;
  priceTier5?: unknown;
}

export interface PriceStateTierUnit {
  tier: number;
  orderUnitRef: string | null;
}

/**
 * SA-796 R-1 value compare-and-set: the opaque token a client echoes back. sha256 hex of the canonical JSON of every
 * price-bearing column the grid reads: the 5 pack columns, `packAuto`, the order unit and the tier order units (they
 * decide which cell is Auto), and each ProductUnit's id, factor and 5 prices. Legacy writers do not bump
 * `Product.priceRevision`, so the revision alone cannot see their writes; this does.
 *
 * Canonical = fixed key order, units sorted by id, money as two-decimal strings, so the token depends on the values and
 * not on column types or row order.
 */
export function computePriceState(
  product: PriceStateProduct,
  units: readonly PriceStateUnit[],
  tierUnits: readonly PriceStateTierUnit[] = [],
): string {
  const canonical = {
    pack: [
      cents(product.pricePerUnit),
      cents(product.priceTier2),
      cents(product.priceTier3),
      cents(product.priceTier4),
      cents(product.priceTier5),
    ],
    packAuto: Number(product.packAuto) || 0,
    orderUnit: product.orderUnitRef ?? "pack",
    tierUnits: [...tierUnits]
      .filter((t) => t.orderUnitRef != null)
      .sort((a, b) => a.tier - b.tier)
      .map((t) => [t.tier, t.orderUnitRef]),
    units: [...units]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((u) => [
        u.id,
        u.factorToBase,
        cents(u.price),
        cents(u.priceTier2),
        cents(u.priceTier3),
        cents(u.priceTier4),
        cents(u.priceTier5),
      ]),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
