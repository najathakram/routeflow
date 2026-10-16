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
import { RfInvoiceIssuerService } from "./rf-invoice/rf-invoice-issuer.service";

function make(
  data: {
    trials?: any[];
    graceSubs?: any[];
    downgrades?: any[];
    rollSubs?: any[];
    cancellations?: any[];
    cancelAddons?: any[];
    activeTeam?: number;
    /** #2641: the Tenant row as re-read UNDER lockTenantForLedger (default: ACTIVE PRODUCTION). */
    lockedTenant?: { status?: string; class?: string; deletedAt?: Date | null };
    /** #2641: per-tenant overrides of the subscription row re-read under the lock. */
    lockedSubs?: Record<string, Record<string, unknown>>;
    /** SA-733 D8: per-tenant overrides of the row as re-read UNDER the tenant-price lock (after the scan). */
    rereadSubs?: Record<string, Record<string, unknown>>;
    /** SA-733r M7: the StripeService mock (default: not configured, no calls). */
    stripe?: any;
    /** SA-786: the TenantAddon rows the downgrade transaction reads (the add-ons the old plan may include). */
    heldAddons?: any[];
    /** SA-786: the SubscriptionMutationService stand-in that bills a leaving add-on after commit. */
    mutations?: any;
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
      // markNeedsReconcile's flag write (SA-786: a failed post-commit bill flags the tenant).
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
      // emitAddonDelta's paying-set read, after the plan write (SA-786).
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        status: "ACTIVE",
        class: "PRODUCTION",
        deletedAt: null,
        ...data.lockedTenant,
        subscription: { planKey: "GROWTH", couponFull: false },
      }),
    },
    user: {
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      count: jest.fn().mockResolvedValue(data.activeTeam ?? 5),
    },
    // #2641: the cancellation sweep reads and deactivates add-ons on its locked tx. SA-786: the downgrade
    // transaction reads the held rows (its `where` carries no `isComp`, the sweep's billable read does).
    tenantAddon: {
      findMany: jest.fn(async ({ where }: any = {}) =>
        where?.isComp === false && !where?.id
          ? (data.cancelAddons ?? [])
          : (data.heldAddons ?? data.cancelAddons ?? []),
      ),
      updateMany: jest.fn(async ({ where }: any = {}) => ({
        count: where?.id ? 1 : (data.cancelAddons?.length ?? 0),
      })),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    tenant: {
      findMany: jest.fn().mockResolvedValue(data.trials ?? []),
      update: jest.fn().mockResolvedValue({}),
      // SA-775: expireTrials locks through a compare-and-swap on status TRIAL.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    tenantSubscription: {
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      // F1b: the compare-and-set that clears a stale local cancel flag.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
  // SA-786: the 12th argument is the mutation service that bills a leaving add-on (a cast keeps this builder
  // compiling against a service that does not take it yet).
  const svc = new (BillingCronService as unknown as new (...a: unknown[]) => BillingCronService)(
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
    undefined,
    data.mutations,
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
    const { svc, prisma, events, tenantStatus } = make({
      trials: [{ id: "t1", class: "PRODUCTION" }],
    });
    await svc.expireTrials();
    // SA-775 S3: the class the gate judged is part of the CAS (a reclassification since the scan cannot lock)
    expect(prisma.tenant.updateMany.mock.calls[0][0].where).toEqual({
      id: "t1",
      status: "TRIAL",
      class: "PRODUCTION",
    });
    expect(prisma.tenant.updateMany.mock.calls[0][0].data).toMatchObject({
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
    expect(prisma.tenant.updateMany).toHaveBeenCalledTimes(2); // both tenants still transitioned
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

  // SA-786 S3 / R6-R8: a scheduled downgrade BELOW the plan that includes an add-on starts to bill it at the TARGET
  // version's catalog price (owner ruling 2026-10-15, Q-B). The row stays on; MANUAL books it in the flip's own
  // transaction, STRIPE creates one item AFTER commit, UNBILLED stays at $0.
  describe("applyScheduledDowngrades - an add-on the old plan included starts to bill (SA-786 R6-R8)", () => {
    const EFFECTIVE = new Date("2026-10-11T00:00:00.000Z");
    const regulated = (over: Record<string, unknown> = {}) => ({
      id: "ta_reg",
      tenantId: "t1",
      addonKey: "REGULATED_ITEMS",
      sku: "REGULATED_ITEMS",
      quantity: 1,
      priceSnapshot: 0,
      stripeItemId: null,
      isComp: false,
      active: true,
      ...over,
    });
    const row = (over: Record<string, unknown> = {}) => ({
      tenantId: "t1",
      planKey: "SCALE",
      planVersionId: "v7",
      downgradeToPlanKey: "GROWTH",
      downgradeEffectiveAt: EFFECTIVE,
      retainedUserIds: [],
      basePriceSnapshot: 499,
      stripeSubId: null,
      externalPayment: true,
      couponFull: false,
      priceOverrideMonthly: null,
      priceOverrideAnnual: null,
      ...over,
    });
    const versionWithRegulated = (catalog: any) =>
      catalog.getVersionForTenant.mockResolvedValue({
        id: "v7",
        definitions: [
          { planKey: "GROWTH", name: "Growth", monthlyPrice: 249, seatsIncluded: 5 },
          { planKey: "SCALE", name: "Scale", monthlyPrice: 499, seatsIncluded: 15 },
        ],
        addonSkus: [
          {
            sku: "REGULATED_ITEMS",
            name: "Regulated items",
            monthlyPrice: 39,
            includedAtPlan: "SCALE",
          },
        ],
      });
    const baseItem = (cents: number) => ({
      id: "si_base",
      quantity: 1,
      price: {
        unit_amount: cents,
        currency: "usd",
        recurring: { interval: "month" },
        product: "p",
      },
    });

    it("R6 MANUAL: the $0 included row is priced at 39 inside the flip, +39 booked once, one DUE notice (kind add); the plan flip is unchanged", async () => {
      const { svc, tx, events, catalog } = make({
        downgrades: [row()],
        heldAddons: [regulated()],
      });
      versionWithRegulated(catalog);
      await svc.applyScheduledDowngrades();

      expect(tx.tenantAddon.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "ta_reg", isComp: false, stripeItemId: null }),
          data: { priceSnapshot: 39 },
        }),
      );
      const added = events.emit.mock.calls.filter(
        (c: any[]) => c[1] === BILLING_EVENTS.ADDON_ENABLED,
      );
      expect(added).toHaveLength(1);
      expect(added[0][3].amountDelta).toBe(39);
      expect(added[0][2]).toMatchObject({ sku: "REGULATED_ITEMS", reprice: "left_inclusion" });
      const notices = tx.auditLog.create.mock.calls.map((c: any[]) => c[0].data);
      expect(notices).toHaveLength(1);
      expect(notices[0].action).toBe("ADDON_MANUAL_INVOICE_DUE");
      expect(notices[0].meta).toMatchObject({
        kind: "add",
        sku: "REGULATED_ITEMS",
        monthlyPrice: 39,
      });
      expect(notices[0].meta.message).toBe(
        "Add-on Regulated items is no longer included in Growth for t1: invoice it at $39.00 a month from October 11, 2026",
      );
      expect(tx.tenantSubscription.update.mock.calls[0][0].data).toMatchObject({
        planKey: "GROWTH",
      });
    });

    it("R7 STRIPE: nothing is written locally; ONE bill call AFTER commit, plan_change + always_invoice pinned to the new period start", async () => {
      const mutations = { billAddonsLeavingInclusion: jest.fn() };
      const stripe = fakeStripeSubscription([baseItem(24900)]);
      const { svc, tx, prisma, catalog } = make({
        downgrades: [row({ stripeSubId: "sub_1", externalPayment: false })],
        heldAddons: [regulated()],
        stripe,
        mutations,
      });
      versionWithRegulated(catalog);
      let committed = false;
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const out = await fn(tx);
        committed = true;
        return out;
      });
      mutations.billAddonsLeavingInclusion.mockImplementation(async () => {
        expect(committed).toBe(true); // billed only after the flip committed
        return {};
      });
      await svc.applyScheduledDowngrades();

      expect(tx.tenantAddon.updateMany).not.toHaveBeenCalled();
      expect(mutations.billAddonsLeavingInclusion).toHaveBeenCalledTimes(1);
      const [tenantId, rows, skus, source, opts] =
        mutations.billAddonsLeavingInclusion.mock.calls[0];
      expect(tenantId).toBe("t1");
      expect(rows.map((r: any) => [r.id, r.monthlyPrice])).toEqual([["ta_reg", 39]]);
      expect(skus.map((k: any) => k.sku)).toEqual(["REGULATED_ITEMS"]);
      expect(source).toBe("plan_change");
      expect(opts).toEqual({ prorationBehavior: "always_invoice", prorationDate: EFFECTIVE });
    });

    it("R7 failure: a throw after commit flags the tenant and writes ONE notice; the plan flip stays committed and the sweep carries on", async () => {
      const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const mutations = {
        billAddonsLeavingInclusion: jest.fn().mockRejectedValue(new Error("stripe down")),
      };
      const stripe = fakeStripeSubscription([baseItem(24900)]);
      const { svc, tx, prisma, catalog } = make({
        downgrades: [row({ stripeSubId: "sub_1", externalPayment: false })],
        heldAddons: [regulated()],
        stripe,
        mutations,
      });
      versionWithRegulated(catalog);
      await expect(svc.applyScheduledDowngrades()).resolves.not.toThrow();

      expect(tx.tenantSubscription.update).toHaveBeenCalledTimes(1); // the flip committed
      expect(
        error.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("needs_reconcile")),
      ).toHaveLength(1);
      const notices = prisma.auditLog.create.mock.calls.map((c: any[]) => c[0].data);
      expect(notices).toHaveLength(1);
      expect(notices[0].meta.message).toBe(
        "Add-on Regulated items for t1 left Scale and could not be billed: bill it",
      );
      error.mockRestore();
    });

    it("R8 guards: a comp row, a priced row with an item, a quantity > 1 row and an UNBILLED tenant are all left alone", async () => {
      const manual = make({
        downgrades: [row()],
        heldAddons: [
          regulated({ id: "ta_comp", isComp: true }),
          regulated({ id: "ta_item", priceSnapshot: 39, stripeItemId: "si_x" }),
          regulated({ id: "ta_qty", quantity: 3 }),
        ],
      });
      versionWithRegulated(manual.catalog);
      await manual.svc.applyScheduledDowngrades();
      expect(manual.tx.tenantAddon.updateMany).not.toHaveBeenCalled();
      expect(manual.tx.auditLog.create).not.toHaveBeenCalled();

      const unbilled = make({
        downgrades: [row({ externalPayment: false })],
        heldAddons: [regulated()],
      });
      versionWithRegulated(unbilled.catalog);
      await unbilled.svc.applyScheduledDowngrades();
      expect(unbilled.tx.tenantAddon.updateMany).not.toHaveBeenCalled();
      expect(unbilled.tx.auditLog.create).not.toHaveBeenCalled();
      expect(
        unbilled.events.emit.mock.calls.filter((c: any[]) => c[1] === BILLING_EVENTS.ADDON_ENABLED),
      ).toHaveLength(0);
    });
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
    expect(tx.user.updateMany.mock.calls[0][0].where.id).toEqual({ notIn: [] });
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

  it("SA-787 C1: applyScheduledCancellations churn delta includes active add-ons; the lock changes STATUS only - rows stay active, only dead Stripe pointers clear", async () => {
    const { svc, tx, events } = make({
      cancellations: [
        { tenantId: "t1", planKey: "BUSINESS", basePriceSnapshot: 349, discount: 10 },
      ],
      cancelAddons: [{ priceSnapshot: 12, quantity: 2 }],
    });
    await svc.applyScheduledCancellations();
    // −(349 + 12×2 − 10) = −363.
    expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_CANCELED)).toBe(-363);
    // SA-787 C1: a lock changes the tenant's status, never its entitlements. The subscription's items died with
    // it, so only the dead pointers clear; `active`, the price, `isComp` and the quantity are never written.
    expect(tx.tenantAddon.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.tenantAddon.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", active: true, stripeItemId: { not: null } },
      data: { stripeItemId: null },
    });
    for (const call of tx.tenantAddon.updateMany.mock.calls) {
      expect(call[0].data).not.toHaveProperty("active");
    }
  });

  it("SA-787 C1: the SUBSCRIPTION_CANCELED event records what stayed on (addonsKept), comps included; it restores nothing", async () => {
    const kept = [
      {
        id: "ta_a",
        addonKey: "FORECASTING",
        sku: "FORECASTING",
        quantity: 1,
        priceSnapshot: 25,
        isComp: false,
      },
      {
        id: "ta_c",
        addonKey: "REGULATED_ITEMS",
        sku: "REGULATED_ITEMS",
        quantity: 1,
        priceSnapshot: 0,
        isComp: true,
      },
    ];
    const { svc, tx, events } = make({
      cancellations: [{ tenantId: "t1", planKey: "BUSINESS", basePriceSnapshot: 349, discount: 0 }],
    });
    tx.tenantAddon.findMany.mockImplementation(async (a: any) =>
      a?.where?.isComp === false ? kept.filter((r) => !r.isComp) : kept,
    );
    await svc.applyScheduledCancellations();

    const canceled = events.emit.mock.calls.find(
      (c: any[]) => c[1] === BILLING_EVENTS.SUBSCRIPTION_CANCELED,
    );
    expect(canceled[2].addonsKept).toEqual(kept);
    expect(canceled[3].amountDelta).toBe(-374); // 349 + 25: the comp is never in the run-rate
  });

  it("N4: the churn delta never includes a COMP add-on (a platform grant: never billed, never in MRR)", async () => {
    const { svc, tx, events } = make({
      cancellations: [
        { tenantId: "t1", planKey: "BUSINESS", basePriceSnapshot: 349, discount: 10 },
      ],
    });
    const rows = [
      { priceSnapshot: 12, quantity: 2, isComp: false },
      { priceSnapshot: 20, quantity: 1, isComp: true },
    ];
    tx.tenantAddon.findMany.mockImplementation(async (a: any) =>
      rows.filter((r) => (a?.where?.isComp === false ? !r.isComp : true)),
    );
    await svc.applyScheduledCancellations();
    // -(349 + 12x2 - 10) = -363; the comp's 20 is not in it (-383 would be the bug)
    expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_CANCELED)).toBe(-363);
    expect(tx.tenantAddon.findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      active: true,
      isComp: false,
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
  it("REG-B863-ROLL 365-day external row labelled MONTHLY rolls onto the ANNUAL calendar (SA-744r2 M4; master: +365d)", async () => {
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
    // BOTH ends are written: the SNAPPED start (never the raw old end) and a full calendar year.
    expect(data.periodStart.toISOString()).toBe("2026-01-01T12:00:00.000Z");
    expect(data.periodEnd.toISOString()).toBe("2027-01-01T12:00:00.000Z");
    expect(prisma.tenantSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ periodStart: true, externalPayment: true }),
      }),
    );
  });

  it("REG-B863-ROLL 90-day external row rolls MONTHLY on the calendar, not +90d (SA-744r2; master: Apr 1 00:00Z)", async () => {
    const periodStart = new Date("2025-10-03T00:00:00.000Z");
    const periodEnd = new Date("2026-01-01T00:00:00.000Z");
    const { svc, prisma } = make({
      rollSubs: [
        { tenantId: "t1", cycle: "MONTHLY", externalPayment: true, periodStart, periodEnd },
      ],
    });
    await svc.rollCycles();
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect(data.periodStart.toISOString()).toBe("2026-01-01T12:00:00.000Z");
    expect(data.periodEnd.toISOString()).toBe("2026-02-01T12:00:00.000Z");
  });

  it("REG-B863-ROLL 180-day external row rolls MONTHLY on the calendar, not +180d", async () => {
    const periodStart = new Date("2025-07-05T00:00:00.000Z");
    const periodEnd = new Date("2026-01-01T00:00:00.000Z");
    const { svc, prisma } = make({
      rollSubs: [
        { tenantId: "t1", cycle: "MONTHLY", externalPayment: true, periodStart, periodEnd },
      ],
    });
    await svc.rollCycles();
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect(data.periodEnd.toISOString()).toBe("2026-02-01T12:00:00.000Z");
  });

  // SA-744r2 red rows (master gives a length-preserving roll for each).
  it("SA-744r2: a 17-day activation ending Nov 1 00:00Z rolls to [Nov 1 12:00Z, Dec 1 12:00Z) (master: another 17 days)", async () => {
    const { svc, prisma } = make({
      rollSubs: [
        {
          tenantId: "t1",
          cycle: "MONTHLY",
          externalPayment: true,
          periodStart: new Date("2026-10-15T00:00:00.000Z"),
          periodEnd: new Date("2026-11-01T00:00:00.000Z"),
        },
      ],
    });
    await svc.rollCycles();
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect([data.periodStart.toISOString(), data.periodEnd.toISOString()]).toEqual([
      "2026-11-01T12:00:00.000Z",
      "2026-12-01T12:00:00.000Z",
    ]);
  });

  it("SA-744r2: a 45-day prepay ending Nov 22 rolls to the ALIGNMENT window [Nov 22, Dec 1 12:00Z), then plain months (master: 45 days forever)", async () => {
    const { svc, prisma } = make({
      rollSubs: [
        {
          tenantId: "t1",
          cycle: "MONTHLY",
          externalPayment: true,
          periodStart: new Date("2026-10-08T00:00:00.000Z"),
          periodEnd: new Date("2026-11-22T00:00:00.000Z"),
        },
      ],
    });
    await svc.rollCycles();
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect([data.periodStart.toISOString(), data.periodEnd.toISOString()]).toEqual([
      "2026-11-22T00:00:00.000Z",
      "2026-12-01T12:00:00.000Z",
    ]);
  });

  it("SA-744r2 M4: an ANNUAL row on a non-1st fixture merges the alignment into the first year, then rolls plain years", async () => {
    const first = {
      tenantId: "t1",
      cycle: "ANNUAL",
      externalPayment: true,
      periodStart: new Date("2025-10-08T00:00:00.000Z"),
      periodEnd: new Date("2026-10-08T00:00:00.000Z"),
    };
    const a = make({ rollSubs: [first] });
    await a.svc.rollCycles();
    const d1 = a.prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect([d1.periodStart.toISOString(), d1.periodEnd.toISOString()]).toEqual([
      "2026-10-08T00:00:00.000Z",
      "2027-11-01T12:00:00.000Z",
    ]);
    const b = make({
      rollSubs: [{ ...first, periodStart: d1.periodStart, periodEnd: d1.periodEnd }],
    });
    await b.svc.rollCycles();
    const d2 = b.prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect([d2.periodStart.toISOString(), d2.periodEnd.toISOString()]).toEqual([
      "2027-11-01T12:00:00.000Z",
      "2028-11-01T12:00:00.000Z",
    ]);
  });

  it("SA-744r2: a merged (< 3 days) alignment rolls to [Nov 29, Jan 1 12:00Z) in ONE write (rollCycles == the issuer's helper)", async () => {
    const { svc, prisma } = make({
      rollSubs: [
        {
          tenantId: "t1",
          cycle: "MONTHLY",
          externalPayment: true,
          periodStart: new Date("2026-10-30T00:00:00.000Z"),
          periodEnd: new Date("2026-11-29T00:00:00.000Z"),
        },
      ],
    });
    await svc.rollCycles();
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect([data.periodStart.toISOString(), data.periodEnd.toISOString()]).toEqual([
      "2026-11-29T00:00:00.000Z",
      "2027-01-01T12:00:00.000Z",
    ]);
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

  // SA-744r2: an external row with no periodStart on record has no observed length to preserve; it follows
  // the calendar by its label (it used to fall back to addCycle).
  it("rollCycles rolls an external row with periodStart: null onto the calendar by its label", async () => {
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
    expect(data.periodStart.toISOString()).toBe("2026-01-01T12:00:00.000Z");
    expect(data.periodEnd.toISOString()).toBe("2026-02-01T12:00:00.000Z");
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

  // F1 (b): the local cancel flag can be a STALE webhook's. Before ANY lock or add-on deactivation the sweep
  // re-reads Stripe: lock only for cancel_at_period_end=true AND current_period_end <= now, or status=canceled.
  describe("F1(b): Stripe is re-read before a scheduled cancellation locks the tenant", () => {
    // the row's updatedAt as the sweep's scan read it, BEFORE the Stripe read
    const SCANNED_AT = new Date("2026-08-31T10:00:00.000Z");
    const withStripe = (getSubscription: jest.Mock) =>
      make({
        cancellations: [{ ...cancellation, stripeSubId: "sub_1", updatedAt: SCANNED_AT }],
        cancelAddons: [{ priceSnapshot: 12, quantity: 2 }],
        stripe: { isConfigured: true, getSubscription },
      });
    const nothingLocked = (h: ReturnType<typeof make>) => {
      expect(h.tx.tenant.update).not.toHaveBeenCalled();
      expect(h.tx.tenantAddon.updateMany).not.toHaveBeenCalled();
      expect(emitted(h.events)).not.toContain(BILLING_EVENTS.SUBSCRIPTION_CANCELED);
      expect(h.tenantStatus.invalidate).not.toHaveBeenCalled();
    };
    const nowS = () => Math.floor(Date.now() / 1000);

    it("Stripe says the cancel was resumed (a stale event armed it): no lock, no add-on deactivation", async () => {
      const get = jest.fn().mockResolvedValue({
        status: "active",
        cancel_at_period_end: false,
        items: {
          data: [
            {
              id: "si",
              current_period_start: nowS() - 86_400,
              current_period_end: nowS() + 86_400,
            },
          ],
        },
      });
      const h = withStripe(get);
      await h.svc.applyScheduledCancellations();
      expect(get.mock.calls[0][0]).toBe("sub_1");
      nothingLocked(h);
    });

    describe("F1b: a stale local cancel flag is cleared once, not warned about hourly", () => {
      const resumed = (extra: Record<string, unknown> = {}) =>
        jest.fn().mockResolvedValue({
          status: "active",
          cancel_at_period_end: false,
          items: {
            data: [
              {
                id: "si",
                current_period_start: nowS() - 86_400,
                current_period_end: nowS() + 86_400,
              },
            ],
          },
          ...extra,
        });

      it("Stripe says resumed: the flag is CAS-cleared on the old value, one log line, no lock", async () => {
        const log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
        const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
        const h = withStripe(resumed());
        await h.svc.applyScheduledCancellations();
        expect(h.prisma.tenantSubscription.updateMany).toHaveBeenCalledTimes(1);
        expect(h.prisma.tenantSubscription.updateMany).toHaveBeenCalledWith({
          // updatedAt fences the clear: a re-cancel that landed after the scan (after Stripe was read) moves it
          where: {
            tenantId: "t1",
            stripeSubId: "sub_1",
            cancelAtPeriodEnd: true,
            updatedAt: SCANNED_AT,
          },
          data: { cancelAtPeriodEnd: false },
        });
        expect(log.mock.calls.filter((c) => /stale/i.test(String(c[0])))).toHaveLength(1);
        expect(
          warn.mock.calls.filter((c) => /does not - not locked/.test(String(c[0]))),
        ).toHaveLength(0);
        nothingLocked(h);
        log.mockRestore();
        warn.mockRestore();
      });

      it("a lost CAS (another writer moved the flag) is quiet: no throw, no second write", async () => {
        const h = withStripe(resumed());
        h.prisma.tenantSubscription.updateMany.mockResolvedValue({ count: 0 });
        await expect(h.svc.applyScheduledCancellations()).resolves.toBeUndefined();
        expect(h.prisma.tenantSubscription.updateMany).toHaveBeenCalledTimes(1);
        nothingLocked(h);
      });

      it("Stripe holds a cancel_at timestamp (a different way to schedule a cancel): the flag is NOT cleared", async () => {
        const h = withStripe(resumed({ cancel_at: nowS() + 86_400 }));
        await h.svc.applyScheduledCancellations();
        expect(h.prisma.tenantSubscription.updateMany).not.toHaveBeenCalled();
        nothingLocked(h);
      });

      it("a failed clear is logged and skips the tenant this hour - the sweep does not throw", async () => {
        const err = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
        const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
        const h = withStripe(resumed());
        h.prisma.tenantSubscription.updateMany.mockRejectedValue(new Error("db blip"));
        await expect(h.svc.applyScheduledCancellations()).resolves.toBeUndefined();
        nothingLocked(h);
        expect(err.mock.calls.length + warn.mock.calls.length).toBeGreaterThan(0);
        err.mockRestore();
        warn.mockRestore();
      });

      it("the control: Stripe still has the cancel armed -> no clear (and it locks once the period ends)", async () => {
        const h = withStripe(
          jest.fn().mockResolvedValue({
            status: "active",
            cancel_at_period_end: true,
            items: {
              data: [
                {
                  id: "si",
                  current_period_start: nowS() - 86_400,
                  current_period_end: nowS() - 60,
                },
              ],
            },
          }),
        );
        await h.svc.applyScheduledCancellations();
        expect(h.prisma.tenantSubscription.updateMany).not.toHaveBeenCalled();
        expect(h.tx.tenant.update.mock.calls[0][0].data).toMatchObject({ status: "READ_ONLY" });
      });
    });

    it("a Stripe read error skips the tenant this hour (logged) - no lock", async () => {
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const err = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const h = withStripe(jest.fn().mockRejectedValue(new Error("Stripe timeout")));
      await expect(h.svc.applyScheduledCancellations()).resolves.toBeUndefined();
      nothingLocked(h);
      expect(warn.mock.calls.length + err.mock.calls.length).toBeGreaterThan(0);
      warn.mockRestore();
      err.mockRestore();
    });

    it("cancel armed at Stripe but the period has NOT ended there: no lock", async () => {
      const get = jest.fn().mockResolvedValue({
        status: "active",
        cancel_at_period_end: true,
        items: {
          data: [
            {
              id: "si",
              current_period_start: nowS() - 86_400,
              current_period_end: nowS() + 86_400,
            },
          ],
        },
      });
      const h = withStripe(get);
      await h.svc.applyScheduledCancellations();
      nothingLocked(h);
    });

    it("cancel armed at Stripe and its period ended: locks (the control)", async () => {
      const get = jest.fn().mockResolvedValue({
        status: "active",
        cancel_at_period_end: true,
        items: {
          data: [
            { id: "si", current_period_start: nowS() - 86_400, current_period_end: nowS() - 60 },
          ],
        },
      });
      const h = withStripe(get);
      await h.svc.applyScheduledCancellations();
      expect(h.tx.tenant.update.mock.calls[0][0].data).toMatchObject({ status: "READ_ONLY" });
    });

    it("Stripe status canceled: locks", async () => {
      const get = jest.fn().mockResolvedValue({
        status: "canceled",
        cancel_at_period_end: false,
        items: {
          data: [
            {
              id: "si",
              current_period_start: nowS() - 86_400,
              current_period_end: nowS() + 86_400,
            },
          ],
        },
      });
      const h = withStripe(get);
      await h.svc.applyScheduledCancellations();
      expect(h.tx.tenant.update.mock.calls[0][0].data).toMatchObject({ status: "READ_ONLY" });
    });
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

// SA-744r2 parity guard (green on master too, by the spec's own label): the window rollCycles writes for an
// external row is EXACTLY the window the issuer's windowsFor issues next - start AND end - for random ends
// and both cycles (L-167: one helper behind both).
describe("SA-744r2: rollCycles == windowsFor (start AND end)", () => {
  it("200 random external ends x both cycles agree", async () => {
    let seed = 744;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const issuer = new (RfInvoiceIssuerService as any)(
      { rfInvoice: { findMany: async () => [], findFirst: async () => null } },
      {},
      {},
    ) as RfInvoiceIssuerService;
    const DAY = 24 * 60 * 60 * 1000;
    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
    for (let i = 0; i < 200; i++) {
      for (const cycle of ["MONTHLY", "ANNUAL"] as const) {
        const periodEnd = new Date(t0 + Math.floor(rand() * 3 * 365 * DAY));
        const periodStart = new Date(periodEnd.getTime() - (cycle === "ANNUAL" ? 365 : 30) * DAY);
        const sub = { tenantId: "t1", cycle, externalPayment: true, periodStart, periodEnd };
        const { svc, prisma } = make({ rollSubs: [sub] });
        await svc.rollCycles();
        const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
        const next = (await issuer.windowsFor(sub as any, periodEnd, Infinity))[0];
        expect([data.periodStart.getTime(), data.periodEnd.getTime()]).toEqual([
          next?.periodStart.getTime(),
          next?.periodEnd.getTime(),
        ]);
      }
    }
  });
});
