import { computeLineSubtotal } from "./pricing";
import type { InvoiceTreatment } from "./api/tracked-categories";

/**
 * One order/cart line as seen by the invoice-split preview. Mirrors the fields
 * `computeLineSubtotal` needs plus the line's regulated category (or null/undefined
 * for a standard line) — never money the server hasn't already priced.
 */
export interface InvoiceSplitLineInput {
  trackedCategoryId?: string | null;
  unitPrice: number;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
}

/** The subset of TrackedCategory this helper needs — id/name for grouping + display,
 *  invoiceTreatment to decide standard-fold vs own-invoice. */
export interface InvoiceSplitCategory {
  id: string;
  name: string;
  invoiceTreatment: InvoiceTreatment;
}

export interface InvoiceSplitGroup {
  /** "Standard" for the non-split group, else the regulated category's name. */
  label: string;
  count: number;
  /** Pre-tax subtotal for this group only — NEVER a total, NEVER includes tax. */
  subtotal: number;
}

export interface InvoiceSplitPreview {
  groups: InvoiceSplitGroup[];
  /** True only when the order splits into more than one invoice (`groups.length > 1`).
   *  A single group (willSplit=false) means the order creates exactly ONE invoice,
   *  byte-identical to pre-split behavior — including a regulated-only cart whose one
   *  SEPARATE_INVOICE category is the sole group. Mirror this exactly: do not show
   *  any split UI in that case. */
  willSplit: boolean;
}

/**
 * Pure, display-only preview of how the server's `createSplitInvoices` will
 * partition an order's lines into invoices — mirrors
 * apps/api/src/invoices/invoices.service.ts#groupOrderLinesForInvoicing EXACTLY
 * (verified by reading both the server rule and web's `CreateOrderModal`
 * `invoiceSplit` memo, which mirrors the same server rule):
 *
 *   - Resolve each line's category via its own `trackedCategoryId` (this helper
 *     takes that pre-resolved; the caller does the OrderItem-vs-product fallback).
 *   - A category forms its OWN group only when `invoiceTreatment === "SEPARATE_INVOICE"`.
 *   - Every other line — uncategorised, OR a regulated category whose treatment is
 *     SEPARATE_SECTION/LINE_TAX — folds into ONE "Standard" group.
 *   - Groups emit Standard first (only if non-empty), then one group per
 *     SEPARATE_INVOICE category, sorted by category name.
 *   - A single resulting group → willSplit=false (the server creates exactly ONE
 *     invoice). This covers both an all-standard cart AND a cart of only one
 *     SEPARATE_INVOICE category with no standard lines. willSplit is true only
 *     when groups.length > 1.
 *
 * MONEY: `subtotal` is the sum of each line's `computeLineSubtotal` (pre-tax) —
 * the exact same money-mirror function used everywhere else on mobile. This
 * function computes NO tax and NO order total; it must never be used for
 * anything beyond this preview, and its output must never be sent to the server.
 * The server is the sole source of truth for the real split and the real money.
 */
export function groupLinesForInvoiceSplit(
  lines: InvoiceSplitLineInput[],
  categoryById: Map<string, InvoiceSplitCategory>,
): InvoiceSplitPreview {
  const standard = { count: 0, subtotal: 0 };
  const separate = new Map<string, { name: string; count: number; subtotal: number }>();

  for (const li of lines) {
    const lineTotal = computeLineSubtotal({
      unitPrice: li.unitPrice,
      qty: li.qty,
      boxes: li.boxes ?? null,
      pieces: li.pieces ?? null,
      unitsPerBox: li.unitsPerBox ?? null,
    });
    const cat = li.trackedCategoryId ? categoryById.get(li.trackedCategoryId) : undefined;
    if (cat && cat.invoiceTreatment === "SEPARATE_INVOICE") {
      const g = separate.get(cat.id) ?? { name: cat.name, count: 0, subtotal: 0 };
      g.count += 1;
      g.subtotal += lineTotal;
      separate.set(cat.id, g);
    } else {
      standard.count += 1;
      standard.subtotal += lineTotal;
    }
  }

  const groups: InvoiceSplitGroup[] = [];
  if (standard.count > 0) groups.push({ label: "Standard", ...standard });
  for (const g of Array.from(separate.values()).sort((a, b) => a.name.localeCompare(b.name))) {
    groups.push({ label: g.name, count: g.count, subtotal: g.subtotal });
  }

  // A split only happens when the server would emit more than one group. A single
  // group — whether it's the Standard group, or one SEPARATE_INVOICE category with
  // no standard lines — makes createSplitInvoices create exactly ONE invoice
  // (invoiceGroupId=null), byte-identical to pre-split behavior. Gating on
  // `separate.size > 0` would wrongly claim a split for a regulated-only cart.
  return { groups, willSplit: groups.length > 1 };
}
