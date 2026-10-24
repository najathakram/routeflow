import { handOverCandidatesWhere, handOverPayments, salePaymentsWhere } from "./counter-sale-today";
import { pickupTenderGroupId } from "./pickup-tender-group";

/**
 * SA-763r R7 review: every filter of the hand-over candidate query is load-bearing. This evaluates the REAL
 * `handOverCandidatesWhere` object against fixture rows with a small where-evaluator (equality, not / notIn / in,
 * gte / lt, nested relations), then applies the code half, so each case goes red if its filter is removed (the
 * mutation checks below do exactly that and expect the wrong row to appear). The real-Postgres twin is
 * counter-sale-today.hand-overs.db.spec.ts.
 */
const T = "test-tenant";
const W = { start: new Date("2026-10-07T04:00:00Z"), end: new Date("2026-10-08T04:00:00Z") };
type Row = Record<string, any>;

function matches(row: any, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const v = row?.[key];
    if (cond === null || typeof cond !== "object" || cond instanceof Date)
      return v === cond || +v === +cond;
    if ("not" in cond) return v !== cond.not;
    if ("notIn" in cond) return !cond.notIn.includes(v);
    if ("in" in cond) return cond.in.includes(v);
    if ("gte" in cond || "lt" in cond)
      return (cond.gte === undefined || v >= cond.gte) && (cond.lt === undefined || v < cond.lt);
    return v != null && matches(v, cond); // a relation
  });
}

const order = (id: string, over: Row = {}) => ({
  id,
  tenantId: T,
  fulfillPath: "PICKUP",
  counterSale: false,
  ...over,
});
const row = (orderId: string, over: Row = {}, orderOver: Row = {}, invoiceOver: Row = {}): Row => ({
  tenantId: T,
  status: "PAID",
  paidAt: new Date("2026-10-07T15:00:00Z"),
  method: "CASH",
  amount: "10.00",
  paymentGroupId: pickupTenderGroupId(orderId),
  invoice: {
    tenantId: T,
    status: "SENT",
    orderId,
    order: order(orderId, orderOver),
    ...invoiceOver,
  },
  ...over,
});
const counted = (rows: Row[], where = handOverCandidatesWhere(T, W) as Record<string, any>) =>
  handOverPayments(rows.filter((r) => matches(r, where)) as never).map((h) => h.orderId);

const FIXTURES = {
  good: row("o-good"),
  route: row("o-route", {}, { fulfillPath: "ROUTE" }),
  counter: row("o-counter", {}, { counterSale: true }),
  voidPayment: row("o-vp", { status: "VOID" }),
  voidInvoice: row("o-vi", {}, {}, { status: "VOID" }),
  // the day close's own rules (row 374 b): a written-off invoice KEEPS the cash that was taken; a cancelled order's money is not the day's
  writtenOff: row("o-wo", {}, {}, { status: "WRITTEN_OFF" }),
  cancelled: row("o-cx", {}, { status: "CANCELLED" }),
  otherDay: row("o-day", { paidAt: new Date("2026-10-09T15:00:00Z") }),
  otherTenant: row("o-t", { tenantId: "other" }),
  deposit: row("o-dep", { paymentGroupId: "11111111-2222-5333-8444-555555555555" }),
  noGroup: row("o-ng", { paymentGroupId: null }),
};
const ALL = Object.values(FIXTURES);

describe("hand-over candidates: each filter keeps its row out", () => {
  it("counts only the PAID, in-window, live-invoice, PICKUP non-counter payment with the order's v5 id", () => {
    // the written-off invoice's cash stays; the cancelled order's does not
    expect(counted(ALL)).toEqual(["o-good", "o-wo"]);
  });

  it.each([
    ["fulfillPath PICKUP", "route", (w: any) => delete w.invoice.order.fulfillPath],
    ["counterSale false", "counter", (w: any) => delete w.invoice.order.counterSale],
    ["invoice not VOID", "voidInvoice", (w: any) => delete w.invoice.status],
    ["order not CANCELLED", "cancelled", (w: any) => delete w.invoice.order.status],
    ["paidAt window", "otherDay", (w: any) => delete w.paidAt],
    ["tenant", "otherTenant", (w: any) => delete w.tenantId],
  ] as const)(
    "without the %s filter the %s row would count (mutation proof)",
    (_n, key, mutate) => {
      const where = JSON.parse(JSON.stringify(handOverCandidatesWhere(T, W)), (k, v) =>
        k === "gte" || k === "lt" ? new Date(v) : v,
      );
      mutate(where);
      expect(counted(ALL, where)).toContain(FIXTURES[key].invoice.orderId);
    },
  );

  it("a VOID payment stays out even without the SQL status filter: the shared tender predicate is the second wall", () => {
    const where = JSON.parse(JSON.stringify(handOverCandidatesWhere(T, W)), (k, v) =>
      k === "gte" || k === "lt" ? new Date(v) : v,
    );
    delete where.status;
    expect(counted(ALL, where)).not.toContain("o-vp");
  });

  it("the v5 match (code half) keeps a deposit and an id-less payment out", () => {
    expect(counted([FIXTURES.deposit, FIXTURES.noGroup])).toEqual([]);
  });
});

/** row 374: Today's counter payments and the Z read ONE where; a written-off invoice keeps its cash, a void one does not. */
describe("salePaymentsWhere: one rule for Today's money in and the Z", () => {
  const sale = (id: string, over: Row = {}, invoiceOver: Row = {}, orderOver: Row = {}) => ({
    tenantId: T,
    status: "PAID",
    paidAt: new Date("2026-10-07T15:00:00Z"),
    method: "CASH",
    amount: "10.00",
    id,
    invoice: {
      tenantId: T,
      status: "SENT",
      order: { tenantId: T, counterSale: true, status: "DELIVERED", ...orderOver },
      ...invoiceOver,
    },
    ...over,
  });
  const ids = (rows: Row[]) =>
    rows.filter((r) => matches(r, salePaymentsWhere(T, W) as Record<string, any>)).map((r) => r.id);

  it("keeps a WRITTEN_OFF invoice's cash, drops a VOID invoice's, a void payment and other days", () => {
    expect(
      ids([
        sale("kept"),
        sale("written-off", {}, { status: "WRITTEN_OFF" }),
        sale("void-invoice", {}, { status: "VOID" }),
        sale("void-payment", { status: "VOID" }),
        sale("other-day", { paidAt: new Date("2026-10-09T15:00:00Z") }),
        sale("pickup-order", {}, {}, { counterSale: false }),
      ]),
    ).toEqual(["kept", "written-off"]);
  });
});
