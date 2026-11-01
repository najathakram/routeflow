/**
 * SA-1078 W-1096 PR-6 (BP2, BP3): the buyer's open-balance statement and its print route.
 *
 * Over HTTP through the real chain: the buyer-jwt strategy (a real signed token), BuyerJwtAuthGuard,
 * BuyerSellerContextGuard (the link check) and BuyerTenantInterceptor. Prisma is an in-memory stand-in for the
 * two reads the guard makes; the statement services are jest fns so the spec can see exactly who they were asked for.
 *   BP2  the print route answers { url } for the buyer's own customer; the read carries no staff fields
 *   BP3  a buyer of seller A asking as seller B is refused by the seller guard, and nothing is rendered or read
 *
 * Fixtures are placeholders (acme / globex); no live-client data.
 */
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
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
import { FeatureConfigService } from "../billing/feature-config.service";
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
import { listenOnLoopback } from "../common/testing/listen-loopback";

const SECRET = "account-statement-authz-spec-secret";
const jwt = new JwtService({ secret: SECRET });

const SIGNED = "https://files.example.test/statement-pdfs/c-mine/current.pdf?sig=abc";
const STATEMENT = { openBalance: 1000, customer: { id: "c-mine", businessName: "Sample" } };

const tenants = [
  { id: "t-1", slug: "acme", status: "ACTIVE" },
  { id: "t-2", slug: "globex", status: "ACTIVE" },
];
// buyer-mine is linked to acme only; buyer-globex is linked to globex only
const links = [
  { buyerAccountId: "buyer-mine", customerId: "c-mine", tenantId: "t-1", status: "ACTIVE" },
  { buyerAccountId: "buyer-globex", customerId: "c-globex", tenantId: "t-2", status: "ACTIVE" },
];

let app: INestApplication;
const getAccountStatement = jest.fn();
const generateCurrent = jest.fn();

beforeEach(async () => {
  getAccountStatement.mockReset().mockResolvedValue(STATEMENT);
  generateCurrent.mockReset().mockResolvedValue(SIGNED);
  const prisma = {
    tenant: {
      findUnique: jest.fn(
        async (args: { where: { slug: string } }) =>
          tenants.find((t) => t.slug === args.where.slug) ?? null,
      ),
    },
    customerLink: {
      findFirst: jest.fn(async (args: { where: Record<string, any> }) => {
        const link = links.find(
          (l) =>
            l.buyerAccountId === args.where.buyerAccountId &&
            l.tenantId === args.where.tenantId &&
            l.status === args.where.status,
        );
        return link
          ? { ...link, customer: { id: link.customerId, userId: "u-1", businessName: "Sample" } }
          : null;
      }),
    },
  } as unknown as PrismaService;

  const stub = (token: InjectionToken) => ({ provide: token, useValue: {} });
  const moduleRef = await Test.createTestingModule({
    imports: [PassportModule],
    controllers: [BuyerController],
    providers: [
      oversellReaderOffProvider,
      BuyerJwtStrategy,
      {
        provide: ConfigService,
        useValue: { get: (key: string) => (key === "jwt" ? { secret: SECRET } : undefined) },
      },
      { provide: TenantContextService, useValue: new TenantContextService() },
      { provide: PrismaService, useValue: prisma },
      { provide: CustomersService, useValue: { getAccountStatement } },
      { provide: StatementPdfService, useValue: { generateCurrent } },
      { provide: FeatureConfigService, useValue: { getEffectiveMode: async () => "on" } },
      ...[
        BuyerService,
        BuyerCatalogService,
        BuyerDashboardService,
        ReplenishmentService,
        ShelfService,
        StockAlertService,
        PromotionsService,
        OrdersService,
        ChangeRequestsService,
        InvoicesService,
        InvoicePdfService,
        StatementService,
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

const token = (sub: string) =>
  jwt.sign({ sub, email: `${sub}@example.test`, name: sub, type: "BUYER" });

function get(path: string, slug: string | null, bearer: string | null = token("buyer-mine")) {
  const req = request(app.getHttpServer()).get(path);
  if (bearer) req.set("Authorization", `Bearer ${bearer}`);
  if (slug) req.set("X-Tenant-Slug", slug);
  return req;
}

const ROUTES = ["/buyer/account-statement", "/buyer/account-statement/pdf"] as const;

describe("BP2: the buyer's statement and its print route", () => {
  it("the read is the customer-shaped one: staff: false, for the buyer's own customer", async () => {
    const res = await get("/buyer/account-statement", "acme").expect(200);
    expect(res.body).toEqual(STATEMENT);
    expect(getAccountStatement).toHaveBeenCalledWith("c-mine", { staff: false });
  });

  it("the print route answers { url } rendered for the buyer's own customer, taking no id from the caller", async () => {
    const res = await get("/buyer/account-statement/pdf", "acme").expect(200);
    expect(res.body).toEqual({ url: SIGNED });
    expect(generateCurrent).toHaveBeenCalledTimes(1);
    expect(generateCurrent).toHaveBeenCalledWith("c-mine");
  });

  it("a customer id on the query string is ignored", async () => {
    await get("/buyer/account-statement/pdf?customerId=c-globex", "acme").expect(200);
    expect(generateCurrent).toHaveBeenCalledWith("c-mine");
  });
});

describe.each(ROUTES)("BP3: %s", (path) => {
  it("a buyer of seller A asking as seller B: 403, and nothing is read or rendered", async () => {
    await get(path, "globex").expect(403);
    expect(getAccountStatement).not.toHaveBeenCalled();
    expect(generateCurrent).not.toHaveBeenCalled();
  });

  it("the other seller's buyer asking as seller A: 403", async () => {
    await get(path, "acme", token("buyer-globex")).expect(403);
    expect(getAccountStatement).not.toHaveBeenCalled();
    expect(generateCurrent).not.toHaveBeenCalled();
  });

  it("no seller header: refused, nothing read or rendered", async () => {
    const res = await get(path, null);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(getAccountStatement).not.toHaveBeenCalled();
    expect(generateCurrent).not.toHaveBeenCalled();
  });

  it("no buyer token: 401", async () => {
    await get(path, "acme", null).expect(401);
    expect(getAccountStatement).not.toHaveBeenCalled();
    expect(generateCurrent).not.toHaveBeenCalled();
  });
});
