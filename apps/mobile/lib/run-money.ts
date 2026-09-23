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
  /**
   * B305 round 5: `orderAmountDue`'s fallback must exclude CANCELLED lines
   * from both the subtotal and the category-tax sum — the three line-cancel
   * writers (orders.service.ts) zero a line's `subtotal` but NOT its
   * `categoryTaxAmount`, so a cancelled regulated line keeps a stale
   * non-zero snapshot that would otherwise leak into the quote.
   */
  status?: string | null;
}

/**
 * REG-B305 round 2 (RULING 1): ONE of the order's OPEN DRAFT INVOICES, as the
 * server last computed it (status DRAFT, deliveryBatchId null; `total =
 * subtotal + taxAmount + shippingFee - discount`, `taxAmount` already folds
 * regular + category tax). A regulated SEPARATE_INVOICE order can have
 * SEVERAL of these open at once (base + `-R#` siblings —
 * invoices.service.ts#reconcileSplitOrderDrafts) — `RunMoneyOrder.invoices`
 * is the FULL list, never just the first. This — not `Order.total` — is the
 * basis for the driver's amount due when a draft exists: on a split
 * delivery, `Order.total` (were it ever read, which it isn't — see RULING 2
 * below) carries the WHOLE shipping fee on every visit, not each visit's
 * share. `Order.total`'s discount term is path-dependent (CREATE nets it,
 * every edit/merge drops it) — B305 round 5 corrected an earlier, wrong
 * blanket claim here that it "carries no discount"; it does on some paths.
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
   * B305 round 2 (RULING 2): `Order.total - discountAmount` is NEVER a safe
   * fallback — `Order.total` is net of discount only on the CREATE path
   * (orders.service.ts ~2166) but not on edit/merge, so a client-side
   * `total - discountAmount` guess would silently disagree with what the
   * server bills. RULING 2 still stands: `Order.total` itself is never read
   * here. B305 round 5: this column IS read directly (never combined with
   * `total`) — `orderAmountDue`'s and `reconciledAmountDue`'s fallbacks
   * subtract it, whole, from the order's own line subtotal, mirroring how
   * the server's own invoice bills a discount.
   */
  discountAmount?: number | string | null;
  shippingFee?: number | string | null;
  /** ALL of the order's open draft invoices (RULING 1 — never just the first). */
  invoices?: RunMoneyInvoice[];
}

export interface RunMoneyStop {
  orders?: RunMoneyOrder[];
  /**
   * B305 round 5: feeds `orderAmountDue`'s exemption gate the same way
   * `reconciledAmountDue`'s caller already does — an exempt customer's
   * server-side reconcile zeroes BOTH tax terms (invoices.service.ts), so
   * the fallback must too, or it over-collects at the door.
   */
  customer?: { isTaxExempt?: boolean };
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
 *  (b) else (B305 round 5 — the DEFAULT state for a route order: the server
 *      only creates/reconciles a draft at stop-completion time) the
 *      tax-inclusive quote over the order's own ACTIVE lines, mirroring
 *      `reconciledAmountDue`'s already-server-verified shape:
 *        subtotal = Σ non-CANCELLED lines' `lineItemSubtotal`
 *        regularTax = isTaxExempt ? 0 : order.tax × (subtotal / order.subtotal)
 *          — proportional, not read verbatim, so a line cancelled after
 *          `Order.subtotal`'s last write can't overstate it (r is 1 in the
 *          overwhelming majority of reads — `Order.subtotal` is recomputed
 *          fresh on every write this codebase's order-mutating paths use).
 *        categoryTax = isTaxExempt ? 0 : Σ non-CANCELLED lines'
 *          `categoryTaxAmount` at FULL stored value — this is a PRE-delivery
 *          quote (nothing has been short-picked yet), unlike
 *          `deliveredCategoryTax`'s delivered-share scaling for the
 *          post-delivery path; reusing that here would under-quote.
 *        due = subtotal − order.discountAmount + order.shippingFee +
 *          regularTax + categoryTax — discount/shippingFee stay WHOLE,
 *          never prorated, exactly as `reconciledAmountDue` already does
 *          (the server never prorates them either).
 *      RULING 2 stands unchanged: `Order.total` itself is never read here —
 *      its discount term depends on which write path last touched it
 *      (CREATE nets it, every edit/merge drops it), so it can never be a
 *      safe base. `Order.tax` and `Order.subtotal` carry no such ambiguity:
 *      every write path recomputes both fresh from the current line set.
 *
 * Every `Number()` is guarded by `Number.isFinite` (via `finiteOrNull`) —
 * this never returns NaN.
 */
export function orderAmountDue(order: RunMoneyOrder, isTaxExempt?: boolean): number {
  const drafts = order.invoices ?? [];
  const finiteTotals = drafts
    .map((d) => finiteOrNull(d.total))
    .filter((n): n is number => n != null);
  if (finiteTotals.length > 0) {
    return roundMoney(finiteTotals.reduce((sum, n) => sum + n, 0));
  }

  const active = (order.lineItems ?? []).filter((li) => li.status !== "CANCELLED");
  const subtotal = roundMoney(active.reduce((sum, li) => sum + lineItemSubtotal(li), 0));
  const orderSubtotal = finiteOrNull(order.subtotal);
  const r = orderSubtotal != null && orderSubtotal > 0 ? subtotal / orderSubtotal : 1;

  const discount = finiteOrNull(order.discountAmount) ?? 0;
  const shippingFee = Math.max(0, finiteOrNull(order.shippingFee) ?? 0);

  if (isTaxExempt) {
    return roundMoney(subtotal - discount + shippingFee);
  }

  const regularTax = roundMoney((finiteOrNull(order.tax) ?? 0) * r);
  const categoryTax = roundMoney(
    active.reduce((sum, li) => sum + (finiteOrNull(li.categoryTaxAmount) ?? 0), 0),
  );

  return roundMoney(subtotal - discount + shippingFee + regularTax + categoryTax);
}

export function stopAmountDue(stop: RunMoneyStop): number {
  const isTaxExempt = stop.customer?.isTaxExempt === true;
  return (stop.orders ?? []).reduce((sum, order) => {
    const due = orderAmountDue(order, isTaxExempt);
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

/**
 * REG-B305 round 4: the door quote's two halves MUST come from the SAME line
 * set. Round 3's `payment.tsx` fed `deliveredSubtotal` from the filtered
 * `shortPickLines` (`status !== "CANCELLED" && deliveredQty === 0`) but
 * `deliveredCategoryTax` from the RAW `o.lineItems` — and `deliveredCategoryTax`
 * defaults a line absent from `deliveredQtyById` to FULLY delivered (matches
 * `buildDeliveries`'s own default), so a CANCELLED regulated line, or a
 * regulated line already delivered on an earlier split-delivery visit, leaked
 * its FULL `categoryTaxAmount` into the quote while contributing zero
 * subtotal — cash over-collected at the door. The server never does this: it
 * excludes CANCELLED lines from every money projection
 * (invoices.service.ts's line select is `where status != CANCELLED`) and
 * bills only the CURRENT visit's delivered lines
 * (`reconcileOrderDraftInvoice` / `buildInvoiceItemData`, basis "delivered").
 * This helper restricts `lineItems` to the ids already present in
 * `shortPickLines` before delegating to `deliveredCategoryTax`, so a line
 * excluded from the subtotal (cancelled, or already delivered) is excluded
 * from the category tax the exact same way — never the plain "no entry ->
 * fully delivered" default that only makes sense for a line still in play.
 * `deliveredCategoryTax` itself is left unchanged: its default-to-fully-
 * delivered contract is correct for the lines `buildDeliveries` actually
 * plans against.
 */
export function shortPickCategoryTax(
  lineItems: RunMoneyLineItem[],
  shortPickLines: ReadonlyArray<{ orderItemId: string }>,
  deliveredQtyById: Record<string, number>,
): number {
  const shortPickIds = new Set(shortPickLines.map((l) => l.orderItemId));
  const restricted = lineItems.filter((li) => li.id != null && shortPickIds.has(li.id));
  return deliveredCategoryTax(restricted, deliveredQtyById);
}

export interface ReconciledAmountDueInput {
  /**
   * ALL of the order's open draft invoices (RULING 1 — a regulated split
   * order can have several). Only `discount`/`shippingFee` are read; an
   * empty array (B305 round 5 — the DEFAULT state pre-completion: the server
   * only creates/reconciles a draft at stop-completion time) falls back to
   * the ORDER's own `discountAmount`/`shippingFee` instead of skipping tax
   * the way this used to.
   */
  drafts: Array<Pick<RunMoneyInvoice, "discount" | "shippingFee">>;
  /** The ORDER's own projected fields (Order columns, never the draft's). */
  order: {
    subtotal: number | string | null | undefined;
    tax: number | string | null | undefined;
    /** B305 round 5: the no-draft fallback basis — see `drafts` above. */
    discountAmount?: number | string | null;
    shippingFee?: number | string | null;
  };
  /** The delivered/short-picked share of the order's pre-tax line subtotal (`reconciledTotal`). */
  deliveredSubtotal: number;
  /** Σ each delivered line's category tax share — see `deliveredCategoryTax`. */
  deliveredCategoryTax: number;
  /**
   * B305 round 3: the customer's exemption flag (sales.prisma
   * Customer.isTaxExempt, projected onto RUN_STOP_INCLUDE.customer.select).
   * Neither `order.tax` nor a line's `categoryTaxAmount` snapshot is
   * exemption-aware on its own — the server zeroes BOTH for an exempt
   * customer (invoices.service.ts ~1495-1500: `regularTax = isTaxExempt ? 0
   * : …`, `foldCategoryTax(…, isTaxExempt)` -> 0) — so this must be passed
   * separately.
   */
  isTaxExempt?: boolean;
}

/**
 * REG-B305 round 2 (RULING 3 — the short-pick estimate follows the SERVER's
 * own rule, invoices.service.ts#reconcileOrderDraftInvoice basis "delivered"):
 * `regularTax` scales with the delivered SHARE of the order's own subtotal
 * (`orderTax * (deliveredSubtotal / orderSubtotal)`, never the draft's whole
 * `taxAmount`), `categoryTax` is the caller's own per-line
 * `deliveredCategoryTax`, and discount/shipping fee stay WHOLE (the server
 * never prorates them). B305 round 5: discount/shippingFee source from the
 * open draft(s) when one exists, else the ORDER's own columns — previously
 * NO drafts meant an early return of the bare pre-tax `deliveredSubtotal`,
 * which is the DEFAULT state pre-completion (the server only creates a draft
 * at stop-completion), so a short-picked stop omitted tax on every normal
 * delivery. Still falls back to the bare `deliveredSubtotal` only when the
 * order's own subtotal isn't a usable basis at all (<=0 or missing) —
 * prorating against zero would divide by zero, and that shape means the
 * order projection itself is incomplete, not merely undrafted.
 */
export function reconciledAmountDue(input: ReconciledAmountDueInput): number {
  const deliveredSubtotal = Number.isFinite(input.deliveredSubtotal) ? input.deliveredSubtotal : 0;
  const orderSubtotal = finiteOrNull(input.order?.subtotal);
  if (orderSubtotal == null || !(orderSubtotal > 0)) {
    return deliveredSubtotal;
  }

  const drafts = input.drafts ?? [];
  const discount =
    drafts.length > 0
      ? drafts.reduce((sum, d) => sum + (finiteOrNull(d.discount) ?? 0), 0)
      : (finiteOrNull(input.order?.discountAmount) ?? 0);
  const shippingFee =
    drafts.length > 0
      ? drafts.reduce((sum, d) => sum + (finiteOrNull(d.shippingFee) ?? 0), 0)
      : Math.max(0, finiteOrNull(input.order?.shippingFee) ?? 0);

  // B305 round 3: an exempt customer's server-side reconcile
  // (invoices.service.ts#reconcileOrderDraftInvoice) zeroes BOTH the regular
  // tax term and the per-line category tax — reproduce that exactly, or a
  // short-picked stop over-collects at the door. Discount/shipping fee still
  // stay whole (the server never prorates them either way).
  if (input.isTaxExempt) {
    return roundMoney(deliveredSubtotal - discount + shippingFee);
  }

  const orderTax = finiteOrNull(input.order?.tax) ?? 0;
  const categoryTax = Number.isFinite(input.deliveredCategoryTax) ? input.deliveredCategoryTax : 0;

  return roundMoney(
    deliveredSubtotal -
      discount +
      shippingFee +
      orderTax * (deliveredSubtotal / orderSubtotal) +
      categoryTax,
  );
}
