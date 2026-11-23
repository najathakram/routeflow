/**
 * SA-1228 D5: GET /buyer/invoices/:id returns the account rows the detail read built (the business's
 * showAccountBalance switch), as given. The wrong buyer still gets today's 403 with nothing of the rows in it.
 *
 * Fixtures are placeholders (acme-style ids); no live-client data.
 */
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { ForbiddenException, InjectionToken, NotFoundException } from "@nestjs/common";
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

const CTX = {
  customerId: "c-mine",
  tenantId: "t-1",
  tenantSlug: "acme",
  userId: null,
  customer: { id: "c-mine", businessName: "Sample Buyer Co" },
};

const ROWS = [
  { kind: "heading", label: "Customer account", amount: null },
  { kind: "others", label: "Other unpaid invoices", amount: 30 },
  { kind: "thisInvoice", label: "This invoice", amount: 150 },
  { kind: "openBalance", label: "Open balance", amount: 180 },
];

function invoice(status: string, customerId = "c-mine") {
  return {
    id: `inv-${status.toLowerCase()}`,
    invoiceNumber: `INV-${status}`,
    customerId,
    status,
    total: 150,
    viewedAt: new Date("2026-11-01T12:00:00Z") as Date | null,
    pdfUrl: null as string | null,
    items: [],
    accountBlock: ROWS,
  };
}

async function boot(row: ReturnType<typeof invoice>) {
  const findOne = jest.fn().mockResolvedValue(row);
  const update = jest.fn().mockResolvedValue({});
  const stub = (token: InjectionToken) => ({ provide: token, useValue: {} });
  const moduleRef = await Test.createTestingModule({
    controllers: [BuyerController],
    providers: [
      oversellReaderOffProvider,
      { provide: InvoicesService, useValue: { findOne } },
      { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
      { provide: PrismaService, useValue: { forTenant: () => ({ invoice: { update } }) } },
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
  return { controller: moduleRef.get(BuyerController), findOne, update };
}

describe("GET /buyer/invoices/:id: the account rows (SA-1228 D5)", () => {
  it("R3: the buyer's own invoice carries the rows as given, from one findOne call", async () => {
    const { controller, findOne } = await boot(invoice("SENT"));
    const out: any = await controller.getInvoice("inv-sent", CTX);
    expect(out.accountBlock).toEqual(ROWS);
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(findOne).toHaveBeenCalledWith("inv-sent");
  });

  it("R4: another customer's invoice is a 403 holding none of the rows", async () => {
    const { controller, update } = await boot(invoice("SENT", "c-other"));
    const err: any = await controller.getInvoice("inv-sent", CTX).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    const body = JSON.stringify(err.getResponse());
    expect(body).not.toContain("accountBlock");
    expect(body).not.toContain("180");
    expect(update).not.toHaveBeenCalled();
  });

  it("R4: the buyer's own DRAFT is a 404, rows or not", async () => {
    const { controller } = await boot(invoice("DRAFT"));
    await expect(controller.getInvoice("inv-draft", CTX)).rejects.toBeInstanceOf(NotFoundException);
  });
});
