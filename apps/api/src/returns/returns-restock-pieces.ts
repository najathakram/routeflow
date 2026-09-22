import { resolvePackFactors } from "../common/line-pack-factors";
import type { RestockPieces, RestockableReturnItem } from "./returns-restock.util";

/**
 * B665: the resolver a STANDARD return's `receive()` hands to `restockReturnItems`. A STANDARD return stores
 * the qty the operator typed in the order line's OWN unit (every creator is capped by the raw line qty), which
 * is pieces for a box-split or ordinary line but BOXES for a box-unaware boxed line, while stock is counted in
 * pieces. The pack comes only from `legacyLinePieces` through the shared `resolvePackFactors` (own split, else
 * the line's linked InvoiceItem when it carries a split — no sibling guess): NEVER the live product's
 * `unitsPerBox` (Senior Architect ruling 2026-09-21).
 *
 * A return has no line key, so an item is resolved against ALL of the order's non-cancelled lines of that
 * product: they must agree on one factor. A product sitting on lines with different packs (say one box-aware
 * and one box-unaware) is `unknown`, as is any line whose pack cannot be established: it parks, it is never
 * guessed. A product with no ambiguous line restocks exactly as before (factor 1).
 */
export function standardRestockResolver(tx: any, orderId: string) {
  let loaded: Promise<{
    lines: any[];
    packs: Awaited<ReturnType<typeof resolvePackFactors>>;
  }> | null = null;
  const load = () =>
    (loaded ??= (async () => {
      const lines: any[] = await tx.orderItem.findMany({
        where: { orderId, status: { not: "CANCELLED" } },
        select: {
          id: true,
          productId: true,
          qty: true,
          boxes: true,
          pieces: true,
          unitsPerBox: true,
          product: { select: { unitsPerBox: true } },
        },
      });
      const packs = await resolvePackFactors({
        orderId,
        lines,
        loadInvoiceItems: async (lineIds) => {
          const items: any[] = await tx.invoiceItem.findMany({
            where: { orderItemId: { in: lineIds } },
            select: { orderItemId: true, qty: true, boxes: true, pieces: true, unitsPerBox: true },
          });
          return new Map(items.map((x) => [x.orderItemId, x]));
        },
      });
      return { lines, packs };
    })());

  return async (item: RestockableReturnItem): Promise<RestockPieces> => {
    const { lines, packs } = await load();
    const qty = Number(item.qty);
    const mine = lines.filter((l) => l.productId === item.productId);
    const factors = new Set<number>();
    for (const line of mine) {
      const p = packs.get(line.id);
      if (!p) factors.add(1);
      else if ("unknown" in p) return { unknown: true, reason: p.reason };
      else factors.add(p.factor);
    }
    if (factors.size > 1) {
      return { unknown: true, reason: "the product is on order lines with different packs" };
    }
    return { pieces: qty * (factors.size === 1 ? [...factors][0] : 1) };
  };
}
