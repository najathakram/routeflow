// Records the lock's lifecycle so a test can prove WHEN the deferred push runs relative to the unlock.
const mockEvents: string[] = [];
// B1053: fold-math spec — the row guard is passed through (see testing/merge-recheck-passthrough.ts).
jest.mock("./merge-lock-recheck", () =>
  require("./testing/merge-recheck-passthrough").passthrough(),
);
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => {
    mockEvents.push("lock");
    try {
      return { acquired: true, value: await fn() };
    } finally {
      mockEvents.push("unlock");
    }
  }),
}));

import { buildOrdersService } from "./testing/orders-service-harness";

/**
 * F-05 (#2093, SA-255) — the merge paths call the merge-and-warn helper: a merge is never blocked, the actor
 * picks the channel (staff = STAFF; buyer / automatic = BUYER_PORTAL), and the banned lines reach the caller.
 * The helper's own behaviour is pinned in `merge-restriction-warning.spec.ts`.
 */
describe("OrdersService merge paths — merge and warn (F-05)", () => {
  const line = (id: string, productId: string) => ({
    id,
    productId,
    qty: 2,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitPrice: 5,
    subtotal: 10,
    status: "PENDING",
    priceType: "STANDARD",
    originalPrice: null,
    overrideReason: null,
    overriddenBy: null,
    notes: null,
  });
  const orders = () => [
    {
      id: "w1",
      customerId: "cust-1",
      tenantId: "t-row",
      status: "PENDING",
      lineItems: [line("wl", "p-ok")],
    },
    {
      id: "l1",
      customerId: "cust-1",
      tenantId: "t-row",
      status: "PENDING",
      lineItems: [line("ll", "p-banned")],
    },
  ];
  const banned = {
    outcome: "BLOCK",
    reasons: [{ productId: "p-banned", productName: "Banned Cola", ruleId: "r1", message: "no" }],
  };

  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.getTenantId.mockReturnValue("t1");
    h.prisma.orderItem.findMany.mockResolvedValue([]);
    h.prisma.order.findMany.mockResolvedValue(orders());
    h.prisma.product.findMany.mockResolvedValue([]);
    h.prisma.user.findMany.mockResolvedValue([{ id: "op1" }]);
    h.restrictions.checkLinesSellable.mockResolvedValue(banned);
    mockEvents.length = 0;
    h.sideEffects.notifications.sendToUser.mockImplementation(async () => {
      mockEvents.push("push");
      return 1;
    });
  });

  it("mergeAllPendingForCustomer: a ban never blocks; a staff actor is STAFF, sees the lines, no notification", async () => {
    const onBannedLines = jest.fn();
    await expect(
      h.service.mergeAllPendingForCustomer(
        "cust-1",
        {},
        { actor: { role: "OPERATOR" }, onBannedLines },
      ),
    ).resolves.toBeDefined();
    expect(h.restrictions.checkLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "STAFF", customerId: "cust-1", tenantId: "t-row" }),
    );
    expect(onBannedLines).toHaveBeenCalledWith([
      expect.objectContaining({ productId: "p-banned" }),
    ]);
    expect(h.prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("a staff merge path that wires NO onBannedLines (merge-choice create, driver auto-merge) still notifies operators, after the lock", async () => {
    await h.service.mergeAllPendingForCustomer("cust-1", {}, { actor: { role: "OPERATOR" } });
    expect(h.sideEffects.notifications.sendToUser).toHaveBeenCalledTimes(1);
    expect(h.prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("a buyer-initiated merge is BUYER_PORTAL and notifies operators", async () => {
    await h.service.mergeAllPendingForCustomer("cust-1", { buyerInitiated: true });
    expect(h.restrictions.checkLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "BUYER_PORTAL" }),
    );
  });

  it("an automatic merge (no actor) is the stricter BUYER_PORTAL", async () => {
    await h.service.mergeAllPendingForCustomer("cust-1");
    expect(h.restrictions.checkLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "BUYER_PORTAL" }),
    );
  });

  it("forceConsolidateCustomer warns the same way and never blocks", async () => {
    const onBannedLines = jest.fn();
    await expect(
      h.service.forceConsolidateCustomer("cust-1", { actor: { role: "OPERATOR" }, onBannedLines }),
    ).resolves.toBeDefined();
    expect(h.restrictions.checkLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "STAFF" }),
    );
    expect(onBannedLines).toHaveBeenCalledTimes(1);
  });

  it("nothing banned: the merge writes no warning row", async () => {
    h.restrictions.checkLinesSellable.mockResolvedValue({ outcome: "ALLOW", reasons: [] });
    await h.service.mergeAllPendingForCustomer("cust-1");
    expect(h.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("the winner row's tenant wins over the ambient one (fixtures carry t-row, the ambient tenant is t1)", async () => {
    await h.service.mergeAllPendingForCustomer("cust-1");
    expect(h.restrictions.checkLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t-row" }),
    );
    expect(h.prisma.auditLog.create.mock.calls[0][0].data.tenantId).toBe("t-row");
  });

  it("the push runs AFTER the advisory lock is released, never inside it", async () => {
    await h.service.mergeAllPendingForCustomer("cust-1", { buyerInitiated: true });
    expect(mockEvents[0]).toBe("lock");
    expect(mockEvents.indexOf("unlock")).toBeGreaterThan(-1);
    expect(mockEvents.indexOf("push")).toBeGreaterThan(mockEvents.indexOf("unlock"));
  });

  it("a merge whose transaction THROWS writes no audit row and sends no push (both merge paths)", async () => {
    h.prisma.tenantTransaction.mockRejectedValue(new Error("tx failed"));
    await expect(
      h.service.mergeAllPendingForCustomer("cust-1", { buyerInitiated: true }),
    ).rejects.toThrow("tx failed");
    // proves the throw came from the merge transaction itself, not an earlier step
    expect(h.prisma.tenantTransaction).toHaveBeenCalled();
    await expect(
      h.service.forceConsolidateCustomer("cust-1", { actor: { type: "BUYER" } }),
    ).rejects.toThrow("tx failed");
    expect(h.prisma.auditLog.create).not.toHaveBeenCalled();
    expect(h.sideEffects.notifications.sendToUser).not.toHaveBeenCalled();
  });

  describe("forceConsolidateCustomer uses the same pattern", () => {
    it("the winner row's tenant wins over the ambient one", async () => {
      await h.service.forceConsolidateCustomer("cust-1", { actor: { role: "OPERATOR" } });
      expect(h.restrictions.checkLinesSellable).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "t-row" }),
      );
      expect(h.prisma.auditLog.create.mock.calls[0][0].data.tenantId).toBe("t-row");
    });

    it("the push runs AFTER the advisory lock is released, never inside it", async () => {
      // a non-STAFF actor (buyer) so the push is sent at all
      await h.service.forceConsolidateCustomer("cust-1", { actor: { type: "BUYER" } });
      expect(mockEvents[0]).toBe("lock");
      expect(mockEvents.indexOf("unlock")).toBeGreaterThan(-1);
      expect(mockEvents.indexOf("push")).toBeGreaterThan(mockEvents.indexOf("unlock"));
    });
  });
});
