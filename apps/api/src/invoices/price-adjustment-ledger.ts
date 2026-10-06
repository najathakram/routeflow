import { BadRequestException, ConflictException, Logger } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import {
  computeCategoryTax,
  computeLineSubtotal,
  inferredGoodsFlatRate,
  packFromOwnSplit,
  regulatedUnitBasis,
  roundMoney,
  type CategoryTaxType,
} from "@routeflow/pricing";
import type { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  assertInvoiceTotalsSane,
  assertNoNegativeLineSubtotal,
  storedInvoiceTotals,
} from "../common/money-invariants.util";
import type { PriceAdjustmentOverpaidInvoice } from "@routeflow/types";
import { isNsfLine } from "./nsf-line";
import { sumConfirmed, type ConfirmablePaymentRow } from "./payment-predicates";

const logger = new Logger("PriceAdjustment");

/** The `code` a Nest exception body carries (a plain-string exception has none). */
function codeOf(e: BadRequestException | ConflictException): string | undefined {
  const body = e.getResponse();
  return typeof body === "object" ? (body as { code?: string }).code : undefined;
}

/**
 * B1058 (SA-651/SA-683): the guards below throw plain-string 400s (shared with create()/update()). Tag the
 * ones THIS flow owns with MONEY_INVARIANT at the source, same message, so a bulk run can tell a re-judge
 * refusal from an unknown fault by its code instead of guessing from "is it a 400".
 */
function tagMoneyInvariant<T>(guard: () => T): T {
  try {
    return guard();
  } catch (e) {
    if (e instanceof BadRequestException && !codeOf(e))
      throw new BadRequestException({ code: API_ERROR_CODES.MONEY_INVARIANT, message: e.message });
    throw e;
  }
}

/**
 * B662: keep the regulated ledger equal to a re-priced invoice, inside the SAME transaction as the invoice
 * write. ONE mechanism per document state (Senior Architect ruling 2026-09-21):
 *   - DRAFT: the very re-sync `update()` uses (`resyncInvoiceLedger`: reverse the net the ledger holds for
 *     each line, then write fresh SALE rows). A correction row hung on a SALE that a draft re-sync later
 *     reverses would be an orphan that double counts, so a draft never gets one.
 *   - ISSUED: an append-only CORRECTION row per re-priced regulated line, booked in the current period and
 *     pointing at the SALE it corrects (`correctSaleForPriceChange`). A filed period is never reopened; an
 *     invoice that later returns to draft re-syncs over the SALE AND its corrections.
 * Ordinary (non-regulated) lines have no ledger row and are skipped either way.
 */
export async function syncLedgerAfterPriceChange(
  deps: {
    ledger: Pick<RegulatedLedgerService, "correctSaleForPriceChange">;
    resync: (invoiceId: string, orderId: string | null, items: any[], db: any) => Promise<void>;
  },
  inv: { id: string; status: string; orderId?: string | null },
  items: any[],
  adjustedItemIds: Set<string>,
  tx: any,
): Promise<void> {
  if (inv.status === InvoiceStatus.DRAFT) {
    if (items.some((li) => li.trackedCategoryId)) {
      await deps.resync(inv.id, inv.orderId ?? null, items, tx);
    }
    return;
  }
  const lines = items
    .filter((li) => li.trackedCategoryId && adjustedItemIds.has(li.id))
    .map((li) => ({
      invoiceItemId: li.id as string,
      qty: Number(li.qty),
      netSales: Number(li.subtotal),
      categoryTax: Number(li.categoryTaxAmount ?? 0),
      boxes: li.boxes ?? null,
      unitsPerBox: li.unitsPerBox ?? null,
      promoFreeUnits: li.promoFreeUnits ?? null,
    }));
  if (lines.length > 0) {
    await deps.ledger.correctSaleForPriceChange({ invoiceId: inv.id, lines, db: tx });
  }
}

/**
 * B1120: a re-priced line's total (after its stored line discount) AT `newPrice`, a whole-cent price already
 * rounded by the caller. The line is priced from its OWN numbers through `computeLineSubtotal`, the same
 * helper every other line writer uses (a box + loose pieces split at the BOX price, free units taken off
 * first, a loose line at `price x qty`), never from a multiplier recovered out of the stored subtotal: that
 * subtotal is already rounded, so `subtotal / oldPrice` is not the quantity (50.13 / 8.36 = 5.9964 for six),
 * and a fractional multiplier drifted a few cents on every repeat adjust.
 *
 * The pack comes from the line's own snapshot, else from its OWN boxes/pieces/qty (`packFromOwnSplit`), never
 * from the live product (which may have been repacked since). A line that HAS a box split but whose pack
 * neither source yields (a legacy `boxes: 0, pieces: N` line with no snapshot) cannot be priced from its
 * fields, and reading the split as loose pieces would bill the BOX price per piece. That one shape keeps the
 * proportional recovery `newPrice x (gross / oldPrice) - discount`, where gross = stored subtotal + discount.
 * It is only sound while that ratio exists: a stored price of 0, or a stored gross that rounded to 0, carries
 * NO memory of the quantity, and falling back to `qty` bills the pieces at the case price (a 12x overcharge)
 * while a ratio of 0 prices the line at $0.00 for good. So a re-price to a price above 0 from such a row is
 * REFUSED (400 MONEY_INVARIANT, naming the line), and so is a positive price whose NEW gross rounds to $0.00
 * (a 0.01 typo would strand the line the same way); a new price of 0 is allowed. SA-698a, SA-698b N2. The
 * remedy in the copy depends on the invoice: a DRAFT can be edited, an issued one needs a credit note or a
 * void and reissue (SA-698b N1).
 *
 * The recovery divides an ALREADY-ROUNDED stored subtotal, so it re-bases the total a little on each CHANGED
 * price: a round trip A -> B -> A can land up to (1/2 cent) x A / B + 1/2 cent away from where it began, which
 * is at most 1 cent whenever B is at least half of A (pinned by an executed sweep and a real-rows case in the
 * B1120 specs). Re-applying the SAME price never reaches this function at all (see
 * `buildPriceAdjustmentUpdates`). Only a legacy row can carry this shape; every other line prices from its own
 * fields (a derivable-pack line restores exactly from $0).
 */
/** N1: the remedy named in a refusal. An issued invoice cannot be edited line by line, so it never says "re-enter". */
const refusalRemedy = (status: string | undefined): string =>
  status === InvoiceStatus.DRAFT
    ? "Re-enter this line's quantity and price."
    : "Issue a credit note, or void and reissue the invoice.";

function repricedLineTotal(
  line: any,
  newPrice: number,
  discount: number,
  invoiceStatus?: string,
): number {
  const qty = Number(line.qty);
  const hasSplit = line.boxes != null || line.pieces != null;
  const snapshot = Number(line.unitsPerBox ?? 0);
  const pack =
    snapshot > 1 ? snapshot : packFromOwnSplit({ qty, boxes: line.boxes, pieces: line.pieces });
  if (hasSplit && pack == null) {
    const oldUnitPrice = Number(line.unitPrice);
    const gross = Number(line.subtotal) + discount;
    if (!(newPrice > 0)) return roundMoney(-discount); // a price of 0 zeroes the gross whatever the quantity was
    const label = `Line item "${line.description ?? "item"}"`;
    if (!(oldUnitPrice > 0) || !(gross > 0)) {
      throw new BadRequestException({
        code: API_ERROR_CODES.MONEY_INVARIANT,
        message:
          `${label} can't be re-priced: its stored price or total is $0, so its quantity can't be ` +
          `recovered from them. ${refusalRemedy(invoiceStatus)}`,
      });
    }
    const newGross = newPrice * (gross / oldUnitPrice);
    if (!(roundMoney(newGross) > 0)) {
      throw new BadRequestException({
        code: API_ERROR_CODES.MONEY_INVARIANT,
        message:
          `${label} can't be re-priced to $${newPrice.toFixed(2)}: its total would round to $0.00 and its ` +
          `quantity could not be recovered afterwards. Enter a higher price.`,
      });
    }
    return roundMoney(newGross - discount);
  }
  const beforeDiscount = computeLineSubtotal({
    unitPrice: newPrice,
    qty,
    boxes: line.boxes,
    pieces: line.pieces,
    unitsPerBox: pack,
    freeUnits: line.promoFreeUnits,
  });
  return roundMoney(beforeDiscount - discount);
}

/**
 * The per-line writes of `applyPriceAdjustment` (moved here so `invoices.service.ts` holds flat, B662): the
 * new unit price and subtotal, and, for a REGULATED line, the category tax re-derived from the NEW subtotal
 * (F03/R3/T-B57). An exempt customer owes $0 of category tax just as they owe $0 of the regular tax
 * (foldCategoryTax's contract), so re-deriving it would bill excise the creation path correctly zeroed.
 * B1120: the price is rounded to whole cents HERE, before it is written or priced from (every unit price
 * column is numeric(10,2); the DTO already refuses a 3rd decimal, this is the write-site guarantee for every
 * caller, the bulk map included), so the stored price and the stored line total can never disagree.
 * Pure: it only reads its arguments.
 */
export function buildPriceAdjustmentUpdates(args: {
  items: any[];
  localPriceMap: Map<string, number>;
  categoriesById: Map<string, any>;
  unitsPerBoxByProduct: Map<string, number>;
  isTaxExempt: boolean;
  /** The invoice's status: it picks the remedy in a refusal's copy (a DRAFT can be edited, an issued one cannot). */
  invoiceStatus?: string;
}): Array<{ id: string; data: Record<string, any> }> {
  const { items, localPriceMap, categoriesById, unitsPerBoxByProduct, isTaxExempt, invoiceStatus } =
    args;
  // B679: mirrors orders.service.recomputeLineCategoryTaxes — a box-split line stores qty already in
  // pieces; a boxed selling-unit line expands by its snapshotted unitsPerBox, falling back to the
  // product's. Unused by PERCENT_OF_SALE (unitBasisQty is ignored there) but correct for an
  // EXCISE_PER_UNIT / PER_VOLUME / DEPOSIT_PER_CONTAINER line. Delegates to regulatedUnitBasis
  // (@routeflow/pricing) — the ONE place this conversion happens — instead of an independent copy of
  // its box-unaware fallback branch.
  const linePieceQty = (li: any): number =>
    regulatedUnitBasis(
      { qty: Number(li.qty) || 0, boxes: li.boxes, pieces: li.pieces, unitLabel: li.unitLabel },
      li.unitsPerBox ?? (li.productId ? unitsPerBoxByProduct.get(li.productId) : null) ?? 0,
    ).unitBasisQty;
  const updates: Array<{ id: string; data: Record<string, any> }> = [];
  for (const item of items) {
    const requested = localPriceMap.get(item.id);
    if (requested == null) continue;
    const newPrice = roundMoney(requested); // B1120: whole cents, the price the line is priced AT and stored as
    // SA-640 / SA-698b: a line whose price is UNCHANGED is left alone, BEFORE anything is re-derived or refused:
    // no new subtotal, no category tax, no negative-line judgement. The panel sends every line with its current
    // price, so re-deriving the untouched ones is what moved them (and refused a whole save over a line the
    // operator never touched). Untouched lines are never re-derived, never refused and never moved.
    if (newPrice === roundMoney(Number(item.unitPrice))) continue;
    const newSubtotal = repricedLineTotal(
      item,
      newPrice,
      Number(item.discount ?? 0),
      invoiceStatus,
    );
    const data: Record<string, any> = { unitPrice: newPrice, subtotal: newSubtotal };
    const category = item.trackedCategoryId ? categoriesById.get(item.trackedCategoryId) : null;
    if (category) {
      data.categoryTaxAmount = isTaxExempt
        ? 0
        : computeCategoryTax({
            taxType: category.taxType as CategoryTaxType,
            rate: Number(category.rate),
            unitBasisQty: linePieceQty(item),
            lineSubtotal: newSubtotal,
            priceIncludesTax: category.priceIncludesTax,
          });
    }
    updates.push({ id: item.id, data });
  }
  // B1031: the SAME guard create() and update() run, over the lines THIS re-price writes (a stored line it
  // leaves alone is not re-judged, SA-640): `newPrice * multiplier - lineDiscount` below zero stored a
  // negative line subtotal and lowered the invoice total. Pure, so it also covers the in-transaction call.
  tagMoneyInvariant(() =>
    assertNoNegativeLineSubtotal(
      updates.map((u) => ({
        description: items.find((i) => i.id === u.id)?.description ?? "item",
        subtotal: u.data.subtotal,
      })),
    ),
  );
  return updates;
}

type InvoiceTotalsFacts = {
  items: any[];
  discount?: unknown;
  shippingFee?: unknown;
  subtotal?: unknown;
  total?: unknown;
};

/**
 * THE totals arithmetic of a re-priced invoice, in one place: round the line sums, `taxAmount =
 * round(round(Σ subtotal x taxRate) + round(Σ categoryTaxAmount))`, `total = round(subtotal - discount +
 * shippingFee + taxAmount)`. The pre-flight projection (`projectedTotals`) and the tx write
 * (`commitPriceAdjustment`) BOTH call it, so the figure judged before a write is the figure the write stores
 * (B1058; the projected == written db case pins it).
 */
export function totalsFromLines(
  lines: ReadonlyArray<{ subtotal?: unknown; taxRate?: unknown; categoryTaxAmount?: unknown }>,
  invoice: { discount?: unknown; shippingFee?: unknown },
): { subtotal: number; taxAmount: number; total: number; discount: number } {
  const subtotal = roundMoney(lines.reduce((s, li) => s + Number(li.subtotal), 0));
  const regularTax = roundMoney(
    lines.reduce((s, li) => s + Number(li.subtotal) * Number(li.taxRate ?? 0), 0),
  );
  const categoryTax = roundMoney(lines.reduce((s, li) => s + Number(li.categoryTaxAmount ?? 0), 0));
  const taxAmount = roundMoney(regularTax + categoryTax);
  const discount = Number(invoice.discount ?? 0);
  const total = roundMoney(subtotal - discount + Number(invoice.shippingFee ?? 0) + taxAmount);
  return { subtotal, taxAmount, total, discount };
}

/**
 * The invoice's totals AS THEY WOULD BE after this re-price: the re-priced lines take their new subtotal and
 * levy, every other line keeps its stored one, then `totalsFromLines`. `flatRate` is B294's inferred rate,
 * which the tx stamps on every non-NSF line still at taxRate 0 BEFORE it totals; pass it only where the
 * projection must equal the stored total (the overpay judgment).
 */
function projectedTotals(
  inv: InvoiceTotalsFacts,
  updates: ReadonlyArray<{ id: string; data: Record<string, any> }>,
  flatRate?: number,
): { discount: number; subtotal: number; total: number } {
  const byId = new Map(updates.map((u) => [u.id, u.data]));
  const lines = inv.items.map((li) => {
    const line = byId.has(li.id) ? { ...li, ...byId.get(li.id) } : li;
    return flatRate != null && Number(line.taxRate ?? 0) === 0 && !isNsfLine(line)
      ? { ...line, taxRate: flatRate }
      : line;
  });
  return totalsFromLines(lines, inv);
}

/**
 * B1031 (SA ruling): the same invoice-level totals guard `create()` and `update()` run (discount above the
 * subtotal, negative total), judged on the invoice AS IT WOULD BE after this re-price (`projectedTotals`).
 * A lower price against a stored invoice discount can leave discount > subtotal on a SENT invoice, and one
 * bulk action can do it to many. Pure, so it runs before any write, in the same pass as the line guard.
 */
export function assertAdjustedTotalsSane(
  inv: InvoiceTotalsFacts,
  updates: ReadonlyArray<{ id: string; data: Record<string, any> }>,
): void {
  const after = projectedTotals(inv, updates);
  // SA-651 NOT-WORSE: judged against the invoice's STORED totals, so a legacy invoice that is already
  // insane still takes a re-price that does not make it worse (a price raise), never refusing every one.
  tagMoneyInvariant(() => assertInvoiceTotalsSane(after, storedInvoiceTotals(inv)));
}

/**
 * The two reads the category-tax reference needs: a tenant client (the pre-flight) or a transaction (the write).
 * Structural, so a Prisma client, a tenant-extended client and a test double all fit.
 */
export type PriceReferenceDb = {
  trackedCategory: { findMany(args: any): PromiseLike<any[]> };
  product: { findMany(args: any): PromiseLike<any[]> };
};

/** A bulk refusal: the re-judge's own 400 (a bad line, totals or an overpayment) or 409 (the invoice moved under its lock). */
type BulkRefusal = BadRequestException | ConflictException;
const isBulkRefusal = (e: unknown): e is BulkRefusal =>
  e instanceof BadRequestException || e instanceof ConflictException;

type BulkTarget = { id: string; invoiceNumber?: string | null };
const invoiceLabel = (inv: BulkTarget): string => inv.invoiceNumber || inv.id;
const money = (n: number): string => `$${n.toFixed(2)}`;

/**
 * SA-683: the refusal codes this flow OWNS. Each guard tags its own 400/409 at the source (MONEY_INVARIANT for
 * a line or the totals, PRICE_ADJUSTMENT_OVERPAYS for the payment guard, INVOICE_CHANGED_CONCURRENTLY for the
 * lock's 409s), so the bulk report echoes exactly these. Anything else (an untagged or foreign refusal) is the
 * generic PRICE_ADJUSTMENT_REFUSED: a code the client was never told about is not guessed into a money label.
 */
const KNOWN_REFUSAL_CODES: ReadonlySet<string> = new Set([
  API_ERROR_CODES.MONEY_INVARIANT,
  API_ERROR_CODES.PRICE_ADJUSTMENT_OVERPAYS,
  API_ERROR_CODES.INVOICE_CHANGED_CONCURRENTLY,
]);
const reportedCode = (e: BulkRefusal): string => {
  const code = codeOf(e);
  return code && KNOWN_REFUSAL_CODES.has(code) ? code : API_ERROR_CODES.PRICE_ADJUSTMENT_REFUSED;
};

/**
 * SA-651 MED-1 (a): the refusal of one invoice inside a bulk run, same status and same body (code and any
 * structured fields), its message prefixed "Invoice X:" so the operator can see WHICH of the batch it was.
 */
function refusalNamingInvoice(inv: BulkTarget, e: BulkRefusal): BulkRefusal {
  const message = `Invoice ${invoiceLabel(inv)}: ${e.message}`;
  const code = codeOf(e);
  // A coded body keeps its structured fields (B1058: the overpay refusal's `overpaid` list), only the message is prefixed.
  const response = code ? { ...(e.getResponse() as object), message } : message;
  return e instanceof ConflictException
    ? new ConflictException(response)
    : new BadRequestException(response);
}

/**
 * B1058 (SA-683): ONE 400 for every invoice a bulk re-price would leave overpaid, each with its number and the
 * overage in cents (`roundMoney`), so the operator fixes the whole batch at once instead of one refusal per
 * run. Nothing was written when this is thrown.
 */
function collectedOverpayRefusal(rows: PriceAdjustmentOverpaidInvoice[]): BadRequestException {
  const list = rows.map((r) => `${r.invoiceNumber || r.invoiceId} by ${money(r.overpaidBy)}`);
  const noun = rows.length === 1 ? "invoice" : "invoices";
  return new BadRequestException({
    code: API_ERROR_CODES.PRICE_ADJUSTMENT_OVERPAYS,
    message:
      `This price change would leave ${rows.length} ${noun} overpaid: ${list.join(", ")}. ` +
      `Nothing was changed. Issue a credit note on each of them instead.`,
    overpaid: rows,
  });
}

/**
 * B1031: the bulk scope (ALL_CUSTOMER_SINCE) re-prices several invoices, each in its OWN transaction, so a
 * refusal found on invoice N would leave invoices 1..N-1 already re-priced. Judge every target first, from
 * the lines as read, writing nothing; a refusal names the invoice.
 *
 * Two kinds of refusal, both before ANY write. A bad line or insane totals (B1031/B1030) stops at the FIRST
 * offender, named. An OVERPAYMENT (B1051, collected here under B1058) is gathered across the WHOLE batch and
 * thrown once, listing every offender. The new total it judges is `projectedTotals` with the same regular
 * tax, category tax (re-derived from the new subtotals, so the reference data is read through `db`) and B294
 * flat rate the tx will write; the paid side is CONFIRMED payments only (DRAFT / PENDING money is ignored,
 * exactly as the tx and the status recompute do).
 *
 * ALL-OR-NOTHING IS JUDGED HERE, AT PRE-FLIGHT; THE TX RE-JUDGES PER INVOICE (SA-651 MED-1). The pre-flight
 * holds no lock (a lock across a whole batch is not worth its footprint), so each invoice's tx re-judges the
 * lines and payments it re-reads under that invoice's own Invoice lock: every invoice stays sane and never
 * overpaid, a race can still refuse, never store a negative line or an overpayment. What a race can leave is
 * a PARTIAL batch (1..N-1 committed, N refused), which `applyBulkPriceAdjustment` reports as a structured
 * result, never as a bare error.
 *
 * Returns each target's PROJECTED new total (invoice id -> cents), the figure the overpay judgment used; the
 * db spec compares it to the total the real run then writes, to the cent.
 */
export async function preflightBulkPriceAdjustment(
  plans: ReadonlyArray<{
    inv: BulkTarget & {
      items: any[];
      discount?: unknown;
      shippingFee?: unknown;
      subtotal?: unknown;
      taxAmount?: unknown;
      total?: unknown;
      status?: string | null;
      payments?: ReadonlyArray<Pick<ConfirmablePaymentRow, "amount" | "status">> | null;
    };
    localMap: Map<string, number>;
  }>,
  isTaxExempt: boolean,
  db: PriceReferenceDb,
): Promise<ReadonlyMap<string, number>> {
  const overpaid: PriceAdjustmentOverpaidInvoice[] = [];
  const projected = new Map<string, number>();
  for (const { inv, localMap } of plans) {
    try {
      const reference = await loadPriceAdjustmentReference(db, inv.items, localMap);
      const updates = buildPriceAdjustmentUpdates({
        items: inv.items,
        localPriceMap: localMap,
        isTaxExempt,
        invoiceStatus: inv.status ?? undefined,
        ...reference,
      });
      assertAdjustedTotalsSane(inv, updates);
      const flat = inferredGoodsFlatRate({
        subtotal: inv.subtotal,
        taxAmount: inv.taxAmount,
        lines: inv.items,
      });
      const newTotal = projectedTotals(inv, updates, flat?.verified ? flat.rate : undefined).total;
      projected.set(inv.id, newTotal);
      const entry = overpaidEntry(inv, sumConfirmed(inv.payments), newTotal);
      if (entry) overpaid.push(entry);
    } catch (e) {
      throw isBulkRefusal(e) ? refusalNamingInvoice(inv, e) : e;
    }
  }
  if (overpaid.length > 0) throw collectedOverpayRefusal(overpaid);
  return projected;
}

/** SA-683: what a bulk run that stopped after >= 1 commit leaves in the log (ids only, no money, no names). */
function logPartial(what: string, applied: string[], failingId: string, error: unknown): void {
  logger.warn(
    `bulk price adjustment ${what}: applied [${applied.join(", ")}], failing ${failingId}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * SA-651 MED-1 (b): the bulk run itself, one invoice at a time after the pre-flight passed. `apply` re-prices
 * ONE invoice and calls `onCommitted` the moment its transaction has committed (before the post-commit
 * commission and order syncs), so only a refusal from the tx re-judge or the Invoice lock is treated as one.
 *
 * Semantics: STOP at the first failure. A refusal here means the invoices changed since the pre-flight read
 * them, so the premise of the rest of the batch is gone; nothing further is written. Re-running the same bulk
 * request later is safe (a re-price to the same price re-derives the same subtotal) and finishes the skipped
 * invoices.
 *   - nothing committed yet: the refusal is rethrown as is, named "Invoice X:" (the batch is still
 *     all-or-nothing);
 *   - 1..N-1 committed: a 409 `PRICE_ADJUSTMENT_PARTIAL` whose body lists `applied` (invoice ids),
 *     `refused` ({invoiceId, invoiceNumber, code, message}; the code is echoed only when it is a KNOWN
 *     refusal code, else PRICE_ADJUSTMENT_REFUSED) and `skipped` (ids never attempted), with fixed copy;
 *   - B1058: invoice N COMMITTED and a post-commit sync then threw (the follow-up sync: the linked order's totals, then commissions): the same 409
 *     with `applied` INCLUDING N and `syncFailed` ({invoiceId, invoiceNumber}) in place of `refused`. Never a
 *     bare error: the invoice is priced, so the operator must be told which order to look at. The raw error
 *     goes to the log, not the body. (Chosen over swallowing the throw: the order totals have no healing
 *     cron, so a swallowed failure would leave them stale with nothing to say so; the run is idempotent.)
 * A fault that is not a refusal and not post-commit (the database failing inside the tx) propagates unchanged,
 * after a warn naming what had committed and which invoice failed (SA-683: a 500 hides that).
 */
export async function applyBulkPriceAdjustment<T extends BulkTarget>(
  plans: ReadonlyArray<{ inv: T; localMap: Map<string, number> }>,
  apply: (inv: T, localMap: Map<string, number>, onCommitted: () => void) => Promise<void>,
): Promise<void> {
  const applied: string[] = [];
  for (const [index, { inv, localMap }] of plans.entries()) {
    let committed = false;
    const base = {
      code: API_ERROR_CODES.PRICE_ADJUSTMENT_PARTIAL,
      applied,
      skipped: plans.slice(index + 1).map((p) => p.inv.id),
    };
    const invoiceNumber = inv.invoiceNumber ?? null;
    try {
      await apply(inv, localMap, () => {
        committed = true;
        applied.push(inv.id);
      });
    } catch (e) {
      if (committed) {
        logPartial("post-commit sync failed", applied, inv.id, e);
        throw new ConflictException({
          ...base,
          message: `${applied.length} of ${plans.length} invoices were updated; invoice ${invoiceLabel(inv)} was updated, but its follow-up sync (order totals and commissions) did not finish. Review it, then run the change again.`,
          syncFailed: { invoiceId: inv.id, invoiceNumber },
        });
      }
      if (!isBulkRefusal(e)) {
        if (applied.length > 0) logPartial("fault", applied, inv.id, e);
        throw e;
      }
      const refusal = refusalNamingInvoice(inv, e);
      if (applied.length === 0) throw refusal;
      logPartial("refused", applied, inv.id, e);
      throw new ConflictException({
        ...base,
        message: `${applied.length} of ${plans.length} invoices were updated; invoice ${invoiceLabel(inv)} changed while saving — review it`,
        refused: {
          invoiceId: inv.id,
          invoiceNumber,
          code: reportedCode(e),
          message: refusal.message,
        },
      });
    }
  }
}

/**
 * The tax reference data for the lines being re-priced, read on the adjustment's own tx from the lines
 * re-read UNDER the Invoice lock (so a line whose category or product changed under the same id is
 * priced against ITS current category and pack, not the pre-lock one).
 *
 * F03/R3/T-B57: the tracked-category tax config for every REGULATED line being re-priced, so a
 * PERCENT_OF_SALE (or other category-taxed) line's categoryTaxAmount is re-derived from its NEW
 * subtotal. Each such line's PRODUCT unitsPerBox too, so linePieceQty can expand a boxed line ordered
 * in SELLING UNITS: create only snapshots unitsPerBox on box-split lines while it computed the ORIGINAL
 * levy from the product's box size, so without this fallback a per-unit levy collapses by a factor of
 * unitsPerBox on the first re-price (the same fetch orders.service.recomputeLineCategoryTaxes carries).
 */
export async function loadPriceAdjustmentReference(
  tx: PriceReferenceDb,
  items: any[],
  localPriceMap: Map<string, number>,
): Promise<{
  categoriesById: Map<string, any>;
  unitsPerBoxByProduct: Map<string, number>;
}> {
  const regulated = items.filter((i) => localPriceMap.get(i.id) != null && i.trackedCategoryId);
  const catIds = [...new Set(regulated.map((i) => i.trackedCategoryId as string))];
  const productIds = [...new Set(regulated.map((i) => i.productId).filter(Boolean))] as string[];
  const cats = catIds.length
    ? await tx.trackedCategory.findMany({ where: { id: { in: catIds } } })
    : [];
  const products = productIds.length
    ? await tx.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, unitsPerBox: true },
      })
    : [];
  return {
    categoriesById: new Map<string, any>(cats.map((c: any) => [c.id, c])),
    unitsPerBoxByProduct: new Map<string, number>(
      products.map((pr: any) => [pr.id, Number(pr.unitsPerBox ?? 0)]),
    ),
  };
}

/**
 * The adjustment tx's FIRST statement (N-3): the Invoice row lock, BEFORE any InvoiceItem row is
 * written. The order-edit path takes the Invoice first and its rows after (orders.service
 * resync), so locking the items first here could deadlock against it. Everything the adjustment
 * decides on is then re-read UNDER the lock (N-1/N-2): the status guard is re-checked (a payment or
 * write-off that landed after the pre-lock read is a 409, never an adjustment of a settled invoice),
 * the payments feed the recomputed status, and the returned `items` are the lines the caller builds
 * its writes from. A line added or removed since the pre-lock read is a 409 too: the reference data
 * loaded for the pre-lock lines (categories, pack sizes) would not cover it.
 */
export async function lockInvoiceForPriceAdjustment(tx: any, inv: any): Promise<any> {
  await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${inv.id} FOR UPDATE`;
  const live = await tx.invoice.findUnique({
    where: { id: inv.id },
    include: { items: true, payments: true },
  });
  if (!live) return inv;
  if (
    live.status === InvoiceStatus.PAID ||
    live.status === InvoiceStatus.WRITTEN_OFF ||
    live.status === InvoiceStatus.VOID
  ) {
    throw new ConflictException({
      code: API_ERROR_CODES.INVOICE_CHANGED_CONCURRENTLY,
      message: `The invoice became ${live.status} while the price was being adjusted. Issue a credit note instead.`,
    });
  }
  const ids = (rows: any[]) =>
    rows
      .map((r) => r.id)
      .sort()
      .join("|");
  if (ids(live.items ?? []) !== ids(inv.items ?? [])) {
    throw new ConflictException({
      code: API_ERROR_CODES.INVOICE_CHANGED_CONCURRENTLY,
      message: "The invoice's lines changed while the price was being adjusted. Retry.",
    });
  }
  return { ...inv, ...live };
}

/**
 * B1051: dollars by which the CONFIRMED payments exceed the invoice's new total (0 when they do not). Both
 * sides are rounded to cents BEFORE the comparison (L-170), so paid == new total is NOT an overpayment.
 * Nothing paid is never an overpayment: an invoice that is ALREADY insane (a negative total, SA-651 NOT-WORSE)
 * may still be re-priced when the edit improves it, and "$0 paid > -$60" must not read as $60 overpaid.
 * The one place the figure is derived: the pre-flight (`preflightBulkPriceAdjustment`) and the in-tx guard
 * below both call it.
 */
export function overpaymentOf(confirmedPaid: number, newTotal: number): number {
  const paid = roundMoney(confirmedPaid);
  return paid > 0 ? Math.max(0, roundMoney(paid - roundMoney(newTotal))) : 0;
}

/**
 * The overpaid-list entry of one invoice (null when the CONFIRMED payments do not exceed its new total): what
 * both the pre-flight's collected 400 and the in-tx guard's 400 carry, so every overpay refusal has the SAME
 * `overpaid` shape (B1058).
 */
function overpaidEntry(
  inv: BulkTarget,
  confirmedPaid: number,
  newTotal: number,
): PriceAdjustmentOverpaidInvoice | null {
  const overpaidBy = overpaymentOf(confirmedPaid, newTotal);
  return overpaidBy > 0
    ? {
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber ?? null,
        paid: roundMoney(confirmedPaid),
        newTotal: roundMoney(newTotal),
        overpaidBy,
      }
    : null;
}

/**
 * B1051: a price adjustment must never take an invoice's total BELOW what the customer has already paid
 * (CONFIRMED payments, the same basis the status recompute uses, read under the Invoice lock). A settled
 * (PAID) invoice is refused up front with "issue a credit note instead"; a re-price that would MAKE the
 * invoice overpaid is the same act and gets the same answer. DRAFT and PENDING payments are not counted.
 * B1058: this is the RACE re-judge for a bulk run (its pre-flight judges every target first); it is the
 * only judge for the SINGLE scope. Tagged PRICE_ADJUSTMENT_OVERPAYS, and the body ALWAYS carries the
 * one-entry `overpaid` list (the client renders from it, never from `message`).
 */
export function assertNotOverpaidByPriceChange(
  confirmedPaid: number,
  newTotal: number,
  inv: BulkTarget,
): void {
  const entry = overpaidEntry(inv, confirmedPaid, newTotal);
  if (entry) {
    throw new BadRequestException({
      code: API_ERROR_CODES.PRICE_ADJUSTMENT_OVERPAYS,
      message:
        `This price change would leave the invoice overpaid by ${money(entry.overpaidBy)} ` +
        `(paid ${money(entry.paid)}, new total ${money(entry.newTotal)}). ` +
        `Issue a credit note instead.`,
      overpaid: [entry],
    });
  }
}

/**
 * The transaction body of `applyPriceAdjustment` (B662), AFTER the line writes (those stay in the service so the
 * order/invoice line-writer coverage scanners still see this writer): recompute the invoice totals from the fresh
 * lines, persist them with the status recomputed from CONFIRMED payments against the NEW total
 * (F03/R4/T-B74: a lowered total a payment already covered must not keep a stale SENT/PARTIAL status), and
 * sync the regulated ledger, all in `tx` so they commit or fail TOGETHER. B1051: a total BELOW the CONFIRMED
 * payments is refused (`assertNotOverpaidByPriceChange`), never written: recomputeStatus would land PAID and
 * balanceDue floors at 0, so the customer's overpayment would show nowhere. The refusal throws before any
 * write of this function, and the caller's line writes roll back with it. Category (excise) tax is persisted per
 * line and is NOT part of taxRate: omitting it would under-bill excise and propagate the shortfall to the
 * linked order. The per-line write honours exemption, so this sum is exemption-correct by construction.
 * paidAt is paired with the status like every sibling status writer, or a PAID invoice keeps paidAt NULL and
 * vanishes from every "status: PAID + paidAt" revenue window.
 */
export async function commitPriceAdjustment(args: {
  inv: any;
  itemUpdates: Array<{ id: string; data: Record<string, any> }>;
  auditLine: string;
  tx: any;
  recomputeStatus: (paid: number, total: number, dueDate: Date | null, status: any) => any;
  ledger: Pick<RegulatedLedgerService, "correctSaleForPriceChange">;
  resync: (invoiceId: string, orderId: string | null, items: any[], db: any) => Promise<void>;
}): Promise<void> {
  const { inv, itemUpdates, auditLine, tx, recomputeStatus } = args;
  const updatedItems: any[] = await tx.invoiceItem.findMany({ where: { invoiceId: inv.id } });
  const { subtotal, taxAmount, total } = totalsFromLines(updatedItems, inv);
  const existingInternal = inv.internalNotes ?? "";
  const confirmedPaid = sumConfirmed(inv.payments);
  assertNotOverpaidByPriceChange(confirmedPaid, total, inv); // B1051: before ANY invoice or ledger write
  const newStatus = recomputeStatus(confirmedPaid, total, inv.dueDate ?? null, inv.status);
  await tx.invoice.update({
    where: { id: inv.id },
    data: {
      subtotal,
      taxAmount,
      total,
      status: newStatus,
      paidAt: newStatus === InvoiceStatus.PAID ? new Date() : null,
      internalNotes: existingInternal ? `${existingInternal}\n${auditLine}` : auditLine,
    },
  });
  await syncLedgerAfterPriceChange(
    args,
    inv,
    updatedItems,
    new Set(itemUpdates.map((u) => u.id)),
    tx,
  );
}
