/**
 * Security tests for buyer authentication.
 *
 * F3-005: buyer login must NOT leak account existence/status. A suspended
 * account previously got a distinct "This account has been suspended" message,
 * which confirmed the email belonged to a real account (user enumeration). The
 * message is now the constant "Invalid credentials" for not-found, deleted, and
 * suspended alike — mirroring staff validateUser. A legitimate ACTIVE login must
 * still succeed.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { BuyerAuthService } from "./buyer-auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("bcrypt", () => ({ compare: jest.fn(), hash: jest.fn() }));

const JWT_CONFIG = {
  secret: "test-secret",
  refreshSecret: "test-refresh-secret",
  expiresIn: "15m",
  refreshExpiresIn: "30d",
};

const MOCK_ACCOUNT = {
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

describe("BuyerAuthService — F3-005 enumeration-safe login", () => {
  let service: BuyerAuthService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuyerAuthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue("mock-token"),
            verify: jest.fn(),
            decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          },
        },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(JWT_CONFIG) } },
        { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = module.get(BuyerAuthService);
    (bcrypt.compare as jest.Mock).mockReset();
  });

  const login = (password = "whatever") =>
    service.login({ email: MOCK_ACCOUNT.email, password }, undefined);

  async function messageOf(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
      throw new Error("expected login to reject");
    } catch (e) {
      return (e as Error).message;
    }
  }

  it("SUSPENDED account returns the CONSTANT 'Invalid credentials' (no suspended oracle)", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({ ...MOCK_ACCOUNT, status: "SUSPENDED" });

    const message = await messageOf(login());
    expect(message).toBe("Invalid credentials");
    expect(message).not.toMatch(/suspend/i);
    // Enumeration-safe: a suspended account must not run bcrypt either.
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  it("unknown email and wrong password give the SAME message", async () => {
    // Unknown email
    prisma.buyerAccount.findUnique.mockResolvedValue(null);
    const unknownMsg = await messageOf(login());

    // Known ACTIVE account, wrong password
    prisma.buyerAccount.findUnique.mockResolvedValue({ ...MOCK_ACCOUNT });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);
    const badPassMsg = await messageOf(login("nope"));

    expect(unknownMsg).toBe("Invalid credentials");
    expect(badPassMsg).toBe("Invalid credentials");
  });

  it("a legitimate ACTIVE login still succeeds and issues tokens", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({ ...MOCK_ACCOUNT });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    const result = await login("correct-horse");
    expect(result.accessToken).toBe("mock-token");
    expect(result.buyer).toMatchObject({ id: "buyer-1", email: MOCK_ACCOUNT.email });
  });

  it("suspended login rejects with UnauthorizedException (not a 4xx status leak)", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({ ...MOCK_ACCOUNT, status: "SUSPENDED" });
    await expect(login()).rejects.toThrow(UnauthorizedException);
  });
});
