import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { BadRequestException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { BuyerAuthService } from "./buyer-auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("bcrypt", () => ({ compare: jest.fn(), hash: jest.fn() }));

/**
 * Buyer forgot/reset-password flow — mirrors the staff RF-018 flow
 * (auth/password-reset.spec.ts). Also the supported "claim a password" path
 * for buyer accounts auto-created via Google before passwordSet existed.
 */

const JWT_CONFIG = {
  secret: "test-secret",
  refreshSecret: "test-refresh-secret",
  expiresIn: "15m",
  refreshExpiresIn: "30d",
};

const URLS_CONFIG = { web: "https://web.test", mobileWeb: "https://mobile.test" };

const ACTIVE_BUYER = {
  id: "buyer-1",
  email: "buyer@example.com",
  passwordHash: "$2b$10$hash",
  passwordSet: true,
  name: "Buyer One",
  googleId: null as string | null,
  status: "ACTIVE" as const,
  emailVerified: true,
  failedLoginAttempts: 0,
  lockedUntil: null as Date | null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("BuyerAuthService — password reset", () => {
  let service: BuyerAuthService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let emailService: { send: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    emailService = { send: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuyerAuthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue("tok"),
            verify: jest.fn(),
            decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => (key === "urls" ? URLS_CONFIG : JWT_CONFIG)),
          },
        },
        { provide: EmailService, useValue: emailService },
      ],
    }).compile();

    service = module.get(BuyerAuthService);
  });

  // ── requestPasswordReset ───────────────────────────────────────────────────

  describe("requestPasswordReset", () => {
    it("creates a token row and emails a /buyer/reset-password link", async () => {
      prisma.buyerAccount.findUnique.mockResolvedValue(ACTIVE_BUYER as any);
      prisma.buyerPasswordResetToken.deleteMany.mockResolvedValue({ count: 0 } as any);
      prisma.buyerPasswordResetToken.create.mockResolvedValue({} as any);

      const result = await service.requestPasswordReset("buyer@example.com");

      expect(result.message).toContain("If that address is registered");
      expect(prisma.buyerPasswordResetToken.create).toHaveBeenCalledTimes(1);

      const createArg = prisma.buyerPasswordResetToken.create.mock.calls[0]![0];
      expect(createArg.data.buyerAccountId).toBe("buyer-1");
      expect(createArg.data.tokenHash).toBeDefined();
      expect(createArg.data.expiresAt).toBeInstanceOf(Date);

      await Promise.resolve(); // email is fire-and-forget
      const sendArg = emailService.send.mock.calls[0]![0];
      expect(sendArg.to).toBe("buyer@example.com");
      expect(sendArg.html).toContain("https://web.test/buyer/reset-password?token=");
    });

    it("cleans up previous unexpired unused tokens", async () => {
      prisma.buyerAccount.findUnique.mockResolvedValue(ACTIVE_BUYER as any);

      await service.requestPasswordReset("buyer@example.com");

      expect(prisma.buyerPasswordResetToken.deleteMany).toHaveBeenCalledWith({
        where: {
          buyerAccountId: "buyer-1",
          usedAt: null,
          expiresAt: { gt: expect.any(Date) },
        },
      });
    });

    it.each([
      ["missing account", null],
      ["deleted account", { ...ACTIVE_BUYER, deletedAt: new Date() }],
      ["suspended account", { ...ACTIVE_BUYER, status: "SUSPENDED" }],
    ])("returns the same message for %s (no enumeration)", async (_label, account) => {
      prisma.buyerAccount.findUnique.mockResolvedValue(account as any);

      const result = await service.requestPasswordReset("buyer@example.com");

      expect(result.message).toContain("If that address is registered");
      expect(prisma.buyerPasswordResetToken.create).not.toHaveBeenCalled();
      expect(emailService.send).not.toHaveBeenCalled();
    });
  });

  // ── resetPassword ──────────────────────────────────────────────────────────

  describe("resetPassword", () => {
    const rawToken = "a".repeat(64);
    const fakeHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    const baseRecord = {
      id: "bprt-1",
      buyerAccountId: "buyer-1",
      tokenHash: fakeHash,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    };

    beforeEach(() => {
      (prisma.$transaction as jest.Mock).mockImplementation((ops: any[]) =>
        Promise.all(ops.map(() => ({}))),
      );
      (bcrypt.hash as jest.Mock).mockResolvedValue("$2b$10$newhash");
    });

    it("updates the password, flips passwordSet, and revokes refresh tokens", async () => {
      prisma.buyerPasswordResetToken.findUnique.mockResolvedValue(baseRecord as any);

      const result = await service.resetPassword(rawToken, "NewPass1!");

      expect(result.message).toContain("Password reset successfully");
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // The transaction's operations were built from these calls:
      expect(prisma.buyerPasswordResetToken.update).toHaveBeenCalledWith({
        where: { tokenHash: fakeHash },
        data: { usedAt: expect.any(Date) },
      });
      expect(prisma.buyerAccount.update).toHaveBeenCalledWith({
        where: { id: "buyer-1" },
        data: { passwordHash: "$2b$10$newhash", passwordSet: true },
      });
      expect(prisma.buyerRefreshToken.deleteMany).toHaveBeenCalledWith({
        where: { buyerAccountId: "buyer-1" },
      });
    });

    it("throws 400 when the token is not found", async () => {
      prisma.buyerPasswordResetToken.findUnique.mockResolvedValue(null);

      await expect(service.resetPassword("badtoken", "NewPass1!")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws 400 when the token has already been used", async () => {
      prisma.buyerPasswordResetToken.findUnique.mockResolvedValue({
        ...baseRecord,
        usedAt: new Date(Date.now() - 60_000),
      } as any);

      await expect(service.resetPassword(rawToken, "NewPass1!")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws 400 when the token has expired", async () => {
      prisma.buyerPasswordResetToken.findUnique.mockResolvedValue({
        ...baseRecord,
        expiresAt: new Date(Date.now() - 60_000),
      } as any);

      await expect(service.resetPassword(rawToken, "NewPass1!")).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
