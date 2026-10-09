/**
 * SA-749r2 item 9 (LEAD RULING, CR-1): a CASH refund may not exceed the cash applied to that sale minus the cash already
 * refunded on it (409 REFUND_EXCEEDS_CASH_PAID). It is per SALE (a return can span source orders on the inline path), enforced
 * under the Order locks on both refund paths. The cash applied is the PAID CASH payments on the sale's live invoices (a split
 * sale's card leg is not cash); earlier refunds count when their tender is CASH or UNKNOWN (fail closed: a null tender is never
 * assumed to be card). Card and check have no cap yet (they wait for the tender column's own reports).
 */
import {
  amountsBySourceOrder,
  assertCashRefundWithinCap,
  refundAmountsBySale,
} from "./cash-refund-cap";

type Pay = { amount: number; invoice: { orderId: string } };
type EarlierItem = {
  sourceOrderId: string;
  subtotal: number;
  taxAmount: number;
  categoryTax: number;
};
type EarlierStd = { orderId: string; refundAmount: number };

function fakeTx(rows: { pay?: Pay[]; items?: EarlierItem[]; std?: EarlierStd[] }) {
  const calls: Record<string, any[]> = { pay: [], items: [], std: [] };
  return {
    calls,
    tx: {
      invoicePayment: {
        findMany: jest.fn(async (args: any) => (calls.pay.push(args), rows.pay ?? [])),
      },
      returnItem: {
        findMany: jest.fn(async (args: any) => (calls.items.push(args), rows.items ?? [])),
      },
      return: {
        findMany: jest.fn(async (args: any) => (calls.std.push(args), rows.std ?? [])),
      },
    },
  };
}

const run = async (
  rows: Parameters<typeof fakeTx>[0],
  perOrder: Array<[string, number]>,
  tender: "CASH" | "CARD" | "CHECK" | null = "CASH",
  counterOrder?: boolean,
) => {
  const f = fakeTx(rows);
  const out = await assertCashRefundWithinCap(f.tx, {
    returnId: "ret-now",
    tender,
    perOrder: new Map(perOrder),
    counterOrder,
  }).then(
    () => null,
    (e: any) => ({ status: e.getStatus?.(), body: e.getResponse?.() }),
  );
  return { out, ...f };
};

describe("assertCashRefundWithinCap", () => {
  it("a split sale (cash 40 of 100): refunding 40.00 in cash is fine, 40.01 is 409 REFUND_EXCEEDS_CASH_PAID with the maximum", async () => {
    const pay = [{ amount: 40, invoice: { orderId: "o1" } }];
    expect((await run({ pay }, [["o1", 40]])).out).toBeNull();
    const { out } = await run({ pay }, [["o1", 40.01]]);
    expect(out?.status).toBe(409);
    expect(out?.body).toMatchObject({
      code: "REFUND_EXCEEDS_CASH_PAID",
      maxCashRefund: 40,
      requested: 40.01,
    });
    expect(out?.body.message).toMatch(/card or check|store credit/i);
  });

  it("earlier cash refunds on the sale reduce the room: cash 40, 30 already refunded, so at most 10.00 more", async () => {
    const pay = [{ amount: 40, invoice: { orderId: "o1" } }];
    const items = [{ sourceOrderId: "o1", subtotal: 28, taxAmount: 2, categoryTax: 0 }];
    expect((await run({ pay, items }, [["o1", 10]])).out).toBeNull();
    expect((await run({ pay, items }, [["o1", 10.01]])).out?.body).toMatchObject({
      code: "REFUND_EXCEEDS_CASH_PAID",
      maxCashRefund: 10,
    });
  });

  it("an earlier STANDARD cash refund (its whole amount on its order) counts the same", async () => {
    const pay = [{ amount: 100, invoice: { orderId: "o1" } }];
    const std = [{ orderId: "o1", refundAmount: 90 }];
    expect((await run({ pay, std }, [["o1", 10]])).out).toBeNull();
    expect((await run({ pay, std }, [["o1", 10.5]])).out?.body).toMatchObject({
      maxCashRefund: 10,
    });
  });

  it("a sale paid entirely by card has no cash to give back: maximum 0", async () => {
    const { out } = await run({ pay: [] }, [["o1", 5]]);
    expect(out?.body).toMatchObject({ code: "REFUND_EXCEEDS_CASH_PAID", maxCashRefund: 0 });
  });

  it("is per SALE: two source orders, one within its cash and one over its own (the other's cash does not cover it)", async () => {
    const pay = [
      { amount: 50, invoice: { orderId: "o1" } },
      { amount: 5, invoice: { orderId: "o2" } },
    ];
    expect(
      (
        await run({ pay }, [
          ["o1", 50],
          ["o2", 5],
        ])
      ).out,
    ).toBeNull();
    const { out } = await run({ pay }, [
      ["o1", 20],
      ["o2", 20],
    ]);
    expect(out?.body).toMatchObject({
      code: "REFUND_EXCEEDS_CASH_PAID",
      maxCashRefund: 5,
      requested: 20,
    });
  });

  it("several cash payments on one sale add up", async () => {
    const pay = [
      { amount: 20, invoice: { orderId: "o1" } },
      { amount: 20.5, invoice: { orderId: "o1" } },
    ];
    expect((await run({ pay }, [["o1", 40.5]])).out).toBeNull();
  });

  it("card and check refunds are not capped here and read nothing", async () => {
    for (const tender of ["CARD", "CHECK", null] as const) {
      const r = await run({ pay: [] }, [["o1", 999]], tender);
      expect(r.out).toBeNull();
      expect(r.tx.invoicePayment.findMany).not.toHaveBeenCalled();
    }
  });

  describe("an omitted tender on a COUNTER order is treated as cash (fail closed)", () => {
    const pay = [{ amount: 40, invoice: { orderId: "o1" } }]; // a split sale: 40 cash + 60 card

    it("a refund of 60 with no tender on a 40-cash split counter sale is 409 REFUND_EXCEEDS_CASH_PAID", async () => {
      const { out } = await run({ pay }, [["o1", 60]], null, true);
      expect(out?.body).toMatchObject({
        code: "REFUND_EXCEEDS_CASH_PAID",
        maxCashRefund: 40,
        requested: 60,
      });
    });

    it("within the cash it is fine, and the cap reads the sale", async () => {
      const r = await run({ pay }, [["o1", 40]], null, true);
      expect(r.out).toBeNull();
      expect(r.tx.invoicePayment.findMany).toHaveBeenCalled();
    });

    it("an explicit CARD or CHECK tender on a counter order is still uncapped", async () => {
      for (const tender of ["CARD", "CHECK"] as const) {
        expect((await run({ pay }, [["o1", 60]], tender, true)).out).toBeNull();
      }
    });

    it("a NON-counter order with no tender stays uncapped (the server tender is optional there)", async () => {
      const r = await run({ pay }, [["o1", 60]], null, false);
      expect(r.out).toBeNull();
      expect(r.tx.invoicePayment.findMany).not.toHaveBeenCalled();
    });
  });

  describe("what it reads", () => {
    it("cash = PAID CASH payments on LIVE (not VOID / WRITTEN_OFF) invoices of the sale", async () => {
      const { calls } = await run({ pay: [{ amount: 40, invoice: { orderId: "o1" } }] }, [
        ["o1", 1],
      ]);
      expect(calls.pay[0].where).toMatchObject({
        method: "CASH",
        status: "PAID",
        invoice: { orderId: { in: ["o1"] }, status: { notIn: ["VOID", "WRITTEN_OFF"] } },
      });
    });

    it("earlier refunds = other REFUNDED EXTERNAL_REFUND returns whose tender is CASH or UNKNOWN (null), never this return", async () => {
      const { calls } = await run({ pay: [{ amount: 40, invoice: { orderId: "o1" } }] }, [
        ["o1", 1],
      ]);
      const where = calls.items[0].where;
      expect(where.sourceOrderId).toEqual({ in: ["o1"] });
      expect(where.return).toMatchObject({
        kind: "INLINE",
        status: "REFUNDED",
        refundMethod: "EXTERNAL_REFUND",
        id: { not: "ret-now" },
        OR: [{ refundTender: null }, { refundTender: "CASH" }],
      });
      expect(calls.std[0].where).toMatchObject({
        orderId: { in: ["o1"] },
        kind: "STANDARD",
        status: "REFUNDED",
        refundMethod: "EXTERNAL_REFUND",
        id: { not: "ret-now" },
        OR: [{ refundTender: null }, { refundTender: "CASH" }],
      });
    });
  });
});

describe("refundAmountsBySale", () => {
  const item = (sourceOrderId: string | null, subtotal: number) => ({
    sourceOrderId,
    subtotal,
    taxAmount: 0,
    categoryTax: 0,
  });
  it("a return from ONE sale takes exactly the refund total (even when the items carry no money)", () => {
    expect([...refundAmountsBySale([item("o1", 0), item("o1", 0)], 30)]).toEqual([["o1", 30]]);
    expect([...refundAmountsBySale([item("o1", 10), item("o1", 19.99)], 30)]).toEqual([["o1", 30]]);
  });
  it("a return spanning several sales is split by its items' own money", () => {
    expect([...refundAmountsBySale([item("o1", 10), item("o2", 5)], 15)]).toEqual([
      ["o1", 10],
      ["o2", 5],
    ]);
  });
  it("no source order at all is an empty split (nothing to cap; the paid-in-full gate already refused it)", () => {
    expect(refundAmountsBySale([item(null, 5)], 5).size).toBe(0);
  });
});

describe("amountsBySourceOrder", () => {
  it("sums subtotal + tax + category tax of the return's items per source order, rounded to cents", () => {
    const m = amountsBySourceOrder([
      { sourceOrderId: "o1", subtotal: "10.00", taxAmount: "0.87", categoryTax: "0" },
      { sourceOrderId: "o1", subtotal: 5, taxAmount: 0.44, categoryTax: null },
      { sourceOrderId: "o2", subtotal: 1, taxAmount: 0, categoryTax: 0 },
      { sourceOrderId: null, subtotal: 9, taxAmount: 0, categoryTax: 0 },
    ]);
    expect([...m]).toEqual([
      ["o1", 16.31],
      ["o2", 1],
    ]);
  });
});
