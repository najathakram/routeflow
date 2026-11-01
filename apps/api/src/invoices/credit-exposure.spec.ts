import { OrderStatus, Prisma } from "@prisma/client";
import {
  BACKING_ORDER_STATUSES,
  computeCreditExposure,
  DELIVERED_ORDER_STATUSES,
  isUnbackedDraft,
  loadCreditExposure,
  NON_BACKING_ORDER_STATUSES,
  OPEN_ORDER_STATUSES,
  type ExposureInvoice,
  type ExposureOrder,
} from "./credit-exposure";
import {
  CREDIT_EXPOSURE_EXCLUDED,
  CREDIT_NOT_APPLICABLE,
  KPI_SUMMARY_EXCLUDED,
} from "./invoice-status-sets";

/**
 * D6 / B462 — the ONE credit-exposure derivation, owner ruling "option B". Pure core first
 * (no I/O), then the single DB reader.
 *
 * Intent: a standalone unissued draft is not a receivable; DELIVERED goods must never become
 * unguarded. A DRAFT whose order is OPEN or DELIVERED counts in the hard block (`counted`);
 * a partially invoiced order counts max(order total, issued + draft) ONCE; ONLY drafts with no
 * open/delivered order behind them (`isUnbackedDraft`) are excluded and shown as
 * `pendingExposure`. The payment basis (every non-VOID payment reduces a balance) is
 * deliberately unchanged.
 */

const invoice = (o: Partial<ExposureInvoice> & { total: unknown }): ExposureInvoice => ({
  status: "SENT",
  orderId: null,
  payments: [],
  order: null, // required on ExposureInvoice (B584) — overridden per test where an order backs it
  ...o,
});
const order = (id: string, total: unknown): ExposureOrder => ({ id, total });
/** An invoice's `order` relation, exactly as loadCreditExposure selects it. */
const orderRef = (id: string, status: string, total: unknown) => ({ id, status, total });

describe("isUnbackedDraft (the single draft-exclusion predicate)", () => {
  it.each(["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", "DELIVERED"])(
    "a DRAFT whose order is %s is BACKED (not unbacked)",
    (status) => {
      expect(isUnbackedDraft({ status: "DRAFT", order: { status } })).toBe(false);
    },
  );

  it.each(["DRAFT", "CANCELLED"])("a DRAFT whose order is %s is UNBACKED", (status) => {
    expect(isUnbackedDraft({ status: "DRAFT", order: { status } })).toBe(true);
  });

  it("a standalone DRAFT (order null) is UNBACKED", () => {
    expect(isUnbackedDraft({ status: "DRAFT", order: null })).toBe(true);
  });

  it("B584: a DRAFT whose `order` is missing at RUNTIME is still UNBACKED (the loader's `as` cast can deliver undefined; the type guards the typed call sites, this pins the fallback)", () => {
    expect(isUnbackedDraft({ status: "DRAFT" } as any)).toBe(true);
  });

  it.each(["SENT", "VIEWED", "PARTIAL", "OVERDUE", "PAID", "VOID", "WRITTEN_OFF"])(
    "a non-DRAFT %s invoice is never an unbacked draft, whatever its order",
    (status) => {
      expect(isUnbackedDraft({ status, order: null })).toBe(false);
      expect(isUnbackedDraft({ status, order: { status: "CANCELLED" } })).toBe(false);
    },
  );
});

describe("computeCreditExposure (pure)", () => {
  it("no data → all zeros", () => {
    expect(computeCreditExposure({ invoices: [], openOrders: [] })).toEqual({
      invoiceExposure: 0,
      uninvoicedOrderExposure: 0,
      counted: 0,
      pendingExposure: 0,
    });
  });

  describe("issued invoices (payment basis unchanged)", () => {
    it("an issued invoice counts its full total when unpaid", () => {
      const r = computeCreditExposure({
        invoices: [invoice({ total: 100 })],
        openOrders: [],
      });
      expect(r).toMatchObject({ invoiceExposure: 100, counted: 100, pendingExposure: 0 });
    });

    it("counts total minus every non-VOID payment (partial payments net off)", () => {
      const r = computeCreditExposure({
        invoices: [
          invoice({
            total: 90,
            status: "PARTIAL",
            payments: [
              { amount: 60, status: "PAID" },
              { amount: 10, status: "PAID" },
            ],
          }),
        ],
        openOrders: [],
      });
      expect(r.invoiceExposure).toBe(20);
      expect(r.counted).toBe(20);
    });

    it("a VOID (bounced) payment does NOT reduce the balance", () => {
      const r = computeCreditExposure({
        invoices: [
          invoice({
            total: 120,
            status: "OVERDUE",
            payments: [
              { amount: 120, status: "VOID" }, // bounced — must not count as paid
              { amount: 20, status: "PAID" },
            ],
          }),
        ],
        openOrders: [],
      });
      expect(r.counted).toBe(100);
    });

    it("payment basis is UNCHANGED by D6: a DRAFT payment still reduces the balance (tracked follow-up)", () => {
      // The DRAFT-PAYMENT basis is a separate, still-open owner decision. Pinned so a
      // well-meaning sumConfirmed conversion cannot slip in through this module.
      const r = computeCreditExposure({
        invoices: [invoice({ total: 100, payments: [{ amount: 40, status: "DRAFT" }] })],
        openOrders: [],
      });
      expect(r.counted).toBe(60);
    });

    // E9
    it.each(["PAID", "VOID", "WRITTEN_OFF"])(
      "E9: a settled %s invoice is never counted and never pending, even if over-fetched",
      (status) => {
        const r = computeCreditExposure({
          invoices: [invoice({ total: 500, status })],
          openOrders: [],
        });
        expect(r).toEqual({
          invoiceExposure: 0,
          uninvoicedOrderExposure: 0,
          counted: 0,
          pendingExposure: 0,
        });
      },
    );

    it.each(["SENT", "VIEWED", "PARTIAL", "OVERDUE"])("an issued %s invoice counts", (status) => {
      const r = computeCreditExposure({
        invoices: [invoice({ total: 50, status })],
        openOrders: [],
      });
      expect(r.counted).toBe(50);
    });

    it("an invoice fixture with no status still counts (exclude-list, never allow-list)", () => {
      const r = computeCreditExposure({
        invoices: [{ total: 30, orderId: null, payments: [] } as unknown as ExposureInvoice],
        openOrders: [],
      });
      expect(r.counted).toBe(30);
    });
  });

  describe("option B worked examples (owner ruling)", () => {
    it("E1: a DELIVERED order (90) with a DRAFT invoice (90), no payments → counted 90, pending 0", () => {
      const r = computeCreditExposure({
        invoices: [
          invoice({
            total: 90,
            status: "DRAFT",
            orderId: "o1",
            order: orderRef("o1", "DELIVERED", 90),
          }),
        ],
        openOrders: [], // a delivered order is not an OPEN order
      });
      expect(r).toEqual({
        invoiceExposure: 90,
        uninvoicedOrderExposure: 0,
        counted: 90,
        pendingExposure: 0,
      });
    });

    it("E1 (block arithmetic): with limit 100 and a projected 15, counted 90 + 15 = 105 exceeds the limit", () => {
      const { counted } = computeCreditExposure({
        invoices: [
          invoice({
            total: 90,
            status: "DRAFT",
            orderId: "o1",
            order: orderRef("o1", "DELIVERED", 90),
          }),
        ],
        openOrders: [],
      });
      expect(counted + 15).toBe(105);
      expect(counted + 15 > 100).toBe(true);
    });

    it.each(["PARTIALLY_DELIVERED", "DELIVERED", "PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"])(
      "E1: a DRAFT on a %s order is counted (backed), never pending",
      (status) => {
        const isOpen = OPEN_ORDER_STATUSES.includes(status as never);
        const r = computeCreditExposure({
          invoices: [
            invoice({
              total: 90,
              status: "DRAFT",
              orderId: "o1",
              order: orderRef("o1", status, 90),
            }),
          ],
          openOrders: isOpen ? [order("o1", 90)] : [],
        });
        expect(r).toMatchObject({ counted: 90, pendingExposure: 0 });
      },
    );

    it("E2: OPEN order 100 with ISSUED 60 + DRAFT 40 → counted 100 exactly ONCE (not 200, not 60)", () => {
      const o = orderRef("o1", "CONFIRMED", 100);
      const r = computeCreditExposure({
        invoices: [
          invoice({ total: 60, orderId: "o1", order: o }),
          invoice({ total: 40, status: "DRAFT", orderId: "o1", order: o }),
        ],
        openOrders: [order("o1", 100)],
      });
      expect(r).toEqual({
        invoiceExposure: 100,
        uninvoicedOrderExposure: 0,
        counted: 100,
        pendingExposure: 0,
      });
    });

    it("E2: the same order with a 30 payment on the issued invoice → 70 (payments keep netting)", () => {
      const o = orderRef("o1", "CONFIRMED", 100);
      const r = computeCreditExposure({
        invoices: [
          invoice({
            total: 60,
            orderId: "o1",
            order: o,
            payments: [{ amount: 30, status: "PAID" }],
          }),
          invoice({ total: 40, status: "DRAFT", orderId: "o1", order: o }),
        ],
        openOrders: [order("o1", 100)],
      });
      expect(r.counted).toBe(70);
      expect(r.pendingExposure).toBe(0);
    });

    it("E2: a DELIVERED order (100) with ISSUED 60 + DRAFT 40 also counts 100 once", () => {
      const o = orderRef("o1", "DELIVERED", 100);
      const r = computeCreditExposure({
        invoices: [
          invoice({ total: 60, orderId: "o1", order: o }),
          invoice({ total: 40, status: "DRAFT", orderId: "o1", order: o }),
        ],
        openOrders: [],
      });
      expect(r).toMatchObject({ counted: 100, pendingExposure: 0 });
    });

    it.each([
      ["no order at all (orderId null)", null, null],
      ["a CANCELLED order", "CANCELLED", "o1"],
      ["a DRAFT-status order", "DRAFT", "o1"],
    ] as const)(
      "E3: a DRAFT invoice (200) with %s is pending 200, counted 0",
      (_label, orderStatus, orderId) => {
        const r = computeCreditExposure({
          invoices: [
            invoice({
              total: 200,
              status: "DRAFT",
              orderId,
              order: orderStatus && orderId ? orderRef(orderId, orderStatus, 200) : null,
            }),
          ],
          openOrders: [],
        });
        expect(r).toEqual({
          invoiceExposure: 0,
          uninvoicedOrderExposure: 0,
          counted: 0,
          pendingExposure: 200,
        });
      },
    );

    it("E4: OPEN order 90 with a sole DRAFT mirror of 110 (shipping fee) → counted 110, pending 0 — no dollars in neither figure", () => {
      const r = computeCreditExposure({
        invoices: [
          invoice({
            total: 110,
            status: "DRAFT",
            orderId: "o1",
            order: orderRef("o1", "CONFIRMED", 90),
          }),
        ],
        openOrders: [order("o1", 90)],
      });
      expect(r).toEqual({
        invoiceExposure: 110,
        uninvoicedOrderExposure: 0,
        counted: 110,
        pendingExposure: 0,
      });
    });

    it("E4: a mirror draft of 90 on an order of 90 → counted 90 (== pre-D6)", () => {
      const r = computeCreditExposure({
        invoices: [
          invoice({
            total: 90,
            status: "DRAFT",
            orderId: "o1",
            order: orderRef("o1", "CONFIRMED", 90),
          }),
        ],
        openOrders: [order("o1", 90)],
      });
      expect(r).toMatchObject({ counted: 90, pendingExposure: 0 });
    });

    it("E4: several DRAFTs on one open order whose sum exceeds the order total → counted at their sum, once", () => {
      const o = orderRef("o1", "CONFIRMED", 100);
      const r = computeCreditExposure({
        invoices: [
          invoice({ total: 60, status: "DRAFT", orderId: "o1", order: o }),
          invoice({ total: 60, status: "DRAFT", orderId: "o1", order: o }),
        ],
        openOrders: [order("o1", 100)],
      });
      expect(r).toMatchObject({ counted: 120, pendingExposure: 0 });
    });

    it("E5: DELIVERED order T=90 with a DRAFT of 80 → counted 80 + max(0, 90−80) = 90", () => {
      const r = computeCreditExposure({
        invoices: [
          invoice({
            total: 80,
            status: "DRAFT",
            orderId: "o1",
            order: orderRef("o1", "DELIVERED", 90),
          }),
        ],
        openOrders: [],
      });
      expect(r).toEqual({
        invoiceExposure: 80,
        uninvoicedOrderExposure: 10,
        counted: 90,
        pendingExposure: 0,
      });
    });

    it("E6: OPEN order T=100 with ISSUED 90 only → counted 90 + 10 = 100 (the partially-invoiced remainder)", () => {
      const r = computeCreditExposure({
        invoices: [invoice({ total: 90, orderId: "o1", order: orderRef("o1", "CONFIRMED", 100) })],
        openOrders: [order("o1", 100)],
      });
      expect(r).toEqual({
        invoiceExposure: 90,
        uninvoicedOrderExposure: 10,
        counted: 100,
        pendingExposure: 0,
      });
    });

    it("E6: a payment on the partially invoiced order nets off the invoice balance, the remainder is unchanged", () => {
      const r = computeCreditExposure({
        invoices: [
          invoice({
            total: 90,
            orderId: "o1",
            order: orderRef("o1", "CONFIRMED", 100),
            payments: [{ amount: 50, status: "PAID" }],
          }),
        ],
        openOrders: [order("o1", 100)],
      });
      expect(r).toMatchObject({ invoiceExposure: 40, uninvoicedOrderExposure: 10, counted: 50 });
    });

    it("E7: an OPEN order with NO invoice counts its total", () => {
      const r = computeCreditExposure({ invoices: [], openOrders: [order("o1", 75)] });
      expect(r).toEqual({
        invoiceExposure: 0,
        uninvoicedOrderExposure: 75,
        counted: 75,
        pendingExposure: 0,
      });
    });

    it("E7: an OPEN order whose issued invoice covers it exactly counts ONCE (via the invoice)", () => {
      const r = computeCreditExposure({
        invoices: [invoice({ total: 40, orderId: "o1", order: orderRef("o1", "CONFIRMED", 40) })],
        openOrders: [order("o1", 40)],
      });
      expect(r).toEqual({
        invoiceExposure: 40,
        uninvoicedOrderExposure: 0,
        counted: 40,
        pendingExposure: 0,
      });
    });

    it("E8: a DELIVERED order with only an ISSUED invoice → plain balance, NO remainder added", () => {
      const r = computeCreditExposure({
        invoices: [
          invoice({
            total: 70,
            orderId: "o1",
            order: orderRef("o1", "DELIVERED", 90), // order worth more than the invoice
          }),
        ],
        openOrders: [],
      });
      expect(r).toEqual({
        invoiceExposure: 70,
        uninvoicedOrderExposure: 0,
        counted: 70,
        pendingExposure: 0,
      });
    });

    it("E8: an issued invoice on a CANCELLED order also counts by plain balance (no remainder)", () => {
      const r = computeCreditExposure({
        invoices: [invoice({ total: 30, orderId: "o1", order: orderRef("o1", "CANCELLED", 90) })],
        openOrders: [],
      });
      expect(r).toMatchObject({ counted: 30, uninvoicedOrderExposure: 0 });
    });

    it("the openOrders row is the authority for an open order's total (the invoice's order.total may lag)", () => {
      const r = computeCreditExposure({
        invoices: [invoice({ total: 60, orderId: "o1", order: orderRef("o1", "CONFIRMED", 999) })],
        openOrders: [order("o1", 100)],
      });
      expect(r.counted).toBe(100); // 60 + (100 − 60), not 60 + (999 − 60)
    });
  });

  describe("pending (unbacked DRAFT) exposure", () => {
    it("pending uses the same payment basis (non-VOID payments net off a draft)", () => {
      const r = computeCreditExposure({
        invoices: [
          invoice({
            total: 100,
            status: "DRAFT",
            payments: [
              { amount: 100, status: "VOID" },
              { amount: 30, status: "PAID" },
            ],
          }),
        ],
        openOrders: [],
      });
      expect(r.pendingExposure).toBe(70);
      expect(r.counted).toBe(0);
    });

    it("a backed draft with payments is measured on its BALANCE (total minus non-VOID payments)", () => {
      const r = computeCreditExposure({
        invoices: [
          invoice({
            total: 110,
            status: "DRAFT",
            orderId: "o1",
            order: orderRef("o1", "DELIVERED", 90),
            payments: [{ amount: 15, status: "CONFIRMED" }],
          }),
        ],
        openOrders: [],
      });
      // balance 95; order total 90 < draft total 110 so no remainder.
      expect(r).toMatchObject({ counted: 95, pendingExposure: 0 });
    });

    it("only the order's backing status separates counted from pending (same draft, different order)", () => {
      const draftOn = (status: string | null) =>
        computeCreditExposure({
          invoices: [
            invoice({
              total: 60,
              status: "DRAFT",
              orderId: status ? "o1" : null,
              order: status ? orderRef("o1", status, 60) : null,
            }),
          ],
          openOrders: [],
        });
      expect(draftOn("DELIVERED")).toMatchObject({ counted: 60, pendingExposure: 0 });
      expect(draftOn("CANCELLED")).toMatchObject({ counted: 0, pendingExposure: 60 });
      expect(draftOn("DRAFT")).toMatchObject({ counted: 0, pendingExposure: 60 });
      expect(draftOn(null)).toMatchObject({ counted: 0, pendingExposure: 60 });
    });

    it("the same fixture as a SENT invoice counts (only the DRAFT status + missing backing separates it)", () => {
      const asDraft = computeCreditExposure({
        invoices: [invoice({ total: 60, status: "DRAFT" })],
        openOrders: [],
      });
      const asSent = computeCreditExposure({
        invoices: [invoice({ total: 60, status: "SENT" })],
        openOrders: [],
      });
      expect(asDraft).toMatchObject({ counted: 0, pendingExposure: 60 });
      expect(asSent).toMatchObject({ counted: 60, pendingExposure: 0 });
    });
  });

  describe("E10: excludeOrderId (the edited order)", () => {
    const fixture = () => ({
      invoices: [
        invoice({ total: 500, orderId: "edit", order: orderRef("edit", "CONFIRMED", 700) }), // issued
        invoice({
          total: 300,
          status: "DRAFT",
          orderId: "edit",
          order: orderRef("edit", "CONFIRMED", 700),
        }), // its (backed) draft
        invoice({ total: 20, orderId: "other", order: orderRef("other", "CONFIRMED", 20) }),
        invoice({ total: 7, status: "DRAFT", orderId: null }), // standalone (unbacked) draft
        invoice({
          total: 60,
          status: "DRAFT",
          orderId: "del",
          order: orderRef("del", "DELIVERED", 60),
        }), // delivered-order draft
        invoice({
          total: 11,
          status: "DRAFT",
          orderId: "gone",
          order: orderRef("gone", "CANCELLED", 11),
        }), // cancelled-order draft (unbacked)
      ],
      openOrders: [order("edit", 700), order("other", 20), order("third", 5)],
    });

    it("drops the excluded order AND its invoices from counted AND pending", () => {
      const r = computeCreditExposure({ ...fixture(), excludeOrderId: "edit" });
      expect(r).toEqual({
        invoiceExposure: 80, // other's issued (20) + the delivered-order draft (60)
        uninvoicedOrderExposure: 5, // "third" only
        counted: 85,
        pendingExposure: 18, // standalone 7 + cancelled-order draft 11 — "edit"'s draft is gone
      });
    });

    it("without excludeOrderId nothing is dropped (the edit order counts issued 500 + draft 300 once)", () => {
      const r = computeCreditExposure(fixture());
      // edit: 800 (invoices already exceed the order's 700); other 20; del 60; third 5.
      expect(r).toEqual({
        invoiceExposure: 880,
        uninvoicedOrderExposure: 5,
        counted: 885,
        pendingExposure: 18,
      });
    });

    it("excluding a DELIVERED order drops its backed draft from counted (and it is not pending either)", () => {
      const r = computeCreditExposure({
        invoices: [
          invoice({
            total: 90,
            status: "DRAFT",
            orderId: "del",
            order: orderRef("del", "DELIVERED", 90),
          }),
        ],
        openOrders: [],
        excludeOrderId: "del",
      });
      expect(r).toEqual({
        invoiceExposure: 0,
        uninvoicedOrderExposure: 0,
        counted: 0,
        pendingExposure: 0,
      });
    });

    it("excludeOrderId null / undefined never drops an invoice whose orderId is null", () => {
      const base = {
        invoices: [
          invoice({ total: 10, orderId: null }),
          invoice({ total: 4, status: "DRAFT", orderId: null }),
        ],
        openOrders: [],
      };
      expect(computeCreditExposure({ ...base, excludeOrderId: null })).toMatchObject({
        counted: 10,
        pendingExposure: 4,
      });
      expect(computeCreditExposure({ ...base, excludeOrderId: undefined })).toMatchObject({
        counted: 10,
        pendingExposure: 4,
      });
    });
  });

  describe("rounding and coercion", () => {
    it("0.1 + 0.2 → 0.3 (no binary-float dust in any figure)", () => {
      const r = computeCreditExposure({
        invoices: [invoice({ total: 0.1 }), invoice({ total: 0.2 })],
        openOrders: [order("o1", 0.1), order("o2", 0.2)],
      });
      expect(r.invoiceExposure).toBe(0.3);
      expect(r.uninvoicedOrderExposure).toBe(0.3);
      expect(r.counted).toBe(0.6);

      const pending = computeCreditExposure({
        invoices: [
          invoice({ total: 0.1, status: "DRAFT" }),
          invoice({ total: 0.2, status: "DRAFT" }),
        ],
        openOrders: [],
      });
      expect(pending.pendingExposure).toBe(0.3);
    });

    it("the max rule is cent-exact: an order of 0.3 covered by drafts of 0.1 + 0.2 counts 0.3, and 0.1 + 0.1 of 0.3 leaves a 0.1 remainder", () => {
      const o = orderRef("o1", "DELIVERED", 0.3);
      const covered = computeCreditExposure({
        invoices: [
          invoice({ total: 0.1, status: "DRAFT", orderId: "o1", order: o }),
          invoice({ total: 0.2, status: "DRAFT", orderId: "o1", order: o }),
        ],
        openOrders: [],
      });
      expect(covered).toMatchObject({ counted: 0.3, uninvoicedOrderExposure: 0 });

      const short = computeCreditExposure({
        invoices: [
          invoice({ total: 0.1, status: "DRAFT", orderId: "o1", order: o }),
          invoice({ total: 0.1, status: "DRAFT", orderId: "o1", order: o }),
        ],
        openOrders: [],
      });
      expect(short).toMatchObject({
        invoiceExposure: 0.2,
        uninvoicedOrderExposure: 0.1,
        counted: 0.3,
      });
    });

    it("accepts numeric-string and Prisma.Decimal totals/amounts", () => {
      const r = computeCreditExposure({
        invoices: [
          invoice({
            total: "10.10",
            payments: [{ amount: new Prisma.Decimal("0.05"), status: "PAID" }],
          }),
          invoice({ total: new Prisma.Decimal("20.20") }),
          invoice({ total: { toString: () => "3.30" }, status: "DRAFT" }),
        ],
        openOrders: [order("o1", "4.40"), order("o2", new Prisma.Decimal("5.55"))],
      });
      expect(r.invoiceExposure).toBe(30.25); // 10.05 + 20.20
      expect(r.uninvoicedOrderExposure).toBe(9.95);
      expect(r.counted).toBe(40.2);
      expect(r.pendingExposure).toBe(3.3);
    });

    it("a backed draft on a Decimal-priced delivered order counts through Decimal totals", () => {
      const r = computeCreditExposure({
        invoices: [
          invoice({
            total: new Prisma.Decimal("40.05"),
            status: "DRAFT",
            orderId: "o1",
            order: orderRef("o1", "DELIVERED", new Prisma.Decimal("100.10")),
          }),
        ],
        openOrders: [],
      });
      expect(r).toMatchObject({
        invoiceExposure: 40.05,
        uninvoicedOrderExposure: 60.05,
        counted: 100.1,
      });
    });

    it("null / undefined / garbage totals contribute 0 and never NaN", () => {
      const r = computeCreditExposure({
        invoices: [
          invoice({ total: null, payments: [{ amount: undefined, status: "PAID" }] }),
          invoice({ total: "not-a-number", status: "DRAFT" }),
          invoice({
            total: undefined,
            status: "DRAFT",
            orderId: "o9",
            order: orderRef("o9", "DELIVERED", "garbage"),
          }),
        ],
        openOrders: [order("o1", null), order("o2", undefined)],
      });
      expect(r).toEqual({
        invoiceExposure: 0,
        uninvoicedOrderExposure: 0,
        counted: 0,
        pendingExposure: 0,
      });
      for (const v of Object.values(r)) expect(Number.isNaN(v)).toBe(false);
    });
  });

  describe("E11: no unissued item is counted twice, none is dropped", () => {
    // Each slice is one independent order (or one standalone draft) with its hand-computed
    // outcome — counted + pending covers the slice's dollars exactly once.
    interface Slice {
      name: string;
      invoices: ExposureInvoice[];
      openOrders: ExposureOrder[];
      counted: number;
      pending: number;
    }
    const slices: Slice[] = [
      {
        name: "OPEN order + DRAFT mirror",
        invoices: [
          invoice({
            total: 100,
            status: "DRAFT",
            orderId: "A",
            order: orderRef("A", "CONFIRMED", 100),
          }),
        ],
        openOrders: [order("A", 100)],
        counted: 100,
        pending: 0,
      },
      {
        name: "standalone DRAFT",
        invoices: [invoice({ total: 40, status: "DRAFT", orderId: null })],
        openOrders: [],
        counted: 0,
        pending: 40,
      },
      {
        name: "DRAFT on a DELIVERED order",
        invoices: [
          invoice({
            total: 25,
            status: "DRAFT",
            orderId: "C",
            order: orderRef("C", "DELIVERED", 25),
          }),
        ],
        openOrders: [],
        counted: 25,
        pending: 0,
      },
      {
        name: "ISSUED invoice on an OPEN order",
        invoices: [invoice({ total: 200, orderId: "F", order: orderRef("F", "PENDING", 200) })],
        openOrders: [order("F", 200)],
        counted: 200,
        pending: 0,
      },
      {
        name: "OPEN order with no invoice",
        invoices: [],
        openOrders: [order("D", 60)],
        counted: 60,
        pending: 0,
      },
      {
        name: "DRAFT on a CANCELLED order",
        invoices: [
          invoice({
            total: 15,
            status: "DRAFT",
            orderId: "X",
            order: orderRef("X", "CANCELLED", 15),
          }),
        ],
        openOrders: [],
        counted: 0,
        pending: 15,
      },
      {
        name: "DRAFT on a DRAFT-status order",
        invoices: [
          invoice({ total: 8, status: "DRAFT", orderId: "Y", order: orderRef("Y", "DRAFT", 8) }),
        ],
        openOrders: [],
        counted: 0,
        pending: 8,
      },
      {
        name: "partially invoiced OPEN order: ISSUED 60 + DRAFT 30 of 100",
        invoices: [
          invoice({ total: 60, orderId: "P", order: orderRef("P", "CONFIRMED", 100) }),
          invoice({
            total: 30,
            status: "DRAFT",
            orderId: "P",
            order: orderRef("P", "CONFIRMED", 100),
          }),
        ],
        openOrders: [order("P", 100)],
        counted: 100, // 60 + 30 + the 10 still unbilled
        pending: 0,
      },
      {
        name: "shipping-inflated mirror: DRAFT 110 on OPEN order 90",
        invoices: [
          invoice({
            total: 110,
            status: "DRAFT",
            orderId: "S",
            order: orderRef("S", "OUT_FOR_DELIVERY", 90),
          }),
        ],
        openOrders: [order("S", 90)],
        counted: 110,
        pending: 0,
      },
    ];

    const merged = () => ({
      invoices: slices.flatMap((s) => s.invoices),
      openOrders: slices.flatMap((s) => s.openOrders),
    });
    const expectedCounted = slices.reduce((s, x) => s + x.counted, 0);
    const expectedPending = slices.reduce((s, x) => s + x.pending, 0);

    it.each(slices.map((s) => [s.name, s] as const))("slice: %s", (_name, s) => {
      const r = computeCreditExposure({ invoices: s.invoices, openOrders: s.openOrders });
      expect({ counted: r.counted, pending: r.pendingExposure }).toEqual({
        counted: s.counted,
        pending: s.pending,
      });
    });

    it("the merged customer equals the sum of its independent slices (no cross-slice double count or drop)", () => {
      const r = computeCreditExposure(merged());
      expect(r.counted).toBe(expectedCounted);
      expect(r.pendingExposure).toBe(expectedPending);
      const perSlice = slices.map((s) =>
        computeCreditExposure({ invoices: s.invoices, openOrders: s.openOrders }),
      );
      expect(r.counted).toBe(perSlice.reduce((sum, x) => sum + x.counted, 0));
      expect(r.pendingExposure).toBe(perSlice.reduce((sum, x) => sum + x.pendingExposure, 0));
    });

    it("the result is independent of row order (reversed and rotated inputs give the identical figures)", () => {
      const base = merged();
      const expected = computeCreditExposure(base);
      const rotate = <T>(xs: T[], n: number) => [...xs.slice(n), ...xs.slice(0, n)];
      for (const variant of [
        { invoices: [...base.invoices].reverse(), openOrders: [...base.openOrders].reverse() },
        { invoices: rotate(base.invoices, 3), openOrders: rotate(base.openOrders, 2) },
        { invoices: rotate(base.invoices, 7), openOrders: base.openOrders },
      ]) {
        expect(computeCreditExposure(variant)).toEqual(expected);
      }
    });

    it("an unissued draft of value v sits in EXACTLY one figure: flipping only its order's status moves v between counted and pending", () => {
      const draftOn = (status: string) =>
        computeCreditExposure({
          invoices: [
            invoice({
              total: 73,
              status: "DRAFT",
              orderId: "o1",
              order: orderRef("o1", status, 73),
            }),
          ],
          openOrders: OPEN_ORDER_STATUSES.includes(status as never) ? [order("o1", 73)] : [],
        });
      for (const status of BACKING_ORDER_STATUSES) {
        const r = draftOn(status);
        expect({ status, counted: r.counted, pending: r.pendingExposure }).toEqual({
          status,
          counted: 73,
          pending: 0,
        });
      }
      for (const status of ["CANCELLED", "DRAFT"]) {
        const r = draftOn(status);
        expect({ status, counted: r.counted, pending: r.pendingExposure }).toEqual({
          status,
          counted: 0,
          pending: 73,
        });
      }
    });
  });
});

describe("credit-exposure status sets and constants", () => {
  it("CREDIT_EXPOSURE_EXCLUDED = the settled set + DRAFT (i.e. 'not an ISSUED invoice'), same members as KPI_SUMMARY_EXCLUDED", () => {
    expect(new Set(CREDIT_EXPOSURE_EXCLUDED)).toEqual(new Set([...CREDIT_NOT_APPLICABLE, "DRAFT"]));
    expect(new Set(CREDIT_EXPOSURE_EXCLUDED)).toEqual(new Set(KPI_SUMMARY_EXCLUDED));
  });

  it("OPEN_ORDER_STATUSES is exactly PENDING / CONFIRMED / OUT_FOR_DELIVERY", () => {
    expect(new Set(OPEN_ORDER_STATUSES)).toEqual(
      new Set(["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"]),
    );
  });

  it("DELIVERED_ORDER_STATUSES is exactly PARTIALLY_DELIVERED / DELIVERED", () => {
    expect(new Set(DELIVERED_ORDER_STATUSES)).toEqual(
      new Set(["PARTIALLY_DELIVERED", "DELIVERED"]),
    );
  });

  it("BACKING_ORDER_STATUSES is open ∪ delivered — and never DRAFT or CANCELLED", () => {
    expect(new Set(BACKING_ORDER_STATUSES)).toEqual(
      new Set([...OPEN_ORDER_STATUSES, ...DELIVERED_ORDER_STATUSES]),
    );
    expect(BACKING_ORDER_STATUSES).not.toContain("DRAFT");
    expect(BACKING_ORDER_STATUSES).not.toContain("CANCELLED");
  });
});

describe("loadCreditExposure (the ONLY reader)", () => {
  const makeDb = (invoices: unknown[], orders: unknown[]) => ({
    invoice: { findMany: jest.fn().mockResolvedValue(invoices) },
    order: { findMany: jest.fn().mockResolvedValue(orders) },
  });

  it("reads non-SETTLED invoices INCLUDING drafts (each with its order), plus the customer's open orders", async () => {
    const db = makeDb([], []);
    await loadCreditExposure(db, "cust-1");

    const invArgs = db.invoice.findMany.mock.calls[0][0];
    expect(invArgs.where.customerId).toBe("cust-1");
    // The DB read drops SETTLED only — DRAFT must come back so backing can be judged (B577 adds the
    // covering PAID invoices of OPEN orders as a second OR branch; an edit adds a third).
    const [issued] = invArgs.where.OR;
    expect(new Set(issued.status.notIn)).toEqual(new Set(CREDIT_NOT_APPLICABLE));
    expect(issued.status.notIn).not.toContain("DRAFT");
    expect(invArgs.select).toEqual({
      total: true,
      status: true,
      orderId: true,
      // Without the order relation every DRAFT would look unbacked and vanish from the block.
      order: { select: { id: true, status: true, total: true } },
      payments: { select: { amount: true, status: true, method: true } },
    });

    const ordArgs = db.order.findMany.mock.calls[0][0];
    expect(ordArgs.where.customerId).toBe("cust-1");
    expect(new Set(ordArgs.where.status.in)).toEqual(new Set(OPEN_ORDER_STATUSES));
    expect(ordArgs.select).toEqual({ id: true, total: true });
  });

  it("derives everything through the pure core, honouring excludeOrderId", async () => {
    const db = makeDb(
      [
        {
          total: 100,
          status: "SENT",
          orderId: "edit",
          order: orderRef("edit", "CONFIRMED", 100),
          payments: [],
        },
        {
          total: 50,
          status: "SENT",
          orderId: null,
          order: null,
          payments: [{ amount: 20, status: "PAID" }],
        },
        { total: 12, status: "DRAFT", orderId: null, order: null, payments: [] },
        {
          total: 90,
          status: "DRAFT",
          orderId: "del",
          order: orderRef("del", "DELIVERED", 90),
          payments: [],
        },
      ],
      [{ id: "edit", total: 100 }],
    );
    const r = await loadCreditExposure(db, "cust-1", { excludeOrderId: "edit" });
    expect(r).toEqual({
      invoiceExposure: 120, // 30 (issued, no order) + 90 (delivered-order draft)
      uninvoicedOrderExposure: 0,
      counted: 120,
      pendingExposure: 12, // the standalone draft only
      excludedOrderPaid: 0, // present only because an order is being edited; nothing was paid on it
      excludedOrderUnsettledOutstanding: 100, // ...but its own SENT invoice (100) is issued and unsettled
    });
  });

  it("issues exactly one invoice read and one order read on the client it is given", async () => {
    const db = makeDb([], []);
    await loadCreditExposure(db, "cust-1");
    expect(db.invoice.findMany).toHaveBeenCalledTimes(1);
    expect(db.order.findMany).toHaveBeenCalledTimes(1);
  });

  describe("B584: BACKING_ORDER_STATUSES is pinned exhaustively against OrderStatus", () => {
    it("every OrderStatus is classified exactly once — BACKING or NON_BACKING — so a NEW status cannot silently fall on the wrong side of the credit block", () => {
      const all = Object.values(OrderStatus).sort();
      const classified = [...BACKING_ORDER_STATUSES, ...NON_BACKING_ORDER_STATUSES].sort();
      expect(all.length).toBeGreaterThan(0);
      expect(classified).toEqual(all); // covers every status, none twice
      expect(BACKING_ORDER_STATUSES.filter((s) => NON_BACKING_ORDER_STATUSES.includes(s))).toEqual(
        [],
      );
    });

    it("the classification is the ruling's: backing = open + delivered; non-backing = DRAFT and CANCELLED only", () => {
      expect([...BACKING_ORDER_STATUSES].sort()).toEqual(
        ["CONFIRMED", "DELIVERED", "OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", "PENDING"].sort(),
      );
      expect([...NON_BACKING_ORDER_STATUSES].sort()).toEqual(["CANCELLED", "DRAFT"]);
    });
  });
});
