/**
 * B985 / SA-631: a buyer's "create a separate order" (`forceNew`) must PERSIST. The controller used to call
 * `ordersService.create(dto, user)` without `{ skipAutoMerge: true }`, so the new order was a merge
 * candidate: the post-commit sweep (and the hourly one) folded it into another order and hard-deleted the
 * loser. Staff already passes `{ skipAutoMerge: choice === "separate" }`. These pins are EXECUTED against
 * the controller with a mocked OrdersService:
 *  - forceNew creates with `{ skipAutoMerge: true }`, runs NO post-commit sweep, and returns THAT order
 *    (re-read, with the figure);
 *  - a plain create passes `{ skipAutoMerge: false }` and still sweeps (unchanged);
 *  - a re-read failure after the commit never throws.
 * The hourly-sweep survival is on real Postgres: order-forcenew-survives-sweep.db.spec.ts.
 */
jest.mock("../common/db-locks", () => {
  class LockTimeoutError extends Error {
    constructor(
      public readonly family: string,
      public readonly key: string,
      public readonly waitMs: number,
    ) {
      super(`advisory lock timeout: ${family}:${key} after ${waitMs}ms`);
      this.name = "LockTimeoutError";
    }
  }
  class LockUnavailableError extends Error {
    constructor(public readonly cause?: unknown) {
      super("advisory lock unavailable");
      this.name = "LockUnavailableError";
    }
  }
  return {
    withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
      acquired: true,
      value: await fn(),
    })),
    LockTimeoutError,
    LockUnavailableError,
  };
});

import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { Test, TestingModule } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
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
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";

import { NotFoundException } from "@nestjs/common";
import { readFileSync } from "fs";
import { join } from "path";
import { withStockWrite } from "../orders/order-stock";
import { MERGE_IN_PROGRESS, MERGE_IN_PROGRESS_MESSAGE } from "../orders/merge-contention";

const CTX = {
  customerId: "cust-1",
  tenantId: "tenant-xyz",
  tenantSlug: "acme",
  userId: null,
  customer: { id: "cust-1", businessName: "Buyer" },
};
const write = (entries: Array<[string, number]>) => ({ backorderByProduct: new Map(entries) });
const line = (id: string, productId: string, qty: number) => ({
  id,
  productId,
  qty,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  status: "PENDING",
  product: { id: productId, unitsPerBox: null },
});
const orderOf = (id: string, rows: Array<[string, string, number]>) => ({
  id,
  skipAutoMerge: false, // merge-eligible, as a default buyer create is
  lineItems: rows.map(([i, p, q]) => line(i, p, q)),
});
const figures = (o: any) => o.lineItems.map((l: any) => l.backorderPieces);
const noKey = (o: any) => o.lineItems.every((l: any) => !("backorderPieces" in l));

describe("BuyerController forceNew persists the buyer's separate choice (B985, SA-631)", () => {
  let controller: BuyerController;
  let orders: Record<string, jest.Mock>;
  let templates: { generateOrder: jest.Mock };
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    orders = {
      findActiveOrder: jest.fn().mockResolvedValue(null),
      updateOrderItems: jest.fn(),
      applyBuyerMergeHeader: jest.fn().mockResolvedValue(undefined),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      findOne: jest.fn(),
    };
    templates = { generateOrder: jest.fn() };
    prisma = createMockPrisma();
    prisma.forTenant().product.findMany.mockResolvedValue([{ id: "p", unitsPerBox: null }]);
    prisma.forTenant().orderTemplate.findFirst.mockResolvedValue({ customerId: CTX.customerId });
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
        { provide: OrdersService, useValue: orders },
        { provide: ChangeRequestsService, useValue: {} },
        { provide: InvoicesService, useValue: {} },
        { provide: InvoicePdfService, useValue: {} },
        { provide: StatementService, useValue: {} },
        { provide: StatementPdfService, useValue: {} },
        { provide: CustomersService, useValue: {} },
        { provide: OrderTemplatesService, useValue: templates },
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

  const activeOrder = {
    id: "o-active",
    customerId: CTX.customerId,
    lineItems: [
      { id: "l0", productId: "p", qty: 2, boxes: null, pieces: null, unitPrice: 10, name: null },
    ],
  };
  const cart = { items: [{ productId: "p", qty: 6 }] };
  const createdOrder = (extra: Record<string, unknown> = {}) =>
    withStockWrite({ ...orderOf("o-new", [["c1", "p", 8]]), ...extra }, write([["p", 3]]));
  const rereadsCreated = () =>
    orders.findOne.mockImplementation(async (id: string) => {
      if (id === "o-new") return orderOf("o-new", [["c1", "p", 8]]);
      throw new NotFoundException("Order not found");
    });

  it("(a)/(e) forceNew with an existing PENDING order: created with { skipAutoMerge: true }, the existing order is untouched, the response is THE created order with its figure", async () => {
    orders.findActiveOrder.mockResolvedValue(activeOrder);
    orders.create.mockResolvedValue(createdOrder({ skipAutoMerge: true }));
    rereadsCreated();
    const res: any = await controller.createOrder({ ...cart, forceNew: true } as any, CTX as any);
    expect(orders.create).toHaveBeenCalledTimes(1);
    expect(orders.create.mock.calls[0][2]).toEqual({ skipAutoMerge: true });
    expect(orders.updateOrderItems).not.toHaveBeenCalled(); // never folded into the open order
    expect(res.id).toBe("o-new");
    expect(figures(res)).toEqual([3]);
  });

  it("forceNew runs NO post-commit sweep (it has nothing to consolidate, and the customer's OTHER orders are the hourly sweep's)", async () => {
    orders.create.mockResolvedValue(createdOrder({ skipAutoMerge: true }));
    orders.mergeAllPendingForCustomer.mockResolvedValue(orderOf("o-other", [["m1", "p", 9]]));
    rereadsCreated();
    const res: any = await controller.createOrder({ ...cart, forceNew: true } as any, CTX as any);
    expect(orders.mergeAllPendingForCustomer).not.toHaveBeenCalled();
    expect(res.id).toBe("o-new");
  });

  it("(e) a PLAIN create passes { skipAutoMerge: false } and still sweeps (unchanged behaviour)", async () => {
    orders.create.mockResolvedValue(createdOrder({ skipAutoMerge: false }));
    rereadsCreated();
    await controller.createOrder(cart as any, CTX as any);
    expect(orders.create.mock.calls[0][2]).toEqual({ skipAutoMerge: false });
    expect(orders.mergeAllPendingForCustomer).toHaveBeenCalledTimes(1);
  });

  it("forceNew: the re-read failing after the commit never throws (the created order comes back, key omitted)", async () => {
    const created = createdOrder({ skipAutoMerge: true });
    orders.create.mockResolvedValue(created);
    orders.findOne.mockRejectedValue(new Error("db down"));
    await expect(
      controller.createOrder({ ...cart, forceNew: true } as any, CTX as any),
    ).resolves.toBe(created);
  });

  it("forceNew: the pre-create merge is still skipped (the open order is never read for a merge)", async () => {
    orders.findActiveOrder.mockResolvedValue(activeOrder);
    orders.create.mockResolvedValue(createdOrder({ skipAutoMerge: true }));
    rereadsCreated();
    await controller.createOrder({ ...cart, forceNew: true } as any, CTX as any);
    expect(orders.findActiveOrder).not.toHaveBeenCalled();
    expect(orders.applyBuyerMergeHeader).not.toHaveBeenCalled();
  });
});
