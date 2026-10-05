/**
 * Every buyer-portal read of an order or an invoice carries customer-facing fields only: no line
 * override reason/author, no order commission rate, no invoice internal notes, no payment notes,
 * no DRAFT invoice inside an order, and the invoice LIST shows confirmed (PAID) payments only.
 * The services below are stubbed to return the full staff-shaped row, so each assertion pins the
 * buyer boundary itself. Fixtures are placeholders (acme-style ids); no live-client data.
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

const CTX = {
  customerId: "c-mine",
  tenantId: "t-1",
  tenantSlug: "acme",
  userId: null,
  customer: { id: "c-mine", businessName: "Sample Buyer Co" },
};

const line = () => ({
  id: "li-1",
  productId: "p-1",
  qty: 1,
  unitPrice: 5,
  overrideReason: "staff-only reason",
  overriddenBy: "user-op",
});

const orderRow = () => ({
  id: "ord-1",
  customerId: "c-mine",
  status: "PENDING",
  commissionRatePct: 7.5,
  lineItems: [line()],
  invoices: [
    { id: "inv-draft", status: "DRAFT", payments: [] },
    { id: "inv-sent", status: "SENT", payments: [] },
  ],
});

const invoiceRow = () => ({
  id: "inv-1",
  customerId: "c-mine",
  status: "SENT",
  viewedAt: new Date(),
  pdfUrl: null,
  internalNotes: "staff-only memo",
  items: [line()],
  payments: [
    { id: "p-paid", status: "PAID", amount: 3, notes: "staff-only payment memo" },
    { id: "p-draft", status: "DRAFT", amount: 4, notes: "unconfirmed" },
    { id: "p-void", status: "VOID", amount: 6, notes: "bounced" },
  ],
});

async function boot() {
  const ordersService = {
    findAll: jest.fn().mockResolvedValue({ data: [orderRow()], meta: { total: 1 } }),
    findOne: jest.fn().mockResolvedValue(orderRow()),
    findActiveOrder: jest.fn().mockResolvedValue(orderRow()),
    create: jest.fn().mockResolvedValue(orderRow()),
    mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
    updateOrderItems: jest.fn().mockResolvedValue(orderRow()),
  };
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
      { provide: ShelfService, useValue: { lowItems: jest.fn().mockResolvedValue([]) } },
      { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
      {
        provide: PrismaService,
        useValue: { forTenant: () => ({ invoice: { update: jest.fn() } }) },
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
        OrderTemplatesService,
        AuthorizationsService,
        SystemConfigService,
        TenantContextService,
      ].map(stub),
    ],
  }).compile();
  return { controller: moduleRef.get(BuyerController), ordersService, invoicesService };
}

type Row = Record<string, unknown> & {
  lineItems?: Array<Record<string, unknown>>;
  items?: Array<Record<string, unknown>>;
  invoices?: Array<{ id: string }>;
  payments?: Array<Record<string, unknown>>;
};

function expectCustomerFacingOrder(order: Row) {
  expect(order).not.toHaveProperty("commissionRatePct");
  for (const li of order.lineItems ?? []) {
    expect(li).not.toHaveProperty("overrideReason");
    expect(li).not.toHaveProperty("overriddenBy");
  }
  expect((order.invoices ?? []).map((i) => i.id)).toEqual(["inv-sent"]);
  expect(order.lineItems).toHaveLength(1);
}

function expectCustomerFacingInvoice(inv: Row) {
  expect(inv).not.toHaveProperty("internalNotes");
  for (const li of inv.items ?? []) {
    expect(li).not.toHaveProperty("overrideReason");
    expect(li).not.toHaveProperty("overriddenBy");
  }
  for (const p of inv.payments ?? []) expect(p).not.toHaveProperty("notes");
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
    expect(row.payments).toEqual([{ id: "p-paid", status: "PAID", amount: 3 }]);
  });

  it("GET /buyer/invoices/:id: no internal notes, line override fields or payment notes", async () => {
    const { controller } = await boot();
    const out = (await controller.getInvoice("inv-1", CTX)) as unknown as Row;
    expectCustomerFacingInvoice(out);
    expect(out.id).toBe("inv-1");
  });
});
