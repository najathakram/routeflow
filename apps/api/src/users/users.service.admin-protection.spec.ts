/**
 * Admin account protection: an account with the TENANT_ADMIN role can only be changed by a TENANT_ADMIN caller
 * (password reset, status change, email edit). Decided by ROLE: `isAdmin` is not on the request user.
 */
import { ForbiddenException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { UsersService } from "./users.service";
import { UsersController } from "./users.controller";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

const ADMIN_TARGET = {
  id: "t1",
  username: "owner",
  email: "owner@acme.example",
  role: "TENANT_ADMIN",
  status: "ACTIVE",
  deletedAt: null,
};
const OPERATOR_TARGET = {
  id: "o1",
  username: "op",
  email: "op@acme.example",
  role: "OPERATOR",
  status: "ACTIVE",
  deletedAt: null,
};

describe("UsersService: admin account protection", () => {
  let service: UsersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let email: Record<string, jest.Mock>;

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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: email },
        {
          provide: ConfigService,
          useValue: { get: () => ({ web: "https://a.example", mobileWeb: "https://m.example" }) },
        },
      ],
    }).compile();
    service = module.get(UsersService);
  });

  describe("resetPassword", () => {
    it("an OPERATOR cannot reset a TENANT_ADMIN: 403 and nothing is written", async () => {
      prisma.user.findUnique.mockResolvedValue(ADMIN_TARGET as any);
      await expect(service.resetPassword("t1", "OPERATOR" as any)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
    it("a TENANT_ADMIN can reset a TENANT_ADMIN", async () => {
      prisma.user.findUnique.mockResolvedValue(ADMIN_TARGET as any);
      prisma.user.update.mockResolvedValue({} as any);
      await expect(service.resetPassword("t1", "TENANT_ADMIN" as any)).resolves.toHaveProperty(
        "tempPassword",
      );
    });
    it("an OPERATOR can still reset an OPERATOR", async () => {
      prisma.user.findUnique.mockResolvedValue(OPERATOR_TARGET as any);
      prisma.user.update.mockResolvedValue({} as any);
      await expect(service.resetPassword("o1", "OPERATOR" as any)).resolves.toHaveProperty(
        "tempPassword",
      );
    });
  });

  describe("changeStatus", () => {
    it("an OPERATOR cannot change a TENANT_ADMIN's status: 403 and nothing is written", async () => {
      prisma.user.findUnique.mockResolvedValue(ADMIN_TARGET as any);
      await expect(
        service.changeStatus("t1", { status: "SUSPENDED" } as any, "OPERATOR" as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
    it("a TENANT_ADMIN can change a TENANT_ADMIN's status", async () => {
      prisma.user.findUnique.mockResolvedValue(ADMIN_TARGET as any);
      prisma.user.update.mockResolvedValue({ id: "t1" } as any);
      await expect(
        service.changeStatus("t1", { status: "SUSPENDED" } as any, "TENANT_ADMIN" as any),
      ).resolves.toBeDefined();
    });
    it("an OPERATOR can still change an OPERATOR's status", async () => {
      prisma.user.findUnique.mockResolvedValue(OPERATOR_TARGET as any);
      prisma.user.update.mockResolvedValue({ id: "o1" } as any);
      await expect(
        service.changeStatus("o1", { status: "SUSPENDED" } as any, "OPERATOR" as any),
      ).resolves.toBeDefined();
    });
  });

  describe("updateUser (email edit)", () => {
    it("an OPERATOR cannot change a TENANT_ADMIN's email: 403 and nothing is written", async () => {
      prisma.user.findUnique.mockResolvedValue(ADMIN_TARGET as any);
      await expect(
        service.updateUser("t1", { email: "other@acme.example" } as any, "op", "OPERATOR" as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
    it("a TENANT_ADMIN can change their own email", async () => {
      prisma.user.findUnique.mockResolvedValue(ADMIN_TARGET as any);
      prisma.user.update.mockResolvedValue({
        id: "t1",
        username: "owner",
        email: "new@acme.example",
        role: "TENANT_ADMIN",
      } as any);
      await expect(
        service.updateUser(
          "t1",
          { email: "new@acme.example" } as any,
          "owner",
          "TENANT_ADMIN" as any,
        ),
      ).resolves.toBeDefined();
    });
    it("a support session cannot change an email (403 IMPERSONATION_NOT_ALLOWED) and nothing is written", async () => {
      prisma.user.findUnique.mockResolvedValue(ADMIN_TARGET as any);
      await expect(
        service.updateUser(
          "t1",
          { email: "mine@support.example" } as any,
          "owner",
          "TENANT_ADMIN" as any,
          "sa-1",
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: "IMPERSONATION_NOT_ALLOWED" }),
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
    it("a support session can still save an unchanged email with other fields", async () => {
      prisma.user.findUnique.mockResolvedValue(OPERATOR_TARGET as any);
      prisma.user.update.mockResolvedValue({ id: "o1", username: "op", role: "OPERATOR" } as any);
      await expect(
        service.updateUser(
          "o1",
          { email: "OP@acme.example", firstName: "Op" } as any,
          "owner",
          "TENANT_ADMIN" as any,
          "sa-1",
        ),
      ).resolves.toBeDefined();
    });
    it("an OPERATOR can still change an OPERATOR's email", async () => {
      prisma.user.findUnique.mockResolvedValue(OPERATOR_TARGET as any);
      prisma.user.update.mockResolvedValue({
        id: "o1",
        username: "op",
        email: "new@acme.example",
        role: "OPERATOR",
      } as any);
      await expect(
        service.updateUser("o1", { email: "new@acme.example" } as any, "op", "OPERATOR" as any),
      ).resolves.toBeDefined();
    });
  });

  describe("updateUser (only an ACTUAL change of email or username is guarded)", () => {
    it("an OPERATOR cannot change a TENANT_ADMIN's username: 403 and nothing is written", async () => {
      prisma.user.findUnique.mockResolvedValue(ADMIN_TARGET as any);
      await expect(
        service.updateUser("t1", { username: "renamed" } as any, "op", "OPERATOR" as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
    it("an OPERATOR sending the UNCHANGED email and username on an admin row is allowed (the web form always sends them)", async () => {
      prisma.user.findUnique.mockResolvedValue(ADMIN_TARGET as any);
      prisma.user.update.mockResolvedValue({
        id: "t1",
        username: "owner",
        email: "owner@acme.example",
        role: "TENANT_ADMIN",
      } as any);
      await expect(
        service.updateUser(
          "t1",
          { email: "  Owner@Acme.example ", username: "owner" } as any,
          "op",
          "OPERATOR" as any,
        ),
      ).resolves.toBeDefined();
    });
    it("a mixed-case or padded STORED email with a no-op save is allowed", async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...ADMIN_TARGET,
        email: " Owner@Acme.Example ",
      } as any);
      prisma.user.update.mockResolvedValue({
        id: "t1",
        username: "owner",
        email: " Owner@Acme.Example ",
        forcePasswordChange: true,
      } as any);
      await expect(
        service.updateUser(
          "t1",
          { email: "owner@acme.example", username: "owner" } as any,
          "op",
          "OPERATOR" as any,
        ),
      ).resolves.toBeDefined();
      // not a real change: no stored-email rewrite and no email side effects
      const data = (prisma.user.update.mock.calls[0][0] as any).data;
      expect(data).not.toHaveProperty("email");
      expect(prisma.passwordResetToken.updateMany).not.toHaveBeenCalled();
      expect(email.sendEmailChangedNotice).not.toHaveBeenCalled();
      expect(email.sendEmailChangeConfirmation).not.toHaveBeenCalled();
      expect(email.sendSetPasswordEmail).not.toHaveBeenCalled();
    });
    it("an OPERATOR changing the email on an admin row is still refused", async () => {
      prisma.user.findUnique.mockResolvedValue(ADMIN_TARGET as any);
      await expect(
        service.updateUser(
          "t1",
          { email: "x@acme.example", username: "owner" } as any,
          "op",
          "OPERATOR" as any,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("updateUser (username normalization mirrors email)", () => {
    it("a padded copy of the SAME username on an admin row is allowed and not written", async () => {
      prisma.user.findUnique.mockResolvedValue(ADMIN_TARGET as any);
      prisma.user.update.mockResolvedValue({ id: "t1", username: "owner" } as any);
      await expect(
        service.updateUser("t1", { username: " owner " } as any, "op", "OPERATOR" as any),
      ).resolves.toBeDefined();
      const data = (prisma.user.update.mock.calls[0][0] as any).data;
      expect(data).not.toHaveProperty("username");
    });
    it("a padded REAL username change on an admin row by an OPERATOR is still refused", async () => {
      prisma.user.findUnique.mockResolvedValue(ADMIN_TARGET as any);
      await expect(
        service.updateUser("t1", { username: " renamed " } as any, "op", "OPERATOR" as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
    it("a non-admin target's padded new username is stored trimmed", async () => {
      prisma.user.findUnique.mockResolvedValue(OPERATOR_TARGET as any);
      prisma.user.update.mockResolvedValue({ id: "o1", username: "newname" } as any);
      await service.updateUser("o1", { username: "  newname " } as any, "op", "OPERATOR" as any);
      const data = (prisma.user.update.mock.calls[0][0] as any).data;
      expect(data.username).toBe("newname");
    });
  });

  describe("callers other than a TENANT_ADMIN", () => {
    it("a SUPER_ADMIN caller is refused on an admin target", async () => {
      prisma.user.findUnique.mockResolvedValue(ADMIN_TARGET as any);
      await expect(service.resetPassword("t1", "SUPER_ADMIN" as any)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
    it("an undefined caller role is refused on an admin target", async () => {
      prisma.user.findUnique.mockResolvedValue(ADMIN_TARGET as any);
      await expect(service.unlockUser("t1", undefined as any)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
    it("controller + service: a non-admin caller on the driver-permit route is refused", async () => {
      prisma.user.findUnique.mockResolvedValue({ ...ADMIN_TARGET, canActAsDriver: false } as any);
      const controller = new UsersController(service as any, {} as any);
      await expect(
        controller.toggleDriverPermit("t1", {
          sub: "op1",
          username: "op",
          role: "OPERATOR",
        } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe("unlockUser", () => {
    it("an OPERATOR cannot clear a TENANT_ADMIN's lockout: 403 and nothing is written", async () => {
      prisma.user.findUnique.mockResolvedValue(ADMIN_TARGET as any);
      await expect(service.unlockUser("t1", "OPERATOR" as any)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
    it("a TENANT_ADMIN can unlock a TENANT_ADMIN; an OPERATOR can unlock an OPERATOR", async () => {
      prisma.user.update.mockResolvedValue({} as any);
      prisma.user.findUnique.mockResolvedValue(ADMIN_TARGET as any);
      await expect(service.unlockUser("t1", "TENANT_ADMIN" as any)).resolves.toMatchObject({
        unlocked: true,
      });
      prisma.user.findUnique.mockResolvedValue(OPERATOR_TARGET as any);
      await expect(service.unlockUser("o1", "OPERATOR" as any)).resolves.toMatchObject({
        unlocked: true,
      });
    });
  });

  describe("toggleDriverPermit", () => {
    it("an OPERATOR cannot toggle a TENANT_ADMIN's driver permit: 403 and nothing is written", async () => {
      prisma.user.findUnique.mockResolvedValue({ ...ADMIN_TARGET, canActAsDriver: false } as any);
      await expect(service.toggleDriverPermit("t1", "OPERATOR" as any)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
    it("a TENANT_ADMIN can toggle their own permit", async () => {
      prisma.user.findUnique.mockResolvedValue({ ...ADMIN_TARGET, canActAsDriver: true } as any);
      prisma.user.update.mockResolvedValue({ id: "t1" } as any);
      await expect(service.toggleDriverPermit("t1", "TENANT_ADMIN" as any)).resolves.toBeDefined();
    });
  });
});
