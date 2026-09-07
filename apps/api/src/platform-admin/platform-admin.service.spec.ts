import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { PlatformAdminService } from "./platform-admin.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { BillingService } from "../billing/billing.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { PlatformPricingService } from "../billing/platform-pricing.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { BillingEventService } from "../billing/billing-event.service";
import { MeterService } from "../billing/meter.service";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * P1 regression: platform-admin lifecycle mutations MUST emit a purpose-built
 * audit row keyed to the TARGET tenant (tenantId=target, userId=super-admin,
 * entityType="tenant", entityId=target, structured action code). Before this,
 * only the generic interceptor logged these with tenantId=null, so they never
 * surfaced under a per-tenant filter — and impersonation writes weren't logged
 * at all despite the controller claiming they were.
 */
describe("PlatformAdminService — audit provenance", () => {
  let service: PlatformAdminService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let auditLog: jest.Mock;
  let planCatalogService: { getPublishedVersion: jest.Mock };
  let entitlementsService: { resolve: jest.Mock; invalidate: jest.Mock };
  let billingEventService: { emit: jest.Mock };
  let meterService: { readAll: jest.Mock };
  let platformPricingService: { resolveTenantPricing: jest.Mock };

  const ADMIN_ID = "super-1";
  const TENANT_ID = "tenant-1";

  beforeEach(async () => {
    prisma = createMockPrisma();
    // createMockPrisma omits these two models; the service touches both.
    (prisma as any).tenantSubscription = {
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
    };
    (prisma as any).auditLog = {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    // createMockPrisma's default $transaction mock builds `tx` from its internal model
    // set, which — like the top level — omits tenantSubscription. updatePlan writes
    // both tenant and tenantSubscription inside one transaction, so extend tx to carry
    // it too (reusing the same mock instance the top-level assertions read from).
    (prisma.$transaction as jest.Mock).mockImplementation((fn: any) =>
      fn({ ...prisma, tenantSubscription: (prisma as any).tenantSubscription }),
    );

    auditLog = jest.fn().mockResolvedValue(undefined);
    // Default: unseeded catalog — MRR/entitlements tests override per-case.
    planCatalogService = { getPublishedVersion: jest.fn().mockResolvedValue(null) };
    entitlementsService = { resolve: jest.fn(), invalidate: jest.fn() };
    billingEventService = { emit: jest.fn().mockResolvedValue({}) };
    meterService = { readAll: jest.fn() };
    platformPricingService = { resolveTenantPricing: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformAdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { sign: jest.fn().mockReturnValue("signed.jwt") } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue({ secret: "s", expiresIn: "15m" }) },
        },
        { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: BillingService,
          useValue: {
            createCheckoutSession: jest.fn().mockRejectedValue(new Error("no stripe")),
            syncStripeSubscriptionPrice: jest.fn().mockResolvedValue({ synced: false }),
          },
        },
        { provide: PlanCatalogService, useValue: planCatalogService },
        { provide: PlatformPricingService, useValue: platformPricingService },
        { provide: EntitlementsService, useValue: entitlementsService },
        { provide: BillingEventService, useValue: billingEventService },
        { provide: MeterService, useValue: meterService },
        { provide: TenantStatusGuard, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: auditLog } },
      ],
    }).compile();

    service = module.get<PlatformAdminService>(PlatformAdminService);
  });

  it("logs TENANT_SUSPENDED against the target tenant with the acting admin", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
    prisma.tenant.update.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      status: "SUSPENDED",
    } as any);

    await service.updateStatus(TENANT_ID, { status: "SUSPENDED" } as any, ADMIN_ID);

    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        userId: ADMIN_ID,
        action: "TENANT_SUSPENDED",
        entityType: "tenant",
        entityId: TENANT_ID,
      }),
    );
  });

  it("maps a reactivation to TENANT_REACTIVATED", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
    prisma.tenant.update.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      status: "ACTIVE",
    } as any);

    await service.updateStatus(TENANT_ID, { status: "ACTIVE" } as any, ADMIN_ID);

    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "TENANT_REACTIVATED", tenantId: TENANT_ID }),
    );
  });

  it("logs TENANT_PLAN_CHANGED with the previous and new plan in meta, writes planKey/planVersionId consistent with subscribe(), and invalidates entitlements", async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      plan: "STARTER",
      status: "ACTIVE",
    } as any);
    prisma.tenant.update.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      plan: "PROFESSIONAL",
    } as any);
    planCatalogService.getPublishedVersion.mockResolvedValue({
      id: "v-9",
      definitions: [
        { planKey: "STARTER", monthlyPrice: 99 },
        { planKey: "GROWTH", monthlyPrice: 249 },
        { planKey: "SCALE", monthlyPrice: 499 },
        { planKey: "ENTERPRISE", monthlyPrice: null },
      ],
    });
    (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
      planKey: "STARTER",
      basePriceSnapshot: 99,
      priceOverrideMonthly: null,
      discount: null,
    });

    await service.updatePlan(TENANT_ID, { plan: "PROFESSIONAL" } as any, ADMIN_ID);

    // PROFESSIONAL normalizes to SCALE (planKeyFromEnum) — the write must carry the
    // catalog's resolved planKey + the published version id, the same shape
    // SubscriptionMutationService.subscribe() writes (subscription-mutation.service.ts:132-163).
    // basePriceSnapshot moves with planKey: MrrService prices from the snapshot alone, so a
    // stale/absent one would report SCALE tenants at the old plan's price (or $0).
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { plan: "PROFESSIONAL", planVersionId: "v-9" },
    });
    expect((prisma as any).tenantSubscription.upsert).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID },
      create: {
        tenantId: TENANT_ID,
        currentPlan: "PROFESSIONAL",
        planKey: "SCALE",
        planVersionId: "v-9",
        basePriceSnapshot: 499,
      },
      update: {
        currentPlan: "PROFESSIONAL",
        planKey: "SCALE",
        planVersionId: "v-9",
        basePriceSnapshot: 499,
        // A committing plan write disarms any scheduled downgrade (round 3, findings 2/9):
        // the 02:00 sweep filters on downgradeEffectiveAt alone, so one left armed would undo
        // this admin's change and deactivate every operator/driver over the target seat cap.
        downgradeToPlanKey: null,
        downgradeEffectiveAt: null,
        retainedUserIds: [],
      },
    });
    // …but it must NOT revoke a cancellation the tenant asked for — that is resume()'s job.
    expect((prisma as any).tenantSubscription.upsert.mock.calls[0][0].update).not.toHaveProperty(
      "cancelAtPeriodEnd",
    );
    expect(entitlementsService.invalidate).toHaveBeenCalledWith(TENANT_ID);

    // The snapshot run-rate moved $99 → $499, so the append-only ledger must move with it —
    // otherwise `mrr` and `ledgerMrr`/`momDelta` (mrr.service.ts:21-27) diverge by $400 forever.
    expect(billingEventService.emit).toHaveBeenCalledWith(
      TENANT_ID,
      "plan.changed",
      expect.objectContaining({ fromPlan: "STARTER", toPlan: "SCALE", platformAdmin: true }),
      expect.objectContaining({ amountDelta: 400, actorId: ADMIN_ID }),
    );

    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TENANT_PLAN_CHANGED",
        tenantId: TENANT_ID,
        userId: ADMIN_ID,
        meta: expect.objectContaining({ from: "STARTER", to: "PROFESSIONAL", platformAdmin: true }),
      }),
    );
  });

  it("prices a custom (ENTERPRISE) plan from the tenant's negotiated monthly fee, not $0", async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      plan: "STARTER",
      status: "ACTIVE",
    } as any);
    prisma.tenant.update.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      plan: "ENTERPRISE",
    } as any);
    planCatalogService.getPublishedVersion.mockResolvedValue({
      id: "v-9",
      definitions: [
        { planKey: "STARTER", monthlyPrice: 99 },
        { planKey: "ENTERPRISE", monthlyPrice: null, isCustom: true },
      ],
    });
    (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
      planKey: "STARTER",
      basePriceSnapshot: 99,
      priceOverrideMonthly: 1200,
      discount: null,
    });

    await service.updatePlan(TENANT_ID, { plan: "ENTERPRISE" } as any, ADMIN_ID);

    // The custom definition carries no catalog price; writing planKey with a null snapshot
    // would enter the tenant in the rollup at $0 base while its add-ons book MRR behind it.
    expect((prisma as any).tenantSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ planKey: "ENTERPRISE", basePriceSnapshot: 1200 }),
      }),
    );
    expect(billingEventService.emit).toHaveBeenCalledWith(
      TENANT_ID,
      "plan.changed",
      expect.anything(),
      expect.objectContaining({ amountDelta: 1101 }),
    );
  });

  it("books the add-ons of a plan-less ACTIVE tenant that this change makes paying", async () => {
    // Manual/external activation leaves planKey null, so neither the base nor the add-ons
    // counted (mrr.service.ts:60-66). Setting planKey crosses the tenant INTO the paying
    // set — the ledger delta is the whole contribution, add-ons and discount included.
    prisma.tenant.findUnique.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      plan: "STARTER",
      status: "ACTIVE",
    } as any);
    prisma.tenant.update.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      plan: "PROFESSIONAL",
    } as any);
    planCatalogService.getPublishedVersion.mockResolvedValue({
      id: "v-9",
      definitions: [{ planKey: "SCALE", monthlyPrice: 499 }],
    });
    (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
      planKey: null,
      basePriceSnapshot: null,
      priceOverrideMonthly: null,
      discount: 10,
    });
    prisma.tenantAddon.findMany.mockResolvedValue([
      { priceSnapshot: 39, quantity: 1 },
      { priceSnapshot: 15, quantity: 2 },
    ] as any);

    await service.updatePlan(TENANT_ID, { plan: "PROFESSIONAL" } as any, ADMIN_ID);

    // 499 base + (39 + 30) add-ons − 10 discount
    expect(billingEventService.emit).toHaveBeenCalledWith(
      TENANT_ID,
      "plan.changed",
      expect.objectContaining({ fromPlan: null, toPlan: "SCALE" }),
      expect.objectContaining({ amountDelta: 558 }),
    );
  });

  it("404s updatePlan when no published plan catalog exists, without writing or invalidating", async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      plan: "STARTER",
      status: "ACTIVE",
    } as any);
    planCatalogService.getPublishedVersion.mockResolvedValue(null);

    await expect(
      service.updatePlan(TENANT_ID, { plan: "PROFESSIONAL" } as any, ADMIN_ID),
    ).rejects.toThrow("No published plan catalog exists");

    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect((prisma as any).tenantSubscription.upsert).not.toHaveBeenCalled();
    expect(entitlementsService.invalidate).not.toHaveBeenCalled();
    expect(billingEventService.emit).not.toHaveBeenCalled();
  });

  it("activateManualSubscription disarms every pending transition when it rolls the period (round 3, findings 2/9)", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
    prisma.tenant.update.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      status: "ACTIVE",
      plan: "PROFESSIONAL",
    } as any);

    await service.activateManualSubscription(
      TENANT_ID,
      { plan: "PROFESSIONAL", billingPeriodDays: 30, paymentMethod: "BANK_TRANSFER" } as any,
      ADMIN_ID,
    );

    // A downgrade left armed now points at the OLD (already past) period end, so the very next
    // 02:00 sweep fires it against the subscription this admin just activated — re-pricing the
    // row and deactivating every operator/driver over the target plan's seat cap.
    expect((prisma as any).tenantSubscription.upsert.mock.calls[0][0].update).toMatchObject({
      cancelAtPeriodEnd: false,
      downgradeToPlanKey: null,
      downgradeEffectiveAt: null,
      retainedUserIds: [],
    });
  });

  it("price-override back-fills a null basePriceSnapshot for a custom plan and emits the run-rate delta", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
    (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
      priceOverrideMonthly: null,
      planKey: "ENTERPRISE",
      basePriceSnapshot: null,
    });

    await service.updateTenantPriceOverride(TENANT_ID, { monthly: 1200 } as any, ADMIN_ID);

    expect((prisma as any).tenantSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ basePriceSnapshot: 1200 }),
      }),
    );
    expect(billingEventService.emit).toHaveBeenCalledWith(
      TENANT_ID,
      "plan.changed",
      expect.objectContaining({ toPlan: "ENTERPRISE", priceOverrideBackfill: true }),
      expect.objectContaining({ amountDelta: 1200 }),
    );
  });

  it("price-override leaves a grandfathered basePriceSnapshot alone and emits nothing", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
    (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
      priceOverrideMonthly: 800,
      planKey: "ENTERPRISE",
      basePriceSnapshot: 900,
    });

    await service.updateTenantPriceOverride(TENANT_ID, { monthly: 1200 } as any, ADMIN_ID);

    const upsertArg = (prisma as any).tenantSubscription.upsert.mock.calls.at(-1)[0];
    expect(upsertArg.update.basePriceSnapshot).toBeUndefined();
    expect(billingEventService.emit).not.toHaveBeenCalled();
  });

  it("logs IMPERSONATION_STARTED — the controller's audit-logged claim is now true", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
    prisma.user.findFirst.mockResolvedValue({
      id: "admin-9",
      username: "acmeadmin",
      role: "TENANT_ADMIN",
      status: "ACTIVE",
      isAdmin: true,
      canActAsDriver: true,
    } as any);

    const res = await service.impersonate(TENANT_ID, ADMIN_ID);

    expect(res.accessToken).toBe("signed.jwt");
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        userId: ADMIN_ID,
        action: "IMPERSONATION_STARTED",
        entityType: "tenant",
        entityId: TENANT_ID,
        meta: expect.objectContaining({ impersonatedUserId: "admin-9" }),
      }),
    );
  });

  it("enriches audit rows with actionLabel + resolved actor/tenant, and leaves legacy rows raw", async () => {
    (prisma as any).auditLog.findMany.mockResolvedValue([
      {
        id: "log-1",
        tenantId: TENANT_ID,
        userId: "super-1",
        action: "TENANT_SUSPENDED",
        entityType: "tenant",
        entityId: TENANT_ID,
        ip: null,
        meta: {},
        createdAt: new Date(),
      },
      {
        id: "log-2",
        tenantId: null,
        userId: null,
        action: "PATCH /platform-admin/tenants/x/status",
        entityType: "platform-admin",
        entityId: "tenants",
        ip: null,
        meta: null,
        createdAt: new Date(),
      },
    ]);
    (prisma as any).auditLog.count.mockResolvedValue(2);
    prisma.user.findMany.mockResolvedValue([
      { id: "super-1", username: "aaron", email: "aaron@rf.co", role: "SUPER_ADMIN" },
    ] as any);
    prisma.tenant.findMany.mockResolvedValue([
      { id: TENANT_ID, slug: "acme", name: "Acme Corp" },
    ] as any);

    const res = await service.getAuditLogs({}, 1, 50);

    expect(res.data[0]).toEqual(
      expect.objectContaining({
        actionLabel: "Tenant suspended",
        actor: { id: "super-1", username: "aaron", email: "aaron@rf.co", isPlatform: true },
        tenant: { id: TENANT_ID, slug: "acme", name: "Acme Corp" },
      }),
    );
    // Legacy interceptor row: unknown action → no friendly label, no resolvable actor/tenant.
    expect(res.data[1].actionLabel).toBeNull();
    expect(res.data[1].actor).toBeNull();
    expect(res.data[1].tenant).toBeNull();
  });

  it("exposes known action facets for the filter dropdown", () => {
    const facets = service.getAuditLogFacets();
    expect(facets.actions.find((a) => a.code === "IMPERSONATION_STARTED")?.label).toBe(
      "Impersonation started",
    );
    expect(facets.actions.find((a) => a.code === "TENANT_PLAN_CHANGED")?.label).toBe(
      "Plan changed",
    );
  });

  describe("getStats enrichment", () => {
    it("computes estMrrUsd from basePriceSnapshot else the catalog price for the tenant's normalized planKey — a GROWTH tenant contributes its real price, never $0", async () => {
      prisma.tenant.findMany.mockImplementation((args: any) => {
        if (args?.where?.status?.not === "CANCELLED") {
          return Promise.resolve([
            // Grandfathered: keeps its pinned $59 snapshot even though the catalog
            // now prices STARTER at $99.
            {
              status: "ACTIVE",
              plan: "STARTER",
              subscription: { planKey: "STARTER", basePriceSnapshot: 59 },
            },
            // No snapshot; only the legacy `plan` enum. planKeyFromEnum("TEAM") now
            // maps to GROWTH (the v8 rename) — this is exactly what
            // STOPGAP_PLAN_MONTHLY_USD priced at $0.
            { status: "ACTIVE", plan: "TEAM", subscription: null },
            // TRIAL: counted in planBreakdown, excluded from MRR.
            { status: "TRIAL", plan: "STARTER", subscription: null },
          ]);
        }
        return Promise.resolve([]);
      });
      planCatalogService.getPublishedVersion.mockResolvedValue({
        definitions: [
          { planKey: "STARTER", monthlyPrice: 99 },
          { planKey: "GROWTH", monthlyPrice: 249 },
          { planKey: "SCALE", monthlyPrice: 499 },
          { planKey: "ENTERPRISE", monthlyPrice: null },
        ],
      });

      const stats = await service.getStats();

      expect(stats.estMrrUsd).toBe(59 + 249);
      expect(stats.planBreakdown).toEqual({ STARTER: 2, GROWTH: 1 });
    });

    it("prices tenants against a still-published legacy catalog — TEAM/BUSINESS rows answer GROWTH/SCALE lookups", async () => {
      prisma.tenant.findMany.mockImplementation((args: any) => {
        if (args?.where?.status?.not === "CANCELLED") {
          return Promise.resolve([
            { status: "ACTIVE", plan: "TEAM", subscription: null },
            { status: "ACTIVE", plan: "PROFESSIONAL", subscription: null },
          ]);
        }
        return Promise.resolve([]);
      });
      // The publish script is a manual post-deploy step: until it runs, the
      // published version is still keyed TEAM/BUSINESS.
      planCatalogService.getPublishedVersion.mockResolvedValue({
        definitions: [
          { planKey: "STARTER", monthlyPrice: 59 },
          { planKey: "TEAM", monthlyPrice: 149 },
          { planKey: "BUSINESS", monthlyPrice: 349 },
          { planKey: "ENTERPRISE", monthlyPrice: null },
        ],
      });

      const stats = await service.getStats();

      expect(stats.estMrrUsd).toBe(149 + 349);
      expect(stats.planBreakdown).toEqual({ GROWTH: 1, SCALE: 1 });
    });

    it("attaches userCount to trials and a human riskReason to at-risk tenants", async () => {
      prisma.tenant.findMany.mockImplementation((args: any) => {
        if (args?.where?.status === "TRIAL") {
          return Promise.resolve([
            {
              id: "t-trial",
              slug: "trial",
              name: "Trial Co",
              plan: "STARTER",
              trialEndsAt: new Date(),
              createdAt: new Date(),
              _count: { users: 4 },
            },
          ]);
        }
        if (args?.where?.OR) {
          return Promise.resolve([
            {
              id: "t-susp",
              slug: "susp",
              name: "Susp Co",
              status: "SUSPENDED",
              plan: "STARTER",
              trialEndsAt: null,
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const stats = await service.getStats();
      expect(stats.trialsExpiringSoon[0].userCount).toBe(4);
      expect(stats.atRiskTenants[0].riskReason).toBe("Suspended");
    });
  });

  describe("listTenants filters", () => {
    it("hides deleted by default, builds a search OR + explicit sort, returns deletedCount", async () => {
      prisma.tenant.findMany.mockResolvedValue([]);
      // count() is called twice: filtered total, then the global soft-deleted count.
      prisma.tenant.count.mockResolvedValueOnce(5).mockResolvedValueOnce(3);

      const result = await service.listTenants(1, 20, {
        search: "acme",
        status: "ACTIVE",
        plan: "STARTER",
        sortKey: "slug",
        sortDir: "asc",
      });

      const args = (prisma.tenant.findMany as jest.Mock).mock.calls.at(-1)![0];
      expect(args.where.deletedAt).toBeNull();
      expect(args.where.status).toBe("ACTIVE");
      expect(args.where.plan).toBe("STARTER");
      expect(args.where.OR).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ slug: { contains: "acme", mode: "insensitive" } }),
        ]),
      );
      expect(args.orderBy).toEqual({ slug: "asc" });
      expect(result.meta.total).toBe(5);
      expect(result.meta.deletedCount).toBe(3);
    });

    it("includes deleted (no deletedAt filter) when requested", async () => {
      prisma.tenant.findMany.mockResolvedValue([]);
      prisma.tenant.count.mockResolvedValue(0);
      await service.listTenants(1, 20, { includeDeleted: true });
      const args = (prisma.tenant.findMany as jest.Mock).mock.calls.at(-1)![0];
      expect(args.where.deletedAt).toBeUndefined();
    });
  });

  describe("getTenantEntitlements", () => {
    it("returns flags, addons, caps, and the resolved planKey from EntitlementsService plus meter usage from MeterService", async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, slug: "acme" } as any);
      entitlementsService.resolve.mockResolvedValue({
        tenantId: TENANT_ID,
        planKey: "GROWTH",
        flags: ["flag.returns", "flag.reports"],
        addons: ["BUYER_PORTAL"],
        caps: { seats: 10, routes: 3, scans: 100, msgs: 200 },
      });
      meterService.readAll.mockResolvedValue([
        { meter: "SEATS", used: 4, included: 10, remaining: 6, resetsAt: null },
      ]);

      const result = await service.getTenantEntitlements(TENANT_ID);

      expect(result).toEqual({
        planKey: "GROWTH",
        flags: ["flag.returns", "flag.reports"],
        addons: ["BUYER_PORTAL"],
        caps: { seats: 10, routes: 3, scans: 100, msgs: 200 },
        usage: [{ meter: "SEATS", used: 4, included: 10, remaining: 6, resetsAt: null }],
      });
      expect(entitlementsService.resolve).toHaveBeenCalledWith(TENANT_ID);
      expect(meterService.readAll).toHaveBeenCalledWith(TENANT_ID);
    });

    it("404s for a tenant that doesn't exist, without calling the entitlements/meter services", async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);

      await expect(service.getTenantEntitlements("nope")).rejects.toThrow("Tenant nope not found");
      expect(entitlementsService.resolve).not.toHaveBeenCalled();
      expect(meterService.readAll).not.toHaveBeenCalled();
    });
  });
});
