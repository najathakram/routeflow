import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { ForbiddenException } from "@nestjs/common";
import * as crypto from "crypto";
import { GoogleOAuthService } from "./google-oauth.service";

/**
 * B349 regression: the OAuth `state` must be signed (HKDF-derived key + HMAC) so a
 * caller cannot rewrite its content (e.g. `linkUserId`) to attach their Google
 * identity to someone else's account, and the one-time nonce must be bound to the
 * exact payload it was minted for — not just checked for presence. Titled REG-B349
 * per the bug's test plan (`.claude/campaign/bugs/B349.md`).
 */
describe("GoogleOAuthService OAuth state signing (REG-B349)", () => {
  const CONFIG_VALUES: Record<string, string> = {
    GOOGLE_REDIRECT_URI_TENANT: "https://example.test/api/v1/auth/google/callback",
    GOOGLE_CLIENT_ID: "test-client-id",
  };

  function makeMockRedis() {
    const store = new Map<string, string>();
    return {
      set: jest.fn(async (key: string, val: string) => {
        store.set(key, val);
        return "OK";
      }),
      getdel: jest.fn(async (key: string) => {
        const v = store.has(key) ? store.get(key)! : null;
        store.delete(key);
        return v;
      }),
      eval: jest.fn(async () => null),
      on: jest.fn(),
      disconnect: jest.fn(),
      _store: store,
    };
  }

  function buildService() {
    const config = {
      get: (key: string) =>
        key === "jwt" ? { secret: "test-jwt-secret-for-oauth-state" } : CONFIG_VALUES[key],
    } as unknown as ConfigService;
    const service = new GoogleOAuthService(
      {} as any, // prisma — not reached by generateLinkUrl/verifyCallback
      {} as unknown as JwtService,
      config,
      {} as any, // email
      { claimsFor: jest.fn().mockResolvedValue(null) } as any, // entitlements
    );
    const mockRedis = makeMockRedis();
    (service as any).redis = mockRedis;
    // Return the raw state instead of a real Google URL — tests only need the state.
    (service as any).oauth2Client = {
      generateAuthUrl: jest.fn((opts: { state: string }) => opts.state),
      getToken: jest.fn().mockResolvedValue({ tokens: { id_token: "id-token" } }),
      verifyIdToken: jest.fn().mockResolvedValue({
        getPayload: () => ({
          sub: "google-victim",
          email: "victim@example.com",
          email_verified: true,
          name: "Victim",
        }),
      }),
    };
    return { service, mockRedis };
  }

  /**
   * Decode the payload segment of a state regardless of format: pre-fix it IS the
   * whole state (bare base64url JSON); post-fix it's the part before the first ".".
   * This lets the same tamper helper below prove RED on the untouched service and
   * GREEN on the fixed one, instead of hardcoding the new two-part shape.
   */
  function decodePayload(state: string): Record<string, unknown> {
    const dotIndex = state.indexOf(".");
    const payloadB64 = dotIndex === -1 ? state : state.slice(0, dotIndex);
    return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8"));
  }

  /**
   * Rewrite `linkUserId` in a minted state while carrying over whatever came after
   * the payload (the "." + mac, once signed — nothing, pre-fix). Format-agnostic on
   * purpose: this is the exact "rewrite linkUserId in the base64 state" attack from
   * B349's root cause, expressed independent of the signing fix.
   */
  function tamperLinkUserId(state: string, newLinkUserId: string): string {
    const dotIndex = state.indexOf(".");
    const suffix = dotIndex === -1 ? "" : state.slice(dotIndex); // includes leading "."
    const payload = decodePayload(state);
    const tampered = { ...payload, linkUserId: newLinkUserId };
    const tamperedB64 = Buffer.from(JSON.stringify(tampered)).toString("base64url");
    return `${tamperedB64}${suffix}`;
  }

  it("REG-B349: a state whose payload is modified after signing is rejected", async () => {
    const { service } = buildService();
    const state = await service.generateLinkUrl("tenant", "victim-user-id");

    const tamperedState = tamperLinkUserId(state, "attacker-user-id");

    await expect(service.verifyCallback("code", tamperedState)).rejects.toThrow(
      new ForbiddenException("state_invalid"),
    );
  });

  it("REG-B349: a valid MAC but a nonce stored for a different payload is rejected", async () => {
    const { service, mockRedis } = buildService();
    const state = await service.generateLinkUrl("tenant", "victim-user-id");
    const { nonce } = decodePayload(state) as { nonce: string };

    // Corrupt the binding: the nonce's stored content-hash now points at some OTHER
    // payload than the one this (untouched, validly-signed) state actually carries.
    const otherPayloadHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({ type: "tenant", nonce: "unrelated-nonce", linkUserId: "someone-else" }),
      )
      .digest("hex");
    mockRedis._store.set(`oauth:nonce:${nonce}`, otherPayloadHash);

    await expect(service.verifyCallback("code", state)).rejects.toThrow(
      new ForbiddenException("state_invalid"),
    );
  });

  it("REG-B349: a replayed (already-consumed) nonce is rejected", async () => {
    const { service } = buildService();
    const state = await service.generateLinkUrl("tenant", "victim-user-id");

    await service.verifyCallback("code", state); // consumes the nonce
    await expect(service.verifyCallback("code", state)).rejects.toThrow(
      new ForbiddenException("state_invalid"),
    );
  });

  it("REG-B349(e): a validly bound state with a corrupted MAC segment is rejected", async () => {
    // Proves the MAC check (not just the nonce-binding check) is load-bearing: the
    // other REG-B349 cases pass even if verifyStateSignature is deleted, because the
    // nonce binding rejects the tampered payload first. Here the nonce binding is
    // stored for the EXACT payload presented (as generateLinkUrl does on the happy
    // path) — only the MAC segment is corrupted — so a correct implementation must
    // reject on the signature check alone.
    const { service } = buildService();
    const state = await service.generateLinkUrl("tenant", "victim-user-id");
    const dotIndex = state.indexOf(".");
    const payloadB64 = state.slice(0, dotIndex);
    const macB64 = state.slice(dotIndex + 1);
    const flipped = macB64[0] === "A" ? "B" : "A";
    const corruptedState = `${payloadB64}.${flipped}${macB64.slice(1)}`;

    await expect(service.verifyCallback("code", corruptedState)).rejects.toThrow(
      new ForbiddenException("state_invalid"),
    );
  });

  it("REG-B349: the happy path still works, with the same generic error for every rejection", async () => {
    const { service } = buildService();

    const happyState = await service.generateLinkUrl("tenant", "victim-user-id");
    const profile = await service.verifyCallback("code", happyState);
    expect(profile).toMatchObject({ googleId: "google-victim", linkUserId: "victim-user-id" });

    // Tampered payload, mismatched nonce binding, and nonce replay all surface the
    // SAME generic error — no oracle that would let a caller distinguish them.
    const tamperState = tamperLinkUserId(
      await service.generateLinkUrl("tenant", "victim-user-id"),
      "attacker-user-id",
    );
    let tamperError: unknown;
    try {
      await service.verifyCallback("code", tamperState);
    } catch (e) {
      tamperError = e;
    }

    let replayError: unknown;
    try {
      await service.verifyCallback("code", happyState); // already consumed above
    } catch (e) {
      replayError = e;
    }

    expect(tamperError).toBeInstanceOf(ForbiddenException);
    expect(replayError).toBeInstanceOf(ForbiddenException);
    expect((tamperError as ForbiddenException).message).toBe("state_invalid");
    expect((replayError as ForbiddenException).message).toBe(
      (tamperError as ForbiddenException).message,
    );
  });
});

describe("GoogleOAuthService construction (B349 round 1 — fail closed without a secret)", () => {
  it("throws instead of deriving the state-signing key from an empty string when JWT_SECRET is missing", () => {
    const config = {
      get: (key: string) => (key === "jwt" ? { secret: "" } : undefined),
    } as unknown as ConfigService;
    expect(
      () =>
        new GoogleOAuthService(
          {} as any,
          {} as unknown as JwtService,
          config,
          {} as any,
          { claimsFor: jest.fn() } as any,
        ),
    ).toThrow("JWT_SECRET is required to sign OAuth state");
  });
});
