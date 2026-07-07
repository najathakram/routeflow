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
});
