import { resolvePackFactors } from "../common/line-pack-factors";
import type { RestockPieces, RestockableReturnItem } from "./returns-restock.util";

/**
 * EVERY live invoice item per line, not one: resolvePackFactors decides on the COUNT (a line billed
 * across several is not a 1:1 source and parks), so collapsing them here would both hide that case and
 * make the answer depend on the row order of an unordered query. VOID invoices are cancelled billings
 * and are not evidence of how the line was sold. Shared by the restock resolver and the STANDARD return
 * cap (returns-pieces.util.ts) so both read a line's pack from the same evidence (SA-158).
 */
export const liveInvoiceItemsByLine =
  (tx: any) =>
  async (lineIds: string[]): Promise<Map<string, any[]>> => {
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
  };

export type ProductPackBasis =
  | { factor: number }
  | { unknown: true; reason: string; singleUnit: boolean }
  | { mixed: true; factors: number[] }
  | { noLines: true };

/**
 * ONE rule for "what does a typed qty of this product count in, per line unit" — used by the restock
 * resolver below and by the STANDARD return cap (returns-pieces.util.ts, SA-158), so the two can never
 * disagree. A return has no line key, so the product resolves against ALL of the order's non-cancelled
 * lines of it: they must agree on one factor. Different packs (say one box-aware and one box-unaware) are
 * `mixed`; a line whose pack cannot be established is `unknown`; neither is ever guessed as factor 1. A
 * line the resolver has nothing to say about (a split line, a unit-aware line, a pack-less product) is
 * genuinely factor 1.
 */
export function productPackBasis(
  lines: { id?: string; productId: string | null }[],
  packs: Awaited<ReturnType<typeof resolvePackFactors>>,
  productId: string,
): ProductPackBasis {
  const mine = lines.filter((l) => l.productId === productId);
  if (mine.length === 0) return { noLines: true };
  const factors = new Set<number>();
  let firstUnknown: string | null = null;
  let unknownLines = 0;
  for (const line of mine) {
    const p = line.id == null ? undefined : packs.get(line.id);
    if (!p) factors.add(1);
    else if ("unknown" in p) {
      firstUnknown ??= p.reason;
      unknownLines += 1;
    } else factors.add(p.factor);
  }
  // `singleUnit`: EVERY live line of the product is unresolvable (the legacy box-unaware shape), so all
  // of them are in the line's own unit and a line-unit sum is coherent. One resolvable line beside an
  // unresolvable one is not.
  if (firstUnknown != null)
    return { unknown: true, reason: firstUnknown, singleUnit: unknownLines === mine.length };
  if (factors.size > 1) return { mixed: true, factors: [...factors].sort((x, y) => x - y) };
  return { factor: [...factors][0] };
}

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
          unitLabel: true, // A4-F3: a unit-aware line is already base pieces (factor 1)
          product: { select: { unitsPerBox: true } },
        },
      });
      const packs = await resolvePackFactors({
        orderId,
        lines,
        loadInvoiceItems: liveInvoiceItemsByLine(tx),
      });
      return { lines, packs };
    })());

  return async (item: RestockableReturnItem): Promise<RestockPieces> => {
    const { lines, packs } = await load();
    const qty = Number(item.qty);
    const basis = productPackBasis(lines, packs, item.productId);
    if ("noLines" in basis) {
      // No live order line for this product on the order, so there is nothing to read a pack from: the
      // line was cancelled or replaced after the return was created (updateOrderItems replaces lines under
      // fresh ids; cancelling a line zeroes it and marks it CANCELLED), or the row is not visible to this
      // tenant. Falling through to the factor-1 default below would book the TYPED qty as pieces — 3 boxes
      // as 3 pieces — which is precisely the B665 defect, un-parked and with no error log. Park instead.
      return {
        unknown: true,
        reason: "no live order line for this product on the order to read a pack from",
      };
    }
    if ("unknown" in basis) return { unknown: true, reason: basis.reason };
    if ("mixed" in basis) {
      return { unknown: true, reason: "the product is on order lines with different packs" };
    }
    // A split line or a pack-less product is genuinely factor 1 (see productPackBasis).
    return { pieces: qty * basis.factor };
  };
}
