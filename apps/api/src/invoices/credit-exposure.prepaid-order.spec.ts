import {
  computeCreditExposure,
  loadCreditExposure,
  OPEN_ORDER_STATUSES,
  SETTLED_COVERING_STATUSES,
  type ExposureInvoice,
} from "./credit-exposure";

/**
 * B577 — an OPEN order fully prepaid by a PAID invoice must not count again. The reader used to drop
 * every PAID invoice, so the order looked entirely "unbilled" and its whole total re-entered the hard
 * credit block. Rule: exposure per open order = max(0, order total − Σ that order's non-VOID
 * invoices, issued or paid); invoice BALANCES are still counted separately (a PAID invoice has none).
 */

const orderRef = (id: string, status: string, total: unknown) => ({ id, status, total });
const inv = (o: Partial<ExposureInvoice> & { total: unknown }): ExposureInvoice => ({
  status: "SENT",
  orderId: null,
  payments: [],
  order: null,
  ...o,
});
/** A PAID invoice for `orderId`, fully paid (balance 0) — what the reader now also returns. */
const paid = (orderId: string, total: number, status = "PAID") =>
  inv({
    total,
    status,
    orderId,
    order: orderRef(orderId, "CONFIRMED", 100),
    payments: [{ amount: total, status: "PAID" }],
  });
const open = (id: string, total: number) => ({ id, total });

describe("computeCreditExposure — settled invoices COVER their order (B577)", () => {
  it("a fully prepaid OPEN order counts 0 (was: its whole total again)", () => {
    const r = computeCreditExposure({
      invoices: [paid("o1", 100)],
      openOrders: [open("o1", 100)],
    });
    expect(r).toEqual({
      invoiceExposure: 0,
      uninvoicedOrderExposure: 0,
      counted: 0,
      pendingExposure: 0,
    });
  });

  it("a partially prepaid OPEN order counts only the uncovered remainder", () => {
    const r = computeCreditExposure({
      invoices: [paid("o1", 60)],
      openOrders: [open("o1", 100)],
    });
    expect(r.uninvoicedOrderExposure).toBe(40);
    expect(r.invoiceExposure).toBe(0);
    expect(r.counted).toBe(40);
  });

  it("control: an OPEN order with no invoice at all still counts its whole total", () => {
    const r = computeCreditExposure({ invoices: [], openOrders: [open("o1", 100)] });
    expect(r).toMatchObject({ uninvoicedOrderExposure: 100, invoiceExposure: 0, counted: 100 });
  });

  it("two PAID invoices cover cumulatively", () => {
    const r = computeCreditExposure({
      invoices: [paid("o1", 30), paid("o1", 45)],
      openOrders: [open("o1", 100)],
    });
    expect(r.counted).toBe(25);
  });

  it("PAID + a still-unpaid issued invoice on one order: the balance counts once, the remainder is 0", () => {
    const r = computeCreditExposure({
      invoices: [
        paid("o1", 60),
        inv({ total: 40, status: "SENT", orderId: "o1", order: orderRef("o1", "CONFIRMED", 100) }),
      ],
      openOrders: [open("o1", 100)],
    });
    // 40 open balance; 100 − 60 − 40 = 0 unbilled — never 100, never 140.
    expect(r).toMatchObject({ invoiceExposure: 40, uninvoicedOrderExposure: 0, counted: 40 });
  });

  it("a PAID invoice larger than the order floors the remainder at 0 (never negative)", () => {
    const r = computeCreditExposure({
      invoices: [paid("o1", 130)],
      openOrders: [open("o1", 100)],
    });
    expect(r.counted).toBe(0);
  });

  it("a WRITTEN_OFF invoice covers NOTHING (conservative: only PAID is ruled; write-off cover is an open owner question)", () => {
    const r = computeCreditExposure({
      invoices: [paid("o1", 100, "WRITTEN_OFF")],
      openOrders: [open("o1", 100)],
    });
    expect(r.counted).toBe(100);
  });

  it("a VOID invoice covers NOTHING — its order's value is exposure again", () => {
    const r = computeCreditExposure({
      invoices: [paid("o1", 100, "VOID")],
      openOrders: [open("o1", 100)],
    });
    expect(r.counted).toBe(100);
  });

  it("cover is per order: another order's PAID invoice does not reduce this one", () => {
    const r = computeCreditExposure({
      invoices: [paid("o2", 100)],
      openOrders: [open("o1", 100), open("o2", 100)],
    });
    expect(r).toMatchObject({ uninvoicedOrderExposure: 100, counted: 100 }); // o1 in full, o2 covered
  });

  it("a standalone PAID invoice (no order) covers nothing and is never counted", () => {
    const r = computeCreditExposure({
      invoices: [inv({ total: 100, status: "PAID", orderId: null })],
      openOrders: [open("o1", 100)],
    });
    expect(r.counted).toBe(100);
  });

  it("a PAID invoice on a DELIVERED order with no draft is ignored (no remainder is ever added there)", () => {
    const r = computeCreditExposure({
      invoices: [
        inv({
          total: 100,
          status: "PAID",
          orderId: "d1",
          order: orderRef("d1", "DELIVERED", 100),
          payments: [{ amount: 100, status: "PAID" }],
        }),
      ],
      openOrders: [],
    });
    expect(r.counted).toBe(0);
  });

  it("core only: a PAID invoice covers its share of a DELIVERED order that carries a backed DRAFT (same max rule; the reader supplies OPEN orders' covers only)", () => {
    const delivered = orderRef("d1", "DELIVERED", 100);
    const r = computeCreditExposure({
      invoices: [
        inv({ total: 60, status: "PAID", orderId: "d1", order: delivered }),
        inv({ total: 40, status: "DRAFT", orderId: "d1", order: delivered }),
      ],
      openOrders: [],
    });
    // 40 draft balance; 100 − 60 − 40 = 0 remainder. Without the cover it would count 100.
    expect(r).toMatchObject({ invoiceExposure: 40, uninvoicedOrderExposure: 0, counted: 40 });
  });

  it("excludeOrderId: the edited order contributes nothing (the caller supplies its projected total); another order's cover still applies", () => {
    const r = computeCreditExposure({
      invoices: [paid("edit", 100), paid("o2", 50)],
      openOrders: [open("edit", 100), open("o2", 80)],
      excludeOrderId: "edit",
    });
    expect(r.counted).toBe(30); // only o2's uncovered 30 — not 0 and not 110
  });
});

describe("SETTLED_COVERING_STATUSES and the reader (B577)", () => {
  it("covers PAID only — never VOID or WRITTEN_OFF, never a live or draft status", () => {
    expect([...SETTLED_COVERING_STATUSES]).toEqual(["PAID"]);
  });

  it("the reader also selects the PAID invoices of OPEN orders only (bounded, never lifetime history), scoped by customer", async () => {
    const db = {
      invoice: { findMany: jest.fn().mockResolvedValue([]) },
      order: { findMany: jest.fn().mockResolvedValue([]) },
    };
    await loadCreditExposure(db, "cust-1");

    const args = db.invoice.findMany.mock.calls[0][0];
    expect(args.where.customerId).toBe("cust-1");
    expect(args.where.OR).toHaveLength(2);
    const cover = args.where.OR[1];
    expect(new Set(cover.status.in)).toEqual(new Set(SETTLED_COVERING_STATUSES));
    expect(new Set(cover.order.status.in)).toEqual(new Set(OPEN_ORDER_STATUSES));
    // delivered/terminal orders must NOT be read: their paid history would grow with every credit check
    expect(cover.order.status.in).not.toContain("DELIVERED");
    expect(cover.order.status.in).not.toContain("PARTIALLY_DELIVERED");
  });

  it("end to end through the reader: the open order's PAID invoice comes back and the order counts 0", async () => {
    const db = {
      invoice: { findMany: jest.fn().mockResolvedValue([paid("o1", 100)]) },
      order: { findMany: jest.fn().mockResolvedValue([open("o1", 100)]) },
    };
    await expect(loadCreditExposure(db, "cust-1")).resolves.toMatchObject({ counted: 0 });
  });
});
