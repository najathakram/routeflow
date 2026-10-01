/**
 * #2142 N1 — the buyer portal never shows a DRAFT invoice.
 *
 * The buyer invoice list left DRAFTs out only when no status filter was sent (`?status=DRAFT`
 * listed them), and the detail route read any invoice of the buyer's own customer, DRAFT
 * included, and stamped it `viewedAt` on the way. A DRAFT is the seller's unissued working copy:
 * the list never returns one, whatever the filter, and the detail answers exactly like a missing
 * id (404) and writes nothing.
 *
 * Fixtures are placeholders (acme-style ids); no live-client data.
 */
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { ForbiddenException, InjectionToken, NotFoundException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
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

function invoice(status: string, customerId = "c-mine") {
  return {
    id: `inv-${status.toLowerCase()}`,
    invoiceNumber: `INV-${status}`,
    customerId,
    status,
    total: 42,
    viewedAt: null as Date | null,
    pdfUrl: null as string | null,
    items: [],
  };
}

async function boot(row: ReturnType<typeof invoice>) {
  const findOne = jest.fn().mockResolvedValue(row);
  const findAll = jest.fn().mockResolvedValue({ data: [row], meta: { total: 1 } });
  const update = jest.fn().mockResolvedValue({});
  const getOrGenerate = jest.fn().mockResolvedValue("https://files.example.test/inv.pdf");
  const stub = (token: InjectionToken) => ({ provide: token, useValue: {} });
  const moduleRef = await Test.createTestingModule({
    controllers: [BuyerController],
    providers: [
      oversellReaderOffProvider,
      { provide: InvoicesService, useValue: { findOne, findAll } },
      { provide: InvoicePdfService, useValue: { getOrGenerate } },
      { provide: PrismaService, useValue: { forTenant: () => ({ invoice: { update } }) } },
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
        TenantContextService, // BuyerTenantInterceptor's dependency
      ].map(stub),
    ],
  }).compile();
  return { controller: moduleRef.get(BuyerController), findOne, findAll, update, getOrGenerate };
}

describe("GET /buyer/invoices/:id — a DRAFT is not the buyer's to open (#2142 N1)", () => {
  it("#2142 N1: its own customer's DRAFT answers 404, like a missing invoice", async () => {
    const { controller } = await boot(invoice("DRAFT"));
    await expect(controller.getInvoice("inv-draft", CTX)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("#2142 N1: opening a DRAFT writes nothing (no viewedAt) and renders no PDF", async () => {
    const { controller, update, getOrGenerate } = await boot({
      ...invoice("DRAFT"),
      pdfUrl: "stale.pdf",
    });
    await controller.getInvoice("inv-draft", CTX).catch(() => undefined);
    expect(update).not.toHaveBeenCalled();
    expect(getOrGenerate).not.toHaveBeenCalled();
  });

  it("an issued invoice still opens and is marked viewed", async () => {
    const { controller, update } = await boot(invoice("SENT"));
    const result = await controller.getInvoice("inv-sent", CTX);
    expect(result).toEqual(expect.objectContaining({ id: "inv-sent", status: "SENT" }));
    expect(update).toHaveBeenCalledWith({
      where: { id: "inv-sent" },
      data: { viewedAt: expect.any(Date) },
    });
  });

  it("another customer's invoice is still refused (403), DRAFT or not", async () => {
    for (const status of ["DRAFT", "SENT"]) {
      const { controller, update } = await boot(invoice(status, "c-someone-else"));
      await expect(controller.getInvoice(`inv-${status}`, CTX)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(update).not.toHaveBeenCalled();
    }
  });
});

describe("GET /buyer/invoices — never a DRAFT, whatever the filter (#2142)", () => {
  const NON_DRAFT = Object.values(InvoiceStatus).filter((s) => s !== InvoiceStatus.DRAFT);
  const EMPTY = { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } };
  /** The status filter the list actually ran with (findAll reads `statuses` before `status`). */
  const ranWith = (findAll: jest.Mock) => {
    const [query] = findAll.mock.calls[0];
    return { status: query.status, statuses: query.statuses, customerId: query.customerId };
  };

  it("#2142 N1: ?status=DRAFT returns an empty page and never queries", async () => {
    const { controller, findAll } = await boot(invoice("SENT"));
    const res = await controller.getInvoices(CTX, { status: InvoiceStatus.DRAFT });
    expect(res).toEqual(EMPTY);
    expect(findAll).not.toHaveBeenCalled();
  });

  it("#2142 N1: ?statuses=DRAFT returns an empty page and never queries", async () => {
    const { controller, findAll } = await boot(invoice("SENT"));
    const res = await controller.getInvoices(CTX, {
      statuses: [InvoiceStatus.DRAFT],
      page: 3,
      limit: 10,
    });
    expect(res).toEqual({ data: [], meta: { total: 0, page: 3, limit: 10, totalPages: 0 } });
    expect(findAll).not.toHaveBeenCalled();
  });

  it("#2142 N1: DRAFT is dropped from a mixed statuses filter; the rest still apply", async () => {
    const { controller, findAll } = await boot(invoice("SENT"));
    await controller.getInvoices(CTX, {
      statuses: [InvoiceStatus.DRAFT, InvoiceStatus.SENT],
      status: InvoiceStatus.DRAFT,
    });
    expect(ranWith(findAll)).toEqual({
      status: undefined,
      statuses: [InvoiceStatus.SENT],
      customerId: "c-mine",
    });
  });

  it("a single non-DRAFT status is kept", async () => {
    const { controller, findAll } = await boot(invoice("PAID"));
    await controller.getInvoices(CTX, { status: InvoiceStatus.PAID });
    expect(ranWith(findAll)).toEqual({
      status: undefined,
      statuses: [InvoiceStatus.PAID],
      customerId: "c-mine",
    });
  });

  it("no filter lists every status but DRAFT, for the buyer's own customer only", async () => {
    const { controller, findAll } = await boot(invoice("SENT"));
    await controller.getInvoices(CTX, { customerId: "c-someone-else" });
    const ran = ranWith(findAll);
    expect([...ran.statuses].sort()).toEqual([...NON_DRAFT].sort());
    expect(ran.customerId).toBe("c-mine");
  });
});
