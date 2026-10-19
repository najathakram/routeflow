import { finiteStoredMoney } from "../common/money-invariants.util";
import { resolveProductMatches } from "./finalize-order-recompute";

/**
 * `recomputeOrderFromInvoices` (the invoice -> order back-sync), step 1, extracted from invoices.service.ts (a
 * size-ratchet-tracked file): which ORDER line each invoice line bills, and what each target aggregates to.
 * Pure (no I/O): the caller supplies the order's lines and its non-void invoices (with `items`).
 *
 * Aggregates billed qty + subtotal, resolving each invoice line to its source order line: prefer the stored
 * `orderItemId`; else first-match by productId (legacy rows); else by (product, category snapshot trio), so a second
 * recompute finds the lines it created and never cancels and re-creates them (row 373). An invoice line with a
 * product but no matching order line becomes a NEW order line (an item added on the invoice). Freeform invoice
 * lines (no product, no orderItemId) can't map to an order line and are reported in `freeformSkipped`.
 */
export interface OrderBacksyncAgg {
  line: any; // existing order line, or null -> create new
  productId: string | null;
  qty: number;
  subtotal: number;
  categoryTax: number; // RF-4: sum of billed category tax for this source line
  freeUnits: number; // BUY_N_GET_M: sum of billed free selling units for this source line
  unitPrice: number;
  n: number; // contributing invoice lines
  packs: Set<number>; // their packs (0 = none), for the shared-pack re-split rule
  sample: any; // an invoice item, for the box/piece + upb snapshot
}

/** The category / subcategory / rate-trio snapshot a line was billed under, as one comparable key. */
export const snapshotKeyOf = (r: any): string =>
  [
    r.trackedCategoryId ?? "",
    r.trackedSubcategoryId ?? "",
    r.categoryTaxType ?? "",
    r.categoryTaxRate != null ? Number(r.categoryTaxRate) : "",
    r.categoryPriceIncludesTax ?? "",
  ].join("|");

export function aggregateInvoiceLines(
  orderLines: any[],
  invoices: any[],
): {
  existingById: Map<string, any>;
  ambiguousLineIds: Set<string>;
  byTarget: Map<string, OrderBacksyncAgg>;
  freeformSkipped: string[];
} {
  const existingById = new Map<string, any>();
  for (const li of orderLines) existingById.set(li.id, li);
  // #1185 round 5, item 2 -- see resolveProductMatches' own doc.
  const { existingByProduct, ambiguousLineIds } = resolveProductMatches(orderLines);
  // (product, snapshot) -> its ONLY active order line (null when two share one): row 373's idempotent match.
  const bySnapshot = new Map<string, any>();
  for (const li of orderLines) {
    if (!li.productId || li.status === "CANCELLED") continue;
    const k = `${li.productId}|${snapshotKeyOf(li)}`;
    bySnapshot.set(k, bySnapshot.has(k) ? null : li);
  }
  const byTarget = new Map<string, OrderBacksyncAgg>();
  const freeformSkipped: string[] = []; // SA-093a rd6: no orderItemId, no productId -- warn, never silent
  for (const inv of invoices) {
    for (const it of inv.items as any[]) {
      const line =
        (it.orderItemId && existingById.get(it.orderItemId)) ||
        (it.productId && existingByProduct.get(it.productId)) ||
        // row 373: a product on several order lines (different snapshots) matches by (product, snapshot).
        (it.productId && bySnapshot.get(`${it.productId}|${snapshotKeyOf(it)}`)) ||
        null;
      if (!line && !it.productId) {
        freeformSkipped.push(it.id);
        continue;
      }
      // A new order line per (product, category, subcategory, trio): invoice lines of one product that were
      // billed under different snapshots must not be summed under the LAST one's (row 373 review).
      const key = line ? `line:${line.id}` : `product:${it.productId}|${snapshotKeyOf(it)}`;
      const prev = byTarget.get(key) ?? {
        line,
        productId: it.productId ?? null,
        qty: 0,
        subtotal: 0,
        categoryTax: 0,
        freeUnits: 0,
        unitPrice: Number(it.unitPrice),
        n: 0,
        packs: new Set<number>(),
        sample: it,
      };
      prev.n += 1;
      prev.packs.add(Number(it.unitsPerBox ?? 0));
      prev.qty += Number(it.qty);
      prev.subtotal += Number(it.subtotal);
      // SA-816: a stored non-finite levy is refused here (400), never summed into a NaN that roundMoney turns into 0.
      prev.categoryTax += finiteStoredMoney(
        it.categoryTaxAmount,
        `Invoice line ${it.id} category tax`,
      );
      prev.freeUnits += Math.max(0, Math.trunc(Number(it.promoFreeUnits ?? 0) || 0));
      prev.unitPrice = Number(it.unitPrice); // most-recent line wins for display
      prev.sample = it;
      byTarget.set(key, prev);
    }
  }
  return { existingById, ambiguousLineIds, byTarget, freeformSkipped };
}
