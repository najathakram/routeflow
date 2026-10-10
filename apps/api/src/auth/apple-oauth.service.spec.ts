import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import {
  ConflictException,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import * as crypto from "crypto";
import * as jose from "jose";
import { AppleOAuthService } from "./apple-oauth.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("bcrypt", () => ({
  hash: jest.fn().mockResolvedValue("$2b$10$placeholder"),
  compare: jest.fn(),
}));

const APPLE_ISSUER = "https://appleid.apple.com";
const BUNDLE_ID = "com.routeflow.app";
const KID = "test-kid-1";

const CONFIG_VALUES: Record<string, string> = {
  APPLE_BUNDLE_ID: BUNDLE_ID,
  APPLE_TEAM_ID: "TEAMID1234",
  APPLE_KEY_ID: "KEYID1234",
  APPLE_PRIVATE_KEY: "unused-in-most-tests",
};

const JWT_CONFIG = {
  secret: "test-secret",
  refreshSecret: "test-refresh-secret",
  expiresIn: "15m",
  refreshExpiresIn: "30d",
};

function sha256hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function makeMockRedis() {
  const store = new Map<string, string>();
  return {
    set: jest.fn(async (key: string, val: string, ...args: unknown[]) => {
      if (args.includes("NX") && store.has(key)) return null;
      store.set(key, val);
      return "OK";
    }),
    del: jest.fn(async (key: string) => {
      return store.delete(key) ? 1 : 0;
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

// No spec may reach Apple over the network: any fetch (token exchange / revoke) is a stub that
// records the call and fails, so the service's log-and-continue path runs and nothing leaves.
const fetchStub = jest.fn(async () => {
  throw new Error("network disabled in apple-oauth.service.spec");
});
beforeEach(() => {
  fetchStub.mockClear();
  (global as any).fetch = fetchStub;
});

async function makeKeyPair() {
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = KID;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { publicKey, privateKey, jwk };
}

interface BuildOpts {
  prismaOverrides?: Record<string, unknown>;
  configOverrides?: Record<string, string>;
}

async function buildService(opts: BuildOpts = {}) {
  const prisma = createMockPrisma();
  Object.assign(prisma, opts.prismaOverrides ?? {});

  const config = {
    get: (key: string) =>
      key === "jwt" ? JWT_CONFIG : { ...CONFIG_VALUES, ...(opts.configOverrides ?? {}) }[key],
  } as unknown as ConfigService;

  const emailService = { send: jest.fn().mockResolvedValue(undefined) };
  const entitlements = { claimsFor: jest.fn().mockResolvedValue(null) };
  const encryption = {
    encrypt: jest.fn((v: string) => `enc:${v}`),
    decrypt: jest.fn((v: string) => v.replace(/^enc:/, "")),
  };

  const service = new AppleOAuthService(
    prisma as any,
    {
      sign: jest.fn().mockReturnValue("signed-token"),
      decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    } as unknown as JwtService,
    config,
    emailService as any,
    entitlements as any,
    encryption as any,
  );

  const mockRedis = makeMockRedis();
  (service as any).redis = mockRedis;

  const { jwk, privateKey } = await makeKeyPair();
  const jwks = jose.createLocalJWKSet({ keys: [jwk] });
  (service as any).jwks = jwks;

  return { service, prisma, mockRedis, privateKey, emailService, encryption };
}

/** Signs a valid Apple identity token, with any claim overridable for negative tests. */
async function signIdentityToken(
  privateKey: jose.KeyLike,
  overrides: Partial<{
    sub: string;
    email: string | null;
    email_verified: boolean | string;
    nonce: string;
    aud: string;
    iss: string;
    expiresIn: string;
    kid: string;
  }> = {},
) {
  // `email: null` models Apple's later sign-ins, whose identity token OMITS email and email_verified.
  const claims: Record<string, unknown> =
    overrides.email === null
      ? { nonce: overrides.nonce }
      : {
          email: overrides.email ?? "buyer@example.com",
          email_verified: overrides.email_verified ?? true,
          nonce: overrides.nonce,
        };
  const expiresAt =
    overrides.expiresIn === "-1h"
      ? Math.floor(Date.now() / 1000) - 3600
      : (overrides.expiresIn ?? "5m");
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: overrides.kid ?? KID })
    .setIssuer(overrides.iss ?? APPLE_ISSUER)
    .setAudience(overrides.aud ?? BUNDLE_ID)
    .setSubject(overrides.sub ?? "apple-sub-1")
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(privateKey);
}

async function mintAndSign(
  service: AppleOAuthService,
  privateKey: jose.KeyLike,
  opts: {
    tenantSlug?: string;
    context: "staff" | "buyer-standalone";
    tokenOverrides?: Parameters<typeof signIdentityToken>[1];
  },
) {
  const { nonce } = await service.mintNonce(opts.tenantSlug, opts.context);
  const identityToken = await signIdentityToken(privateKey, {
    nonce: sha256hex(nonce),
    ...opts.tokenOverrides,
  });
  return { nonce, identityToken };
}

describe("AppleOAuthService — isConfigured() with every APPLE_* var unset or blank (boot safety)", () => {
  const ALL = ["APPLE_BUNDLE_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"] as const;

  it("is false when all four are unset", async () => {
    const { service } = await buildService({
      configOverrides: Object.fromEntries(ALL.map((k) => [k, undefined])) as unknown as Record<
        string,
        string
      >,
    });
    expect(service.isConfigured()).toBe(false);
    expect(service.isNotificationConfigured()).toBe(false);
  });

  it("is false when they are empty or whitespace-only (a blank .env line), for every key", async () => {
    for (const k of ALL) {
      for (const blank of ["", "   ", "\n"]) {
        const { service } = await buildService({ configOverrides: { [k]: blank } });
        expect(service.isConfigured()).toBe(false);
      }
    }
  });
});

describe("AppleOAuthService — token verification (SA-418 §1)", () => {
  it("rejects a bad signature", async () => {
    const { service, privateKey } = await buildService();
    const { nonce } = await service.mintNonce(undefined, "buyer-standalone");
    // Sign with a DIFFERENT keypair — same kid, different key, so signature check fails.
    const { privateKey: otherKey } = await makeKeyPair();
    const identityToken = await signIdentityToken(otherKey, { nonce: sha256hex(nonce) });

    await expect(
      service.signIn({
        identityToken,
        authorizationCode: "code",
        nonce,
        context: "buyer-standalone",
      }),
    ).rejects.toThrow(new UnauthorizedException("apple_token_invalid"));
  });

  it.each([
    ["another company code", { tenantSlug: "other-co", context: "staff" as const }],
    ["the buyer context", { tenantSlug: "acme", context: "buyer-standalone" as const }],
  ])("rejects a nonce minted for {acme, staff} but used with %s (no write)", async (_n, used) => {
    const { service, privateKey, prisma } = await buildService();
    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      tenantSlug: "acme",
      context: "staff",
    });
    await expect(
      service.signIn({ identityToken, authorizationCode: "code", nonce, ...used }),
    ).rejects.toThrow(new UnauthorizedException("apple_token_invalid"));
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.buyerAccount.create).not.toHaveBeenCalled();
  });

  it("rejects the wrong audience", async () => {
    const { service, privateKey } = await buildService();
    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      context: "buyer-standalone",
      tokenOverrides: { aud: "com.someone.else" },
    });

    await expect(
      service.signIn({
        identityToken,
        authorizationCode: "code",
        nonce,
        context: "buyer-standalone",
      }),
    ).rejects.toThrow(new UnauthorizedException("apple_token_invalid"));
  });

  it("rejects an expired token", async () => {
    const { service, privateKey } = await buildService();
    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      context: "buyer-standalone",
      tokenOverrides: { expiresIn: "-1h" },
    });

    await expect(
      service.signIn({
        identityToken,
        authorizationCode: "code",
        nonce,
        context: "buyer-standalone",
      }),
    ).rejects.toThrow(new UnauthorizedException("apple_token_invalid"));
  });

  it("rejects a nonce-claim mismatch", async () => {
    const { service, privateKey } = await buildService();
    const { nonce } = await service.mintNonce(undefined, "buyer-standalone");
    const identityToken = await signIdentityToken(privateKey, { nonce: "wrong-nonce-hash" });

    await expect(
      service.signIn({
        identityToken,
        authorizationCode: "code",
        nonce,
        context: "buyer-standalone",
      }),
    ).rejects.toThrow(new UnauthorizedException("apple_token_invalid"));
  });

  it("rejects a replayed (already-consumed) nonce", async () => {
    const { service, privateKey, prisma } = await buildService();
    prisma.buyerAccount.findFirst.mockResolvedValue(null);
    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      context: "buyer-standalone",
    });

    await service.signIn({
      identityToken,
      authorizationCode: "code",
      nonce,
      context: "buyer-standalone",
    });
    await expect(
      service.signIn({
        identityToken,
        authorizationCode: "code",
        nonce,
        context: "buyer-standalone",
      }),
    ).rejects.toThrow(new UnauthorizedException("apple_token_invalid"));
  });

  it("rejects email_verified: false", async () => {
    const { service, privateKey } = await buildService();
    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      context: "buyer-standalone",
      tokenOverrides: { email_verified: false },
    });

    await expect(
      service.signIn({
        identityToken,
        authorizationCode: "code",
        nonce,
        context: "buyer-standalone",
      }),
    ).rejects.toThrow(new UnauthorizedException("apple_token_invalid"));
  });

  it('accepts email_verified as the string "true"', async () => {
    const { service, privateKey, prisma } = await buildService();
    prisma.buyerAccount.findFirst.mockResolvedValue(null);
    prisma.buyerAccount.create.mockResolvedValue({
      id: "buyer-1",
      email: "buyer@example.com",
      name: "buyer@example.com",
      passwordSet: false,
    });
    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      context: "buyer-standalone",
      tokenOverrides: { email_verified: "true" },
    });

    const result = await service.signIn({
      identityToken,
      authorizationCode: "code",
      nonce,
      context: "buyer-standalone",
    });
    expect(result.kind).toBe("buyer");
  });

  it("B964-1: a formula-led Apple fullName never blocks the sign-in: the buyer is created with the email local-part as the name", async () => {
    const { service, privateKey, prisma } = await buildService();
    prisma.buyerAccount.findFirst.mockResolvedValue(null);
    prisma.buyerAccount.create.mockImplementation(async ({ data }: any) => ({
      id: "buyer-1",
      ...data,
    }));
    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      context: "buyer-standalone",
    });
    const result = await service.signIn({
      identityToken,
      authorizationCode: "code",
      nonce,
      context: "buyer-standalone",
      fullName: "=HYPERLINK(1)",
    } as any);
    expect(result.kind).toBe("buyer");
    expect(prisma.buyerAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "buyer" }), // "buyer@example.com" local part
    });
  });

  it("no prisma write happens on a rejected token", async () => {
    const { service, privateKey, prisma } = await buildService();
    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      context: "buyer-standalone",
      tokenOverrides: { email_verified: false },
    });

    await expect(
      service.signIn({
        identityToken,
        authorizationCode: "code",
        nonce,
        context: "buyer-standalone",
      }),
    ).rejects.toThrow();
    expect(prisma.buyerAccount.create).not.toHaveBeenCalled();
    expect(prisma.buyerAccount.update).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("refetches the JWKS once on an unknown kid", async () => {
    const { service, privateKey, jwk1 } = await (async () => {
      const built = await buildService();
      return { ...built, jwk1: null };
    })();

    // Simulate Apple rotating in a second signing key: sign with a NEW key/kid that
    // isn't in the locally-cached JWKS, and swap in a getKey function that only
    // "discovers" the new key after being called once (mirrors jose's own
    // createRemoteJWKSet single-refetch-on-unknown-kid behaviour).
    const { publicKey: newPublicKey, privateKey: newPrivateKey } =
      await jose.generateKeyPair("RS256");
    const newJwk = await jose.exportJWK(newPublicKey);
    newJwk.kid = "rotated-kid";
    newJwk.alg = "RS256";
    newJwk.use = "sig";

    let calls = 0;
    const refetchingGetKey = async (protectedHeader: { kid?: string }) => {
      calls += 1;
      if (protectedHeader.kid === "rotated-kid") {
        const { importJWK } = jose;
        return importJWK(newJwk, "RS256");
      }
      throw new Error("no matching key found");
    };
    (service as any).jwks = refetchingGetKey;

    const { nonce } = await service.mintNonce(undefined, "buyer-standalone");
    const identityToken = await signIdentityToken(newPrivateKey, {
      nonce: sha256hex(nonce),
      kid: "rotated-kid",
    });

    const prisma = (service as any).prisma;
    prisma.buyerAccount.findFirst.mockResolvedValue(null);
    prisma.buyerAccount.create.mockResolvedValue({
      id: "buyer-1",
      email: "buyer@example.com",
      name: "buyer@example.com",
      passwordSet: false,
    });

    const result = await service.signIn({
      identityToken,
      authorizationCode: "code",
      nonce,
      context: "buyer-standalone",
    });
    expect(result.kind).toBe("buyer");
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});

describe("AppleOAuthService — staff flow (SA-418 §3)", () => {
  const TENANT = { id: "tenant-1", slug: "acme", status: "ACTIVE" };
  const STAFF_USER = {
    id: "user-1",
    tenantId: "tenant-1",
    username: "op1",
    role: "OPERATOR",
    status: "ACTIVE",
    email: "op@acme.example",
    appleId: null as string | null,
    password: "hash",
    forcePasswordChange: false,
  };

  it("another tenant's user with the same email ⇒ apple_no_match", async () => {
    const { service, prisma, privateKey } = await buildService();
    prisma.tenant.findFirst.mockResolvedValue(TENANT);
    prisma.user.findFirst.mockResolvedValue(null); // scoped to tenant-1 — no match there

    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      tenantSlug: "acme",
      context: "staff",
      tokenOverrides: { email: "op@acme.example" },
    });

    await expect(
      service.signIn({
        identityToken,
        authorizationCode: "code",
        nonce,
        tenantSlug: "acme",
        context: "staff",
      }),
    ).rejects.toThrow(new ForbiddenException("apple_no_match"));
  });

  it("a SUSPENDED tenant ⇒ tenant_suspended", async () => {
    const { service, prisma, privateKey } = await buildService();
    prisma.tenant.findFirst.mockResolvedValue({ ...TENANT, status: "SUSPENDED" });

    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      tenantSlug: "acme",
      context: "staff",
    });

    await expect(
      service.signIn({
        identityToken,
        authorizationCode: "code",
        nonce,
        tenantSlug: "acme",
        context: "staff",
      }),
    ).rejects.toThrow(new ForbiddenException("tenant_suspended"));
  });

  it("an inactive user ⇒ unauthorized", async () => {
    const { service, prisma, privateKey } = await buildService();
    prisma.tenant.findFirst.mockResolvedValue(TENANT);
    prisma.user.findFirst.mockResolvedValue({ ...STAFF_USER, status: "SUSPENDED" });

    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      tenantSlug: "acme",
      context: "staff",
      tokenOverrides: { email: STAFF_USER.email },
    });

    await expect(
      service.signIn({
        identityToken,
        authorizationCode: "code",
        nonce,
        tenantSlug: "acme",
        context: "staff",
      }),
    ).rejects.toThrow(new ForbiddenException("unauthorized"));
  });

  it("a relay email matching no provisioned user ⇒ 403 apple_no_match, no create", async () => {
    const { service, prisma, privateKey } = await buildService();
    prisma.tenant.findFirst.mockResolvedValue(TENANT);
    prisma.user.findFirst.mockResolvedValue(null);

    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      tenantSlug: "acme",
      context: "staff",
      tokenOverrides: { email: "abc123@privaterelay.appleid.com" },
    });

    await expect(
      service.signIn({
        identityToken,
        authorizationCode: "code",
        nonce,
        tenantSlug: "acme",
        context: "staff",
      }),
    ).rejects.toThrow(new ForbiddenException("apple_no_match"));
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("first link writes appleId + forcePasswordChange:false", async () => {
    const { service, prisma, privateKey } = await buildService();
    prisma.tenant.findFirst.mockResolvedValue(TENANT);
    prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...STAFF_USER });
    prisma.user.updateMany.mockResolvedValue({ count: 1 });

    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      tenantSlug: "acme",
      context: "staff",
      tokenOverrides: { email: STAFF_USER.email, sub: "apple-sub-1" },
    });

    const result = await service.signIn({
      identityToken,
      authorizationCode: "code",
      nonce,
      tenantSlug: "acme",
      context: "staff",
    });

    expect(result.kind).toBe("staff");
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: STAFF_USER.id, tenantId: TENANT.id, appleId: null },
      data: { appleId: "apple-sub-1", forcePasswordChange: false },
    });
  });

  it("staff sign-in with Apple records the sign-in time", async () => {
    const { service, prisma, privateKey } = await buildService();
    prisma.tenant.findFirst.mockResolvedValue(TENANT);
    prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...STAFF_USER });
    prisma.user.updateMany.mockResolvedValue({ count: 1 });

    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      tenantSlug: "acme",
      context: "staff",
      tokenOverrides: { email: STAFF_USER.email, sub: "apple-sub-1" },
    });
    await service.signIn({
      identityToken,
      authorizationCode: "code",
      nonce,
      tenantSlug: "acme",
      context: "staff",
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: STAFF_USER.id },
      data: { lastLoginAt: expect.any(Date) },
    });
  });
});

describe("AppleOAuthService — buyer flow (SA-418 §4)", () => {
  it("SA-418a: buyer-standalone never looks up staff; an email that is also staff somewhere signs in as a buyer", async () => {
    const { service, prisma, privateKey } = await buildService();
    prisma.user.findFirst.mockResolvedValue({ id: "user-1", role: "OPERATOR", deletedAt: null });
    prisma.buyerAccount.findFirst.mockResolvedValue(null);
    prisma.buyerAccount.create.mockResolvedValue({
      id: "buyer-new",
      email: "staffer@example.com",
      status: "ACTIVE",
    });

    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      context: "buyer-standalone",
      tokenOverrides: { email: "staffer@example.com" },
    });

    await expect(
      service.signIn({
        identityToken,
        authorizationCode: "code",
        nonce,
        context: "buyer-standalone",
      }),
    ).resolves.toMatchObject({ kind: "buyer" });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.buyerAccount.create).toHaveBeenCalled();
  });

  it("a relay email matching nothing creates a new placeholder-password account", async () => {
    const { service, prisma, privateKey } = await buildService();
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.buyerAccount.findFirst.mockResolvedValue(null);
    prisma.buyerAccount.create.mockResolvedValue({
      id: "buyer-new",
      email: "abc123@privaterelay.appleid.com",
      name: "abc123@privaterelay.appleid.com",
      passwordSet: false,
    });

    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      context: "buyer-standalone",
      tokenOverrides: { email: "abc123@privaterelay.appleid.com", sub: "apple-sub-relay" },
    });

    const result = await service.signIn({
      identityToken,
      authorizationCode: "code",
      nonce,
      context: "buyer-standalone",
    });

    expect(result.kind).toBe("buyer");
    expect(prisma.buyerAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: "abc123@privaterelay.appleid.com",
        appleId: "apple-sub-relay",
        passwordSet: false,
        status: "ACTIVE",
        emailVerified: true,
      }),
    });
  });

  it("neutralizes a squatted password and revokes sessions on first Apple link", async () => {
    const { service, prisma, privateKey } = await buildService();
    prisma.user.findFirst.mockResolvedValue(null);
    const squatted = {
      id: "buyer-squat",
      email: "victim@example.com",
      passwordSet: true,
      emailVerified: false,
      appleId: null,
      status: "ACTIVE",
      name: "Victim",
    };
    prisma.buyerAccount.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(squatted);
    prisma.buyerAccount.updateMany.mockResolvedValue({ count: 1 });

    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      context: "buyer-standalone",
      tokenOverrides: { email: "victim@example.com", sub: "apple-sub-victim" },
    });

    await service.signIn({
      identityToken,
      authorizationCode: "code",
      nonce,
      context: "buyer-standalone",
    });

    expect(prisma.buyerAccount.updateMany).toHaveBeenCalledWith({
      where: { id: "buyer-squat", appleId: null },
      data: expect.objectContaining({
        appleId: "apple-sub-victim",
        emailVerified: true,
        passwordSet: false,
      }),
    });
    expect(prisma.buyerRefreshToken.deleteMany).toHaveBeenCalledWith({
      where: { buyerAccountId: "buyer-squat" },
    });
  });
});

describe("AppleOAuthService — linking (SA-418 §2)", () => {
  it("a same-tenant sub already claimed by someone else ⇒ apple_already_linked", async () => {
    const { service, prisma, privateKey } = await buildService();
    prisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      tenantId: "tenant-1",
      deletedAt: null,
      appleId: null,
      email: "me@acme.example",
    });
    prisma.user.findFirst.mockResolvedValue({ id: "someone-else" }); // existingByAppleId

    const { nonce } = await service.mintNonce(undefined, "staff");
    const identityToken = await signIdentityToken(privateKey, { nonce: sha256hex(nonce) });

    await expect(service.linkAppleAccount("user-1", identityToken, nonce)).rejects.toThrow(
      new ForbiddenException("apple_already_linked"),
    );
  });

  it("already linked ⇒ 403", async () => {
    const { service, prisma, privateKey } = await buildService();
    prisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      tenantId: "tenant-1",
      deletedAt: null,
      appleId: "already-set",
      email: "me@acme.example",
    });
    prisma.user.findFirst.mockResolvedValue(null);

    const { nonce } = await service.mintNonce(undefined, "staff");
    const identityToken = await signIdentityToken(privateKey, { nonce: sha256hex(nonce) });

    await expect(service.linkAppleAccount("user-1", identityToken, nonce)).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe("AppleOAuthService — SA-598 P1 sub-first resolve + CAS link (#2495 for Apple)", () => {
  const TENANT = { id: "tenant-1", slug: "acme", status: "ACTIVE" };
  const STAFF = {
    id: "user-1",
    tenantId: "tenant-1",
    username: "op1",
    role: "OPERATOR",
    status: "ACTIVE",
    email: "op@acme.example",
    appleId: null as string | null,
    forcePasswordChange: false,
  };
  const BUYER = {
    id: "buyer-1",
    email: "b@example.com",
    name: "B",
    status: "ACTIVE",
    passwordSet: true,
    emailVerified: true,
    appleId: null as string | null,
  };

  async function staffSignIn(
    env: Awaited<ReturnType<typeof buildService>>,
    tokenOverrides: Parameters<typeof signIdentityToken>[1] = {},
  ) {
    const { nonce, identityToken } = await mintAndSign(env.service, env.privateKey, {
      tenantSlug: "acme",
      context: "staff",
      tokenOverrides: { email: STAFF.email, sub: "apple-sub-1", ...tokenOverrides },
    });
    return env.service.signIn({
      identityToken,
      authorizationCode: "code",
      nonce,
      tenantSlug: "acme",
      context: "staff",
    });
  }

  async function buyerSignIn(
    env: Awaited<ReturnType<typeof buildService>>,
    tokenOverrides: Parameters<typeof signIdentityToken>[1] = {},
  ) {
    const { nonce, identityToken } = await mintAndSign(env.service, env.privateKey, {
      context: "buyer-standalone",
      tokenOverrides: { email: BUYER.email, sub: "apple-sub-1", ...tokenOverrides },
    });
    return env.service.signIn({
      identityToken,
      authorizationCode: "code",
      nonce,
      context: "buyer-standalone",
    });
  }

  describe("staff", () => {
    it("resolves by appleId FIRST: an email-sharing row is never queried or written", async () => {
      const env = await buildService();
      env.prisma.tenant.findFirst.mockResolvedValue(TENANT);
      env.prisma.user.findFirst.mockResolvedValueOnce({ ...STAFF, appleId: "apple-sub-1" });

      await expect(staffSignIn(env)).resolves.toMatchObject({ kind: "staff" });

      expect(env.prisma.user.findFirst).toHaveBeenCalledTimes(1);
      expect(env.prisma.user.findFirst.mock.calls[0][0].where).toMatchObject({
        tenantId: "tenant-1",
        appleId: "apple-sub-1",
      });
      expect(env.prisma.user.findFirst.mock.calls[0][0].where.OR).toBeUndefined();
      expect(env.prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it("a token WITHOUT an email claim signs in when the appleId is already bound (Apple omits email after the first sign-in)", async () => {
      const env = await buildService();
      env.prisma.tenant.findFirst.mockResolvedValue(TENANT);
      env.prisma.user.findFirst.mockResolvedValueOnce({ ...STAFF, appleId: "apple-sub-1" });

      await expect(staffSignIn(env, { email: null })).resolves.toMatchObject({ kind: "staff" });

      expect(env.prisma.user.findFirst).toHaveBeenCalledTimes(1);
      expect(env.prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it("no email claim AND no bound appleId: refused 403 before any email lookup or write", async () => {
      const env = await buildService();
      env.prisma.tenant.findFirst.mockResolvedValue(TENANT);
      env.prisma.user.findFirst.mockResolvedValue(null);

      await expect(staffSignIn(env, { email: null })).rejects.toThrow(
        new ForbiddenException("unauthorized"),
      );
      // sub lookup only; a null email must never widen the where into an unscoped match
      expect(env.prisma.user.findFirst).toHaveBeenCalledTimes(1);
      expect(env.prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it("the email fallback is ordered createdAt,id and stays tenant-scoped", async () => {
      const env = await buildService();
      env.prisma.tenant.findFirst.mockResolvedValue(TENANT);
      env.prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...STAFF });
      env.prisma.user.updateMany.mockResolvedValue({ count: 1 });

      await staffSignIn(env);

      expect(env.prisma.user.findFirst.mock.calls[1][0]).toMatchObject({
        where: { tenantId: "tenant-1", deletedAt: null, email: STAFF.email },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
    });

    it("an email row bound to a DIFFERENT appleId is a 409 apple_account_mismatch with no write", async () => {
      const env = await buildService();
      env.prisma.tenant.findFirst.mockResolvedValue(TENANT);
      env.prisma.user.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...STAFF, appleId: "someone-else" });

      const err = await staffSignIn(env).catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getStatus()).toBe(409);
      expect(err.message).toBe("apple_account_mismatch");
      // P4: the Apple routes return JSON (no redirect allow-list like Google's mapErrorCode), so the
      // code a client maps is exactly this response body message.
      expect(err.getResponse()).toMatchObject({
        statusCode: 409,
        message: "apple_account_mismatch",
      });
      expect(env.prisma.user.updateMany).not.toHaveBeenCalled();
      expect(env.prisma.user.update).not.toHaveBeenCalled();
    });

    it("a CAS lost race to a DIFFERENT sub is a 409; the token pair is never issued", async () => {
      const env = await buildService();
      env.prisma.tenant.findFirst.mockResolvedValue(TENANT);
      env.prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...STAFF });
      env.prisma.user.updateMany.mockResolvedValue({ count: 0 });
      env.prisma.user.findUnique.mockResolvedValue({ ...STAFF, appleId: "attacker" });

      await expect(staffSignIn(env)).rejects.toThrow(
        new ConflictException("apple_account_mismatch"),
      );
    });

    it("a CAS lost race to the SAME sub proceeds", async () => {
      const env = await buildService();
      env.prisma.tenant.findFirst.mockResolvedValue(TENANT);
      env.prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...STAFF });
      env.prisma.user.updateMany.mockResolvedValue({ count: 0 });
      env.prisma.user.findUnique.mockResolvedValue({ ...STAFF, appleId: "apple-sub-1" });

      await expect(staffSignIn(env)).resolves.toMatchObject({ kind: "staff" });
    });

    it("a falsy sub or email is refused with ZERO prisma calls", async () => {
      for (const over of [{ sub: "" }, { email: "" }]) {
        const env = await buildService();
        env.prisma.tenant.findFirst.mockResolvedValue(TENANT);
        // verifyIdentityToken may itself refuse; either way no prisma call may happen.
        await expect(staffSignIn(env, over)).rejects.toThrow();
        expect(env.prisma.tenant.findFirst).not.toHaveBeenCalled();
        expect(env.prisma.user.findFirst).not.toHaveBeenCalled();
        expect(env.prisma.user.updateMany).not.toHaveBeenCalled();
      }
    });

    it.each([
      ["SUSPENDED", { status: "SUSPENDED" }],
      ["INACTIVE", { status: "INACTIVE" }],
      ["locked", { lockedUntil: new Date(Date.now() + 86_400_000) }],
      ["deleted", { deletedAt: new Date(Date.now() - 1000) }],
    ])(
      "a %s staff account cannot sign in via Apple (unauthorized, no link write)",
      async (_n, over) => {
        const env = await buildService();
        env.prisma.tenant.findFirst.mockResolvedValue(TENANT);
        env.prisma.user.findFirst
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ ...STAFF, ...over });

        await expect(staffSignIn(env)).rejects.toThrow(new ForbiddenException("unauthorized"));
        expect(env.prisma.user.updateMany).not.toHaveBeenCalled();
      },
    );
  });

  describe("buyer", () => {
    it("a token WITHOUT an email claim signs in a buyer whose appleId is already bound", async () => {
      const env = await buildService();
      env.prisma.buyerAccount.findFirst.mockResolvedValueOnce({ ...BUYER, appleId: "apple-sub-1" });
      env.prisma.customerLink.count.mockResolvedValue(0);

      await expect(buyerSignIn(env, { email: null })).resolves.toMatchObject({ kind: "buyer" });

      expect(env.prisma.buyerAccount.findFirst).toHaveBeenCalledTimes(1);
      expect(env.prisma.buyerAccount.create).not.toHaveBeenCalled();
      // No email attested, so no emailVerified upgrade and no "linked" mail is sent.
      expect(env.prisma.buyerAccount.update).not.toHaveBeenCalled();
      expect(env.emailService.send).not.toHaveBeenCalled();
    });

    it("no email claim AND no bound appleId: never auto-creates an account, 403", async () => {
      const env = await buildService();
      env.prisma.buyerAccount.findFirst.mockResolvedValue(null);

      await expect(buyerSignIn(env, { email: null })).rejects.toThrow(
        new ForbiddenException("unauthorized"),
      );
      expect(env.prisma.buyerAccount.create).not.toHaveBeenCalled();
    });

    it("an email claim that is present but not verified is still refused (unchanged)", async () => {
      const env = await buildService();
      await expect(buyerSignIn(env, { email_verified: false })).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("resolves by appleId FIRST: the email is never queried when the sub matches", async () => {
      const env = await buildService();
      env.prisma.buyerAccount.findFirst.mockResolvedValueOnce({ ...BUYER, appleId: "apple-sub-1" });

      await expect(buyerSignIn(env)).resolves.toMatchObject({ kind: "buyer" });

      expect(env.prisma.buyerAccount.findFirst).toHaveBeenCalledTimes(1);
      expect(env.prisma.buyerAccount.findFirst.mock.calls[0][0].where).toMatchObject({
        appleId: "apple-sub-1",
      });
      expect(env.prisma.buyerAccount.findFirst.mock.calls[0][0].where.OR).toBeUndefined();
      expect(env.prisma.buyerAccount.updateMany).not.toHaveBeenCalled();
    });

    it("the email fallback is ordered createdAt,id", async () => {
      const env = await buildService();
      env.prisma.buyerAccount.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...BUYER });
      env.prisma.buyerAccount.updateMany.mockResolvedValue({ count: 1 });

      await buyerSignIn(env);

      expect(env.prisma.buyerAccount.findFirst.mock.calls[1][0]).toMatchObject({
        where: { deletedAt: null, email: BUYER.email },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
    });

    it("an email row bound to a DIFFERENT appleId is a 409 with no write, no create, no revoke", async () => {
      const env = await buildService();
      env.prisma.buyerAccount.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...BUYER, appleId: "someone-else" });

      const err = await buyerSignIn(env).catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe("apple_account_mismatch");
      expect(env.prisma.buyerAccount.updateMany).not.toHaveBeenCalled();
      expect(env.prisma.buyerAccount.update).not.toHaveBeenCalled();
      expect(env.prisma.buyerAccount.create).not.toHaveBeenCalled();
      expect(env.prisma.buyerRefreshToken.deleteMany).not.toHaveBeenCalled();
    });

    const squatted = { ...BUYER, passwordSet: true, emailVerified: false };

    it("CAS lost race to a DIFFERENT sub is a 409: no revoke, no email", async () => {
      const env = await buildService();
      env.prisma.buyerAccount.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...squatted });
      env.prisma.buyerAccount.updateMany.mockResolvedValue({ count: 0 });
      env.prisma.buyerAccount.findUnique.mockResolvedValue({ ...squatted, appleId: "attacker" });

      await expect(buyerSignIn(env)).rejects.toThrow(
        new ConflictException("apple_account_mismatch"),
      );
      expect(env.prisma.buyerRefreshToken.deleteMany).not.toHaveBeenCalled();
      expect(env.emailService.send).not.toHaveBeenCalled();
    });

    it("CAS lost race to the SAME sub proceeds WITHOUT revoking or emailing", async () => {
      const env = await buildService();
      env.prisma.buyerAccount.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...squatted });
      env.prisma.buyerAccount.updateMany.mockResolvedValue({ count: 0 });
      env.prisma.buyerAccount.findUnique.mockResolvedValue({ ...squatted, appleId: "apple-sub-1" });

      await expect(buyerSignIn(env)).resolves.toMatchObject({ kind: "buyer" });
      expect(env.prisma.buyerRefreshToken.deleteMany).not.toHaveBeenCalled();
      expect(env.emailService.send).not.toHaveBeenCalled();
    });

    it("when THIS request links, it emails (and revokes for a squatted password)", async () => {
      const env = await buildService();
      env.prisma.buyerAccount.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...squatted });
      env.prisma.buyerAccount.updateMany.mockResolvedValue({ count: 1 });

      await buyerSignIn(env);

      expect(env.prisma.buyerRefreshToken.deleteMany).toHaveBeenCalledWith({
        where: { buyerAccountId: "buyer-1" },
      });
      expect(env.emailService.send).toHaveBeenCalledTimes(1);
    });

    it("a falsy sub or email is refused with ZERO prisma calls", async () => {
      for (const over of [{ sub: "" }, { email: "" }]) {
        const env = await buildService();
        await expect(buyerSignIn(env, over)).rejects.toThrow();
        expect(env.prisma.buyerAccount.findFirst).not.toHaveBeenCalled();
        expect(env.prisma.buyerAccount.updateMany).not.toHaveBeenCalled();
        expect(env.prisma.buyerAccount.create).not.toHaveBeenCalled();
      }
    });

    it.each([
      ["SUSPENDED", { status: "SUSPENDED" }],
      ["locked", { lockedUntil: new Date(Date.now() + 86_400_000) }],
      ["deleted", { deletedAt: new Date(Date.now() - 1000) }],
    ])("a %s buyer cannot sign in via Apple (unauthorized, no link write)", async (_n, over) => {
      const env = await buildService();
      env.prisma.buyerAccount.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...BUYER, ...over });

      await expect(buyerSignIn(env)).rejects.toThrow(new ForbiddenException("unauthorized"));
      expect(env.prisma.buyerAccount.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("linkAppleAccount", () => {
    async function link(env: Awaited<ReturnType<typeof buildService>>) {
      const { nonce } = await env.service.mintNonce(undefined, "staff");
      const identityToken = await signIdentityToken(env.privateKey, {
        nonce: sha256hex(nonce),
        sub: "apple-sub-1",
        email: "me@acme.example",
      });
      return env.service.linkAppleAccount("user-1", identityToken, nonce);
    }
    const ME = {
      id: "user-1",
      tenantId: "tenant-1",
      deletedAt: null,
      appleId: null,
      email: "me@acme.example",
    };

    it("links by CAS scoped to id + tenantId + appleId:null, then emails", async () => {
      const env = await buildService();
      env.prisma.user.findUnique.mockResolvedValue({ ...ME });
      env.prisma.user.findFirst.mockResolvedValue(null);
      env.prisma.user.updateMany.mockResolvedValue({ count: 1 });

      await link(env);

      expect(env.prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: "user-1", tenantId: "tenant-1", appleId: null },
        data: { appleId: "apple-sub-1", forcePasswordChange: false },
      });
      expect(env.emailService.send).toHaveBeenCalledTimes(1);
    });

    it("a lost CAS to a DIFFERENT sub is a 409 and sends no email", async () => {
      const env = await buildService();
      env.prisma.user.findUnique
        .mockResolvedValueOnce({ ...ME })
        .mockResolvedValueOnce({ ...ME, appleId: "attacker" });
      env.prisma.user.findFirst.mockResolvedValue(null);
      env.prisma.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(link(env)).rejects.toThrow(new ConflictException("apple_account_mismatch"));
      expect(env.emailService.send).not.toHaveBeenCalled();
    });

    it("a lost CAS to the SAME sub succeeds without a second email", async () => {
      const env = await buildService();
      env.prisma.user.findUnique
        .mockResolvedValueOnce({ ...ME })
        .mockResolvedValueOnce({ ...ME, appleId: "apple-sub-1" });
      env.prisma.user.findFirst.mockResolvedValue(null);
      env.prisma.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(link(env)).resolves.toBeUndefined();
      expect(env.emailService.send).not.toHaveBeenCalled();
    });

    it("a falsy sub is refused with ZERO prisma calls", async () => {
      const env = await buildService();
      const { nonce } = await env.service.mintNonce(undefined, "staff");
      const identityToken = await signIdentityToken(env.privateKey, {
        nonce: sha256hex(nonce),
        sub: "",
      });
      await expect(env.service.linkAppleAccount("user-1", identityToken, nonce)).rejects.toThrow();
      expect(env.prisma.user.findUnique).not.toHaveBeenCalled();
      expect(env.prisma.user.findFirst).not.toHaveBeenCalled();
      expect(env.prisma.user.updateMany).not.toHaveBeenCalled();
    });
  });
});

describe("AppleOAuthService — notifications (SA-418 §5)", () => {
  it("rejects a token with the wrong aud", async () => {
    const { service, privateKey } = await buildService();
    const signedPayload = await new jose.SignJWT({
      events: JSON.stringify({ type: "consent-revoked", sub: "s" }),
    })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(APPLE_ISSUER)
      .setAudience("wrong.bundle.id")
      .setIssuedAt()
      .setJti(crypto.randomUUID())
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(service.handleNotification(signedPayload)).rejects.toThrow(UnauthorizedException);
  });

  it("consent-revoked clears appleId + the refresh token + our refresh tokens, never deletes the account", async () => {
    const { service, prisma, privateKey } = await buildService();
    prisma.buyerAccount.findFirst.mockResolvedValue({ id: "buyer-1", appleId: "apple-sub-1" });
    prisma.user.findMany.mockResolvedValue([]);

    const signedPayload = await new jose.SignJWT({
      events: JSON.stringify({ type: "consent-revoked", sub: "apple-sub-1" }),
    })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(APPLE_ISSUER)
      .setAudience(BUNDLE_ID)
      .setIssuedAt()
      .setJti(crypto.randomUUID())
      .setExpirationTime("5m")
      .sign(privateKey);

    await service.handleNotification(signedPayload);

    expect(prisma.buyerAccount.update).toHaveBeenCalledWith({
      where: { id: "buyer-1" },
      data: { appleId: null, appleRefreshTokenEnc: null },
    });
    expect(prisma.buyerRefreshToken.deleteMany).toHaveBeenCalledWith({
      where: { buyerAccountId: "buyer-1" },
    });
    expect(prisma.buyerAccount.delete).not.toHaveBeenCalled();
  });

  it("an UNCONFIGURED bundle id rejects a validly signed token of ANY audience, and writes nothing", async () => {
    // jose skips the audience check for a falsy `audience`: with APPLE_BUNDLE_ID unset, any
    // Apple-signed JWT (another app's) must still be refused, never treated as a revocation.
    const { service, prisma, privateKey } = await buildService({
      configOverrides: { APPLE_BUNDLE_ID: "" },
    });
    expect(service.isNotificationConfigured()).toBe(false);
    const signedPayload = await new jose.SignJWT({
      events: JSON.stringify({ type: "consent-revoked", sub: "apple-sub-1" }),
    })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(APPLE_ISSUER)
      .setAudience("com.someone.else")
      .setIssuedAt()
      .setJti(crypto.randomUUID())
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(service.handleNotification(signedPayload)).rejects.toThrow(UnauthorizedException);
    expect(prisma.buyerAccount.update).not.toHaveBeenCalled();
    expect(prisma.buyerRefreshToken.deleteMany).not.toHaveBeenCalled();
  });

  // ─── Replay protection (lead follow-up on #2486) ────────────────────────────────
  async function signNotification(
    privateKey: jose.KeyLike,
    opts: { jti?: string | null; iatSecondsAgo?: number; type?: string; sub?: string } = {},
  ) {
    const jwt = new jose.SignJWT({
      events: JSON.stringify({
        type: opts.type ?? "consent-revoked",
        sub: opts.sub ?? "apple-sub-1",
      }),
    })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(APPLE_ISSUER)
      .setAudience(BUNDLE_ID)
      .setIssuedAt(Math.floor(Date.now() / 1000) - (opts.iatSecondsAgo ?? 0))
      .setExpirationTime("30d");
    if (opts.jti !== null) jwt.setJti(opts.jti ?? crypto.randomUUID());
    return jwt.sign(privateKey);
  }

  it("a replayed notification (same jti) is ignored: no second write, no error", async () => {
    const { service, prisma, privateKey } = await buildService();
    prisma.buyerAccount.findFirst.mockResolvedValue({ id: "buyer-1", appleId: "apple-sub-1" });
    prisma.user.findMany.mockResolvedValue([]);
    const token = await signNotification(privateKey, { jti: "jti-1" });

    await service.handleNotification(token);
    expect(prisma.buyerAccount.update).toHaveBeenCalledTimes(1);

    // The user re-links, then an attacker replays the captured token: it must not undo the link.
    prisma.buyerAccount.update.mockClear();
    prisma.buyerAccount.findFirst.mockResolvedValue({ id: "buyer-1", appleId: "apple-sub-1" });
    await expect(service.handleNotification(token)).resolves.toBeUndefined();
    expect(prisma.buyerAccount.update).not.toHaveBeenCalled();
    expect(prisma.buyerRefreshToken.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("a transient write failure frees the jti, so Apple's retry of the same token is processed (not swallowed as a replay)", async () => {
    const { service, prisma, privateKey } = await buildService();
    prisma.buyerAccount.findFirst.mockResolvedValue({ id: "buyer-1", appleId: "apple-sub-1" });
    prisma.user.findMany.mockResolvedValue([]);
    prisma.buyerAccount.update
      .mockRejectedValueOnce(new Error("transient db error"))
      .mockResolvedValue(undefined);
    const token = await signNotification(privateKey, { jti: "jti-retry" });

    await expect(service.handleNotification(token)).rejects.toThrow("transient db error");
    // Apple retries the SAME jwt after our 500: it must run again and clear the link.
    await expect(service.handleNotification(token)).resolves.toBeUndefined();
    expect(prisma.buyerAccount.update).toHaveBeenCalledTimes(2);
    expect(prisma.buyerRefreshToken.deleteMany).toHaveBeenCalledTimes(1);

    // And once it succeeded, a third delivery IS a replay.
    prisma.buyerAccount.update.mockClear();
    await service.handleNotification(token);
    expect(prisma.buyerAccount.update).not.toHaveBeenCalled();
  });

  it("pins the replay-store contract: SET key NX with a 7-day TTL under the apple:notif:jti: prefix", async () => {
    const { service, privateKey } = await buildService();
    const redisSet = (service as any).redis.set as jest.Mock;
    const token = await signNotification(privateKey, { jti: "jti-ttl" });
    (service as any).prisma.buyerAccount.findFirst.mockResolvedValue(null);
    (service as any).prisma.user.findMany.mockResolvedValue([]);

    await service.handleNotification(token);

    const call = redisSet.mock.calls.find((c) => String(c[0]).startsWith("apple:notif:jti:"));
    expect(call).toBeTruthy();
    expect(call![0]).toBe("apple:notif:jti:jti-ttl");
    expect(call!.slice(2)).toEqual(["EX", 7 * 24 * 3600, "NX"]);
    // The TTL must outlive every token that could still carry the jti (maxTokenAge 48h + skew).
    expect(7 * 24 * 3600).toBeGreaterThan(48 * 3600 + 60);
  });

  it("a FAILED jti delete is logged, never swallowed silently, and the original write error still surfaces", async () => {
    const { service, prisma, privateKey } = await buildService();
    prisma.buyerAccount.findFirst.mockResolvedValue({ id: "buyer-1", appleId: "apple-sub-1" });
    prisma.user.findMany.mockResolvedValue([]);
    prisma.buyerAccount.update.mockRejectedValueOnce(new Error("transient db error"));
    (service as any).redis.del = jest.fn().mockRejectedValue(new Error("redis del failed"));
    const warn = jest.spyOn((service as any).logger, "warn");

    await expect(
      service.handleNotification(await signNotification(privateKey, { jti: "jti-del-fail" })),
    ).rejects.toThrow("transient db error");

    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/jti/i);
    expect(logged).toMatch(/retry/i);
    // never log the jti value itself
    expect(logged).not.toContain("jti-del-fail");
  });

  it("two DIFFERENT notifications (different jti) are both processed", async () => {
    const { service, prisma, privateKey } = await buildService();
    prisma.buyerAccount.findFirst.mockResolvedValue({ id: "buyer-1", appleId: "apple-sub-1" });
    prisma.user.findMany.mockResolvedValue([]);
    await service.handleNotification(await signNotification(privateKey, { jti: "jti-a" }));
    await service.handleNotification(await signNotification(privateKey, { jti: "jti-b" }));
    expect(prisma.buyerAccount.update).toHaveBeenCalledTimes(2);
  });

  it("a token older than the max age (48h) is refused even though its exp is still in the future", async () => {
    const { service, prisma, privateKey } = await buildService();
    const old = await signNotification(privateKey, { iatSecondsAgo: 3 * 24 * 3600 });
    await expect(service.handleNotification(old)).rejects.toThrow(UnauthorizedException);
    expect(prisma.buyerAccount.update).not.toHaveBeenCalled();
  });

  it("a token with no jti is refused (it cannot be replay-checked) and writes nothing", async () => {
    const { service, prisma, privateKey } = await buildService();
    const noJti = await signNotification(privateKey, { jti: null });
    await expect(service.handleNotification(noJti)).rejects.toThrow(UnauthorizedException);
    expect(prisma.buyerAccount.update).not.toHaveBeenCalled();
  });

  it("when Redis is down the replay check fails closed with a 503 (Apple retries), writing nothing", async () => {
    const { service, prisma, privateKey } = await buildService();
    (service as any).redis.set = jest.fn().mockRejectedValue(new Error("redis down"));
    const token = await signNotification(privateKey);
    await expect(service.handleNotification(token)).rejects.toThrow(ServiceUnavailableException);
    expect(prisma.buyerAccount.update).not.toHaveBeenCalled();
    expect(prisma.buyerAccount.findFirst).not.toHaveBeenCalled();
  });
});

describe("AppleOAuthService — an unconfigured environment", () => {
  const UNSET = { APPLE_BUNDLE_ID: "", APPLE_TEAM_ID: "", APPLE_KEY_ID: "", APPLE_PRIVATE_KEY: "" };

  it("fails closed per request: with APPLE_BUNDLE_ID unset, a valid-looking token is apple_token_invalid", async () => {
    const { service, privateKey, prisma } = await buildService({ configOverrides: UNSET });
    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      context: "buyer-standalone",
    });
    await expect(
      service.signIn({
        identityToken,
        authorizationCode: "code",
        nonce,
        context: "buyer-standalone",
      }),
    ).rejects.toThrow(new UnauthorizedException("apple_token_invalid"));
    expect(prisma.buyerAccount.create).not.toHaveBeenCalled();
  });

  it("warns exactly once at boot when unset, and not at all when configured", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      await buildService({ configOverrides: UNSET });
      const unsetWarns = warn.mock.calls.filter(([m]) => String(m).includes("APPLE_BUNDLE_ID"));
      expect(unsetWarns).toHaveLength(1);
      warn.mockClear();
      await buildService();
      expect(warn.mock.calls.filter(([m]) => String(m).includes("APPLE_BUNDLE_ID"))).toHaveLength(
        0,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("constructs (the API boots) with no APPLE_* set at all", async () => {
    await expect(
      buildService({
        configOverrides: {
          APPLE_BUNDLE_ID: "",
          APPLE_TEAM_ID: "",
          APPLE_KEY_ID: "",
          APPLE_PRIVATE_KEY: "",
        },
      }),
    ).resolves.toBeDefined();
  });
});

describe("AppleOAuthService — algorithm pinning", () => {
  it("rejects an identity token signed with a non-RS256 key, even one present in the JWKS", async () => {
    const { service, prisma } = await buildService();
    const { publicKey, privateKey } = await jose.generateKeyPair("ES256");
    const esJwk = await jose.exportJWK(publicKey);
    esJwk.kid = "es-kid";
    esJwk.alg = "ES256";
    (service as any).jwks = jose.createLocalJWKSet({ keys: [esJwk] });
    const { nonce } = await service.mintNonce("acme", "staff");
    const token = await new jose.SignJWT({
      nonce: require("crypto").createHash("sha256").update(nonce).digest("hex"),
      email: "ops@acme.test",
      email_verified: true,
    })
      .setProtectedHeader({ alg: "ES256", kid: "es-kid" })
      .setIssuer(APPLE_ISSUER)
      .setAudience(BUNDLE_ID)
      .setSubject("apple-sub-es")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      service.signIn(
        {
          identityToken: token,
          authorizationCode: "c",
          nonce,
          tenantSlug: "acme",
          context: "staff",
        } as any,
        {} as any,
      ),
    ).rejects.toThrow("apple_token_invalid");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("AppleOAuthService — no PII or credentials in logs (lead Opus on #2486)", () => {
  const STAFF_EMAIL = "op@acme.example";
  const BUYER_EMAIL = "newbuyer@example.com";
  const spies: jest.SpyInstance[] = [];

  function spyLogs() {
    const seen: string[] = [];
    for (const level of ["log", "warn", "error", "debug", "verbose", "fatal"] as const) {
      spies.push(
        jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
          seen.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
        }),
      );
    }
    return seen;
  }

  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
  });

  it("a buyer created via Apple logs the account id, never the email or a credential", async () => {
    const seen = spyLogs();
    const { service, prisma, privateKey } = await buildService();
    prisma.buyerAccount.findFirst.mockResolvedValue(null);
    prisma.buyerAccount.create.mockResolvedValue({
      id: "buyer-new",
      email: BUYER_EMAIL,
      status: "ACTIVE",
      passwordSet: false,
    });
    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      context: "buyer-standalone",
      tokenOverrides: { email: BUYER_EMAIL, sub: "apple-sub-pii" },
    });
    await service.signIn({
      identityToken,
      authorizationCode: "auth-code-secret",
      nonce,
      context: "buyer-standalone",
    });

    const logs = seen.join("\n");
    expect(logs).toContain("buyer-new");
    for (const secret of [BUYER_EMAIL, identityToken, "auth-code-secret", nonce])
      expect(logs).not.toContain(secret);
  });

  it("a staff account linked via Apple logs the user id, never the email or a credential", async () => {
    const seen = spyLogs();
    const { service, prisma, privateKey } = await buildService();
    prisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      tenantId: "tenant-1",
      deletedAt: null,
      appleId: null,
      email: STAFF_EMAIL,
    });
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    const { nonce } = await service.mintNonce(undefined, "staff");
    const identityToken = await signIdentityToken(privateKey, {
      nonce: sha256hex(nonce),
      sub: "apple-sub-pii",
      email: STAFF_EMAIL,
    });
    await service.linkAppleAccount("user-1", identityToken, nonce);

    const logs = seen.join("\n");
    expect(logs).toContain("user-1");
    for (const secret of [STAFF_EMAIL, identityToken, nonce]) expect(logs).not.toContain(secret);
  });

  it("the spy is discriminating: it sees a log call that does carry an email", () => {
    const seen = spyLogs();
    new Logger("probe").log(`linked (${STAFF_EMAIL})`);
    expect(seen.join("\n")).toContain(STAFF_EMAIL);
  });
});

describe("AppleOAuthService — issuer pinning", () => {
  it("a token signed with a valid key but a foreign issuer is rejected before any lookup", async () => {
    const { service, prisma, privateKey } = await buildService();
    const { nonce, identityToken } = await mintAndSign(service, privateKey, {
      context: "buyer-standalone",
      tokenOverrides: { iss: "https://evil.example.com" },
    });
    await expect(
      service.signIn({
        identityToken,
        authorizationCode: "code",
        nonce,
        context: "buyer-standalone",
      }),
    ).rejects.toThrow("apple_token_invalid");
    expect(prisma.buyerAccount.findFirst).not.toHaveBeenCalled();
    expect(prisma.buyerAccount.create).not.toHaveBeenCalled();
  });
});

describe("AppleOAuthService.revokeRefreshToken — revoke a STORED token without reading the DB (B944 merge ordering)", () => {
  async function withRealKey() {
    const { privateKey } = await jose.generateKeyPair("ES256", { extractable: true });
    const pkcs8 = await jose.exportPKCS8(privateKey);
    return buildService({ configOverrides: { APPLE_PRIVATE_KEY: pkcs8 } });
  }

  it("posts the DECRYPTED token to Apple's revoke endpoint with the bundle id as client_id", async () => {
    const { service } = await withRealKey();
    fetchStub.mockResolvedValueOnce({ ok: true, status: 200 } as never);

    await service.revokeRefreshToken("enc:the-refresh-token", "buyer-S");

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, { body: URLSearchParams }];
    expect(url).toBe("https://appleid.apple.com/auth/revoke");
    expect(init.body.get("token")).toBe("the-refresh-token");
    expect(init.body.get("client_id")).toBe(BUNDLE_ID);
    expect(init.body.get("token_type_hint")).toBe("refresh_token");
  });

  it("no stored token: nothing is sent", async () => {
    const { service } = await withRealKey();
    await service.revokeRefreshToken(null, "buyer-S");
    await service.revokeRefreshToken("", "buyer-S");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("a non-OK answer or a network failure is logged and NEVER thrown (it must not block the caller)", async () => {
    const { service } = await withRealKey();
    const warn = jest.spyOn((service as any).logger, "warn");
    fetchStub.mockResolvedValueOnce({ ok: false, status: 500 } as never);
    await expect(service.revokeRefreshToken("enc:t", "buyer-S")).resolves.toBeUndefined();
    fetchStub.mockRejectedValueOnce(new Error("network down"));
    await expect(service.revokeRefreshToken("enc:t", "buyer-S")).resolves.toBeUndefined();
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/revoke failed/i);
    expect(logged).not.toContain("enc:t");
  });

  it("revokeForBuyer still reads the stored token and delegates (unchanged behaviour)", async () => {
    const { service, prisma } = await withRealKey();
    prisma.buyerAccount.findUnique.mockResolvedValue({ appleRefreshTokenEnc: "enc:stored" });
    fetchStub.mockResolvedValueOnce({ ok: true, status: 200 } as never);
    await service.revokeForBuyer("buyer-1");
    const [, init] = fetchStub.mock.calls[0] as unknown as [string, { body: URLSearchParams }];
    expect(init.body.get("token")).toBe("stored");
  });
});
