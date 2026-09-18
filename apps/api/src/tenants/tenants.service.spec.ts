import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { ConflictException } from "@nestjs/common";
import { TenantsService } from "./tenants.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { EncryptionService } from "../common/encryption.service";
import { StorageService } from "../storage/storage.service";
import { EmailService } from "../email/email.service";

/**
 * Repro-first coverage for the self-service tenant signup email-honesty bug:
 * `TenantsService.register()`/`resendVerification()` used to `await
 * this.email.send(...)` inside a bare `try { ... } catch { /* best-effort *\/ }`
 * and never looked at the result. EmailService.send() is documented to never
 * throw for a delivery failure — it returns `{delivered: false, ...}` instead
 * — so a real failure (RESEND_API_KEY unset, Resend rejection, tenant SMTP
 * unreachable) was invisible everywhere: not logged, not returned to the
 * caller, not surfaced to the frontend. The self-registered admin's User row
 * stayed `status: INACTIVE` forever with zero signal, while
 * PlatformAdminService.createTenant() sets `status: ACTIVE` immediately —
 * which is exactly why "signup from super admin works" but self-service
 * signup silently didn't. This file did not exist before this fix (the
 * self-service registration path had zero test coverage).
 */
describe("TenantsService", () => {
  let service: TenantsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let email: { send: jest.Mock };

  const REGISTER_DTO = {
    slug: "acme-distribution",
    businessName: "Acme Distribution",
    adminEmail: "owner@acme.example",
    adminUsername: "acme_admin",
    adminPassword: "Sup3rSecret!",
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    // Nobody else exists yet — slug/username both free.
    (prisma.tenant.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    // createMockPrisma()'s generic `create` default resolves `{}` regardless
    // of input — echo the write back (id + given fields) like real Prisma
    // does, since register()'s result shape depends on what tenant.create /
    // user.create returned.
    let tenantSeq = 0;
    (prisma.tenant.create as jest.Mock).mockImplementation(({ data }: any) => ({
      id: `tenant-${++tenantSeq}`,
      ...data,
    }));
    let userSeq = 0;
    (prisma.user.create as jest.Mock).mockImplementation(({ data }: any) => ({
      id: `user-${++userSeq}`,
      ...data,
    }));
    // B556: register() now creates a TenantSubscription row (with a resolved planKey)
    // alongside the tenant — createMockPrisma() doesn't model this table by default, and its
    // default $transaction mock closes over the model set from BEFORE this ad-hoc addition, so
    // the transaction callback's `tx` needs its own override to see it (same pattern as
    // platform-admin.service.spec.ts).
    (prisma as any).tenantSubscription = { create: jest.fn().mockResolvedValue({}) };
    (prisma.$transaction as jest.Mock).mockImplementation((fn: any) =>
      fn({ ...prisma, tenantSubscription: (prisma as any).tenantSubscription }),
    );

    email = { send: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EncryptionService, useValue: {} },
        { provide: StorageService, useValue: {} },
        { provide: EmailService, useValue: email },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === "WEB_URL") return "https://app.test";
              if (key === "jwt.secret") return "test-secret";
              return undefined;
            }),
          },
        },
        { provide: JwtService, useValue: { sign: jest.fn().mockReturnValue("mock.jwt.token") } },
      ],
    }).compile();

    service = module.get<TenantsService>(TenantsService);
  });

  describe("register", () => {
    it("creates the tenant+user and reports emailSent:true when delivery succeeds", async () => {
      email.send.mockResolvedValue({ delivered: true, transport: "resend", id: "msg-1" });

      const result = await service.register(REGISTER_DTO);

      expect(result.tenant.slug).toBe("acme-distribution");
      expect(result.user.email).toBe("owner@acme.example");
      expect(result.emailSent).toBe(true);
      expect(email.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: "owner@acme.example", senderClass: "platform" }),
      );
    });

    it("still creates the account but reports emailSent:false when delivery fails — THE BUG: this used to be silently discarded", async () => {
      email.send.mockResolvedValue({
        delivered: false,
        transport: "none",
        error: "RESEND_API_KEY not configured",
      });
      const loggerErrorSpy = jest.spyOn((service as any).logger, "error");

      const result = await service.register(REGISTER_DTO);

      // Registration must not fail over a mail-transport problem — the account
      // row is already committed.
      expect(result.tenant.slug).toBe("acme-distribution");
      // The honest signal that used to not exist at all.
      expect(result.emailSent).toBe(false);
      // And it must be loud server-side, not merely swallowed.
      expect(loggerErrorSpy).toHaveBeenCalledWith(expect.stringContaining("NOT delivered"));
    });

    it("reports emailSent:false and logs when EmailService.send itself throws", async () => {
      email.send.mockRejectedValue(new Error("ECONNREFUSED"));
      const loggerErrorSpy = jest.spyOn((service as any).logger, "error");

      const result = await service.register(REGISTER_DTO);

      expect(result.tenant.slug).toBe("acme-distribution");
      expect(result.emailSent).toBe(false);
      expect(loggerErrorSpy).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
    });

    it("rejects a taken slug before touching email", async () => {
      (prisma.tenant.findUnique as jest.Mock).mockResolvedValue({ id: "existing" });
      await expect(service.register(REGISTER_DTO)).rejects.toBeInstanceOf(ConflictException);
      expect(email.send).not.toHaveBeenCalled();
    });

    // B556: this used to create ONLY the Tenant row (plan: "STARTER") with no matching
    // TenantSubscription — MrrService.computeOverview() gates MRR on
    // TenantSubscription.planKey, not Tenant.plan, so a tenant that later gets activated
    // without ever passing through the "Change Plan" admin action would show a real plan on
    // its Tenant.plan badge while contributing exactly $0 to MRR forever. Repro-first: this
    // assertion fails against the pre-fix register(), which never touches
    // tx.tenantSubscription at all.
    it("B556 creates a TenantSubscription row with planKey resolved from the STARTER default, alongside the tenant", async () => {
      email.send.mockResolvedValue({ delivered: true, transport: "resend" });

      await service.register(REGISTER_DTO);

      expect((prisma as any).tenantSubscription.create).toHaveBeenCalledWith({
        data: {
          tenantId: expect.stringMatching(/^tenant-/),
          currentPlan: "STARTER",
          planKey: "STARTER",
        },
      });
    });

    it("creates the admin user as INACTIVE regardless of email outcome (gates login until verified)", async () => {
      email.send.mockResolvedValue({ delivered: true, transport: "resend" });
      await service.register(REGISTER_DTO);
      const createCall = (prisma.user.create as jest.Mock).mock.calls[0][0];
      expect(createCall.data.status).toBe("INACTIVE");
    });
  });

  describe("resendVerification", () => {
    const PENDING_USER = {
      id: "user-1",
      email: "owner@acme.example",
      username: "acme_admin",
      status: "INACTIVE",
      deletedAt: null,
      tenant: { id: "tenant-1", name: "Acme Distribution", slug: "acme-distribution" },
    };

    it("returns true and dispatches the email for a real pending account", async () => {
      (prisma.user.findFirst as jest.Mock).mockResolvedValue(PENDING_USER);
      email.send.mockResolvedValue({ delivered: true, transport: "resend" });

      const sent = await service.resendVerification("owner@acme.example");

      expect(sent).toBe(true);
      expect(email.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: "owner@acme.example", senderClass: "platform" }),
      );
    });

    it("returns false without calling email.send for a non-existent/already-verified address (enumeration-safe)", async () => {
      (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
      const sent = await service.resendVerification("nobody@nowhere.example");
      expect(sent).toBe(false);
      expect(email.send).not.toHaveBeenCalled();
    });

    it("returns false and logs when delivery fails for a real pending account — previously silent", async () => {
      (prisma.user.findFirst as jest.Mock).mockResolvedValue(PENDING_USER);
      email.send.mockResolvedValue({ delivered: false, transport: "none", error: "no transport" });
      const loggerErrorSpy = jest.spyOn((service as any).logger, "error");

      const sent = await service.resendVerification("owner@acme.example");

      expect(sent).toBe(false);
      expect(loggerErrorSpy).toHaveBeenCalledWith(expect.stringContaining("NOT delivered"));
    });
  });
});
