import {
  armNeedsReconcile,
  clearNeedsReconcile,
  markNeedsReconcile,
  NEEDS_RECONCILE_ARMED_KIND,
} from "./needs-reconcile";

/** A one-row in-memory TenantSubscription with a transaction that records the order of its statements. */
function make(initial = false) {
  const state = { needsReconcile: initial };
  const order: string[] = [];
  const audits: any[] = [];
  const tx: any = {
    $queryRaw: jest.fn(async () => {
      order.push("lock-tenant");
      return [];
    }),
    tenantSubscription: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        order.push(`update:${JSON.stringify(data)}`);
        if (where.needsReconcile !== undefined && state.needsReconcile !== where.needsReconcile)
          return { count: 0 };
        state.needsReconcile = data.needsReconcile;
        return { count: 1 };
      }),
    },
    auditLog: {
      create: jest.fn(async ({ data }: any) => {
        order.push("audit");
        audits.push(data);
        return {};
      }),
    },
  };
  const prisma: any = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
  const logger = { error: jest.fn(), warn: jest.fn() };
  return { state, order, audits, prisma, logger, deps: { prisma, logger } };
}

describe("needsReconcile (SA-733r M7 / r3 N4)", () => {
  it("arm: Tenant lock first, flag raised, ONE audit row carrying the idempotency key and the attempt nonce", async () => {
    const h = make();
    const armed = await armNeedsReconcile(h.deps, {
      tenantId: "t1",
      kind: "plan_change",
      key: "t1:plan-change:v2:n-1",
      nonce: "n-1",
      stripeSubId: "sub_1",
    });
    expect(armed).toEqual({ owned: true });
    expect(h.state.needsReconcile).toBe(true);
    expect(h.order).toEqual(["lock-tenant", 'update:{"needsReconcile":true}', "audit"]);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].meta).toMatchObject({
      kind: NEEDS_RECONCILE_ARMED_KIND,
      flow: "plan_change",
      idempotencyKey: "t1:plan-change:v2:n-1",
      attemptNonce: "n-1",
      stripeSubId: "sub_1",
      alreadyFlagged: false,
    });
  });

  it("arm on an already-flagged row does not own the flag (a later clear must leave it up)", async () => {
    const h = make(true);
    const armed = await armNeedsReconcile(h.deps, {
      tenantId: "t1",
      kind: "plan_change",
      key: "k",
    });
    expect(armed).toEqual({ owned: false });
    expect(h.audits[0].meta.alreadyFlagged).toBe(true);
    await clearNeedsReconcile(h.deps, "t1", armed);
    expect(h.state.needsReconcile).toBe(true);
  });

  it("clear: lowers a flag this attempt armed; a no-op without ownership or without a database", async () => {
    const h = make();
    const armed = await armNeedsReconcile(h.deps, {
      tenantId: "t1",
      kind: "plan_change",
      key: "k",
    });
    await clearNeedsReconcile(h.deps, "t1", armed);
    expect(h.state.needsReconcile).toBe(false);

    const none = make(true);
    await clearNeedsReconcile(none.deps, "t1", { owned: false });
    await clearNeedsReconcile(none.deps, "t1", undefined);
    await clearNeedsReconcile({ logger: none.logger }, "t1", { owned: true });
    expect(none.state.needsReconcile).toBe(true);
    expect(none.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("clear never throws: a failed clear leaves the flag up and warns", async () => {
    const h = make();
    h.prisma.$transaction.mockRejectedValueOnce(new Error("db down"));
    await expect(clearNeedsReconcile(h.deps, "t1", { owned: true })).resolves.toBeUndefined();
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("the flag stays up"));
  });

  it("arm rejects when the flag cannot be written (the caller must then NOT call Stripe)", async () => {
    const h = make();
    h.prisma.$transaction.mockRejectedValueOnce(new Error("db down"));
    await expect(
      armNeedsReconcile(h.deps, { tenantId: "t1", kind: "plan_change", key: "k" }),
    ).rejects.toThrow("db down");
  });

  it("mark: keeps the ERROR alert (same event name) AND raises the flag; log-only without a database", async () => {
    const h = make();
    await markNeedsReconcile(h.deps, {
      tenantId: "t1",
      stripeSubId: "sub_1",
      key: "k",
      error: "boom",
    });
    expect(h.state.needsReconcile).toBe(true);
    const line = h.logger.error.mock.calls[0][0] as string;
    expect(line).toContain("billing.plan_change.needs_reconcile");
    expect(line).toContain('"idempotencyKey":"k"');

    const logOnly = make();
    await markNeedsReconcile({ logger: logOnly.logger }, { tenantId: "t1" });
    expect(logOnly.logger.error).toHaveBeenCalledTimes(1);
    expect(logOnly.state.needsReconcile).toBe(false);
  });

  it("mark never throws when the flag cannot be written (the alert is the record)", async () => {
    const h = make();
    h.prisma.$transaction.mockRejectedValueOnce(new Error("db down"));
    await expect(markNeedsReconcile(h.deps, { tenantId: "t1" })).resolves.toBeUndefined();
    expect(h.logger.error).toHaveBeenCalledTimes(2);
  });
});
