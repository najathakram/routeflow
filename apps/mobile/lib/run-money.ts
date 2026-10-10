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
import type { InvoiceStatus } from "@routeflow/types";

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

/**
 * B810: EVERY payable invoice (DRAFT/SENT/PARTIAL/OVERDUE — mirrors the
 * server's own payment write path, recordDeliveryPaymentInTx), each carrying
 * a server-computed `balanceDue` (B421's formula: total - confirmed
 * payments). This is `orderAmountDue`'s basis now, not `RunMoneyInvoice`
 * above (which stays `reconciledAmountDue`'s DRAFT-only reconcile basis,
 * unchanged) — fixes a SENT/PARTIAL invoice reading the full order total
 * instead of what's actually still owed. NEVER derive `balanceDue`
 * client-side (B305's standing rule, extended here to every status).
 */
export interface RunMoneyPayableInvoice {
  id: string;
  status: InvoiceStatus;
  total: number | string | null;
  balanceDue: number | string | null;
  /**
   * SA-102's WP-D1 shape (server-computed, see run-invoice-balance.ts): true
   * when this invoice IS the order's own live bill (its sole non-void
   * invoice, no deliveryBatchId, carrying a deposit) rather than a
   * separately-finalized one. Feeds `reconciledDoorDue`'s three-way rule.
   */
  isDepositMirror?: boolean;
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
  /** ALL of the order's open draft invoices (RULING 1 — never just the first).
   *  `reconciledAmountDue`'s own reconcile basis only — see `payableInvoices`
   *  below for `orderAmountDue`'s basis (B810). */
  invoices?: RunMoneyInvoice[];
  /** B810: see `RunMoneyPayableInvoice`'s own docstring. */
  payableInvoices?: RunMoneyPayableInvoice[];
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

/**
 * Σ non-CANCELLED lines' `lineItemSubtotal` — the ACTIVE line subtotal a
 * fresh invoice would be SEEDED from right now (`createSplitInvoices`'s
 * first pass, SA-092). Used by `orderAmountDue`'s own fallback and, as
 * `ReconciledAmountDueInput.activeSubtotal`, to give `reconciledAmountDue`
 * the discount's seeding share — see that function's docstring.
 */
export function activeOrderSubtotal(order: RunMoneyOrder): number {
  return roundMoney(
    (order.lineItems ?? [])
      .filter((li) => li.status !== "CANCELLED")
      .reduce((sum, li) => sum + lineItemSubtotal(li), 0),
  );
}

export function sumStopOrders(stop: RunMoneyStop): number {
  return (stop.orders ?? []).reduce((sum, order) => sum + sumOrderLineItems(order), 0);
}

/**
 * B810: the driver "amount due" is the SUM of every PAYABLE invoice's
 * server-computed `balanceDue` (DRAFT/SENT/PARTIAL/OVERDUE — mirrors
 * recordDeliveryPaymentInTx's own predicate, the driver's actual payment
 * write path) — not just open drafts (REG-B305 round 2's original basis).
 * An order whose invoice has already progressed to SENT/PARTIAL used to fall
 * through to the order-total formula below, showing the FULL order total and
 * ignoring any payment already collected. Only entries with a finite
 * `balanceDue` count; a malformed one is skipped rather than poisoning the
 * sum (same defensive shape REG-B305 round 2 established for `total`).
 *
 *  (a) one or more payable invoices with a finite `balanceDue` -> Σ those
 *      balances, rounded — DRAFT's own balanceDue reduces to its `total`
 *      when it carries no payments, byte-identical to before B810;
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
 *        due = subtotal − discount×r + order.shippingFee + regularTax +
 *          categoryTax — shippingFee stays WHOLE. discount and regularTax
 *          BOTH scale by r (SA-092b: `r = subtotal / (orderSubtotal || 1)`,
 *          the exact `Number(order.subtotal) || 1` pattern
 *          `rebuildSiblingDrafts`/`reconcileOrderDraftInvoice` use) — never
 *          prorated is WRONG as a blanket claim (an earlier round's own
 *          error): the driver's actual completion path
 *          (`completeWithPayment` -> `recordDeliveryPaymentInTx`, no
 *          existing draft -> `createInvoiceFromOrder` -> `createSplitInvoices`
 *          over the FULL order, first pass, share r=1 so discount SEEDS
 *          whole -> `reconcileOrderDeliveredInvoices`, byte-identical for a
 *          single group to `reconcileOrderDraftInvoice(delivered)`, which
 *          keeps that seeded discount unchanged) means r is 1 in the
 *          overwhelming majority of reads, but the formula itself DOES
 *          scale by r whenever the active line set diverges from
 *          `order.subtotal` (a stale/partial client snapshot) — exactly
 *          mirroring how `createSplitInvoices`'s own proportional-discount
 *          formula (invoices.service.ts ~1172) computes the SAME ratio on
 *          its first pass, at share 1.0 on this path.
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
  const payable = order.payableInvoices ?? [];
  const finiteTotals = payable
    .map((i) => finiteOrNull(i.balanceDue))
    .filter((n): n is number => n != null);
  if (finiteTotals.length > 0) {
    return roundMoney(finiteTotals.reduce((sum, n) => sum + n, 0));
  }

  const subtotal = activeOrderSubtotal(order);
  const orderSubtotal = finiteOrNull(order.subtotal);
  if (orderSubtotal == null) {
    // B305 PR B review (Opus, narrowed SA-092b): `order.subtotal` itself
    // missing means the WHOLE RUN_STOP_INCLUDE-driven projection (order.tax,
    // discountAmount, shippingFee, and the caller's isTaxExempt) may be just
    // as unpopulated — the exact shape of an OTA shipping this fix ahead of
    // #1272's server deploy (expo-updates ships with no store-build gate).
    // `li.categoryTaxAmount` is a DIFFERENT, already-live projection
    // (RUN_LINE_ITEMS_SELECT), so without this bail the tax math below would
    // still charge it — to an EXEMPT customer too, since `isTaxExempt` would
    // silently read `undefined` (never `true`). A genuinely-zero
    // `order.subtotal` is NOT this case (the field IS present and IS a real
    // number) — it flows through the normal formula below, `r` landing at 0
    // via `orderSubtotal || 1`, exactly as the server treats a $0 order.
    return roundMoney(subtotal);
  }
  const r = subtotal / (orderSubtotal || 1);

  const discount = (finiteOrNull(order.discountAmount) ?? 0) * r;
  const shippingFee = Math.max(0, finiteOrNull(order.shippingFee) ?? 0);

  if (isTaxExempt) {
    return roundMoney(subtotal - discount + shippingFee);
  }

  const regularTax = roundMoney((finiteOrNull(order.tax) ?? 0) * r);
  const categoryTax = roundMoney(
    (order.lineItems ?? [])
      .filter((li) => li.status !== "CANCELLED")
      .reduce((sum, li) => sum + (finiteOrNull(li.categoryTaxAmount) ?? 0), 0),
  );

  return roundMoney(subtotal - discount + shippingFee + regularTax + categoryTax);
}

/**
 * B810 (SA-125): the door figure while actively reconciling a visit is
 * `reconciledAmountDue(...) + earlierVisitsRemaining(...)` — the fresh
 * estimate for what THIS visit is delivering, plus whatever remains on
 * invoices already issued on an EARLIER visit (a prior partial delivery of
 * the same multi-visit order). Excludes DRAFT: a draft is what THIS visit's
 * reconcile rebuilds/creates, so including it here would double-count with
 * `reconciledAmountDue`'s own figure. Never scaled by the delivered share —
 * each is already a fixed, previously-issued amount, not an estimate.
 */
export function earlierVisitsRemaining(payableInvoices: RunMoneyPayableInvoice[]): number {
  const finite = payableInvoices
    .filter((i) => i.status !== "DRAFT")
    .map((i) => finiteOrNull(i.balanceDue))
    .filter((n): n is number => n != null);
  return roundMoney(finite.reduce((sum, n) => sum + n, 0));
}

/**
 * SA-130a (Opus round on B810/SA-125): the SA-125 shape above
 * (`reconciledAmountDue(...) + earlierVisitsRemaining(...)`, unconditionally
 * added) double-counts once an order has NO open draft and its only payable
 * is a plain, already-finalized invoice — a SENT $100 invoice with a 6-of-10
 * short-pick re-derived `reconciledAmountDue` to ~$90 and then ADDED the
 * invoice's own $100 on top (~$190), when the answer is simply $100: a
 * previously-issued invoice doesn't retroactively change because a LATER
 * visit short-picks. This function is the caller's ONE decision point,
 * per order, on the reconciled (active short-pick) path:
 *
 *  (a) an open draft exists (`hasOpenDraft`) -> `reconciledEstimate` (already
 *      computed by the caller from THIS order's own drafts, byte-identical
 *      to the pre-SA-130a call) plus `earlierVisitsRemaining` over the
 *      non-DRAFT payables — unchanged from SA-125, and also covers the case
 *      of NO payable invoice at all yet (earlierVisitsRemaining is 0, so
 *      this reduces to the bare estimate — the pre-B810 no-invoice shape).
 *  (b) no open draft, and the ONLY payable is a deposit mirror
 *      (`isDepositMirror`) -> the mirror IS this order's own bill, so it's
 *      legitimate to restate it against the delivered share via
 *      `reconciledEstimate` (computed by the caller the SAME way, with an
 *      empty `drafts` — `reconciledAmountDue`'s own fallback basis), then
 *      subtract whatever the mirror already collected
 *      (`mirror.total - mirror.balanceDue`) so a part-paid deposit is never
 *      re-billed in full.
 *  (c) no open draft, a plain (non-mirror) payable -> Σ `balanceDue` ONLY,
 *      no reconciled term at all — a finalized invoice is the bill, full
 *      stop, regardless of what a later visit short-picks.
 *
 * `reconciledAmountDue` itself is UNCHANGED by this round — only this
 * caller-side composition (payment.tsx) changes.
 */
/** total - balanceDue for one payable invoice — how much of it is already paid. Never negative-poisoning: a malformed field is treated as 0. */
function alreadyPaidOn(inv: RunMoneyPayableInvoice): number {
  return (finiteOrNull(inv.total) ?? 0) - (finiteOrNull(inv.balanceDue) ?? 0);
}

export function reconciledDoorDue(input: {
  hasOpenDraft: boolean;
  reconciledEstimate: number;
  payableInvoices: RunMoneyPayableInvoice[];
}): number {
  const { hasOpenDraft, reconciledEstimate, payableInvoices } = input;
  if (hasOpenDraft || payableInvoices.length === 0) {
    // B822 (round 2): `reconciledEstimate` is re-derived from the order's own
    // CURRENT line items — it has no idea a confirmed payment (e.g. an
    // applied advance) already landed against THIS visit's own draft(s), so
    // that must be subtracted here too, not just assumed away. With no
    // payable invoice at all yet, both sums are 0, so this correctly reduces
    // to the bare estimate — the pre-B810 no-invoice shape — rather than
    // falling into case (c)'s pure-balance-sum (which would wrongly return 0
    // instead of the estimate).
    const draftAlreadyPaid = payableInvoices
      .filter((i) => i.status === "DRAFT")
      .reduce((sum, i) => sum + alreadyPaidOn(i), 0);
    // Round 3: floor the draft-netted estimate at 0 BEFORE adding
    // earlierVisitsRemaining — a draft overpayment (an advance exceeding
    // what THIS visit's re-derived estimate says is owed) must never bleed
    // negative into (and silently discount) an unrelated SENT balance from
    // an earlier visit.
    return roundMoney(
      Math.max(0, reconciledEstimate - draftAlreadyPaid) + earlierVisitsRemaining(payableInvoices),
    );
  }
  const soleMirror =
    payableInvoices.length === 1 && payableInvoices[0]!.isDepositMirror
      ? payableInvoices[0]!
      : null;
  if (soleMirror) {
    // Round 2: floor at 0 — a mirror restated DOWN by a short-pick (a
    // partial delivery billing less than what was already collected as a
    // deposit) must never go negative; the excess is a refund/credit
    // question for the office, not something this quote surfaces as a
    // negative "amount due".
    return roundMoney(Math.max(0, reconciledEstimate - alreadyPaidOn(soleMirror)));
  }
  // (c) round 2: sum EVERY payable's balanceDue, including a DRAFT one —
  // `hasOpenDraft` is already false in this branch (from `o.invoices`, the
  // separate DRAFT-only projection), so a DRAFT entry reaching here is not
  // "this visit's own draft" being double-counted; excluding it via
  // `earlierVisitsRemaining` (built for case (a)'s different semantics)
  // would silently drop it from the total instead.
  return roundMoney(payableInvoices.reduce((sum, i) => sum + (finiteOrNull(i.balanceDue) ?? 0), 0));
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
  shortPickLines: ReadonlyArray<{ orderItemId: string; needsEntry?: boolean }>,
  deliveredQtyById: Record<string, number>,
): number {
  const shortPickIds = new Set(shortPickLines.map((l) => l.orderItemId));
  const restricted = lineItems.filter((li) => li.id != null && shortPickIds.has(li.id));
  // SA-367a: a line served no `remaining` and not yet entered has NO default — 0 here, exactly as
  // its subtotal half (short-pick.ts#effectiveDeliveredQty) — never deliveredCategoryTax's
  // "absent = fully delivered", which would quote its full excise against a $0 subtotal.
  const plan = { ...deliveredQtyById };
  for (const l of shortPickLines) {
    if (l.needsEntry && plan[l.orderItemId] == null) plan[l.orderItemId] = 0;
  }
  return deliveredCategoryTax(restricted, plan);
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
  /**
   * SA-092b: the order's FULL active (non-CANCELLED) line subtotal — NOT
   * `deliveredSubtotal` below. Used ONLY when no draft exists, to compute
   * the discount's SEEDING share (`activeSubtotal / order.subtotal`): the
   * server seeds a fresh invoice's discount at the active-line share
   * (`createSplitInvoices`, first pass) and the delivered-basis rebuild
   * (`reconcileOrderDeliveredInvoices`, byte-identical for a single group
   * to `reconcileOrderDraftInvoice(delivered)`) keeps that seeded figure
   * UNCHANGED — it is never re-scaled by how much was actually delivered.
   * Applying the delivered share here instead would under-subtract the
   * discount on every short pick. Optional: defaults to `order.subtotal`
   * itself (seeding share 1, i.e. the discount stays whole) when omitted,
   * matching every caller's behavior before this field existed. Ignored
   * when a draft already exists — its stored `discount` IS the seeded
   * figure, used as-is.
   */
  activeSubtotal?: number;
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
 * `deliveredCategoryTax`, and shipping fee stays WHOLE. SA-092b: discount
 * does NOT share regularTax's delivered-share scaling — when no draft
 * exists it scales by the discount's own SEEDING share instead
 * (`activeSubtotal / orderSubtotal`, see `ReconciledAmountDueInput.activeSubtotal`),
 * because the server seeds a fresh invoice's discount at the active-line
 * share and the delivered-basis rebuild (`reconcileOrderDeliveredInvoices`,
 * byte-identical for a single group to `reconcileOrderDraftInvoice(delivered)`)
 * keeps that seeded figure unchanged — never re-scaled by delivered qty.
 * When a draft already exists, its own stored `discount` is used as-is (it
 * already IS the seeded figure). B305 round 5: discount/shippingFee source
 * from the open draft(s) when one exists, else the ORDER's own columns —
 * previously NO drafts meant an early return of the bare pre-tax
 * `deliveredSubtotal`, which is the DEFAULT state pre-completion (the server
 * only creates a draft at stop-completion), so a short-picked stop omitted
 * tax on every normal delivery. Still falls back to the bare
 * `deliveredSubtotal` only when the order's own subtotal isn't a usable
 * basis at all (<=0 or missing) — prorating against zero would divide by
 * zero, and that shape means the order projection itself is incomplete, not
 * merely undrafted.
 */
export function reconciledAmountDue(input: ReconciledAmountDueInput): number {
  const deliveredSubtotal = Number.isFinite(input.deliveredSubtotal) ? input.deliveredSubtotal : 0;
  const orderSubtotal = finiteOrNull(input.order?.subtotal);
  if (orderSubtotal == null || !(orderSubtotal > 0)) {
    return deliveredSubtotal;
  }

  const drafts = input.drafts ?? [];
  // SA-092b: the discount's SEEDING share — defaults to orderSubtotal itself
  // (seeding share 1, discount stays whole) when the caller doesn't supply
  // activeSubtotal, matching every pre-existing caller's behavior.
  const activeSubtotal = Number.isFinite(input.activeSubtotal)
    ? (input.activeSubtotal as number)
    : orderSubtotal;
  const rSeed = activeSubtotal / orderSubtotal;
  const discount =
    drafts.length > 0
      ? drafts.reduce((sum, d) => sum + (finiteOrNull(d.discount) ?? 0), 0)
      : (finiteOrNull(input.order?.discountAmount) ?? 0) * rSeed;
  const shippingFee =
    drafts.length > 0
      ? drafts.reduce((sum, d) => sum + (finiteOrNull(d.shippingFee) ?? 0), 0)
      : Math.max(0, finiteOrNull(input.order?.shippingFee) ?? 0);

  // B305 round 3: an exempt customer's server-side reconcile
  // (invoices.service.ts#reconcileOrderDeliveredInvoices) zeroes BOTH the
  // regular tax term and the per-line category tax — reproduce that
  // exactly, or a short-picked stop over-collects at the door. `discount`
  // above already carries its own seeding-share scaling (or is used as-is
  // from a draft); shipping fee stays whole either way.
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
