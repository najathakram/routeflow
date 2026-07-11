import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { BuyerAuthService } from "./buyer-auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("bcrypt", () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

const JWT_CONFIG = {
  secret: "test-secret",
  refreshSecret: "test-refresh-secret",
  expiresIn: "15m",
  refreshExpiresIn: "3d",
};

const MOCK_ACCOUNT = {
  id: "buyer-1",
  email: "buyer@example.com",
  passwordHash: "$2b$10$hash",
  name: "Buyer One",
  status: "ACTIVE" as const,
  emailVerified: true,
  failedLoginAttempts: 0,
  lockedUntil: null as Date | null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("BuyerAuthService — account lockout", () => {
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
      ],
    }).compile();
    service = module.get(BuyerAuthService);
  });

  const login = () => service.login({ email: MOCK_ACCOUNT.email, password: "whatever" }, undefined);

  beforeEach(() => {
    (bcrypt.compare as jest.Mock).mockClear();
  });

  it("locked account gets the identical 'Invalid credentials' WITHOUT running bcrypt", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({
      ...MOCK_ACCOUNT,
      lockedUntil: new Date(Date.now() + 60_000),
    });

    await expect(login()).rejects.toThrow(new UnauthorizedException("Invalid credentials"));
    expect(bcrypt.compare).not.toHaveBeenCalled();
    expect(prisma.buyerAccount.update).not.toHaveBeenCalled();
  });

  it("a failed attempt increments the counter and still says 'Invalid credentials'", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({ ...MOCK_ACCOUNT, failedLoginAttempts: 2 });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    await expect(login()).rejects.toThrow(new UnauthorizedException("Invalid credentials"));
    expect(prisma.buyerAccount.update).toHaveBeenCalledWith({
      where: { id: "buyer-1" },
      data: { failedLoginAttempts: 3 },
    });
  });

  it("the Nth failure locks for 15 minutes and resets the counter", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({
      ...MOCK_ACCOUNT,
      failedLoginAttempts: BuyerAuthService.LOCKOUT_THRESHOLD - 1,
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    const before = Date.now();
    await expect(login()).rejects.toThrow(UnauthorizedException);

    const update = prisma.buyerAccount.update.mock.calls[0][0];
    expect(update.data.failedLoginAttempts).toBe(0);
    const lockedUntil = update.data.lockedUntil as Date;
    expect(lockedUntil.getTime()).toBeGreaterThanOrEqual(
      before + BuyerAuthService.LOCKOUT_WINDOW_MS - 1000,
    );
  });

  it("a successful login clears the counter and any expired lock", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({
      ...MOCK_ACCOUNT,
      failedLoginAttempts: 4,
      lockedUntil: new Date(Date.now() - 60_000), // expired
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    prisma.buyerRefreshToken.create.mockResolvedValue({});

    const result = await login();

    expect(result.buyer.id).toBe("buyer-1");
    expect(prisma.buyerAccount.update).toHaveBeenCalledWith({
      where: { id: "buyer-1" },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
  });

  it("a failure after an expired lock restarts the streak at 1", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({
      ...MOCK_ACCOUNT,
      failedLoginAttempts: 0,
      lockedUntil: new Date(Date.now() - 60_000), // expired
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    await expect(login()).rejects.toThrow(UnauthorizedException);
    expect(prisma.buyerAccount.update).toHaveBeenCalledWith({
      where: { id: "buyer-1" },
      data: { failedLoginAttempts: 1, lockedUntil: null },
    });
  });
});
