/**
 * SA-773 (row 332) - the ONE refundable remainder. Every path that gives money or credit back for invoiced goods (a refund of
 * a return, store credit for one, a standalone credit note) asks THIS function what is still left to give, under the same row
 * locks it already holds, before its claim or mint. Two value-givers can then never pay twice for the same goods, in either
 * order.
 *
 * GRAIN = `priceReturn`'s: one POOL per (billing group, product). A billing group is an order's creditable invoices (an invoice
 * with no order is a group of one), so a product sold on several lines and invoices of one order is one pool, exactly as the
 * refund prices it. The caller passes any invoice ids; the group is always the order's whole creditable set, so a subset can
 * never under-count what other invoices of the order already gave back.
 *
 * A pool's remainder is its BILLED (qty in pieces, gross value) minus:
 *   (a) every Return of the order that is not REJECTED / CANCELLED, whatever its refund method, at its stored qty (fail closed:
 *       a pending, approved or received return already reserves the goods). An INLINE return counts its stored item money
 *       (subtotal + taxAmount + categoryTax). A STANDARD return stores no item money, so its value is its qty at the pool's own
 *       gross average, the figure the goods are worth;
 *       DEVIATION FROM THE RULING TEXT (declared, for the Lead to sign off): a return whose OWN credit note is VOID reserves
 *       nothing - the credit was taken back, so the goods are creditable again (the per-line headroom has always reopened on a
 *       void, and this keeps that). It stays money-safe because a VOID note's credit can no longer be spent; a return with NO credit note
 *       (a recorded refund) always reserves;
 *   (b) standalone CreditNoteItem rows on the pool's lines whose credit note is not VOID and is not a counted Return's own credit
 *       note (that money is already in (a); never twice). Gross = amount + categoryTax + roundMoney(amount x the line's stored
 *       taxRate);
 *   (c) amount-only credit notes of the group's invoices (no items, not VOID, not a Return's): they cannot be placed on a line, so
 *       they reduce only the group's invoice-level value, fail closed.
 * Not netted: price adjustments and discounts (already in the billed lines), payments and write-offs (the cash cap and the
 * invoice status own those). The numbers are NOT clamped: an old pool that was over-credited reads <= 0, so any further
 * value-giver on it is refused.
 *
 * The function only READS; it takes no lock. The caller holds the order and invoice locks (house order, Order before its
 * invoices id-sorted) and the remainder is read under them. Row filters on status and exclusions run here in code, over the rows
 * the queries scope by id, so the formula is the same one the specs pin.
 */
import { ConflictException } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { piecesPerQtyOf } from "../credit-notes/line-credit-headroom";
import { CREDIT_SOURCE_EXCLUDED } from "../invoices/invoice-status-sets";
import { DEAD_RETURN_STATUSES } from "./return-statuses";
import { PACK_LINE_SELECT, packFactorOrReason, standardPackBases } from "./returns-pieces.util";
import type { ProductPackBasis } from "./returns-restock-pieces";

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const DEAD = new Set<string>(DEAD_RETURN_STATUSES);
const EXCLUDED_INVOICE = new Set<string>(CREDIT_SOURCE_EXCLUDED);
/** One cent, plus half a cent of rounding drift per earlier item (at most 4 cents), like the line headroom's tolerance. */
const valueTolerance = (items: number): number => 0.01 + Math.min(0.04, 0.005 * items);

/** What is left of one pool. `qty` is in PIECES. May be <= 0 (an over-credited pool); never clamped. */
export interface PoolRemainder {
  qty: number;
  value: number;
  /** Tolerance on `qty` (0.001 per billed line, scaled by the line's pieces per qty). */
  qtyTol: number;
  /** Tolerance on `value` (one cent plus the rounding drift of the items already subtracted). */
  valueTol: number;
  /** Pieces per qty of the pool's lines when they agree, else 1: what a STANDARD qty with no pack proof is counted at. */
  unitFactor: number;
  /** Net (pre-tax) billed value per piece of the pool: what a STANDARD return of its goods is priced at (the pooled average). */
  unitNet: number;
}

/** What is left of a billing group's invoices as a whole (includes the amount-only credit notes of (c)). */
export interface InvoiceRemainder {
  value: number;
  valueTol: number;
}

export interface RefundableRemainder {
  /** Key `${invoiceId}:${productId}` (see {@link poolKey}). Every invoice of a group that bills the product points at ONE shared pool: read one, never add them. */
  byInvoiceProduct: Map<string, PoolRemainder>;
  /** Key invoiceId. Every invoice of a group shares ONE entry. */
  byInvoice: Map<string, InvoiceRemainder>;
}

export const poolKey = (invoiceId: string, productId: string): string =>
  `${invoiceId}:${productId}`;

interface Line {
  id: string;
  invoiceId: string;
  productId: string;
  ppq: number;
  taxRate: number;
}
interface Pool {
  billedQty: number;
  billedValue: number;
  billedNet: number;
  qtyTol: number;
  qtyOut: number;
  valueOut: number;
  items: number;
  ppqs: Set<number>;
  invoiceIds: Set<string>;
}
interface Group {
  invoiceIds: string[];
  pools: Map<string, Pool>;
  amountOnlyOut: number;
  amountOnlyItems: number;
}

/** A credit note row whose status is VOID (its credit was taken back: it holds no goods). */
const isVoidNote = (note: { status?: string | null } | null | undefined): boolean =>
  note?.status === "VOID";

const poolUnitFactor = (pool: Pool): number => (pool.ppqs.size === 1 ? [...pool.ppqs][0] : 1);

/** The gross value of one invoice line: its net subtotal, its regular tax at the line's stored rate, its category tax. */
export function lineGrossValue(line: {
  subtotal?: unknown;
  taxRate?: unknown;
  categoryTaxAmount?: unknown;
}): number {
  const net = roundMoney(num(line.subtotal));
  return roundMoney(net + roundMoney(net * num(line.taxRate)) + num(line.categoryTaxAmount));
}

const INVOICE_SELECT = {
  id: true,
  orderId: true,
  status: true,
  items: {
    select: {
      id: true,
      productId: true,
      qty: true,
      subtotal: true,
      taxRate: true,
      categoryTaxAmount: true,
      boxes: true,
      pieces: true,
      unitsPerBox: true,
      product: { select: { unitsPerBox: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
} as const;

/** The where of "these invoices, and every creditable invoice of the orders they belong to". */
const groupWhere = (ids: readonly string[]) => ({
  status: { notIn: [...CREDIT_SOURCE_EXCLUDED] },
  OR: [{ id: { in: [...ids] } }, { order: { invoices: { some: { id: { in: [...ids] } } } } }],
});

/**
 * The given invoices plus every creditable invoice of their orders, id-sorted: the set a value-giver must lock (Order first)
 * before it reads the remainder, so the whole pool is serialised and not just the invoice it names.
 */
export async function creditableGroupInvoiceIds(
  tx: any,
  invoiceIds: readonly string[],
): Promise<string[]> {
  const ids = [...new Set(invoiceIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows: Array<{ id: string }> = await tx.invoice.findMany({
    where: groupWhere(ids),
    select: { id: true },
  });
  return [...new Set([...ids, ...rows.map((r) => r.id)])].sort();
}

export async function refundableRemainder(
  tx: any,
  args: {
    invoiceIds: readonly string[];
    /** The return being refunded / re-issued: it is the request, so its own reservation is not subtracted. */
    excludeReturnId?: string;
    /** The credit note being re-issued / edited: its own credit is not subtracted. */
    excludeCreditNoteId?: string;
  },
): Promise<RefundableRemainder> {
  const result: RefundableRemainder = { byInvoiceProduct: new Map(), byInvoice: new Map() };
  const ids = [...new Set(args.invoiceIds.filter(Boolean))].sort();
  if (ids.length === 0) return result;
  const { excludeReturnId, excludeCreditNoteId } = args;

  // 1. BILLED: the invoices and their lines, grouped by order
  const invoices: Array<{
    id: string;
    orderId: string | null;
    status?: string;
    items?: any[];
  }> = await tx.invoice.findMany({
    where: groupWhere(ids),
    select: INVOICE_SELECT,
    orderBy: [{ id: "asc" }],
  });
  const groups = new Map<string, Group>();
  const groupOfInvoice = new Map<string, Group>();
  const lineById = new Map<string, Line>();
  const groupOfOrder = new Map<string, Group>();
  const orderOfGroup = new Map<Group, string | null>();
  for (const inv of invoices) {
    if (inv.status && EXCLUDED_INVOICE.has(inv.status)) continue;
    const key = inv.orderId ?? `invoice:${inv.id}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        invoiceIds: [],
        pools: new Map(),
        amountOnlyOut: 0,
        amountOnlyItems: 0,
      };
      groups.set(key, group);
      orderOfGroup.set(group, inv.orderId);
      if (inv.orderId) groupOfOrder.set(inv.orderId, group);
    }
    group.invoiceIds.push(inv.id);
    groupOfInvoice.set(inv.id, group);
    for (const it of inv.items ?? []) {
      if (!it.id || !it.productId) continue;
      const ppq = piecesPerQtyOf(it);
      lineById.set(it.id, {
        id: it.id,
        invoiceId: inv.id,
        productId: it.productId,
        ppq,
        taxRate: num(it.taxRate),
      });
      const pool =
        group.pools.get(it.productId) ??
        ({
          billedQty: 0,
          billedValue: 0,
          billedNet: 0,
          qtyTol: 0,
          qtyOut: 0,
          valueOut: 0,
          items: 0,
          ppqs: new Set<number>(),
          invoiceIds: new Set<string>(),
        } as Pool);
      pool.billedQty += num(it.qty) * ppq;
      pool.billedValue += lineGrossValue(it);
      pool.billedNet += roundMoney(num(it.subtotal));
      pool.qtyTol += 0.001 * ppq;
      pool.ppqs.add(ppq);
      pool.invoiceIds.add(inv.id);
      group.pools.set(it.productId, pool);
    }
  }
  if (groups.size === 0) return result;
  const orderIds = [...groupOfOrder.keys()].sort();
  const memberInvoiceIds = [...groupOfInvoice.keys()].sort();
  const lineIds = [...lineById.keys()];

  // 2. (a) RETURNS of the order(s): STANDARD by Return.orderId, INLINE by the item's source order
  // a return whose own credit note was voided gave nothing back (the credit was taken away): it reserves nothing
  const voidReturnNotes = new Set<string>();
  const counted = (r: {
    id?: string;
    status?: string | null;
    creditNoteId?: string | null;
  }): boolean =>
    !(r.status && DEAD.has(r.status)) &&
    r.id !== excludeReturnId &&
    !(r.creditNoteId && voidReturnNotes.has(r.creditNoteId));
  const standard: Array<{
    id: string;
    orderId: string | null;
    kind?: string | null;
    status?: string | null;
    creditNoteId?: string | null;
    items?: Array<{ productId: string; qty: unknown }>;
  }> =
    orderIds.length > 0
      ? await tx.return.findMany({
          where: { orderId: { in: orderIds }, kind: "STANDARD" },
          select: {
            id: true,
            orderId: true,
            kind: true,
            status: true,
            creditNoteId: true,
            items: { select: { productId: true, qty: true } },
          },
        })
      : [];
  const inlineItems: Array<{
    productId: string;
    qty: unknown;
    sourceOrderId: string | null;
    subtotal?: unknown;
    taxAmount?: unknown;
    categoryTax?: unknown;
    return?: {
      id?: string;
      kind?: string | null;
      status?: string | null;
      creditNoteId?: string | null;
    } | null;
  }> =
    orderIds.length > 0
      ? await tx.returnItem.findMany({
          where: { sourceOrderId: { in: orderIds }, return: { kind: "INLINE" } },
          select: {
            productId: true,
            qty: true,
            sourceOrderId: true,
            subtotal: true,
            taxAmount: true,
            categoryTax: true,
            return: { select: { id: true, kind: true, status: true, creditNoteId: true } },
          },
        })
      : [];
  const returnNoteIds = [
    ...new Set(
      [...standard, ...inlineItems.map((i) => i.return ?? {})]
        .filter(
          (r: any) =>
            r.creditNoteId && !(r.status && DEAD.has(r.status)) && r.id !== excludeReturnId,
        )
        .map((r: any) => r.creditNoteId as string),
    ),
  ];
  if (returnNoteIds.length > 0) {
    const notes: Array<{ id: string; status?: string | null }> = await tx.creditNote.findMany({
      where: { id: { in: returnNoteIds } },
      select: { id: true, status: true },
    });
    for (const n of notes) if (n.status === "VOID") voidReturnNotes.add(n.id);
  }
  const standardCounted = standard.filter((r) => r.kind !== "INLINE" && counted(r) && r.orderId);

  // STANDARD qty is in the order line's own unit: pieces through the order's pack basis (same reader the over-return cap uses)
  const basesByOrder = new Map<string, Map<string, ProductPackBasis>>();
  for (const orderId of new Set(standardCounted.map((r) => r.orderId as string))) {
    if (!standardCounted.some((r) => r.orderId === orderId && (r.items?.length ?? 0) > 0)) continue;
    const lines: any[] = await tx.orderItem.findMany({
      where: { orderId, status: { not: "CANCELLED" } },
      select: PACK_LINE_SELECT,
    });
    basesByOrder.set(orderId, await standardPackBases(tx, orderId, lines));
  }
  for (const ret of standardCounted) {
    const group = groupOfOrder.get(ret.orderId as string);
    if (!group) continue;
    const bases = basesByOrder.get(ret.orderId as string) ?? new Map();
    for (const it of ret.items ?? []) {
      const pool = group.pools.get(it.productId);
      if (!pool) continue;
      const f = packFactorOrReason(bases, it.productId);
      const factor = "factor" in f ? f.factor : poolUnitFactor(pool);
      const pieces = num(it.qty) * factor;
      pool.qtyOut += pieces;
      pool.valueOut += pool.billedQty > 0 ? (pieces * pool.billedValue) / pool.billedQty : 0;
      pool.items += 1;
    }
  }
  for (const it of inlineItems) {
    if (it.return?.kind && it.return.kind !== "INLINE") continue;
    if (!counted(it.return ?? {}) || !it.sourceOrderId) continue;
    const pool = groupOfOrder.get(it.sourceOrderId)?.pools.get(it.productId);
    if (!pool) continue;
    pool.qtyOut += num(it.qty);
    pool.valueOut += roundMoney(num(it.subtotal) + num(it.taxAmount) + num(it.categoryTax));
    pool.items += 1;
  }

  // 3. (b) standalone credit note items and (c) amount-only credit notes, minus every counted Return's own credit note
  const cnItems: Array<{
    invoiceItemId: string | null;
    creditNoteId: string;
    qty: unknown;
    amount: unknown;
    categoryTax: unknown;
    creditNote?: { status?: string | null } | null;
  }> =
    lineIds.length > 0
      ? await tx.creditNoteItem.findMany({
          where: { invoiceItemId: { in: lineIds } },
          select: {
            invoiceItemId: true,
            creditNoteId: true,
            qty: true,
            amount: true,
            categoryTax: true,
            creditNote: { select: { status: true } },
          },
        })
      : [];
  const amountOnly: Array<{
    id: string;
    invoiceId: string | null;
    amount: unknown;
    status?: string | null;
  }> =
    memberInvoiceIds.length > 0
      ? await tx.creditNote.findMany({
          where: { invoiceId: { in: memberInvoiceIds }, items: { none: {} } },
          select: { id: true, invoiceId: true, amount: true, status: true },
        })
      : [];
  const liveItems = cnItems.filter(
    (row) => !isVoidNote(row.creditNote) && row.creditNoteId !== excludeCreditNoteId,
  );
  const liveAmountOnly = amountOnly.filter(
    (note) => !isVoidNote(note) && note.id !== excludeCreditNoteId,
  );
  const cnIds = [
    ...new Set([...liveItems.map((i) => i.creditNoteId), ...liveAmountOnly.map((c) => c.id)]),
  ];
  const returnCreditNotes: Array<{
    id?: string;
    creditNoteId: string | null;
    status?: string | null;
  }> =
    cnIds.length > 0
      ? await tx.return.findMany({
          where: { creditNoteId: { in: cnIds } },
          select: { id: true, creditNoteId: true, status: true },
        })
      : [];
  // a credit note of a return that is counted in (a), or the one being refunded now, is never "standalone"
  const returnsOwn = new Set(
    returnCreditNotes
      .filter(
        (r) => r.creditNoteId && (r.id === excludeReturnId || !(r.status && DEAD.has(r.status))),
      )
      .map((r) => r.creditNoteId as string),
  );
  for (const it of liveItems) {
    if (!it.invoiceItemId || returnsOwn.has(it.creditNoteId)) continue;
    const line = lineById.get(it.invoiceItemId);
    if (!line?.productId) continue;
    const pool = groupOfInvoice.get(line.invoiceId)?.pools.get(line.productId);
    if (!pool) continue;
    const amount = roundMoney(num(it.amount));
    pool.qtyOut += num(it.qty) * line.ppq;
    pool.valueOut += roundMoney(amount + num(it.categoryTax) + roundMoney(amount * line.taxRate));
    pool.items += 1;
  }
  for (const cn of liveAmountOnly) {
    if (!cn.invoiceId || returnsOwn.has(cn.id)) continue;
    const group = groupOfInvoice.get(cn.invoiceId);
    if (!group) continue;
    group.amountOnlyOut += roundMoney(num(cn.amount));
    group.amountOnlyItems += 1;
  }

  // 4. the remainders
  for (const group of groups.values()) {
    // a group that bills no goods (no product lines) has nothing to reason about: it caps nothing, as before
    if (group.pools.size === 0) continue;
    // the invoice-level figure is the product lines' gross value: header discounts, shipping and fee lines are not goods
    let billed = 0;
    let poolValueOut = 0;
    let items = group.amountOnlyItems;
    for (const [productId, pool] of group.pools) {
      billed += pool.billedValue;
      // a pool credited past its value (read <= 0 below) must not eat the room of the invoice's OTHER goods
      poolValueOut += Math.min(pool.valueOut, pool.billedValue);
      items += pool.items;
      const remainder: PoolRemainder = {
        qty: round3(pool.billedQty - pool.qtyOut),
        value: roundMoney(pool.billedValue - pool.valueOut),
        qtyTol: Math.max(0.001, pool.qtyTol),
        valueTol: valueTolerance(pool.items),
        unitFactor: poolUnitFactor(pool),
        unitNet: pool.billedQty > 0 ? pool.billedNet / pool.billedQty : 0,
      };
      for (const invoiceId of pool.invoiceIds)
        result.byInvoiceProduct.set(poolKey(invoiceId, productId), remainder);
    }
    const invoiceLevel: InvoiceRemainder = {
      value: roundMoney(billed - poolValueOut - group.amountOnlyOut),
      valueTol: valueTolerance(items),
    };
    for (const invoiceId of group.invoiceIds) result.byInvoice.set(invoiceId, invoiceLevel);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// The check every value-giver runs on its own request

/** What a value-giver wants to give back: `qty` in PIECES and/or a gross `value`, against one invoice (and product). */
export interface RefundableRequest {
  invoiceId: string;
  /** Absent for an amount-only credit: it is checked against the invoice-level value alone. */
  productId?: string | null;
  qty?: number;
  value?: number;
}

export interface RefundableRefusal {
  invoiceId: string;
  productId?: string;
  /** Pieces left in the pool (null for the invoice-level refusal); never below 0 in the answer. */
  remainingQty: number | null;
  remainingValue: number;
}

const floor0 = (n: number): number => (n > 0 ? n : 0);

/**
 * The first pool (or invoice) the requests exceed, else null. Requests on one pool are added first, so two lines of one product
 * cannot each fit and together overshoot. Never clamps: a refusal names what is left.
 */
export function refundableRefusal(
  rem: RefundableRemainder,
  requests: readonly RefundableRequest[],
): RefundableRefusal | null {
  const perPool = new Map<
    PoolRemainder,
    { invoiceId: string; productId: string; qty: number; value: number }
  >();
  const perInvoice = new Map<InvoiceRemainder, { invoiceId: string; value: number }>();
  for (const r of requests) {
    if (r.productId) {
      const pool = rem.byInvoiceProduct.get(poolKey(r.invoiceId, r.productId));
      if (pool) {
        const acc = perPool.get(pool) ?? {
          invoiceId: r.invoiceId,
          productId: r.productId,
          qty: 0,
          value: 0,
        };
        acc.qty += r.qty ?? 0;
        acc.value += r.value ?? 0;
        perPool.set(pool, acc);
      }
    }
    const inv = rem.byInvoice.get(r.invoiceId);
    if (inv && r.value) {
      const acc = perInvoice.get(inv) ?? { invoiceId: r.invoiceId, value: 0 };
      acc.value += r.value;
      perInvoice.set(inv, acc);
    }
  }
  for (const [pool, acc] of perPool) {
    if (acc.qty > pool.qty + pool.qtyTol || acc.value > pool.value + pool.valueTol)
      return {
        invoiceId: acc.invoiceId,
        productId: acc.productId,
        remainingQty: round3(floor0(pool.qty)),
        remainingValue: roundMoney(floor0(pool.value)),
      };
  }
  for (const [inv, acc] of perInvoice) {
    if (acc.value > inv.value + inv.valueTol)
      return {
        invoiceId: acc.invoiceId,
        remainingQty: null,
        remainingValue: roundMoney(floor0(inv.value)),
      };
  }
  return null;
}

const REFUSAL_MESSAGE: Record<string, string> = {
  [API_ERROR_CODES.RETURN_EXCEEDS_REFUNDABLE]:
    "This is more than what is still refundable for these goods: part of it was already returned or credited. Reduce the amount, or cancel the return.",
  [API_ERROR_CODES.CREDIT_EXCEEDS_REFUNDABLE]:
    "This credit is more than what is still creditable for these goods: part of it was already returned or credited. Reduce the amount.",
};

export type RefundableRefusalCode =
  | typeof API_ERROR_CODES.RETURN_EXCEEDS_REFUNDABLE
  | typeof API_ERROR_CODES.CREDIT_EXCEEDS_REFUNDABLE;

/** 409 `code` { invoiceId, productId?, remainingQty, remainingValue } when the requests exceed the remainder; else nothing. */
export function assertWithinRefundable(
  rem: RefundableRemainder,
  requests: readonly RefundableRequest[],
  code: RefundableRefusalCode,
): void {
  const refusal = refundableRefusal(rem, requests);
  if (refusal) throw new ConflictException({ code, message: REFUSAL_MESSAGE[code], ...refusal });
}

/** The invoice id of `invoiceIds` whose group has a pool for `productId` (the key a STANDARD request reads), else undefined. */
export function invoiceIdForProduct(
  rem: RefundableRemainder,
  invoiceIds: readonly string[],
  productId: string,
): string | undefined {
  return invoiceIds.find((id) => rem.byInvoiceProduct.has(poolKey(id, productId)));
}

/**
 * The requests of a STANDARD return: its qty per product in PIECES (the order line's unit through its pack basis, the same
 * conversion the over-return cap uses; an unknown basis counts the typed qty as it is) and, per product, its VALUE: the pieces at the
 * pool's pooled net average, which is the price `priceReturn` gives them (a recorded EXTERNAL_REFUND has no other value gate), plus
 * the refund's net `value` against the invoice-level remainder. A product billed on none of the invoices has no pool and is not requested here.
 */
export function standardReturnRequests(
  rem: RefundableRemainder,
  invoiceIds: readonly string[],
  items: ReadonlyArray<{ productId: string; qty: unknown }>,
  bases: Map<string, ProductPackBasis>,
  value: number,
): RefundableRequest[] {
  const qtyByProduct = new Map<string, number>();
  for (const it of items)
    qtyByProduct.set(it.productId, (qtyByProduct.get(it.productId) ?? 0) + num(it.qty));
  const requests: RefundableRequest[] = [];
  for (const [productId, qty] of qtyByProduct) {
    const invoiceId = invoiceIdForProduct(rem, invoiceIds, productId);
    if (!invoiceId) continue;
    const f = packFactorOrReason(bases, productId);
    const unit = rem.byInvoiceProduct.get(poolKey(invoiceId, productId))?.unitFactor ?? 1;
    const pieces = qty * ("factor" in f ? f.factor : unit);
    const unitNet = rem.byInvoiceProduct.get(poolKey(invoiceId, productId))?.unitNet ?? 0;
    requests.push({ invoiceId, productId, qty: pieces, value: roundMoney(pieces * unitNet) });
  }
  // each product's value already counts at the invoice level; the refund's own figure stands in only when no product has a pool
  const anchor = invoiceIds.find((id) => rem.byInvoice.has(id));
  if (anchor && value > 0 && requests.length === 0)
    requests.push({ invoiceId: anchor, value: roundMoney(value) });
  return requests;
}

/**
 * The requests of an INLINE return: each stored item's pieces and money (subtotal + tax + category tax) against the pool of the
 * invoice its source line sits on. An item with no source line (unreferenced) or whose line is gone has no pool; the refund's
 * paid-in-full check already fails closed on those.
 */
export async function inlineReturnRequests(
  tx: any,
  items: ReadonlyArray<{
    productId: string;
    qty: unknown;
    sourceInvoiceItemId?: string | null;
    subtotal?: unknown;
    taxAmount?: unknown;
    categoryTax?: unknown;
  }>,
): Promise<RefundableRequest[]> {
  const lineIds = [
    ...new Set(items.map((i) => i.sourceInvoiceItemId).filter((i): i is string => !!i)),
  ];
  if (lineIds.length === 0) return [];
  const lines: Array<{ id: string; invoiceId: string }> = await tx.invoiceItem.findMany({
    where: { id: { in: lineIds } },
    select: { id: true, invoiceId: true },
  });
  const invoiceOf = new Map(lines.map((l) => [l.id, l.invoiceId]));
  const requests: RefundableRequest[] = [];
  for (const it of items) {
    const invoiceId = it.sourceInvoiceItemId ? invoiceOf.get(it.sourceInvoiceItemId) : undefined;
    if (!invoiceId) continue;
    requests.push({
      invoiceId,
      productId: it.productId,
      qty: num(it.qty),
      value: roundMoney(num(it.subtotal) + num(it.taxAmount) + num(it.categoryTax)),
    });
  }
  return requests;
}

/**
 * The requests of a credit note: each item's pieces and gross value (amount + category tax + the line's tax at its stored rate)
 * against the pool of the line's invoice; an amount-only credit note is its amount against the invoice-level remainder alone.
 */
export async function creditNoteRequests(
  tx: any,
  input: {
    invoiceId: string;
    amount: number;
    items: ReadonlyArray<{
      invoiceItemId: string;
      amount: number;
      qty: number;
      categoryTax?: number;
    }>;
  },
): Promise<RefundableRequest[]> {
  if (input.items.length === 0)
    return [{ invoiceId: input.invoiceId, value: roundMoney(input.amount) }];
  const lines: any[] = await tx.invoiceItem.findMany({
    where: { id: { in: input.items.map((i) => i.invoiceItemId) } },
    select: {
      id: true,
      invoiceId: true,
      productId: true,
      qty: true,
      taxRate: true,
      boxes: true,
      pieces: true,
      unitsPerBox: true,
      product: { select: { unitsPerBox: true } },
    },
  });
  const lineById = new Map(lines.map((l) => [l.id as string, l]));
  const requests: RefundableRequest[] = [];
  for (const item of input.items) {
    const line = lineById.get(item.invoiceItemId);
    if (!line) continue;
    const amount = roundMoney(num(item.amount));
    requests.push({
      invoiceId: line.invoiceId,
      productId: line.productId,
      qty: num(item.qty) * piecesPerQtyOf(line),
      value: roundMoney(amount + num(item.categoryTax) + roundMoney(amount * num(line.taxRate))),
    });
  }
  return requests;
}

/**
 * What is still refundable for the SELECTED goods, in value: the sum of each distinct pool's remainder (never below 0), held to
 * the remainder of its invoice group. This is the figure a quote's `cashRefundable` takes with the cash room:
 * `min(cash room, selectedGoodsRemainder(...))`. Pure over a remainder the caller read under the locks.
 */
export function selectedGoodsRemainder(
  rem: RefundableRemainder,
  goods: ReadonlyArray<{ invoiceId: string; productId: string }>,
): number {
  const pools = new Set<PoolRemainder>();
  const perInvoice = new Map<InvoiceRemainder, number>();
  for (const g of goods) {
    const pool = rem.byInvoiceProduct.get(poolKey(g.invoiceId, g.productId));
    const inv = rem.byInvoice.get(g.invoiceId);
    if (!pool || !inv || pools.has(pool)) continue;
    pools.add(pool);
    perInvoice.set(inv, (perInvoice.get(inv) ?? 0) + floor0(pool.value));
  }
  let total = 0;
  for (const [inv, value] of perInvoice) total += Math.min(value, floor0(inv.value));
  return roundMoney(total);
}
