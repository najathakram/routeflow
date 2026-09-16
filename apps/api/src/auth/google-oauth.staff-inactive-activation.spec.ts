import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { ForbiddenException } from "@nestjs/common";
import { GoogleOAuthService } from "./google-oauth.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("google-auth-library", () => ({ OAuth2Client: jest.fn() }));

/**
 * B212/B213 follow-up: a self-service tenant signup (TenantsService.register)
 * creates the TENANT_ADMIN INACTIVE until the emailed verification link is
 * clicked. "Sign in with Google" is the natural alternative a self-signup
 * admin reaches for when that email never arrives — but it used to be an
 * identical dead end: a bare "unauthorized" (the web callback renders this as
 * "contact your administrator", even though this person IS the
 * administrator), despite Google having just verified the exact mailbox the
 * lost verification email was trying to prove. This pins the fix:
 * handleTenantAuth now activates an INACTIVE staff user when Google attests
 * their own email, mirroring handleBuyerPortalAuth's googleAttestsMailbox
 * check, and neutralizes any password set at signup time (it could have been
 * chosen by an impostor who signed up under this email — the real owner's
 * Google identity must not inherit a password they don't control).
 */
describe("GoogleOAuthService.handleTenantAuth — INACTIVE self-signup admin activation", () => {
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
    return new GoogleOAuthService(
      prisma as any,
      jwt,
      config,
      { send: jest.fn().mockResolvedValue(undefined) } as any, // email
      { claimsFor: jest.fn().mockResolvedValue(null) } as any, // entitlements
    );
  }

  const TENANT = { id: "tenant-1", slug: "acme-distribution", status: "ACTIVE" };
  const baseProfile = {
    type: "tenant" as const,
    tenantSlug: TENANT.slug,
    googleId: "google-victim-real-id",
    email: "owner@acme.example",
    name: "Real Owner",
  };

  it("activates an INACTIVE admin whose email Google just verified, and clears the signup-time password", async () => {
    const prisma = createMockPrisma();
    prisma.tenant.findFirst.mockResolvedValue(TENANT as any);
    const inactiveAdmin = {
      id: "user-1",
      email: "owner@acme.example",
      username: "acme_admin",
      role: "TENANT_ADMIN",
      status: "INACTIVE",
      googleId: null,
      password: "$2b$10$whoeverSubmittedTheFormChoseThis",
      tenantId: TENANT.id,
    };
    prisma.user.findFirst.mockResolvedValue(inactiveAdmin as any);
    prisma.user.update.mockImplementation(({ data }: any) =>
      Promise.resolve({ ...inactiveAdmin, ...data }),
    );

    const service = buildService(prisma);
    const result: any = await service.findOrCreateUser(baseProfile as any);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        status: "ACTIVE",
        googleId: "google-victim-real-id",
        password: null,
        forcePasswordChange: false,
      },
    });
    expect(result.kind).toBe("staff");
    expect(result.user).toMatchObject({
      id: "user-1",
      tenantId: TENANT.id,
      tenantSlug: TENANT.slug,
    });
    expect(result.accessToken).toBe("tok");
  });

  it("does NOT activate an INACTIVE user when Google's verified email does not match the account's own email", async () => {
    const prisma = createMockPrisma();
    prisma.tenant.findFirst.mockResolvedValue(TENANT as any);
    prisma.user.findFirst.mockResolvedValue({
      id: "user-2",
      email: "owner@acme.example",
      role: "TENANT_ADMIN",
      status: "INACTIVE",
      googleId: null,
      password: "hash",
      tenantId: TENANT.id,
    } as any);

    const service = buildService(prisma);
    // profile.email deliberately different from the account's email.
    await expect(
      service.findOrCreateUser({ ...baseProfile, email: "someone-else@example.com" } as any),
    ).rejects.toThrow(new ForbiddenException("unauthorized"));
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("does NOT resurrect a SUSPENDED admin via Google, even with a matching email", async () => {
    const prisma = createMockPrisma();
    prisma.tenant.findFirst.mockResolvedValue(TENANT as any);
    prisma.user.findFirst.mockResolvedValue({
      id: "user-3",
      email: "owner@acme.example",
      role: "TENANT_ADMIN",
      status: "SUSPENDED",
      googleId: null,
      password: "hash",
      tenantId: TENANT.id,
    } as any);

    const service = buildService(prisma);
    await expect(service.findOrCreateUser(baseProfile as any)).rejects.toThrow(
      new ForbiddenException("unauthorized"),
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("still rejects with google_email_is_staff for a buyer-portal-context request, without activating", async () => {
    const prisma = createMockPrisma();
    prisma.tenant.findFirst.mockResolvedValue(TENANT as any);
    prisma.user.findFirst.mockResolvedValue({
      id: "user-4",
      email: "owner@acme.example",
      role: "TENANT_ADMIN",
      status: "INACTIVE",
      googleId: null,
      password: "hash",
      tenantId: TENANT.id,
    } as any);

    const service = buildService(prisma);
    await expect(
      service.findOrCreateUser({ ...baseProfile, context: "portal" } as any),
    ).rejects.toThrow(new ForbiddenException("google_email_is_staff"));
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("an already-ACTIVE staff user with no prior Google link is unaffected by the INACTIVE-activation branch", async () => {
    const prisma = createMockPrisma();
    prisma.tenant.findFirst.mockResolvedValue(TENANT as any);
    const activeUser = {
      id: "user-5",
      email: "owner@acme.example",
      username: "acme_admin",
      role: "TENANT_ADMIN",
      status: "ACTIVE",
      googleId: null,
      password: "hash",
      tenantId: TENANT.id,
    };
    prisma.user.findFirst.mockResolvedValue(activeUser as any);
    prisma.user.update.mockImplementation(({ data }: any) =>
      Promise.resolve({ ...activeUser, ...data }),
    );

    const service = buildService(prisma);
    const result: any = await service.findOrCreateUser(baseProfile as any);

    // Existing link-on-first-sign-in behavior, unchanged: no status/password touched.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-5" },
      data: { googleId: "google-victim-real-id", forcePasswordChange: false },
    });
    expect(result.kind).toBe("staff");
  });
});
