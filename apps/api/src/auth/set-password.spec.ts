import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import * as bcrypt from "bcrypt";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { SetPasswordDto } from "./dto/set-password.dto";
import { EmailService } from "../email/email.service";
import { UsersService } from "../users/users.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { EntitlementsService } from "../billing/entitlements.service";

jest.mock("bcrypt", () => ({ compare: jest.fn(), hash: jest.fn(), genSalt: jest.fn() }));

/**
 * POST /auth/set-password — first-password setup for Google-only staff accounts.
 * Pins the security invariant: the endpoint only works when `User.password` is
 * NULL in the database; an existing password can never be overwritten here.
 */

const JWT_CONFIG = {
  secret: "test-secret",
  refreshSecret: "test-refresh-secret",
  expiresIn: "15m",
  refreshExpiresIn: "30d",
};

const URLS_CONFIG = { web: "https://web.test", mobileWeb: "https://mobile.test" };

const GOOGLE_ONLY_USER = {
  id: "user-1",
  email: "alice@example.com",
  username: "alice",
  password: null as string | null,
  googleId: "google-1",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
  isAdmin: false,
  canActAsDriver: false,
  tenantId: "tenant-1",
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("AuthService.setPassword", () => {
  let service: AuthService;
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
        AuthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: UsersService,
          useValue: {
            findByUsername: jest.fn(),
            findByUsernameCrossTenant: jest.fn().mockResolvedValue(null),
            findByEmailCrossTenant: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: JwtService, useValue: jwtService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => (key === "urls" ? URLS_CONFIG : JWT_CONFIG)),
          },
        },
        { provide: EmailService, useValue: emailService },
        {
          provide: EntitlementsService,
          useValue: { claimsFor: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    (bcrypt.hash as jest.Mock).mockClear();
    (bcrypt.hash as jest.Mock).mockResolvedValue("$2b$10$newhash");
  });

  it("sets a first password, revokes all sessions, and reissues a pair", async () => {
    prisma.user.findUnique.mockResolvedValue(GOOGLE_ONLY_USER as any);
    prisma.user.update.mockResolvedValue({
      ...GOOGLE_ONLY_USER,
      password: "$2b$10$newhash",
      forcePasswordChange: false,
    } as any);
    prisma.tenant.findUnique.mockResolvedValue({ slug: "acme" } as any);
    prisma.refreshToken.upsert.mockResolvedValue({} as any);

    const result = await service.setPassword("user-1", "NewPass1!", { ipAddress: "1.2.3.4" });

    expect(bcrypt.hash).toHaveBeenCalledWith("NewPass1!", 10);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { password: "$2b$10$newhash", forcePasswordChange: false },
    });
    // All prior sessions die; the caller gets a fresh pair
    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(result).toMatchObject({
      message: expect.stringMatching(/Password set successfully/),
      accessToken: "mock-token",
      refreshToken: "mock-token",
    });
  });

  it("N2 review fix: invalidates any outstanding PasswordResetToken so a 72h staff-invite/admin-reset link can't outlive a first-password setup", async () => {
    prisma.user.findUnique.mockResolvedValue(GOOGLE_ONLY_USER as any);
    prisma.user.update.mockResolvedValue({
      ...GOOGLE_ONLY_USER,
      password: "$2b$10$newhash",
      forcePasswordChange: false,
    } as any);
    prisma.tenant.findUnique.mockResolvedValue({ slug: "acme" } as any);
    prisma.refreshToken.upsert.mockResolvedValue({} as any);

    await service.setPassword("user-1", "NewPass1!", { ipAddress: "1.2.3.4" });

    expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
  });

  it("signs the fresh access token with hasPassword=true", async () => {
    prisma.user.findUnique.mockResolvedValue(GOOGLE_ONLY_USER as any);
    prisma.user.update.mockResolvedValue({
      ...GOOGLE_ONLY_USER,
      password: "$2b$10$newhash",
    } as any);
    prisma.tenant.findUnique.mockResolvedValue({ slug: "acme" } as any);
    prisma.refreshToken.upsert.mockResolvedValue({} as any);

    await service.setPassword("user-1", "NewPass1!");

    expect(jwtService.sign.mock.calls[0]![0]).toMatchObject({
      sub: "user-1",
      hasPassword: true,
      forcePasswordChange: false,
    });
  });

  it("fires a security notification email (fire-and-forget)", async () => {
    prisma.user.findUnique.mockResolvedValue(GOOGLE_ONLY_USER as any);
    prisma.user.update.mockResolvedValue({
      ...GOOGLE_ONLY_USER,
      password: "$2b$10$newhash",
    } as any);
    prisma.tenant.findUnique.mockResolvedValue({ slug: "acme" } as any);
    prisma.refreshToken.upsert.mockResolvedValue({} as any);

    await service.setPassword("user-1", "NewPass1!", { ipAddress: "1.2.3.4" });
    await Promise.resolve(); // flush microtasks — email is fire-and-forget

    expect(emailService.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "alice@example.com",
        subject: expect.stringContaining("password was set"),
        senderClass: "platform",
      }),
    );
  });

  it("REFUSES when the account already has a password (never overwrites)", async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...GOOGLE_ONLY_USER,
      password: "$2b$10$existing",
    } as any);

    await expect(service.setPassword("user-1", "NewPass1!")).rejects.toThrow(BadRequestException);
    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.refreshToken.deleteMany).not.toHaveBeenCalled();
  });

  it("throws Unauthorized for an unknown user", async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.setPassword("nobody", "NewPass1!")).rejects.toThrow(UnauthorizedException);
    expect(bcrypt.hash).not.toHaveBeenCalled();
  });
});

// ─── DTO + controller wiring ─────────────────────────────────────────────────

describe("SetPasswordDto validation and controller metatype", () => {
  it.each(["short1A", "alllowercase1", "ALLUPPERCASE1", "NoDigitsOrSpecials"])(
    "rejects weak password %p",
    async (newPassword) => {
      const dto = plainToInstance(SetPasswordDto, { newPassword });
      const errors = await validate(dto);
      expect(errors.map((e) => e.property)).toContain("newPassword");
    },
  );

  it("accepts a compliant password", async () => {
    const dto = plainToInstance(SetPasswordDto, { newPassword: "SecurePass1!" });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("setPassword handler body carries the concrete DTO metatype (ValidationPipe runs)", () => {
    const paramTypes =
      (Reflect.getMetadata(
        "design:paramtypes",
        AuthController.prototype,
        "setPassword",
      ) as unknown[]) ?? [];
    expect(paramTypes).toContain(SetPasswordDto);
  });
});
