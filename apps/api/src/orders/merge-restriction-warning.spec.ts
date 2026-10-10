import { warnBannedMergedLines } from "./merge-restriction-warning";

/**
 * F-05 (#2093, SA-255) — MERGE AND WARN. A merge is never blocked; a non-empty banned set writes ONE audit row
 * (winner, losers, products, rules, channel), goes to `onBannedLines`, and notifies operators ONLY when no
 * staff actor sees the result (buyer / automatic). An empty set writes nothing and notifies no one.
 */
describe("warnBannedMergedLines", () => {
  const banned = {
    outcome: "BLOCK",
    reasons: [{ productId: "p-b", productName: "Banned Cola", ruleId: "rule-1", message: "no CA" }],
  };
  const winner = { id: "w1", lineItems: [{ productId: "p-ok" }, { productId: null }] };
  const losers = [{ id: "l1", lineItems: [{ productId: "p-b" }, { productId: "p-ok" }] }];
  let restrictions: { checkLinesSellable: jest.Mock };
  let prisma: { auditLog: { create: jest.Mock }; user: { findMany: jest.Mock } };
  let notifications: { sendToUser: jest.Mock };
  let warn: jest.Mock;
  let onBannedLines: jest.Mock;

  /** Runs the merge warning, then the deferred push the caller would run after it releases the lock. */
  const run = async (actor: object | null | undefined, wireCallback = true) => {
    const after = await warnBannedMergedLines(
      { restrictions, prisma, notifications, warn } as never,
      {
        tenantId: () => "t1",
        customerId: "c1",
        winner,
        losers,
        actor,
        ...(wireCallback ? { onBannedLines } : {}),
      } as never,
    );
    expect(notifications.sendToUser).not.toHaveBeenCalled(); // never inside the lock: only via the thunk
    await after?.();
  };

  beforeEach(() => {
    restrictions = { checkLinesSellable: jest.fn().mockResolvedValue(banned) };
    prisma = {
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      user: { findMany: jest.fn().mockResolvedValue([{ id: "op1" }, { id: "op2" }]) },
    };
    notifications = { sendToUser: jest.fn().mockResolvedValue(1) };
    warn = jest.fn();
    onBannedLines = jest.fn();
  });

  it("checks the WINNER's folded catalog lines (winner + losers, deduped, productless dropped)", async () => {
    await run({ role: "OPERATOR" });
    expect(restrictions.checkLinesSellable).toHaveBeenCalledWith({
      tenantId: "t1",
      customerId: "c1",
      lines: [{ productId: "p-ok" }, { productId: "p-b" }],
      channel: "STAFF",
    });
  });

  it("writes ONE audit row with winner, losers, products, rules and channel; the lines reach the callback", async () => {
    await run({ role: "OPERATOR" });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: "order.merge-banned-lines",
      entityId: "w1",
      meta: {
        winnerId: "w1",
        loserIds: ["l1"],
        productIds: ["p-b"],
        ruleIds: ["rule-1"],
        channel: "STAFF",
      },
    });
    expect(onBannedLines).toHaveBeenCalledWith([
      { productId: "p-b", productName: "Banned Cola", ruleId: "rule-1", message: "no CA" },
    ]);
  });

  it("a buyer-side actor gets the lines REDACTED (names only, no rule id or rule text)", async () => {
    await run({ type: "BUYER" });
    expect(onBannedLines).toHaveBeenCalledWith([
      {
        productId: "p-b",
        productName: "Banned Cola",
        ruleId: null,
        message: "Banned Cola can't be sold right now",
      },
    ]);
  });

  it("INDETERMINATE warns too", async () => {
    restrictions.checkLinesSellable.mockResolvedValue({ ...banned, outcome: "INDETERMINATE" });
    await run({ role: "OPERATOR" });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("a staff actor who is SHOWN the lines needs no push; a staff path wiring NO callback still notifies (SA-272)", async () => {
    await run({ role: "OPERATOR" });
    expect(notifications.sendToUser).not.toHaveBeenCalled();
    await run({ role: "OPERATOR" }, false);
    expect(notifications.sendToUser).toHaveBeenCalledTimes(2);
  });

  it("onBannedLines is called BEFORE the audit insert, so a failed insert cannot drop it", async () => {
    prisma.auditLog.create.mockRejectedValue(new Error("audit down"));
    await run({ role: "OPERATOR" });
    expect(onBannedLines).toHaveBeenCalledTimes(1);
  });

  it("a tenant-less caller never fails the merge: the tenant is resolved inside the try", async () => {
    await expect(
      warnBannedMergedLines(
        { restrictions, prisma, notifications, warn } as never,
        {
          tenantId: () => {
            throw new Error("Selling restrictions require a tenant-scoped session");
          },
          customerId: "c1",
          winner,
          losers,
          actor: null,
        } as never,
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tenant-scoped"));
  });

  it.each([
    ["a buyer", { type: "BUYER" }],
    ["an automatic run (no principal)", null],
  ])("%s is judged as BUYER_PORTAL and notifies each operator once", async (_n, actor) => {
    await run(actor);
    expect(restrictions.checkLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "BUYER_PORTAL" }),
    );
    expect(notifications.sendToUser).toHaveBeenCalledTimes(2);
    expect(prisma.auditLog.create.mock.calls[0][0].data.meta.channel).toBe("BUYER_PORTAL");
  });

  it("an empty set (ALLOW) writes nothing, calls nothing, notifies no one", async () => {
    restrictions.checkLinesSellable.mockResolvedValue({ outcome: "ALLOW", reasons: [] });
    await run(null);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(onBannedLines).not.toHaveBeenCalled();
    expect(notifications.sendToUser).not.toHaveBeenCalled();
  });

  it("NEVER blocks: a failing check or write is swallowed and logged, and does not throw", async () => {
    restrictions.checkLinesSellable.mockRejectedValue(new Error("db down"));
    await expect(run(null)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("db down"));
    restrictions.checkLinesSellable.mockResolvedValue(banned);
    prisma.auditLog.create.mockRejectedValue(new Error("audit down"));
    await expect(run(null)).resolves.toBeUndefined();
  });
});
