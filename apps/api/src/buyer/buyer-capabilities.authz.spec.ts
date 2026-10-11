/**
 * Business profiles 1B — GET /buyer/capabilities: a buyer reads the fulfilment facts of a seller it
 * holds a LIVE link with, and only that seller's.
 *
 * End to end over HTTP through the real chain: the buyer-jwt passport strategy (a real signed
 * token), BuyerJwtAuthGuard, BuyerSellerContextGuard (the link check) and BuyerTenantInterceptor.
 * Stand-ins: Prisma (an in-memory store that applies the `where` the guard sends and throws on any
 * shape it does not model) and FulfilmentCapabilityService (records the tenant it was asked for).
 *
 * Fixtures are placeholders (acme / globex); no live-client data.
 */
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

import { BuyerCapabilitiesController } from "./buyer-capabilities.controller";
import { BuyerJwtStrategy } from "./strategies/buyer-jwt.strategy";
import { FulfilmentCapabilityService } from "../billing/fulfilment-capability.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { listenOnLoopback } from "../common/testing/listen-loopback";

const SECRET = "capabilities-authz-spec-secret";
const jwt = new JwtService({ secret: SECRET });

function seed() {
  return {
    accounts: [
      { id: "buyer-a", status: "ACTIVE", deletedAt: null as Date | null },
      { id: "buyer-b", status: "ACTIVE", deletedAt: null as Date | null },
    ],
    tenants: [
      { id: "t-acme", slug: "acme", status: "ACTIVE" },
      { id: "t-globex", slug: "globex", status: "ACTIVE" },
    ],
    customers: [
      { id: "c-a", tenantId: "t-acme", userId: "u-a", deletedAt: null as Date | null },
      { id: "c-b", tenantId: "t-globex", userId: "u-b", deletedAt: null as Date | null },
    ].map((c) => ({ ...c, businessName: `Sample ${c.id}`, email: `${c.id}@example.test` })),
    // buyer-a is linked to seller A (acme) only; buyer-b to seller B (globex) only.
    links: [
      { buyerAccountId: "buyer-a", customerId: "c-a", tenantId: "t-acme", status: "ACTIVE" },
      { buyerAccountId: "buyer-b", customerId: "c-b", tenantId: "t-globex", status: "ACTIVE" },
    ],
  };
}

type Store = ReturnType<typeof seed>;

const sameKeys = (obj: unknown, keys: string[]) =>
  !!obj &&
  typeof obj === "object" &&
  Object.keys(obj).sort().join(",") === [...keys].sort().join(",");

const pick = (row: Record<string, unknown>, select: Record<string, boolean>) =>
  Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));

function makePrisma(store: Store) {
  const customerOf = (id: string) => store.customers.find((c) => c.id === id)!;
  function linkMatches(link: Store["links"][number], where: Record<string, any>) {
    for (const [key, cond] of Object.entries(where)) {
      if (key === "buyerAccountId" || key === "tenantId" || key === "status") {
        if (typeof cond !== "string") throw new Error(`stand-in: unsupported ${key} filter`);
        if ((link as any)[key] !== cond) return false;
      } else if (key === "customer") {
        if (!sameKeys(cond, ["deletedAt"]) || cond.deletedAt !== null) {
          throw new Error(`stand-in: unsupported customer filter ${JSON.stringify(cond)}`);
        }
        if (customerOf(link.customerId).deletedAt !== null) return false;
      } else if (key === "buyerAccount") {
        if (
          !sameKeys(cond, ["status", "deletedAt"]) ||
          cond.status !== "ACTIVE" ||
          cond.deletedAt !== null
        ) {
          throw new Error(`stand-in: unsupported buyerAccount filter ${JSON.stringify(cond)}`);
        }
        const account = store.accounts.find((a) => a.id === link.buyerAccountId);
        if (!account || account.status !== "ACTIVE" || account.deletedAt !== null) return false;
      } else {
        throw new Error(`stand-in: unsupported CustomerLink filter "${key}"`);
      }
    }
    return true;
  }
  return {
    tenant: {
      findUnique: jest.fn(async (args: { where: { slug: string } }) => {
        if (!sameKeys(args.where, ["slug"])) throw new Error("stand-in: tenant by slug only");
        return store.tenants.find((t) => t.slug === args.where.slug) ?? null;
      }),
    },
    customerLink: {
      findFirst: jest.fn(
        async (args: { where: Record<string, any>; include?: any; select?: any }) => {
          const link = store.links.find((l) => linkMatches(l, args.where));
          if (!link) return null;
          const customer = customerOf(link.customerId);
          if (args.include)
            return { ...link, customer: pick(customer, args.include.customer.select) };
          return {
            customerId: link.customerId,
            customer: pick(customer, args.select.customer.select),
          };
        },
      ),
    },
  };
}

let app: INestApplication;
let store: Store;
let forBuyer: jest.Mock;

beforeEach(async () => {
  store = seed();
  forBuyer = jest.fn(async (tenantId: string) => ({
    portalMethods: tenantId === "t-acme" ? ["SHIP"] : ["ROUTE"],
    portalDefault: tenantId === "t-acme" ? "SHIP" : "ROUTE",
    fleet: tenantId !== "t-acme",
  }));
  const moduleRef = await Test.createTestingModule({
    imports: [PassportModule],
    controllers: [BuyerCapabilitiesController],
    providers: [
      BuyerJwtStrategy,
      {
        provide: ConfigService,
        useValue: { get: (key: string) => (key === "jwt" ? { secret: SECRET } : undefined) },
      },
      { provide: TenantContextService, useValue: new TenantContextService() },
      { provide: PrismaService, useValue: makePrisma(store) },
      { provide: FulfilmentCapabilityService, useValue: { forBuyer } },
    ],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await listenOnLoopback(app);
});

afterEach(async () => {
  await app.close();
});

const buyerToken = (sub: string) =>
  jwt.sign({ sub, email: `${sub}@example.test`, name: sub, type: "BUYER" });

function capabilities(slug: string | null, token: string | null = buyerToken("buyer-a")) {
  const req = request(app.getHttpServer()).get("/buyer/capabilities");
  if (token) req.set("Authorization", `Bearer ${token}`);
  if (slug) req.set("X-Tenant-Slug", slug);
  return req;
}

// SA r-note 5 A3 (Opus delta M1): the buyer web UI derives "isn't taking online orders" / a disabled Place Order button
// ONLY from `acceptingOrders`, so it must follow SELLER_READ_ONLY_BUYER_GATE: a dark gate means the server still takes
// the order, and the UI must not claim otherwise.
describe("GET /buyer/capabilities — acceptingOrders follows SELLER_READ_ONLY_BUYER_GATE", () => {
  const saved = process.env.SELLER_READ_ONLY_BUYER_GATE;
  afterEach(() => {
    if (saved === undefined) delete process.env.SELLER_READ_ONLY_BUYER_GATE;
    else process.env.SELLER_READ_ONLY_BUYER_GATE = saved;
  });
  const readOnlySeller = () => {
    store.tenants.find((t) => t.id === "t-acme")!.status = "READ_ONLY";
  };

  it("dark (the default) + a READ_ONLY seller: acceptingOrders is TRUE (the server takes the order)", async () => {
    delete process.env.SELLER_READ_ONLY_BUYER_GATE;
    readOnlySeller();
    const res = await capabilities("acme").expect(200);
    expect(res.body.acceptingOrders).toBe(true);
  });

  it("enforced + a READ_ONLY seller: acceptingOrders is FALSE", async () => {
    process.env.SELLER_READ_ONLY_BUYER_GATE = "enforced";
    readOnlySeller();
    const res = await capabilities("acme").expect(200);
    expect(res.body.acceptingOrders).toBe(false);
  });

  it.each([undefined, "dark", "enforced"])(
    "an ACTIVE seller accepts orders (gate %s)",
    async (g) => {
      if (g === undefined) delete process.env.SELLER_READ_ONLY_BUYER_GATE;
      else process.env.SELLER_READ_ONLY_BUYER_GATE = g;
      const res = await capabilities("acme").expect(200);
      expect(res.body.acceptingOrders).toBe(true);
    },
  );
});

describe("GET /buyer/capabilities — only the linked seller's facts", () => {
  it("buyer A at its own seller A: 200, read for seller A's tenant", async () => {
    const res = await capabilities("acme").expect(200);
    expect(res.body).toEqual({
      portalMethods: ["SHIP"],
      portalDefault: "SHIP",
      fleet: false,
      acceptingOrders: true,
    });
    expect(forBuyer).toHaveBeenCalledTimes(1);
    expect(forBuyer).toHaveBeenCalledWith("t-acme");
  });

  it("buyer A's token naming seller B's context: 403, and seller B is never read", async () => {
    await capabilities("globex").expect(403);
    expect(forBuyer).not.toHaveBeenCalled();
  });

  it("buyer B at seller B: 200, read for seller B's tenant (the header picks a LINKED seller only)", async () => {
    const res = await capabilities("globex", buyerToken("buyer-b")).expect(200);
    expect(res.body).toEqual({
      portalMethods: ["ROUTE"],
      portalDefault: "ROUTE",
      fleet: true,
      acceptingOrders: true,
    });
    expect(forBuyer).toHaveBeenCalledWith("t-globex");
  });

  it("a disconnected link to its own seller: 403, nothing read", async () => {
    store.links.find((l) => l.buyerAccountId === "buyer-a")!.status = "DISCONNECTED";
    await capabilities("acme").expect(403);
    expect(forBuyer).not.toHaveBeenCalled();
  });

  it("a suspended seller: 403, nothing read", async () => {
    store.tenants.find((t) => t.id === "t-acme")!.status = "SUSPENDED";
    await capabilities("acme").expect(403);
    expect(forBuyer).not.toHaveBeenCalled();
  });

  it("an unknown seller: 404; no seller named: 400", async () => {
    await capabilities("initech").expect(404);
    await capabilities(null).expect(400);
    expect(forBuyer).not.toHaveBeenCalled();
  });
});

describe("GET /buyer/capabilities — only a buyer token opens it", () => {
  it("no token: 401", async () => {
    await capabilities("acme", null).expect(401);
  });

  it("a staff token: 401 (the buyer strategy accepts BUYER tokens only)", async () => {
    await capabilities(
      "acme",
      jwt.sign({ sub: "u-a", role: "CUSTOMER", tenantId: "t-acme" }),
    ).expect(401);
  });

  it("a token this server did not sign: 401", async () => {
    const forged = new JwtService({ secret: "someone-else" }).sign({
      sub: "buyer-a",
      type: "BUYER",
    });
    await capabilities("acme", forged).expect(401);
    expect(forBuyer).not.toHaveBeenCalled();
  });
});
