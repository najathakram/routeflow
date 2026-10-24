/**
 * F1-INFRA-500S: Regression tests for buyer portal 500 errors.
 *
 * Verifies that GET /buyer/orders, GET /buyer/invoices, and
 * GET /buyer/standing-orders do NOT perform a userId-based customer lookup
 * (which would 500 when customerId is known but userId is null on the Customer
 * record for buyer-portal-only accounts).
 *
 * Root cause: RF-197 added Customer.deletedAt to the schema without a migration,
 * causing Prisma to fail on every Customer query in the Railway DB.  The
 * secondary fix here ensures the controller routes bypass the userId lookup
 * entirely by passing customerId directly + OPERATOR role.
 */
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { Test, TestingModule } from "@nestjs/testing";
import { BuyerController } from "./buyer.controller";
import { BuyerService } from "./buyer.service";
import { BuyerCatalogService } from "./buyer-catalog.service";
import { BuyerDashboardService } from "./buyer-dashboard.service";
import { ReplenishmentService } from "./replenishment.service";
import { ShelfService } from "./shelf.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { PromotionsService } from "../promotions/promotions.service";
import { OrdersService } from "../orders/orders.service";
import { ChangeRequestsService } from "../orders/change-requests.service";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { StatementService } from "./statement.service";
import { StatementPdfService } from "./statement-pdf.service";
import { CustomersService } from "../customers/customers.service";
import { OrderTemplatesService } from "../order-templates/order-templates.service";
import { AuthorizationsService } from "../authorizations/authorizations.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { UserRole } from "@prisma/client";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";

const MOCK_CTX = {
  customerId: "cust-abc",
  tenantId: "tenant-xyz",
  tenantSlug: "acme",
  userId: null, // buyer-portal-only account — no operator-portal user
  customer: { id: "cust-abc", businessName: "Test Buyer" },
};

describe("BuyerController — buyer portal 500 fixes (F1-INFRA-500S)", () => {
  let controller: BuyerController;
  let ordersService: { findAll: jest.Mock; findActiveOrder: jest.Mock };
  let shelfService: {
    shelf: jest.Mock;
    lowItems: jest.Mock;
    snooze: jest.Mock;
    unsnooze: jest.Mock;
  };
  let invoicesService: jest.Mocked<Pick<InvoicesService, "findAll">>;
  let templatesService: jest.Mocked<
    Pick<OrderTemplatesService, "findAllForBuyer" | "generateOrder">
  >;
  let authorizationsService: jest.Mocked<Pick<AuthorizationsService, "listForBuyer" | "submit">>;
  let stockAlertService: {
    subscribe: jest.Mock;
    unsubscribe: jest.Mock;
    subscriptionsFor: jest.Mock;
    isSubscribed: jest.Mock;
  };
  let prisma: ReturnType<typeof createMockPrisma>;
  let systemConfigService: { getRemittanceConfig: jest.Mock };
  let customersService: { getStatementForOperator: jest.Mock };

  beforeEach(async () => {
    ordersService = {
      findAll: jest.fn().mockResolvedValue({ data: [], meta: { total: 0 } }),
      findActiveOrder: jest.fn().mockResolvedValue(null),
    };
    shelfService = {
      shelf: jest.fn().mockResolvedValue([]),
      lowItems: jest.fn().mockResolvedValue([]),
      snooze: jest.fn().mockResolvedValue({ snoozedUntil: "2026-08-01T00:00:00.000Z" }),
      unsnooze: jest.fn().mockResolvedValue({ ok: true }),
    };
    invoicesService = { findAll: jest.fn().mockResolvedValue({ data: [], meta: { total: 0 } }) };
    templatesService = {
      findAllForBuyer: jest.fn().mockResolvedValue({ data: [], meta: { total: 0 } }),
      generateOrder: jest.fn().mockResolvedValue({ id: "o1" }),
    };
    authorizationsService = {
      listForBuyer: jest.fn().mockResolvedValue([]),
      submit: jest.fn().mockResolvedValue({ id: "auth-1", status: "PENDING_REVIEW" }),
    };
    stockAlertService = {
      subscribe: jest.fn().mockResolvedValue({ subscribed: true }),
      unsubscribe: jest.fn().mockResolvedValue({ subscribed: false }),
      subscriptionsFor: jest.fn().mockResolvedValue({ productIds: [] }),
      isSubscribed: jest.fn().mockResolvedValue(false),
    };
    prisma = createMockPrisma();
    systemConfigService = {
      getRemittanceConfig: jest.fn().mockResolvedValue({ payToName: "Acme Wholesale" }),
    };
    customersService = {
      getStatementForOperator: jest.fn().mockResolvedValue({ outstandingAmount: 0 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BuyerController],
      providers: [
        oversellReaderOffProvider,
        { provide: BuyerService, useValue: {} },
        { provide: BuyerCatalogService, useValue: {} },
        { provide: BuyerDashboardService, useValue: {} },
        { provide: ReplenishmentService, useValue: {} },
        { provide: ShelfService, useValue: shelfService },
        { provide: StockAlertService, useValue: stockAlertService },
        { provide: PromotionsService, useValue: {} },
        { provide: OrdersService, useValue: ordersService },
        { provide: ChangeRequestsService, useValue: {} },
        { provide: InvoicesService, useValue: invoicesService },
        { provide: InvoicePdfService, useValue: {} },
        { provide: StatementService, useValue: {} },
        { provide: StatementPdfService, useValue: {} },
        { provide: CustomersService, useValue: customersService },
        { provide: OrderTemplatesService, useValue: templatesService },
        { provide: AuthorizationsService, useValue: authorizationsService },
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: systemConfigService },
        {
          provide: TenantContextService,
          useValue: { run: jest.fn((id, fn) => fn()), getOrNull: jest.fn().mockReturnValue(null) },
        },
      ],
    }).compile();

    controller = module.get<BuyerController>(BuyerController);
  });

  it("getOrders: passes customerId directly — no userId lookup", async () => {
    await controller.getOrders(MOCK_CTX as any, {} as any);

    expect(ordersService.findAll).toHaveBeenCalledTimes(1);
    const [query, user] = (ordersService.findAll as jest.Mock).mock.calls[0];

    // customerId injected from ctx, not from a DB lookup
    expect(query.customerId).toBe("cust-abc");
    // OPERATOR role so service takes the customerId branch, not the userId-lookup branch
    expect(user.role).toBe(UserRole.OPERATOR);
    // userId on pseudoUser is irrelevant (null buyer account), but must not throw
    expect(user.sub).toBeDefined();
  });

  it("getInvoices: passes customerId directly, excludes DRAFT, no userId lookup", async () => {
    await controller.getInvoices(MOCK_CTX as any, {} as any);

    expect(invoicesService.findAll).toHaveBeenCalledTimes(1);
    const [query, user] = (invoicesService.findAll as jest.Mock).mock.calls[0];

    expect(query.customerId).toBe("cust-abc");
    expect(user.role).toBe(UserRole.OPERATOR);
    // DRAFT must not be in statuses (buyer must not see draft invoices)
    if (query.statuses) {
      expect(query.statuses).not.toContain("DRAFT");
    }
  });

  // D6 / B462: the buyer portal reuses getStatementForOperator. It must NOT ask for the
  // operator-only exposure figures — a buyer is never shown the seller's unissued-draft
  // totals. The call carries the customerId ONLY (no options argument at all).
  it("getStatement: asks for the customer's statement WITHOUT the operator-only exposure flag", async () => {
    await controller.getStatement(MOCK_CTX as any);

    expect(customersService.getStatementForOperator).toHaveBeenCalledTimes(1);
    const args = customersService.getStatementForOperator.mock.calls[0];
    expect(args).toEqual(["cust-abc"]);
    expect(args).toHaveLength(1);
  });

  it("getStandingOrders: the buyer-filtered list, by customerId — no userId lookup (row 479)", async () => {
    await controller.getStandingOrders(MOCK_CTX as any);

    expect(templatesService.findAllForBuyer).toHaveBeenCalledTimes(1);
    expect(templatesService.findAllForBuyer).toHaveBeenCalledWith("cust-abc");
  });

  it("getTemplates: the buyer-filtered list, by customerId — no userId lookup (row 479)", async () => {
    await controller.getTemplates(MOCK_CTX as any);

    expect(templatesService.findAllForBuyer).toHaveBeenCalledTimes(1);
    expect(templatesService.findAllForBuyer).toHaveBeenCalledWith("cust-abc");
  });

  // RF-094 / RF-180: GET /buyer/standing-orders returns 200 (empty array OK)
  it("getStandingOrders: returns data without 500 when customerId is set", async () => {
    const result = await controller.getStandingOrders(MOCK_CTX as any);
    // templatesService.findAllForBuyer resolves to { data: [], meta: { total: 0 } }
    expect(result).toBeDefined();
    expect(templatesService.findAllForBuyer).toHaveBeenCalledTimes(1);
  });

  // #1208 review LOW-MED: this buyer-portal path bypasses generateOrderForUser entirely
  // (there is no JwtPayload here), so it must pass isStaffRole itself — a hardcoded/
  // defaulted true would let a buyer's "Reorder" silently oversell where their own
  // checkout (orders.service.ts create()) returns 409 INSUFFICIENT_STOCK.
  describe("reorderFromTemplate (POST /buyer/templates/:id/reorder)", () => {
    it("generates with isStaffRole=false — the buyer's own hard-block posture, never staff oversell", async () => {
      prisma.orderTemplate.findFirst.mockResolvedValue({ customerId: "cust-abc" });

      const result = await controller.reorderFromTemplate("tpl-1", MOCK_CTX as any);

      expect(templatesService.generateOrder).toHaveBeenCalledTimes(1);
      // (id, isStaffRole, allowOversell: policy off, the out-param a restriction-trimmed Reorder fills)
      expect(templatesService.generateOrder).toHaveBeenCalledWith("tpl-1", false, false, {
        skipped: [],
      });
      expect(result).toEqual({ id: "o1", skipped: [] }); // nothing was left out
    });

    it("refuses a template belonging to another customer — never calls generateOrder", async () => {
      prisma.orderTemplate.findFirst.mockResolvedValue({ customerId: "someone-elses-customer" });

      await expect(controller.reorderFromTemplate("tpl-1", MOCK_CTX as any)).rejects.toThrow(
        "This template does not belong to your account",
      );
      expect(templatesService.generateOrder).not.toHaveBeenCalled();
    });

    it("404s a nonexistent template — never calls generateOrder", async () => {
      prisma.orderTemplate.findFirst.mockResolvedValue(null);

      await expect(
        controller.reorderFromTemplate("no-such-template", MOCK_CTX as any),
      ).rejects.toThrow("Template not found");
      expect(templatesService.generateOrder).not.toHaveBeenCalled();
    });
  });

  // RF-217: GET /buyer/me returns 200 — it is a direct passthrough of ctx.customer
  it("getMe: returns customer profile directly from context (no extra DB call)", () => {
    const result = controller.getMe(MOCK_CTX as any);
    expect(result).toEqual(MOCK_CTX.customer);
  });

  // W6b: buyer license endpoints resolve customerId from context, not the client.
  it("listAuthorizations: delegates to the service with the context customerId", () => {
    controller.listAuthorizations(MOCK_CTX as any);
    expect(authorizationsService.listForBuyer).toHaveBeenCalledWith("cust-abc");
  });

  it("submitAuthorization: delegates to the service with the context customerId + dto", () => {
    const dto = {
      trackedCategoryId: "cat-1",
      licenseNumber: "LIC-1",
      expiresAt: "2027-01-01T00:00:00Z",
      shareConsent: true,
    };
    controller.submitAuthorization(MOCK_CTX as any, dto as any);
    expect(authorizationsService.submit).toHaveBeenCalledWith("cust-abc", dto);
  });

  // ─── Your Shelf (P5-06/07) ───────────────────────────────────────────────────

  it("getShelf: returns snooze-overlaid estimates + active-order summary (stored total only)", async () => {
    shelfService.shelf.mockResolvedValue([{ productId: "A", state: "low", snoozed: true }]);
    ordersService.findActiveOrder.mockResolvedValue({
      id: "o1",
      orderNumber: "SO-1001",
      total: "45.50",
      lineItems: [{}, {}],
    });

    const res = await controller.getShelf(MOCK_CTX as any);

    expect(shelfService.shelf).toHaveBeenCalledWith("cust-abc");
    expect(res.estimates[0]).toMatchObject({ productId: "A", snoozed: true });
    expect(res.activeOrder).toEqual({
      id: "o1",
      orderNumber: "SO-1001",
      itemCount: 2,
      total: 45.5,
    });
  });

  it("getShelf: no active order → activeOrder null", async () => {
    ordersService.findActiveOrder.mockResolvedValue(null);
    const res = await controller.getShelf(MOCK_CTX as any);
    expect(res.activeOrder).toBeNull();
  });

  it("addAllLow: delegates the low && !snoozed items to the createOrder merge path", async () => {
    shelfService.lowItems.mockResolvedValue([
      { productId: "A", qty: 6 },
      { productId: "B", qty: 24 },
    ]);
    const createSpy = jest.spyOn(controller, "createOrder").mockResolvedValue({ id: "o1" } as any);

    const result = await controller.addAllLow(MOCK_CTX as any);

    expect(shelfService.lowItems).toHaveBeenCalledWith("cust-abc");
    expect(createSpy).toHaveBeenCalledWith(
      {
        items: [
          { productId: "A", qty: 6 },
          { productId: "B", qty: 24 },
        ],
      },
      MOCK_CTX,
    );
    expect(result).toEqual({ id: "o1" });
  });

  it("addAllLow: empty low list → no-op returning the active order, no create", async () => {
    shelfService.lowItems.mockResolvedValue([]);
    ordersService.findActiveOrder.mockResolvedValue({ id: "o9", lineItems: [] });
    const createSpy = jest.spyOn(controller, "createOrder");

    const result = await controller.addAllLow(MOCK_CTX as any);

    expect(createSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: "o9" });
  });

  it("snooze/unsnooze: delegate with ctx.customerId (+ tenantId on snooze)", async () => {
    await controller.snoozeReplenishment("prod-1", MOCK_CTX as any);
    expect(shelfService.snooze).toHaveBeenCalledWith("cust-abc", "prod-1", "tenant-xyz");

    await controller.unsnoozeReplenishment("prod-1", MOCK_CTX as any);
    expect(shelfService.unsnooze).toHaveBeenCalledWith("cust-abc", "prod-1");
  });

  // ─── Stock alerts / Notify-me (P5-03) ───────────────────────────────────────

  it("subscribeStockAlert: delegates with context customerId + tenantId", () => {
    controller.subscribeStockAlert("prod-9", MOCK_CTX as any);
    expect(stockAlertService.subscribe).toHaveBeenCalledWith("cust-abc", "prod-9", "tenant-xyz");
  });

  it("unsubscribeStockAlert: delegates with context customerId", () => {
    controller.unsubscribeStockAlert("prod-9", MOCK_CTX as any);
    expect(stockAlertService.unsubscribe).toHaveBeenCalledWith("cust-abc", "prod-9");
  });

  // ─── Payments & remittance (P5-14) ──────────────────────────────────────────

  it("getPayments: scopes to ctx.customerId via the invoice relation and maps check-lifecycle fields", async () => {
    (prisma.invoicePayment.findMany as jest.Mock).mockResolvedValue([
      {
        id: "pay-1",
        invoiceId: "inv-1",
        invoice: { invoiceNumber: "INV-1001" },
        amount: "125.50",
        method: "CHECK",
        status: "PAID",
        checkStatus: "BOUNCED",
        nsfFeeAmount: "25",
        paidAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ]);
    (prisma.invoicePayment.count as jest.Mock).mockResolvedValue(1);

    const result = await controller.getPayments(MOCK_CTX as any);

    expect(prisma.invoicePayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { invoice: { customerId: "cust-abc" } } }),
    );
    expect(result.data[0]).toEqual({
      id: "pay-1",
      invoiceId: "inv-1",
      invoiceNumber: "INV-1001",
      amount: 125.5,
      method: "CHECK",
      status: "PAID",
      checkStatus: "BOUNCED",
      nsfFeeAmount: 25,
      paidAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("getPayments: paginates — page 2 skips 20 and computes totalPages", async () => {
    (prisma.invoicePayment.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.invoicePayment.count as jest.Mock).mockResolvedValue(45);

    const result = await controller.getPayments(MOCK_CTX as any, "2", "20");

    expect(prisma.invoicePayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 20 }),
    );
    expect(result.meta).toEqual({ total: 45, page: 2, limit: 20, totalPages: 3 });
  });

  it("getPayments: defaults page/limit to 1/20 on garbage query params", async () => {
    (prisma.invoicePayment.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.invoicePayment.count as jest.Mock).mockResolvedValue(0);

    const result = await controller.getPayments(MOCK_CTX as any, "not-a-number", "-5");

    expect(prisma.invoicePayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 20 }),
    );
    expect(result.meta).toEqual({ total: 0, page: 1, limit: 20, totalPages: 1 });
  });

  it("getRemittance: delegates to SystemConfigService.getRemittanceConfig", async () => {
    const result = await controller.getRemittance();
    expect(systemConfigService.getRemittanceConfig).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ payToName: "Acme Wholesale" });
  });
});
