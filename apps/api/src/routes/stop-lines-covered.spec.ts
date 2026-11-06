import { BadRequestException } from "@nestjs/common";
import { assertEveryOpenLineCovered, lockStopOrdersAndFit } from "./complete-payment-reconcile";

/**
 * SA-1101 §2.3 (B785): every line with something left needs an entry in `deliveries`.
 * RO-6 (no entries), RO-6b (one of two), RO-6c (the observed re-visit shape: a line delivered on an
 * earlier visit has nothing left and needs none). The remaining figure is `lineRemaining`, the one the fit
 * check uses, read through the same evidence rows.
 */
type Line = {
  id: string;
  orderId: string;
  qty: number;
  deliveredQty: number;
  status?: string;
  order?: { status: string };
};
const line = (id: string, over: Partial<Line> = {}): Line => ({
  id,
  orderId: "O1",
  qty: 10,
  deliveredQty: 0,
  status: "CONFIRMED",
  order: { status: "OUT_FOR_DELIVERY" },
  ...over,
});

/** `evidence` = DeliveryMutation rows (keyed by line id) the earlier visits left. */
function fakeTx(
  lines: Line[],
  evidence: Array<{ orderItemId: string; orderId: string; qty: number }> = [],
) {
  return {
    orderItem: { findMany: jest.fn().mockResolvedValue(lines) },
    deliveryMutation: {
      findMany: jest.fn().mockResolvedValue(
        evidence.map((e) => ({
          orderId: e.orderId,
          orderItemId: e.orderItemId,
          routeRunStopId: "earlier-stop",
          type: "DELIVERED",
          quantityDelivered: e.qty,
        })),
      ),
    },
  };
}
const ORDERS = [{ id: "O1" }];

async function refusal(promise: Promise<unknown>): Promise<BadRequestException> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return e as BadRequestException;
  }
  throw new Error("expected a 400");
}

describe("assertEveryOpenLineCovered (SA-1101 B785)", () => {
  it("RO-6: deliveries [] on an order with something left is a 400 STOP_DELIVERY_LINES_MISSING", async () => {
    const tx = fakeTx([line("a"), line("b")]);
    const e = await refusal(assertEveryOpenLineCovered(tx, "S1", ORDERS, []));
    expect(e.getResponse()).toMatchObject({ code: "STOP_DELIVERY_LINES_MISSING" });
    expect(JSON.stringify(e.getResponse())).toContain("2 lines are missing");
  });

  it("RO-6: undefined deliveries is the same refusal", async () => {
    await refusal(assertEveryOpenLineCovered(fakeTx([line("a")]), "S1", ORDERS, undefined));
  });

  it("RO-6b: two lines, an entry for one -> 400 naming 1 missing", async () => {
    const tx = fakeTx([line("a"), line("b")]);
    const e = await refusal(assertEveryOpenLineCovered(tx, "S1", ORDERS, [{ orderItemId: "a" }]));
    expect(JSON.stringify(e.getResponse())).toContain("1 line is missing");
  });

  it("RO-6c (guard): a re-visit - line b delivered in full earlier, an entry only for a - passes", async () => {
    const tx = fakeTx(
      [line("a"), line("b", { qty: 5, deliveredQty: 5 })],
      [{ orderItemId: "b", orderId: "O1", qty: 5 }],
    );
    await expect(
      assertEveryOpenLineCovered(tx, "S1", ORDERS, [{ orderItemId: "a" }]),
    ).resolves.toBeUndefined();
  });

  it("a refused entry (type REFUSED, quantity 0) still counts as an entry", async () => {
    const tx = fakeTx([line("a")]);
    await expect(
      assertEveryOpenLineCovered(tx, "S1", ORDERS, [{ orderItemId: "a" }]),
    ).resolves.toBeUndefined();
  });

  it("a line with nothing left (column says fully delivered, no rows) needs no entry", async () => {
    const tx = fakeTx([line("a", { deliveredQty: 10 })]);
    await expect(assertEveryOpenLineCovered(tx, "S1", ORDERS, [])).resolves.toBeUndefined();
  });

  it("a stop with no lines to cover reads no evidence", async () => {
    const tx = fakeTx([]);
    await expect(assertEveryOpenLineCovered(tx, "S1", ORDERS, [])).resolves.toBeUndefined();
    expect(tx.deliveryMutation.findMany).not.toHaveBeenCalled();
  });

  it("the read already excludes cancelled lines and non-routable orders (DRAFT, terminal)", async () => {
    const tx = fakeTx([]);
    await assertEveryOpenLineCovered(tx, "S1", ORDERS, []);
    const where = tx.orderItem.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ not: "CANCELLED" });
    expect(where.order.status.notIn).toEqual(["DRAFT", "DELIVERED", "REFUSED", "CANCELLED"]);
  });

  it("no orders on the stop -> nothing to cover, no query", async () => {
    const tx = fakeTx([line("a")]);
    await expect(assertEveryOpenLineCovered(tx, "S1", [], [])).resolves.toBeUndefined();
    expect(tx.orderItem.findMany).not.toHaveBeenCalled();
  });
});

describe("lockStopOrdersAndFit runs the cover check after the fit (SA-1101)", () => {
  it("an empty close on an order with something left is refused through the shared entry point", async () => {
    const calls: string[] = [];
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
      order: { findMany: jest.fn().mockResolvedValue([]) },
      orderItem: {
        findMany: jest.fn().mockImplementation(async () => {
          calls.push("orderItem.findMany");
          return [line("a")];
        }),
      },
      deliveryMutation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    await refusal(lockStopOrdersAndFit(tx, "S1", ORDERS, []));
    expect(calls).toEqual(["orderItem.findMany"]);
  });
});
