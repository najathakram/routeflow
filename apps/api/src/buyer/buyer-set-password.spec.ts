import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { BuyerAuthService } from "./buyer-auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("bcrypt", () => ({ compare: jest.fn(), hash: jest.fn() }));

/**
 * POST /buyer/auth/set-password — first-password setup for Google-auto-created
 * buyer accounts (passwordSet=false, random placeholder hash). Pins the
 * security invariant: passwordSet=true accounts are refused — their password
 * can only change via changePassword (current-password proof) or the email
 * reset flow.
 */

const JWT_CONFIG = {
  secret: "test-secret",
  refreshSecret: "test-refresh-secret",
  expiresIn: "15m",
  refreshExpiresIn: "30d",
};

const URLS_CONFIG = { web: "https://web.test", mobileWeb: "https://mobile.test" };

const GOOGLE_BUYER = {
  id: "buyer-1",
  email: "buyer@example.com",
  passwordHash: "$2b$10$random-placeholder",
  passwordSet: false,
  name: "Buyer One",
  googleId: "google-1",
  status: "ACTIVE" as const,
  emailVerified: true,
  failedLoginAttempts: 0,
  lockedUntil: null as Date | null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("BuyerAuthService.setPassword", () => {
  let service: BuyerAuthService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let emailService: { send: jest.Mock };
  let jwtService: { sign: jest.Mock; verify: jest.Mock; decode: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    emailService = { send: jest.fn().mockResolvedValue(undefined) };
    jwtService = {
      sign: jest.fn().mockReturnValue("mock-token"),
      verify: jest.fn(),
      decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuyerAuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwtService },
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
    (bcrypt.hash as jest.Mock).mockClear();
    (bcrypt.hash as jest.Mock).mockResolvedValue("$2b$10$newhash");
  });

  it("sets a first password, flips passwordSet, revokes sessions, reissues a pair", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue(GOOGLE_BUYER as any);
    prisma.buyerAccount.update.mockResolvedValue({} as any);
    prisma.buyerRefreshToken.upsert.mockResolvedValue({} as any);

    const result = await service.setPassword("buyer-1", "NewPass1!", { ipAddress: "1.2.3.4" });

    expect(bcrypt.hash).toHaveBeenCalledWith("NewPass1!", 10);
    expect(prisma.buyerAccount.update).toHaveBeenCalledWith({
      where: { id: "buyer-1" },
      data: { passwordHash: "$2b$10$newhash", passwordSet: true },
    });
    expect(prisma.buyerRefreshToken.deleteMany).toHaveBeenCalledWith({
      where: { buyerAccountId: "buyer-1" },
    });
    expect(result).toMatchObject({
      message: expect.stringMatching(/Password set successfully/),
      accessToken: "mock-token",
      refreshToken: "mock-token",
      buyer: { id: "buyer-1", hasPassword: true },
    });
  });

  it("signs the fresh access token with hasPassword=true", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue(GOOGLE_BUYER as any);
    prisma.buyerAccount.update.mockResolvedValue({} as any);
    prisma.buyerRefreshToken.upsert.mockResolvedValue({} as any);

    await service.setPassword("buyer-1", "NewPass1!");

    expect(jwtService.sign.mock.calls[0]![0]).toMatchObject({
      sub: "buyer-1",
      type: "BUYER",
      hasPassword: true,
    });
  });

  it("fires a security notification email (fire-and-forget)", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue(GOOGLE_BUYER as any);
    prisma.buyerAccount.update.mockResolvedValue({} as any);
    prisma.buyerRefreshToken.upsert.mockResolvedValue({} as any);

    await service.setPassword("buyer-1", "NewPass1!");
    await Promise.resolve();

    expect(emailService.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "buyer@example.com",
        subject: expect.stringContaining("password was set"),
      }),
    );
  });

  it("REFUSES when passwordSet=true (real passwords are never overwritten here)", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({
      ...GOOGLE_BUYER,
      passwordSet: true,
    } as any);

    await expect(service.setPassword("buyer-1", "NewPass1!")).rejects.toThrow(BadRequestException);
    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(prisma.buyerAccount.update).not.toHaveBeenCalled();
  });

  it("throws Unauthorized for deleted or missing accounts", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue(null);
    await expect(service.setPassword("nobody", "NewPass1!")).rejects.toThrow(UnauthorizedException);

    prisma.buyerAccount.findUnique.mockResolvedValue({
      ...GOOGLE_BUYER,
      deletedAt: new Date(),
    } as any);
    await expect(service.setPassword("buyer-1", "NewPass1!")).rejects.toThrow(
      UnauthorizedException,
    );
    expect(bcrypt.hash).not.toHaveBeenCalled();
  });
});
