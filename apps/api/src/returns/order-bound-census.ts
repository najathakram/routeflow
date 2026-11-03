/**
 * SA-1091 piece 1 (row 631): READ-ONLY census of the OLD rows, ported to the helper's terms (an owner-run report; it never
 * feeds a figure and never changes a row). The order-wide bound (`loadOrderRefundRoom`) starts refusing a take past the room;
 * what was given back before it existed stays as it is. This counts how much of that there is:
 *
 *   orders.overBound   orders whose room is already below zero, read by `loadOrderRefundRoom` itself (the bound's own figure,
 *                      never a copy): their LATER credits are refused, nothing else changes. A remedy is the owner's call.
 *   inline.*           the second count SA-1091 owes: invoices whose STORED inline gross (net + tax + category tax of the live
 *                      inline return rows sourced from their lines) passes what the invoice CHARGED for those lines, priced by
 *                      `refundableLineShare` for the whole line with no prior. Per invoice (sums) and per line. "Reopen the
 *                      A-1 repricing only if this count isn't small."
 *
 * COUNTS ONLY: no tenant, customer, order, invoice or amount is returned; the over amounts are bucketed (a cent, up to a
 * dollar, more). `apps/api/scripts/report-sa1091-order-bound-census.mjs` is the thin runner (read-only session, ROLLBACK).
 */
import { refundableInvoiceOf, refundableLineShare, roundMoney } from "@routeflow/pricing";
import { loadOrderRefundRoom } from "../credit-notes/line-credit-headroom";
import { CREDIT_SOURCE_EXCLUDED } from "../invoices/invoice-status-sets";

/** The same two statuses `loadOrderRefundRoom` leaves out of an inline return's gross. */
const DEAD_RETURN = ["CANCELLED", "REJECTED"];
/** Half a cent: stored money is whole cents, so anything past this is at least one cent. */
const EPS = 0.005;
const BATCH = 500;

export interface OverBuckets {
  /** over by exactly a cent (or less than 1.5 cents) */
  upToOneCent: number;
  /** over by more than a cent, up to a dollar */
  upToOneDollar: number;
  /** over by more than a dollar */
  overOneDollar: number;
}

export interface OrderBoundCensus {
  orders: {
    /** anchors read: an order (or an order-less invoice) that gave something back */
    scanned: number;
    /** scanned anchors with no creditable invoice, so no bound (the helper returns null) */
    noBound: number;
    overBound: number;
    overBy: OverBuckets;
    /** of the over-bound anchors, how many have each giver above zero (one anchor can count in several) */
    overBoundGivers: { notes: number; unlinked: number; recorded: number; inline: number };
  };
  inline: {
    /** invoices with at least one live inline return row sourced from a line (not void / written off) */
    invoicesWithInline: number;
    /** invoices whose Σ stored inline gross passes Σ what their lines charged */
    invoicesPastCharge: number;
    invoicesPastBy: OverBuckets;
    /** invoice lines whose stored inline gross passes the line's charge */
    linesPastCharge: number;
    /** invoices the helper could not read (a bad stored pool): counted, never guessed */
    invoicesUnreadable: number;
  };
  /** plain counts that prove the database is live: all 0 = the run proved nothing */
  denominators: {
    creditableInvoicesWithLiveNotes: number;
    liveInlineReturnItems: number;
    liveStandardReturnOrders: number;
  };
}

const zeroBuckets = (): OverBuckets => ({ upToOneCent: 0, upToOneDollar: 0, overOneDollar: 0 });

function bucket(into: OverBuckets, over: number) {
  if (over <= 0.015) into.upToOneCent += 1;
  else if (over <= 1) into.upToOneDollar += 1;
  else into.overOneDollar += 1;
}

const chunks = <T>(xs: readonly T[], n = BATCH): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

const grossOf = (it: { subtotal: unknown; taxAmount: unknown; categoryTax: unknown }) =>
  Number(it.subtotal ?? 0) + Number(it.taxAmount ?? 0) + Number(it.categoryTax ?? 0);

/** Plain reads only (findMany / count). Pass a read-only transaction client. `tenantId` narrows every read to one tenant (specs). */
export async function censusOrderBound(
  db: any,
  opts: { tenantId?: string } = {},
): Promise<OrderBoundCensus> {
  const tenantWhere = opts.tenantId ? { tenantId: opts.tenantId } : {};
  const result: OrderBoundCensus = {
    orders: {
      scanned: 0,
      noBound: 0,
      overBound: 0,
      overBy: zeroBuckets(),
      overBoundGivers: { notes: 0, unlinked: 0, recorded: 0, inline: 0 },
    },
    inline: {
      invoicesWithInline: 0,
      invoicesPastCharge: 0,
      invoicesPastBy: zeroBuckets(),
      linesPastCharge: 0,
      invoicesUnreadable: 0,
    },
    denominators: {
      creditableInvoicesWithLiveNotes: 0,
      liveInlineReturnItems: 0,
      liveStandardReturnOrders: 0,
    },
  };

  // 1. The live inline rows that name a source line, and the invoice each line sits on
  const inlineItems: Array<{
    subtotal: unknown;
    taxAmount: unknown;
    categoryTax: unknown;
    sourceInvoiceItemId: string;
  }> = await db.returnItem.findMany({
    where: {
      ...tenantWhere,
      sourceInvoiceItemId: { not: null },
      return: { kind: "INLINE", status: { notIn: DEAD_RETURN } },
    },
    select: {
      subtotal: true,
      taxAmount: true,
      categoryTax: true,
      sourceInvoiceItemId: true,
    },
  });
  result.denominators.liveInlineReturnItems = inlineItems.length;
  const storedByLine = new Map<string, number>();
  for (const it of inlineItems)
    storedByLine.set(
      it.sourceInvoiceItemId,
      roundMoney((storedByLine.get(it.sourceInvoiceItemId) ?? 0) + grossOf(it)),
    );
  const invoiceOfLine = new Map<string, string>();
  const anchors = new Map<string, { orderId?: string; invoiceId?: string }>();
  const anchorOf = (inv: { id: string; orderId: string | null }) =>
    anchors.set(inv.orderId ? `o:${inv.orderId}` : `i:${inv.id}`, {
      ...(inv.orderId ? { orderId: inv.orderId } : { invoiceId: inv.id }),
    });
  for (const ids of chunks([...storedByLine.keys()])) {
    const lines: Array<{ id: string; invoiceId: string; invoice: any }> =
      await db.invoiceItem.findMany({
        where: {
          id: { in: ids },
          ...tenantWhere,
          invoice: { status: { notIn: CREDIT_SOURCE_EXCLUDED } },
        },
        select: { id: true, invoiceId: true, invoice: { select: { id: true, orderId: true } } },
      });
    for (const l of lines) {
      invoiceOfLine.set(l.id, l.invoiceId);
      anchorOf(l.invoice);
    }
  }

  // 2. Every creditable invoice with a live credit note, and every order with a live standard return
  const withNotes: Array<{ id: string; orderId: string | null }> = await db.invoice.findMany({
    where: {
      ...tenantWhere,
      status: { notIn: CREDIT_SOURCE_EXCLUDED },
      creditNotes: { some: { status: { not: "VOID" } } },
    },
    select: { id: true, orderId: true },
  });
  result.denominators.creditableInvoicesWithLiveNotes = withNotes.length;
  for (const inv of withNotes) anchorOf(inv);
  const standard: Array<{ orderId: string }> = await db.return.findMany({
    where: { ...tenantWhere, kind: { not: "INLINE" }, status: { notIn: DEAD_RETURN } },
    select: { orderId: true },
    distinct: ["orderId"],
  });
  result.denominators.liveStandardReturnOrders = standard.length;
  for (const r of standard) anchors.set(`o:${r.orderId}`, { orderId: r.orderId });

  // 3. The order-wide bound, read by the helper itself
  for (const anchor of anchors.values()) {
    result.orders.scanned += 1;
    const room = await loadOrderRefundRoom(db, anchor);
    if (!room) {
      result.orders.noBound += 1;
      continue;
    }
    if (room.room >= -EPS) continue;
    result.orders.overBound += 1;
    bucket(result.orders.overBy, roundMoney(-room.room));
    for (const g of ["notes", "unlinked", "recorded", "inline"] as const)
      if (room.given[g] > EPS) result.orders.overBoundGivers[g] += 1;
  }

  // 4. Stored inline gross against what each invoice charged for those lines
  const storedByInvoice = new Map<string, Map<string, number>>();
  for (const [lineId, stored] of storedByLine) {
    const invoiceId = invoiceOfLine.get(lineId);
    if (!invoiceId) continue; // a line on a void / written-off invoice, or gone
    if (!storedByInvoice.has(invoiceId)) storedByInvoice.set(invoiceId, new Map());
    storedByInvoice.get(invoiceId)!.set(lineId, stored);
  }
  result.inline.invoicesWithInline = storedByInvoice.size;
  for (const ids of chunks([...storedByInvoice.keys()], 100)) {
    const invoices: any[] = await db.invoice.findMany({
      where: { id: { in: ids } },
      include: { items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
    });
    for (const inv of invoices) {
      const stored = storedByInvoice.get(inv.id)!;
      try {
        const view = refundableInvoiceOf(inv);
        let chargeSum = 0;
        let storedSum = 0;
        for (const [lineId, storedGross] of stored) {
          const line = view.lines.find((l) => l.id === lineId);
          if (!line || line.isNsf) {
            storedSum = roundMoney(storedSum + storedGross);
            continue; // not goods: nothing charged for it as goods, so all of it is past
          }
          const charge = refundableLineShare({
            invoice: view,
            lineId,
            returnedQty: Number(line.qty),
            prior: { qty: 0, net: 0, tax: 0, categoryTax: 0 },
          });
          chargeSum = roundMoney(chargeSum + charge.total);
          storedSum = roundMoney(storedSum + storedGross);
          if (storedGross > charge.total + EPS) result.inline.linesPastCharge += 1;
        }
        if (storedSum > chargeSum + EPS) {
          result.inline.invoicesPastCharge += 1;
          bucket(result.inline.invoicesPastBy, roundMoney(storedSum - chargeSum));
        }
      } catch {
        result.inline.invoicesUnreadable += 1;
      }
    }
  }
  return result;
}
