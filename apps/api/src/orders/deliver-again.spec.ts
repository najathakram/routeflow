import { ConflictException } from "@nestjs/common";
import { deliverAgainInTx } from "./deliver-again";

/**
 * SA-1101 A-3 (B1 + N1). RO-14 (the compare-and-set misses), RO-17 (a PENDING return blocks it), RO-20 (a stop that is
 * not COMPLETED is never cleared), plus the classification table. The real round trip is deliver-again.db.spec.ts (RO-8).
 */
type OrderRow = {
  id: string;
  status: string;
  routeRunId: string | null;
  routeRunStopId: string | null;
  routeRunStop: { status: string } | null;
  routeRun: { status: string } | null;
};
const base: OrderRow = {
  id: "o1",
  status: "REFUSED",
  routeRunId: "run1",
  routeRunStopId: "stop1",
  routeRunStop: { status: "COMPLETED" },
  routeRun: { status: "IN_PROGRESS" },
};
function fakeTx(
  over: Partial<OrderRow> | null,
  opts: { liveReturns?: number; casCount?: number } = {},
) {
  const row = over === null ? null : { ...base, ...over };
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    order: {
      findFirst: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: opts.casCount ?? 1 }),
    },
    return: { count: jest.fn().mockResolvedValue(opts.liveReturns ?? 0) },
  };
  return tx;
}
const data = { status: "CONFIRMED" } as any;
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConflictException);
    return (e as ConflictException).getResponse() as { code: string; message: string };
  }
  throw new Error("expected a 409");
};

describe("deliverAgainInTx (SA-1101 A-3)", () => {
  it("locks the Order row first, then reads, then writes once", async () => {
    const tx = fakeTx({});
    await deliverAgainInTx(tx as any, "o1", data);
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.order.findFirst.mock.invocationCallOrder[0],
    );
    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
  });

  it("a COMPLETED stop's link is cleared together, as one CAS on the link as read", async () => {
    const tx = fakeTx({});
    await deliverAgainInTx(tx as any, "o1", data);
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "o1", status: "REFUSED", routeRunId: "run1", routeRunStopId: "stop1" },
      data: { status: "CONFIRMED", routeRunId: null, routeRunStopId: null },
    });
  });

  it("no link: the status moves and nothing else is written", async () => {
    const tx = fakeTx({
      routeRunId: null,
      routeRunStopId: null,
      routeRunStop: null,
      routeRun: null,
    });
    await deliverAgainInTx(tx as any, "o1", data);
    expect(tx.order.updateMany.mock.calls[0][0].data).toEqual({ status: "CONFIRMED" });
  });

  it.each(["COMPLETED", "CANCELLED"])("a bare link to a %s run is cleared", async (status) => {
    const tx = fakeTx({ routeRunStopId: null, routeRunStop: null, routeRun: { status } });
    await deliverAgainInTx(tx as any, "o1", data);
    expect(tx.order.updateMany.mock.calls[0][0].data).toEqual({
      status: "CONFIRMED",
      routeRunId: null,
      routeRunStopId: null,
    });
  });

  it.each(["SCHEDULED", "IN_PROGRESS"])(
    "a bare link to a %s run fails closed: 409 ORDER_RUN_LINK_CHANGED, nothing written",
    async (status) => {
      const tx = fakeTx({ routeRunStopId: null, routeRunStop: null, routeRun: { status } });
      expect((await codeOf(deliverAgainInTx(tx as any, "o1", data))).code).toBe(
        "ORDER_RUN_LINK_CHANGED",
      );
      expect(tx.order.updateMany).not.toHaveBeenCalled();
    },
  );

  it("RO-20: a stop link whose stop is not COMPLETED is never cleared", async () => {
    for (const status of ["PENDING", "IN_PROGRESS", "SKIPPED"]) {
      const tx = fakeTx({ routeRunStop: { status } });
      expect((await codeOf(deliverAgainInTx(tx as any, "o1", data))).code).toBe(
        "ORDER_RUN_LINK_CHANGED",
      );
      expect(tx.order.updateMany).not.toHaveBeenCalled();
    }
  });

  it("a stop link whose stop row cannot be read fails closed", async () => {
    const tx = fakeTx({ routeRunStop: null });
    expect((await codeOf(deliverAgainInTx(tx as any, "o1", data))).code).toBe(
      "ORDER_RUN_LINK_CHANGED",
    );
  });

  it("RO-14: the CAS sees the link changed since the read (count 0): 409, the caller's tx rolls back", async () => {
    const tx = fakeTx({}, { casCount: 0 });
    const body = await codeOf(deliverAgainInTx(tx as any, "o1", data));
    expect(body.code).toBe("ORDER_RUN_LINK_CHANGED");
    expect(body.message).toBe("This order's delivery run changed. Reload and try again.");
  });

  it("RO-17: a live return (any status but REJECTED / CANCELLED) blocks it, with A-3's text", async () => {
    const tx = fakeTx({}, { liveReturns: 1 });
    const body = await codeOf(deliverAgainInTx(tx as any, "o1", data));
    expect(body).toMatchObject({
      code: "ORDER_HAS_RETURN",
      message:
        "This order has a return. To deliver it again, cancel the return first, or create a new order.",
    });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    const where = tx.return.count.mock.calls[0][0].where;
    expect(where.status.notIn).toEqual(["REJECTED", "CANCELLED"]);
    expect(where.orderId).toBe("o1");
  });

  it("the return check runs before the link is classified or written", async () => {
    const tx = fakeTx({ routeRunStop: { status: "IN_PROGRESS" } }, { liveReturns: 2 });
    expect((await codeOf(deliverAgainInTx(tx as any, "o1", data))).code).toBe("ORDER_HAS_RETURN");
  });

  it("an order that is no longer REFUSED under the lock is the generic changed-during-edit 409", async () => {
    const tx = fakeTx({ status: "CONFIRMED" });
    expect((await codeOf(deliverAgainInTx(tx as any, "o1", data))).code).toBe(
      "ORDER_CHANGED_DURING_EDIT",
    );
    const gone = fakeTx(null);
    expect((await codeOf(deliverAgainInTx(gone as any, "o1", data))).code).toBe(
      "ORDER_CHANGED_DURING_EDIT",
    );
  });
});
