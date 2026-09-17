import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { ForbiddenException } from "@nestjs/common";
import { GoogleOAuthService } from "./google-oauth.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("google-auth-library", () => ({ OAuth2Client: jest.fn() }));

/**
 * Regression coverage for a reactivation vulnerability caught in review of the
 * rescued B212/B213 auth fixes (PR #778): an earlier version of this file
 * activated an INACTIVE `handleTenantAuth` staff match on a matching Google
 * email, on the theory that INACTIVE means "self-signup admin pending email
 * verification." That's wrong — INACTIVE is the SAME status an admin sets via
 * `useChangeUserStatus`/`UsersService.changeStatus` (apps/web settings page,
 * `toggleStatus`) to deactivate ANY staff member, and the same status
 * `BillingCronService`'s seat-cap enforcement writes when a tenant downgrades
 * over its new OPERATOR/DRIVER seat cap. The `staffUser` query below matches
 * OPERATOR, DRIVER, and TENANT_ADMIN alike (see the `role: { in: [...] }`
 * filter above), so the activation path let ANY deactivated staff member
 * self-reactivate — with staff tokens, and their password nulled out — just
 * by signing in with Google using the same email their account already has.
 * `UserStatus` (prisma/schema/tenancy.prisma) has exactly three values —
 * ACTIVE, INACTIVE, SUSPENDED — with no column distinguishing "never
 * verified" from "deliberately deactivated," so this cannot be gated safely
 * by a status check alone. The fix is to leave handleTenantAuth's status
 * gate exactly as it was: any non-ACTIVE staff match is rejected outright,
 * with no side effect. A real self-signup-pending-verification signal would
 * need a schema discriminator (e.g. a nullable `emailVerifiedAt` column or a
 * distinct `PENDING_VERIFICATION` status) — proposed as a follow-up, not
 * built here.
 */
describe("GoogleOAuthService.handleTenantAuth — INACTIVE staff is rejected, never reactivated", () => {
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
    googleId: "google-real-id",
    email: "owner@acme.example",
    name: "Real Owner",
  };

  it.each(["TENANT_ADMIN", "OPERATOR", "DRIVER"] as const)(
    "rejects an INACTIVE %s with a matching Google email WITHOUT reactivating them or issuing tokens",
    async (role) => {
      const prisma = createMockPrisma();
      prisma.tenant.findFirst.mockResolvedValue(TENANT as any);
      const inactiveStaff = {
        id: `user-${role}`,
        email: "owner@acme.example",
        username: `acme_${role.toLowerCase()}`,
        role,
        status: "INACTIVE",
        googleId: null,
        // A staff member deactivated by an admin keeps their real password —
        // unlike self-signup, there is no "impostor-chosen" password to clear.
        password: "$2b$10$realHashOfTheirOwnChosenPassword",
        tenantId: TENANT.id,
      };
      prisma.user.findFirst.mockResolvedValue(inactiveStaff as any);

      const service = buildService(prisma);
      await expect(service.findOrCreateUser(baseProfile as any)).rejects.toThrow(
        new ForbiddenException("unauthorized"),
      );

      // The regression: this must NEVER write status:"ACTIVE" or null the password.
      expect(prisma.user.update).not.toHaveBeenCalled();
    },
  );

  it("still rejects a SUSPENDED staff member the same way, with no side effect", async () => {
    const prisma = createMockPrisma();
    prisma.tenant.findFirst.mockResolvedValue(TENANT as any);
    prisma.user.findFirst.mockResolvedValue({
      id: "user-suspended",
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

  it("an already-ACTIVE staff user with no prior Google link links normally (unaffected by the removed INACTIVE branch)", async () => {
    const prisma = createMockPrisma();
    prisma.tenant.findFirst.mockResolvedValue(TENANT as any);
    const activeUser = {
      id: "user-active",
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

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-active" },
      data: { googleId: "google-real-id", forcePasswordChange: false },
    });
    expect(result.kind).toBe("staff");
  });
});
