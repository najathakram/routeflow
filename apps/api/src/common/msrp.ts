import { roundMoney } from "@routeflow/pricing";

/** 0, negatives and non-numbers all mean "no MSRP" — never render those as $0.00. */
const normalizeMsrp = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? roundMoney(n) : null;
};

export interface MsrpInputs {
  /** CustomerPrice.msrp — highest precedence. */
  customerMsrp?: unknown;
  /**
   * FUTURE middle layer (per-state / per-segment MSRP). Nothing populates this in v1;
   * it exists so the precedence order and every call site are already segment-shaped —
   * adding segments later is one new table plus one lookup in loadMsrpMap, with no
   * migration of existing data and no call-site churn.
   */
  segmentMsrp?: unknown;
  /** Product.msrp — the universal default. */
  productMsrp?: unknown;
}

/** customer override → (future) segment → product default. null = no MSRP (render blank). */
export function resolveMsrp(i: MsrpInputs): number | null {
  return (
    normalizeMsrp(i.customerMsrp) ?? normalizeMsrp(i.segmentMsrp) ?? normalizeMsrp(i.productMsrp)
  );
}

/**
 * Wholesale price expressed per PIECE, so it is comparable with MSRP.
 * pricePerUnit is per SELLING unit — a box when unitsPerBox > 1.
 */
export function wholesalePerPiece(pricePerUnit: unknown, unitsPerBox?: unknown): number | null {
  const p = Number(pricePerUnit);
  if (!Number.isFinite(p) || p <= 0) return null;
  const upb = Number(unitsPerBox);
  return Number.isFinite(upb) && upb > 1 ? roundMoney(p / upb) : roundMoney(p);
}

/** Advisory only — the UI warns, it never blocks. */
export function isMsrpBelowWholesale(
  msrp: unknown,
  pricePerUnit: unknown,
  unitsPerBox?: unknown,
): boolean {
  const m = normalizeMsrp(msrp);
  const w = wholesalePerPiece(pricePerUnit, unitsPerBox);
  return m != null && w != null && m < w;
}

/**
 * Batch-resolve MSRP for many products for one customer.
 * `db` is any prisma-ish client so this runs inside a tenantTransaction too.
 * FUTURE segment layer: add one more select here and pass it as segmentMsrp.
 */
export async function loadMsrpMap(
  db: {
    product: { findMany: (a: any) => Promise<any[]> };
    customerPrice: { findMany: (a: any) => Promise<any[]> };
  },
  customerId: string,
  productIds: string[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (productIds.length === 0) return out;
  const [products, overrides] = await Promise.all([
    db.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, msrp: true },
    }),
    db.customerPrice.findMany({
      where: { customerId, productId: { in: productIds } },
      select: { productId: true, msrp: true },
    }),
  ]);
  const overrideBy = new Map(overrides.map((o) => [o.productId, o.msrp]));
  for (const p of products) {
    out.set(p.id, resolveMsrp({ customerMsrp: overrideBy.get(p.id), productMsrp: p.msrp }));
  }
  return out;
}
