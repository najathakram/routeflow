import { packFromOwnSplit, roundMoney } from "@routeflow/pricing";
import { CREDIT_SOURCE_EXCLUDED } from "../invoices/invoice-status-sets";

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
  /** pieces per unit of `qty` (inline ReturnItem.qty is PIECES; a boxed selling-unit line's qty is boxes). Default 1. */
  piecesPerQty?: number;
}
/**
 * The pieces-per-qty factor of an invoice line, resolved exactly like the inline pricing's `piecesQty`: a box-split line's qty is
 * already pieces (1); else the line's own pack snapshot, else the pack its own boxes/pieces split recovers, else the product's
 * current pack; a selling-unit line's qty is boxes.
 */
export const piecesPerQtyOf = (it: {
  qty?: unknown;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  product?: { unitsPerBox?: number | null } | null;
}): number => {
  if (it.boxes != null) return 1;
  const upb =
    it.unitsPerBox ??
    packFromOwnSplit({ qty: Number(it.qty ?? 0), boxes: it.boxes, pieces: it.pieces }) ??
    it.product?.unitsPerBox ??
    null;
  return Math.max(1, Number(upb) || 1);
};
/** An invoice item row as a HeadroomLine. */
export const toHeadroomLine = (it: any): HeadroomLine => ({
  id: it.id,
  productId: it.productId ?? null,
  subtotal: Number(it.subtotal),
  qty: Number(it.qty),
  piecesPerQty: piecesPerQtyOf(it),
});
export interface LineCredit {
  amount: number;
  qty: number;
  /** how many prior credit items sit in `amount` (each carries <= half a cent of rounding drift) */
  items?: number;
}
export interface RefundItem {
  invoiceItemId: string;
  qty: number;
  amount: number;
}

const EPS = 0.001;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const CENT = 0.01 + 1e-9;

export interface RefundRefusal {
  productId: string;
  requestedAmount: number;
  remainingAmount: number;
  requestedQty: number;
  remainingQty: number;
  /** The unit of the two qty fields: "line" = the invoice line's own axis (a boxed line counts boxes); "pieces" = the order pool. */
  qtyUnit: "line" | "pieces";
}
/** "refund": REFUSE, never clip. "count": the legacy history term, which clips to what the lines have left. */
export type PlanMode = "refund" | "count";

/**
 * ONE function for the refund PRICE and its ITEMISATION, used by the mint, the refund preview and the legacy history term
 * (SA-628b), so they can never disagree.
 *  - PRICE: master's pooled average, `qty x sum(subtotal) / sum(qty)` over the product's lines (money-neutral vs master).
 *  - CAP ("refund" mode): refuse (`refusal`, no items) when the qty exceeds the lines' summed qty room, or the price exceeds
 *    their summed money room by more than a cent plus the rounding drift of the prior credit ITEMS (0.5 cent each, capped at
 *    5 cents total). Never clips. "count" mode clips instead.
 *  - ITEMISATION: qty fills PAID lines first (line order), $0 lines last at amount 0; the price is then distributed over the
 *    same paid takes in order, each up to its line's remaining money, so the items sum to the price exactly.
 */
export function planProductRefund(
  lines: readonly HeadroomLine[],
  credited: ReadonlyMap<string, LineCredit>,
  productId: string,
  qty: number,
  mode: PlanMode = "refund",
  qtyTol: number = EPS,
): { items: RefundItem[]; price: number; amount: number; refusal?: RefundRefusal } {
  const mine = lines.filter((l) => l.productId === productId && l.qty > 0);
  const billedQty = mine.reduce((t, l) => t + l.qty, 0);
  if (mine.length === 0 || billedQty <= 0) return { items: [], price: 0, amount: 0 };
  const billedSubtotal = mine.reduce((t, l) => t + l.subtotal, 0);
  const wanted = round3(Math.min(qty, billedQty));
  const price = roundMoney((wanted * billedSubtotal) / billedQty);

  const room = (l: HeadroomLine) => {
    const d = credited.get(l.id) ?? { amount: 0, qty: 0 };
    return {
      qty: Math.max(0, round3(l.qty - d.qty)),
      amount: l.subtotal > EPS ? Math.max(0, roundMoney(l.subtotal - d.amount)) : 0,
      prior: d.items ?? 0,
    };
  };
  const rooms = mine.map(room);
  const roomQty = round3(rooms.reduce((t, r) => t + r.qty, 0));
  const roomAmount = roundMoney(rooms.reduce((t, r) => t + r.amount, 0));
  const priorItems = rooms.reduce((t, r) => t + r.prior, 0);
  const tol = CENT + Math.min(0.04, 0.005 * priorItems);
  const refuse = (): {
    items: RefundItem[];
    price: number;
    amount: number;
    refusal: RefundRefusal;
  } => ({
    items: [],
    price,
    amount: 0,
    refusal: {
      productId,
      requestedAmount: price,
      remainingAmount: roomAmount,
      requestedQty: wanted,
      remainingQty: roomQty,
      qtyUnit: "line",
    },
  });
  if (mode === "refund" && (wanted > roomQty + qtyTol || price > roomAmount + tol)) return refuse();

  // qty: paid lines first, $0 lines last, each in line order
  const order = mine
    .map((l, i) => ({ l, r: rooms[i] }))
    .sort((x, y) => Number(y.l.subtotal > EPS) - Number(x.l.subtotal > EPS));
  let left = wanted;
  const takes: Array<{ id: string; qty: number; paid: boolean; roomAmount: number }> = [];
  for (const { l, r } of order) {
    if (left <= EPS) break;
    const take = Math.min(left, r.qty);
    if (take <= EPS) continue;
    takes.push({ id: l.id, qty: round3(take), paid: l.subtotal > EPS, roomAmount: r.amount });
    left = round3(left - take);
  }
  // money: the price over the paid takes in order, each up to its line's remaining money
  let rest = price;
  const items: RefundItem[] = takes.map((t) => {
    const amount = t.paid ? roundMoney(Math.min(rest, t.roomAmount)) : 0;
    rest = roundMoney(rest - amount);
    return { invoiceItemId: t.id, qty: t.qty, amount };
  });
  // a paid line short of money while a later paid line has room: product-level cap (SA-628b), so the remainder lands on
  // any paid line with money left (a qty-0 item when that line took no pieces)
  for (const { l, r } of order) {
    if (rest <= EPS) break;
    if (l.subtotal <= EPS) continue;
    const have = items.find((it) => it.invoiceItemId === l.id);
    const more = roundMoney(Math.min(rest, r.amount - (have?.amount ?? 0)));
    if (more <= EPS) continue;
    if (have) have.amount = roundMoney(have.amount + more);
    else items.push({ invoiceItemId: l.id, qty: 0, amount: more });
    rest = roundMoney(rest - more);
  }
  if (mode === "refund" && rest > tol) return refuse(); // the price has nowhere to land
  return { items, price, amount: roundMoney(items.reduce((t, i) => t + i.amount, 0)) };
}

/**
 * A take of `qty` pieces worth `amount` against ONE line (an inline return chunk, which is already line-specific): null when it
 * fits the line's remaining qty and money (money only binds a line that has money; one cent of tolerance plus the drift of the
 * prior credit items, like `planProductRefund`), else the refusal. Never clips.
 */
export function lineTakeRefusal(
  line: HeadroomLine,
  credited: ReadonlyMap<string, LineCredit>,
  take: { qty: number; amount: number },
): RefundRefusal | null {
  const d = credited.get(line.id) ?? { amount: 0, qty: 0 };
  const remainingQty = Math.max(0, round3(line.qty - d.qty));
  const hasMoney = line.subtotal > EPS;
  const remainingAmount = hasMoney ? Math.max(0, roundMoney(line.subtotal - d.amount)) : 0;
  const tol = CENT + Math.min(0.04, 0.005 * (d.items ?? 0));
  const qtyOver = take.qty > remainingQty + EPS;
  const moneyOver = hasMoney && take.amount > remainingAmount + tol;
  if (!qtyOver && !moneyOver) return null;
  return {
    productId: line.productId ?? "",
    requestedAmount: roundMoney(take.amount),
    remainingAmount,
    requestedQty: round3(take.qty),
    qtyUnit: "line",
    remainingQty,
  };
}

/** Adds `items` onto `credited` (a new map). */
export function addCredits(
  credited: ReadonlyMap<string, LineCredit>,
  items: readonly RefundItem[],
): Map<string, LineCredit> {
  const out = new Map(credited);
  for (const it of items) {
    const prev = out.get(it.invoiceItemId) ?? { amount: 0, qty: 0 };
    out.set(it.invoiceItemId, {
      amount: prev.amount + it.amount,
      qty: prev.qty + it.qty,
      items: (prev.items ?? 0) + 1,
    });
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
  // `skipLegacy`: the ORDER POOL (below) counts the itemless refund notes of every creditable invoice once, itself.
  opts: { excludeCreditNoteId?: string; skipLegacy?: boolean } = {},
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
    credited.set(k, {
      amount: prev.amount + Number(r.amount),
      qty: prev.qty + Number(r.qty ?? 0),
      items: (prev.items ?? 0) + 1,
    });
  }

  // INLINE term (B948, SA-628a (c)): an inline return mints a STANDALONE itemless credit note (no invoiceId), so neither term
  // below sees it; its ReturnItems record the source line, so count them (net `subtotal` + qty). Held (DRIVER_CAP) returns count
  // too: their credit lands at approve(). CANCELLED / REJECTED ones credit nothing.
  const inlineRows: Array<{ sourceInvoiceItemId: string | null; qty: unknown; subtotal: unknown }> =
    (await db.returnItem?.findMany?.({
      where: {
        sourceInvoiceItemId: { in: ids },
        return: { kind: "INLINE", status: { notIn: ["CANCELLED", "REJECTED"] } },
      },
      select: { sourceInvoiceItemId: true, qty: true, subtotal: true },
    })) ?? [];
  for (const r of inlineRows) {
    const k = r.sourceInvoiceItemId ?? "";
    const prev = credited.get(k) ?? { amount: 0, qty: 0 };
    const factor = lines.find((l) => l.id === k)?.piecesPerQty ?? 1;
    credited.set(k, {
      amount: prev.amount + Number(r.subtotal ?? 0),
      qty: prev.qty + Number(r.qty ?? 0) / factor,
      items: (prev.items ?? 0) + 1,
    });
  }

  if (opts.skipLegacy) return credited;

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
      acc = addCredits(acc, planProductRefund(lines, acc, productId, qty, "count").items);
    }
    return new Map(acc);
  }
  return credited;
}

/**
 * B947: the ORDER POOL. A return refund on an order with 2+ creditable invoices is minted as ONE itemless lump sum on the
 * LATEST invoice, so the per-invoice legacy term above attributes it to the latest invoice's lines only: a line of the same
 * product on an OLDER invoice never sees it, and a credit note item on that line never sees the refund (and vice versa).
 * The pool counts, for a product P across ALL the order's creditable invoices (`CREDIT_SOURCE_EXCLUDED` is the one predicate
 * `priceReturn` uses too): the credit note items and inline-return items on P's lines, plus every non-VOID ITEMLESS refund
 * note of the order (on any creditable invoice, or linked to the order) attributed to P through its Return's items, pooled
 * across the combined P lines exactly like the refund's own price. A manual itemless note carries no Return: never counted.
 * It takes NO lock: the writers call `lockOrderPoolRows` FIRST (Order, then every creditable invoice id-sorted, SA-214) so a
 * refund on invoice Y and a credit note on invoice X serialize against each other, and so the lock order never inverts.
 * An INLINE return's note is counted once, by the inline term (its items carry the source line); the itemless term skips
 * INLINE returns.
 */
export interface OrderPool {
  invoiceCount: number;
  lines: HeadroomLine[];
  credited: Map<string, LineCredit>;
}
export async function loadOrderPool(
  db: any,
  orderId: string,
  opts: { excludeCreditNoteId?: string } = {},
): Promise<OrderPool> {
  const invoices: Array<{ id: string; items: any[] }> = await db.invoice.findMany({
    where: { orderId, status: { notIn: CREDIT_SOURCE_EXCLUDED } },
    select: {
      id: true,
      items: {
        select: {
          id: true,
          productId: true,
          subtotal: true,
          qty: true,
          boxes: true,
          unitsPerBox: true,
          pieces: true,
          product: { select: { unitsPerBox: true } },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
    orderBy: [{ id: "asc" }],
  });
  const ids = invoices.map((i) => i.id);
  const lines: HeadroomLine[] = [];
  let credited = new Map<string, LineCredit>();
  for (const inv of invoices) {
    const invLines = (inv.items ?? []).map(toHeadroomLine);
    lines.push(...invLines);
    const part = await loadLineCredits(db, inv.id, invLines, {
      excludeCreditNoteId: opts.excludeCreditNoteId,
      skipLegacy: true,
    });
    for (const [k, v] of part) credited.set(k, v);
  }
  const notThis = opts.excludeCreditNoteId ? { id: { not: opts.excludeCreditNoteId } } : {};
  const itemless: Array<{ id: string }> =
    ids.length === 0
      ? []
      : await db.creditNote.findMany({
          where: {
            status: { not: "VOID" },
            items: { none: {} },
            OR: [{ invoiceId: { in: ids } }, { orderLinks: { some: { orderId } } }],
            ...notThis,
          },
          select: { id: true },
        });
  if (itemless.length > 0) {
    const returns: Array<{ items: Array<{ productId: string; qty: unknown }> }> =
      await db.return.findMany({
        // the CN link, not the status (legacy PROCESSED rows); never an INLINE return (counted by the inline term above)
        // `orderId`: an order-linked note (OrderCreditNote) can be ANOTHER order's refund lump merely queued to apply here; its
        // Return belongs to that other order and must not be attributed to this order's lines (a false refusal otherwise).
        where: {
          creditNoteId: { in: itemless.map((c) => c.id) },
          kind: { not: "INLINE" },
          orderId,
        },
        select: { items: { select: { productId: true, qty: true } } },
      });
    const qtyByProduct = new Map<string, number>();
    for (const ret of returns)
      for (const it of ret.items ?? [])
        qtyByProduct.set(it.productId, (qtyByProduct.get(it.productId) ?? 0) + Number(it.qty));
    let acc: ReadonlyMap<string, LineCredit> = credited;
    for (const [productId, qty] of qtyByProduct)
      acc = addCredits(acc, planProductRefund(lines, acc, productId, qty, "count").items);
    credited = new Map(acc);
  }
  return { invoiceCount: invoices.length, lines, credited };
}

/**
 * The pool in PIECES (B967): each line's qty and its credited qty times its own `piecesPerQty`, every factor then 1. NO round3
 * before the multiply (1.8333 boxes of room is 22 pieces; rounding to 1.833 first makes it 21.996).
 */
export function toPiecesPool(pool: OrderPool): OrderPool {
  const factor = new Map(pool.lines.map((l) => [l.id, l.piecesPerQty ?? 1]));
  const credited = new Map<string, LineCredit>();
  for (const [id, c] of pool.credited)
    credited.set(id, { ...c, qty: c.qty * (factor.get(id) ?? 1) });
  return {
    ...pool,
    lines: pool.lines.map((l) => ({ ...l, qty: l.qty * (l.piecesPerQty ?? 1), piecesPerQty: 1 })),
    credited,
  };
}

/**
 * A return refund of `qty` PIECES of `productId` against the pool: null when it fits, else the refusal. Never clips.
 * INVARIANT (B965/B967): this check counts in pieces, like the credit-note mint. A STANDARD return's qty is in its order line's
 * own selling unit, so the caller converts it at the boundary (`ReturnsService.poolPieces` -> `standardReturnPieces`, one
 * factor) BEFORE this check. A product on lines with different pack factors, or whose factor is unknown, is never converted:
 * the refund door refuses it (`RETURN_MIXED_UNIT_PRODUCT`). B969: the single-invoice itemiser and `priceReturn` now price in pieces on both sides too (`returnPricingAxis`). KNOWN, not widened here:
 * the legacy itemless term of `loadOrderPool` attributes a Return's line-unit qty
 * onto invoice lines, so a pre-SA-628 refund on a box-unaware line is under-counted in pieces. The tolerance is EPS per line
 * scaled by that line's pieces-per-qty, like `pooledTakeRefusal`.
 */
export function pooledRefundRefusal(
  pool: OrderPool,
  productId: string,
  qty: number,
): RefundRefusal | null {
  const qtyTol = pool.lines
    .filter((l) => l.productId === productId && l.qty > 0)
    .reduce((t, l) => t + EPS * (l.piecesPerQty ?? 1), 0);
  const inPieces = toPiecesPool(pool);
  const { refusal } = planProductRefund(
    inPieces.lines,
    inPieces.credited,
    productId,
    qty,
    "refund",
    Math.max(EPS, qtyTol),
  );
  return refusal ? { ...refusal, qtyUnit: "pieces" } : null;
}

/**
 * A take of `amount` (and `qty` PIECES, when one is given) against product `productId`'s POOLED room: null when it fits, else the
 * refusal. Money binds only the lines that have money; one cent of tolerance plus the drift of prior items. The qty is in
 * PIECES: the pool's lines can use different units (a boxed selling-unit line counts boxes, a pieces line counts pieces), so each
 * line's room is converted with its own `piecesPerQty` before the lines are added; adding raw `qty` across units is wrong.
 */
export function pooledTakeRefusal(
  pool: OrderPool,
  productId: string,
  take: { amount: number; qty?: number | null },
): RefundRefusal | null {
  const mine = pool.lines.filter((l) => l.productId === productId && l.qty > 0);
  if (mine.length === 0) return null;
  let remainingQty = 0; // pieces
  let qtyTol = 0; // pieces: EPS on each line's own axis, scaled by that line's pieces-per-qty
  let remainingAmount = 0;
  let priorItems = 0;
  for (const l of mine) {
    const d = pool.credited.get(l.id) ?? { amount: 0, qty: 0 };
    const ppq = l.piecesPerQty ?? 1;
    // NO round3 before the multiply: rounding a line's room to 3 decimals and THEN scaling by pieces-per-qty grows the error
    // (1.8333 boxes rounds to 1.833 = 21.996 pieces, not 22). Stored credit qty is itself rounded to 3 decimals, so the
    // tolerance scales the same way: EPS per line, times that line's pieces-per-qty.
    remainingQty += Math.max(0, l.qty - d.qty) * ppq;
    qtyTol += EPS * ppq;
    remainingAmount += l.subtotal > EPS ? Math.max(0, roundMoney(l.subtotal - d.amount)) : 0;
    priorItems += d.items ?? 0;
  }
  remainingQty = round3(remainingQty);
  remainingAmount = roundMoney(remainingAmount);
  const tol = CENT + Math.min(0.04, 0.005 * priorItems);
  const moneyOver = take.amount > remainingAmount + tol;
  const qtyOver = take.qty != null && take.qty > remainingQty + qtyTol;
  if (!moneyOver && !qtyOver) return null;
  return {
    productId,
    requestedAmount: roundMoney(take.amount),
    remainingAmount,
    requestedQty: round3(take.qty ?? 0),
    remainingQty,
    qtyUnit: "pieces",
  };
}

/**
 * B947 (SA-214: Order -> Invoice, each set id-sorted): the order's creditable invoices and the Order row, locked FOR UPDATE
 * BEFORE any credit is read, only when the invoice's order has 2+ creditable invoices (a lone invoice keeps today's single
 * invoice lock). Call it on a tx client, FIRST in the transaction, so no writer ever takes an Invoice and then the Order.
 */
export async function lockOrderPoolRows(
  tx: any,
  invoiceId: string,
  tenantId: string | null,
): Promise<void> {
  // `"tenantId" = ${null}` is never true in SQL: a null tenant would lock NOTHING and look like it worked. Fail closed.
  if (!tenantId) throw new Error("lockOrderPoolRows: a tenant context is required");
  const inv: { orderId: string | null } | null = await tx.invoice.findFirst({
    where: { id: invoiceId },
    select: { orderId: true },
  });
  if (!inv?.orderId) return;
  const siblings: Array<{ id: string }> = await tx.invoice.findMany({
    where: { orderId: inv.orderId, status: { notIn: CREDIT_SOURCE_EXCLUDED } },
    select: { id: true },
    orderBy: [{ id: "asc" }],
  });
  if (siblings.length < 2) return;
  await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${inv.orderId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  for (const s of siblings)
    await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${s.id} AND "tenantId" = ${tenantId} FOR UPDATE`;
}

/** B947: how many creditable invoices the order has (the pool only matters from 2): ONE cheap count before any pool read. */
export async function countCreditableInvoices(db: any, orderId: string): Promise<number> {
  return db.invoice.count({ where: { orderId, status: { notIn: CREDIT_SOURCE_EXCLUDED } } });
}
