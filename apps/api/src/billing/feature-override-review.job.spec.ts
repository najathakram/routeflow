// `@LeaderCron` wraps every cron tick in a Postgres advisory lock (common/cron-lock.ts). Mirrors
// billing-cron.service.spec.ts's convention: a pass-through mock that still calls the real
// body, but here it also records the call so we can assert the exact lock key the tick runs
// under (proves this is NOT a bare, unelected @Cron).
const withAdvisoryLockMock = jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
  acquired: true,
  value: await fn(),
}));
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: (...args: [unknown, () => Promise<unknown>]) =>
    (withAdvisoryLockMock as any)(...args),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { Logger } from "@nestjs/common";
import {
  FeatureOverrideReviewJob,
  FEATURE_OVERRIDE_EXPIRED_REVIEW_ACTION,
} from "./feature-override-review.job";
import { FEATURE_OVERRIDE_PILOT_ENDING_NOTIFIED } from "./feature-override-audit.constants";

function overrideRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ov1",
    tenantId: "t1",
    featureKey: "tobacco_dealer",
    kind: "PILOT",
    effect: "GRANT",
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

// pre-merge review (2026-09-17), MUST-4 + STARVATION follow-up: the mock applies the job's
// ACTUAL `where` clauses on BOTH queries -- not a hardcoded assumption baked into the fixture
// filter -- so dropping `revokedAt: null`, `expiresAt.lte`, or the `id.notIn` exclusion from the
// real queries changes what this mock returns, and the assertions below fail instead of
// silently passing.
function build(rows: ReturnType<typeof overrideRow>[], auditedIds: string[] = []) {
  const prisma = {
    tenantFeatureOverride: {
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        const lte = where?.expiresAt?.lte as Date | undefined;
        const notIn: string[] = where?.id?.notIn ?? [];
        return Promise.resolve(
          rows.filter(
            (r) =>
              r.revokedAt === where?.revokedAt &&
              r.expiresAt != null &&
              lte != null &&
              (r.expiresAt as Date).getTime() <= lte.getTime() &&
              !notIn.includes(r.id as string),
          ),
        );
      }),
    },
    auditLog: {
      findMany: jest
        .fn()
        .mockImplementation(() => Promise.resolve(auditedIds.map((entityId) => ({ entityId })))),
    },
  } as any;
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as any;
  const ownerAlerts = { pilotEnding: jest.fn().mockResolvedValue(undefined) } as any;
  const catalog = { getVersionForTenant: jest.fn() } as any;
  const entitlements = { resolve: jest.fn() } as any;
  return {
    job: new FeatureOverrideReviewJob(prisma, audit, ownerAlerts, catalog, entitlements),
    prisma,
    audit,
  };
}

describe("FeatureOverrideReviewJob.reviewExpiredOverrides", () => {
  beforeEach(() => withAdvisoryLockMock.mockClear());

  it("B589: a page that comes back exactly at the cap is logged; a smaller one is not", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const full = Array.from({ length: 500 }, (_, i) =>
        overrideRow({ id: `ov${i}`, expiresAt: new Date(Date.UTC(2000, 0, 1, 0, 0, i)) }),
      );
      await build(full).job.reviewExpiredOverrides();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("hit its batch cap of 500"));

      warn.mockClear();
      await build(full.slice(0, 499)).job.reviewExpiredOverrides();
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("batch cap"));
    } finally {
      warn.mockRestore();
    }
  });

  it("flags exactly one expired-unrevoked override and leaves an active one alone", async () => {
    const { job, audit } = build([
      overrideRow({ id: "ov-expired", expiresAt: new Date("2000-01-01T00:00:00Z") }),
      overrideRow({ id: "ov-active", expiresAt: new Date(Date.now() + 86_400_000) }),
    ]);

    const result = await job.reviewExpiredOverrides();

    expect(result.reviewed).toBe(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        userId: null,
        action: FEATURE_OVERRIDE_EXPIRED_REVIEW_ACTION,
        entityType: "tenantFeatureOverride",
        entityId: "ov-expired",
      }),
    );
  });

  it("skips an already-revoked expired row -- writes no audit row for it", async () => {
    const { job, audit } = build([
      overrideRow({
        id: "ov-revoked",
        expiresAt: new Date("2000-01-01T00:00:00Z"),
        revokedAt: new Date(),
      }),
    ]);

    const result = await job.reviewExpiredOverrides();

    expect(result.reviewed).toBe(0);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("queries with revokedAt: null, expiresAt.lte <= now, oldest first, capped at 500", async () => {
    const { job, prisma } = build([]);
    await job.reviewExpiredOverrides();
    expect(prisma.tenantFeatureOverride.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revokedAt: null, expiresAt: { lte: expect.any(Date) } }),
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }], // B589: id tiebreak
        take: 500,
      }),
    );
  });

  it("looks up already-audited ids for THIS action/entityType, bounded, before selecting rows", async () => {
    const { job, prisma } = build([]);
    await job.reviewExpiredOverrides();
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          action: FEATURE_OVERRIDE_EXPIRED_REVIEW_ACTION,
          entityType: "tenantFeatureOverride",
        },
        take: 5000,
      }),
    );
  });

  it("never revokes the row -- update() is not even wired on this collaborator", async () => {
    const { job, prisma } = build([
      overrideRow({ id: "ov-expired", expiresAt: new Date("2000-01-01T00:00:00Z") }),
    ]);
    expect(prisma.tenantFeatureOverride.update).toBeUndefined();
    await job.reviewExpiredOverrides();
    // Still true after the tick ran -- confirms the job never even tries to call it.
    expect(prisma.tenantFeatureOverride.update).toBeUndefined();
  });

  // pre-merge review, SHOULD-3: audit once EVER, not once per night.
  it("skips a row that already carries a FEATURE_OVERRIDE_EXPIRED_REVIEW audit row from a prior tick", async () => {
    const { job, audit, prisma } = build(
      [overrideRow({ id: "ov-already-flagged", expiresAt: new Date("2000-01-01T00:00:00Z") })],
      ["ov-already-flagged"],
    );

    const result = await job.reviewExpiredOverrides();

    expect(result.reviewed).toBe(0);
    expect(audit.log).not.toHaveBeenCalled();
    // The exclusion is applied INSIDE the selection query, not as a post-filter.
    expect(prisma.tenantFeatureOverride.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { notIn: ["ov-already-flagged"] } }),
      }),
    );
  });

  it("audits a not-yet-flagged row while skipping an already-flagged one in the SAME tick", async () => {
    const { job, audit } = build(
      [
        overrideRow({ id: "ov-new", expiresAt: new Date("2000-01-01T00:00:00Z") }),
        overrideRow({ id: "ov-old-flagged", expiresAt: new Date("1999-01-01T00:00:00Z") }),
      ],
      ["ov-old-flagged"],
    );

    const result = await job.reviewExpiredOverrides();

    expect(result.reviewed).toBe(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ entityId: "ov-new" }));
  });

  // STARVATION oracle (pre-merge re-review, 2026-09-17): 501 (REVIEW_BATCH_SIZE + 1)
  // already-audited-and-still-unrevoked rows plus ONE fresh, never-audited expired row. The
  // pre-fix code (dedupe applied AFTER a fixed 500-row oldest-first page) would fill its entire
  // page with already-audited rows and never even see the fresh one -- reviewed would stay 0
  // forever. The fix excludes audited ids INSIDE the query, so the fresh row is selected
  // regardless of how many already-audited rows precede it.
  it("does not starve a fresh expired row behind >= REVIEW_BATCH_SIZE already-audited ones", async () => {
    const staleAuditedIds = Array.from({ length: 501 }, (_, i) => `ov-stale-${i}`);
    const staleRows = staleAuditedIds.map((id, i) =>
      overrideRow({ id, expiresAt: new Date(Date.UTC(2000, 0, 1, 0, 0, i)) }),
    );
    const freshRow = overrideRow({ id: "ov-fresh", expiresAt: new Date("2005-01-01T00:00:00Z") });

    const { job, audit } = build([...staleRows, freshRow], staleAuditedIds);

    const result = await job.reviewExpiredOverrides();

    expect(result.reviewed).toBe(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ entityId: "ov-fresh" }));
  });

  it("runs the tick under the shared advisory lock, keyed by the pinned job name", async () => {
    const { job } = build([]);
    await job.reviewExpiredOverrides();
    expect(withAdvisoryLockMock).toHaveBeenCalledWith(
      expect.objectContaining({
        family: "cron",
        key: "billing.reviewExpiredOverrides",
        mode: "try",
      }),
      expect.any(Function),
    );
  });
});

// ─── R25 / T25: the owner hears 7 days before a billable free period ends ──────────────────────

const DAY = 86_400_000;
const PRICED_CATALOG = {
  id: "v-1",
  addonSkus: [
    {
      sku: "REGULATED_ITEMS",
      name: "Regulated items",
      monthlyPrice: "39.00",
      meteredKey: null,
      includedAtPlan: "SCALE",
    },
    {
      sku: "MSRP",
      name: "MSRP pricing",
      monthlyPrice: "0.00",
      meteredKey: null,
      includedAtPlan: null,
    },
  ],
};

function pilotRow(over: Record<string, unknown> = {}) {
  return {
    id: "ov-pilot",
    tenantId: "t1",
    featureKey: "tobacco_dealer",
    kind: "PILOT",
    effect: "GRANT",
    revokedAt: null as Date | null,
    expiresAt: new Date(Date.now() + 6 * DAY) as Date | null,
    tenant: {
      id: "t1",
      name: "Acme Foods",
      plan: "GROWTH",
      planVersionId: "v-1",
      deletedAt: null as Date | null,
      class: "PRODUCTION",
      subscription: { planKey: "GROWTH" },
    },
    ...over,
  };
}

// The mock APPLIES the real where clause (kind, effect, revokedAt, the window, the feature keys,
// the NOT of already-warned id+date pairs) and keeps the audit rows the job writes so a second
// tick sees them: dropping any clause changes what comes back and a test below goes red.
function buildPilot(
  rows: ReturnType<typeof pilotRow>[],
  catalogVersion: unknown = PRICED_CATALOG,
  facts: {
    addonRows?: { addonKey: string; sku: string | null; active: boolean }[];
    planFlags?: string[];
    planKey?: string;
    otherOverrides?: { featureKey: string; effect: string }[];
  } = {},
) {
  const auditRows: { entityId: string; meta: { expiresAt: string } }[] = [];
  const events: string[] = [];
  const prisma = {
    tenantFeatureOverride: {
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        // the per-business read of the OTHER live overrides (served-answer facts), not the candidate page
        if (where?.tenantId) {
          expect(where.revokedAt).toBeNull();
          expect(where.id).toEqual({ not: expect.any(String) });
          return Promise.resolve(facts.otherOverrides ?? []);
        }
        const { gt, lte } = where?.expiresAt ?? {};
        const kinds: string[] | undefined = where?.kind?.in;
        const keys: string[] | undefined = where?.featureKey?.in;
        const not: { id: string; expiresAt: Date }[] = where?.NOT ?? [];
        return Promise.resolve(
          rows.filter(
            (r) =>
              (kinds ? kinds.includes(r.kind) : r.kind === where?.kind) &&
              r.effect === where?.effect &&
              r.revokedAt === where?.revokedAt &&
              r.expiresAt != null &&
              gt != null &&
              lte != null &&
              r.expiresAt.getTime() > gt.getTime() &&
              r.expiresAt.getTime() <= lte.getTime() &&
              (!keys || keys.includes(r.featureKey)) &&
              (where?.tenant?.deletedAt !== null || r.tenant.deletedAt === null) &&
              (where?.tenant?.class === undefined || r.tenant.class === where.tenant.class) &&
              !not.some((n) => n.id === r.id && n.expiresAt.getTime() === r.expiresAt!.getTime()),
          ),
        );
      }),
    },
    tenantAddon: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve(facts.addonRows ?? [])),
    },
    auditLog: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve([...auditRows])),
      create: jest.fn().mockImplementation(({ data }: any) => {
        events.push("audit");
        auditRows.push({
          entityId: data.entityId,
          meta: { expiresAt: new Date(data.meta.expiresAt).toISOString() },
        });
        return Promise.resolve({});
      }),
    },
  } as any;
  const audit = { log: jest.fn() } as any;
  const ownerAlerts = {
    pilotEnding: jest.fn().mockImplementation(async () => {
      events.push("send");
    }),
  } as any;
  const catalog = { getVersionForTenant: jest.fn().mockResolvedValue(catalogVersion) } as any;
  const entitlements = {
    resolve: jest.fn().mockResolvedValue({
      planKey: facts.planKey ?? "GROWTH",
      flags: facts.planFlags ?? [],
    }),
  } as any;
  return {
    job: new FeatureOverrideReviewJob(prisma, audit, ownerAlerts, catalog, entitlements),
    entitlements,
    prisma,
    ownerAlerts,
    catalog,
    events,
  };
}

describe("FeatureOverrideReviewJob.warnBillablePilotsEnding (R25 / T25)", () => {
  beforeEach(() => withAdvisoryLockMock.mockClear());

  it("a billable free period ending in 6 days: exactly one owner mail and one audit row, audit first", async () => {
    const row = pilotRow();
    const { job, ownerAlerts, prisma, events } = buildPilot([row]);

    const out = await job.warnBillablePilotsEnding();

    expect(out).toEqual({ warned: 1 });
    expect(ownerAlerts.pilotEnding).toHaveBeenCalledTimes(1);
    expect(ownerAlerts.pilotEnding).toHaveBeenCalledWith("t1", {
      featureName: "Regulated items",
      endsAt: row.expiresAt,
      monthlyPrice: 39,
    });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "t1",
        userId: null,
        action: FEATURE_OVERRIDE_PILOT_ENDING_NOTIFIED,
        entityType: "tenantFeatureOverride",
        entityId: "ov-pilot",
        meta: { expiresAt: row.expiresAt },
      }),
    });
    expect(events).toEqual(["audit", "send"]);
  });

  it("a second tick sends nothing more for the same end date", async () => {
    const { job, ownerAlerts, prisma } = buildPilot([pilotRow()]);
    await job.warnBillablePilotsEnding();
    const second = await job.warnBillablePilotsEnding();
    expect(second).toEqual({ warned: 0 });
    expect(ownerAlerts.pilotEnding).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("an extended end date earns a new warning", async () => {
    const row = pilotRow();
    const { job, ownerAlerts } = buildPilot([row]);
    await job.warnBillablePilotsEnding();
    row.expiresAt = new Date(Date.now() + 5 * DAY); // moved, still inside the window
    await job.warnBillablePilotsEnding();
    expect(ownerAlerts.pilotEnding).toHaveBeenCalledTimes(2);
  });

  it("the already-warned lookup is bounded, and the exclusion sits INSIDE the selection query", async () => {
    const { job, prisma } = buildPilot([pilotRow()]);
    await job.warnBillablePilotsEnding();
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: FEATURE_OVERRIDE_PILOT_ENDING_NOTIFIED,
          entityType: "tenantFeatureOverride",
        }),
        take: 5000,
      }),
    );
    await job.warnBillablePilotsEnding();
    expect(prisma.tenantFeatureOverride.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ NOT: [{ id: "ov-pilot", expiresAt: expect.any(Date) }] }),
        take: 500,
      }),
    );
  });

  it.each([
    ["revoked", { revokedAt: new Date() }],
    ["a comp (not a pilot)", { kind: "COMP" }],
    ["a support grant (not a free period)", { kind: "SUPPORT" }],
    ["a deny", { effect: "DENY" }],
    ["ending in 8 days", { expiresAt: new Date(Date.now() + 8 * 86_400_000) }],
    ["already ended", { expiresAt: new Date(Date.now() - DAY) }],
    ["no end date", { expiresAt: null }],
    ["a feature that has no paid add-on", { featureKey: "flag.units_v1" }],
    ["a deleted business", { tenant: { ...pilotRow().tenant, deletedAt: new Date() } }],
    ["a TEST-class business (BP-4)", { tenant: { ...pilotRow().tenant, class: "TEST" } }],
    ["a DEMO-class business (BP-4)", { tenant: { ...pilotRow().tenant, class: "DEMO" } }],
  ])("sends nothing for %s", async (_label, over) => {
    const { job, ownerAlerts, prisma } = buildPilot([pilotRow(over)]);
    const out = await job.warnBillablePilotsEnding();
    expect(out).toEqual({ warned: 0 });
    expect(ownerAlerts.pilotEnding).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("sends nothing when the add-on is priced 0, or the business plan already includes it", async () => {
    const free = buildPilot([pilotRow({ featureKey: "flag.msrp" })]);
    await free.job.warnBillablePilotsEnding();
    expect(free.ownerAlerts.pilotEnding).not.toHaveBeenCalled();

    const included = buildPilot([pilotRow()], {
      id: "v-1",
      addonSkus: [
        {
          sku: "REGULATED_ITEMS",
          name: "Regulated items",
          monthlyPrice: "39.00",
          meteredKey: null,
          includedAtPlan: "GROWTH",
        },
      ],
    });
    await included.job.warnBillablePilotsEnding();
    expect(included.ownerAlerts.pilotEnding).not.toHaveBeenCalled();
  });

  describe("SA-1100 §1 red rows: the free period must really cost something afterwards", () => {
    const withForecasting = {
      id: "v-1",
      addonSkus: [
        ...PRICED_CATALOG.addonSkus,
        {
          sku: "FORECASTING",
          name: "Forecasting",
          monthlyPrice: "19.00",
          meteredKey: null,
          includedAtPlan: "SCALE",
        },
      ],
    };
    const saved = process.env.PLAN_FLAG_ENFORCEMENT;
    afterEach(() => {
      if (saved === undefined) delete process.env.PLAN_FLAG_ENFORCEMENT;
      else process.env.PLAN_FLAG_ENFORCEMENT = saved;
    });

    it("BP-1: an analytics pilot on Starter with the switch off sends nothing (the plan flag is served anyway)", async () => {
      delete process.env.PLAN_FLAG_ENFORCEMENT;
      const { job, ownerAlerts, prisma } = buildPilot(
        [
          pilotRow({
            featureKey: "flag.analytics",
            tenant: { ...pilotRow().tenant, plan: "STARTER", subscription: { planKey: "STARTER" } },
          }),
        ],
        withForecasting,
        { planKey: "STARTER" },
      );
      expect(await job.warnBillablePilotsEnding()).toEqual({ warned: 0 });
      expect(ownerAlerts.pilotEnding).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("the same pilot warns once enforcement is on (ending it then really removes the feature)", async () => {
      process.env.PLAN_FLAG_ENFORCEMENT = "on";
      const { job, ownerAlerts } = buildPilot(
        [
          pilotRow({
            featureKey: "flag.analytics",
            tenant: { ...pilotRow().tenant, plan: "STARTER", subscription: { planKey: "STARTER" } },
          }),
        ],
        withForecasting,
        { planKey: "STARTER" },
      );
      expect(await job.warnBillablePilotsEnding()).toEqual({ warned: 1 });
      expect(ownerAlerts.pilotEnding).toHaveBeenCalledWith("t1", {
        featureName: "Forecasting",
        endsAt: expect.any(Date),
        monthlyPrice: 19,
      });
    });

    it("BP-2: a Regulated pilot on Growth with no add-on row warns once", async () => {
      const { job, ownerAlerts } = buildPilot([pilotRow()]);
      expect(await job.warnBillablePilotsEnding()).toEqual({ warned: 1 });
      expect(ownerAlerts.pilotEnding).toHaveBeenCalledTimes(1);
    });

    it("a TRIAL free period warns the same way", async () => {
      const { job, ownerAlerts } = buildPilot([pilotRow({ kind: "TRIAL" })]);
      expect(await job.warnBillablePilotsEnding()).toEqual({ warned: 1 });
      expect(ownerAlerts.pilotEnding).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["a paid", { addonKey: "tobacco_dealer", sku: "REGULATED_ITEMS", active: true }],
      ["a comp", { addonKey: "tobacco_dealer", sku: null, active: true }],
    ])("BP-3: an active %s add-on row holding the SKU sends nothing", async (_l, row) => {
      const { job, ownerAlerts, prisma } = buildPilot([pilotRow()], PRICED_CATALOG, {
        addonRows: [row],
      });
      expect(await job.warnBillablePilotsEnding()).toEqual({ warned: 0 });
      expect(ownerAlerts.pilotEnding).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("another live GRANT on the same feature keeps it served, so nothing is warned", async () => {
      const { job, ownerAlerts } = buildPilot([pilotRow()], PRICED_CATALOG, {
        otherOverrides: [{ featureKey: "tobacco_dealer", effect: "GRANT" }],
      });
      expect(await job.warnBillablePilotsEnding()).toEqual({ warned: 0 });
      expect(ownerAlerts.pilotEnding).not.toHaveBeenCalled();
    });

    it("a capacity SKU is out: its cost depends on how many are needed", async () => {
      const capacity = {
        id: "v-1",
        addonSkus: [
          {
            sku: "REGULATED_ITEMS",
            name: "Regulated items",
            monthlyPrice: "39.00",
            meteredKey: "CUSTOMERS",
            includedAtPlan: "SCALE",
          },
        ],
      };
      const { job, ownerAlerts } = buildPilot([pilotRow()], capacity);
      expect(await job.warnBillablePilotsEnding()).toEqual({ warned: 0 });
      expect(ownerAlerts.pilotEnding).not.toHaveBeenCalled();
    });

    it("a business whose plan cannot be resolved is skipped, not warned", async () => {
      const { job, ownerAlerts, entitlements } = buildPilot([pilotRow()]);
      entitlements.resolve.mockRejectedValue(new Error("no plan"));
      expect(await job.warnBillablePilotsEnding()).toEqual({ warned: 0 });
      expect(ownerAlerts.pilotEnding).not.toHaveBeenCalled();
    });
  });

  it("only reads the overrides: no revoke, no price or plan write", async () => {
    const { job, prisma } = buildPilot([pilotRow()]);
    await job.warnBillablePilotsEnding();
    expect(prisma.tenantFeatureOverride.update).toBeUndefined();
    expect(prisma.tenantFeatureOverride.updateMany).toBeUndefined();
  });

  it("if the audit row cannot be written, no mail goes out (at most once)", async () => {
    const { job, ownerAlerts, prisma } = buildPilot([pilotRow()]);
    prisma.auditLog.create.mockRejectedValueOnce(new Error("db down"));
    const out = await job.warnBillablePilotsEnding();
    expect(out).toEqual({ warned: 0 });
    expect(ownerAlerts.pilotEnding).not.toHaveBeenCalled();
  });

  it("one business whose catalog cannot be read does not stop the others", async () => {
    const a = pilotRow({ id: "ov-a" });
    const b = pilotRow({
      id: "ov-b",
      tenantId: "t2",
      tenant: { ...pilotRow().tenant, id: "t2", planVersionId: "v-broken" },
    });
    const { job, ownerAlerts, catalog } = buildPilot([b, a]);
    catalog.getVersionForTenant.mockImplementation(async (id: string) => {
      if (id === "v-broken") throw new Error("no catalog");
      return PRICED_CATALOG;
    });
    const out = await job.warnBillablePilotsEnding();
    expect(out).toEqual({ warned: 1 });
    expect(ownerAlerts.pilotEnding).toHaveBeenCalledWith("t1", expect.anything());
  });

  it("runs under the shared advisory lock, keyed by the pinned job name", async () => {
    const { job } = buildPilot([]);
    await job.warnBillablePilotsEnding();
    expect(withAdvisoryLockMock).toHaveBeenCalledWith(
      expect.objectContaining({
        family: "cron",
        key: "billing.warnBillablePilotsEnding",
        mode: "try",
      }),
      expect.any(Function),
    );
  });
});
