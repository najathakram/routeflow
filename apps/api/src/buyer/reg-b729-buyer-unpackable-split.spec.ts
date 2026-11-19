/**
 * REG-B729: the unpackable-split refusal (SA-077(2): boxes/pieces on a line whose product has no pack, so the split has no
 * denominator and would be silently dropped) is enforced for the operator invoice endpoints; the buyer order endpoints also accept
 * boxes/pieces. The wrong value: a buyer createOrder / edit-lines payload that names a split on an unpackable product
 * (unitsPerBox null or 1) reaches the order writer instead of being refused with a 400.
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

describe("REG-B729: buyer order endpoints refuse a split on an unpackable product", () => {
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

  const refused = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(svc.create).not.toHaveBeenCalled();
    expect(svc.updateOrderItems).not.toHaveBeenCalled();
  };

  it("REG-B729: createOrder with boxes on a product with no pack is a 400 and nothing is created", async () => {
    await refused(
      controller.createOrder(
        { items: [{ productId: "plain", qty: 3, boxes: 2, pieces: 0 }] } as any,
        CTX as any,
      ),
    );
  });

  it("REG-B729 (SA-1170 K4): a contradictory split is refused on the fold into an active order too", async () => {
    svc.findActiveOrder.mockResolvedValue({ id: "ord-1", customerId: "cust-1", lineItems: [] });
    await refused(
      controller.createOrder(
        { items: [{ productId: "plain", qty: 3, boxes: 2, pieces: 0 }] } as any,
        CTX as any,
      ),
    );
  });

  it("REG-B729: a self-consistent split on a no-pack product still goes through (stale carts)", async () => {
    for (const line of [
      { qty: 24, boxes: 2, pieces: 0 },
      { qty: 3, boxes: 0, pieces: 0 },
      { qty: 3, pieces: 3 },
    ]) {
      svc.create.mockClear();
      await controller.createOrder({ items: [{ productId: "plain", ...line }] } as any, CTX as any);
      expect(svc.create).toHaveBeenCalledTimes(1);
    }
  });

  it("REG-B729: a plain qty on that product (no split) is still accepted", async () => {
    await controller.createOrder({ items: [{ productId: "plain", qty: 3 }] } as any, CTX as any);
    expect(svc.create).toHaveBeenCalledTimes(1);
  });
});
