// `@LeaderCron` wraps every cron tick in a Postgres advisory lock (common/cron-lock.ts).
// These specs invoke the tick directly and have no database, so the lock is a PASS-THROUGH here:
// it must still call the body — a mock that skipped it would make every assertion below measure
// a tick that never ran.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { SnapshotFailedError } from "./plan-transition-config.service";
import { Logger } from "@nestjs/common";
import { BillingCronService } from "./billing-cron.service";
import { BILLING_EVENTS, normalizePlanKey, planKeyFromEnum } from "./plan-catalog.constants";
import { fakeStripeSubscription } from "../testing/fake-stripe-subscription";

function make(
  data: {
    trials?: any[];
    graceSubs?: any[];
    downgrades?: any[];
    rollSubs?: any[];
    cancellations?: any[];
    cancelAddons?: any[];
    activeTeam?: number;
    /** ids the seat-free sweep selects for deactivation (default two users) */
    seatUsers?: string[];
    /** #2641: the Tenant row as re-read UNDER lockTenantForLedger (default: ACTIVE PRODUCTION). */
    lockedTenant?: { status?: string; class?: string; deletedAt?: Date | null };
    /** #2641: per-tenant overrides of the subscription row re-read under the lock. */
    lockedSubs?: Record<string, Record<string, unknown>>;
    /** SA-733 D8: per-tenant overrides of the row as re-read UNDER the tenant-price lock (after the scan). */
    rereadSubs?: Record<string, Record<string, unknown>>;
    /** SA-733r M7: the StripeService mock (default: not configured, no calls). */
    stripe?: any;
  } = {},
) {
  // #2641: the scanned row IS the committed row unless a test overrides it (a mid-sweep change).
  // A scanned row matched the scan's filter, so it is ARMED: default the schedule fields it implies.
  const past = new Date("2026-01-01T00:00:00.000Z");
  const scanned = new Map<string, any>([
    ...(data.downgrades ?? []).map((r: any): [string, any] => [
      r.tenantId,
      { downgradeEffectiveAt: past, ...r },
    ]),
    ...(data.cancellations ?? []).map((r: any): [string, any] => [
      r.tenantId,
      { cancelAtPeriodEnd: true, periodEnd: past, ...r },
    ]),
  ]);
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    tenantSubscription: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(async ({ where }: any) => {
        const row = scanned.get(where.tenantId);
        return row ? { ...row, ...(data.lockedSubs?.[where.tenantId] ?? {}) } : null;
      }),
    },
    tenant: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({
        status: "ACTIVE",
        class: "PRODUCTION",
        deletedAt: null,
        ...data.lockedTenant,
      }),
    },
    // Account-link revocation (common/revoke-user-link-tokens.ts) is raw SQL on the tx client.
    $executeRaw: jest.fn().mockResolvedValue(1),
    user: {
      // The seat-free sweep selects the ids it will deactivate BEFORE writing (to burn their
      // links in the same tx); `data.seatUsers` names them.
      findMany: jest
        .fn()
        .mockResolvedValue((data.seatUsers ?? ["u2", "u3"]).map((id: string) => ({ id }))),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      count: jest.fn().mockResolvedValue(data.activeTeam ?? 5),
    },
    // #2641: the cancellation sweep reads and deactivates add-ons on its locked tx.
    tenantAddon: {
      findMany: jest.fn().mockResolvedValue(data.cancelAddons ?? []),
      updateMany: jest.fn().mockResolvedValue({ count: data.cancelAddons?.length ?? 0 }),
    },
  };
  const prisma = {
    tenant: {
      findMany: jest.fn().mockResolvedValue(data.trials ?? []),
      update: jest.fn().mockResolvedValue({}),
    },
    tenantSubscription: {
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      // The revert's fresh read of the committed row (SA-733r M7).
      // Also the cron's re-read UNDER the tenant-price lock (SA-733 D8): the committed row, plus the tenant's
      // status. `data.rereadSubs` lets a test move a column between the scan and the lock.
      findUnique: jest.fn(async ({ where }: any) => {
        const row = scanned.get(where.tenantId);
        return row
          ? {
              ...row,
              ...(data.rereadSubs?.[where.tenantId] ?? {}),
              tenant: { status: "ACTIVE", deletedAt: null },
            }
          : null;
      }),
    },
    tenantAddon: {
      findMany: jest.fn().mockResolvedValue(data.cancelAddons ?? []),
      updateMany: jest.fn().mockResolvedValue({ count: data.cancelAddons?.length ?? 0 }),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  } as any;
  // route findMany call-sites by argument shape
  prisma.tenantSubscription.findMany.mockImplementation(({ where }: any) => {
    if (where.graceStartedAt) return Promise.resolve(data.graceSubs ?? []);
    // `tenant.plan` is part of the real select (the nullable-planKey fallback); default it here.
    if (where.downgradeEffectiveAt) {
      return Promise.resolve(
        (data.downgrades ?? []).map((d: any) => ({ tenant: { plan: "BUSINESS" }, ...d })),
      );
    }
    if (where.cancelAtPeriodEnd) return Promise.resolve(data.cancellations ?? []);
    return Promise.resolve(data.rollSubs ?? []);
  });
  const events = { emit: jest.fn().mockResolvedValue({}) } as any;
  const entitlements = { invalidate: jest.fn() } as any;
  const tenantStatus = { invalidate: jest.fn() } as any;
  const catalog = {
    getVersionForTenant: jest.fn().mockResolvedValue({
      definitions: [
        { planKey: "STARTER", name: "Starter", monthlyPrice: 59, seatsIncluded: 1 },
        { planKey: "BUSINESS", name: "Business", monthlyPrice: 349, seatsIncluded: 15 },
      ],
    }),
    // Finding 1 fallback path: a target plan missing from the tenant's PINNED version falls
    // back to the published catalog. Existing tests' targets (STARTER/BUSINESS) are always
    // found in the default getVersionForTenant definitions above, so this default is a no-op
    // for them — only the finding-1 tests below override it.
    getPublishedVersion: jest.fn().mockResolvedValue(null),
  } as any;
  // Defaults to "unlimited" so grace windows expire exactly as they did before the
  // CUSTOMERS soft-cap; the tests below narrow it where the cap matters.
  const meters = {
    read: jest.fn().mockResolvedValue({
      meter: "CUSTOMERS",
      used: 0,
      included: null,
      remaining: null,
      resetsAt: null,
    }),
  } as any;
  const billingNotification = {
    notifyTrialEnding: jest.fn().mockResolvedValue(undefined),
    notifyDowngradeApplied: jest.fn().mockResolvedValue(undefined),
  } as any;
  const planTransition = {
    isEnabled: jest.fn().mockResolvedValue(true),
    prepare: jest.fn().mockResolvedValue({ enabled: true, planAllows: null }),
    onPlanChange: jest.fn().mockResolvedValue({ action: "none" }),
    transactionOptions: jest.fn().mockReturnValue(undefined),
    invalidateCaches: jest.fn(),
  } as any;
  const stripe = data.stripe ?? ({ isConfigured: false } as any);
  const scheduledPrice = { applyDue: jest.fn().mockResolvedValue({ pushed: 0, held: 0 }) } as any;
  const svc = new BillingCronService(
    prisma,
    events,
    entitlements,
    tenantStatus,
    catalog,
    meters,
    billingNotification,
    planTransition,
    stripe,
    scheduledPrice,
  );
  return {
    planTransition,
    svc,
    prisma,
    tx,
    events,
    entitlements,
    tenantStatus,
    catalog,
    meters,
    billingNotification,
    stripe,
    scheduledPrice,
  };
}

const emitted = (events: any) => events.emit.mock.calls.map((c: any[]) => c[1]);
const deltaOf = (events: any, type: string) => {
  const c = events.emit.mock.calls.find((x: any[]) => x[1] === type);
  return c ? c[3]?.amountDelta : undefined;
};

describe("BillingCronService", () => {
  it("expireTrials flips expired trials to READ_ONLY (not SUSPENDED) + emits trial.expired", async () => {
    const { svc, prisma, events, tenantStatus } = make({ trials: [{ id: "t1" }] });
    await svc.expireTrials();
    expect(prisma.tenant.update.mock.calls[0][0].data).toMatchObject({
      status: "READ_ONLY",
      readOnlyReason: "trial_expired",
    });
    expect(emitted(events)).toContain(BILLING_EVENTS.TRIAL_EXPIRED);
    expect(tenantStatus.invalidate).toHaveBeenCalledWith("t1");
  });

  it("N3: expireTrials notifies TRIAL_ENDING_EXPIRY with the tenant's trialEndsAt", async () => {
    const trialEndsAt = new Date("2026-09-10T00:00:00.000Z");
    const { svc, billingNotification } = make({ trials: [{ id: "t1", trialEndsAt }] });
    await svc.expireTrials();
    expect(billingNotification.notifyTrialEnding).toHaveBeenCalledWith(
      "t1",
      "TRIAL_ENDING_EXPIRY",
      trialEndsAt,
    );
  });

  it("N3: a rejected notifyTrialEnding never blocks expireTrials for the REST of the batch", async () => {
    const { svc, prisma, billingNotification } = make({
      trials: [
        { id: "t1", trialEndsAt: new Date() },
        { id: "t2", trialEndsAt: new Date() },
      ],
    });
    billingNotification.notifyTrialEnding.mockRejectedValueOnce(new Error("email down"));
    await svc.expireTrials();
    expect(prisma.tenant.update).toHaveBeenCalledTimes(2); // both tenants still transitioned
    expect(billingNotification.notifyTrialEnding).toHaveBeenCalledTimes(2); // t2 still attempted
  });

  describe("N3: warnTrialsEnding", () => {
    it("notifies TRIAL_ENDING_7D for a tenant whose trial ends in the 6-7 day window", async () => {
      const now = Date.now();
      const trialEndsAt = new Date(now + 6.5 * 24 * 60 * 60 * 1000);
      const { svc, prisma, billingNotification } = make();
      prisma.tenant.findMany.mockResolvedValueOnce([{ id: "t1", trialEndsAt }]); // 7d window
      prisma.tenant.findMany.mockResolvedValueOnce([]); // 1d window
      await svc.warnTrialsEnding();
      expect(billingNotification.notifyTrialEnding).toHaveBeenCalledWith(
        "t1",
        "TRIAL_ENDING_7D",
        trialEndsAt,
      );
    });

    it("notifies TRIAL_ENDING_1D for a tenant whose trial ends within 24 hours", async () => {
      const now = Date.now();
      const trialEndsAt = new Date(now + 12 * 60 * 60 * 1000);
      const { svc, prisma, billingNotification } = make();
      prisma.tenant.findMany.mockResolvedValueOnce([]); // 7d window
      prisma.tenant.findMany.mockResolvedValueOnce([{ id: "t1", trialEndsAt }]); // 1d window
      await svc.warnTrialsEnding();
      expect(billingNotification.notifyTrialEnding).toHaveBeenCalledWith(
        "t1",
        "TRIAL_ENDING_1D",
        trialEndsAt,
      );
    });

    it("a tenant outside both windows (e.g. trial ends in 3 days) gets neither reminder", async () => {
      const { svc, prisma, billingNotification } = make();
      prisma.tenant.findMany.mockResolvedValueOnce([]);
      prisma.tenant.findMany.mockResolvedValueOnce([]);
      await svc.warnTrialsEnding();
      expect(billingNotification.notifyTrialEnding).not.toHaveBeenCalled();
    });
  });

  it("expireGrace clears grace windows older than 7 days", async () => {
    const { svc, prisma, events } = make({ graceSubs: [{ tenantId: "t1" }] });
    await svc.expireGrace();
    expect(prisma.tenantSubscription.update.mock.calls[0][0].data).toEqual({
      graceStartedAt: null,
      graceMeter: null,
    });
    expect(emitted(events)).toContain(BILLING_EVENTS.GRACE_EXPIRED);
  });

  it("expireGrace keeps an expired CUSTOMERS window in place while the tenant is still over cap", async () => {
    const { svc, prisma, events, meters } = make({
      graceSubs: [{ tenantId: "t1", graceMeter: "CUSTOMERS" }],
    });
    meters.read.mockResolvedValue({
      meter: "CUSTOMERS",
      used: 101,
      included: 100,
      remaining: 0,
      resetsAt: null,
    });

    await svc.expireGrace();

    // Clearing it would read as "no grace window was ever opened" to the customer-create
    // gate, which would open a fresh one on the next create — the cap could never engage.
    expect(prisma.tenantSubscription.update).not.toHaveBeenCalled();
    expect(emitted(events)).not.toContain(BILLING_EVENTS.GRACE_EXPIRED);
  });

  it("expireGrace clears a CUSTOMERS window once the tenant is back within cap", async () => {
    const { svc, prisma, events, meters } = make({
      graceSubs: [{ tenantId: "t1", graceMeter: "CUSTOMERS" }],
    });
    meters.read.mockResolvedValue({
      meter: "CUSTOMERS",
      used: 90,
      included: 100,
      remaining: 10,
      resetsAt: null,
    });

    await svc.expireGrace();

    expect(prisma.tenantSubscription.update.mock.calls[0][0].data).toEqual({
      graceStartedAt: null,
      graceMeter: null,
    });
    expect(emitted(events)).toContain(BILLING_EVENTS.GRACE_EXPIRED);
  });

  // #2223 / SA-444c: a scheduled downgrade moves the PLAN, never a negotiated fee — the snapshot stays
  // the override, Δ0, priceOverrideMonthly untouched. A catalog row keeps today's catalog delta.
  it("SA-444c: a due downgrade of an override row keeps the fee — snapshot = fee, Δ0, plan moves", async () => {
    const { svc, tx, events } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          downgradeEffectiveAt: new Date(Date.now() - 86400000),
          retainedUserIds: [],
          priceOverrideMonthly: 150,
          // #2460: a consistent override row — its snapshot is the fee it pays (SA-444a), so the
          // ledger (new − stored snapshot, SA-464 (2)) books Δ0.
          basePriceSnapshot: 150,
        },
      ],
    });
    await svc.applyScheduledDowngrades();
    const data = tx.tenantSubscription.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ planKey: "STARTER", basePriceSnapshot: 150 });
    expect(data).not.toHaveProperty("priceOverrideMonthly");
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(0);
  });

  // SA-464b: the same override row with a NULL snapshot (not yet counted) — the downgrade writes the fee
  // and books it in full, so snapshot MRR and ledger MRR re-agree.
  it("SA-464b: a due downgrade of an override row with a NULL snapshot writes the fee and books +fee", async () => {
    const { svc, tx, events } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          downgradeEffectiveAt: new Date(Date.now() - 86400000),
          retainedUserIds: [],
          priceOverrideMonthly: 150,
          basePriceSnapshot: null,
        },
      ],
    });
    await svc.applyScheduledDowngrades();
    expect(tx.tenantSubscription.update.mock.calls[0][0].data).toMatchObject({
      planKey: "STARTER",
      basePriceSnapshot: 150,
    });
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(150);
  });

  it("SA-444c: the downgrade query selects the override it keeps", async () => {
    const { svc, prisma } = make({ downgrades: [] });
    await svc.applyScheduledDowngrades();
    expect(prisma.tenantSubscription.findMany.mock.calls[0][0].select).toMatchObject({
      priceOverrideMonthly: true,
    });
  });

  // #2460 / SA-464 (2): the downgrade's ledger nets against the STORED snapshot (NULL ⇒ 0), never
  // the pinned catalog price of the plan being left, so snapshot MRR and ledger MRR stay equal.
  it("#2460: a downgrade of a NULL-snapshot row books the new price in full (never 59 − 349)", async () => {
    const { svc, events } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: [],
          basePriceSnapshot: null,
        },
      ],
    });
    await svc.applyScheduledDowngrades();
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(59);
  });

  it("#2460: the downgrade query selects the stored snapshot it nets against", async () => {
    const { svc, prisma } = make({ downgrades: [] });
    await svc.applyScheduledDowngrades();
    expect(prisma.tenantSubscription.findMany.mock.calls[0][0].select).toMatchObject({
      basePriceSnapshot: true,
    });
  });

  it("A2b: a scheduled downgrade snapshots via the hook INSIDE its transaction, before the plan write", async () => {
    const { svc, tx, planTransition } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: [],
        },
      ],
    });
    const order: string[] = [];
    planTransition.onPlanChange.mockImplementation(async () => {
      order.push("onPlanChange");
      return { action: "snapshot", snapshotId: "s1" };
    });
    tx.tenantSubscription.update.mockImplementation(async () => {
      order.push("plan-write");
      return {};
    });

    await svc.applyScheduledDowngrades();

    expect(order).toEqual(["onPlanChange", "plan-write"]);
    const [txArg, transition] = planTransition.onPlanChange.mock.calls[0];
    expect(txArg).toBe(tx);
    expect(transition).toMatchObject({
      tenantId: "t1",
      fromPlanKey: normalizePlanKey("BUSINESS"), // the stored key, normalised (BUSINESS -> SCALE)
      toPlanKey: "STARTER",
      actor: { id: null },
    });
  });

  // #2551 / SA-503a: the downgrade takes the Tenant row lock right after the hook and BEFORE its
  // subscription write — the house order every other ledger writer uses (no 40P01 vs reconcile).
  it("#2551: hook → Tenant lock → subscription write", async () => {
    const { svc, tx, planTransition } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: [],
        },
      ],
    });
    const order: string[] = [];
    planTransition.onPlanChange.mockImplementation(async () => {
      order.push("onPlanChange");
      return { action: "none" };
    });
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      if (/FROM "Tenant" WHERE id = \? FOR UPDATE/.test(Array.from(strings).join("?")))
        order.push("tenant-lock");
      return [];
    });
    tx.tenantSubscription.update.mockImplementation(async () => {
      order.push("plan-write");
      return {};
    });

    await svc.applyScheduledDowngrades();

    expect(order).toEqual(["onPlanChange", "tenant-lock", "plan-write"]);
  });

  it("flag OFF: the sweep issues exactly its old query (no tenant.plan join) and never touches the hook", async () => {
    const { svc, prisma, planTransition } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: [],
        },
      ],
    });
    planTransition.isEnabled.mockResolvedValue(false);

    await svc.applyScheduledDowngrades();

    const call = prisma.tenantSubscription.findMany.mock.calls.find(
      (c: any[]) => c[0].where.downgradeEffectiveAt,
    )!;
    expect(call[0].select).not.toHaveProperty("tenant");
    expect(planTransition.prepare).not.toHaveBeenCalled();
    expect(planTransition.onPlanChange).not.toHaveBeenCalled();
  });

  it("flag ON: the tenant.plan join is present", async () => {
    const { svc, prisma } = make({ downgrades: [] });

    await svc.applyScheduledDowngrades();

    const call = prisma.tenantSubscription.findMany.mock.calls.find(
      (c: any[]) => c[0].where.downgradeEffectiveAt,
    )!;
    expect(call[0].select.tenant).toEqual({ select: { plan: true } });
  });

  it("A2b: a NULL stored planKey resolves the plan being left from tenant.plan, never skips the snapshot", async () => {
    const { svc, planTransition } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: null,
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: [],
          tenant: { plan: "BUSINESS" },
        },
      ],
    });

    await svc.applyScheduledDowngrades();

    const [, transition] = planTransition.onPlanChange.mock.calls[0];
    expect(transition.fromPlanKey).toBe(planKeyFromEnum("BUSINESS"));
  });

  it("A2b: a snapshot failure fails THAT tenant closed (no plan write, no event) but the sweep carries on to the next tenant", async () => {
    const { svc, tx, planTransition, events } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: [],
        },
        {
          tenantId: "t2",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: [],
        },
      ],
    });
    planTransition.onPlanChange
      .mockRejectedValueOnce(new SnapshotFailedError("t1", new Error("disk full")))
      .mockResolvedValue({ action: "none" });

    await expect(svc.applyScheduledDowngrades()).resolves.not.toThrow();

    // t1 wrote nothing (fail closed, schedule stays armed for the next tick) ...
    expect(planTransition.onPlanChange).toHaveBeenCalledTimes(2);
    // ... and t2, later in the same sweep, was NOT stranded.
    expect(tx.tenantSubscription.update).toHaveBeenCalledTimes(1);
    expect(emitted(events).filter((e: string) => e === BILLING_EVENTS.PLAN_CHANGED)).toHaveLength(
      1,
    );
  });

  it("A2b: three snapshot failures in a row are systemic — the sweep aborts as a real cron failure", async () => {
    const row = (tenantId: string) => ({
      tenantId,
      planKey: "BUSINESS",
      planVersionId: "v7",
      downgradeToPlanKey: "STARTER",
      retainedUserIds: [],
    });
    const { svc, planTransition, tx } = make({
      downgrades: [row("t1"), row("t2"), row("t3"), row("t4")],
    });
    planTransition.onPlanChange.mockImplementation(
      async (_tx: unknown, t: { tenantId: string }) => {
        throw new SnapshotFailedError(t.tenantId, new Error("pool timeout"));
      },
    );

    await expect(svc.applyScheduledDowngrades()).rejects.toBeInstanceOf(SnapshotFailedError);

    expect(planTransition.onPlanChange).toHaveBeenCalledTimes(3); // t4 never attempted
    expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
  });

  it("A2b: any OTHER hook failure still rethrows (pool exhaustion etc. is a real cron failure)", async () => {
    const { svc, tx, planTransition } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: [],
        },
      ],
    });
    planTransition.onPlanChange.mockRejectedValueOnce(new Error("pool exhausted"));
    await expect(svc.applyScheduledDowngrades()).rejects.toThrow("pool exhausted");
    expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
  });

  it("A2b: a downgrade that applied invalidates the hook's caches, and a held-back one does not", async () => {
    const row = (tenantId: string) => ({
      tenantId,
      planKey: "BUSINESS",
      planVersionId: "v7",
      downgradeToPlanKey: "STARTER",
      retainedUserIds: [],
    });
    const { svc, planTransition } = make({ downgrades: [row("t1"), row("t2")] });
    planTransition.onPlanChange
      .mockRejectedValueOnce(new SnapshotFailedError("t1", new Error("disk full")))
      .mockResolvedValue({ action: "none" });

    await svc.applyScheduledDowngrades();

    expect(planTransition.invalidateCaches).toHaveBeenCalledTimes(1);
    expect(planTransition.invalidateCaches).toHaveBeenCalledWith("t2", {
      enabled: true,
      planAllows: null,
    });
  });

  it("A2b: the per-tenant transaction gets the hook's timeout options", async () => {
    const { svc, prisma, planTransition } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: [],
        },
      ],
    });
    const opts = { timeout: 20_000, maxWait: 10_000 };
    planTransition.transactionOptions.mockReturnValue(opts);
    await svc.applyScheduledDowngrades();
    expect(planTransition.transactionOptions).toHaveBeenCalledWith({
      enabled: true,
      planAllows: null,
    });
    expect(prisma.$transaction.mock.calls.at(-1)[1]).toBe(opts);
  });

  it("applyScheduledDowngrades switches plan, frees non-retained seats, emits events", async () => {
    const { svc, tx, events, entitlements } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: ["u1"],
          basePriceSnapshot: 349, // #2460: a consistent row carries its snapshot (the ledger nets against it, SA-464).
        },
      ],
      activeTeam: 5, // over the STARTER cap of 1
    });
    await svc.applyScheduledDowngrades();
    expect(tx.tenantSubscription.update.mock.calls[0][0].data).toMatchObject({
      planKey: "STARTER",
      basePriceSnapshot: 59, // re-snapshot the new price
      downgradeToPlanKey: null,
      downgradeEffectiveAt: null,
    });
    // MRR delta priced off the PINNED version (59 − 349).
    const planChanged = events.emit.mock.calls.find(
      (c: any[]) => c[1] === BILLING_EVENTS.PLAN_CHANGED,
    );
    expect(planChanged[3].amountDelta).toBe(-290);
    // Over the seat cap → deactivate active team users NOT on the retained list.
    expect(tx.user.updateMany.mock.calls[0][0].where).toMatchObject({
      status: "ACTIVE",
      id: { notIn: ["u1"] },
    });
    expect(emitted(events)).toEqual(
      expect.arrayContaining([BILLING_EVENTS.SEAT_FREED, BILLING_EVENTS.PLAN_CHANGED]),
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
  });

  // Lead ruling R1 (option B): a downgrade's price reaches Stripe BEFORE the renewal (scheduled-price-change.ts), so this 02:00 sweep NEVER pushes a price. It
  // flips the local row (from the row re-read UNDER the tenant-price lock) and only VERIFIES Stripe read-only.
  describe("applyScheduledDowngrades - never pushes to Stripe (lead R1)", () => {
    const item = (cents: number) => ({
      id: "si_base",
      quantity: 1,
      price: {
        unit_amount: cents,
        currency: "usd",
        recurring: { interval: "month" },
        product: "prod_business",
      },
    });
    const row = (tenantId: string, over: Record<string, unknown> = {}) => ({
      tenantId,
      planKey: "BUSINESS",
      planVersionId: "v7",
      downgradeToPlanKey: "STARTER",
      retainedUserIds: [],
      basePriceSnapshot: 349,
      stripeSubId: "sub_1",
      priceOverrideMonthly: null,
      priceOverrideAnnual: null,
      ...over,
    });
    const withVersionId = (catalog: any) =>
      catalog.getVersionForTenant.mockResolvedValue({
        id: "v7",
        definitions: [
          { planKey: "STARTER", name: "Starter", monthlyPrice: 59, seatsIncluded: 1 },
          { planKey: "BUSINESS", name: "Business", monthlyPrice: 349, seatsIncluded: 15 },
        ],
        addonSkus: [],
      });
    const alerts = (spy: jest.SpyInstance) =>
      spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("needs_reconcile"));

    it("applies the downgrade locally and sends Stripe NOTHING - no update, no product, no schedule", async () => {
      const stripe = fakeStripeSubscription([item(5900)]);
      const { svc, catalog, tx } = make({ downgrades: [row("t1")], stripe });
      withVersionId(catalog);
      await svc.applyScheduledDowngrades();

      expect(tx.tenantSubscription.update).toHaveBeenCalledTimes(1);
      expect(stripe.updateSubscription).not.toHaveBeenCalled();
      expect(stripe.client.products.create).not.toHaveBeenCalled();
    });

    it("read-only verification: Stripe already bills the downgraded price -> no alert", async () => {
      const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const stripe = fakeStripeSubscription([item(5900)]); // the pre-renewal push put it here
      const { svc, catalog } = make({ downgrades: [row("t1")], stripe });
      withVersionId(catalog);
      await svc.applyScheduledDowngrades();
      expect(stripe.getSubscription).toHaveBeenCalledTimes(1);
      expect(alerts(error)).toHaveLength(0);
      error.mockRestore();
    });

    it("N2 (L-167 one rule): a checkout-made add-on item no row owns yet is NOT mistaken for the base item -> no false alert", async () => {
      const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const checkoutAddon = {
        id: "si_checkout_addon",
        quantity: 1,
        price: {
          unit_amount: 2900,
          currency: "usd",
          recurring: { interval: "month" },
          product: { id: "prod_addon", metadata: { addonSku: "EXTRA_SEATS" } },
        },
      };
      // the add-on line comes FIRST: the old verify (owned rows only) took it for the base and alerted
      const stripe = fakeStripeSubscription([checkoutAddon, item(5900)]);
      const { svc, catalog } = make({ downgrades: [row("t1")], stripe });
      withVersionId(catalog);
      await svc.applyScheduledDowngrades();
      expect(alerts(error)).toHaveLength(0);
      // and it reads the subscription the way the push does (add-on products expanded)
      expect(stripe.getSubscription).toHaveBeenCalledWith("sub_1", {
        expand: ["items.data.price.product"],
      });
      error.mockRestore();
    });

    it("N2: a REAL mismatch is still alerted when a checkout add-on line is present", async () => {
      const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const checkoutAddon = {
        id: "si_checkout_addon",
        quantity: 1,
        price: {
          unit_amount: 2900,
          currency: "usd",
          recurring: { interval: "month" },
          product: { id: "prod_addon", metadata: { addonSku: "EXTRA_SEATS" } },
        },
      };
      const stripe = fakeStripeSubscription([checkoutAddon, item(34900)]);
      const { svc, catalog } = make({ downgrades: [row("t1")], stripe });
      withVersionId(catalog);
      await svc.applyScheduledDowngrades();
      const [alert] = alerts(error);
      expect(JSON.parse(alert.slice(alert.indexOf("{")))).toMatchObject({
        stripeState: { billedCents: 34900, expectedCents: 5900 },
      });
      error.mockRestore();
    });

    it("read-only verification: Stripe still bills the OLD price -> a needs-reconcile ALERT, still no push", async () => {
      const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const stripe = fakeStripeSubscription([item(34900)]);
      const { svc, catalog } = make({ downgrades: [row("t1")], stripe });
      withVersionId(catalog);
      await svc.applyScheduledDowngrades();

      const [alert] = alerts(error);
      expect(JSON.parse(alert.slice(alert.indexOf("{")))).toMatchObject({
        tenantId: "t1",
        stripeSubId: "sub_1",
        stripeState: { billedCents: 34900, expectedCents: 5900 },
      });
      expect(stripe.updateSubscription).not.toHaveBeenCalled();
      error.mockRestore();
    });

    it("B1: the fee verified and booked is the one read UNDER the lock, not the stale scanned one", async () => {
      const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const stripe = fakeStripeSubscription([item(18000)]);
      const fee = { priceOverrideMonthly: 180 };
      const { svc, catalog, tx, events } = make({
        downgrades: [row("t1")], // the scan saw NO override
        rereadSubs: { t1: fee }, // the committed row, read under the lock, has one
        lockedSubs: { t1: fee },
        stripe,
      });
      withVersionId(catalog);
      await svc.applyScheduledDowngrades();

      expect(tx.tenantSubscription.update.mock.calls[0][0].data.basePriceSnapshot).toBe(180);
      const planChanged = events.emit.mock.calls.find(
        (c: any[]) => c[1] === BILLING_EVENTS.PLAN_CHANGED,
      );
      expect(planChanged[3].amountDelta).toBe(-169); // 180 - the stored 349, not 59 - 349
      expect(alerts(error)).toHaveLength(0); // Stripe's 18000 IS the fee: verified against the fresh row
      error.mockRestore();
    });

    it("B1: a fee that moves between the under-lock read and the transaction is caught by the in-tx check: nothing is written", async () => {
      const { svc, catalog, tx } = make({
        downgrades: [row("t1")],
        lockedSubs: { t1: { priceOverrideMonthly: 180 } }, // committed after the re-read
      });
      withVersionId(catalog);
      await svc.applyScheduledDowngrades();
      expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
    });

    it("B1: a schedule disarmed between the scan and the lock is skipped before anything is read from Stripe", async () => {
      const stripe = fakeStripeSubscription([item(34900)]);
      const { svc, catalog, tx } = make({
        downgrades: [row("t1")],
        rereadSubs: { t1: { downgradeToPlanKey: null } },
        stripe,
      });
      withVersionId(catalog);
      await svc.applyScheduledDowngrades();
      expect(stripe.getSubscription).not.toHaveBeenCalled();
      expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
    });

    it("a tenant without a stripeSubId (manual-pay) is applied with no Stripe read at all", async () => {
      const stripe = fakeStripeSubscription([item(34900)]);
      const { svc, catalog, tx } = make({ downgrades: [row("t1", { stripeSubId: null })], stripe });
      withVersionId(catalog);
      await svc.applyScheduledDowngrades();
      expect(stripe.getSubscription).not.toHaveBeenCalled();
      expect(tx.tenantSubscription.update).toHaveBeenCalledTimes(1);
    });

    it("takes the tenant-price advisory lock per tenant (the family the upgrade and the price override take)", async () => {
      const { withAdvisoryLock } = jest.requireMock("../common/db-locks");
      withAdvisoryLock.mockClear();
      const { svc, catalog } = make({
        downgrades: [row("t1")],
        stripe: fakeStripeSubscription([item(5900)]),
      });
      withVersionId(catalog);
      await svc.applyScheduledDowngrades();
      expect(withAdvisoryLock).toHaveBeenCalledWith(
        { family: "tenant-price", key: "t1", mode: "wait", waitMs: 20_000 },
        expect.any(Function),
      );
    });

    it("an unreadable Stripe during verification is logged and never fails the sweep or the next tenant", async () => {
      const stripe = fakeStripeSubscription([item(5900)]);
      stripe.getSubscription.mockRejectedValueOnce(new Error("stripe down"));
      const { svc, catalog, tx } = make({
        downgrades: [row("t1"), row("t2", { stripeSubId: "sub_2" })],
        stripe,
      });
      withVersionId(catalog);
      await expect(svc.applyScheduledDowngrades()).resolves.not.toThrow();
      expect(tx.tenantSubscription.update).toHaveBeenCalledTimes(2); // both flipped
    });
  });

  it("R1 option B: the hourly backup sweep delegates to the ONE scheduled-price function and never touches Stripe itself", async () => {
    const stripe = fakeStripeSubscription([]);
    const { svc, scheduledPrice } = make({ stripe });
    scheduledPrice.applyDue.mockResolvedValue({ pushed: 2, held: 1 });
    await svc.pushUpcomingDowngradePrices();
    expect(scheduledPrice.applyDue).toHaveBeenCalledTimes(1);
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it("N3: applyScheduledDowngrades notifies with the effectiveAt the row carried BEFORE the transaction cleared it", async () => {
    const downgradeEffectiveAt = new Date("2026-09-01T00:00:00.000Z");
    const { svc, billingNotification } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          downgradeEffectiveAt,
          retainedUserIds: ["u1"],
        },
      ],
      activeTeam: 5,
    });
    await svc.applyScheduledDowngrades();
    expect(billingNotification.notifyDowngradeApplied).toHaveBeenCalledWith(
      "t1",
      "Business",
      "Starter",
      downgradeEffectiveAt,
    );
  });

  it("N3: a rejected notifyDowngradeApplied never blocks the sweep for the rest of the batch", async () => {
    const { svc, tx, billingNotification } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: [],
        },
        {
          tenantId: "t2",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: [],
        },
      ],
      activeTeam: 0,
    });
    billingNotification.notifyDowngradeApplied.mockRejectedValueOnce(new Error("email down"));
    await svc.applyScheduledDowngrades();
    expect(tx.tenantSubscription.update).toHaveBeenCalledTimes(2); // both applied regardless
    expect(billingNotification.notifyDowngradeApplied).toHaveBeenCalledTimes(2); // t2 still attempted
  });

  it("downgrade with an EMPTY retained list still frees seats when over cap (keeps only admins)", async () => {
    const { svc, tx } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: [],
        },
      ],
      activeTeam: 5,
    });
    await svc.applyScheduledDowngrades();
    // notIn [] matches all → deactivates every non-admin operator/driver.
    expect(tx.user.updateMany).toHaveBeenCalled();
    expect(tx.user.findMany.mock.calls[0][0].where.id).toEqual({ notIn: [] });
    expect(tx.user.updateMany.mock.calls[0][0].where.id).toMatchObject({ notIn: [] });
  });

  describe("seat-free bulk deactivation burns the freed users' account links", () => {
    const burnedIds = (tx: any) =>
      tx.$executeRaw.mock.calls
        .filter(([strings]: any[]) => strings.join("").includes('UPDATE "PasswordResetToken"'))
        .map((c: any[]) => c[1]);
    const downgrade = (over: Record<string, unknown> = {}) => ({
      tenantId: "t1",
      planKey: "BUSINESS",
      planVersionId: "v7",
      downgradeToPlanKey: "STARTER",
      retainedUserIds: ["u1"],
      ...over,
    });

    it("revokes exactly the users it deactivates, in the same tx and before the write", async () => {
      const { svc, tx } = make({
        downgrades: [downgrade()],
        activeTeam: 5,
        seatUsers: ["u2", "u3"],
      });

      await svc.applyScheduledDowngrades();

      expect(burnedIds(tx)).toEqual(["u2", "u3"]);
      // the write is keyed on the very ids that were burned (never a re-evaluated predicate)
      const write = tx.user.updateMany.mock.calls[0][0];
      expect(write.where.id).toMatchObject({ in: ["u2", "u3"], notIn: ["u1"] });
      expect(write.data).toEqual({ status: "INACTIVE" });
      // the selection uses the same predicate the old write used: never an admin, never retained
      const select = tx.user.findMany.mock.calls[0][0];
      expect(select.where).toMatchObject({
        tenantId: "t1",
        role: { in: ["OPERATOR", "DRIVER"] },
        status: "ACTIVE",
        deletedAt: null,
        id: { notIn: ["u1"] },
      });
      // ordering: every burn precedes the status write
      const lastBurn = Math.max(...tx.$executeRaw.mock.invocationCallOrder);
      expect(lastBurn).toBeLessThan(tx.user.updateMany.mock.invocationCallOrder[0]);
    });

    it("a failed burn fails the tenant's downgrade (nothing is deactivated)", async () => {
      const { svc, tx } = make({ downgrades: [downgrade()], activeTeam: 5, seatUsers: ["u2"] });
      tx.$executeRaw.mockRejectedValue(new Error("db down"));

      await svc.applyScheduledDowngrades().catch(() => undefined);

      expect(tx.user.updateMany).not.toHaveBeenCalled();
    });

    it("burns nothing and writes nothing when no user is eligible to be freed", async () => {
      const { svc, tx, events } = make({ downgrades: [downgrade()], activeTeam: 5, seatUsers: [] });

      await svc.applyScheduledDowngrades();

      expect(burnedIds(tx)).toEqual([]);
      expect(tx.user.updateMany).not.toHaveBeenCalled();
      expect(emitted(events)).not.toContain(BILLING_EVENTS.SEAT_FREED);
    });

    it("burns nothing when the tenant is within the new seat cap", async () => {
      const { svc, tx } = make({ downgrades: [downgrade()], activeTeam: 1 });

      await svc.applyScheduledDowngrades();

      expect(tx.user.findMany).not.toHaveBeenCalled();
      expect(burnedIds(tx)).toEqual([]);
    });
  });

  it("downgrade WITHIN the new seat cap frees nobody", async () => {
    const { svc, tx } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: [],
        },
      ],
      activeTeam: 1, // == STARTER cap
    });
    await svc.applyScheduledDowngrades();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it("applyScheduledDowngrades only selects ACTIVE, non-deleted tenants (round 3, finding 8)", async () => {
    const { svc, prisma } = make({ downgrades: [] });
    await svc.applyScheduledDowngrades();
    // Without this filter the sweep applies a schedule left on a tenant that has already
    // churned (SUSPENDED/CANCELLED — its −MRR delta booked), booking a SECOND PLAN_CHANGED
    // delta the Σ-amountDelta rollup never heals, and deactivating a deleted tenant's staff.
    // Same clause applyScheduledCancellations carries in this file.
    const where = prisma.tenantSubscription.findMany.mock.calls[0][0].where;
    expect(where.tenant).toEqual({ status: "ACTIVE", deletedAt: null });
  });

  // B218: planKeyToEnum() now THROWS for a `downgradeToPlanKey` outside PLAN_KEYS instead of
  // silently writing STARTER (e.g. stale/migrated data, or a catalog row retired after the
  // downgrade was scheduled). A cron sweep must not let tenant N's bad row stop tenant N+1's
  // otherwise-valid scheduled downgrade from applying.
  it("REG-B218 applyScheduledDowngrades skips-and-logs ONE bad row (off-catalog target) and still applies the rest", async () => {
    const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, tx, entitlements, tenantStatus } = make({
      downgrades: [
        {
          tenantId: "bad-1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "BOGUS", // not in PLAN_KEYS or LEGACY_PLAN_KEY_ALIASES
          retainedUserIds: [],
        },
        {
          tenantId: "good-1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: ["u1"],
        },
      ],
      activeTeam: 5,
    });

    await svc.applyScheduledDowngrades();

    // The bad row's write never reached the DB — planKeyToEnum() throws while building the
    // update's `data`, before tx.tenantSubscription.update is ever invoked for tenant
    // "bad-1" — but the sweep kept going: the good row right after it still applied in full.
    expect(tx.tenantSubscription.update).toHaveBeenCalledTimes(1);
    expect(tx.tenantSubscription.update.mock.calls[0][0]).toMatchObject({
      where: { tenantId: "good-1" },
      data: { planKey: "STARTER" },
    });
    expect(entitlements.invalidate).toHaveBeenCalledWith("good-1");
    expect(entitlements.invalidate).not.toHaveBeenCalledWith("bad-1");
    expect(tenantStatus.invalidate).not.toHaveBeenCalledWith("bad-1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("tenant=bad-1"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("BOGUS"));

    errorSpy.mockRestore();
  });

  // F2 (W1 review-fix round): the catch around applyScheduledDowngrades' per-tenant
  // $transaction was, pre-fix, broad enough to swallow EVERY error class — a pool
  // exhaustion, a Prisma error, any unrelated failure — and log it as if it were a bad
  // plan key, so the sweep reported success while masking a real infrastructure failure.
  // The B218 skip-and-continue behaviour above (an unresolvable plan key) must stay
  // exactly as it is; everything else must now propagate instead.
  it("REG-F2 applyScheduledDowngrades PROPAGATES a non-plan-key failure instead of logging it as a bad plan key", async () => {
    const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, tx } = make({
      downgrades: [
        {
          tenantId: "infra-1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER", // a perfectly valid plan key — NOT the failure here
          retainedUserIds: [],
        },
      ],
      activeTeam: 5,
    });
    // A Prisma-style failure (e.g. pool exhaustion, P2025) thrown from inside the
    // transaction — NOT planKeyToEnum()'s unresolvable-key Error.
    const dbError = Object.assign(new Error("Connection pool timeout"), { code: "P2024" });
    tx.tenantSubscription.update.mockRejectedValueOnce(dbError);

    await expect(svc.applyScheduledDowngrades()).rejects.toThrow("Connection pool timeout");

    // Must never be reported through the "Skipping ... " bad-plan-key path — that would
    // disguise a real infrastructure failure as a data problem.
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("Skipping"));

    errorSpy.mockRestore();
  });

  // Finding 1 (Lite-L2 review, money): an admin's downgrade to LITE is scheduled while the
  // tenant is still pinned to a pre-LITE catalog version. When the cron later applies it, the
  // OLD pinned version has no LITE row — pre-fix, findPlanDefinition() silently returned
  // undefined, planMonthly() fell back to 0, and the ledger booked a wildly wrong delta while
  // never re-pinning planVersionId, breaking later entitlement lookups too.
  it("REG-1 an ACTIVE tenant's downgrade to LITE re-pins planVersionId to the version that actually defines LITE and books the real delta", async () => {
    const { svc, tx, catalog, events } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "GROWTH",
          planVersionId: "v11",
          downgradeToPlanKey: "LITE",
          retainedUserIds: [],
          basePriceSnapshot: 249, // #2460: a consistent row carries its snapshot (the ledger nets against it, SA-464).
        },
      ],
    });
    catalog.getVersionForTenant.mockResolvedValue({
      id: "v11",
      definitions: [{ planKey: "GROWTH", monthlyPrice: 249, seatsIncluded: 10 }],
    });
    catalog.getPublishedVersion.mockResolvedValue({
      id: "v12",
      definitions: [
        { planKey: "GROWTH", monthlyPrice: 249, seatsIncluded: 10 },
        { planKey: "LITE", monthlyPrice: 99, seatsIncluded: 3 },
      ],
    });

    await svc.applyScheduledDowngrades();

    expect(tx.tenantSubscription.update.mock.calls[0][0].data).toMatchObject({
      planKey: "LITE",
      planVersionId: "v12",
      basePriceSnapshot: 99,
    });
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(-150); // 99 − 249
  });

  it("REG-1 a target plan missing from every resolvable catalog version is skipped-and-logged, not silently applied", async () => {
    const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, tx, catalog, entitlements } = make({
      downgrades: [
        {
          tenantId: "bad-1",
          planKey: "GROWTH",
          planVersionId: "v11",
          downgradeToPlanKey: "GHOST",
          retainedUserIds: [],
        },
        {
          tenantId: "good-1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: [],
        },
      ],
      activeTeam: 1,
    });
    catalog.getVersionForTenant.mockImplementation((versionId: string) =>
      Promise.resolve(
        versionId === "v11"
          ? {
              id: "v11",
              definitions: [{ planKey: "GROWTH", monthlyPrice: 249, seatsIncluded: 10 }],
            }
          : {
              id: "v7",
              definitions: [
                { planKey: "STARTER", monthlyPrice: 59, seatsIncluded: 1 },
                { planKey: "BUSINESS", monthlyPrice: 349, seatsIncluded: 15 },
              ],
            },
      ),
    );
    catalog.getPublishedVersion.mockResolvedValue({
      id: "v12",
      definitions: [{ planKey: "GROWTH", monthlyPrice: 249, seatsIncluded: 10 }],
    });

    await svc.applyScheduledDowngrades();

    expect(tx.tenantSubscription.update).toHaveBeenCalledTimes(1);
    expect(tx.tenantSubscription.update.mock.calls[0][0]).toMatchObject({
      where: { tenantId: "good-1" },
      data: { planKey: "STARTER" },
    });
    expect(entitlements.invalidate).not.toHaveBeenCalledWith("bad-1");
    expect(entitlements.invalidate).toHaveBeenCalledWith("good-1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("tenant=bad-1"));

    errorSpy.mockRestore();
  });

  it("applyScheduledCancellations flips cancelled+expired subs to READ_ONLY + emits a NEGATIVE churn delta", async () => {
    const { svc, tx, events, tenantStatus } = make({
      cancellations: [
        { tenantId: "t1", planKey: "BUSINESS", basePriceSnapshot: 349, discount: 10 },
      ],
    });
    await svc.applyScheduledCancellations();
    expect(tx.tenant.update.mock.calls[0][0].data).toMatchObject({
      status: "READ_ONLY",
      readOnlyReason: "subscription_cancelled",
    });
    expect(emitted(events)).toContain(BILLING_EVENTS.SUBSCRIPTION_CANCELED);
    // Ledger nets DOWN by the tenant's run-rate: base 349 − discount 10 = 339.
    expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_CANCELED)).toBe(-339);
    expect(tenantStatus.invalidate).toHaveBeenCalledWith("t1");
  });

  it("applyScheduledCancellations churn delta includes active add-ons + deactivates the add-on rows", async () => {
    const { svc, tx, events } = make({
      cancellations: [
        { tenantId: "t1", planKey: "BUSINESS", basePriceSnapshot: 349, discount: 10 },
      ],
      cancelAddons: [{ priceSnapshot: 12, quantity: 2 }],
    });
    await svc.applyScheduledCancellations();
    // −(349 + 12×2 − 10) = −363.
    expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_CANCELED)).toBe(-363);
    // Rows follow the ledger: the removed add-ons are deactivated so a later reactivation
    // re-adds their delta symmetrically (no ledger drift).
    expect(tx.tenantAddon.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", active: true },
      data: { active: false },
    });
  });

  it("rollCycles advances the billing period so meters bucket into the new cycle", async () => {
    const periodEnd = new Date("2026-06-01T00:00:00Z"); // in the past
    const { svc, prisma } = make({
      rollSubs: [{ tenantId: "t1", cycle: "MONTHLY", periodEnd, createdAt: periodEnd }],
    });
    await svc.rollCycles();
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect(data.periodStart).toEqual(periodEnd); // new period starts at the old end
    expect(data.periodEnd.getTime()).toBeGreaterThan(periodEnd.getTime()); // advanced ~1 month
  });

  // B329's anchor-ratchet half stayed UNFIXED (correction 2026-09-13 — see the
  // rollCycles() comment in billing-cron.service.ts): the previously-landed fix used
  // TenantSubscription.createdAt as the anchor day, but createdAt is not a safe billing
  // anchor — 7 call sites create that row, several unrelated to subscribing (e.g.
  // customers.service.ts's maybeStartCustomerGrace(), billing.service.ts's
  // ensureStripeCustomer()) — so a tenant whose row was minted by one of those would have
  // every future period computed from the wrong date. rollCycles() still re-derives the
  // clamp day from the already-clamped periodEnd on every tick and therefore still
  // ratchets an anchor day down after a short month clips it, exactly like master.
  // addMonthsUtc already supports the anchorDay parameter that would fix this (full
  // coverage in billing-math.spec.ts) — it just needs an immutable, never-clamped
  // anchorDay column on TenantSubscription to pass it, which does not exist yet.
  it.todo(
    "rollCycles preserves the tenant's original anchor day across repeated short-month clips, never ratcheting down — blocked on a persisted anchorDay column; no safe anchor source exists today (createdAt is not the billing anchor)",
  );

  it("rollCycles preserves the period's time-of-day instead of collapsing to midnight — B329 (2)", async () => {
    const periodEnd = new Date("2026-01-15T09:30:15.250Z");
    const { svc, prisma } = make({
      rollSubs: [{ tenantId: "t1", cycle: "MONTHLY", periodEnd, createdAt: periodEnd }],
    });
    await svc.rollCycles();
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect(data.periodEnd.toISOString()).toBe("2026-02-15T09:30:15.250Z");
  });

  it("rollCycles guard: a mid-month anchor at midnight rolls byte-identically (no clip, nothing to preserve) — B329 (4)", async () => {
    const periodEnd = new Date("2026-03-15T00:00:00.000Z");
    const { svc, prisma } = make({
      rollSubs: [{ tenantId: "t1", cycle: "MONTHLY", periodEnd, createdAt: periodEnd }],
    });
    await svc.rollCycles();
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect(data.periodEnd.toISOString()).toBe("2026-04-15T00:00:00.000Z");
  });

  // B863 / SA-277: rollCycles() selects no periodStart/externalPayment and always calls
  // addCycle(periodEnd, cycle) — a manually-activated external row whose `cycle` field is
  // mislabeled (or whose real billing period doesn't match the stored cycle enum) rolls by
  // the wrong span forever. An externally-paid row must instead roll by its OWN observed
  // period length (periodEnd - periodStart), not by the `cycle` column.
  it("REG-B863-ROLL 365-day external row rolls +365d (flips REG-ROLL-MANUAL-ANNUAL, SA-277)", async () => {
    const periodStart = new Date("2025-01-01T00:00:00.000Z");
    const periodEnd = new Date("2026-01-01T00:00:00.000Z");
    const { svc, prisma } = make({
      rollSubs: [
        {
          tenantId: "t-manual-annual",
          cycle: "MONTHLY",
          externalPayment: true,
          periodStart,
          periodEnd,
        },
      ],
    });
    await svc.rollCycles();

    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect(data.periodStart).toEqual(periodEnd);
    expect(data.periodEnd.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(prisma.tenantSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ periodStart: true, externalPayment: true }),
      }),
    );
  });

  it("REG-B863-ROLL 90-day external row rolls +90d", async () => {
    const periodStart = new Date("2025-10-03T00:00:00.000Z");
    const periodEnd = new Date("2026-01-01T00:00:00.000Z");
    const { svc, prisma } = make({
      rollSubs: [
        { tenantId: "t1", cycle: "MONTHLY", externalPayment: true, periodStart, periodEnd },
      ],
    });
    await svc.rollCycles();
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect(data.periodEnd.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("REG-B863-ROLL 180-day external row rolls +180d", async () => {
    const periodStart = new Date("2025-07-05T00:00:00.000Z");
    const periodEnd = new Date("2026-01-01T00:00:00.000Z");
    const { svc, prisma } = make({
      rollSubs: [
        { tenantId: "t1", cycle: "MONTHLY", externalPayment: true, periodStart, periodEnd },
      ],
    });
    await svc.rollCycles();
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect(data.periodEnd.toISOString()).toBe("2026-06-30T00:00:00.000Z");
  });

  // Pin: a Stripe/catalog-priced row (externalPayment: false) is still rolled by `addCycle`
  // off its `cycle` column — only externally-paid rows change under B863's fix.
  it("rollCycles still rolls a Stripe/catalog row (externalPayment: false) by addCycle +1 month", async () => {
    const periodEnd = new Date("2026-01-01T00:00:00.000Z");
    const periodStart = new Date("2025-10-03T00:00:00.000Z"); // 90d back
    const { svc, prisma } = make({
      rollSubs: [
        { tenantId: "t1", cycle: "MONTHLY", externalPayment: false, periodStart, periodEnd },
      ],
    });
    await svc.rollCycles();
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect(data.periodEnd.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  // Pin: an external row with no periodStart on record can't derive an observed period
  // length, so it falls back to the old addCycle(periodEnd, cycle) behavior.
  it("rollCycles falls back to addCycle for an external row with periodStart: null", async () => {
    const periodEnd = new Date("2026-01-01T00:00:00.000Z");
    const { svc, prisma } = make({
      rollSubs: [
        {
          tenantId: "t1",
          cycle: "MONTHLY",
          externalPayment: true,
          periodStart: null,
          periodEnd,
        },
      ],
    });
    await svc.rollCycles();
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect(data.periodEnd.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });
});

// #2641 (#2638 follow-up): both scheduled sweeps decide "paying" with the shared isPayingRow on
// the Tenant + subscription rows re-read UNDER lockTenantForLedger — never on the pre-tx scan, which
// a suspension, a disarmed schedule or a resumed cancellation can overtake before the lock.
describe("#2641 scheduled sweeps book on the paying predicate, re-read under the lock", () => {
  const downgrade = {
    tenantId: "t1",
    planKey: "BUSINESS",
    planVersionId: "v7",
    downgradeToPlanKey: "STARTER",
    downgradeEffectiveAt: new Date("2026-09-01T00:00:00.000Z"),
    retainedUserIds: ["u1"],
    basePriceSnapshot: 349,
  };
  const cancellation = {
    tenantId: "t1",
    planKey: "BUSINESS",
    cancelAtPeriodEnd: true,
    periodEnd: new Date("2026-09-01T00:00:00.000Z"),
    basePriceSnapshot: 349,
    discount: 10,
  };

  it("downgrade: the Tenant + subscription re-reads come AFTER the Tenant row lock, on the tx", async () => {
    const { svc, tx } = make({ downgrades: [downgrade] });
    await svc.applyScheduledDowngrades();
    const lockAt = tx.$queryRaw.mock.invocationCallOrder[0];
    expect(lockAt).toBeDefined();
    expect(tx.tenant.findUnique.mock.invocationCallOrder[0]).toBeGreaterThan(lockAt);
    expect(tx.tenantSubscription.findUnique.mock.invocationCallOrder[0]).toBeGreaterThan(lockAt);
    expect(tx.tenantSubscription.update.mock.invocationCallOrder[0]).toBeGreaterThan(
      tx.tenant.findUnique.mock.invocationCallOrder[0],
    );
  });

  it("downgrade: a tenant SUSPENDED between the scan and the lock is skipped — no write, no PLAN_CHANGED", async () => {
    const { svc, tx, events, entitlements } = make({
      downgrades: [downgrade],
      lockedTenant: { status: "SUSPENDED" },
    });
    await expect(svc.applyScheduledDowngrades()).resolves.toBeUndefined();
    expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
    expect(emitted(events)).not.toContain(BILLING_EVENTS.PLAN_CHANGED);
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  it("downgrade: a tenant soft-deleted between the scan and the lock is skipped", async () => {
    const { svc, tx, events } = make({
      downgrades: [downgrade],
      lockedTenant: { deletedAt: new Date() },
    });
    await svc.applyScheduledDowngrades();
    expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
    expect(emitted(events)).not.toContain(BILLING_EVENTS.PLAN_CHANGED);
  });

  it("downgrade: a schedule disarmed (or retargeted) before the lock is not applied", async () => {
    for (const lockedSub of [
      { downgradeToPlanKey: null, downgradeEffectiveAt: null },
      { downgradeToPlanKey: "BUSINESS" },
    ]) {
      const { svc, tx, events } = make({ downgrades: [downgrade], lockedSubs: { t1: lockedSub } });
      await svc.applyScheduledDowngrades();
      expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
      expect(emitted(events)).not.toContain(BILLING_EVENTS.PLAN_CHANGED);
    }
  });

  it("downgrade: one skipped tenant never stops the sweep — the next tenant still applies", async () => {
    const { svc, tx, events } = make({
      downgrades: [downgrade, { ...downgrade, tenantId: "t2" }],
    });
    tx.tenant.findUnique
      .mockResolvedValueOnce({ status: "SUSPENDED", class: "PRODUCTION", deletedAt: null })
      .mockResolvedValueOnce({ status: "ACTIVE", class: "PRODUCTION", deletedAt: null });
    await svc.applyScheduledDowngrades();
    expect(tx.tenantSubscription.update).toHaveBeenCalledTimes(1);
    expect(tx.tenantSubscription.update.mock.calls[0][0].where).toEqual({ tenantId: "t2" });
    expect(emitted(events).filter((t: string) => t === BILLING_EVENTS.PLAN_CHANGED)).toHaveLength(
      1,
    );
  });

  it("downgrade: Δ nets against the snapshot re-read UNDER the lock, not the scanned one", async () => {
    const { svc, events } = make({
      downgrades: [downgrade],
      lockedSubs: { t1: { basePriceSnapshot: 300 } },
    });
    await svc.applyScheduledDowngrades();
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(59 - 300);
  });

  it("downgrade: a TEST-class tenant is still downgraded but books Δ0 (never in the paying set)", async () => {
    const { svc, tx, events } = make({
      downgrades: [downgrade],
      lockedTenant: { class: "TEST" },
    });
    await svc.applyScheduledDowngrades();
    expect(tx.tenantSubscription.update).toHaveBeenCalledTimes(1);
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(0);
  });

  it("downgrade: a planKey-NULL (pre-plans-as-data) row enters the paying set at the new plan — books +newBase", async () => {
    const { svc, events } = make({
      downgrades: [{ ...downgrade, planKey: null, basePriceSnapshot: null }],
    });
    await svc.applyScheduledDowngrades();
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(59);
  });

  it("cancellation: runs in ONE transaction — Tenant row lock first, then the re-reads, then every write on the tx", async () => {
    const { svc, prisma, tx, events } = make({ cancellations: [cancellation] });
    await svc.applyScheduledCancellations();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const lockAt = tx.$queryRaw.mock.invocationCallOrder[0];
    expect(lockAt).toBeDefined();
    expect(tx.tenant.findUnique.mock.invocationCallOrder[0]).toBeGreaterThan(lockAt);
    expect(tx.tenantSubscription.findUnique.mock.invocationCallOrder[0]).toBeGreaterThan(lockAt);
    expect(tx.tenant.update).toHaveBeenCalledTimes(1);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(prisma.tenantAddon.updateMany).not.toHaveBeenCalled();
    const call = events.emit.mock.calls.find(
      (c: any[]) => c[1] === BILLING_EVENTS.SUBSCRIPTION_CANCELED,
    );
    expect(call[3].tx).toBe(tx);
  });

  it("cancellation: a tenant SUSPENDED between the scan and the lock books nothing and is not made READ_ONLY", async () => {
    const { svc, tx, events, tenantStatus } = make({
      cancellations: [cancellation],
      cancelAddons: [{ priceSnapshot: 12, quantity: 2 }],
      lockedTenant: { status: "SUSPENDED" },
    });
    await svc.applyScheduledCancellations();
    expect(tx.tenant.update).not.toHaveBeenCalled();
    expect(tx.tenantAddon.updateMany).not.toHaveBeenCalled();
    expect(emitted(events)).not.toContain(BILLING_EVENTS.SUBSCRIPTION_CANCELED);
    expect(tenantStatus.invalidate).not.toHaveBeenCalled();
  });

  it("cancellation: a cancellation RESUMED before the lock (cancelAtPeriodEnd cleared) is not applied", async () => {
    const { svc, tx, events } = make({
      cancellations: [cancellation],
      lockedSubs: { t1: { cancelAtPeriodEnd: false } },
    });
    await svc.applyScheduledCancellations();
    expect(tx.tenant.update).not.toHaveBeenCalled();
    expect(emitted(events)).not.toContain(BILLING_EVENTS.SUBSCRIPTION_CANCELED);
  });

  it("cancellation: a period extended past now before the lock is not applied", async () => {
    const { svc, tx, events } = make({
      cancellations: [cancellation],
      lockedSubs: { t1: { periodEnd: new Date(Date.now() + 86_400_000) } },
    });
    await svc.applyScheduledCancellations();
    expect(tx.tenant.update).not.toHaveBeenCalled();
    expect(emitted(events)).not.toContain(BILLING_EVENTS.SUBSCRIPTION_CANCELED);
  });

  it("cancellation: a TEST-class tenant still goes READ_ONLY but books Δ0", async () => {
    const { svc, tx, events } = make({
      cancellations: [cancellation],
      cancelAddons: [{ priceSnapshot: 12, quantity: 2 }],
      lockedTenant: { class: "TEST" },
    });
    await svc.applyScheduledCancellations();
    expect(tx.tenant.update.mock.calls[0][0].data).toMatchObject({ status: "READ_ONLY" });
    expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_CANCELED)).toBe(0);
  });

  it("cancellation: the churn Δ is priced from the rows re-read UNDER the lock", async () => {
    const { svc, events } = make({
      cancellations: [cancellation],
      lockedSubs: { t1: { basePriceSnapshot: 300, discount: 0 } },
    });
    await svc.applyScheduledCancellations();
    expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_CANCELED)).toBe(-300);
  });

  it("downgrade: an overtaken tenant never counts toward the snapshot-failure breaker", async () => {
    // Three overtaken rows (== MAX_CONSECUTIVE_SNAPSHOT_FAILURES) then one real snapshot failure:
    // the sweep must NOT abort — an overtaken skip is not a systemic fault.
    const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const rows = ["a", "b", "c", "d"].map((id) => ({ ...downgrade, tenantId: id }));
    const { svc, tx, planTransition } = make({ downgrades: rows });
    tx.tenant.findUnique
      .mockResolvedValueOnce({ status: "SUSPENDED", class: "PRODUCTION", deletedAt: null })
      .mockResolvedValueOnce({ status: "SUSPENDED", class: "PRODUCTION", deletedAt: null })
      .mockResolvedValueOnce({ status: "SUSPENDED", class: "PRODUCTION", deletedAt: null });
    planTransition.onPlanChange
      .mockResolvedValueOnce({ action: "none" })
      .mockResolvedValueOnce({ action: "none" })
      .mockResolvedValueOnce({ action: "none" })
      .mockRejectedValueOnce(new SnapshotFailedError("d", new Error("boom")));
    await expect(svc.applyScheduledDowngrades()).resolves.toBeUndefined();
    expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("cancellation: a tenant soft-deleted between the scan and the lock is not applied", async () => {
    const { svc, tx, events } = make({
      cancellations: [cancellation],
      lockedTenant: { deletedAt: new Date() },
    });
    await svc.applyScheduledCancellations();
    expect(tx.tenant.update).not.toHaveBeenCalled();
    expect(emitted(events)).not.toContain(BILLING_EVENTS.SUBSCRIPTION_CANCELED);
  });

  it("cancellation: caches are invalidated only AFTER the transaction commits", async () => {
    const { svc, prisma, entitlements, tenantStatus } = make({ cancellations: [cancellation] });
    let invalidatedInsideTx = false;
    prisma.$transaction.mockImplementationOnce(async (fn: any) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        tenant: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ status: "ACTIVE", class: "PRODUCTION", deletedAt: null }),
          update: jest.fn().mockResolvedValue({}),
        },
        tenantSubscription: { findUnique: jest.fn().mockResolvedValue(cancellation) },
        tenantAddon: {
          findMany: jest.fn().mockResolvedValue([]),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      };
      const out = await fn(tx);
      invalidatedInsideTx =
        entitlements.invalidate.mock.calls.length > 0 ||
        tenantStatus.invalidate.mock.calls.length > 0;
      return out;
    });
    await svc.applyScheduledCancellations();
    expect(invalidatedInsideTx).toBe(false);
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
    expect(tenantStatus.invalidate).toHaveBeenCalledWith("t1");
  });

  it("cancellation: a planKey-NULL row is outside the paying set — READ_ONLY with Δ0", async () => {
    const { svc, tx, events } = make({ cancellations: [{ ...cancellation, planKey: null }] });
    await svc.applyScheduledCancellations();
    expect(tx.tenant.update).toHaveBeenCalledTimes(1);
    expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_CANCELED)).toBe(0);
  });
});
