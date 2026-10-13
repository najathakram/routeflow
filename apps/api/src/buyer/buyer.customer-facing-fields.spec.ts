/**
 * Every buyer-portal read or write of an order or an invoice carries an ALLOWLIST of customer-facing
 * fields (common/staff-only-fields.ts): none of the staff-internal columns (idempotency key, merge
 * flag, run / template links, commission rate, write-off reason, payment image key / bank charges /
 * bounce reason ...) nor any column added later, no DRAFT invoice inside an order, and the invoice
 * LIST shows confirmed (PAID) payments only. The services below are stubbed to return the full
 * staff-shaped row (common/testing/customer-leak-fixtures.ts), so each assertion pins the buyer
 * boundary itself. Fixtures are placeholders (acme-style ids); no live-client data.
 */
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { InjectionToken } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { BuyerController } from "./buyer.controller";
import { BuyerService } from "./buyer.service";
import { BuyerCatalogService } from "./buyer-catalog.service";
import { BuyerDashboardService } from "./buyer-dashboard.service";
import { ReplenishmentService } from "./replenishment.service";
import { ShelfService } from "./shelf.service";
import { StatementService } from "./statement.service";
import { StatementPdfService } from "./statement-pdf.service";
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
import {
  expectNoStaffLeaks,
  leakyInvoice,
  leakyOrder,
} from "../common/testing/customer-leak-fixtures";

const CTX = {
  customerId: "c-mine",
  tenantId: "t-1",
  tenantSlug: "acme",
  userId: null,
  customer: { id: "c-mine", businessName: "Sample Buyer Co" },
};

const orderRow = leakyOrder;
const invoiceRow = () => ({
  ...leakyInvoice(),
  customerId: "c-mine",
  viewedAt: new Date(),
  pdfUrl: null,
});

async function boot() {
  const ordersService = {
    findAll: jest.fn().mockResolvedValue({ data: [orderRow()], meta: { total: 1 } }),
    findOne: jest.fn().mockResolvedValue(orderRow()),
    findActiveOrder: jest.fn().mockResolvedValue(orderRow()),
    create: jest.fn().mockResolvedValue(orderRow()),
    mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
    liveTrioByProduct: jest.fn().mockResolvedValue(new Map()),
    updateOrderItems: jest.fn().mockResolvedValue(orderRow()),
  };
  const templatesService = { generateOrder: jest.fn().mockResolvedValue(orderRow()) };
  const invoicesService = {
    findAll: jest.fn().mockResolvedValue({ data: [invoiceRow()], meta: { total: 1 } }),
    findOne: jest.fn().mockResolvedValue(invoiceRow()),
  };
  const stub = (token: InjectionToken) => ({ provide: token, useValue: {} });
  const moduleRef = await Test.createTestingModule({
    controllers: [BuyerController],
    providers: [
      oversellReaderOffProvider,
      { provide: OrdersService, useValue: ordersService },
      { provide: InvoicesService, useValue: invoicesService },
      { provide: OrderTemplatesService, useValue: templatesService },
      { provide: ShelfService, useValue: { lowItems: jest.fn().mockResolvedValue([]) } },
      { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
      {
        provide: PrismaService,
        useValue: {
          forTenant: () => ({
            invoice: { update: jest.fn() },
            orderTemplate: { findFirst: jest.fn().mockResolvedValue({ customerId: "c-mine" }) },
          }),
        },
      },
      ...[
        BuyerService,
        BuyerCatalogService,
        BuyerDashboardService,
        ReplenishmentService,
        StockAlertService,
        PromotionsService,
        ChangeRequestsService,
        StatementService,
        StatementPdfService,
        CustomersService,
        AuthorizationsService,
        SystemConfigService,
        TenantContextService,
      ].map(stub),
    ],
  }).compile();
  return {
    controller: moduleRef.get(BuyerController),
    ordersService,
    invoicesService,
    templatesService,
  };
}

type Row = Record<string, unknown> & {
  lineItems?: Array<Record<string, unknown>>;
  items?: Array<Record<string, unknown>>;
  invoices?: Array<{ id: string }>;
  payments?: Array<Record<string, unknown>>;
};

function expectCustomerFacingOrder(order: Row) {
  expectNoStaffLeaks(order);
  expect((order.invoices ?? []).map((i) => i.id)).toEqual(["inv-sent"]);
  expect(order.lineItems).toHaveLength(1);
  // What the buyer screens read survives the allowlist.
  expect(order).toMatchObject({ id: "ord-1", orderNumber: "ORD-1", status: "PENDING", total: 10 });
  expect(order.lineItems?.[0]).toMatchObject({ id: "li-1", qty: 2, unitPrice: 5, subtotal: 10 });
  expect(order.lineItems?.[0].product).toEqual({ id: "p-1", name: "Widget", unit: "ea" });
}

function expectCustomerFacingInvoice(inv: Row) {
  expectNoStaffLeaks(inv);
  expect(inv).toMatchObject({ id: "inv-1", invoiceNumber: "INV-1", total: 20 });
  expect(inv.items?.[0]).toMatchObject({ id: "li-1", description: "Widget", unitPrice: 5 });
}

describe("buyer order reads — customer-facing fields only", () => {
  it("GET /buyer/orders", async () => {
    const { controller } = await boot();
    const out = await controller.getOrders(CTX, {} as never);
    expectCustomerFacingOrder(out.data[0] as unknown as Row);
  });

  it("GET /buyer/orders/active", async () => {
    const { controller } = await boot();
    expectCustomerFacingOrder((await controller.getActiveOrder(CTX)) as unknown as Row);
  });

  it("GET /buyer/orders/:id", async () => {
    const { controller } = await boot();
    expectCustomerFacingOrder((await controller.getOrder("ord-1", CTX)) as unknown as Row);
  });

  it("POST /buyer/orders (new order)", async () => {
    const { controller } = await boot();
    const out = await controller.createOrder(
      { items: [{ productId: "p-1", qty: 1 }], forceNew: true } as never,
      CTX,
    );
    expectCustomerFacingOrder(out as unknown as Row);
  });

  it("PATCH /buyer/orders/:id/items", async () => {
    const { controller } = await boot();
    const out = await controller.updateOrderItems("ord-1", { items: [] } as never, CTX);
    expectCustomerFacingOrder(out as unknown as Row);
  });

  it("POST /buyer/templates/:id/reorder (the order the template generated)", async () => {
    const { controller, templatesService } = await boot();
    const out = await controller.reorderFromTemplate("tpl-1", CTX);
    expect(templatesService.generateOrder).toHaveBeenCalledTimes(1);
    expectCustomerFacingOrder(out as unknown as Row);
  });

  it("POST /buyer/templates/:id/reorder: a template that generates nothing answers null", async () => {
    const { controller, templatesService } = await boot();
    templatesService.generateOrder.mockResolvedValue(null);
    expect(await controller.reorderFromTemplate("tpl-1", CTX)).toBeNull();
  });

  it("buyer create + edit-items redact an upsell line's base price BEFORE the allowlist", async () => {
    const { controller, ordersService } = await boot();
    const upsold = () => ({
      ...orderRow(),
      lineItems: [
        {
          ...orderRow().lineItems[0],
          priceType: "MANUAL",
          unitPrice: 8,
          originalPrice: 5,
          product: { id: "p-1", name: "Widget", unit: "ea", pricePerUnit: 5 },
        },
      ],
    });
    ordersService.create.mockResolvedValue(upsold());
    ordersService.updateOrderItems.mockResolvedValue(upsold());
    const created = (await controller.createOrder(
      { items: [{ productId: "p-1", qty: 1 }], forceNew: true } as never,
      CTX,
    )) as unknown as Row;
    const edited = (await controller.updateOrderItems(
      "ord-1",
      { items: [] } as never,
      CTX,
    )) as unknown as Row;
    for (const out of [created, edited]) {
      expect(out.lineItems?.[0]).toMatchObject({
        unitPrice: 8,
        originalPrice: null,
        priceType: "STANDARD",
      });
    }
  });

  it("POST /buyer/shelf/add-all-low (nothing low: the active order)", async () => {
    const { controller } = await boot();
    expectCustomerFacingOrder((await controller.addAllLow(CTX)) as unknown as Row);
  });
});

describe("buyer invoice reads — customer-facing fields only", () => {
  it("GET /buyer/invoices: no internal/payment notes, confirmed (PAID) payments only", async () => {
    const { controller } = await boot();
    const out = await controller.getInvoices(CTX, {} as never);
    const row = out.data[0] as unknown as Row;
    expectCustomerFacingInvoice(row);
    expect(row.payments?.map((p) => p.id)).toEqual(["p-paid"]);
  });

  it("GET /buyer/invoices/:id: no internal notes, line override fields or payment notes", async () => {
    const { controller } = await boot();
    const out = (await controller.getInvoice("inv-1", CTX)) as unknown as Row;
    expectCustomerFacingInvoice(out);
    expect(out.id).toBe("inv-1");
  });
});
