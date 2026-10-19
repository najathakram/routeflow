/**
 * SA-815 B1 / SA-785 / SA-786 - the harm fix, end to end, real Postgres.
 *
 * SA-785: a GROWTH -> SCALE upgrade switched the tenant's (legacy-keyed) `tobacco_dealer` add-on OFF, so the
 * regulated route guard answered 403 ADDON_GATE and both compliance crons skipped the tenant. SA-786 keeps an
 * included add-on ON at $0. This spec sets the tenant up THROUGH the upgrade path (never by inserting the end
 * state) and then proves, on the real tables:
 *   1. the regulated route guard allows (HTTP 200 through the real `AddonGuard` -> `AddonService` -> Postgres),
 *   2. the regulated filing cron's real eligibility predicate includes the tenant (it prepares its category),
 *   3. the monthly tobacco report cron's real eligibility predicate includes the tenant (it generates for it).
 *
 * Red on master: the upgrade wrote `active:false`, so 1 answered 403 and 2/3 never reached the tenant.
 * Throwaway `qa-*` tenants (assertTestTenant). The advisory cron lock is a pass-through (ticks are invoked
 * directly); both sweeps scan the whole scratch database, so every assertion is scoped to this run's tenant.
 */
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  withAdvisoryLocks: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { randomUUID } from "crypto";
import request from "supertest";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { listenOnLoopback } from "../common/testing/listen-loopback";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { RegulatedController } from "../regulated/regulated.controller";
import { RegulatedService } from "../regulated/regulated.service";
import { RegulatedFilingService } from "../regulated/regulated-filing.service";
import { RegulatedReportService } from "../regulated/regulated-report.service";
import { ParkedReversalResolutionService } from "../regulated/parked-reversal-resolution.service";
import { RegulatedFilingCronService } from "../regulated/regulated-filing-cron.service";
import { TobaccoReportService } from "../tobacco/tobacco-report.service";
import { AddonGuard } from "./addon.guard";
import { AddonService } from "./addon.service";
import { EntitlementsService } from "./entitlements.service";
import { listenOnLoopback } from "../common/testing/listen-loopback";
import { FeatureOverrideService } from "./feature-override.service";
import { BillingEventService } from "./billing-event.service";
import { ProrationService } from "./proration.service";
import { SubscriptionMutationService } from "./subscription-mutation.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "scale-upgrade-regulated.db.spec.ts";
const DAY = 24 * 60 * 60 * 1000;

describeDb(
  "SA-815 B1: a SCALE tenant holding tobacco_dealer keeps its regulated access (real Postgres)",
  () => {
    let pool: Pool;
    let prisma: PrismaClient;
    let mutation: SubscriptionMutationService;
    let addons: AddonService;
    let app: INestApplication;
    let versionId: string;
    let createdVersionId: string | undefined;
    const run = randomUUID().slice(0, 8);
    const tenantIds: string[] = [];
    let tenantId: string;
    let categoryId: string;

    const prepareFiling = jest.fn().mockResolvedValue(undefined);
    const ranTenants: string[] = [];
    const tenantCtx: any = {
      run: (id: string, fn: () => Promise<unknown>) => {
        ranTenants.push(id);
        return fn();
      },
    };

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);

      const published = await prisma.planVersion.findFirst({ where: { status: "PUBLISHED" } });
      if (published) {
        versionId = published.id;
      } else {
        const version =
          ((await prisma.planVersion.aggregate({ _max: { version: true } }))._max.version ?? 0) + 1;
        const created = await prisma.planVersion.create({
          data: {
            version,
            status: "PUBLISHED",
            publishedAt: new Date(),
            notes: `qa fixture - ${SPEC}`,
          },
        });
        createdVersionId = versionId = created.id;
      }
      // The plan graph under test: the regulated pack is bundled at SCALE and above.
      const catalog = {
        id: versionId,
        definitions: [
          {
            planKey: "GROWTH",
            name: "Growth",
            monthlyPrice: 249,
            annualPrice: null,
            isCustom: false,
          },
          {
            planKey: "SCALE",
            name: "Scale",
            monthlyPrice: 499,
            annualPrice: null,
            isCustom: false,
          },
        ],
        addonSkus: [
          {
            sku: "REGULATED_ITEMS",
            name: "Regulated items",
            monthlyPrice: 39,
            includedAtPlan: "SCALE",
          },
        ],
      };
      const catalogService = {
        getPublishedCatalog: () => Promise.resolve(catalog),
        getVersionForTenant: () => Promise.resolve(catalog),
      } as any;
      const events = new BillingEventService(prisma as any);
      mutation = new SubscriptionMutationService(
        prisma as any,
        catalogService,
        new ProrationService(prisma as any, catalogService),
        { getSubscription: jest.fn().mockResolvedValue(undefined) } as any,
        { invalidate: jest.fn() } as any,
        events,
        { invalidate: jest.fn() } as any,
        {} as any, // stripe: a manual-pay tenant has no subscription to push to
        { notifyUpgradeConfirmed: jest.fn().mockResolvedValue(undefined) } as any,
        {
          prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
          onPlanChange: () => Promise.resolve({ action: "none" }),
          transactionOptions: () => undefined,
          invalidateCaches: () => undefined,
        } as any,
      );
      addons = new AddonService(
        prisma as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        events,
        {} as any,
      );

      // The tenant arrives at SCALE THROUGH the upgrade path: GROWTH, manual-pay, a priced legacy-keyed row.
      const slug = assertTestTenant(`qa-sa815-b1-${run}`, SPEC);
      const tenant = await prisma.tenant.create({
        data: {
          slug,
          name: slug,
          class: TenantClass.PRODUCTION,
          status: TenantStatus.ACTIVE,
          planVersionId: versionId,
        },
      });
      tenantId = tenant.id;
      tenantIds.push(tenant.id);
      await prisma.tenantSubscription.create({
        data: {
          tenantId: tenant.id,
          planKey: "GROWTH",
          planVersionId: versionId,
          basePriceSnapshot: 249,
          discount: 0,
          cycle: "MONTHLY",
          periodStart: new Date(Date.now() - 15 * DAY),
          periodEnd: new Date(Date.now() + 15 * DAY),
          externalPayment: true,
        },
      });
      await prisma.tenantAddon.create({
        data: {
          tenantId: tenant.id,
          addonKey: "tobacco_dealer",
          sku: null,
          quantity: 1,
          priceSnapshot: 39,
          active: true,
        },
      });
      categoryId = (
        await prisma.trackedCategory.create({
          data: { tenantId: tenant.id, name: `qa-sa815-b1-${run}`, active: true },
        })
      ).id;

      await mutation.upgrade(tenant.id, "SCALE", "admin-sa815-b1");

      // The real route guard in front of the real regulated controller.
      const noop = { run: jest.fn() };
      const moduleRef = await Test.createTestingModule({
        controllers: [RegulatedController],
        providers: [
          AddonGuard,
          { provide: AddonService, useValue: addons },
          {
            provide: EntitlementsService,
            useValue: { isAlwaysEnforcedTenant: jest.fn().mockResolvedValue(false) },
          },
          {
            provide: FeatureOverrideService,
            useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
          },
          {
            provide: RegulatedService,
            useValue: { getLedger: jest.fn().mockResolvedValue({ rows: [] }) },
          },
          { provide: RegulatedFilingService, useValue: noop },
          { provide: RegulatedReportService, useValue: noop },
          { provide: ParkedReversalResolutionService, useValue: noop },
        ],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue({
          canActivate: (ctx: any) => {
            const req = ctx.switchToHttp().getRequest();
            req.user = { tenantId: req.headers["x-test-tenant"], role: "OPERATOR" };
            return true;
          },
        })
        .overrideGuard(RolesGuard)
        .useValue({ canActivate: () => true })
        .compile();
      app = moduleRef.createNestApplication();
      await app.init();
      await listenOnLoopback(app);
    });

    afterAll(async () => {
      await app?.close();
      if (tenantIds.length) {
        await prisma.trackedCategory.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.billingEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenantAddon.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      }
      if (createdVersionId) await prisma.planVersion.delete({ where: { id: createdVersionId } });
      await prisma?.$disconnect();
      await pool?.end();
    });

    it("the upgrade left the row ON at $0 (the set-up this spec depends on)", async () => {
      const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId } });
      expect(sub.planKey).toBe("SCALE");
      const row = await prisma.tenantAddon.findFirstOrThrow({ where: { tenantId } });
      expect([row.active, Number(row.priceSnapshot)]).toEqual([true, 0]);
    }, 60_000);

    it("the regulated route guard allows: GET /regulated/ledger answers 200, not 403 ADDON_GATE", async () => {
      const res = await request(app.getHttpServer())
        .get("/regulated/ledger")
        .set("x-test-tenant", tenantId);
      // Master: 403 {code: ADDON_GATE} - the SCALE upgrade had switched the row off.
      expect(res.status).toBe(200);
      // and a tenant WITHOUT the pack is still refused by the same guard (the guard is real, not a pass-through)
      const other = await request(app.getHttpServer())
        .get("/regulated/ledger")
        .set("x-test-tenant", randomUUID());
      expect(other.status).toBe(403);
    }, 60_000);

    it("the regulated filing cron's real eligibility predicate includes the tenant (it prepares the tenant's category)", async () => {
      const cron = new RegulatedFilingCronService(
        {
          trackedCategory: prisma.trackedCategory,
          tenantAddon: prisma.tenantAddon,
          tenant: prisma.tenant,
          forTenant: () => ({ regulatedFiling: { findFirst: async () => null } }),
        } as any,
        tenantCtx,
        { prepareFiling } as any,
      );
      await cron.autoPrepareClosedFilings();
      expect(prepareFiling).toHaveBeenCalledWith(
        expect.objectContaining({ trackedCategoryId: categoryId, userId: null }),
      );
    }, 60_000);

    it("the monthly tobacco report cron's real eligibility predicate includes the tenant (it generates for it)", async () => {
      const reports = new TobaccoReportService(
        {
          tenant: prisma.tenant,
          tenantAddon: prisma.tenantAddon,
          forTenant: () => ({ tobaccoReport: { findFirst: async () => null } }),
        } as any,
        {} as any,
        {} as any,
        tenantCtx,
      );
      const generate = jest.spyOn(reports, "generateForPeriod").mockResolvedValue(undefined as any);
      ranTenants.length = 0;
      await reports.generateMonthlyReports();
      expect(ranTenants).toContain(tenantId);
      expect(generate).toHaveBeenCalled();
    }, 60_000);
  },
);
