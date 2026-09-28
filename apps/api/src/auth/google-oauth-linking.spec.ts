import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { ConflictException } from "@nestjs/common";
import { GoogleOAuthService } from "./google-oauth.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("google-auth-library", () => ({ OAuth2Client: jest.fn() }));

/**
 * #2495: `handlePlatformAuth`, `handleTenantAuth`'s staff lookup and
 * `handleBuyerPortalAuth` used to resolve via
 * `findFirst({ OR: [{ googleId }, { email }] })`, which is nondeterministic
 * when two rows match (one bound to the signing-in Google sub, another merely
 * sharing the email — Postgres gives no ordering guarantee over an
 * unordered OR). This pins:
 *   (a) sub match wins over an email match, and a different bound sub 409s
 *       with no update, on all three flows;
 *   (b) a googleId-NULL email match still auto-links;
 *   (c) the staff access token carries `isAdmin`/`canActAsDriver` exactly like
 *       AuthService.login();
 *   (d) no logger call ever carries the profile email.
 */
describe("GoogleOAuthService — lookup order & claims (#2495)", () => {
  function buildService(prisma: ReturnType<typeof createMockPrisma>) {
    const config = {
      get: (key: string) => {
        if (key === "jwt") {
          return { secret: "s", refreshSecret: "rs", expiresIn: "15m", refreshExpiresIn: "30d" };
        }
        return undefined;
      },
    } as unknown as ConfigService;
    const jwt = {
      sign: jest.fn().mockReturnValue("tok"),
      decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    } as unknown as JwtService;
    const emailService = { send: jest.fn().mockResolvedValue(undefined) };
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const service = new GoogleOAuthService(
      prisma as any,
      jwt,
      config,
      emailService as any,
      { claimsFor: jest.fn().mockResolvedValue(null) } as any,
    );
    (service as any).logger = logger;
    return { service, emailService, logger, jwt };
  }

  const PROFILE_EMAIL = "person@example.com";
  const profileFor = (googleId: string) => ({
    type: "platform" as const,
    googleId,
    email: PROFILE_EMAIL,
    name: "Person",
  });

  // ─── (a) sub match wins over email match ─────────────────────────────────

  it("platform: a sub match wins even though a DIFFERENT row shares the email", async () => {
    const prisma = createMockPrisma();
    const subRow = {
      id: "user-sub",
      username: "admin1",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      googleId: "google-sub-123",
      email: "other@example.com",
      tenantId: null,
    };
    const emailRow = {
      id: "user-email",
      username: "admin2",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      googleId: null,
      email: PROFILE_EMAIL,
      tenantId: null,
    };
    prisma.user.findFirst.mockImplementation(({ where }: any) => {
      if (where.googleId === "google-sub-123") return Promise.resolve(subRow);
      if (where.email === PROFILE_EMAIL) return Promise.resolve(emailRow);
      return Promise.resolve(null);
    });

    const { service } = buildService(prisma);
    const result: any = await service.findOrCreateUser(profileFor("google-sub-123") as any);

    expect(result.user.id).toBe("user-sub");
    // The sub match already has a googleId — no link/re-link update should fire
    // (issueUserTokenPair's lastLoginAt stamp is the only update() call expected).
    expect(prisma.user.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ googleId: expect.anything() }) }),
    );
  });

  // ─── (a) different bound sub → 409, no update ────────────────────────────

  it("platform: an email match already bound to a DIFFERENT sub is refused with 409, no update", async () => {
    const prisma = createMockPrisma();
    prisma.user.findFirst.mockImplementation(({ where }: any) => {
      if (where.googleId === "attacker-sub") return Promise.resolve(null);
      if (where.email === PROFILE_EMAIL) {
        return Promise.resolve({
          id: "user-victim",
          username: "victim",
          role: "SUPER_ADMIN",
          status: "ACTIVE",
          googleId: "victim-real-sub",
          email: PROFILE_EMAIL,
          tenantId: null,
        });
      }
      return Promise.resolve(null);
    });
    const { service } = buildService(prisma);

    await expect(service.findOrCreateUser(profileFor("attacker-sub") as any)).rejects.toThrow(
      new ConflictException("google_account_mismatch"),
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("staff: an email match already bound to a DIFFERENT sub is refused with 409, no update", async () => {
    const prisma = createMockPrisma();
    const TENANT = { id: "tenant-1", slug: "acme", status: "ACTIVE" };
    prisma.tenant.findFirst.mockResolvedValue(TENANT as any);
    prisma.user.findFirst.mockImplementation(({ where }: any) => {
      if (where.googleId === "attacker-sub") return Promise.resolve(null);
      if (where.email === PROFILE_EMAIL) {
        return Promise.resolve({
          id: "staff-victim",
          username: "staff1",
          role: "OPERATOR",
          status: "ACTIVE",
          googleId: "staff-real-sub",
          email: PROFILE_EMAIL,
          tenantId: TENANT.id,
        });
      }
      return Promise.resolve(null);
    });

    const { service } = buildService(prisma);
    const profile = {
      type: "tenant" as const,
      tenantSlug: TENANT.slug,
      googleId: "attacker-sub",
      email: PROFILE_EMAIL,
      name: "Person",
    };

    await expect(service.findOrCreateUser(profile as any)).rejects.toThrow(
      new ConflictException("google_account_mismatch"),
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("buyer: an email match already bound to a DIFFERENT sub is refused with 409, no update", async () => {
    const prisma = createMockPrisma();
    prisma.buyerAccount.findFirst.mockImplementation(({ where }: any) => {
      if (where.googleId === "attacker-sub") return Promise.resolve(null);
      if (where.email === PROFILE_EMAIL) {
        return Promise.resolve({
          id: "buyer-victim",
          email: PROFILE_EMAIL,
          name: "Victim",
          googleId: "buyer-real-sub",
          status: "ACTIVE",
          deletedAt: null,
          passwordSet: true,
          emailVerified: true,
        });
      }
      return Promise.resolve(null);
    });

    const { service } = buildService(prisma);
    const profile = {
      type: "tenant" as const,
      context: "buyer-standalone" as const,
      googleId: "attacker-sub",
      email: PROFILE_EMAIL,
      name: "Person",
    };

    await expect(service.findOrCreateUser(profile as any)).rejects.toThrow(
      new ConflictException("google_account_mismatch"),
    );
    expect(prisma.buyerAccount.update).not.toHaveBeenCalled();
  });

  // ─── (b) googleId-NULL email match still auto-links ──────────────────────

  it("platform: a googleId-NULL email match links normally (no sub row exists yet)", async () => {
    const prisma = createMockPrisma();
    const row = {
      id: "user-1",
      username: "admin",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      googleId: null,
      email: PROFILE_EMAIL,
      tenantId: null,
    };
    prisma.user.findFirst.mockImplementation(({ where }: any) => {
      if (where.googleId) return Promise.resolve(null);
      return Promise.resolve(row);
    });
    prisma.user.update.mockImplementation(({ data }: any) => Promise.resolve({ ...row, ...data }));

    const { service } = buildService(prisma);
    const result: any = await service.findOrCreateUser(profileFor("google-new") as any);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { googleId: "google-new", forcePasswordChange: false },
    });
    expect(result.user.id).toBe("user-1");
  });

  // ─── (c) staff access token claims mirror AuthService.login() ────────────

  it("staff access token carries isAdmin (from role) and canActAsDriver, mirroring AuthService.login()", async () => {
    const prisma = createMockPrisma();
    const TENANT = { id: "tenant-1", slug: "acme", status: "ACTIVE" };
    prisma.tenant.findFirst.mockResolvedValue(TENANT as any);
    const staffRow = {
      id: "staff-1",
      username: "admin1",
      role: "TENANT_ADMIN",
      status: "ACTIVE",
      googleId: "google-staff",
      email: PROFILE_EMAIL,
      tenantId: TENANT.id,
      isAdmin: false, // role-derived isAdmin must still be true
      canActAsDriver: true,
      forcePasswordChange: false,
      password: "hash",
    };
    prisma.user.findFirst.mockImplementation(({ where }: any) => {
      if (where.googleId === "google-staff") return Promise.resolve(staffRow);
      return Promise.resolve(null);
    });

    const { service, jwt } = buildService(prisma);
    const profile = {
      type: "tenant" as const,
      tenantSlug: TENANT.slug,
      googleId: "google-staff",
      email: PROFILE_EMAIL,
      name: "Admin",
    };
    await service.findOrCreateUser(profile as any);

    const signedPayload = (jwt.sign as jest.Mock).mock.calls.find(
      ([payload]: any[]) => payload.sub === "staff-1",
    )?.[0];
    expect(signedPayload).toMatchObject({ isAdmin: true, canActAsDriver: true });
  });

  it("staff access token carries isAdmin=false for a non-admin OPERATOR with role-derived isAdmin still respected", async () => {
    const prisma = createMockPrisma();
    const TENANT = { id: "tenant-1", slug: "acme", status: "ACTIVE" };
    prisma.tenant.findFirst.mockResolvedValue(TENANT as any);
    const staffRow = {
      id: "staff-2",
      username: "op1",
      role: "OPERATOR",
      status: "ACTIVE",
      googleId: "google-op",
      email: PROFILE_EMAIL,
      tenantId: TENANT.id,
      isAdmin: false,
      canActAsDriver: false,
      forcePasswordChange: false,
      password: "hash",
    };
    prisma.user.findFirst.mockImplementation(({ where }: any) => {
      if (where.googleId === "google-op") return Promise.resolve(staffRow);
      return Promise.resolve(null);
    });

    const { service, jwt } = buildService(prisma);
    const profile = {
      type: "tenant" as const,
      tenantSlug: TENANT.slug,
      googleId: "google-op",
      email: PROFILE_EMAIL,
      name: "Op",
    };
    await service.findOrCreateUser(profile as any);

    const signedPayload = (jwt.sign as jest.Mock).mock.calls.find(
      ([payload]: any[]) => payload.sub === "staff-2",
    )?.[0];
    expect(signedPayload).toMatchObject({ isAdmin: false, canActAsDriver: false });
  });

  // ─── (d) no email in logs ─────────────────────────────────────────────────

  it("never logs the profile email — linkGoogleAccount", async () => {
    const prisma = createMockPrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      email: "secret@example.com",
      googleId: null,
      tenantId: null,
      deletedAt: null,
    } as any);
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.update.mockResolvedValue({} as any);

    const { service, logger } = buildService(prisma);
    await service.linkGoogleAccount({
      linkUserId: "user-1",
      googleId: "g1",
      email: "secret@example.com",
      name: "Secret",
      picture: "",
      type: "tenant",
    } as any);

    assertNoEmailLogged(logger, "secret@example.com");
  });

  it("never logs the profile email — buyer auto-create", async () => {
    const prisma = createMockPrisma();
    prisma.buyerAccount.findFirst.mockResolvedValue(null);
    prisma.buyerAccount.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: "buyer-new", ...data }),
    );
    prisma.customerLink.count.mockResolvedValue(0);
    prisma.buyerRefreshToken.upsert.mockResolvedValue({} as any);

    const { service, logger } = buildService(prisma);
    const profile = {
      type: "tenant" as const,
      context: "buyer-standalone" as const,
      googleId: "google-1",
      email: "new-buyer-secret@example.com",
      name: "New Buyer",
    };
    await service.findOrCreateUser(profile as any);

    assertNoEmailLogged(logger, "new-buyer-secret@example.com");
  });

  function assertNoEmailLogged(
    logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock },
    email: string,
  ) {
    for (const fn of [logger.log, logger.warn, logger.error, logger.debug]) {
      for (const call of fn.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain(email);
        }
      }
    }
  }
});
