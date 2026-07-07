import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { PlatformAdminService } from "./platform-admin.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { BillingService } from "../billing/billing.service";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { estimatePlatformMrrUsd, addonMonthlyUsd } from "./plan-pricing.constant";

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

  const ADMIN_ID = "super-1";
  const TENANT_ID = "tenant-1";

  beforeEach(async () => {
    prisma = createMockPrisma();
    // createMockPrisma omits these two models; the service touches both.
    (prisma as any).tenantSubscription = { upsert: jest.fn().mockResolvedValue({}) };
    (prisma as any).auditLog = {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };

    auditLog = jest.fn().mockResolvedValue(undefined);

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
          useValue: { createCheckoutSession: jest.fn().mockRejectedValue(new Error("no stripe")) },
        },
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

  it("logs TENANT_PLAN_CHANGED with the previous and new plan in meta", async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      plan: "STARTER",
    } as any);
    prisma.tenant.update.mockResolvedValue({
      id: TENANT_ID,
      slug: "acme",
      plan: "PROFESSIONAL",
    } as any);

    await service.updatePlan(TENANT_ID, { plan: "PROFESSIONAL" } as any, ADMIN_ID);

    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TENANT_PLAN_CHANGED",
        tenantId: TENANT_ID,
        userId: ADMIN_ID,
        meta: expect.objectContaining({ from: "STARTER", to: "PROFESSIONAL", platformAdmin: true }),
      }),
    );
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
    beforeEach(() => {
      (prisma.tenant as any).groupBy = jest.fn().mockResolvedValue([
        { plan: "STARTER", _count: { plan: 2 } },
        { plan: "PROFESSIONAL", _count: { plan: 1 } },
      ]);
    });

    it("computes stopgap estMrrUsd from the plan breakdown", async () => {
      const stats = await service.getStats();
      expect(stats.estMrrUsd).toBe(2 * 29 + 79); // 137
      expect(stats.planBreakdown).toEqual({ STARTER: 2, PROFESSIONAL: 1 });
      // MRR is computed from an ACTIVE-only groupBy; the donut excludes cancelled.
      const groupByArgs = ((prisma.tenant as any).groupBy as jest.Mock).mock.calls.map((c) => c[0]);
      expect(groupByArgs.some((a) => a?.where?.status?.not === "CANCELLED")).toBe(true);
      expect(groupByArgs.some((a) => a?.where?.status === "ACTIVE")).toBe(true);
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

  describe("estimatePlatformMrrUsd", () => {
    it("sums plan counts × stopgap prices and ignores unknown plans", () => {
      expect(estimatePlatformMrrUsd({ STARTER: 2, PROFESSIONAL: 1, ENTERPRISE: 1 })).toBe(
        2 * 29 + 79 + 199,
      );
      expect(estimatePlatformMrrUsd({ MYSTERY: 5 })).toBe(0);
      expect(estimatePlatformMrrUsd({})).toBe(0);
    });

    it("addonMonthlyUsd sums known add-on keys and ignores unknown ones", () => {
      expect(addonMonthlyUsd(["regulated_items", "ai_scanning"])).toBe(39 + 19);
      expect(addonMonthlyUsd(["nope"])).toBe(0);
      expect(addonMonthlyUsd([])).toBe(0);
    });
  });

  describe("getBillingOverview", () => {
    beforeEach(() => {
      (prisma.tenant as any).groupBy = jest
        .fn()
        .mockResolvedValue([{ plan: "PROFESSIONAL", _count: { plan: 1 } }]);
      (prisma as any).tenantSubscription = {
        findMany: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
      };
    });

    it("computes per-row base/addon/mrr (active-only), cycle, and rolled-up est MRR", async () => {
      const now = Date.now();
      (prisma as any).tenantSubscription.findMany
        .mockResolvedValueOnce([
          {
            tenantId: "t1",
            currentPlan: "PROFESSIONAL",
            periodStart: new Date(now - 365 * 864e5),
            periodEnd: new Date(now + 30 * 864e5),
            cancelAtPeriodEnd: false,
            stripeCustomerId: "cus_1",
            tenant: {
              id: "t1",
              slug: "acme",
              name: "Acme",
              status: "ACTIVE",
              plan: "PROFESSIONAL",
              trialEndsAt: null,
              addons: [{ addonKey: "regulated_items" }],
            },
          },
        ])
        .mockResolvedValueOnce([]); // past-due list
      prisma.tenant.count.mockResolvedValue(3);
      prisma.tenantAddon.findMany.mockResolvedValue([{ addonKey: "regulated_items" }] as any);

      const res = await service.getBillingOverview({ page: 1, limit: 20 });

      expect(res.subscriptions[0]).toMatchObject({
        baseMonthly: 79,
        addonMonthly: 39,
        mrr: 118,
        cycle: "Annual",
      });
      expect(res.baseMrr).toBe(79);
      expect(res.addonRevenue).toBe(39);
      expect(res.estMrr).toBe(118);
      expect(res.pastDue).toEqual({ count: 0, amount: 0 });
      expect(res.meta.total).toBe(1);
    });

    it("zeroes MRR for a non-active (trial) subscription row", async () => {
      (prisma as any).tenantSubscription.findMany
        .mockResolvedValueOnce([
          {
            tenantId: "t2",
            currentPlan: "PROFESSIONAL",
            periodStart: null,
            periodEnd: null,
            cancelAtPeriodEnd: false,
            stripeCustomerId: null,
            tenant: {
              id: "t2",
              slug: "trialco",
              name: "Trial Co",
              status: "TRIAL",
              plan: "PROFESSIONAL",
              trialEndsAt: new Date(),
              addons: [{ addonKey: "regulated_items" }],
            },
          },
        ])
        .mockResolvedValueOnce([]);
      prisma.tenant.count.mockResolvedValue(0);
      prisma.tenantAddon.findMany.mockResolvedValue([] as any);

      const res = await service.getBillingOverview({});
      expect(res.subscriptions[0]).toMatchObject({ baseMonthly: 0, addonMonthly: 0, mrr: 0 });
    });
  });
});
