import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import * as crypto from "crypto";
import { GoogleOAuthService } from "./google-oauth.service";
import { TenantGoogleOAuthService } from "../tenants/tenant-google-oauth.service";
import { EncryptionService } from "../common/encryption.service";

jest.mock("google-auth-library", () => ({
  OAuth2Client: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OAuth2Client } = require("google-auth-library");

/**
 * F3-001 regression: Google account linking/matching must REJECT ID tokens
 * whose email is not verified by Google. Unverified emails can be claimed
 * with arbitrary addresses (workspace aliases, edu domains), enabling
 * account-takeover via a spoofed email match. Both OAuth paths are pinned:
 * the platform-level GoogleOAuthService.verifyCallback and the legacy
 * per-tenant TenantGoogleOAuthService.exchangeCode.
 */

// ─── Platform path: GoogleOAuthService.verifyCallback ─────────────────────────

describe("GoogleOAuthService.verifyCallback email_verified (F3-001)", () => {
  const CONFIG_VALUES: Record<string, string> = {
    GOOGLE_REDIRECT_URI_TENANT: "https://example.test/api/v1/auth/google/callback",
    GOOGLE_CLIENT_ID: "test-client-id",
  };

  function buildService(payload: Record<string, unknown>) {
    const config = {
      get: (key: string) =>
        key === "jwt" ? { secret: "test-jwt-secret-for-oauth-state" } : CONFIG_VALUES[key],
    } as unknown as ConfigService;
    const service = new GoogleOAuthService(
      {} as any, // prisma — verifyCallback never reaches the DB
      {} as unknown as JwtService,
      config,
      {} as any, // email
      { claimsFor: jest.fn().mockResolvedValue(null) } as any, // entitlements
    );
    // Nonce lookup succeeds so we get past the state check.
    (service as any).redis = {
      getdel: jest.fn().mockResolvedValue("1"),
      eval: jest.fn(),
      on: jest.fn(),
    };
    (service as any).oauth2Client = {
      getToken: jest.fn().mockResolvedValue({ tokens: { id_token: "id-token" } }),
      verifyIdToken: jest.fn().mockResolvedValue({ getPayload: () => payload }),
    };
    return service;
  }

  // B349: state is now signed (base64url(payload).base64url(mac)) — build it via the
  // service's own signState() rather than duplicating the HKDF/HMAC scheme here, and
  // point the nonce mock at the matching content hash so the binding check passes.
  function signedState(service: GoogleOAuthService, payload: Record<string, unknown>) {
    const payloadJson = JSON.stringify(payload);
    const hash = crypto.createHash("sha256").update(payloadJson).digest("hex");
    (service as any).redis.getdel = jest.fn().mockResolvedValue(hash);
    return (service as any).signState(payloadJson);
  }

  it("rejects when Google reports email_verified=false", async () => {
    const service = buildService({
      sub: "google-1",
      email: "victim@example.com",
      email_verified: false,
    });
    const state = signedState(service, { nonce: "n1", type: "tenant" });

    await expect(service.verifyCallback("code", state)).rejects.toThrow(
      new UnauthorizedException("google_email_not_verified"),
    );
  });

  it("rejects when email_verified is absent from the payload", async () => {
    const service = buildService({ sub: "google-1", email: "victim@example.com" });
    const state = signedState(service, { nonce: "n1", type: "tenant" });

    await expect(service.verifyCallback("code", state)).rejects.toThrow(
      new UnauthorizedException("google_email_not_verified"),
    );
  });

  it("returns the profile (lowercased email) when the email IS verified", async () => {
    const service = buildService({
      sub: "google-1",
      email: "Person@Example.com",
      email_verified: true,
      name: "Person",
    });
    const state = signedState(service, { nonce: "n1", type: "tenant" });

    const profile = await service.verifyCallback("code", state);
    expect(profile).toMatchObject({ googleId: "google-1", email: "person@example.com" });
  });
});

// ─── Legacy per-tenant path: TenantGoogleOAuthService.exchangeCode ─────────────

describe("TenantGoogleOAuthService.exchangeCode email_verified (F3-001)", () => {
  function buildService(payload: Record<string, unknown>, user?: Record<string, unknown>) {
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ id: "tenant-1", slug: "qa-t", deletedAt: null }),
      },
      tenantGoogleOAuth: {
        findFirst: jest.fn().mockResolvedValue({
          tenantId: "tenant-1",
          enabled: true,
          clientId: "cid",
          clientSecret: "enc-secret",
          callbackUrl: null,
        }),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue(user ?? null),
        update: jest.fn().mockImplementation((a: any) => Promise.resolve({ ...user, ...a.data })),
      },
    };
    (OAuth2Client as jest.Mock).mockImplementation(() => ({
      getToken: jest.fn().mockResolvedValue({ tokens: { id_token: "id-token" } }),
      setCredentials: jest.fn(),
      verifyIdToken: jest.fn().mockResolvedValue({ getPayload: () => payload }),
    }));
    const encryption = {
      decrypt: jest.fn().mockReturnValue("secret"),
    } as unknown as EncryptionService;
    const service = new TenantGoogleOAuthService(prisma as any, encryption);
    return { service, prisma };
  }

  it("rejects unverified emails BEFORE any user matching/linking runs", async () => {
    const { service, prisma } = buildService({
      sub: "google-1",
      email: "victim@example.com",
      email_verified: false,
    });

    await expect(service.exchangeCode("code", "qa-t")).rejects.toThrow(
      new ForbiddenException("google_email_not_verified"),
    );
    // The account-takeover vector was the email match — it must never run.
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("proceeds to user matching when the email IS verified", async () => {
    const activeUser = {
      id: "u1",
      username: "op",
      email: "person@example.com",
      role: "OPERATOR",
      status: "ACTIVE",
      tenantId: "tenant-1",
      googleId: "google-1",
    };
    const { service } = buildService(
      { sub: "google-1", email: "person@example.com", email_verified: true },
      activeUser,
    );

    const result = await service.exchangeCode("code", "qa-t");
    expect(result).toMatchObject({ id: "u1", role: "OPERATOR", tenantId: "tenant-1" });
  });
});
