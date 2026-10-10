import { roundMoney } from "@routeflow/pricing";
import {
  resolveStoredPOLineAmounts,
  type POItem,
} from "@/app/(dashboard)/inventory/_components/purchase-orders-shared";

/**
 * The money of a STORED purchase order, as the vendor-bills page's own Purchase Orders ledger
 * row reads it (B716 — B698's deferred fourth site). That is a page-local `PurchaseOrdersTab`,
 * distinct from the inventory `_components/PurchaseOrdersTab.tsx` the rest of B698 fixed.
 *
 * Extracted out of `page.tsx` so it can be pinned by a spec; the behaviour change is the line
 * fallback. A boxed line's stored `unitCost` is the per-piece cost at 4 dp, for costing only, so
 * summing `qtyOrdered x unitCost` re-multiplies a rounded figure — the exact drift B677 (#1199)
 * fixed on the store side: 1,000 cases of 12 at $11.00 is stored as $11,000.00 and the product
 * route reads $11,000.40. The stored exact figure is READ, never rebuilt from its rounded
 * components (L-204).
 *
 * This adds no derivation of its own: the line total comes from web's
 * `resolveStoredPOLineAmounts` (the mobile twin is `poLineSubtotal` in
 * `apps/mobile/lib/po-line-subtotal.ts`). A LIST row carries no `product.unitsPerBox` — the list
 * endpoint includes `items: true` with no product relation — so it is called at `unitsPerBox` 0,
 * which selects the per-piece branch and lets the row's stored `totalCost` win outright.
 *
 * Spec: `po-ledger-total.test.ts`.
 */

/**
 * A PO line as the LIST endpoint returns it — the same raw Prisma row `POItem` describes (every
 * Decimal a numeric string), narrowed to the three money fields this total needs rather than
 * redeclared. `totalCost` is a NOT NULL column, so a row without one is an unsaved or partial
 * shape, not something the API returns.
 */
export type POLedgerItem = Pick<POItem, "qtyOrdered" | "unitCost" | "totalCost">;

/** A purchase order as the vendor-bills ledger table renders it. */
export interface PORow {
  id: string;
  poNumber: string;
  status: string;
  supplier?: { id: string; name: string };
  expectedDate?: string;
  createdAt?: string;
  totalAmount?: number;
  items?: POLedgerItem[];
}

/**
 * The order's document total: the stored `totalAmount` whenever the row has one (every PO
 * `createPurchaseOrder` writes does), else the sum of the stored line totals.
 *
 * The stored figure has to be FINITE to win — a non-numeric one falls through to the line sum,
 * which beats rendering NaN — but not positive: a negative stored total is still the stored money
 * figure and renders as stored, never silently replaced by a derived sum on sign (lead ruling,
 * B716).
 */
export function poTotal(po: PORow): number {
  const stored = po.totalAmount != null ? Number(po.totalAmount) : NaN;
  if (Number.isFinite(stored)) return roundMoney(stored);
  const sum = (po.items ?? []).reduce(
    (acc, item) => acc + resolveStoredPOLineAmounts(item, 0).totalCost,
    0,
  );
  return Number.isFinite(sum) ? roundMoney(sum) : 0;
}
