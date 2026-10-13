/**
 * Structural inventory guard for every place the API signs a token, plus a behavioural check
 * that the HTTP strategy and the socket gateway admit exactly the session shapes.
 *
 * A new `.sign(` / `.signAsync(` call under `apps/api/src` that is not classified in SITES
 * fails this spec: classify it, give it a payload shape, and the checks below then apply to it.
 */
import * as fs from "fs";
import * as path from "path";
import { JwtService } from "@nestjs/jwt";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { JwtStrategy } from "./strategies/jwt.strategy";
import {
  DERIVED_JWT_AUDIENCES,
  DERIVED_JWT_LABELS,
  derivedJwtKey,
  type DerivedJwtLabel,
} from "../common/derived-jwt-key";
import {
  BUYER_ACCESS_AUDIENCE,
  BUYER_REFRESH_AUDIENCE,
  STAFF_ACCESS_AUDIENCE,
  STAFF_REFRESH_AUDIENCE,
} from "./session-token";
import { AuthService } from "./auth.service";
import { AppleOAuthService } from "./apple-oauth.service";
import { GoogleOAuthService } from "./google-oauth.service";
import { BuyerAuthService } from "../buyer/buyer-auth.service";
import { BuyerAdminService } from "../buyer/buyer-admin.service";
import { PlatformAdminService } from "../platform-admin/platform-admin.service";
import { createMockPrisma } from "../testing/prisma-mock";

const SRC_ROOT = path.resolve(__dirname, "..");
const SECRET = "token-sign-sites-test-secret-0123456789";

type Cls = "session-staff" | "session-impersonation" | "buyer" | "non-session";
/** Which key signs the token: the session key, the refresh key, a per-purpose derived key, or an external provider's. */
type Key = "access" | "refresh" | "provider" | `derived:${DerivedJwtLabel}`;

const staffAccess = {
  sub: "u1",
  username: "alice",
  role: "OPERATOR",
  status: "ACTIVE",
  forcePasswordChange: false,
  tenantId: "t1",
  tenantSlug: "acme",
  isAdmin: false,
  canActAsDriver: false,
  hasPassword: true,
  plan: "TEAM",
  flags: [],
  addons: [],
  seats: null,
  trialEnds: null,
};

const SHAPES: Record<string, Record<string, unknown>> = {
  "staff-access": staffAccess,
  "staff-impersonation": {
    ...staffAccess,
    role: "TENANT_ADMIN",
    forcePasswordChange: false,
    impersonatedBy: "sa1",
  },
  "buyer-access": { sub: "b1", email: "b@example.test", name: "B", type: "BUYER" },
  "email-link": { sub: "u1", tenantId: "t1", type: "email_verify" },
  "staff-refresh": { sub: "u1", type: "staff", jti: "j1" },
  "buyer-refresh": { sub: "b1", type: "buyer" },
  "connect-state": { purpose: "stripe-connect", tid: "t1", by: null, jti: "j1" },
  "provider-client-secret": {
    iss: "TEAM",
    sub: "com.example.app",
    aud: "https://appleid.apple.com",
  },
};

type Site = { cls: Cls; shape: keyof typeof SHAPES; key: Key; aud: string | null };

const STAFF_ACCESS = { key: "access", aud: STAFF_ACCESS_AUDIENCE } as const;
const BUYER_ACCESS = { key: "access", aud: BUYER_ACCESS_AUDIENCE } as const;
const STAFF_REFRESH = { key: "refresh", aud: STAFF_REFRESH_AUDIENCE } as const;
const BUYER_REFRESH = { key: "refresh", aud: BUYER_REFRESH_AUDIENCE } as const;
const EMAIL_LINK = {
  key: `derived:${DERIVED_JWT_LABELS.emailVerify}`,
  aud: "email-verify",
} as const;

/** "<file relative to src>#<n-th sign call in that file>" -> classification + payload shape + key. */
const SITES: Record<string, Site> = {
  "auth/apple-oauth.service.ts#1": {
    cls: "non-session",
    shape: "provider-client-secret",
    key: "provider",
    aud: null,
  },
  "auth/apple-oauth.service.ts#2": { cls: "session-staff", shape: "staff-access", ...STAFF_ACCESS },
  "auth/apple-oauth.service.ts#3": { cls: "non-session", shape: "staff-refresh", ...STAFF_REFRESH },
  "auth/apple-oauth.service.ts#4": { cls: "buyer", shape: "buyer-access", ...BUYER_ACCESS },
  "auth/apple-oauth.service.ts#5": { cls: "non-session", shape: "buyer-refresh", ...BUYER_REFRESH },
  "auth/auth.service.ts#1": { cls: "session-staff", shape: "staff-access", ...STAFF_ACCESS },
  "auth/auth.service.ts#2": { cls: "non-session", shape: "staff-refresh", ...STAFF_REFRESH },
  "auth/auth.service.ts#3": { cls: "session-staff", shape: "staff-access", ...STAFF_ACCESS },
  "auth/auth.service.ts#4": { cls: "non-session", shape: "staff-refresh", ...STAFF_REFRESH },
  "auth/auth.service.ts#5": { cls: "session-staff", shape: "staff-access", ...STAFF_ACCESS },
  "auth/auth.service.ts#6": { cls: "non-session", shape: "staff-refresh", ...STAFF_REFRESH },
  "auth/google-oauth.service.ts#1": {
    cls: "session-staff",
    shape: "staff-access",
    ...STAFF_ACCESS,
  },
  "auth/google-oauth.service.ts#2": {
    cls: "non-session",
    shape: "staff-refresh",
    ...STAFF_REFRESH,
  },
  "auth/google-oauth.service.ts#3": { cls: "buyer", shape: "buyer-access", ...BUYER_ACCESS },
  "auth/google-oauth.service.ts#4": {
    cls: "non-session",
    shape: "buyer-refresh",
    ...BUYER_REFRESH,
  },
  "tenants/tenants.service.ts#1": { cls: "non-session", shape: "email-link", ...EMAIL_LINK },
  "tenants/tenants.service.ts#2": { cls: "non-session", shape: "email-link", ...EMAIL_LINK },
  "platform-admin/platform-admin.service.ts#1": {
    cls: "session-impersonation",
    shape: "staff-impersonation",
    ...STAFF_ACCESS,
  },
  "stripe-connect/stripe-connect.service.ts#1": {
    cls: "non-session",
    shape: "connect-state",
    key: `derived:${DERIVED_JWT_LABELS.stripeConnectState}`,
    aud: "stripe-connect-state",
  },
  "buyer/buyer-auth.service.ts#1": { cls: "buyer", shape: "buyer-access", ...BUYER_ACCESS },
  "buyer/buyer-auth.service.ts#2": { cls: "non-session", shape: "buyer-refresh", ...BUYER_REFRESH },
  "buyer/buyer-admin.service.ts#1": { cls: "buyer", shape: "buyer-access", ...BUYER_ACCESS },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "testing" && e.name !== "node_modules") walk(p, out);
    } else if (e.name.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

function scanSites(): string[] {
  const found: string[] = [];
  for (const file of walk(SRC_ROOT).sort()) {
    const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/");
    const code = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    let n = 0;
    for (const line of code) {
      const hits = line.match(/\.sign(Async)?\(/g);
      for (let i = 0; i < (hits?.length ?? 0); i++) found.push(`${rel}#${++n}`);
    }
  }
  return found;
}

describe("token signing inventory", () => {
  it("classifies every signing site, and only those", () => {
    expect(scanSites()).toEqual(Object.keys(SITES).sort());
    expect(Object.keys(SITES)).toHaveLength(22);
  });

  it("gives every derived-key site a known label and an audience, and a session site its realm audience", () => {
    const labels = new Set<string>(Object.values(DERIVED_JWT_LABELS));
    for (const [site, { key, aud }] of Object.entries(SITES)) {
      if (key.startsWith("derived:")) {
        expect(labels.has(key.slice("derived:".length))).toBe(true);
        expect(typeof aud).toBe("string");
      } else if (key === "provider") {
        expect([site, aud]).toEqual([site, null]);
      } else {
        expect([site, typeof aud]).toEqual([site, "string"]);
      }
    }
  });

  it("pins the four realm audiences", () => {
    expect([
      STAFF_ACCESS_AUDIENCE,
      BUYER_ACCESS_AUDIENCE,
      STAFF_REFRESH_AUDIENCE,
      BUYER_REFRESH_AUDIENCE,
    ]).toEqual(["staff-access", "buyer-access", "staff-refresh", "buyer-refresh"]);
  });

  it("derived-key sites sign through the shared helper's label and audience, never the raw secret", () => {
    for (const [site, { key, aud }] of Object.entries(SITES)) {
      if (!key.startsWith("derived:")) continue;
      const file = fs.readFileSync(path.join(SRC_ROOT, site.split("#")[0]!), "utf8");
      const name = Object.entries(DERIVED_JWT_LABELS).find(
        ([, v]) => v === key.slice("derived:".length),
      )![0];
      expect(file).toContain(`DERIVED_JWT_LABELS.${name}`);
      const audName = Object.entries(DERIVED_JWT_AUDIENCES).find(([, v]) => v === aud)?.[0];
      expect(audName).toBeDefined();
      expect(file).toContain(`DERIVED_JWT_AUDIENCES.${audName}`);
    }
  });

  it("does not import another signing library outside the classified files", () => {
    const offenders = walk(SRC_ROOT)
      .filter((f) =>
        /from ["'](jsonwebtoken|jose)["']|require\(["']jsonwebtoken["']\)/.test(
          fs.readFileSync(f, "utf8"),
        ),
      )
      .map((f) => path.relative(SRC_ROOT, f).split(path.sep).join("/"));
    expect(offenders).toEqual(["auth/apple-oauth.service.ts"]);
  });
});

describe("session token admission by shape", () => {
  const jwt = new JwtService({ secret: SECRET });
  const strategy = new JwtStrategy({
    get: () => ({ secret: SECRET }),
  } as unknown as ConstructorParameters<typeof JwtStrategy>[0]);

  const staffRow = (p: any) => ({
    id: p.sub,
    role: p.role,
    tenantId: p.tenantId ?? null,
    canActAsDriver: p.canActAsDriver === true,
  });

  async function connect(payload: Record<string, unknown>) {
    const token = jwt.sign(payload, { expiresIn: "15m" });
    const prisma = { user: { findMany: jest.fn().mockResolvedValue([staffRow(payload)]) } };
    const gateway = new RouteFlowGateway(jwt, prisma as any);
    const client: any = {
      handshake: { auth: { token }, headers: {} },
      data: {},
      join: jest.fn(),
      disconnect: jest.fn(),
    };
    await gateway.handleConnection(client);
    return client;
  }

  const entries = Object.entries(SITES);

  it.each(entries)("strategy for %s", async (_site, { cls, shape }) => {
    const payload = SHAPES[shape];
    const admitted = await strategy.validate(payload as any).then(
      () => true,
      () => false,
    );
    expect(admitted).toBe(cls === "session-staff" || cls === "session-impersonation");
  });

  it.each(entries.filter(([, s]) => s.cls !== "buyer"))(
    "gateway for %s",
    async (_site, { cls, shape }) => {
      const client = await connect(SHAPES[shape]);
      if (cls === "session-staff" || cls === "session-impersonation") {
        expect(client.disconnect).not.toHaveBeenCalled();
        expect(client.join).toHaveBeenCalled();
      } else {
        expect(client.disconnect).toHaveBeenCalledWith(true);
        expect(client.join).not.toHaveBeenCalled();
      }
    },
  );

  it.each(entries.filter(([, s]) => s.key.startsWith("derived:")))(
    "a token signed with the derived key of %s is admitted by neither strategy nor gateway",
    async (_site, { shape, key, aud }) => {
      const label = key.slice("derived:".length) as DerivedJwtLabel;
      const token = jwt.sign(SHAPES[shape]!, {
        secret: derivedJwtKey(label, SECRET),
        audience: aud!,
        expiresIn: "15m",
      });
      const outcome = await new Promise<string>((resolve) => {
        const s = strategy as any;
        s.success = () => resolve("success");
        s.fail = () => resolve("fail");
        s.error = () => resolve("error");
        s.authenticate({ headers: { authorization: `Bearer ${token}` } });
      });
      expect(outcome).not.toBe("success");

      const gateway = new RouteFlowGateway(jwt, { user: { findMany: jest.fn() } } as any);
      const client: any = {
        handshake: { auth: { token }, headers: {} },
        data: {},
        join: jest.fn(),
        disconnect: jest.fn(),
      };
      await gateway.handleConnection(client);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.join).not.toHaveBeenCalled();
    },
  );

  it("rejects a role-less token without a type", async () => {
    await expect(strategy.validate({ sub: "u1" } as any)).rejects.toBeDefined();
    const client = await connect({ sub: "u1" });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });
});

type DepsAfterConfig =
  ConstructorParameters<typeof PlatformAdminService> extends [any, any, any, ...infer R]
    ? R
    : never;

describe("the real services mint the realm audience on every session token", () => {
  const JWT = {
    secret: "mint-aud-access-secret-0123456789abcdef",
    refreshSecret: "mint-aud-refresh-secret-0123456789abcdef",
    expiresIn: "15m",
    refreshExpiresIn: "30d",
  };
  const real = new JwtService({});
  const config = { get: (k: string) => (k === "jwt" ? JWT : undefined) } as any;
  const entitlements = { claimsFor: jest.fn().mockResolvedValue(null) } as any;
  const email = { send: jest.fn().mockResolvedValue(undefined) } as any;
  /** Any model method resolves to `{}` - minting only needs the writes not to throw. */
  const anyPrisma = () =>
    new Proxy(
      {},
      {
        get: (_t, model) =>
          model === "then"
            ? undefined
            : new Proxy({}, { get: () => jest.fn().mockResolvedValue({}) }),
      },
    ) as any;

  const staffUser = {
    id: "u1",
    username: "alice",
    email: "alice@example.test",
    role: "OPERATOR",
    status: "ACTIVE",
    forcePasswordChange: false,
    tenantId: null as string | null,
    isAdmin: false,
    canActAsDriver: false,
    password: "hash",
    deletedAt: null,
  };
  const SA = { ...staffUser, role: "SUPER_ADMIN" };

  type Pair = { access: string; refresh?: string };

  function authService(prisma: any) {
    return new AuthService(prisma, {} as any, real, config, email, entitlements);
  }

  const MINT: Record<string, () => Promise<Pair>> = {
    "auth.login": async () => {
      const r = await authService(createMockPrisma()).login(SA as any);
      return { access: r.accessToken, refresh: r.refreshToken };
    },
    "auth.refresh": async () => {
      const incoming = real.sign(
        { sub: "u1", type: "staff" },
        { secret: JWT.refreshSecret, expiresIn: "30d" },
      );
      const prisma = createMockPrisma();
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: "r1",
        userId: "u1",
        tokenHash: "h",
        expiresAt: new Date(Date.now() + 60_000),
      } as any);
      prisma.user.findUnique.mockResolvedValue(SA as any);
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 } as any);
      const r = await authService(prisma).refresh(incoming);
      return { access: r.accessToken, refresh: r.refreshToken };
    },
    "auth.mintSessionForUser": async () => {
      const r = await (authService(createMockPrisma()) as any).mintSessionForUser(SA);
      return { access: r.accessToken, refresh: r.refreshToken };
    },
    "google.staff": async () => {
      const svc = new GoogleOAuthService(anyPrisma(), real, config, email, entitlements);
      const r = await (svc as any).issueUserTokenPair(SA, null);
      return { access: r.accessToken, refresh: r.refreshToken };
    },
    "google.buyer": async () => {
      const svc = new GoogleOAuthService(anyPrisma(), real, config, email, entitlements);
      const r = await (svc as any).issueBuyerTokenPair("b1", "b@example.test", "B", true);
      return { access: r.accessToken, refresh: r.refreshToken };
    },
    "apple.staff": async () => {
      const svc = new AppleOAuthService(anyPrisma(), real, config, email, entitlements, {} as any);
      const r = await (svc as any).issueUserTokenPair(SA, null);
      return { access: r.accessToken, refresh: r.refreshToken };
    },
    "apple.buyer": async () => {
      const svc = new AppleOAuthService(anyPrisma(), real, config, email, entitlements, {} as any);
      const r = await (svc as any).issueBuyerTokenPair("b1", "b@example.test", "B", true);
      return { access: r.accessToken, refresh: r.refreshToken };
    },
    "buyerAuth.issue": async () => {
      const svc = new BuyerAuthService(createMockPrisma(), real, config, email, {} as any);
      const r = await svc.issueBuyerTokenPair("b1", "b@example.test", "B");
      return { access: r.accessToken, refresh: r.refreshToken };
    },
    "buyerAdmin.impersonate": async () => {
      const prisma = createMockPrisma();
      prisma.buyerAccount.findUnique.mockResolvedValue({
        id: "b1",
        email: "b@example.test",
        name: "B",
      } as any);
      const r = await new BuyerAdminService(prisma, real, config).impersonateBuyer("b1", "sa1");
      return { access: r.accessToken };
    },
    "platformAdmin.impersonate": async () => {
      const prisma = createMockPrisma();
      prisma.user.findFirst.mockResolvedValue({ ...staffUser, role: "TENANT_ADMIN" } as any);
      const svc = new PlatformAdminService(
        prisma,
        real,
        config,
        ...(Array(15).fill({}) as unknown as DepsAfterConfig),
      );
      jest.spyOn(svc as any, "_findOrThrow").mockResolvedValue({ id: "t1", slug: "acme" });
      jest.spyOn(svc as any, "recordAdminAction").mockResolvedValue(undefined);
      const r = await svc.impersonate("t1", "sa1");
      return { access: r.accessToken };
    },
  };

  /** site -> [minter, which token of the pair]. Every access/refresh site must appear. */
  const SITE_MINTER: Record<string, [keyof typeof MINT, "access" | "refresh"]> = {
    "auth/apple-oauth.service.ts#2": ["apple.staff", "access"],
    "auth/apple-oauth.service.ts#3": ["apple.staff", "refresh"],
    "auth/apple-oauth.service.ts#4": ["apple.buyer", "access"],
    "auth/apple-oauth.service.ts#5": ["apple.buyer", "refresh"],
    "auth/auth.service.ts#1": ["auth.login", "access"],
    "auth/auth.service.ts#2": ["auth.login", "refresh"],
    "auth/auth.service.ts#3": ["auth.refresh", "access"],
    "auth/auth.service.ts#4": ["auth.refresh", "refresh"],
    "auth/auth.service.ts#5": ["auth.mintSessionForUser", "access"],
    "auth/auth.service.ts#6": ["auth.mintSessionForUser", "refresh"],
    "auth/google-oauth.service.ts#1": ["google.staff", "access"],
    "auth/google-oauth.service.ts#2": ["google.staff", "refresh"],
    "auth/google-oauth.service.ts#3": ["google.buyer", "access"],
    "auth/google-oauth.service.ts#4": ["google.buyer", "refresh"],
    "platform-admin/platform-admin.service.ts#1": ["platformAdmin.impersonate", "access"],
    "buyer/buyer-auth.service.ts#1": ["buyerAuth.issue", "access"],
    "buyer/buyer-auth.service.ts#2": ["buyerAuth.issue", "refresh"],
    "buyer/buyer-admin.service.ts#1": ["buyerAdmin.impersonate", "access"],
  };

  it("covers exactly the access and refresh rows of SITES", () => {
    const sessionRows = Object.entries(SITES)
      .filter(([, s]) => s.key === "access" || s.key === "refresh")
      .map(([site]) => site)
      .sort();
    expect(Object.keys(SITE_MINTER).sort()).toEqual(sessionRows);
  });

  const cache = new Map<string, Promise<Pair>>();
  const minted = (name: string) => {
    if (!cache.has(name)) cache.set(name, MINT[name]!());
    return cache.get(name)!;
  };

  it.each(Object.entries(SITE_MINTER))("%s mints its realm audience", async (site, [m, which]) => {
    const { aud, key } = SITES[site]!;
    const token = (await minted(m))[which]!;
    expect(typeof token).toBe("string");
    // Verifying with the realm audience proves both the signature key and the `aud` claim.
    const secret = key === "access" ? JWT.secret : JWT.refreshSecret;
    const claims = real.verify(token, { secret, audience: aud! }) as { aud?: unknown };
    expect(claims.aud).toBe(aud);
  });

  describe("rollout: a token with no audience is still accepted", () => {
    const strategy = new JwtStrategy({
      get: () => ({ secret: JWT.secret }),
    } as unknown as ConstructorParameters<typeof JwtStrategy>[0]);

    it("the staff strategy admits a no-aud and a realm-aud access token", async () => {
      for (const audience of [undefined, STAFF_ACCESS_AUDIENCE]) {
        const token = real.sign(
          { ...staffAccess },
          { secret: JWT.secret, expiresIn: "15m", ...(audience ? { audience } : {}) },
        );
        const outcome = await new Promise<string>((resolve) => {
          const s = strategy as any;
          s.success = () => resolve("success");
          s.fail = () => resolve("fail");
          s.error = () => resolve("error");
          s.authenticate({ headers: { authorization: `Bearer ${token}` } });
        });
        expect(outcome).toBe("success");
      }
    });

    function staffRefreshFixture(prisma: any) {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: "r1",
        userId: "u1",
        tokenHash: "h",
        expiresAt: new Date(Date.now() + 60_000),
      });
      prisma.user.findUnique.mockResolvedValue(SA);
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      return authService(prisma);
    }
    function buyerRefreshFixture(prisma: any) {
      prisma.buyerRefreshToken.findUnique.mockResolvedValue({
        buyerAccountId: "b1",
        tokenHash: "h",
        expiresAt: new Date(Date.now() + 60_000),
      });
      prisma.buyerAccount.findUnique.mockResolvedValue({
        id: "b1",
        email: "b@example.test",
        name: "B",
        status: "ACTIVE",
        deletedAt: null,
        password: "x",
      });
      prisma.buyerRefreshToken.deleteMany.mockResolvedValue({ count: 1 });
      return new BuyerAuthService(prisma, real, config, email, {} as any);
    }
    const refreshTok = (claims: object, audience?: string) =>
      real.sign(claims, {
        secret: JWT.refreshSecret,
        expiresIn: "30d",
        ...(audience ? { audience } : {}),
      });

    it.each([[undefined], [STAFF_REFRESH_AUDIENCE]])(
      "staff refresh accepts aud %p",
      async (aud) => {
        const svc = staffRefreshFixture(createMockPrisma());
        await expect(
          svc.refresh(refreshTok({ sub: "u1", type: "staff" }, aud)),
        ).resolves.toMatchObject({ accessToken: expect.any(String) });
      },
    );

    it.each([[BUYER_REFRESH_AUDIENCE], [STAFF_ACCESS_AUDIENCE], ["email-verify"]])(
      "staff refresh refuses a foreign aud %p",
      async (aud) => {
        const svc = staffRefreshFixture(createMockPrisma());
        await expect(svc.refresh(refreshTok({ sub: "u1", type: "staff" }, aud))).rejects.toThrow(
          "Invalid or expired refresh token",
        );
      },
    );

    it.each([[undefined], [BUYER_REFRESH_AUDIENCE]])(
      "buyer refresh accepts aud %p",
      async (aud) => {
        const svc = buyerRefreshFixture(createMockPrisma());
        await expect(
          svc.refresh(refreshTok({ sub: "b1", type: "buyer" }, aud)),
        ).resolves.toMatchObject({ accessToken: expect.any(String) });
      },
    );

    it.each([[STAFF_REFRESH_AUDIENCE], [BUYER_ACCESS_AUDIENCE], ["stripe-connect-state"]])(
      "buyer refresh refuses a foreign aud %p",
      async (aud) => {
        const svc = buyerRefreshFixture(createMockPrisma());
        await expect(svc.refresh(refreshTok({ sub: "b1", type: "buyer" }, aud))).rejects.toThrow(
          "Invalid or expired refresh token",
        );
      },
    );
  });
});
