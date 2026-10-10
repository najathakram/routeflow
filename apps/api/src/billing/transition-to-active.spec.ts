import { clearDunningTx, DUNNING_CLEAR, transitionToActiveTx } from "./transition-to-active";

function makeTx(opts: { count?: number; sub?: any } = {}) {
  const tx: any = {
    tenant: { updateMany: jest.fn().mockResolvedValue({ count: opts.count ?? 1 }) },
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue(opts.sub ?? null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return tx;
}

describe("transitionToActiveTx - the ONE path back to ACTIVE (SA-733r2 N5)", () => {
  const now = new Date("2026-11-09T12:00:00Z");

  it("writes ACTIVE, nulls readOnlyReason and clears the dunning clock + pause in the same tx", async () => {
    const tx = makeTx({ sub: { pausedAt: null, stripeSubId: "sub_1" } });
    const out = await transitionToActiveTx(tx, "t1", { where: { status: { not: "ACTIVE" } }, now });
    expect(tx.tenant.updateMany).toHaveBeenCalledWith({
      where: { status: { not: "ACTIVE" }, id: "t1" },
      data: { status: "ACTIVE", readOnlyReason: null },
    });
    expect(tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1" },
      data: { pastDueSince: null, pastDueInvoiceId: null, pausedAt: null },
    });
    expect(DUNNING_CLEAR).toEqual({ pastDueSince: null, pastDueInvoiceId: null, pausedAt: null });
    expect(out).toEqual({ count: 1, exit: null });
  });

  it("extra tenant columns ride the same statement (plan, planVersionId) and cannot override status", async () => {
    const tx = makeTx();
    await transitionToActiveTx(tx, "t1", { data: { plan: "SCALE", planVersionId: "v9" } as any });
    expect(tx.tenant.updateMany.mock.calls[0][0].data).toEqual({
      plan: "SCALE",
      planVersionId: "v9",
      status: "ACTIVE",
      readOnlyReason: null,
    });
  });

  it("a lost CAS (count 0) touches nothing else and owes Stripe nothing", async () => {
    const tx = makeTx({ count: 0 });
    const out = await transitionToActiveTx(tx, "t1");
    expect(out).toEqual({ count: 0, exit: null });
    expect(tx.tenantSubscription.findUnique).not.toHaveBeenCalled();
    expect(tx.tenantSubscription.updateMany).not.toHaveBeenCalled();
  });

  it("a row that WAS paused returns the Stripe unpause the caller runs after commit", async () => {
    const tx = makeTx({
      sub: { pausedAt: new Date("2026-11-08T08:00:00Z"), stripeSubId: "sub_1" },
    });
    const out = await transitionToActiveTx(tx, "t1", { now });
    expect(out.exit).toEqual({ tenantId: "t1", stripeSubId: "sub_1", exitAt: now });
    // the read happens BEFORE the clear
    const readOrder = tx.tenantSubscription.findUnique.mock.invocationCallOrder[0];
    const clearOrder = tx.tenantSubscription.updateMany.mock.invocationCallOrder[0];
    expect(readOrder).toBeLessThan(clearOrder);
  });

  it("clearDunningTx alone (extendTrial's TRIAL write) clears the columns and reports the exit", async () => {
    const tx = makeTx({
      sub: { pausedAt: new Date("2026-11-08T08:00:00Z"), stripeSubId: "sub_2" },
    });
    expect(await clearDunningTx(tx, "t2", now)).toEqual({
      tenantId: "t2",
      stripeSubId: "sub_2",
      exitAt: now,
    });
    const unpaused = makeTx({ sub: { pausedAt: null, stripeSubId: "sub_2" } });
    expect(await clearDunningTx(unpaused, "t2", now)).toBeNull();
    const noRow = makeTx({ sub: null });
    expect(await clearDunningTx(noRow, "t2", now)).toBeNull();
  });

  describe("dark neutrality: a where-less caller on an already-ACTIVE row must not wipe a live dunning clock", () => {
    // where-less callers (subscribe, admin activation) can hit a row that is ALREADY ACTIVE: the first CAS (status
    // != ACTIVE) misses, the second keeps the plan columns current.
    function activeTx() {
      const tx: any = {
        tenant: {
          updateMany: jest
            .fn()
            .mockResolvedValueOnce({ count: 0 }) // not leaving a non-ACTIVE state
            .mockResolvedValueOnce({ count: 1 }), // the row exists and is ACTIVE
        },
        tenantSubscription: {
          findUnique: jest.fn().mockResolvedValue({ pausedAt: null, stripeSubId: "sub_1" }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      return tx;
    }

    it("an already-ACTIVE row keeps its clock (subscribe on a tenant in dark): plan data is written, nothing is cleared", async () => {
      const tx = activeTx();
      const out = await transitionToActiveTx(tx, "t1", { data: { plan: "SCALE" } as any });
      expect(out).toEqual({ count: 1, exit: null });
      expect(tx.tenant.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: "t1", status: { not: "ACTIVE" } },
        data: { plan: "SCALE", status: "ACTIVE", readOnlyReason: null },
      });
      expect(tx.tenant.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: "t1", status: "ACTIVE" },
        data: { plan: "SCALE", readOnlyReason: null },
      });
      expect(tx.tenantSubscription.updateMany).not.toHaveBeenCalled(); // the clock survives
      expect(tx.tenantSubscription.findUnique).not.toHaveBeenCalled();
    });

    it("a row that really LEAVES a non-ACTIVE state clears the clock (first CAS wins)", async () => {
      const tx = makeTx({ sub: { pausedAt: null, stripeSubId: "sub_1" } });
      await transitionToActiveTx(tx, "t1", { data: { plan: "SCALE" } as any });
      expect(tx.tenant.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
        where: { tenantId: "t1" },
        data: { pastDueSince: null, pastDueInvoiceId: null, pausedAt: null },
      });
    });

    it("an explicit exit reason (clearDunning) clears even on an ACTIVE row: a manual-pay activation supersedes card dunning", async () => {
      const tx = activeTx();
      await transitionToActiveTx(tx, "t1", { clearDunning: true });
      expect(tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
        where: { tenantId: "t1" },
        data: { pastDueSince: null, pastDueInvoiceId: null, pausedAt: null },
      });
    });

    it("a caller that passes its own where keeps today's single-statement shape", async () => {
      const tx = makeTx();
      await transitionToActiveTx(tx, "t1", { where: { status: { not: "ACTIVE" } } });
      expect(tx.tenant.updateMany).toHaveBeenCalledTimes(1);
    });
  });
});
