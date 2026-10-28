/**
 * SA-840 (B704 / #1477): the money of a STANDARD return's refund, priced from the invoice AS CHARGED. `planProductRefund`
 * keeps the qty FILL (which invoice lines absorb the returned qty, in what order) and its refusals; every figure that is
 * paid out comes from `refundableProductPoolShare` (@routeflow/pricing, SA-970), per invoice and product pool. The preview
 * (`priceReturn`, pure, DB-free) and the mint (`itemiseRefund`, under the shared per-line headroom) both call
 * `priceProductSlice`, so they can never disagree.
 */
import {
  refundableInvoiceOf,
  refundableProductPoolShare,
  roundMoney,
  type RefundableInvoice,
  type StoredInvoice,
  type StoredInvoiceItem,
} from "@routeflow/pricing";
import {
  planProductRefund,
  toHeadroomLine,
  type HeadroomLine,
  type LineCredit,
  type PlanMode,
  type RefundItem,
  type RefundRefusal,
} from "../credit-notes/line-credit-headroom";

/** The frozen split of a refund (what `Return.creditSubtotal / creditTax / creditCategoryTax` store). */
export interface RefundSplit {
  net: number;
  tax: number;
  categoryTax: number;
}

export const NO_SPLIT: RefundSplit = { net: 0, tax: 0, categoryTax: 0 };

export const addSplit = (a: RefundSplit, b: RefundSplit): RefundSplit => ({
  net: roundMoney(a.net + b.net),
  tax: roundMoney(a.tax + b.tax),
  categoryTax: roundMoney(a.categoryTax + b.categoryTax),
});

/** What the customer gets back: net + tax + category tax. */
export const splitTotal = (s: RefundSplit): number => roundMoney(s.net + s.tax + s.categoryTax);

/** The split of itemised refund rows (`amount` is the NET slice; the tax shares ride beside it). */
export const splitOfItems = (items: readonly RefundItem[]): RefundSplit =>
  items.reduce(
    (acc, it) =>
      addSplit(acc, { net: it.amount, tax: it.tax ?? 0, categoryTax: it.categoryTax ?? 0 }),
    NO_SPLIT,
  );

/** The invoice as the helper reads it (the mapping lives in @routeflow/pricing, beside the helper that consumes it). */
export const toRefundableInvoice = (
  invoice: StoredInvoice,
  lineIds?: readonly string[],
): RefundableInvoice => refundableInvoiceOf(invoice, lineIds);

/** A creditable invoice as stored: its items carry the productId and the unit columns the headroom line reads. */
type CreditableItem = StoredInvoiceItem & { productId?: string | null; [column: string]: unknown };
export type CreditableInvoice = Omit<StoredInvoice, "items"> & {
  id?: string | null;
  createdAt?: Date | string | null;
  items?: readonly CreditableItem[] | null;
};

/**
 * Every billed line of `productId` across the creditable invoices, oldest invoice first (the fill order), with the invoice
 * each sits on. A fixture / legacy item with no id gets a positional one: the preview never writes it anywhere.
 */
export function billedLinesOf(creditable: readonly CreditableInvoice[], productId: string) {
  const lines: HeadroomLine[] = [];
  const invoiceOfLine = new Map<string, RefundableInvoice>();
  const ordered = [...creditable].sort(
    (a, b) =>
      new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime() ||
      String(a.id).localeCompare(String(b.id)),
  );
  ordered.forEach((inv, n) => {
    const items = inv.items ?? [];
    const ids = items.map((it, i) => it.id ?? `${n}:${i}`);
    const refundable = toRefundableInvoice(inv, ids);
    items.forEach((it, i) => {
      if (it.productId !== productId) return;
      lines.push({ ...toHeadroomLine(it), id: ids[i] });
      invoiceOfLine.set(ids[i], refundable);
    });
  });
  return { lines, invoiceOf: (id: string) => invoiceOfLine.get(id) as RefundableInvoice };
}

/**
 * ONE product's returned qty, filled over its billed `lines` by `planProductRefund` (paid lines first, $0 lines last; it also
 * REFUSES, never clips, a qty the lines cannot absorb) and priced per invoice POOL (SA-970): a return item names only the
 * product, so on each invoice the filled qty is sliced over the product's lines there as one virtual line
 * (`refundableProductPoolShare`), then spread over the paid lines in fill order. `axis.returned` is in pieces when
 * `axis.pieces` (each line's `piecesPerQty` converts), else in the line's own unit; the rows come back on each line's own
 * axis, `amount` NET with `tax` / `categoryTax` beside it. `credited` is what the lines already carry (empty for the preview).
 */
export function priceProductSlice(args: {
  lines: readonly HeadroomLine[];
  invoiceOf: (lineId: string) => RefundableInvoice;
  credited: ReadonlyMap<string, LineCredit>;
  productId: string;
  axis: { pieces: boolean; returned: number };
  mode: PlanMode;
}): { items: RefundItem[]; refusal?: RefundRefusal } {
  const { lines, invoiceOf, credited, productId, axis, mode } = args;
  const factorOf = (l: HeadroomLine): number => (axis.pieces ? (l.piecesPerQty ?? 1) : 1);
  const inPieces = lines.map((l) => ({ ...l, qty: l.qty * factorOf(l), piecesPerQty: 1 }));
  const creditedInPieces = new Map(credited);
  for (const l of lines) {
    const c = credited.get(l.id);
    if (c) creditedInPieces.set(l.id, { ...c, qty: c.qty * factorOf(l) });
  }
  // EPS (0.001) per line on the line's own axis, scaled by its pieces-per-qty, like `pooledRefundRefusal`
  const qtyTol = Math.max(
    0.001,
    lines.reduce((t, l) => t + 0.001 * factorOf(l), 0),
  );
  const plan = planProductRefund(
    inPieces,
    creditedInPieces,
    productId,
    axis.returned,
    mode,
    qtyTol,
  );
  if (plan.refusal) return { items: [], refusal: plan.refusal };

  const takenPieces = new Map(plan.items.map((it) => [it.invoiceItemId, it.qty]));
  // the spread order is planProductRefund's own fill order: paid lines first, $0 lines last, each in line order
  const ordered = lines
    .filter((l) => l.qty > 0 && l.productId === productId)
    .sort((x, y) => Number(y.subtotal > 0.001) - Number(x.subtotal > 0.001));
  const byInvoice = new Map<RefundableInvoice, HeadroomLine[]>();
  for (const l of ordered) {
    const inv = invoiceOf(l.id);
    byInvoice.set(inv, [...(byInvoice.get(inv) ?? []), l]);
  }

  const items: RefundItem[] = [];
  for (const [invoice, group] of byInvoice) {
    const poolLines = group.map((l) => {
      const c = credited.get(l.id) ?? { amount: 0, qty: 0 };
      return {
        id: l.id,
        pieces: l.qty * factorOf(l),
        // regular tax is not stored on a CreditNoteItem: the slice telescopes on the credited QTY, so the net is the cap
        prior: { qty: c.qty * factorOf(l), net: c.amount, tax: 0, categoryTax: 0 },
      };
    });
    const takes = group.map((l) => takenPieces.get(l.id) ?? 0);
    const pool = poolLines.reduce((t, l) => t + l.pieces, 0);
    const priorPieces = poolLines.reduce((t, l) => t + l.prior.qty, 0);
    let returnedPieces = Math.round(takes.reduce((t, n) => t + n, 0) * 1000) / 1000;
    // the 3-dp round trip of a pieces conversion, never a clip
    const room = Math.max(0, Math.round((pool - priorPieces) * 1000) / 1000);
    if (returnedPieces > room && returnedPieces - room <= 0.002) returnedPieces = room;
    const share = refundableProductPoolShare({ invoice, lines: poolLines, returnedPieces });
    if (share.refusal) {
      return {
        items: [],
        refusal: {
          productId,
          requestedAmount: 0,
          remainingAmount: 0,
          requestedQty: returnedPieces,
          remainingQty: room,
          qtyUnit: "line",
        },
      };
    }
    group.forEach((line, i) => {
      const part = share.spread[i];
      const qty = Math.round((takes[i] / factorOf(line)) * 1000) / 1000;
      if (qty <= 0 && part.total <= 0) return;
      items.push({
        invoiceItemId: line.id,
        qty,
        amount: part.net,
        tax: part.tax,
        categoryTax: part.categoryTax,
      });
    });
  }
  return { items };
}

/**
 * What `processRefund` hands `CreditNotesService.create` besides the rows: the regular tax and the per-line levy slices
 * the rows' NET amounts leave out (so the note reconciles to the gross refund). Empty for an untaxed refund, which keeps
 * the call byte-identical to the net-only one.
 */
export function refundTaxOpts(
  items: readonly RefundItem[] | undefined,
  split: RefundSplit | undefined,
): {
  refundTax?: number;
  refundCategoryTax?: Array<{ invoiceItemId: string; categoryTax: number }>;
} {
  const levy = (items ?? [])
    .filter((it) => (it.categoryTax ?? 0) > 0)
    .map((it) => ({ invoiceItemId: it.invoiceItemId, categoryTax: it.categoryTax as number }));
  if (!items?.length || !split || (split.tax <= 0 && levy.length === 0)) return {};
  return { refundTax: split.tax, refundCategoryTax: levy };
}
