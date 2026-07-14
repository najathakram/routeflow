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
import { Test, TestingModule } from "@nestjs/testing";
import { BuyerController } from "./buyer.controller";
import { BuyerService } from "./buyer.service";
import { BuyerCatalogService } from "./buyer-catalog.service";
import { BuyerDashboardService } from "./buyer-dashboard.service";
import { ReplenishmentService } from "./replenishment.service";
import { ShelfService } from "./shelf.service";
import { PromotionsService } from "../promotions/promotions.service";
import { OrdersService } from "../orders/orders.service";
import { ChangeRequestsService } from "../orders/change-requests.service";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { CustomersService } from "../customers/customers.service";
import { OrderTemplatesService } from "../order-templates/order-templates.service";
import { AuthorizationsService } from "../authorizations/authorizations.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { UserRole } from "@prisma/client";

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
  let templatesService: jest.Mocked<Pick<OrderTemplatesService, "findAllForUser">>;
  let authorizationsService: jest.Mocked<Pick<AuthorizationsService, "listForBuyer" | "submit">>;

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
      findAllForUser: jest.fn().mockResolvedValue({ data: [], meta: { total: 0 } }),
    };
    authorizationsService = {
      listForBuyer: jest.fn().mockResolvedValue([]),
      submit: jest.fn().mockResolvedValue({ id: "auth-1", status: "PENDING_REVIEW" }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BuyerController],
      providers: [
        { provide: BuyerService, useValue: {} },
        { provide: BuyerCatalogService, useValue: {} },
        { provide: BuyerDashboardService, useValue: {} },
        { provide: ReplenishmentService, useValue: {} },
        { provide: ShelfService, useValue: shelfService },
        { provide: PromotionsService, useValue: {} },
        { provide: OrdersService, useValue: ordersService },
        { provide: ChangeRequestsService, useValue: {} },
        { provide: InvoicesService, useValue: invoicesService },
        { provide: InvoicePdfService, useValue: {} },
        { provide: CustomersService, useValue: {} },
        { provide: OrderTemplatesService, useValue: templatesService },
        { provide: AuthorizationsService, useValue: authorizationsService },
        { provide: PrismaService, useValue: {} },
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

  it("getStandingOrders: passes customerId directly — no userId lookup", async () => {
    await controller.getStandingOrders(MOCK_CTX as any);

    expect(templatesService.findAllForUser).toHaveBeenCalledTimes(1);
    const [user, customerId] = (templatesService.findAllForUser as jest.Mock).mock.calls[0];

    // OPERATOR role so findAllForUser takes the direct-customerId path
    expect(user.role).toBe(UserRole.OPERATOR);
    expect(customerId).toBe("cust-abc");
  });

  it("getTemplates: passes customerId directly — no userId lookup", async () => {
    await controller.getTemplates(MOCK_CTX as any);

    expect(templatesService.findAllForUser).toHaveBeenCalledTimes(1);
    const [user, customerId] = (templatesService.findAllForUser as jest.Mock).mock.calls[0];

    expect(user.role).toBe(UserRole.OPERATOR);
    expect(customerId).toBe("cust-abc");
  });

  // RF-094 / RF-180: GET /buyer/standing-orders returns 200 (empty array OK)
  it("getStandingOrders: returns data without 500 when customerId is set", async () => {
    const result = await controller.getStandingOrders(MOCK_CTX as any);
    // templatesService.findAllForUser resolves to { data: [], meta: { total: 0 } }
    expect(result).toBeDefined();
    expect(templatesService.findAllForUser).toHaveBeenCalledTimes(1);
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
});
