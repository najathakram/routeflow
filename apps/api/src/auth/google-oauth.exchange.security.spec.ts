import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { GoogleOAuthService } from "./google-oauth.service";

/**
 * F8-001 regression: the OAuth token handoff must use a SINGLE-USE opaque code,
 * not tokens-in-URL. These tests pin the create/consume semantics that keep
 * access/refresh tokens out of redirect URLs (and server/CDN logs).
 */
describe("GoogleOAuthService exchange code (F8-001)", () => {
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
    const config = { get: () => undefined } as unknown as ConfigService;
    const jwt = {} as unknown as JwtService;
    const prisma = {} as any;
    const email = {} as any;
    const entitlements = { claimsFor: jest.fn().mockResolvedValue(null) } as any;
    const service = new GoogleOAuthService(prisma, jwt, config, email, entitlements);
    const mockRedis = makeMockRedis();
    (service as any).redis = mockRedis;
    return { service, mockRedis };
  }

  it("mints an opaque code and round-trips the bundle once", async () => {
    const { service } = buildService();
    const bundle = { accessToken: "acc", refreshToken: "ref", role: "OPERATOR", tenantSlug: "t1" };

    const code = await service.createExchangeCode(bundle);
    expect(typeof code).toBe("string");
    expect(code.length).toBeGreaterThan(20);

    const first = await service.consumeExchangeCode(code);
    expect(first).toEqual(bundle);
  });

  it("is single-use — a second exchange of the same code returns null", async () => {
    const { service } = buildService();
    const code = await service.createExchangeCode({ accessToken: "a", refreshToken: "r" });

    expect(await service.consumeExchangeCode(code)).not.toBeNull();
    expect(await service.consumeExchangeCode(code)).toBeNull();
  });

  it("returns null for an empty or unknown code", async () => {
    const { service } = buildService();
    expect(await service.consumeExchangeCode("")).toBeNull();
    expect(await service.consumeExchangeCode("does-not-exist")).toBeNull();
  });

  it("sets a short TTL so leaked codes expire quickly", async () => {
    const { service, mockRedis } = buildService();
    await service.createExchangeCode({ accessToken: "a", refreshToken: "r" });
    // set(key, value, "EX", ttlSeconds)
    const call = mockRedis.set.mock.calls[0];
    expect(call[2]).toBe("EX");
    expect(call[3]).toBeLessThanOrEqual(300);
  });
});
