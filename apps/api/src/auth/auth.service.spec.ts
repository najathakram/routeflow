import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException, BadRequestException, ForbiddenException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { AuthService } from "./auth.service";
import { EmailService } from "../email/email.service";

jest.mock("bcrypt", () => ({
  compare: jest.fn(),
  hash: jest.fn(),
  genSalt: jest.fn(),
}));
import { UsersService } from "../users/users.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { EntitlementsService } from "../billing/entitlements.service";

const JWT_CONFIG = {
  secret: "test-secret",
  refreshSecret: "test-refresh-secret",
  expiresIn: "15m",
  refreshExpiresIn: "7d",
};

const MOCK_USER = {
  id: "user-1",
  email: "admin@test.com",
  username: "admin",
  password: "$2b$10$hashedpassword",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
  failedLoginAttempts: 0,
  lockedUntil: null as Date | null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("AuthService", () => {
  let service: AuthService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let usersService: {
    findByUsername: jest.Mock;
    findByUsernameCrossTenant: jest.Mock;
    findByEmailCrossTenant: jest.Mock;
  };
  let jwtService: { sign: jest.Mock; verify: jest.Mock; decode: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    usersService = {
      findByUsername: jest.fn(),
      findByUsernameCrossTenant: jest.fn().mockResolvedValue(null),
      findByEmailCrossTenant: jest.fn().mockResolvedValue(null),
    };
    jwtService = {
      sign: jest.fn().mockReturnValue("mock-token"),
      verify: jest.fn(),
      decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: jwtService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(JWT_CONFIG) },
        },
        {
          provide: EmailService,
          useValue: { send: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: EntitlementsService,
          useValue: { claimsFor: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  // ─── validateUser ─────────────────────────────────────────────────────────

  describe("validateUser", () => {
    it("should return user data (without password) when credentials are valid", async () => {
      usersService.findByUsername.mockResolvedValue(MOCK_USER);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.validateUser("admin", "correct-password");

      expect(result).toBeDefined();
      expect(result!.id).toBe("user-1");
      expect(result).not.toHaveProperty("password");
    });

    it("should return null when user does not exist", async () => {
      usersService.findByUsername.mockResolvedValue(null);
      const result = await service.validateUser("nobody", "pass");
      expect(result).toBeNull();
    });

    it("should return null when password is wrong", async () => {
      usersService.findByUsername.mockResolvedValue(MOCK_USER);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      const result = await service.validateUser("admin", "wrong-password");
      expect(result).toBeNull();
    });

    it("should return null for soft-deleted users", async () => {
      usersService.findByUsername.mockResolvedValue({ ...MOCK_USER, deletedAt: new Date() });
      const result = await service.validateUser("admin", "correct-password");
      expect(result).toBeNull();
    });

    it("should return null for suspended users even with the correct password", async () => {
      usersService.findByUsername.mockResolvedValue({ ...MOCK_USER, status: "SUSPENDED" });
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      const result = await service.validateUser("admin", "correct-password");
      expect(result).toBeNull();
    });

    // Repro-first regression test for the "signup doesn't work" report: a
    // self-service tenant signup (TenantsService.register) creates the admin
    // user with status INACTIVE until the emailed verification link is
    // clicked. Before this fix, validateUser checked status BEFORE the
    // password, so a real self-signup user typing their own correct password
    // got back the exact same "Invalid credentials" as a wrong password or a
    // nonexistent account — indistinguishable, and impossible to self-diagnose.
    describe("INACTIVE user (pending email verification)", () => {
      it("throws a distinguishable EMAIL_NOT_VERIFIED error when the password IS correct", async () => {
        usersService.findByUsername.mockResolvedValue({ ...MOCK_USER, status: "INACTIVE" });
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);

        let caught: ForbiddenException | undefined;
        try {
          await service.validateUser("admin", "correct-password");
        } catch (err) {
          caught = err as ForbiddenException;
        }
        expect(caught).toBeInstanceOf(ForbiddenException);
        expect(caught!.getResponse()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
      });

      it("returns null (no leak) when the password is WRONG — never reveals the account is pending verification to a guesser", async () => {
        usersService.findByUsername.mockResolvedValue({ ...MOCK_USER, status: "INACTIVE" });
        (bcrypt.compare as jest.Mock).mockResolvedValue(false);

        const result = await service.validateUser("admin", "wrong-password");
        expect(result).toBeNull();
      });
    });
  });

  // ─── account lockout ──────────────────────────────────────────────────────

  describe("account lockout", () => {
    beforeEach(() => {
      (bcrypt.compare as jest.Mock).mockClear();
    });

    it("locked account returns null WITHOUT running bcrypt (no timing oracle)", async () => {
      usersService.findByUsername.mockResolvedValue({
        ...MOCK_USER,
        lockedUntil: new Date(Date.now() + 60_000),
      });

      const result = await service.validateUser("admin", "correct-password");

      expect(result).toBeNull();
      expect(bcrypt.compare).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("a failed attempt increments the counter", async () => {
      usersService.findByUsername.mockResolvedValue({ ...MOCK_USER, failedLoginAttempts: 3 });
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await service.validateUser("admin", "wrong-password");

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { failedLoginAttempts: 4 },
      });
    });

    it("the Nth failure locks for 15 minutes and resets the counter", async () => {
      usersService.findByUsername.mockResolvedValue({
        ...MOCK_USER,
        failedLoginAttempts: AuthService.LOCKOUT_THRESHOLD - 1,
      });
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      const before = Date.now();
      await service.validateUser("admin", "wrong-password");

      const update = prisma.user.update.mock.calls[0][0];
      expect(update.data.failedLoginAttempts).toBe(0);
      const lockedUntil = update.data.lockedUntil as Date;
      expect(lockedUntil.getTime()).toBeGreaterThanOrEqual(
        before + AuthService.LOCKOUT_WINDOW_MS - 1000,
      );
      expect(lockedUntil.getTime()).toBeLessThanOrEqual(
        Date.now() + AuthService.LOCKOUT_WINDOW_MS + 1000,
      );
    });

    it("a successful login clears the counter and any expired lock", async () => {
      usersService.findByUsername.mockResolvedValue({
        ...MOCK_USER,
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() - 60_000), // expired
      });
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.validateUser("admin", "correct-password");

      expect(result).not.toBeNull();
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    });

    it("a failure after an expired lock restarts the streak at 1", async () => {
      usersService.findByUsername.mockResolvedValue({
        ...MOCK_USER,
        failedLoginAttempts: 0,
        lockedUntil: new Date(Date.now() - 60_000), // expired
      });
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await service.validateUser("admin", "wrong-password");

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { failedLoginAttempts: 1, lockedUntil: null },
      });
    });
  });

  // ─── login ────────────────────────────────────────────────────────────────

  describe("login", () => {
    const validUser = {
      id: "user-1",
      username: "admin",
      role: "OPERATOR" as const,
      status: "ACTIVE" as const,
      forcePasswordChange: false,
      tenantId: "tenant-1",
      isAdmin: false,
      canActAsDriver: false,
    };

    beforeEach(() => {
      // RF-176: login() looks up tenant slug from prisma.tenant
      prisma.tenant.findUnique.mockResolvedValue({ slug: "test-tenant" } as any);
    });

    it("should return access token, refresh token, and user", async () => {
      prisma.refreshToken.upsert.mockResolvedValue({} as any);

      const result = await service.login(validUser as any);

      expect(result).toHaveProperty("accessToken", "mock-token");
      expect(result).toHaveProperty("refreshToken", "mock-token");
      expect(result.user.id).toBe("user-1");
      expect(jwtService.sign).toHaveBeenCalledTimes(2);
    });

    it("should store the refresh token hash in the database", async () => {
      prisma.refreshToken.upsert.mockResolvedValue({} as any);

      await service.login(validUser as any);

      expect(prisma.refreshToken.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ userId: "user-1" }),
        }),
      );
    });

    it("marks hasPassword=true in payload and user for password logins (stripped user)", async () => {
      // validateUser strips `password` — its absence implies a password login
      prisma.refreshToken.upsert.mockResolvedValue({} as any);

      const result = await service.login(validUser as any);

      expect(jwtService.sign.mock.calls[0]![0]).toMatchObject({ hasPassword: true });
      expect(result.user).toMatchObject({ hasPassword: true });
    });

    it("marks hasPassword=false when a raw null-password user row is passed (legacy Google path)", async () => {
      prisma.refreshToken.upsert.mockResolvedValue({} as any);

      const result = await service.login({ ...validUser, password: null } as any);

      expect(jwtService.sign.mock.calls[0]![0]).toMatchObject({ hasPassword: false });
      expect(result.user).toMatchObject({ hasPassword: false });
    });
  });

  // ─── refresh ──────────────────────────────────────────────────────────────

  describe("refresh", () => {
    it("carries hasPassword=false into the rotated token for Google-only users", async () => {
      jwtService.verify.mockReturnValue({ sub: "user-1" });
      prisma.refreshToken.findUnique.mockResolvedValue({
        userId: "user-1",
        tokenHash: "h",
        expiresAt: new Date(Date.now() + 60_000),
        userAgent: null,
        ipAddress: null,
        deviceName: null,
      } as any);
      prisma.user.findUnique.mockResolvedValue({
        ...MOCK_USER,
        password: null,
        tenantId: "tenant-1",
      } as any);
      prisma.tenant.findUnique.mockResolvedValue({ slug: "test-tenant" } as any);
      prisma.refreshToken.upsert.mockResolvedValue({} as any);

      const result = await service.refresh("incoming-token");

      expect(jwtService.sign.mock.calls[0]![0]).toMatchObject({ hasPassword: false });
      expect(result.user).toMatchObject({ hasPassword: false });
    });
  });

  // ─── F5-003: refresh-token realm discriminator ─────────────────────────────

  describe("refresh — F5-003 realm discriminator", () => {
    function primeValidStoredToken() {
      prisma.refreshToken.findUnique.mockResolvedValue({
        userId: "user-1",
        tokenHash: "h",
        expiresAt: new Date(Date.now() + 60_000),
        userAgent: null,
        ipAddress: null,
        deviceName: null,
      } as any);
      prisma.user.findUnique.mockResolvedValue({ ...MOCK_USER, tenantId: "tenant-1" } as any);
      prisma.tenant.findUnique.mockResolvedValue({ slug: "test-tenant" } as any);
      prisma.refreshToken.upsert.mockResolvedValue({} as any);
    }

    it("rejects a buyer-typed refresh token on the staff refresh path", async () => {
      // A buyer refresh token would verify against the shared secret, but its
      // realm claim must bar it from the staff endpoint — before any DB lookup.
      jwtService.verify.mockReturnValue({ sub: "user-1", type: "buyer" });

      await expect(service.refresh("buyer-token")).rejects.toThrow(UnauthorizedException);
      expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
    });

    it("allows a legacy (no-type) refresh token — grace so live sessions survive", async () => {
      jwtService.verify.mockReturnValue({ sub: "user-1" }); // no `type` claim
      primeValidStoredToken();

      const result = await service.refresh("legacy-token");

      expect(result).toHaveProperty("accessToken");
      expect(result).toHaveProperty("refreshToken");
    });

    it("allows a staff-typed refresh token and mints a staff-typed replacement", async () => {
      jwtService.verify.mockReturnValue({ sub: "user-1", type: "staff" });
      primeValidStoredToken();

      const result = await service.refresh("staff-token");

      expect(result).toHaveProperty("accessToken");
      // calls[0] = access payload, calls[1] = rotated refresh payload
      expect(jwtService.sign.mock.calls[1]![0]).toMatchObject({ sub: "user-1", type: "staff" });
    });

    it("stamps type:staff on the refresh token minted at login", async () => {
      prisma.tenant.findUnique.mockResolvedValue({ slug: "test-tenant" } as any);
      prisma.refreshToken.upsert.mockResolvedValue({} as any);

      await service.login({
        id: "user-1",
        username: "admin",
        role: "OPERATOR",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId: "tenant-1",
        isAdmin: false,
        canActAsDriver: false,
      } as any);

      expect(jwtService.sign.mock.calls[1]![0]).toMatchObject({ sub: "user-1", type: "staff" });
    });
  });

  // ─── logout ───────────────────────────────────────────────────────────────

  describe("logout", () => {
    it("should delete all refresh tokens for the user", async () => {
      prisma.refreshToken.deleteMany.mockResolvedValue({ count: 2 });

      const result = await service.logout("user-1");

      expect(result).toEqual({ message: "Logged out successfully" });
      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: "user-1" },
      });
    });
  });

  // ─── changePassword ───────────────────────────────────────────────────────

  describe("changePassword", () => {
    it("should hash the new password and update the user", async () => {
      prisma.user.findUnique.mockResolvedValue(MOCK_USER);
      (bcrypt.compare as jest.Mock)
        .mockResolvedValueOnce(true) // current password is correct
        .mockResolvedValueOnce(false); // new password differs from old
      (bcrypt.hash as jest.Mock).mockResolvedValue("new-hash");
      prisma.user.update.mockResolvedValue({} as any);

      const result = await service.changePassword("user-1", "old", "new");

      expect(result).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/Password changed successfully/),
        }),
      );
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            password: "new-hash",
            forcePasswordChange: false,
          }),
        }),
      );
    });

    it("should throw BadRequestException when current password is incorrect", async () => {
      prisma.user.findUnique.mockResolvedValue(MOCK_USER);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(service.changePassword("user-1", "wrong", "new")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw UnauthorizedException when user not found", async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.changePassword("nobody", "old", "new")).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  // ─── refresh — in-place rotation (B155) / T19 / R13 ────────────────────────

  describe("refresh — in-place rotation (B155)", () => {
    const T0 = new Date("2026-01-01T00:00:00.000Z");
    const stored = {
      id: "rt-1",
      userId: "user-1",
      tokenHash: "h-old",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: T0,
      lastUsedAt: T0,
      userAgent: null,
      ipAddress: null,
      deviceName: null,
    };
    const sha256 = (value: string) =>
      require("crypto").createHash("sha256").update(value).digest("hex");
    // The rotated token jwtService.sign() mints in this suite is "mock-token";
    // "incoming-token" is the token the caller presents.
    const newHash = () => sha256("mock-token");

    function prime() {
      jwtService.verify.mockReturnValue({ sub: "user-1", type: "staff" });
      prisma.refreshToken.findUnique.mockResolvedValue(stored as any);
      prisma.user.findUnique.mockResolvedValue({ ...MOCK_USER, tenantId: "tenant-1" } as any);
      prisma.tenant.findUnique.mockResolvedValue({ slug: "test-tenant" } as any);
    }

    it("REG-B155 rotates the stored row IN PLACE (same id, compare-and-swap on the old hash) and never deletes or upserts", async () => {
      prime();
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.refresh("incoming-token");

      expect(result).toHaveProperty("accessToken");
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(1);
      const call = prisma.refreshToken.updateMany.mock.calls[0]![0] as any;
      expect(call.where).toEqual({ id: "rt-1", tokenHash: "h-old" });
      expect(call.data.tokenHash).toBe(newHash());
      expect(call.data.expiresAt).toBeInstanceOf(Date);
      expect(call.data.lastUsedAt).toBeInstanceOf(Date);
      // Per key, not `not.arrayContaining([...])` — that matcher negates the
      // CONJUNCTION, so it only fails when every listed key is present.
      for (const identityColumn of ["id", "createdAt", "userId", "tenantId"]) {
        expect(call.data).not.toHaveProperty(identityColumn);
      }
      // No deviceInfo supplied → device columns untouched (undefined, never null).
      expect(call.data.userAgent).toBeUndefined();
      expect(call.data.ipAddress).toBeUndefined();
      expect(call.data.deviceName).toBeUndefined();
      expect(prisma.refreshToken.deleteMany).not.toHaveBeenCalled();
      expect(prisma.refreshToken.upsert).not.toHaveBeenCalled();
    });

    it("pin (B155): losing the concurrent-rotation race (count 0) falls back to creating a fresh row — both refreshes succeed", async () => {
      prime();
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
      prisma.refreshToken.upsert.mockResolvedValue({} as any);

      const result = await service.refresh("incoming-token");

      expect(result).toHaveProperty("refreshToken");
      expect(prisma.refreshToken.upsert).toHaveBeenCalledTimes(1);
      expect((prisma.refreshToken.upsert.mock.calls[0]![0] as any).where).toEqual({
        tokenHash: newHash(),
      });
    });

    it("pin (B155): an inactive user's presented token is still consumed before the 401", async () => {
      prime();
      prisma.user.findUnique.mockResolvedValue({ ...MOCK_USER, status: "SUSPENDED" } as any);

      await expect(service.refresh("incoming-token")).rejects.toThrow(UnauthorizedException);
      // The PRESENTED token's hash — not `expect.any(String)`, which would also
      // pass if the rotated hash (or any other) were deleted instead.
      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { tokenHash: sha256("incoming-token") },
      });
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it("REG-B155 every rotation mints a UNIQUE refresh token (jti) — two sessions rotating in the same second cannot collide on the unique tokenHash", async () => {
      prime();
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });

      await service.refresh("incoming-token");
      await service.refresh("incoming-token");

      // Each refresh signs twice: [0]/[2] the access token, [1]/[3] the rotated
      // refresh token. Without a nonce the rotated payload is only {sub, type} and
      // jsonwebtoken's iat/exp at one-second resolution — byte-identical tokens, one
      // `tokenHash`, and a P2002 on the compare-and-swap (RefreshToken.tokenHash is @unique).
      const first = jwtService.sign.mock.calls[1]![0] as any;
      const second = jwtService.sign.mock.calls[3]![0] as any;
      expect(first).toMatchObject({ sub: "user-1", type: "staff" });
      expect(typeof first.jti).toBe("string");
      expect(first.jti).not.toEqual(second.jti);
    });
  });
});
