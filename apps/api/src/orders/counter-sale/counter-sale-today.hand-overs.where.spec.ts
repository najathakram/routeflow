import { handOverCandidatesWhere, handOverPayments } from "./counter-sale-today";
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
  writtenOff: row("o-wo", {}, {}, { status: "WRITTEN_OFF" }),
  otherDay: row("o-day", { paidAt: new Date("2026-10-09T15:00:00Z") }),
  otherTenant: row("o-t", { tenantId: "other" }),
  deposit: row("o-dep", { paymentGroupId: "11111111-2222-5333-8444-555555555555" }),
  noGroup: row("o-ng", { paymentGroupId: null }),
};
const ALL = Object.values(FIXTURES);

describe("hand-over candidates: each filter keeps its row out", () => {
  it("counts only the PAID, in-window, live-invoice, PICKUP non-counter payment with the order's v5 id", () => {
    expect(counted(ALL)).toEqual(["o-good"]);
  });

  it.each([
    ["fulfillPath PICKUP", "route", (w: any) => delete w.invoice.order.fulfillPath],
    ["counterSale false", "counter", (w: any) => delete w.invoice.order.counterSale],
    ["payment status PAID", "voidPayment", (w: any) => delete w.status],
    ["invoice not VOID / WRITTEN_OFF", "voidInvoice", (w: any) => delete w.invoice.status],
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

  it("the v5 match (code half) keeps a deposit and an id-less payment out", () => {
    expect(counted([FIXTURES.deposit, FIXTURES.noGroup])).toEqual([]);
  });
});
