/**
 * #2717 M4a-1 — the buyer scan shares the ONE `findScanMatches` (SA-578 Q3, L-167) and keeps its own
 * visibility scope (SA-578 Q3 condition: "sharing must not widen the buyer to the staff scope").
 *
 * RED (M4a-1): ../products/scan-match does not exist — fails on "Cannot find module".
 * Behavioural reds once it exists: BuyerController.scanProduct still hand-rolls its own two
 * product.findMany tiers, so the spy sees zero calls and a ProductBarcode row code cannot resolve.
 */
import { NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { normalizeScanCode } from "@routeflow/scanning";
import * as scanMatch from "../products/scan-match";
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { BuyerController } from "./buyer.controller";
import { BuyerService } from "./buyer.service";
import { BuyerCatalogService } from "./buyer-catalog.service";
import { BuyerDashboardService } from "./buyer-dashboard.service";
import { ReplenishmentService } from "./replenishment.service";
import { ShelfService } from "./shelf.service";
import { StatementService } from "./statement.service";
import { StatementPdfService } from "./statement-pdf.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { ChangeRequestsService } from "../orders/change-requests.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { CustomersService } from "../customers/customers.service";
import { OrderTemplatesService } from "../order-templates/order-templates.service";
import { AuthorizationsService } from "../authorizations/authorizations.service";
import { OrdersService } from "../orders/orders.service";
import { InvoicesService } from "../invoices/invoices.service";
import { PromotionsService } from "../promotions/promotions.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { createMockPrisma } from "../testing/prisma-mock";

const BUYER_CTX = {
  customerId: "cust-abc",
  tenantId: "tenant-xyz",
  tenantSlug: "acme",
  userId: null,
};

describe("BuyerController.scanProduct — shares findScanMatches, keeps the buyer's scope (M4a-1)", () => {
  let controller: BuyerController;
  let prisma: ReturnType<typeof createMockPrisma>;
  let catalogService: { getProductDetail: jest.Mock };
  let stockAlertService: { isSubscribed: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.productBarcode.findMany.mockResolvedValue([] as any);
    prisma.product.findMany.mockResolvedValue([] as any);
    catalogService = { getProductDetail: jest.fn() };
    stockAlertService = { isSubscribed: jest.fn().mockResolvedValue(false) };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BuyerController],
      providers: [
        oversellReaderOffProvider,
        { provide: BuyerService, useValue: {} },
        { provide: BuyerCatalogService, useValue: catalogService },
        { provide: BuyerDashboardService, useValue: {} },
        { provide: ReplenishmentService, useValue: {} },
        { provide: ShelfService, useValue: {} },
        { provide: StockAlertService, useValue: stockAlertService },
        { provide: PromotionsService, useValue: {} },
        { provide: OrdersService, useValue: {} },
        { provide: ChangeRequestsService, useValue: {} },
        { provide: InvoicesService, useValue: {} },
        { provide: InvoicePdfService, useValue: {} },
        { provide: StatementService, useValue: {} },
        { provide: StatementPdfService, useValue: {} },
        { provide: CustomersService, useValue: {} },
        { provide: OrderTemplatesService, useValue: {} },
        { provide: AuthorizationsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: {} },
        {
          provide: TenantContextService,
          useValue: { run: jest.fn((_id: string, fn: any) => fn()), getOrNull: () => null },
        },
      ],
    }).compile();
    controller = module.get(BuyerController);
  });
  afterEach(() => jest.restoreAllMocks());

  it("calls the SAME findScanMatches function (spy) with the normalised candidates and a scope object — no second hand-rolled tier (L-167)", async () => {
    const spy = jest.spyOn(scanMatch, "findScanMatches");
    prisma.product.findMany.mockResolvedValue([
      { id: "p1", barcode: "012345678905", sku: null, unitSku: null, unitsPerBox: 6, barcodes: [] },
    ] as any);
    catalogService.getProductDetail.mockResolvedValue({ id: "p1" });

    await controller.scanProduct("0012345678905", BUYER_CTX as any);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual(normalizeScanCode("0012345678905"));
    expect(spy.mock.calls[0][2]).toEqual(expect.any(Object)); // the buyer's own baseWhere, never undefined
  });

  it("a ProductBarcode row code resolves for the buyer too, and goes through the buyer's getProductDetail gate", async () => {
    prisma.productBarcode.findMany.mockResolvedValue([
      {
        productId: "p1",
        code: "X-ROWCODE",
        level: "UNIT",
        symbology: "CODE128",
        origin: "ENTERED",
        copiedFromLevel: null,
        primaryFor: null,
      },
    ] as any);
    prisma.product.findMany.mockResolvedValue([
      { id: "p1", barcode: "LEGACY-ONE", sku: null, unitSku: null, unitsPerBox: 6, barcodes: [] },
    ] as any);
    const detail = { id: "p1", name: "Sample Cola 6pk" };
    catalogService.getProductDetail.mockResolvedValue(detail);

    const result = await controller.scanProduct("X-ROWCODE", BUYER_CTX as any);

    expect(result).toMatchObject({ ...detail, alertSubscribed: false });
    expect(catalogService.getProductDetail).toHaveBeenCalledWith("p1", BUYER_CTX.customerId);
  });

  it("VISIBILITY PIN (SA-578 Q3): a row code on a product this buyer cannot see does NOT resolve — 404, nothing downstream runs", async () => {
    prisma.productBarcode.findMany.mockResolvedValue([
      {
        productId: "hidden",
        code: "X-ROWCODE",
        level: "BOX",
        symbology: "CODE128",
        origin: "ENTERED",
        copiedFromLevel: null,
        primaryFor: null,
      },
    ] as any);
    prisma.product.findMany.mockResolvedValue([
      { id: "hidden", barcode: null, sku: null, unitSku: null, unitsPerBox: 6, barcodes: [] },
    ] as any);
    // the gate the buyer path applies today (inactive / regulated-category product)
    catalogService.getProductDetail.mockRejectedValue(new NotFoundException("Product not found"));

    await expect(controller.scanProduct("X-ROWCODE", BUYER_CTX as any)).rejects.toThrow(
      NotFoundException,
    );
    expect(stockAlertService.isSubscribed).not.toHaveBeenCalled();
  });

  it("the shared lookup receives the buyer path's tenant-scoped db (forTenant()), never the raw client", async () => {
    const spy = jest.spyOn(scanMatch, "findScanMatches");
    prisma.product.findMany.mockResolvedValue([] as any);
    await expect(controller.scanProduct("NOPE", BUYER_CTX as any)).rejects.toThrow(
      NotFoundException,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(prisma.forTenant).toHaveBeenCalled();
    // the db handle handed to the shared function is the tenant-scoped one
    expect(spy.mock.calls[0][0]).toBe(prisma.forTenant.mock.results[0].value);
  });
});
