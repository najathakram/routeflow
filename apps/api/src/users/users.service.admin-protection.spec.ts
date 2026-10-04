/**
 * Admin account protection: an account with the TENANT_ADMIN role can only be changed by a TENANT_ADMIN caller
 * (password reset, status change, email edit). Decided by ROLE: `isAdmin` is not on the request user.
 */
import { ForbiddenException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { UsersService } from "./users.service";
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

  beforeEach(async () => {
    prisma = createMockPrisma();
    const email = {
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
});
