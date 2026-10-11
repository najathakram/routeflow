import { InvoiceStatus } from "@prisma/client";
import type { PrismaService } from "../../../prisma/prisma.service";
import {
  creditNotesInWindowWhere,
  handOverCandidatesWhere,
  liveCounterSalesWhere,
  paidOnDaysSalesWhere,
  salePaymentsWhere,
  windowReturnsWhere,
  type DayWindow,
} from "../counter-sale-today";
import { pickupTenderGroupId } from "../pickup-tender-group";
import type { WindowFacts, WindowPayment } from "./day-close-fold";
import { registerOrderWhere } from "./day-close-register";

type Db = ReturnType<PrismaService["forTenant"]>;

/**
 * The window `[start, end)`'s queries, for one (tenant, register). They are the Today's-sales where-builders (ONE definition of
 * "a live counter sale", "money that came in", "a return counted in the window": L-167) with the register filter AND-ed on the
 * order. `db` is the tenant-scoped client or the close transaction's tenant-wrapped client; every where also names `tenantId`.
 * Run in order, never in parallel: the close runs them inside its transaction on one connection.
 */
export async function readWindowFacts(
  db: Db,
  tenantId: string,
  registerKey: string,
  w: DayWindow,
): Promise<WindowFacts> {
  const reg = registerOrderWhere(registerKey);
  const sales = await db.order.aggregate({
    where: { AND: [liveCounterSalesWhere(tenantId, w), reg] },
    _count: { _all: true },
    _sum: { total: true },
  });
  // Cash that was taken stays in the drawer when the office later writes the rest off: only a VOID invoice drops its payments
  // (the rest of the where is Today's sales' own definition of money in).
  const inWindow = salePaymentsWhere(tenantId, w);
  const taken = {
    ...inWindow,
    invoice: { ...inWindow.invoice, status: { not: InvoiceStatus.VOID } },
  };
  const paymentSelect = {
    amount: true,
    method: true,
    status: true,
    paymentGroupId: true,
    checkStatus: true,
    invoice: { select: { orderId: true, order: { select: { counterSale: true } } } },
  } as const;
  const counterPayments = await db.invoicePayment.findMany({
    where: { AND: [taken, { invoice: { order: reg } }] },
    select: paymentSelect,
  });
  // SA-750r3 r-note (Train 4): a POS-mode pickup hand-over's tender is till cash of the register its order is stamped on. The
  // candidates are the Today's-sales hand-over query (PAID, dated in the window, non-counter PICKUP orders, group id set) with
  // the close's own rules on top (only a VOID invoice drops its payments; the register filter on the order); the v5 group id
  // cannot be computed in SQL, so the rows are matched here. Counter sales are not read twice: `counterSale: false` is disjoint.
  const handOverBase = handOverCandidatesWhere(tenantId, w);
  const handOverRows = await db.invoicePayment.findMany({
    where: {
      AND: [
        {
          ...handOverBase,
          invoice: { ...handOverBase.invoice, status: { not: InvoiceStatus.VOID } },
        },
        { invoice: { order: reg } },
      ],
    },
    select: paymentSelect,
  });
  const handOvers: WindowPayment[] = handOverRows.filter(
    (r) =>
      r.invoice?.orderId != null && r.paymentGroupId === pickupTenderGroupId(r.invoice.orderId),
  );
  const payments: WindowPayment[] = [...counterPayments, ...handOvers];
  const paidOnSales = await db.invoicePayment.aggregate({
    where: { AND: [paidOnDaysSalesWhere(tenantId, w), { invoice: { order: reg } }] },
    _sum: { amount: true },
  });
  const creditNotes = await db.creditNote.findMany({
    where: creditNotesInWindowWhere(tenantId, w),
    select: { id: true },
  });
  const returns = await db.return.findMany({
    where: {
      AND: [
        windowReturnsWhere(
          tenantId,
          w,
          creditNotes.map((c) => c.id),
        ),
        { order: reg },
      ],
    },
    select: {
      refundMethod: true,
      refundTender: true,
      refundAmount: true,
      creditSubtotal: true,
      creditTax: true,
      creditCategoryTax: true,
    },
  });
  return { sales, payments, paidOnSales, returns };
}

/** Counter sales rung at or after `from` on this register (the sheet's "N sales since"), live ones only. */
export async function countSalesSince(
  db: Db,
  tenantId: string,
  registerKey: string,
  from: Date,
  until: Date,
): Promise<number> {
  return db.order.count({
    where: {
      AND: [
        liveCounterSalesWhere(tenantId, { start: from, end: until }),
        registerOrderWhere(registerKey),
      ],
    },
  });
}
