/**
 * #2095 item 4 — GET /buyer/orders/:id/tracking: a buyer can read the tracking of its OWN order,
 * at the seller it is asking as, and nothing else.
 *
 * End to end over HTTP through the real chain: the buyer-jwt passport strategy (a real signed
 * token), BuyerJwtAuthGuard, BuyerSellerContextGuard (the link check), BuyerTenantInterceptor (the
 * request's tenant) and the real `getOrderTracking` behind `OrdersService`. The only stand-in is
 * Prisma: an in-memory store that applies the `where` each caller sends and mirrors
 * PrismaService.forTenant() exactly where this path relies on it (a foreign-tenant row read by id
 * comes back null; a findFirst is tenant-filtered). It throws on any shape it does not model, so
 * a query change cannot pass by accident.
 *
 * Fixtures are placeholders (acme / globex); no live-client data.
 */
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { fulfilmentUnsetProvider } from "../billing/testing/fulfilment-capability-provider";
import { INestApplication, InjectionToken } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

import { BuyerController } from "./buyer.controller";
import { BuyerService } from "./buyer.service";
import { BuyerCatalogService } from "./buyer-catalog.service";
import { BuyerDashboardService } from "./buyer-dashboard.service";
import { ReplenishmentService } from "./replenishment.service";
import { ShelfService } from "./shelf.service";
import { StatementService } from "./statement.service";
import { StatementPdfService } from "./statement-pdf.service";
import { BuyerJwtStrategy } from "./strategies/buyer-jwt.strategy";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { PromotionsService } from "../promotions/promotions.service";
import { OrdersService } from "../orders/orders.service";
import { ChangeRequestsService } from "../orders/change-requests.service";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { CustomersService } from "../customers/customers.service";
import { OrderTemplatesService } from "../order-templates/order-templates.service";
import { AuthorizationsService } from "../authorizations/authorizations.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { getOrderTracking } from "../orders/order-tracking";
import { listenOnLoopback } from "../common/testing/listen-loopback";

const SECRET = "tracking-authz-spec-secret";
const jwt = new JwtService({ secret: SECRET });

// ─── Store ─────────────────────────────────────────────────────────────────────

function seed() {
  return {
    accounts: [
      { id: "buyer-mine", status: "ACTIVE", deletedAt: null as Date | null },
      { id: "buyer-other", status: "ACTIVE", deletedAt: null as Date | null },
    ],
    tenants: [
      { id: "t-1", slug: "acme", status: "ACTIVE" },
      { id: "t-2", slug: "globex", status: "ACTIVE" },
    ],
    customers: [
      { id: "c-mine", tenantId: "t-1", userId: "u-mine", deletedAt: null as Date | null },
      { id: "c-other", tenantId: "t-1", userId: "u-other", deletedAt: null as Date | null },
      { id: "c-mine2", tenantId: "t-2", userId: "u-mine2", deletedAt: null as Date | null },
      { id: "c-far", tenantId: "t-2", userId: "u-far", deletedAt: null as Date | null },
    ].map((c) => ({
      ...c,
      businessName: `Sample ${c.id}`,
      email: `${c.id}@example.test`,
      deliveryWindowStart: "09:00",
      deliveryWindowEnd: "11:00",
    })),
    links: [
      { buyerAccountId: "buyer-mine", customerId: "c-mine", tenantId: "t-1", status: "ACTIVE" },
      { buyerAccountId: "buyer-mine", customerId: "c-mine2", tenantId: "t-2", status: "ACTIVE" },
      { buyerAccountId: "buyer-other", customerId: "c-other", tenantId: "t-1", status: "ACTIVE" },
    ],
    runs: [
      {
        id: "run-1",
        tenantId: "t-1",
        status: "IN_PROGRESS",
        scheduledDate: new Date("2026-09-24T00:00:00.000Z"),
        driver: { id: "d-1", contactName: "Sam Rivera" },
        route: { id: "r-1", name: "Tuesday North" },
      },
    ],
    stops: [
      { id: "s-1", routeRunId: "run-1", stopNumber: 1, status: "COMPLETED" },
      { id: "s-2", routeRunId: "run-1", stopNumber: 2, status: "PENDING" },
      { id: "s-3", routeRunId: "run-1", stopNumber: 3, status: "PENDING" },
    ],
    orders: [
      { id: "o-mine", tenantId: "t-1", customerId: "c-mine", status: "CONFIRMED", stopId: "s-3" },
      { id: "o-other", tenantId: "t-1", customerId: "c-other", status: "CONFIRMED", stopId: "s-2" },
      { id: "o-mine2", tenantId: "t-2", customerId: "c-mine2", status: "PENDING", stopId: null },
      { id: "o-far", tenantId: "t-2", customerId: "c-far", status: "PENDING", stopId: null },
    ],
  };
}

type Store = ReturnType<typeof seed>;

function sameKeys(obj: unknown, keys: string[]): boolean {
  return (
    !!obj &&
    typeof obj === "object" &&
    Object.keys(obj).sort().join(",") === [...keys].sort().join(",")
  );
}

function pick(row: Record<string, unknown>, select: Record<string, boolean>) {
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
}

/** The exact include `getOrderTracking` sends; anything else is a change this spec must see. */
const TRACKING_INCLUDE = {
  customer: { select: { deliveryWindowStart: true, deliveryWindowEnd: true } },
  routeRunStop: {
    include: {
      routeRun: {
        include: {
          driver: { select: { id: true, contactName: true } },
          route: { select: { id: true, name: true } },
          stops: { select: { stopNumber: true, status: true } },
        },
      },
    },
  },
};

function makePrisma(store: Store, tenantCtx: TenantContextService) {
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
        // #2142 R1: the buyer's own account (a to-one relation filter).
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

  const orderFindUnique = jest.fn(async (args: { where: { id: string }; include: unknown }) => {
    if (!sameKeys(args.where, ["id"])) throw new Error("stand-in: order.findUnique by id only");
    expect(args.include).toEqual(TRACKING_INCLUDE);
    const order = store.orders.find((o) => o.id === args.where.id);
    // PrismaService.forTenant(): findUnique cannot carry tenantId in `where`, so a row of
    // another tenant is read and then discarded — the caller sees "not found".
    const tenantId = tenantCtx.getOrNull();
    if (!order || (tenantId && order.tenantId !== tenantId)) return null;
    const stop = store.stops.find((s) => s.id === order.stopId);
    const run = stop && store.runs.find((r) => r.id === stop.routeRunId);
    const customer = customerOf(order.customerId);
    return {
      ...order,
      customer: {
        deliveryWindowStart: customer.deliveryWindowStart,
        deliveryWindowEnd: customer.deliveryWindowEnd,
      },
      routeRunStop:
        stop && run
          ? {
              ...stop,
              routeRun: {
                ...run,
                stops: store.stops
                  .filter((s) => s.routeRunId === run.id)
                  .map((s) => ({ stopNumber: s.stopNumber, status: s.status })),
              },
            }
          : null,
    };
  });

  const scopedCustomerFindFirst = jest.fn(async (args: { where: Record<string, any> }) => {
    if (!sameKeys(args.where, ["userId", "deletedAt"]) || args.where.deletedAt !== null) {
      throw new Error(`stand-in: unsupported customer filter ${JSON.stringify(args.where)}`);
    }
    // PrismaService.forTenant(): findFirst gets the request's tenantId injected into `where`.
    const tenantId = tenantCtx.getOrNull();
    return (
      store.customers.find(
        (c) =>
          c.userId === args.where.userId &&
          c.deletedAt === null &&
          (!tenantId || c.tenantId === tenantId),
      ) ?? null
    );
  });

  return {
    orderFindUnique,
    prisma: {
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
            if (args.include) {
              return { ...link, customer: pick(customer, args.include.customer.select) };
            }
            return {
              customerId: link.customerId,
              customer: pick(customer, args.select.customer.select),
            };
          },
        ),
      },
      forTenant: () => ({
        order: { findUnique: orderFindUnique },
        customer: { findFirst: scopedCustomerFindFirst },
      }),
    },
  };
}

// ─── App ───────────────────────────────────────────────────────────────────────

let app: INestApplication;
let store: Store;
let orderFindUnique: jest.Mock;

beforeEach(async () => {
  store = seed();
  const tenantCtx = new TenantContextService();
  const standIn = makePrisma(store, tenantCtx);
  orderFindUnique = standIn.orderFindUnique;
  const prisma = standIn.prisma as unknown as PrismaService;

  const stub = (token: InjectionToken) => ({ provide: token, useValue: {} });
  const moduleRef = await Test.createTestingModule({
    imports: [PassportModule],
    controllers: [BuyerController],
    providers: [
      fulfilmentUnsetProvider,
      oversellReaderOffProvider,
      BuyerJwtStrategy,
      {
        provide: ConfigService,
        useValue: { get: (key: string) => (key === "jwt" ? { secret: SECRET } : undefined) },
      },
      { provide: TenantContextService, useValue: tenantCtx },
      { provide: PrismaService, useValue: prisma },
      {
        provide: OrdersService,
        // OrdersService.getOrderTracking is exactly this delegation (orders.service.ts).
        useValue: {
          getOrderTracking: (id: string, user: any) => getOrderTracking({ prisma }, id, user),
        },
      },
      ...[
        BuyerService,
        BuyerCatalogService,
        BuyerDashboardService,
        ReplenishmentService,
        ShelfService,
        StockAlertService,
        PromotionsService,
        ChangeRequestsService,
        InvoicesService,
        InvoicePdfService,
        StatementService,
        StatementPdfService,
        CustomersService,
        OrderTemplatesService,
        AuthorizationsService,
        SystemConfigService,
      ].map(stub),
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

function track(
  orderId: string,
  slug: string | null,
  token: string | null = buyerToken("buyer-mine"),
) {
  const req = request(app.getHttpServer()).get(`/buyer/orders/${orderId}/tracking`);
  if (token) req.set("Authorization", `Bearer ${token}`);
  if (slug) req.set("X-Tenant-Slug", slug);
  return req;
}

// ─── Ownership ─────────────────────────────────────────────────────────────────

describe("GET /buyer/orders/:id/tracking — a buyer reads only its own order at its own seller", () => {
  it("its own order at the seller it asks as: 200, with the customer-facing payload", async () => {
    const res = await track("o-mine", "acme").expect(200);
    expect(res.body).toEqual({
      status: "CONFIRMED",
      tracking: {
        runId: "run-1",
        routeName: null,
        driverName: "Sam",
        runStatus: "IN_PROGRESS",
        stopNumber: 3,
        stopStatus: "PENDING",
        stopsAhead: 1,
        scheduledDate: "2026-09-24T00:00:00.000Z",
        estimatedArrivalWindow: { start: "09:00", end: "11:00" },
      },
    });
  });

  it("another customer's order at the same seller: 403", async () => {
    await track("o-other", "acme").expect(403);
  });

  it("another seller's order asked under this seller: 404, indistinguishable from no order", async () => {
    await track("o-far", "acme").expect(404);
    await track("o-mine2", "acme").expect(404);
  });

  it("another customer's order at the buyer's OTHER seller: 403", async () => {
    await track("o-far", "globex").expect(403);
  });

  it("its own order at its other seller, asked as that seller: 200", async () => {
    const res = await track("o-mine2", "globex").expect(200);
    expect(res.body).toEqual({ status: "PENDING", tracking: null });
  });

  it("the other buyer at the same seller cannot read this buyer's order: 403", async () => {
    await track("o-mine", "acme", buyerToken("buyer-other")).expect(403);
  });
});

// ─── The link gate: refused before any order is read ─────────────────────────

describe("GET /buyer/orders/:id/tracking — the seller link gates the request", () => {
  it("a disconnected link: 403, and the order is never read", async () => {
    store.links.find((l) => l.customerId === "c-mine")!.status = "DISCONNECTED";
    await track("o-mine", "acme").expect(403);
    expect(orderFindUnique).not.toHaveBeenCalled();
  });

  it("a removed customer (REG-B141): 403, and the order is never read", async () => {
    store.customers.find((c) => c.id === "c-mine")!.deletedAt = new Date("2026-09-01");
    await track("o-mine", "acme").expect(403);
    expect(orderFindUnique).not.toHaveBeenCalled();
  });

  it("a suspended seller: 403, and the order is never read", async () => {
    store.tenants.find((t) => t.id === "t-1")!.status = "SUSPENDED";
    await track("o-mine", "acme").expect(403);
    expect(orderFindUnique).not.toHaveBeenCalled();
  });

  it("#2142 R1: a SUSPENDED buyer account, on a still-valid token: 403, and the order is never read", async () => {
    // setBuyerStatus leaves the links ACTIVE; the token was minted before the suspension.
    store.accounts.find((a) => a.id === "buyer-mine")!.status = "SUSPENDED";
    await track("o-mine", "acme").expect(403);
    expect(orderFindUnique).not.toHaveBeenCalled();
  });

  it("#2142 R1: a DELETED buyer account, on a still-valid token: 403, and the order is never read", async () => {
    const account = store.accounts.find((a) => a.id === "buyer-mine")!;
    account.status = "DELETED";
    account.deletedAt = new Date("2026-09-25");
    await track("o-mine", "acme").expect(403);
    expect(orderFindUnique).not.toHaveBeenCalled();
  });

  it("a seller the buyer has no link with: 403", async () => {
    store.tenants.push({ id: "t-3", slug: "initech", status: "ACTIVE" });
    await track("o-mine", "initech").expect(403);
    expect(orderFindUnique).not.toHaveBeenCalled();
  });

  it("no seller named: 400", async () => {
    await track("o-mine", null).expect(400);
  });
});

// ─── The token ─────────────────────────────────────────────────────────────────

describe("GET /buyer/orders/:id/tracking — only a buyer token opens it", () => {
  it("no token: 401", async () => {
    await track("o-mine", "acme", null).expect(401);
  });

  it("a staff token: 401 (the buyer strategy accepts BUYER tokens only)", async () => {
    const staff = jwt.sign({ sub: "u-mine", role: "CUSTOMER", tenantId: "t-1" });
    await track("o-mine", "acme", staff).expect(401);
  });

  it("a token this server did not sign: 401", async () => {
    const forged = new JwtService({ secret: "someone-else" }).sign({
      sub: "buyer-mine",
      type: "BUYER",
    });
    await track("o-mine", "acme", forged).expect(401);
  });
});
