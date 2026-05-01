import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { AuthService } from "./auth.service";
import { EmailService } from "../email/email.service";
import { UsersService } from "../users/users.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("bcrypt", () => ({ compare: jest.fn(), hash: jest.fn(), genSalt: jest.fn() }));

const JWT_CONFIG = {
  secret: "test-secret",
  refreshSecret: "test-refresh-secret",
  expiresIn: "15m",
  refreshExpiresIn: "7d",
};

const ACTIVE_USER = {
  id: "user-1",
  email: "alice@example.com",
  username: "alice",
  password: "$2b$10$hashed",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  deletedAt: null,
  forcePasswordChange: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("AuthService — password reset (RF-018)", () => {
  let service: AuthService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let emailService: { send: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    emailService = { send: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: UsersService, useValue: { findByUsername: jest.fn(), findByUsernameCrossTenant: jest.fn().mockResolvedValue(null), findByEmailCrossTenant: jest.fn().mockResolvedValue(null) } },
        { provide: JwtService, useValue: { sign: jest.fn().mockReturnValue("tok"), verify: jest.fn(), decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }) } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(JWT_CONFIG) } },
        { provide: EmailService, useValue: emailService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  // ── Unit: token hashing helper ─────────────────────────────────────────────

  describe("hashTokenPublic", () => {
    it("produces a deterministic SHA-256 hex string", () => {
      const raw = "abc123";
      const result = service.hashTokenPublic(raw);
      const expected = crypto.createHash("sha256").update(raw).digest("hex");
      expect(result).toBe(expected);
    });

    it("different inputs produce different hashes", () => {
      expect(service.hashTokenPublic("aaa")).not.toBe(service.hashTokenPublic("bbb"));
    });
  });

  // ── requestPasswordReset ───────────────────────────────────────────────────

  describe("requestPasswordReset", () => {
    it("creates a token row and fires email when user exists", async () => {
      (prisma.user.findFirst as jest.Mock).mockResolvedValue(ACTIVE_USER);
      (prisma.passwordResetToken.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prisma.passwordResetToken.create as jest.Mock).mockResolvedValue({});

      const result = await service.requestPasswordReset("alice@example.com");

      expect(result.message).toContain("If that address is registered");
      expect(prisma.passwordResetToken.create).toHaveBeenCalledTimes(1);

      const createArg = (prisma.passwordResetToken.create as jest.Mock).mock.calls[0]![0];
      expect(createArg.data.userId).toBe("user-1");
      expect(createArg.data.tokenHash).toBeDefined();
      expect(createArg.data.expiresAt).toBeInstanceOf(Date);

      // email is fire-and-forget — flush microtasks
      await Promise.resolve();
      expect(emailService.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: "alice@example.com", subject: expect.stringContaining("Reset") }),
      );
    });

    it("returns same message when user does NOT exist (no enumeration)", async () => {
      (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.requestPasswordReset("nobody@example.com");

      expect(result.message).toContain("If that address is registered");
      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
    });
  });

  // ── resetPassword ──────────────────────────────────────────────────────────

  describe("resetPassword", () => {
    const rawToken = "a".repeat(64);
    const fakeHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    const baseRecord = {
      id: "prt-1",
      userId: "user-1",
      tokenHash: fakeHash,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    };

    beforeEach(() => {
      // $transaction: call the callback with an array of operations
      (prisma.$transaction as jest.Mock).mockImplementation((ops: any[]) =>
        Promise.all(ops.map(() => ({})))
      );
      (bcrypt.hash as jest.Mock).mockResolvedValue("$2b$10$newhash");
    });

    it("updates password when token is valid", async () => {
      (prisma.passwordResetToken.findUnique as jest.Mock).mockResolvedValue(baseRecord);

      const result = await service.resetPassword(rawToken, "NewPass1!");

      expect(result.message).toContain("Password reset successfully");
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it("throws 400 when token is not found", async () => {
      (prisma.passwordResetToken.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.resetPassword("badtoken", "NewPass1!")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws 400 when token has already been used", async () => {
      (prisma.passwordResetToken.findUnique as jest.Mock).mockResolvedValue({
        ...baseRecord,
        usedAt: new Date(Date.now() - 60_000),
      });

      await expect(service.resetPassword(rawToken, "NewPass1!")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws 400 when token has expired", async () => {
      (prisma.passwordResetToken.findUnique as jest.Mock).mockResolvedValue({
        ...baseRecord,
        expiresAt: new Date(Date.now() - 60_000),
      });

      await expect(service.resetPassword(rawToken, "NewPass1!")).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
