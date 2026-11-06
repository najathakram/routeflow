/**
 * F03 slice 2 (SA-1096), real Postgres: a scheduled downgrade that is over the new seat cap deactivates the people
 * it frees, and burns exactly THEIR live set-password / reset links in the same transaction. The cron's unit spec
 * mocks the transaction, so a burn aimed at the wrong people (the whole tenant instead of the freed list) passes
 * there. Here the real sweep runs over one admin, one retained operator, two freed people and a bystander in another
 * tenant: only the freed two lose their links.
 *
 * The advisory cron lock is a pass-through (the sweep is invoked directly). Real PlanCatalogService and
 * BillingEventService; meters, notifications and the snapshot hook are stubbed. The tenant is pinned to its own
 * throwaway catalog version, so the seat cap is the one this spec writes and a shared published catalog is never
 * touched. Throwaway `qa-*` tenants; afterAll deletes exactly what it made.
 */
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { createHash, randomUUID } from "crypto";
import { PrismaClient, TenantStatus, UserRole, UserStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { BillingCronService } from "./billing-cron.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { BillingEventService } from "./billing-event.service";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "billing-cron-seat-cap-links.db.spec.ts";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

describeDb("a seat-cap downgrade burns the freed people's links and only theirs", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let cron: BillingCronService;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let pinnedVersionId: string | undefined;
  let createdPublishedId: string | undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    createdPublishedId = await ensurePublishedCatalog(
      prisma,
      {
        plans: [
          { planKey: "STARTER", name: "Starter", monthlyPrice: 99 },
          { planKey: "GROWTH", name: "Growth", monthlyPrice: 249 },
        ],
        addons: [],
      },
      SPEC,
    );
    const version =
      ((await prisma.planVersion.aggregate({ _max: { version: true } }))._max.version ?? 0) + 1;
    const pinned = await prisma.planVersion.create({
      data: {
        version,
        status: "SUPERSEDED",
        notes: `qa fixture - ${SPEC}`,
        definitions: {
          create: [
            {
              planKey: "STARTER",
              name: "Starter",
              monthlyPrice: 99,
              seatsIncluded: 2,
              featureFlags: [],
            },
            { planKey: "GROWTH", name: "Growth", monthlyPrice: 249, featureFlags: [] },
          ],
        },
      },
    });
    pinnedVersionId = pinned.id;
    const noop = { invalidate: jest.fn() } as any;
    cron = new BillingCronService(
      prisma as any,
      new BillingEventService(prisma as any),
      noop,
      noop,
      new PlanCatalogService(prisma as any),
      { read: jest.fn() } as any,
      {
        notifyTrialEnding: jest.fn().mockResolvedValue(undefined),
        notifyDowngradeApplied: jest.fn().mockResolvedValue(undefined),
      } as any,
      {
        isEnabled: () => Promise.resolve(false),
        prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
        onPlanChange: () => Promise.resolve({ action: "none" }),
        transactionOptions: () => undefined,
        invalidateCaches: () => undefined,
      } as any,
      {} as any,
      {} as any,
    );
  }, 120_000);

  afterAll(async () => {
    if (tenantIds.length) {
      await prisma.billingEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.user.deleteMany({ where: { tenantId: { in: tenantIds } } }); // tokens cascade
      await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    if (pinnedVersionId) {
      await prisma.planDefinition.deleteMany({ where: { planVersionId: pinnedVersionId } });
      await prisma.planVersion.delete({ where: { id: pinnedVersionId } });
    }
    await dropPublishedCatalog(prisma, createdPublishedId);
    await prisma?.$disconnect();
    await pool?.end();
  }, 120_000);

  const mkTenant = async (label: string) => {
    const slug = assertTestTenant(`qa-seatcap-${run}-${label}`, SPEC);
    const t = await prisma.tenant.create({
      data: { slug, name: slug, status: TenantStatus.ACTIVE, planVersionId: pinnedVersionId },
    });
    tenantIds.push(t.id);
    return t.id;
  };
  const mkUser = async (tenantId: string, name: string, role: UserRole) => {
    const u = await prisma.user.create({
      data: {
        tenantId,
        username: `${name}-${run}`,
        email: `${name}-${run}@example.invalid`,
        role,
        status: UserStatus.ACTIVE,
      },
    });
    await prisma.passwordResetToken.create({
      data: {
        userId: u.id,
        tokenHash: hash(`link-${u.id}`),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return u.id;
  };
  const liveLinks = (userId: string) =>
    prisma.passwordResetToken.count({ where: { userId, usedAt: null } });

  it("S12: over the cap, the freed operators and drivers lose their links; the admin, the retained and another tenant keep theirs", async () => {
    const t = await mkTenant("a");
    const other = await mkTenant("b");
    const admin = await mkUser(t, "admin", UserRole.TENANT_ADMIN);
    const retained = await mkUser(t, "retained", UserRole.OPERATOR);
    const freedOp = await mkUser(t, "freedop", UserRole.OPERATOR);
    const freedDriver = await mkUser(t, "freeddrv", UserRole.DRIVER);
    const bystander = await mkUser(other, "bystander", UserRole.OPERATOR);
    await prisma.tenantSubscription.create({
      data: {
        tenantId: t,
        planKey: "GROWTH",
        planVersionId: pinnedVersionId,
        basePriceSnapshot: 249,
        discount: 0,
        downgradeToPlanKey: "STARTER",
        downgradeEffectiveAt: new Date(Date.now() - 24 * 3_600_000),
        retainedUserIds: [retained],
      } as any,
    });

    await cron.applyScheduledDowngrades();

    const status = async (id: string) =>
      (await prisma.user.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(freedOp)).toBe("INACTIVE");
    expect(await status(freedDriver)).toBe("INACTIVE");
    expect(await status(retained)).toBe("ACTIVE");
    expect(await status(admin)).toBe("ACTIVE");

    expect(await liveLinks(freedOp)).toBe(0);
    expect(await liveLinks(freedDriver)).toBe(0);
    expect(await liveLinks(retained)).toBe(1);
    expect(await liveLinks(admin)).toBe(1);
    expect(await liveLinks(bystander)).toBe(1);
  });
});
