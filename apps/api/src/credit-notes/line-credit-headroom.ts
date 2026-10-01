import { roundMoney } from "@routeflow/pricing";

/**
 * SA-628 — ONE per-line credit headroom for credit notes AND return refunds (a line may never be credited past its value
 * by combining the two). Cap per line: NET credited <= the line's subtotal AND qty credited <= the line's qty (tax is its own
 * sibling term and is never folded into this number). Used by `CreditNotesService.validateAndBuildCnItems` (create) and by
 * `ReturnsService.billedBasisFor` (the refund), so the two can never disagree.
 *
 * What counts as credited against a line (non-VOID credit notes of that invoice only):
 *  1. item-bearing credit notes: their `CreditNoteItem` rows (amount + qty);
 *  2. the LEGACY term: an old ITEMLESS refund credit note (minted by `processRefund` before SA-628) counts via its return's
 *     `ReturnItem.qty` x the line's linear value, allocated across the product's lines in order.
 * Manual itemless credit notes carry no line and stay invoice-level only (no pro-rata).
 * Reconcile-rotated `invoiceItemId`s: BEST-EFFORT in v1 (same caveat as the cap in credit-notes.service.ts).
 */
export interface HeadroomLine {
  id: string;
  productId: string | null;
  subtotal: number;
  qty: number;
}
export interface LineCredit {
  amount: number;
  qty: number;
}
export interface RefundItem {
  invoiceItemId: string;
  qty: number;
  amount: number;
}

const EPS = 0.001;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Sequential fill of `qty` pieces of `productId` across that product's lines, in the order given: each line takes at most what
 * it still has (qty AND amount), a partial take is priced at the line's linear value (subtotal / qty), and the take that CLOSES
 * a line takes exactly the rest of its amount (no rounding residue). `shortfallQty` > 0 means the lines cannot absorb it all.
 */
export function allocateProductQty(
  lines: readonly HeadroomLine[],
  credited: ReadonlyMap<string, LineCredit>,
  productId: string,
  qty: number,
): { items: RefundItem[]; shortfallQty: number } {
  const items: RefundItem[] = [];
  let left = round3(qty);
  for (const line of lines) {
    if (left <= EPS) break;
    if (line.productId !== productId || !(line.qty > 0)) continue;
    const done = credited.get(line.id) ?? { amount: 0, qty: 0 };
    const remainingQty = Math.max(0, round3(line.qty - done.qty));
    const remainingAmount = Math.max(0, roundMoney(line.subtotal - done.amount));
    if (remainingQty <= EPS || remainingAmount <= EPS) continue;
    const take = Math.min(left, remainingQty);
    const closes = take >= remainingQty - EPS;
    const amount = closes
      ? remainingAmount
      : Math.min(remainingAmount, roundMoney((take * line.subtotal) / line.qty));
    items.push({ invoiceItemId: line.id, qty: round3(take), amount });
    left = round3(left - take);
  }
  return { items, shortfallQty: left > EPS ? left : 0 };
}

/** Adds `items` onto `credited` (a new map). */
export function addCredits(
  credited: ReadonlyMap<string, LineCredit>,
  items: readonly RefundItem[],
): Map<string, LineCredit> {
  const out = new Map(credited);
  for (const it of items) {
    const prev = out.get(it.invoiceItemId) ?? { amount: 0, qty: 0 };
    out.set(it.invoiceItemId, { amount: prev.amount + it.amount, qty: prev.qty + it.qty });
  }
  return out;
}

/**
 * The credited amount + qty per invoice line (see the header). `lines` are the invoice's items; `db` is the caller's client
 * (a `tx` inside create(), `forTenant()` for the pre-checks). `excludeCreditNoteId` leaves one note out (the reissue dry run).
 */
export async function loadLineCredits(
  db: any,
  invoiceId: string,
  lines: readonly HeadroomLine[],
  opts: { excludeCreditNoteId?: string } = {},
): Promise<Map<string, LineCredit>> {
  const notThis = opts.excludeCreditNoteId ? { id: { not: opts.excludeCreditNoteId } } : {};
  const credited = new Map<string, LineCredit>();
  const ids = lines.map((l) => l.id);
  if (ids.length === 0) return credited;

  const itemRows: Array<{ invoiceItemId: string | null; amount: unknown; qty: unknown }> =
    await db.creditNoteItem.findMany({
      where: {
        invoiceItemId: { in: ids },
        creditNote: { invoiceId, status: { not: "VOID" }, ...notThis },
      },
      select: { invoiceItemId: true, amount: true, qty: true },
    });
  for (const r of itemRows) {
    const k = r.invoiceItemId ?? "";
    const prev = credited.get(k) ?? { amount: 0, qty: 0 };
    credited.set(k, { amount: prev.amount + Number(r.amount), qty: prev.qty + Number(r.qty ?? 0) });
  }

  // LEGACY term: itemless refund credit notes minted by processRefund before SA-628.
  const itemless: Array<{ id: string }> = await db.creditNote.findMany({
    where: { invoiceId, status: { not: "VOID" }, items: { none: {} }, ...notThis },
    select: { id: true },
  });
  if (itemless.length > 0) {
    const returns: Array<{ items: Array<{ productId: string; qty: unknown }> }> =
      await db.return.findMany({
        where: { creditNoteId: { in: itemless.map((c) => c.id) }, status: "REFUNDED" },
        select: { items: { select: { productId: true, qty: true } } },
      });
    const qtyByProduct = new Map<string, number>();
    for (const ret of returns) {
      for (const it of ret.items ?? []) {
        qtyByProduct.set(it.productId, (qtyByProduct.get(it.productId) ?? 0) + Number(it.qty));
      }
    }
    let acc: ReadonlyMap<string, LineCredit> = credited;
    for (const [productId, qty] of qtyByProduct) {
      acc = addCredits(acc, allocateProductQty(lines, acc, productId, qty).items);
    }
    return new Map(acc);
  }
  return credited;
}
