import * as fs from "fs";
import * as path from "path";
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException } from "@nestjs/common";
import { AuthService, hasSessionTenant } from "./auth.service";
import { EmailService } from "../email/email.service";
import { UsersService } from "../users/users.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { EntitlementsService } from "../billing/entitlements.service";

jest.mock("bcrypt", () => ({
  compare: jest.fn(),
  hash: jest.fn().mockResolvedValue("h"),
  genSalt: jest.fn(),
}));

/**
 * W-767 (SA-917): login's RF-176 rule, "a session with no business is a SUPER_ADMIN session", now also holds for refresh and
 * mintSessionForUser (changePassword / setPassword). Before, a user whose row had lost its tenantId kept renewing a
 * null-tenant JWT through refresh, and that JWT bypasses every forTenant() scope.
 */
const JWT_CONFIG = {
  secret: "test-jwt-secret-0123456789-abcdefghijklmnop",
  refreshSecret: "test-refresh-secret",
  expiresIn: "15m",
  refreshExpiresIn: "7d",
};
const user = (role: string, tenantId: string | null) => ({
  id: "user-1",
  username: "u",
  password: null,
  role,
  status: "ACTIVE",
  tenantId,
  forcePasswordChange: false,
  isAdmin: false,
  canActAsDriver: false,
  deletedAt: null,
});

describe("hasSessionTenant (W-767, RF-176)", () => {
  it.each([
    ["OPERATOR", "t-1", true],
    ["CUSTOMER", "t-1", true],
    ["SUPER_ADMIN", null, true],
    ["OPERATOR", null, false],
    ["TENANT_ADMIN", null, false],
    ["CUSTOMER", null, false],
  ])("%s with tenant %p -> %p", (role, tenantId, ok) => {
    expect(hasSessionTenant({ role, tenantId })).toBe(ok);
  });
});

describe("every staff token mint in auth.service.ts checks hasSessionTenant first (W-767 pin)", () => {
  it("login, refresh and mintSessionForUser are the only signing methods, and each checks before its first sign", () => {
    const src = fs.readFileSync(path.join(__dirname, "auth.service.ts"), "utf8");
    const heads = [...src.matchAll(/^  (?:private |public )?async (\w+)\(/gm)].map((m) => ({
      name: m[1],
      at: m.index!,
    }));
    const signing: string[] = [];
    heads.forEach((h, i) => {
      const body = src.slice(h.at, heads[i + 1]?.at ?? src.length);
      const sign = body.indexOf("this.jwtService.sign(");
      if (sign < 0) return;
      signing.push(h.name);
      const check = body.indexOf("hasSessionTenant(");
      expect({ method: h.name, checksFirst: check > -1 && check < sign }).toEqual({
        method: h.name,
        checksFirst: true,
      });
    });
    expect(signing.sort()).toEqual(["login", "mintSessionForUser", "refresh"]);
  });
});

describe("refresh and setPassword refuse a session with no business unless SUPER_ADMIN (W-767)", () => {
  let service: AuthService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let jwtService: { sign: jest.Mock; verify: jest.Mock; decode: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    jwtService = {
      sign: jest.fn().mockReturnValue("mock-token"),
      verify: jest.fn().mockReturnValue({ sub: "user-1" }),
      decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    };
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: UsersService, useValue: {} },
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(JWT_CONFIG) } },
        { provide: EmailService, useValue: { send: jest.fn() } },
        {
          provide: EntitlementsService,
          useValue: { claimsFor: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();
    service = module.get(AuthService);
    prisma.refreshToken.findUnique.mockResolvedValue({
      userId: "user-1",
      tokenHash: "h",
      expiresAt: new Date(Date.now() + 60_000),
    } as any);
    prisma.refreshToken.upsert.mockResolvedValue({} as any);
    prisma.tenant.findUnique.mockResolvedValue({ slug: "acme" } as any);
  });

  it("refresh: a tenantless OPERATOR is refused, its refresh token consumed, and nothing is minted", async () => {
    prisma.user.findUnique.mockResolvedValue(user("OPERATOR", null) as any);
    await expect(service.refresh("incoming")).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.refreshToken.deleteMany).toHaveBeenCalled();
    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it("refresh: a tenantless SUPER_ADMIN still renews (the platform session)", async () => {
    prisma.user.findUnique.mockResolvedValue(user("SUPER_ADMIN", null) as any);
    await expect(service.refresh("incoming")).resolves.toMatchObject({ accessToken: "mock-token" });
  });

  it("setPassword (mintSessionForUser): a tenantless OPERATOR is refused before any session is revoked or minted", async () => {
    prisma.user.findUnique.mockResolvedValue(user("OPERATOR", null) as any);
    prisma.user.update.mockResolvedValue(user("OPERATOR", null) as any);
    prisma.passwordResetToken.updateMany.mockResolvedValue({ count: 0 } as any);
    await expect(service.setPassword("user-1", "N3w-passw0rd!")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.refreshToken.deleteMany).not.toHaveBeenCalled();
    expect(jwtService.sign).not.toHaveBeenCalled();
  });
});
