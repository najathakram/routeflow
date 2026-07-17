import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { BuyerAuthService } from "./buyer-auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("bcrypt", () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

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
        { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue(undefined) } },
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

describe("BuyerAuthService — F5-003 refresh realm discriminator", () => {
  let service: BuyerAuthService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let jwtService: { sign: jest.Mock; verify: jest.Mock; decode: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
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
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(JWT_CONFIG) } },
        { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = module.get(BuyerAuthService);
  });

  function primeValidStoredToken() {
    prisma.buyerRefreshToken.findUnique.mockResolvedValue({
      buyerAccountId: "buyer-1",
      tokenHash: "h",
      expiresAt: new Date(Date.now() + 60_000),
      userAgent: null,
      ipAddress: null,
      deviceName: null,
    } as any);
    prisma.buyerRefreshToken.deleteMany.mockResolvedValue({ count: 1 } as any);
    prisma.buyerAccount.findUnique.mockResolvedValue({ ...MOCK_ACCOUNT } as any);
    prisma.buyerRefreshToken.upsert.mockResolvedValue({} as any);
  }

  it("rejects a staff-typed refresh token on the buyer refresh path", async () => {
    jwtService.verify.mockReturnValue({ sub: "buyer-1", type: "staff" });

    await expect(service.refresh("staff-token", undefined)).rejects.toThrow(UnauthorizedException);
    expect(prisma.buyerRefreshToken.findUnique).not.toHaveBeenCalled();
  });

  it("allows a legacy (no-type) refresh token — grace so live sessions survive", async () => {
    jwtService.verify.mockReturnValue({ sub: "buyer-1" }); // no `type`
    primeValidStoredToken();

    const result = await service.refresh("legacy-token", undefined);

    expect(result).toHaveProperty("accessToken");
    expect(result.buyer.id).toBe("buyer-1");
  });

  it("allows a buyer-typed token and mints a buyer-typed replacement", async () => {
    jwtService.verify.mockReturnValue({ sub: "buyer-1", type: "buyer" });
    primeValidStoredToken();

    const result = await service.refresh("buyer-token", undefined);

    expect(result).toHaveProperty("accessToken");
    // calls[0] = access payload, calls[1] = rotated refresh payload
    expect(jwtService.sign.mock.calls[1]![0]).toMatchObject({ sub: "buyer-1", type: "buyer" });
  });

  it("stamps type:buyer on the refresh token minted at login", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({ ...MOCK_ACCOUNT } as any);
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    prisma.buyerRefreshToken.upsert.mockResolvedValue({} as any);

    await service.login({ email: MOCK_ACCOUNT.email, password: "whatever" }, undefined);

    expect(jwtService.sign.mock.calls[1]![0]).toMatchObject({ sub: "buyer-1", type: "buyer" });
  });
});
