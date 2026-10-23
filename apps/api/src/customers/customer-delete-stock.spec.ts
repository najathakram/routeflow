import { ConflictException, Logger } from "@nestjs/common";
import { assertOrdersUnchanged, releaseLiveOrderStockInTx } from "./customer-delete-stock";

/** B1241 (N1 + M1 units): the lock-wait mapping, the lock_timeout restore, and the order CAS. */
describe("customer-delete-stock", () => {
  const logger = new Logger("test");
  const txWith = (executeRaw: jest.Mock, queryRaw: jest.Mock) => ({
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    order: { findMany: jest.fn().mockResolvedValue([{ id: "o1", status: "PENDING" }]) },
    orderItem: {
      findMany: jest.fn().mockResolvedValue([{ orderId: "o1", productId: "p1", qty: 3 }]),
    },
    product: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
  });

  it("a lock wait that gives up (55P03) is a 409 retry, never a raw error", async () => {
    const timeout = Object.assign(new Error("canceling statement due to lock timeout"), {
      code: "55P03",
    });
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ v: "0" }]) // current_setting('lock_timeout')
      .mockResolvedValueOnce([]) // Return rows
      .mockResolvedValueOnce([{ id: "o1" }]); // Order rows
    const executeRaw = jest.fn().mockRejectedValue(timeout); // the Product lock
    await expect(
      releaseLiveOrderStockInTx(txWith(executeRaw, queryRaw), "t1", logger, ["c1"]),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("an unrelated error is rethrown unchanged", async () => {
    const boom = new Error("boom");
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ v: "0" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "o1" }]);
    const executeRaw = jest.fn().mockRejectedValue(boom);
    await expect(
      releaseLiveOrderStockInTx(txWith(executeRaw, queryRaw), "t1", logger, ["c1"]),
    ).rejects.toBe(boom);
  });

  it("returns the locked order ids (live or not), and puts lock_timeout back", async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ v: "0" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "o1" }, { id: "o2" }]);
    const executeRaw = jest.fn().mockResolvedValue(0);
    const tx = txWith(executeRaw, queryRaw);
    tx.order.findMany.mockResolvedValue([
      { id: "o1", status: "DRAFT" },
      { id: "o2", status: "DELIVERED" },
    ]);
    await expect(releaseLiveOrderStockInTx(tx, "t1", logger, ["c1"])).resolves.toEqual([
      "o1",
      "o2",
    ]);
    expect(executeRaw).not.toHaveBeenCalled(); // nothing live: no product lock, nothing to restore
  });

  it("assertOrdersUnchanged: equal sets pass; an extra or a missing order is a 409", () => {
    expect(() => assertOrdersUnchanged(["b", "a"], ["a", "b"])).not.toThrow();
    expect(() => assertOrdersUnchanged([], [])).not.toThrow();
    expect(() => assertOrdersUnchanged(["a", "c"], ["a"])).toThrow(ConflictException);
    expect(() => assertOrdersUnchanged(["a"], ["a", "b"])).toThrow(ConflictException);
    expect(() => assertOrdersUnchanged(["a", "a"], ["a", "b"])).toThrow(ConflictException);
  });
});
