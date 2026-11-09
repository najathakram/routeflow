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
    sendEmailChangeLink: jest.Mock;
    sendEmailChangeRequestedNotice: jest.Mock;
    sendRoleChangedNotice: jest.Mock;
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.refreshToken.count.mockResolvedValue(0); // B461: no session row unless a row says so
    email = {
      sendSetPasswordEmail: jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" }),
      sendEmailChangedNotice: jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" }),
      sendEmailChangeConfirmation: jest
        .fn()
        .mockResolvedValue({ delivered: true, transport: "smtp" }),
      sendEmailChangeLink: jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" }),
      sendEmailChangeRequestedNotice: jest
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

  describe("findByUsername", () => {
    it("N2 review fix (#811): matches email case-insensitively — neither web nor mobile lowercases the login identifier before sending", async () => {
      prisma.user.findFirst.mockResolvedValue({ id: "u1", email: "acme_owner@example.com" } as any);

      await service.findByUsername("Acme_Owner@Example.com", "tenant-1");

      const call = prisma.user.findFirst.mock.calls[0][0] as any;
      expect(call.where.OR[1]).toEqual({
        email: { equals: "Acme_Owner@Example.com", mode: "insensitive" },
        tenantId: "tenant-1",
      });
    });

    it("keeps username matching exact (case-sensitive) — usernames are not normalized anywhere in this codebase", async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await service.findByUsername("Acme_Owner", "tenant-1");

      const call = prisma.user.findFirst.mock.calls[0][0] as any;
      expect(call.where.OR[0]).toEqual({ username: "Acme_Owner", tenantId: "tenant-1" });
    });
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
        status: "ACTIVE",
        deletedAt: null,
      } as any);

      await service.resetPassword("u1", "OPERATOR" as any);

      expect(email.sendSetPasswordEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: "op@acme.example", username: "acme_op" }),
      );
    });

    it("N2 review fix: never emails a set-password link for a deactivated/deleted account", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        username: "suspended_op",
        email: "suspended@acme.example",
        status: "SUSPENDED",
        deletedAt: null,
      } as any);

      const result = await service.resetPassword("u1", "OPERATOR" as any);

      expect(email.sendSetPasswordEmail).not.toHaveBeenCalled();
      expect(result.tempPassword).toBeDefined(); // the reset itself still happens
    });

    it("N2 review fix: never emails a set-password link for a soft-deleted account", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        username: "deleted_op",
        email: "deleted@acme.example",
        status: "ACTIVE",
        deletedAt: new Date("2026-01-01"),
      } as any);

      await service.resetPassword("u1", "OPERATOR" as any);

      expect(email.sendSetPasswordEmail).not.toHaveBeenCalled();
    });

    it("skips the email (not the password reset) when the user has no email on file", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        username: "no_email_user",
        email: "",
        status: "ACTIVE",
        deletedAt: null,
      } as any);

      const result = await service.resetPassword("u1", "OPERATOR" as any);

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
        lastLoginAt: null, // B461: never signed in, so the email is written at once
        createdAt: new Date("2026-10-01T00:00:00Z"),
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

      await service.updateUser(
        "u1",
        { email: "new@acme.example" } as any,
        undefined,
        "OPERATOR" as any,
      );

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
        lastLoginAt: null, // B461: never signed in, so the email is written at once
        createdAt: new Date("2026-10-01T00:00:00Z"),
      } as any);
      prisma.user.update.mockResolvedValue({
        id: "u1",
        username: "acme_op",
        email: "same@acme.example",
        role: "OPERATOR",
      } as any);

      await service.updateUser(
        "u1",
        { email: "same@acme.example", username: "renamed" } as any,
        undefined,
        "OPERATOR" as any,
      );

      expect(email.sendEmailChangedNotice).not.toHaveBeenCalled();
      expect(email.sendEmailChangeConfirmation).not.toHaveBeenCalled();
    });

    it("the update still succeeds when both notice emails fail to send", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        username: "acme_op",
        email: "old@acme.example",
        role: "OPERATOR",
        lastLoginAt: null, // B461: never signed in, so the email is written at once
        createdAt: new Date("2026-10-01T00:00:00Z"),
      } as any);
      prisma.user.update.mockResolvedValue({
        id: "u1",
        username: "acme_op",
        email: "new@acme.example",
        role: "OPERATOR",
      } as any);
      email.sendEmailChangedNotice.mockRejectedValue(new Error("smtp down"));

      const result = await service.updateUser(
        "u1",
        { email: "new@acme.example" } as any,
        undefined,
        "OPERATOR" as any,
      );

      expect(result.email).toBe("new@acme.example");
    });

    it("N2 review fix (#811): invalidates any outstanding set-password/reset token when the email changes, so a link mailed to a mistyped address stops working", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        username: "acme_op",
        email: "typo@acme.example",
        role: "OPERATOR",
        lastLoginAt: null, // B461: never signed in, so the email is written at once
        createdAt: new Date("2026-10-01T00:00:00Z"),
      } as any);
      prisma.user.update.mockResolvedValue({
        id: "u1",
        username: "acme_op",
        email: "corrected@acme.example",
        role: "OPERATOR",
        forcePasswordChange: false,
      } as any);

      await service.updateUser(
        "u1",
        { email: "corrected@acme.example" } as any,
        undefined,
        "OPERATOR" as any,
      );

      // burned with the write, in the same transaction (raw SQL: reset + verification tables)
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
      expect(prisma.txExecuteRaw).toHaveBeenCalledTimes(3);
      for (const call of prisma.txExecuteRaw.mock.calls) expect(call.slice(1)).toEqual([["u1"]]);
      expect(String(prisma.txExecuteRaw.mock.calls[0][0])).toContain("PasswordResetToken");
      // B461: a write at once also burns a pending change of the same user
      expect(String(prisma.txExecuteRaw.mock.calls[2][0])).toContain("UserEmailChange");
    });

    it("N2 review fix (#811): sends a fresh set-password invite to the corrected address when the user never set their own password", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        username: "acme_op",
        email: "typo@acme.example",
        role: "OPERATOR",
        lastLoginAt: null, // B461: never signed in, so the email is written at once
        createdAt: new Date("2026-10-01T00:00:00Z"),
      } as any);
      prisma.user.update.mockResolvedValue({
        id: "u1",
        username: "acme_op",
        email: "corrected@acme.example",
        role: "OPERATOR",
        status: "ACTIVE", // the update's select returns it; only an ACTIVE account is mailed an invite (SA-1096)
        forcePasswordChange: true, // never completed the invite flow
      } as any);

      await service.updateUser(
        "u1",
        { email: "corrected@acme.example" } as any,
        undefined,
        "OPERATOR" as any,
      );

      expect(email.sendSetPasswordEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: "corrected@acme.example", username: "acme_op" }),
      );
    });

    it("N2 review fix (#811): does NOT re-invite when the user already has their own password", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        username: "acme_op",
        email: "old@acme.example",
        role: "OPERATOR",
        lastLoginAt: null, // B461: never signed in, so the email is written at once
        createdAt: new Date("2026-10-01T00:00:00Z"),
      } as any);
      prisma.user.update.mockResolvedValue({
        id: "u1",
        username: "acme_op",
        email: "new@acme.example",
        role: "OPERATOR",
        forcePasswordChange: false, // already set their own password
      } as any);

      await service.updateUser(
        "u1",
        { email: "new@acme.example" } as any,
        undefined,
        "OPERATOR" as any,
      );

      expect(email.sendSetPasswordEmail).not.toHaveBeenCalled();
    });
  });

  // B461 (SA-1116): an email edit on an account that has signed in waits for the new address. The rows that prove it
  // against a real database are in email-change-b461.db.spec.ts; these pin the branch itself.
  describe("updateUser — held email change (B461)", () => {
    const signedIn = {
      id: "u1",
      username: "acme_op",
      email: "old@acme.example",
      role: "OPERATOR",
      status: "ACTIVE",
      lastLoginAt: new Date("2026-11-01T00:00:00Z"),
      createdAt: new Date("2026-10-01T00:00:00Z"),
    };
    const afterUpdate = {
      ...signedIn,
      isAdmin: false,
      canActAsDriver: false,
      forcePasswordChange: false,
    };

    it("does not write the email, writes one pending row, mails the link to the NEW address and a masked notice to the OLD one", async () => {
      prisma.user.findUnique.mockResolvedValue(signedIn as any);
      prisma.user.update.mockResolvedValue(afterUpdate as any);

      const res = await service.updateUser(
        "u1",
        { email: "New@Acme.example" } as any,
        "ad",
        "TENANT_ADMIN" as any,
        undefined,
        "admin-1",
      );

      expect(prisma.user.update.mock.calls[0][0].data).toEqual({});
      expect(res.email).toBe("old@acme.example");
      expect(res.pendingEmail).toBe("new@acme.example");
      // the User row lock, one burn of the older rows, one insert; none is the typed client (no tenantId on the table)
      const sql = prisma.txExecuteRaw.mock.calls.map((c: any[]) => String(c[0]));
      expect(sql).toHaveLength(3);
      expect(sql[0]).toContain('FROM "User"');
      expect(sql[0]).toContain("FOR UPDATE");
      expect(sql[1]).toContain('UPDATE "UserEmailChange"');
      expect(sql[2]).toContain('INSERT INTO "UserEmailChange"');
      expect(prisma.txExecuteRaw.mock.calls[2]).toEqual(
        expect.arrayContaining(["u1", "old@acme.example", "new@acme.example", "admin-1"]),
      );
      expect(email.sendEmailChangeLink).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "new@acme.example",
          confirmUrl: expect.stringMatching(
            /^https:\/\/app\.example\.com\/confirm-email-change\?token=[0-9a-f]{64}$/,
          ),
          expiryHours: 24,
        }),
      );
      expect(email.sendEmailChangeRequestedNotice).toHaveBeenCalledWith({
        to: "old@acme.example",
        username: "acme_op",
        maskedNewEmail: "n***@a***.example",
      });
      // the at-once notices are for an email that was written; this one was not
      expect(email.sendEmailChangedNotice).not.toHaveBeenCalled();
      expect(email.sendEmailChangeConfirmation).not.toHaveBeenCalled();
    });

    it("a username edit in the same request still applies at once", async () => {
      prisma.user.findUnique.mockResolvedValue(signedIn as any);
      prisma.user.update.mockResolvedValue(afterUpdate as any);

      await service.updateUser(
        "u1",
        { email: "new@acme.example", username: "renamed" } as any,
        "ad",
        "TENANT_ADMIN" as any,
      );

      expect(prisma.user.update.mock.calls[0][0].data).toEqual({ username: "renamed" });
    });

    it("a role change in the same request burns the account's links BEFORE the pending row is written", async () => {
      prisma.user.findUnique.mockResolvedValue(signedIn as any);
      prisma.user.update.mockResolvedValue(afterUpdate as any);

      await service.updateUser(
        "u1",
        { email: "new@acme.example", role: "DRIVER" } as any,
        "ad",
        "TENANT_ADMIN" as any,
      );

      const sql = prisma.txExecuteRaw.mock.calls.map((c: any[]) => String(c[0]));
      const insertAt = sql.findIndex((q: string) => q.includes('INSERT INTO "UserEmailChange"'));
      expect(insertAt).toBe(sql.length - 1);
      expect(sql.slice(0, insertAt).some((q: string) => q.includes("PasswordResetToken"))).toBe(
        true,
      );
    });

    it("an account that never logged a sign-in but is older than the reliable stamp holds (B461 reader M1)", async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...signedIn,
        lastLoginAt: null,
        createdAt: new Date("2026-09-01T00:00:00Z"),
      } as any);
      prisma.user.update.mockResolvedValue(afterUpdate as any);

      const res = await service.updateUser(
        "u1",
        { email: "new@acme.example" } as any,
        "ad",
        "TENANT_ADMIN" as any,
      );

      expect(prisma.user.update.mock.calls[0][0].data).toEqual({});
      expect(res.pendingEmail).toBe("new@acme.example");
    });

    it("an account with no sign-in stamp but a refresh-token row holds: refresh() never stamps it", async () => {
      prisma.user.findUnique.mockResolvedValue({ ...signedIn, lastLoginAt: null } as any);
      prisma.refreshToken.count.mockResolvedValue(1);
      prisma.user.update.mockResolvedValue(afterUpdate as any);

      const res = await service.updateUser(
        "u1",
        { email: "new@acme.example" } as any,
        "ad",
        "TENANT_ADMIN" as any,
      );

      expect(prisma.refreshToken.count).toHaveBeenCalledWith({ where: { userId: "u1" } });
      expect(prisma.user.update.mock.calls[0][0].data).toEqual({});
      expect(res.pendingEmail).toBe("new@acme.example");
    });

    it("a new address another live user already holds is refused at the request, nothing written or mailed", async () => {
      prisma.user.findUnique.mockResolvedValue(signedIn as any);
      prisma.forTenant().user.findFirst.mockResolvedValue({ id: "u9" } as any);

      await expect(
        service.updateUser(
          "u1",
          { email: "Taken@Acme.example" } as any,
          "ad",
          "TENANT_ADMIN" as any,
        ),
      ).rejects.toMatchObject({ response: { code: "EMAIL_TAKEN" } });

      expect(prisma.forTenant().user.findFirst).toHaveBeenCalledWith({
        where: {
          id: { not: "u1" },
          deletedAt: null,
          email: { equals: "taken@acme.example", mode: "insensitive" },
        },
        select: { id: true },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.txExecuteRaw).not.toHaveBeenCalled();
      expect(email.sendEmailChangeLink).not.toHaveBeenCalled();
    });

    it("the row records the address as it stands under the lock, not the pre-transaction read", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(signedIn as any)
        .mockResolvedValueOnce({ email: "moved@acme.example" } as any);
      prisma.user.update.mockResolvedValue(afterUpdate as any);

      await service.updateUser(
        "u1",
        { email: "new@acme.example" } as any,
        "ad",
        "TENANT_ADMIN" as any,
      );

      const insert = prisma.txExecuteRaw.mock.calls.find((c: any[]) =>
        String(c[0]).includes('INSERT INTO "UserEmailChange"'),
      );
      expect(insert).toEqual(expect.arrayContaining(["moved@acme.example", "new@acme.example"]));
      expect(insert).not.toContain("old@acme.example");
    });

    it("a user nobody has a login time for (unknown) holds, never writes", async () => {
      prisma.user.findUnique.mockResolvedValue({ ...signedIn, lastLoginAt: undefined } as any);
      prisma.user.update.mockResolvedValue(afterUpdate as any);

      const res = await service.updateUser(
        "u1",
        { email: "new@acme.example" } as any,
        "ad",
        "TENANT_ADMIN" as any,
      );

      expect(prisma.user.update.mock.calls[0][0].data).toEqual({});
      expect(res.pendingEmail).toBe("new@acme.example");
    });

    it("the update still succeeds when the mails fail to send, and the row stays", async () => {
      prisma.user.findUnique.mockResolvedValue(signedIn as any);
      prisma.user.update.mockResolvedValue(afterUpdate as any);
      email.sendEmailChangeLink.mockRejectedValue(new Error("smtp down"));

      const res = await service.updateUser(
        "u1",
        { email: "new@acme.example" } as any,
        "ad",
        "TENANT_ADMIN" as any,
      );

      expect(res.pendingEmail).toBe("new@acme.example");
    });

    it("a case-only edit is not a change: no row, no mail (N2)", async () => {
      prisma.user.findUnique.mockResolvedValue(signedIn as any);
      prisma.user.update.mockResolvedValue(afterUpdate as any);

      await service.updateUser(
        "u1",
        { email: "OLD@acme.example", username: "renamed" } as any,
        "ad",
        "TENANT_ADMIN" as any,
      );

      expect(email.sendEmailChangeLink).not.toHaveBeenCalled();
      expect(email.sendEmailChangeRequestedNotice).not.toHaveBeenCalled();
      expect(prisma.txExecuteRaw).not.toHaveBeenCalled();
    });

    it("the user read and the list carry the pending address from a live row", async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...signedIn,
        password: null,
        googleId: null,
      } as any);
      prisma.userEmailChange.findMany.mockResolvedValue([
        { userId: "u1", toEmail: "new@acme.example" },
      ] as any);

      const one = await service.findById("u1");
      expect(one?.pendingEmail).toBe("new@acme.example");
      const where = prisma.userEmailChange.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ userId: { in: ["u1"] }, usedAt: null });
      expect(where.expiresAt.gt).toBeInstanceOf(Date);

      prisma.forTenant().user.findMany.mockResolvedValue([{ id: "u1" }, { id: "u2" }] as any);
      prisma.forTenant().user.count.mockResolvedValue(2);
      const list = await service.findAll({});
      expect(list.data.map((u: any) => [u.id, u.pendingEmail])).toEqual([
        ["u1", "new@acme.example"],
        ["u2", null],
      ]);
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

      await service.updateUser(
        "u1",
        { role: "OPERATOR" } as any,
        "acme_tenant_admin",
        "OPERATOR" as any,
      );

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

      await service.updateUser("u1", { role: "OPERATOR" } as any, undefined, "OPERATOR" as any);

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

      await service.updateUser(
        "u1",
        { role: "OPERATOR", username: "renamed" } as any,
        undefined,
        "OPERATOR" as any,
      );

      expect(email.sendRoleChangedNotice).not.toHaveBeenCalled();
    });
  });
});
