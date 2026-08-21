import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { BuyerAuthService } from "./buyer-auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("bcrypt", () => ({ compare: jest.fn(), hash: jest.fn() }));

/**
 * Buyer registration email-verification flow — closes the #378 residual
 * exposure. Registration keeps issuing a session immediately (verification
 * gates only requestSeller's auto-connect, pinned in buyer-connect.spec.ts);
 * these specs pin the token lifecycle around `emailVerified`:
 * register → emailed /buyer/verify-email link → verifyEmail flips the flag,
 * with resend for buyers who lost the email. Mirrors the reset-password specs
 * (buyer-password-reset.spec.ts) — hashed single-use tokens, server-side URL.
 */

const JWT_CONFIG = {
  secret: "test-secret",
  refreshSecret: "test-refresh-secret",
  expiresIn: "15m",
  refreshExpiresIn: "30d",
};

const URLS_CONFIG = { web: "https://web.test", mobileWeb: "https://mobile.test" };

const UNVERIFIED_BUYER = {
  id: "buyer-1",
  email: "buyer@example.com",
  passwordHash: "$2b$10$hash",
  passwordSet: true,
  name: "Buyer One",
  googleId: null as string | null,
  status: "ACTIVE" as const,
  emailVerified: false,
  failedLoginAttempts: 0,
  lockedUntil: null as Date | null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("BuyerAuthService — registration email verification", () => {
  let service: BuyerAuthService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let emailService: { send: jest.Mock };

  // The register-path verification email is fired with `void` and never awaited —
  // flush the microtask queue before asserting on it.
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(async () => {
    prisma = createMockPrisma();
    emailService = { send: jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" }) };

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
    (bcrypt.hash as jest.Mock).mockResolvedValue("$2b$10$newhash");
  });

  // ── register ───────────────────────────────────────────────────────────────

  describe("register", () => {
    beforeEach(() => {
      prisma.buyerAccount.findUnique.mockResolvedValue(null);
      prisma.buyerAccount.create.mockResolvedValue(UNVERIFIED_BUYER as any);
    });

    it("creates the account unverified and emails a /buyer/verify-email link (fire-and-forget)", async () => {
      const result = await service.register(
        { email: "buyer@example.com", password: "Password1!", name: "Buyer One" } as any,
        undefined,
      );
      await flush();

      expect(prisma.buyerAccount.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ emailVerified: false }) }),
      );
      expect(result.buyer.id).toBe("buyer-1");

      const createArg = prisma.buyerEmailVerificationToken.create.mock.calls[0]![0];
      expect(createArg.data.buyerAccountId).toBe("buyer-1");
      expect(createArg.data.expiresAt).toBeInstanceOf(Date);

      const sendArg = emailService.send.mock.calls[0]![0];
      expect(sendArg.to).toBe("buyer@example.com");
      expect(sendArg.html).toContain("https://web.test/buyer/verify-email?token=");

      // The DB stores only the sha256 of the raw token that was emailed.
      const rawToken = /token=([0-9a-f]{64})/.exec(sendArg.html)![1]!;
      const expectedHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      expect(createArg.data.tokenHash).toBe(expectedHash);
    });

    it("still registers when the verification email path rejects", async () => {
      prisma.buyerEmailVerificationToken.create.mockRejectedValue(new Error("db down"));

      const result = await service.register(
        { email: "buyer@example.com", password: "Password1!", name: "Buyer One" } as any,
        undefined,
      );
      await flush();

      expect(result.accessToken).toBeDefined();
      expect(result.buyer.email).toBe("buyer@example.com");
    });
  });

  // ── verifyEmail ────────────────────────────────────────────────────────────

  describe("verifyEmail", () => {
    const rawToken = "a".repeat(64);
    const fakeHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    const baseRecord = {
      id: "bevt-1",
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
    });

    it("marks the token used and flips emailVerified in one transaction", async () => {
      prisma.buyerEmailVerificationToken.findUnique.mockResolvedValue(baseRecord as any);

      const result = await service.verifyEmail(rawToken);

      expect(result.message).toContain("Email verified");
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.buyerEmailVerificationToken.update).toHaveBeenCalledWith({
        where: { tokenHash: fakeHash },
        data: { usedAt: expect.any(Date) },
      });
      expect(prisma.buyerAccount.update).toHaveBeenCalledWith({
        where: { id: "buyer-1" },
        data: { emailVerified: true },
      });
    });

    it("throws 400 when the token is not found", async () => {
      prisma.buyerEmailVerificationToken.findUnique.mockResolvedValue(null);

      await expect(service.verifyEmail("badtoken")).rejects.toThrow(BadRequestException);
      expect(prisma.buyerAccount.update).not.toHaveBeenCalled();
    });

    it("throws 400 when the token has already been used", async () => {
      prisma.buyerEmailVerificationToken.findUnique.mockResolvedValue({
        ...baseRecord,
        usedAt: new Date(Date.now() - 60_000),
      } as any);

      await expect(service.verifyEmail(rawToken)).rejects.toThrow(BadRequestException);
      expect(prisma.buyerAccount.update).not.toHaveBeenCalled();
    });

    it("throws 400 when the token has expired", async () => {
      prisma.buyerEmailVerificationToken.findUnique.mockResolvedValue({
        ...baseRecord,
        expiresAt: new Date(Date.now() - 60_000),
      } as any);

      await expect(service.verifyEmail(rawToken)).rejects.toThrow(BadRequestException);
      expect(prisma.buyerAccount.update).not.toHaveBeenCalled();
    });
  });

  // ── resendVerification ─────────────────────────────────────────────────────

  describe("resendVerification", () => {
    it("issues a fresh token, cleans up unexpired ones, and reports honest delivery", async () => {
      prisma.buyerAccount.findUnique.mockResolvedValue(UNVERIFIED_BUYER as any);

      const result = await service.resendVerification("buyer-1");

      expect(result.sent).toBe(true);
      expect(result.message).toContain("buyer@example.com");
      expect(prisma.buyerEmailVerificationToken.deleteMany).toHaveBeenCalledWith({
        where: { buyerAccountId: "buyer-1", usedAt: null, expiresAt: { gt: expect.any(Date) } },
      });
      expect(prisma.buyerEmailVerificationToken.create).toHaveBeenCalledTimes(1);
      expect(emailService.send.mock.calls[0]![0].html).toContain(
        "https://web.test/buyer/verify-email?token=",
      );
    });

    it("reports sent:false when the transport does not deliver (send() honesty)", async () => {
      prisma.buyerAccount.findUnique.mockResolvedValue(UNVERIFIED_BUYER as any);
      emailService.send.mockResolvedValue({ delivered: false, transport: "none" });

      const result = await service.resendVerification("buyer-1");

      expect(result.sent).toBe(false);
      expect(result.message).toContain("couldn't send");
    });

    it("no-ops with alreadyVerified for a verified account — no token, no email", async () => {
      prisma.buyerAccount.findUnique.mockResolvedValue({
        ...UNVERIFIED_BUYER,
        emailVerified: true,
      } as any);

      const result = await service.resendVerification("buyer-1");

      expect(result.alreadyVerified).toBe(true);
      expect(result.sent).toBe(false);
      expect(prisma.buyerEmailVerificationToken.create).not.toHaveBeenCalled();
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it.each([
      ["missing account", null],
      ["deleted account", { ...UNVERIFIED_BUYER, deletedAt: new Date() }],
      ["suspended account", { ...UNVERIFIED_BUYER, status: "SUSPENDED" }],
    ])("rejects for a %s", async (_label, account) => {
      prisma.buyerAccount.findUnique.mockResolvedValue(account as any);

      await expect(service.resendVerification("buyer-1")).rejects.toThrow(UnauthorizedException);
      expect(emailService.send).not.toHaveBeenCalled();
    });
  });
});
