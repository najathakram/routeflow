/**
 * B304 / SA-1172 test 19: a `quote` or `priceOnly` flag in a POST /buyer/orders body is no option; the order is still created.
 */
const withAdvisoryLock = jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
  acquired: true,
  value: await fn(),
}));
jest.mock("../common/db-locks", () => ({
  LockTimeoutError: class LockTimeoutError extends Error {},
  LockUnavailableError: class LockUnavailableError extends Error {},
  withAdvisoryLock: (...a: [unknown, () => Promise<unknown>]) => withAdvisoryLock(...a),
}));

import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
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

const CTX = {
  customerId: "cust-1",
  tenantId: "tenant-xyz",
  tenantSlug: "acme",
  userId: null,
  customer: { id: "cust-1", businessName: "Qty Split Buyer" },
};

describe("B304: the buyer order body can not turn on the quote path", () => {
  let controller: BuyerController;
  let svc: Record<string, jest.Mock>;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    withAdvisoryLock.mockClear();
    svc = {
      findActiveOrder: jest.fn().mockResolvedValue(null),
      findOrderIdByIdempotencyKey: jest.fn().mockResolvedValue(null),
      replayMergeReconcile: jest.fn(),
      liveTrioByProduct: jest.fn().mockResolvedValue(new Map()),
      updateOrderItems: jest.fn().mockResolvedValue({ id: "ord-1", lineItems: [] }),
      recordIdempotencyKey: jest.fn(),
      applyBuyerMergeHeader: jest.fn(),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "ord-1", customerId: "cust-1", lineItems: [] }),
      findOne: jest.fn().mockResolvedValue({ id: "ord-1", customerId: "cust-1", lineItems: [] }),
    };
    prisma = createMockPrisma();
    prisma.forTenant().product.findMany.mockResolvedValue([
      { id: "boxed", unitsPerBox: 12 },
      { id: "plain", unitsPerBox: null },
    ]);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BuyerController],
      providers: [
        oversellReaderOffProvider,
        { provide: BuyerService, useValue: {} },
        { provide: BuyerCatalogService, useValue: {} },
        { provide: BuyerDashboardService, useValue: {} },
        { provide: ReplenishmentService, useValue: {} },
        { provide: ShelfService, useValue: {} },
        { provide: StockAlertService, useValue: {} },
        { provide: PromotionsService, useValue: {} },
        { provide: OrdersService, useValue: svc },
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
          useValue: { run: jest.fn((_id, fn) => fn()), getOrNull: jest.fn().mockReturnValue(null) },
        },
      ],
    }).compile();
    controller = module.get(BuyerController);
  });

  it("19: { quote: true, priceOnly: true } in the body still creates an order, with no quote option", async () => {
    await controller.createOrder(
      { items: [{ productId: "plain", qty: 3 }], quote: true, priceOnly: true } as any,
      CTX as any,
    );
    expect(svc.create).toHaveBeenCalledTimes(1);
    const options = svc.create.mock.calls[0][2] ?? {};
    expect(options.quote).toBeUndefined();
    expect(JSON.stringify(options)).not.toContain("priceOnly");
  });
});
