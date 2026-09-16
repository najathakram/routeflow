/**
 * users.service.spec.ts
 * ─────────────────────
 * Unit tests for UsersService.findAll — verifies that the method returns
 * { data, meta } (the paginated shape that the mobile Settings → Users tab
 * expects), not a bare array. Regression guard for NEW-vop-3.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { UsersService } from "./users.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

const MOCK_USERS = [
  {
    id: "user-1",
    username: "admin",
    email: "admin@example.com",
    role: "OPERATOR",
    status: "ACTIVE",
    forcePasswordChange: false,
    isAdmin: true,
    canActAsDriver: false,
    createdAt: new Date("2026-01-01"),
  },
  {
    id: "user-2",
    username: "driver_tom",
    email: "tom@example.com",
    role: "DRIVER",
    status: "ACTIVE",
    forcePasswordChange: false,
    isAdmin: false,
    canActAsDriver: true,
    createdAt: new Date("2026-01-02"),
  },
];

describe("UsersService", () => {
  let service: UsersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let email: {
    sendSetPasswordEmail: jest.Mock;
    sendEmailChangedNotice: jest.Mock;
    sendEmailChangeConfirmation: jest.Mock;
    sendRoleChangedNotice: jest.Mock;
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    email = {
      sendSetPasswordEmail: jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" }),
      sendEmailChangedNotice: jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" }),
      sendEmailChangeConfirmation: jest
        .fn()
        .mockResolvedValue({ delivered: true, transport: "smtp" }),
      sendRoleChangedNotice: jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" }),
    };
    const config = {
      get: () => ({ web: "https://app.example.com", mobileWeb: "https://m.example.com" }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: email },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  describe("findAll", () => {
    it("returns { data, meta } — not a bare array", async () => {
      prisma.forTenant().user.findMany.mockResolvedValue(MOCK_USERS as any);
      prisma.forTenant().user.count.mockResolvedValue(2);

      const result = await service.findAll({});

      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("meta");
      expect(Array.isArray(result.data)).toBe(true);
    });

    it("data array contains the users returned by prisma", async () => {
      prisma.forTenant().user.findMany.mockResolvedValue(MOCK_USERS as any);
      prisma.forTenant().user.count.mockResolvedValue(2);

      const result = await service.findAll({});

      expect(result.data).toHaveLength(2);
      expect(result.data[0].username).toBe("admin");
    });

    it("meta.total reflects the prisma count", async () => {
      prisma.forTenant().user.findMany.mockResolvedValue(MOCK_USERS as any);
      prisma.forTenant().user.count.mockResolvedValue(2);

      const result = await service.findAll({});

      expect(result.meta.total).toBe(2);
    });

    it("meta.totalPages is ceil(total / limit)", async () => {
      // 5 users, limit=2 → 3 pages
      prisma.forTenant().user.findMany.mockResolvedValue(MOCK_USERS as any);
      prisma.forTenant().user.count.mockResolvedValue(5);

      const result = await service.findAll({ limit: 2 });

      expect(result.meta.totalPages).toBe(3);
    });

    it("passes skip correctly for page 2", async () => {
      prisma.forTenant().user.findMany.mockResolvedValue([]);
      prisma.forTenant().user.count.mockResolvedValue(0);

      await service.findAll({ page: 2, limit: 10 });

      const findManyCall = prisma.forTenant().user.findMany.mock.calls[0][0] as any;
      expect(findManyCall.skip).toBe(10);
    });

    it("excludes CUSTOMER role from the query", async () => {
      prisma.forTenant().user.findMany.mockResolvedValue([]);
      prisma.forTenant().user.count.mockResolvedValue(0);

      await service.findAll({});

      const findManyCall = prisma.forTenant().user.findMany.mock.calls[0][0] as any;
      expect(findManyCall.where?.role).toEqual({ not: "CUSTOMER" });
    });
  });

  // ─── Cross-tenant fallback lookups ──────────────────────────────────────────
  //
  // Regression coverage (review of PR #778): an earlier version of this fix
  // dropped `status: "ACTIVE"` from these queries so an INACTIVE self-signup
  // user could reach a distinguishable EMAIL_NOT_VERIFIED error in
  // auth.service.ts's validateUser(). That signal was reverted (UserStatus
  // has no column distinguishing "never verified" from "an admin deactivated
  // this account," so it can't be surfaced safely — see auth.service.spec.ts),
  // so there is no longer any reason to widen this lookup past ACTIVE. Kept
  // filtered: an ACTIVE user whose email also exists on a deactivated account
  // in another tenant must resolve to exactly one match, not two.
  describe("findByEmailCrossTenant", () => {
    it("filters to status:ACTIVE — a deactivated account with the same email in another tenant must not create a false ambiguity", async () => {
      prisma.user.findMany.mockResolvedValue([{ id: "u1", email: "owner@acme.example" }] as any);

      const result = await service.findByEmailCrossTenant("owner@acme.example");

      expect(result).toEqual({ id: "u1", email: "owner@acme.example" });
      const call = prisma.user.findMany.mock.calls[0][0] as any;
      expect(call.where).toMatchObject({ status: "ACTIVE", deletedAt: null });
    });

    it("returns null when 0 or 2+ ACTIVE matches (ambiguous)", async () => {
      prisma.user.findMany.mockResolvedValue([]);
      expect(await service.findByEmailCrossTenant("nobody@nowhere.example")).toBeNull();

      prisma.user.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }] as any);
      expect(await service.findByEmailCrossTenant("shared@example.com")).toBeNull();
    });
  });

  describe("findByUsernameCrossTenant", () => {
    it("filters to status:ACTIVE", async () => {
      prisma.user.findMany.mockResolvedValue([{ id: "u2", username: "acme_admin" }] as any);

      const result = await service.findByUsernameCrossTenant("acme_admin");

      expect(result).toEqual({ id: "u2", username: "acme_admin" });
      const call = prisma.user.findMany.mock.calls[0][0] as any;
      expect(call.where).toMatchObject({ status: "ACTIVE" });
    });
  });

  // ─── N2: account + invite emails ────────────────────────────────────────────

  describe("createOperator — staff invite set-password email", () => {
    it("creates a single-use 72h PasswordResetToken and emails a set-password link", async () => {
      prisma.user.findFirst.mockResolvedValue(null); // no email/username collision
      prisma.user.create.mockResolvedValue({
        id: "u-new",
        username: "acme_op",
        email: "op@acme.example",
        role: "OPERATOR",
        status: "ACTIVE",
        forcePasswordChange: true,
      } as any);

      await service.createOperator({ email: "op@acme.example", username: "acme_op" } as any);

      expect(prisma.passwordResetToken.create).toHaveBeenCalledTimes(1);
      const tokenData = prisma.passwordResetToken.create.mock.calls[0][0].data;
      expect(tokenData.userId).toBe("u-new");
      expect(tokenData.tokenHash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex, never the raw token
      const ttlMs = tokenData.expiresAt.getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(71 * 60 * 60 * 1000);
      expect(ttlMs).toBeLessThanOrEqual(72 * 60 * 60 * 1000);

      expect(email.sendSetPasswordEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: "op@acme.example", username: "acme_op", expiryHours: 72 }),
      );
      expect(email.sendSetPasswordEmail.mock.calls[0][0].setPasswordUrl).toContain(
        "https://app.example.com/reset-password?token=",
      );
    });

    it("still returns the created user + tempPassword when the email fails to send", async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({
        id: "u-new",
        username: "acme_op",
        email: "op@acme.example",
      } as any);
      email.sendSetPasswordEmail.mockRejectedValue(new Error("smtp down"));

      const result = await service.createOperator({
        email: "op@acme.example",
        username: "acme_op",
      } as any);

      expect(result.user.id).toBe("u-new");
      expect(result.tempPassword).toMatch(/^[0-9A-F]{6}-[0-9A-F]{6}$/);
    });
  });

  describe("resetPassword — admin-triggered, same set-password link email", () => {
    it("emails the same set-password link as createOperator", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        username: "acme_op",
        email: "op@acme.example",
      } as any);

      await service.resetPassword("u1");

      expect(email.sendSetPasswordEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: "op@acme.example", username: "acme_op" }),
      );
    });

    it("skips the email (not the password reset) when the user has no email on file", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        username: "no_email_user",
        email: "",
      } as any);

      const result = await service.resetPassword("u1");

      expect(email.sendSetPasswordEmail).not.toHaveBeenCalled();
      expect(result.tempPassword).toBeDefined();
    });
  });

  describe("updateUser — email-change dual notice", () => {
    it("notifies the OLD address and confirms the NEW address when email changes", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        username: "acme_op",
        email: "old@acme.example",
        role: "OPERATOR",
      } as any);
      prisma.user.update.mockResolvedValue({
        id: "u1",
        username: "acme_op",
        email: "new@acme.example",
        role: "OPERATOR",
        status: "ACTIVE",
        isAdmin: false,
        canActAsDriver: false,
      } as any);

      await service.updateUser("u1", { email: "new@acme.example" } as any);

      expect(email.sendEmailChangedNotice).toHaveBeenCalledWith(
        expect.objectContaining({ to: "old@acme.example", newEmail: "new@acme.example" }),
      );
      expect(email.sendEmailChangeConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({ to: "new@acme.example" }),
      );
    });

    it("sends NO email-change notice when email is unchanged", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        username: "acme_op",
        email: "same@acme.example",
        role: "OPERATOR",
      } as any);
      prisma.user.update.mockResolvedValue({
        id: "u1",
        username: "acme_op",
        email: "same@acme.example",
        role: "OPERATOR",
      } as any);

      await service.updateUser("u1", { email: "same@acme.example", username: "renamed" } as any);

      expect(email.sendEmailChangedNotice).not.toHaveBeenCalled();
      expect(email.sendEmailChangeConfirmation).not.toHaveBeenCalled();
    });

    it("the update still succeeds when both notice emails fail to send", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        username: "acme_op",
        email: "old@acme.example",
        role: "OPERATOR",
      } as any);
      prisma.user.update.mockResolvedValue({
        id: "u1",
        username: "acme_op",
        email: "new@acme.example",
        role: "OPERATOR",
      } as any);
      email.sendEmailChangedNotice.mockRejectedValue(new Error("smtp down"));

      const result = await service.updateUser("u1", { email: "new@acme.example" } as any);

      expect(result.email).toBe("new@acme.example");
    });
  });

  describe("updateUser — role-change notice", () => {
    it("names the old role, new role, and who changed it", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        username: "acme_driver",
        email: "driver@acme.example",
        role: "DRIVER",
      } as any);
      prisma.user.update.mockResolvedValue({
        id: "u1",
        username: "acme_driver",
        email: "driver@acme.example",
        role: "OPERATOR",
        status: "ACTIVE",
        isAdmin: false,
        canActAsDriver: true,
      } as any);

      await service.updateUser("u1", { role: "OPERATOR" } as any, "acme_tenant_admin");

      expect(email.sendRoleChangedNotice).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "driver@acme.example",
          oldRole: "DRIVER",
          newRole: "OPERATOR",
          changedBy: "acme_tenant_admin",
        }),
      );
    });

    it("falls back to 'an administrator' when no caller username is passed", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        username: "acme_driver",
        email: "driver@acme.example",
        role: "DRIVER",
      } as any);
      prisma.user.update.mockResolvedValue({
        id: "u1",
        username: "acme_driver",
        email: "driver@acme.example",
        role: "OPERATOR",
      } as any);

      await service.updateUser("u1", { role: "OPERATOR" } as any);

      expect(email.sendRoleChangedNotice).toHaveBeenCalledWith(
        expect.objectContaining({ changedBy: "an administrator" }),
      );
    });

    it("sends NO role-change notice when role is unchanged", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        username: "acme_op",
        email: "op@acme.example",
        role: "OPERATOR",
      } as any);
      prisma.user.update.mockResolvedValue({
        id: "u1",
        username: "acme_op",
        email: "op@acme.example",
        role: "OPERATOR",
      } as any);

      await service.updateUser("u1", { role: "OPERATOR", username: "renamed" } as any);

      expect(email.sendRoleChangedNotice).not.toHaveBeenCalled();
    });
  });
});
