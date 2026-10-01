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

export interface RefundRefusal {
  productId: string;
  requestedAmount: number;
  remainingAmount: number;
  requestedQty: number;
  remainingQty: number;
}
/** "refund": REFUSE, never clip (a refund that would take a line past its value). "count": the legacy history term, which MAY clip. */
export type AllocMode = "refund" | "count";

const CENT = 0.01 + 1e-9;

/**
 * Sequential fill of `qty` pieces of `productId` across that product's lines, in the order given.
 *  - QTY room governs every line; MONEY binds only when the line has money (a $0 line takes its qty at amount 0, SA-628a).
 *  - A partial take is priced at the line's linear value (subtotal / qty); the take that CLOSES a line takes exactly its remaining
 *    amount, which in "refund" mode must be within 1 cent of the linear value.
 *  - "refund" mode never clips: a take whose linear value exceeds the line's remaining money by more than a cent returns
 *    `refusal` (and no items); "count" mode (the legacy loader) clips to what the line has left and skips a spent line.
 * `shortfallQty` > 0 means the lines' remaining QTY cannot absorb it all.
 */
export function allocateProductQty(
  lines: readonly HeadroomLine[],
  credited: ReadonlyMap<string, LineCredit>,
  productId: string,
  qty: number,
  mode: AllocMode = "refund",
): { items: RefundItem[]; shortfallQty: number; refusal?: RefundRefusal } {
  const items: RefundItem[] = [];
  let left = round3(qty);
  for (const line of lines) {
    if (left <= EPS) break;
    if (line.productId !== productId || !(line.qty > 0)) continue;
    const done = credited.get(line.id) ?? { amount: 0, qty: 0 };
    const remainingQty = Math.max(0, round3(line.qty - done.qty));
    if (remainingQty <= EPS) continue;
    const hasMoney = line.subtotal > EPS;
    const remainingAmount = hasMoney ? Math.max(0, roundMoney(line.subtotal - done.amount)) : 0;
    const take = Math.min(left, remainingQty);
    const closes = take >= remainingQty - EPS;
    const linear = hasMoney ? roundMoney((take * line.subtotal) / line.qty) : 0;
    if (mode === "refund") {
      // the closing take sits on the rounding drift of every earlier partial take (<= half a cent each), so its
      // tolerance grows with the pieces already credited (capped); other takes get one cent
      const drift = closes ? Math.min(0.05, 0.005 * Math.ceil(done.qty)) : 0;
      const over = linear > remainingAmount + CENT + drift;
      if (hasMoney && over) {
        return {
          items: [],
          shortfallQty: round3(left),
          refusal: {
            productId,
            requestedAmount: roundMoney((Math.min(left, line.qty) * line.subtotal) / line.qty),
            remainingAmount,
            requestedQty: take,
            remainingQty,
          },
        };
      }
    } else if (!hasMoney || remainingAmount <= EPS) {
      continue; // count mode: a free or spent line has no money to count (SA-628a)
    }
    const amount = !hasMoney ? 0 : closes ? remainingAmount : Math.min(remainingAmount, linear);
    items.push({ invoiceItemId: line.id, qty: round3(take), amount });
    left = round3(left - take);
  }
  if (mode === "refund" && left > EPS) {
    // the lines' remaining QTY cannot absorb the request: refuse, never clip (SA-628a B2)
    const mine = lines.filter((l) => l.productId === productId && l.qty > 0);
    const rem = (l: HeadroomLine) => {
      const d = credited.get(l.id) ?? { amount: 0, qty: 0 };
      return {
        q: Math.max(0, round3(l.qty - d.qty)),
        a: l.subtotal > EPS ? Math.max(0, roundMoney(l.subtotal - d.amount)) : 0,
      };
    };
    const unit = mine.length ? mine[0].subtotal / mine[0].qty : 0;
    return {
      items: [],
      shortfallQty: round3(left),
      refusal: {
        productId,
        requestedAmount: roundMoney(unit * qty),
        remainingAmount: roundMoney(mine.reduce((t, l) => t + rem(l).a, 0)),
        requestedQty: round3(qty),
        remainingQty: round3(mine.reduce((t, l) => t + rem(l).q, 0)),
      },
    };
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
        // keyed on the CN LINK, not the return status: legacy PROCESSED rows exist (SA-628a)
        where: { creditNoteId: { in: itemless.map((c) => c.id) } },
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
      acc = addCredits(acc, allocateProductQty(lines, acc, productId, qty, "count").items);
    }
    return new Map(acc);
  }
  return credited;
}
