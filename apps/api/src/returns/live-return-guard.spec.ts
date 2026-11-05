import {
  assertNoLiveReturn,
  lockThenAssertNoLiveReturn,
  UNDO_STOP_RETURN_MESSAGE,
} from "./live-return-guard";

const txWith = (count: number) => ({ return: { count: jest.fn().mockResolvedValue(count) } });

describe("assertNoLiveReturn", () => {
  it("counts non-dead returns over the given orders and throws 409 ORDER_HAS_RETURN with the caller's text", async () => {
    const tx = txWith(1);
    await expect(assertNoLiveReturn(tx, ["o1", "o2"], "msg")).rejects.toMatchObject({
      status: 409,
      response: { code: "ORDER_HAS_RETURN", message: "msg" },
    });
    expect(tx.return.count).toHaveBeenCalledWith({
      where: { orderId: { in: ["o1", "o2"] }, status: { notIn: ["REJECTED", "CANCELLED"] } },
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
