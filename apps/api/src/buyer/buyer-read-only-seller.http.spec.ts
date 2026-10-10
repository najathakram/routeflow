/**
 * SA-733r6 (B4), end to end over HTTP with the REAL request path: the app has `setGlobalPrefix("api/v1")` (as
 * production does), the buyer token is a real signed BUYER token (no tenantId / role claim), and the chain is the
 * real BuyerJwtAuthGuard -> BuyerSellerContextGuard -> BuyerTenantInterceptor.
 *
 * A READ_ONLY seller still takes the buyer's own PAYMENTS (card, cash declaration, cancel own request) and refuses
 * everything else a buyer writes (SELLER_UNAVAILABLE). Stand-ins: Prisma (tenant + link lookups only) and the
 * payment-requests service (records what reached the handler). Fixtures are placeholders (acme).
 */
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

import { PaymentRequestsService } from "../payment-requests/payment-requests.service";
import { BuyerPaymentsController } from "../payment-requests/buyer-payments.controller";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { listenOnLoopback } from "../common/testing/listen-loopback";
import { BuyerController } from "./buyer.controller";
import { BuyerJwtStrategy } from "./strategies/buyer-jwt.strategy";

const SECRET = "read-only-seller-http-spec-secret";
const jwt = new JwtService({ secret: SECRET });
const token = jwt.sign({ sub: "buyer-a", email: "a@example.test", name: "A", type: "BUYER" });

let app: INestApplication;
let sellerStatus: string;
let payments: { createCardRequest: jest.Mock; createCashRequest: jest.Mock; cancelOwn: jest.Mock };

beforeEach(async () => {
  sellerStatus = "READ_ONLY";
  payments = {
    createCardRequest: jest.fn(async () => ({ checkoutUrl: "https://pay.example/c/1" })),
    createCashRequest: jest.fn(async () => ({ id: "pr1", status: "PENDING" })),
    cancelOwn: jest.fn(async () => ({ id: "pr1", status: "CANCELLED" })),
  };
  const prisma = {
    tenant: {
      findUnique: jest.fn(async () => ({ id: "t-acme", slug: "acme", status: sellerStatus })),
    },
    customerLink: {
      findFirst: jest.fn(async () => ({
        customerId: "c-a",
        customer: { id: "c-a", userId: "u-a", businessName: "Sample", email: "c-a@example.test" },
      })),
    },
  };
  const moduleRef = await Test.createTestingModule({
    imports: [PassportModule],
    controllers: [BuyerPaymentsController, BuyerController],
    providers: [
      BuyerJwtStrategy,
      {
        provide: ConfigService,
        useValue: { get: (key: string) => (key === "jwt" ? { secret: SECRET } : undefined) },
      },
      { provide: TenantContextService, useValue: new TenantContextService() },
      { provide: PrismaService, useValue: prisma },
      { provide: PaymentRequestsService, useValue: payments },
    ],
  })
    // BuyerController has ~19 collaborators; a refused write never reaches any of them.
    .useMocker(() => ({}))
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix("api/v1");
  await listenOnLoopback(app);
});

afterEach(async () => {
  await app.close();
});

const post = (path: string, body: object = {}) =>
  request(app.getHttpServer())
    .post(`/api/v1${path}`)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Tenant-Slug", "acme")
    .send(body);

describe("a READ_ONLY seller still takes the buyer's own payments (real /api/v1 path)", () => {
  it("POST /api/v1/buyer/payments/card passes the guard and reaches the handler", async () => {
    const res = await post("/buyer/payments/card", { amount: 25 });
    expect(res.status).toBeLessThan(300);
    expect(payments.createCardRequest).toHaveBeenCalledTimes(1);
  });

  it("POST /api/v1/buyer/payments/cash passes the guard (a pending declaration)", async () => {
    const res = await post("/buyer/payments/cash", { amount: 25 });
    expect(res.status).toBeLessThan(300);
    expect(payments.createCashRequest).toHaveBeenCalledTimes(1);
  });

  it("POST /api/v1/buyer/payments/requests/:id/cancel passes the guard (cancel own)", async () => {
    const res = await post("/buyer/payments/requests/pr1/cancel");
    expect(res.status).toBeLessThan(300);
    expect(payments.cancelOwn).toHaveBeenCalledTimes(1);
  });
});

describe("a READ_ONLY seller refuses everything else a buyer writes", () => {
  it("POST /api/v1/buyer/orders -> 403 SELLER_UNAVAILABLE, with no billing wording", async () => {
    const res = await post("/buyer/orders", { items: [] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SELLER_UNAVAILABLE");
    expect(JSON.stringify(res.body)).not.toMatch(/payment|billing|subscri|overdue|plan/i);
  });

  it("another real buyer write (a standing-order reorder) is refused, and no payment handler ran", async () => {
    const res = await post("/buyer/templates/t1/reorder");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SELLER_UNAVAILABLE");
    expect(payments.createCardRequest).not.toHaveBeenCalled();
  });

  it("an order edit (PATCH) is refused", async () => {
    const res = await request(app.getHttpServer())
      .patch("/api/v1/buyer/orders/o1/items")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Tenant-Slug", "acme")
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SELLER_UNAVAILABLE");
  });
});

describe("an ACTIVE seller is unaffected", () => {
  it("card payments work exactly as before", async () => {
    sellerStatus = "ACTIVE";
    const res = await post("/buyer/payments/card", { amount: 25 });
    expect(res.status).toBeLessThan(300);
    expect(payments.createCardRequest).toHaveBeenCalledTimes(1);
  });
});
