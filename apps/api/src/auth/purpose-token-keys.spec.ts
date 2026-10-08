/**
 * A purpose token (email-verify link, Connect state) must not be admitted by the session
 * strategy or the socket gateway even if the shape predicate were loosened: they are signed
 * with a per-purpose key, so the session key refuses them at signature verification.
 */
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { TenantsService } from "../tenants/tenants.service";
import { StripeConnectService } from "../stripe-connect/stripe-connect.service";
import { CONNECT_OAUTH_PROVIDER } from "../stripe-connect/provider/connect-oauth.interface";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { EncryptionService } from "../common/encryption.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";

// Predicate DISABLED: only the key can refuse these tokens.
jest.mock("./session-token", () => ({
  ...jest.requireActual("./session-token"),
  isStaffSessionPayload: () => true,
}));

const SECRET = "purpose-token-keys-test-secret-0123456789";
const STRIPE_CONFIG = {
  secretKey: "sk_test",
  connectClientId: "ca_test",
  connectWebhookSecret: "w",
};

function configMock(extra: Record<string, unknown> = {}) {
  return {
    get: jest.fn((k: string) => {
      if (k === "jwt") return { secret: SECRET, refreshSecret: "r", expiresIn: "15m" };
      if (k === "jwt.secret") return SECRET;
      if (k === "stripe") return STRIPE_CONFIG;
      if (k === "WEB_URL") return "https://app.test";
      return extra[k];
    }),
  };
}

async function mintEmailVerifyToken(): Promise<string> {
  const prisma = createMockPrisma();
  (prisma.tenant.findUnique as jest.Mock).mockResolvedValue(null);
  (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.tenant.create as jest.Mock).mockImplementation(({ data }: any) => ({
    id: "t1",
    ...data,
  }));
  (prisma.user.create as jest.Mock).mockImplementation(({ data }: any) => ({ id: "u1", ...data }));
  (prisma as any).tenantSubscription = { create: jest.fn().mockResolvedValue({}) };
  (prisma.$transaction as jest.Mock).mockImplementation((fn: any) =>
    fn({ ...prisma, tenantSubscription: (prisma as any).tenantSubscription }),
  );
  const email = { send: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }) };
  const mod = await Test.createTestingModule({
    providers: [
      TenantsService,
      { provide: PrismaService, useValue: prisma },
      { provide: EncryptionService, useValue: {} },
      { provide: StorageService, useValue: {} },
      { provide: EmailService, useValue: email },
      { provide: ConfigService, useValue: configMock() },
      { provide: JwtService, useValue: new JwtService({ secret: SECRET }) },
    ],
  }).compile();
  await mod.get(TenantsService).register({
    slug: "acme-distribution",
    businessName: "Acme Distribution",
    adminEmail: "owner@acme.example",
    adminUsername: "acme_admin",
    adminPassword: "Sup3rSecret!",
  });
  const html: string = email.send.mock.calls[0][0].html;
  const m = html.match(/token=([\w-]+\.[\w-]+\.[\w-]+)/);
  if (!m) throw new Error("no token in email html");
  return m[1]!;
}

async function mintConnectState(): Promise<string> {
  const prisma: any = createMockPrisma();
  prisma.tenantStripeConnect = { upsert: jest.fn().mockResolvedValue({}) };
  prisma.user.findFirst.mockResolvedValue({ email: "a@acme.example", role: "TENANT_ADMIN" });
  prisma.tenant.findUnique.mockResolvedValue({ name: "Acme" });
  const mod = await Test.createTestingModule({
    providers: [
      StripeConnectService,
      { provide: PrismaService, useValue: prisma },
      { provide: CONNECT_OAUTH_PROVIDER, useValue: { isConfigured: true } },
      { provide: ConfigService, useValue: configMock() },
      { provide: JwtService, useValue: new JwtService({ secret: SECRET }) },
    ],
  }).compile();
  const url = await mod.get(StripeConnectService).buildAuthorizeUrl("t1", "u1", "alice");
  const state = new URL(url).searchParams.get("state");
  if (!state) throw new Error("no state in url");
  return state;
}

function authenticate(strategy: JwtStrategy, token: string) {
  return new Promise<{ outcome: "success" | "fail" | "error"; info?: unknown }>((resolve) => {
    const s = strategy as any;
    s.success = () => resolve({ outcome: "success" });
    s.fail = (info: unknown) => resolve({ outcome: "fail", info });
    s.error = (err: unknown) => resolve({ outcome: "error", info: err });
    s.authenticate({ headers: { authorization: `Bearer ${token}` } });
  });
}

async function connect(token: string) {
  const prisma = { user: { findMany: jest.fn().mockResolvedValue([]) } };
  const gateway = new RouteFlowGateway(new JwtService({ secret: SECRET }), prisma as any);
  const client: any = {
    handshake: { auth: { token }, headers: {} },
    data: {},
    join: jest.fn(),
    disconnect: jest.fn(),
  };
  await gateway.handleConnection(client);
  return client;
}

describe("purpose tokens are not session tokens", () => {
  const strategy = new JwtStrategy({
    get: () => ({ secret: SECRET }),
  } as unknown as ConstructorParameters<typeof JwtStrategy>[0]);

  const cases: Array<[string, () => Promise<string>]> = [
    ["email-verify link", mintEmailVerifyToken],
    ["connect state", mintConnectState],
  ];

  it.each(cases)("%s: sanity - it is a real token minted by the real service", async (_n, mint) => {
    const token = await mint();
    expect(token.split(".")).toHaveLength(3);
    // not the session key's output: the raw secret must not verify it
    expect(() => new JwtService({ secret: SECRET }).verify(token)).toThrow();
  });

  it.each(cases)(
    "%s: the passport strategy refuses it with the predicate disabled",
    async (_n, mint) => {
      const res = await authenticate(strategy, await mint());
      // refused at signature verification (passport "fail"), not by a later claim check
      expect(res.outcome).toBe("fail");
      expect(String((res.info as Error)?.message ?? res.info)).toMatch(/invalid signature/);
    },
  );

  it.each(cases)("%s: the gateway disconnects it with the predicate disabled", async (_n, mint) => {
    const client = await connect(await mint());
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });

  it("control: a session-key token IS admitted when the predicate is disabled", async () => {
    const token = new JwtService({ secret: SECRET }).sign(
      { sub: "u1", role: "OPERATOR", tenantId: "t1" },
      { expiresIn: "15m" },
    );
    expect((await authenticate(strategy, token)).outcome).toBe("success");
  });
});
