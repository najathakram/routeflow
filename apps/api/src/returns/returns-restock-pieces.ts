import { resolvePackFactors } from "../common/line-pack-factors";
import type { RestockPieces, RestockableReturnItem } from "./returns-restock.util";

/**
 * B665: the resolver a STANDARD return's `receive()` hands to `restockReturnItems`. A STANDARD return stores
 * the qty the operator typed in the order line's OWN unit (every creator is capped by the raw line qty), which
 * is pieces for a box-split or ordinary line but BOXES for a box-unaware boxed line, while stock is counted in
 * pieces. The pack comes only from `legacyLinePieces` through the shared `resolvePackFactors` (own split, else
 * the line's ONE linked live InvoiceItem when it carries a split — no sibling guess, and a line billed across several parks): NEVER the live product's
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
          // EVERY live invoice item per line, not one: resolvePackFactors decides on the COUNT (a line
          // billed across several is not a 1:1 source and parks), so collapsing them here would both hide
          // that case and make the answer depend on the row order of an unordered query.
          // VOID invoices are cancelled billings and are not evidence of how the line was sold.
          const items: any[] = await tx.invoiceItem.findMany({
            where: { orderItemId: { in: lineIds }, invoice: { status: { not: "VOID" } } },
            select: { orderItemId: true, qty: true, boxes: true, pieces: true, unitsPerBox: true },
          });
          const byLine = new Map<string, any[]>();
          for (const x of items) {
            const list = byLine.get(x.orderItemId);
            if (list) list.push(x);
            else byLine.set(x.orderItemId, [x]);
          }
          return byLine;
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
