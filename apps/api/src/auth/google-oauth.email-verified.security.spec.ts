import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { UnauthorizedException } from "@nestjs/common";
import * as crypto from "crypto";
import { GoogleOAuthService } from "./google-oauth.service";

jest.mock("google-auth-library", () => ({
  OAuth2Client: jest.fn(),
}));

/**
 * F3-001 regression: Google account linking/matching must REJECT ID tokens
 * whose email is not verified by Google. Unverified emails can be claimed
 * with arbitrary addresses (workspace aliases, edu domains), enabling
 * account-takeover via a spoofed email match. Pinned on the one Google
 * sign-in path, GoogleOAuthService.verifyCallback (the legacy per-tenant
 * service was deleted; retired-sign-in-service.spec.ts keeps it out).
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
        key === "jwt"
          ? { secret: "test-jwt-secret-for-oauth-state-0123456789" }
          : CONFIG_VALUES[key],
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
