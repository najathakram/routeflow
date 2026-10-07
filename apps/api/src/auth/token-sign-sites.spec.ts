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

const SRC_ROOT = path.resolve(__dirname, "..");
const SECRET = "token-sign-sites-test-secret";

type Cls = "session-staff" | "session-impersonation" | "buyer" | "non-session";

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

/** "<file relative to src>#<n-th sign call in that file>" -> classification + payload shape. */
const SITES: Record<string, { cls: Cls; shape: keyof typeof SHAPES }> = {
  "auth/apple-oauth.service.ts#1": { cls: "non-session", shape: "provider-client-secret" },
  "auth/apple-oauth.service.ts#2": { cls: "session-staff", shape: "staff-access" },
  "auth/apple-oauth.service.ts#3": { cls: "non-session", shape: "staff-refresh" },
  "auth/apple-oauth.service.ts#4": { cls: "buyer", shape: "buyer-access" },
  "auth/apple-oauth.service.ts#5": { cls: "non-session", shape: "buyer-refresh" },
  "auth/auth.service.ts#1": { cls: "session-staff", shape: "staff-access" },
  "auth/auth.service.ts#2": { cls: "non-session", shape: "staff-refresh" },
  "auth/auth.service.ts#3": { cls: "session-staff", shape: "staff-access" },
  "auth/auth.service.ts#4": { cls: "non-session", shape: "staff-refresh" },
  "auth/auth.service.ts#5": { cls: "session-staff", shape: "staff-access" },
  "auth/auth.service.ts#6": { cls: "non-session", shape: "staff-refresh" },
  "auth/google-oauth.service.ts#1": { cls: "session-staff", shape: "staff-access" },
  "auth/google-oauth.service.ts#2": { cls: "non-session", shape: "staff-refresh" },
  "auth/google-oauth.service.ts#3": { cls: "buyer", shape: "buyer-access" },
  "auth/google-oauth.service.ts#4": { cls: "non-session", shape: "buyer-refresh" },
  "tenants/tenants.service.ts#1": { cls: "non-session", shape: "email-link" },
  "tenants/tenants.service.ts#2": { cls: "non-session", shape: "email-link" },
  "platform-admin/platform-admin.service.ts#1": {
    cls: "session-impersonation",
    shape: "staff-impersonation",
  },
  "stripe-connect/stripe-connect.service.ts#1": { cls: "non-session", shape: "connect-state" },
  "buyer/buyer-auth.service.ts#1": { cls: "buyer", shape: "buyer-access" },
  "buyer/buyer-auth.service.ts#2": { cls: "non-session", shape: "buyer-refresh" },
  "buyer/buyer-admin.service.ts#1": { cls: "buyer", shape: "buyer-access" },
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

  it("rejects a role-less token without a type", async () => {
    await expect(strategy.validate({ sub: "u1" } as any)).rejects.toBeDefined();
    const client = await connect({ sub: "u1" });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });
});
