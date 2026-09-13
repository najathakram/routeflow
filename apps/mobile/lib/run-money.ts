/**
 * REG-B49 (spec R2): every driver money figure must derive from the server's
 * box-aware line money, never `qty * unitPrice` — for a boxed line
 * (`unitsPerBox > 1`) that multiplies the box price by the PIECE count and
 * over-charges by `unitsPerBox`. Prefer the server-computed `subtotal` when
 * the line carries one (it may arrive as a Prisma Decimal string over the
 * wire); fall back to `computeLineSubtotal` (mirrors the server's own boxed
 * proration) only when it doesn't. Pure — no React import — Jest-testable.
 */
import { computeLineSubtotal, roundMoney } from "@routeflow/pricing";

export interface RunMoneyLineItem {
  /** OrderItem id — the key `deliveredQtyById` (short-pick's `orderItemId`) uses. */
  id?: string;
  qty: number;
  unitPrice: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  /** Prisma Decimal — may arrive as a string over the wire. */
  subtotal?: number | string | null;
  /**
   * B305 round 2 (RULING 3): sale-time snapshot of this line's regulated
   * category tax (sales.prisma OrderItem.categoryTaxAmount, projected by
   * RUN_LINE_ITEMS_SELECT). Prisma Decimal — may arrive as a string.
   */
  categoryTaxAmount?: number | string | null;
}

/**
 * REG-B305 round 2 (RULING 1): ONE of the order's OPEN DRAFT INVOICES, as the
 * server last computed it (status DRAFT, deliveryBatchId null; `total =
 * subtotal + taxAmount + shippingFee - discount`, `taxAmount` already folds
 * regular + category tax). A regulated SEPARATE_INVOICE order can have
 * SEVERAL of these open at once (base + `-R#` siblings —
 * invoices.service.ts#reconcileSplitOrderDrafts) — `RunMoneyOrder.invoices`
 * is the FULL list, never just the first. This — not `Order.total` — is the
 * basis for the driver's amount due: `Order.total` carries NO discount and,
 * on a split delivery, the WHOLE shipping fee on every visit.
 */
export interface RunMoneyInvoice {
  id: string;
  subtotal: number | string | null;
  taxAmount: number | string | null;
  discount: number | string | null;
  shippingFee: number | string | null;
  total: number | string | null;
}

export interface RunMoneyOrder {
  lineItems: RunMoneyLineItem[];
  /** Prisma Decimals — may arrive as strings over the wire. */
  subtotal?: number | string | null;
  tax?: number | string | null;
  total?: number | string | null;
  /**
   * B305 round 2 (RULING 2): projected but NOT read by orderAmountDue's money
   * math any more — `Order.total` is already net of discount on the CREATE
   * path (orders.service.ts:2428) but not on edit/merge, so no client-side
   * `total - discountAmount` guess is ever safe (Opus round-2 finding). Kept
   * in the type/projection for potential display use.
   */
  discountAmount?: number | string | null;
  shippingFee?: number | string | null;
  /** ALL of the order's open draft invoices (RULING 1 — never just the first). */
  invoices?: RunMoneyInvoice[];
}

export interface RunMoneyStop {
  orders?: RunMoneyOrder[];
}

/** `Number(v)` guarded so null/""/non-finite input comes back `null`, never NaN. */
function finiteOrNull(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** One line's money — server subtotal when present, else the box-aware fallback. */
export function lineItemSubtotal(line: RunMoneyLineItem): number {
  if (line.subtotal != null && line.subtotal !== "") return Number(line.subtotal);
  return computeLineSubtotal({
    unitPrice: Number(line.unitPrice ?? 0),
    qty: Number(line.qty ?? 0),
    boxes: line.boxes ?? undefined,
    pieces: line.pieces ?? undefined,
    unitsPerBox: line.unitsPerBox ?? undefined,
  });
}

export function sumOrderLineItems(order: RunMoneyOrder): number {
  return (order.lineItems ?? []).reduce((sum, li) => sum + lineItemSubtotal(li), 0);
}

export function sumStopOrders(stop: RunMoneyStop): number {
  return (stop.orders ?? []).reduce((sum, order) => sum + sumOrderLineItems(order), 0);
}

/**
 * REG-B305 round 2 (RULING 1): the driver "amount due" is the SUM of every
 * open draft invoice's total, as the server last computed each — a regulated
 * split order can have several (base + `-R#` siblings), and each is real
 * money the invoice bills. Only drafts with a finite `total` count; a
 * malformed one is skipped rather than poisoning the sum.
 *
 *  (a) one or more drafts with a finite `total` -> Σ those totals, rounded;
 *  (b) else the pre-tax line sum (`sumOrderLineItems`) — RULING 2: `Order.total
 *      - discountAmount` is NEVER a safe fallback. `Order.total` is net of
 *      discount only on the CREATE path (orders.service.ts:2428); an
 *      edited/merged order can leave it stale, so a client-side re-derivation
 *      of the discount would silently disagree with what the server actually
 *      bills. Falling to the honest pre-tax line sum is a smaller, visible
 *      under-estimate rather than a confident wrong number.
 *
 * Every `Number()` is guarded by `Number.isFinite` (via `finiteOrNull`) —
 * this never returns NaN.
 */
export function orderAmountDue(order: RunMoneyOrder): number {
  const drafts = order.invoices ?? [];
  const finiteTotals = drafts
    .map((d) => finiteOrNull(d.total))
    .filter((n): n is number => n != null);
  if (finiteTotals.length > 0) {
    return roundMoney(finiteTotals.reduce((sum, n) => sum + n, 0));
  }

  return sumOrderLineItems(order);
}

export function stopAmountDue(stop: RunMoneyStop): number {
  return (stop.orders ?? []).reduce((sum, order) => {
    const due = orderAmountDue(order);
    return Number.isFinite(due) ? sum + due : sum;
  }, 0);
}

/**
 * REG-B305 round 2 (RULING 3): Σ over lines of that line's snapshotted
 * category tax scaled by its delivered/ordered qty share — reproduces
 * invoices.service.ts#buildInvoiceItemData's own per-unit proration for a
 * from-scratch (`prior` 0) delivered-basis bill: `categoryTaxAmount ==
 * storedCategoryTax * billQty / orderQty`. Per-unit excise concentrates on
 * whichever lines actually shipped, so — unlike prorating the draft's whole
 * `taxAmount` by subtotal share — this is EXACT, not an approximation.
 * `deliveredQtyById` is keyed by line id (== `orderItemId`, short-pick's
 * convention); a line missing from it defaults to fully delivered (matches
 * `short-pick.ts#buildDeliveries`). Guards qty <= 0 and non-finite inputs —
 * never NaN, never divides by zero.
 */
export function deliveredCategoryTax(
  lineItems: RunMoneyLineItem[],
  deliveredQtyById: Record<string, number>,
): number {
  let sum = 0;
  for (const li of lineItems) {
    const qty = Number(li.qty ?? 0);
    if (!(qty > 0)) continue;
    const categoryTax = finiteOrNull(li.categoryTaxAmount);
    if (!categoryTax) continue;
    const raw = li.id != null && li.id in deliveredQtyById ? deliveredQtyById[li.id] : qty;
    const delivered = Math.max(0, Math.min(Number(raw) || 0, qty));
    sum += (categoryTax * delivered) / qty;
  }
  return roundMoney(sum);
}

export interface ReconciledAmountDueInput {
  /**
   * ALL of the order's open draft invoices (RULING 1 — a regulated split
   * order can have several). Only `discount`/`shippingFee` are read — an
   * empty array falls back to `deliveredSubtotal` alone (legacy basis).
   */
  drafts: Array<Pick<RunMoneyInvoice, "discount" | "shippingFee">>;
  /** The ORDER's own projected subtotal/tax (Order columns, never the draft's). */
  order: { subtotal: number | string | null | undefined; tax: number | string | null | undefined };
  /** The delivered/short-picked share of the order's pre-tax line subtotal (`reconciledTotal`). */
  deliveredSubtotal: number;
  /** Σ each delivered line's category tax share — see `deliveredCategoryTax`. */
  deliveredCategoryTax: number;
}

/**
 * REG-B305 round 2 (RULING 3 — the short-pick estimate follows the SERVER's
 * own rule, invoices.service.ts#reconcileOrderDraftInvoice basis "delivered"):
 * `regularTax` scales with the delivered SHARE of the order's own subtotal
 * (`orderTax * (deliveredSubtotal / orderSubtotal)`, never the draft's whole
 * `taxAmount`), `categoryTax` is the caller's own per-line
 * `deliveredCategoryTax`, and discount/shipping fee stay WHOLE (the server
 * never prorates them). Falls back to the bare `deliveredSubtotal` (legacy)
 * when there is no open draft or the order's own subtotal isn't a usable
 * basis (<= 0) — prorating against zero would divide by zero.
 */
export function reconciledAmountDue(input: ReconciledAmountDueInput): number {
  const deliveredSubtotal = Number.isFinite(input.deliveredSubtotal) ? input.deliveredSubtotal : 0;
  const drafts = input.drafts ?? [];
  const orderSubtotal = finiteOrNull(input.order?.subtotal);
  if (drafts.length === 0 || orderSubtotal == null || !(orderSubtotal > 0)) {
    return deliveredSubtotal;
  }

  const orderTax = finiteOrNull(input.order?.tax) ?? 0;
  const discount = drafts.reduce((sum, d) => sum + (finiteOrNull(d.discount) ?? 0), 0);
  const shippingFee = drafts.reduce((sum, d) => sum + (finiteOrNull(d.shippingFee) ?? 0), 0);
  const categoryTax = Number.isFinite(input.deliveredCategoryTax) ? input.deliveredCategoryTax : 0;

  return roundMoney(
    deliveredSubtotal -
      discount +
      shippingFee +
      orderTax * (deliveredSubtotal / orderSubtotal) +
      categoryTax,
  );
}
