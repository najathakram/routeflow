// REG-B1197: back office "Extend Trial" on an ACTIVE tenant set its status to TRIAL unconditionally. The wrong value is a paying
// tenant row that reads TRIAL afterwards. Both server paths that can write TRIAL (extendTrial, the status PATCH) must leave an
// ACTIVE tenant ACTIVE and answer 409 TENANT_TRIAL_EXTEND_NOT_ALLOWED (activeTenantTrialRefusal, platform-admin.service.ts).
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));
jest.mock("../billing/needs-reconcile", () =>
  require("../testing/needs-reconcile-mock").needsReconcileMock(),
);
import { ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { PlatformAdminService } from "./platform-admin.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { BillingService } from "../billing/billing.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { ProrationService } from "../billing/proration.service";
import { PlatformPricingService } from "../billing/platform-pricing.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { BillingEventService } from "../billing/billing-event.service";
import { MeterService } from "../billing/meter.service";
import { MrrService } from "../billing/mrr.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PlanTransitionConfigService } from "../billing/plan-transition-config.service";
import { StripeService } from "../billing/stripe.service";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { TenantMirrorService } from "./tenant-mirror.service";
import { DunningService } from "../billing/dunning.service";

describe("REG-B1197: an ACTIVE tenant is never moved to TRIAL", () => {
  const TENANT_ID = "tenant-1";
  const ADMIN_ID = "super-1";
  const OLD_END = new Date("2026-01-01T00:00:00.000Z");
  let service: PlatformAdminService;
  let prisma: ReturnType<typeof createMockPrisma>;
  // The stored row: the mocks below apply writes to it the way the database would, predicate included.
  let row: { status: string; trialEndsAt: Date };

  beforeEach(async () => {
    row = { status: "ACTIVE", trialEndsAt: OLD_END };
    prisma = createMockPrisma();
    (prisma as any).tenantSubscription = {
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    };
    (prisma as any).rfInvoice = {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    (prisma as any).auditLog = {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    };
    (prisma.$transaction as jest.Mock).mockImplementation((fn: any) =>
      fn({ ...prisma, tenantSubscription: (prisma as any).tenantSubscription }),
    );
    prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
    prisma.tenant.findUniqueOrThrow.mockImplementation((async () => ({
      id: TENANT_ID,
      slug: "acme",
      plan: "STARTER",
      readOnlyReason: null,
      class: "PRODUCTION",
      deletedAt: null,
      subscription: null,
      ...row,
    })) as any);
    prisma.tenant.updateMany.mockImplementation((async (args: any) => {
      const not = args?.where?.status?.not;
      if (not !== undefined && not === row.status) return { count: 0 };
      Object.assign(row, args.data);
      return { count: 1 };
    }) as any);
    prisma.tenant.update.mockImplementation((async (args: any) => {
      Object.assign(row, args.data);
      return { id: TENANT_ID, slug: "acme", plan: "STARTER", ...row };
    }) as any);

    const module = await Test.createTestingModule({
      providers: [
        PlatformAdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { sign: jest.fn().mockReturnValue("signed.jwt") } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue({}) } },
        {
          provide: EmailService,
          useValue: { send: jest.fn(), sendTenantWelcomeEmail: jest.fn() },
        },
        { provide: BillingService, useValue: {} },
        {
          provide: PlanCatalogService,
          useValue: { getPublishedVersion: jest.fn().mockResolvedValue(null) },
        },
        { provide: ProrationService, useValue: { proratedDiff: jest.fn().mockReturnValue(0) } },
        { provide: PlatformPricingService, useValue: { resolveTenantPricing: jest.fn() } },
        { provide: EntitlementsService, useValue: { resolve: jest.fn(), invalidate: jest.fn() } },
        { provide: BillingEventService, useValue: { emit: jest.fn().mockResolvedValue({}) } },
        { provide: MeterService, useValue: { readAll: jest.fn() } },
        { provide: TenantStatusGuard, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: MrrService,
          useValue: {
            computeOverview: jest.fn(),
            priceTenant: jest.fn(),
            priceSubscription: jest.fn(),
          },
        },
        {
          provide: TenantMirrorService,
          useValue: { upsert: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: FeatureOverrideService,
          useValue: { allActive: jest.fn().mockResolvedValue(new Map()) },
        },
        {
          provide: PlanTransitionConfigService,
          useValue: {
            isEnabled: jest.fn().mockResolvedValue(true),
            prepare: jest.fn().mockResolvedValue({ enabled: true, planAllows: null }),
            onPlanChange: jest.fn().mockResolvedValue({ action: "none" }),
            transactionOptions: jest.fn().mockReturnValue(undefined),
            invalidateCaches: jest.fn(),
          },
        },
        { provide: StripeService, useValue: { isConfigured: false } },
        { provide: DunningService, useValue: { clearPauseAfterCommit: jest.fn() } },
      ],
    }).compile();
    service = module.get(PlatformAdminService);
  });

  const expectRefused = (err: unknown) => {
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: "TENANT_TRIAL_EXTEND_NOT_ALLOWED",
    });
  };

  it("REG-B1197: extendTrial on an ACTIVE tenant answers 409 and the row stays ACTIVE with its old end date", async () => {
    const err = await service.extendTrial(TENANT_ID, 30, ADMIN_ID).catch((e) => e);
    expectRefused(err);
    expect(row).toEqual({ status: "ACTIVE", trialEndsAt: OLD_END });
  });

  it("REG-B1197: the status PATCH ACTIVE -> TRIAL answers 409 and the row stays ACTIVE", async () => {
    const err = await service
      .updateStatus(TENANT_ID, { status: "TRIAL" } as any, ADMIN_ID)
      .catch((e) => e);
    expectRefused(err);
    expect(row.status).toBe("ACTIVE");
  });

  it("REG-B1197: a SUSPENDED tenant is still extended to TRIAL (the refusal is ACTIVE only)", async () => {
    row.status = "SUSPENDED";
    await service.extendTrial(TENANT_ID, 30, ADMIN_ID);
    expect(row.status).toBe("TRIAL");
    expect(row.trialEndsAt.getTime()).toBeGreaterThan(OLD_END.getTime());
  });
});
