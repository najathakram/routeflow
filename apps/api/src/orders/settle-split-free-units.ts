import { linePromoUnits, type PromotionRule } from "@routeflow/pricing";
import {
  reallocateFreeUnits,
  type FreeUnitBaseline,
  type FreeUnitLine,
} from "./product-free-units";

/**
 * B297 row 355 (SA-734r2 r-note 6): after an order's lines are edited, a product that was SPLIT across several
 * live lines gets its BUY_N_GET_M free units re-measured on the COMBINED whole-unit count and re-allocated
 * oldest line first (`product-free-units.ts`). Covers the writers that carry a non-empty `promos:` list and
 * edit lines one at a time: the stored-price qty edit, the DRIVER edit and the at-stop change.
 *
 *  - ONLY products this edit touched are settled (a line created, removed, cancelled, or changed in qty,
 *    split or free units): an unrelated product on the order is never re-priced by someone else's edit.
 *  - The licence is the PRE-edit state (`held`: the lines read under the order's row lock): a per-line
 *    rescale may already have zeroed the line that held the units, and a product that was split is settled
 *    even when the edit left one line.
 *  - `promos` empty is a strict no-op with no query. `canEarnNew` is false: an edit never gives a product a
 *    promo it had not earned.
 */
export async function settleSplitFreeUnits(
  tx: any,
  orderId: string,
  /** The order's lines read UNDER THE ROW LOCK, before this edit's writes (the baseline). */
  held: ReadonlyArray<any>,
  promos: ReadonlyArray<PromotionRule>,
): Promise<void> {
  if (promos.length === 0) return;
  const pre = held;
  const preLive = pre.filter((l) => l.productId && l.status !== "CANCELLED");
  if (preLive.length < 2) return; // nothing can have been split
  const lines: any[] = await tx.orderItem.findMany({
    where: { orderId, status: { not: "CANCELLED" }, productId: { not: null } },
    orderBy: [{ createdAt: "asc" }, { position: "asc" }, { id: "asc" }],
  });

  // Which products did this edit touch?
  const sig = (l: any) =>
    [l.qty, l.boxes, l.pieces, l.promoFreeUnits, l.status].map((v) => String(v ?? "")).join("|");
  const postById = new Map(lines.map((l) => [l.id, l]));
  const preIds = new Set(preLive.map((l) => l.id));
  const touched = new Set<string>();
  for (const l of preLive) {
    const now = postById.get(l.id);
    if (!now || sig(now) !== sig(l)) touched.add(l.productId);
  }
  for (const l of lines) if (!preIds.has(l.id)) touched.add(l.productId);
  const preProducts = new Set(preLive.map((l) => l.productId as string));
  const settle = [...touched].filter((id) => preProducts.has(id));
  if (settle.length === 0) return;

  const products: any[] = await tx.product.findMany({
    where: { id: { in: settle } },
    select: { id: true, category: true, unitsPerBox: true },
  });
  const byProduct = new Map(products.map((p) => [p.id as string, p]));
  const upbOf = (l: any) => Number(l.unitsPerBox ?? byProduct.get(l.productId)?.unitsPerBox ?? 0);

  const baseline = new Map<string, FreeUnitBaseline>();
  for (const id of settle) {
    const own = preLive.filter((l) => l.productId === id);
    // Units a line CREATED by this edit was just priced with count too (an at-door ADD_ITEM mints its own).
    const minted = lines
      .filter((l) => l.productId === id && !preIds.has(l.id))
      .reduce((n, l) => n + Number(l.promoFreeUnits ?? 0), 0);
    baseline.set(id, {
      free: own.reduce((n, l) => n + Number(l.promoFreeUnits ?? 0), 0) + minted,
      units: own.reduce(
        (n, l) =>
          n + linePromoUnits({ qty: Number(l.qty), boxes: l.boxes, pieces: l.pieces }, upbOf(l)),
        0,
      ),
      lines: own.length,
    });
  }

  const input: FreeUnitLine[] = lines
    .filter((l) => settle.includes(l.productId))
    .map((l) => ({
      key: l.id,
      productId: l.productId,
      qty: Number(l.qty),
      boxes: l.boxes,
      pieces: l.pieces,
      pack: Number(l.unitsPerBox ?? 0),
      unitPrice: Number(l.unitPrice),
      free: Number(l.promoFreeUnits ?? 0),
      priceType: l.priceType,
      originalPrice: l.originalPrice != null ? Number(l.originalPrice) : null,
      overriddenBy: l.overriddenBy,
      unitLabel: l.unitLabel ?? null,
    }));
  const changes = reallocateFreeUnits(input, {
    promos,
    canEarnNew: false,
    categoryFor: (id) => byProduct.get(id)?.category ?? null,
    liveUnitsPerBoxFor: (id) => Number(byProduct.get(id)?.unitsPerBox ?? 0),
    baseline,
  });
  for (const c of changes) {
    await tx.orderItem.update({
      where: { id: c.key },
      data: { promoFreeUnits: c.free > 0 ? c.free : null, subtotal: c.subtotal },
    });
  }
}
