import {
  assertNoLiveReturn,
  liveReturnWhere,
  lockThenAssertNoLiveReturn,
  UNDO_STOP_RETURN_MESSAGE,
} from "./live-return-guard";

const txWith = (count: number) => ({ return: { count: jest.fn().mockResolvedValue(count) } });

describe("liveReturnWhere (SA-1101 A-6, RO-36)", () => {
  it("counts a return that rides on the order OR one whose lines were sold on it, and not a dead one", () => {
    expect(liveReturnWhere(["X"])).toEqual({
      status: { notIn: ["REJECTED", "CANCELLED"] },
      OR: [{ orderId: { in: ["X"] } }, { items: { some: { sourceOrderId: { in: ["X"] } } } }],
    });
  });

  it("copies the ids, so a later change to the caller's array cannot change the filter", () => {
    const ids = ["a", "b"];
    const where = liveReturnWhere(ids);
    ids.push("c");
    expect(JSON.stringify(where)).not.toContain('"c"');
  });
});

describe("assertNoLiveReturn", () => {
  it("counts non-dead returns over the given orders and throws 409 ORDER_HAS_RETURN with the caller's text", async () => {
    const tx = txWith(1);
    await expect(assertNoLiveReturn(tx, ["o1", "o2"], "msg")).rejects.toMatchObject({
      status: 409,
      response: { code: "ORDER_HAS_RETURN", message: "msg" },
    });
    expect(tx.return.count).toHaveBeenCalledWith({
      where: {
        status: { notIn: ["REJECTED", "CANCELLED"] },
        OR: [
          { orderId: { in: ["o1", "o2"] } },
          { items: { some: { sourceOrderId: { in: ["o1", "o2"] } } } },
        ],
      },
    });
  });

  it("passes when no live return exists, and asks nothing for an empty stop", async () => {
    await expect(assertNoLiveReturn(txWith(0), ["o1"], "msg")).resolves.toBeUndefined();
    const tx = txWith(5);
    await expect(assertNoLiveReturn(tx, [], "msg")).resolves.toBeUndefined();
    expect(tx.return.count).not.toHaveBeenCalled();
  });

  it("the Undo-the-stop sentence is A-4's", () => {
    expect(UNDO_STOP_RETURN_MESSAGE).toBe(
      "An order on this stop has a return. To undo the stop, cancel the return first.",
    );
  });
});

describe("lockThenAssertNoLiveReturn", () => {
  it("takes the Order row lock (id order) before it counts, and still throws on a live return", async () => {
    const order: string[] = [];
    const tx = {
      $executeRaw: jest.fn().mockImplementation(async () => void order.push("lock")),
      return: {
        count: jest.fn().mockImplementation(async () => {
          order.push("count");
          return 1;
        }),
      },
    };
    await expect(lockThenAssertNoLiveReturn(tx as never, ["b", "a"], "msg")).rejects.toMatchObject({
      response: { code: "ORDER_HAS_RETURN", message: "msg" },
    });
    expect(order).toEqual(["lock", "count"]);
  });
});
