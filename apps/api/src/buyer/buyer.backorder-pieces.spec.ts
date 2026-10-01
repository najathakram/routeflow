// The cart-merge section runs under an advisory lock; no DB here, so a pass-through.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));
jest.mock("../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: class NotificationsService {},
}));

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
import { PolicyOversellReader } from "../orders/policy-oversell-reader";
import type { StockOutcomeSink } from "../orders/order-stock";

/**
 * Buyer backorderPieces (SA-606k): the buyer create / merge / edit responses carry a per-line
 * `backorderPieces` (PIECES - the UI converts), computed from the overshoot the LOCKED stock write
 * reported through the sink the controller hands OrdersService, split stock-first in line order.
 * Policy off -> the field is present and 0. Staff screens never see it (buyer controller only).
 *
 * L-247: builds BuyerController with every provider the other BuyerController specs list.
 */
const CTX = {
  customerId: "cust-1",
  tenantId: "tenant-xyz",
  tenantSlug: "acme",
  userId: null,
  customer: { id: "cust-1", businessName: "Buyer" },
};
const line = (id: string, productId: string | null, qty: number, extra: object = {}) => ({
  id,
  productId,
  qty,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  ...extra,
});

describe("BuyerController backorderPieces", () => {
  let controller: BuyerController;
  let orders: Record<string, jest.Mock>;

  async function build() {
    const prisma = createMockPrisma();
    orders = {
      findActiveOrder: jest.fn().mockResolvedValue(null),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      findOne: jest.fn(),
      updateOrderItems: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BuyerController],
      providers: [
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
        { provide: OrderTemplatesService, useValue: {} },
        { provide: AuthorizationsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: {} },
        { provide: PolicyOversellReader, useValue: { read: jest.fn() } },
        {
          provide: TenantContextService,
          useValue: { run: jest.fn((_id, fn) => fn()), getOrNull: jest.fn().mockReturnValue(null) },
        },
      ],
    }).compile();
    controller = module.get(BuyerController);
  }

  const fill = (sink: StockOutcomeSink, byProduct: Record<string, number>) => {
    for (const [id, n] of Object.entries(byProduct)) sink.backorderByProduct.set(id, n);
  };
  const create = (items: Array<{ productId: string; qty: number }>) =>
    controller.createOrder({ items, forceNew: true } as any, CTX);

  it("C2 fresh create: 7 asked, the decrement overshot 4 -> the line says 4; totals untouched", async () => {
    await build();
    orders.create.mockImplementation(async (_dto, _user, opts) => {
      fill(opts.stockSink, { p1: 4 });
      return { id: "o-1", total: "12.00", lineItems: [line("l1", "p1", 7)] };
    });
    const res: any = await create([{ productId: "p1", qty: 7 }]);
    expect(orders.create.mock.calls[0][2]).toEqual(
      expect.objectContaining({ stockSink: expect.any(Object) }),
    );
    expect(res.lineItems[0].backorderPieces).toBe(4);
    expect(res.total).toBe("12.00");
  });

  it("C1 policy off / enough stock: the sink stays empty and every line says 0", async () => {
    await build();
    orders.create.mockResolvedValue({
      id: "o-1",
      lineItems: [line("l1", "p1", 3), line("l2", null, 1)],
    });
    const res: any = await create([{ productId: "p1", qty: 3 }]);
    expect(res.lineItems.map((l: any) => l.backorderPieces)).toEqual([0, 0]);
  });

  it("C3 two lines of one product: stock-first, the later line carries the overshoot", async () => {
    await build();
    orders.create.mockImplementation(async (_d, _u, opts) => {
      fill(opts.stockSink, { p1: 4 });
      return { id: "o-1", lineItems: [line("l1", "p1", 3), line("l2", "p1", 4)] };
    });
    const res: any = await create([{ productId: "p1", qty: 7 }]);
    expect(res.lineItems.map((l: any) => l.backorderPieces)).toEqual([0, 4]);
  });

  it("a boxed line reports PIECES: 2 boxes of 12 with an overshoot of 14 -> 14", async () => {
    await build();
    orders.create.mockImplementation(async (_d, _u, opts) => {
      fill(opts.stockSink, { p1: 14 });
      opts.stockSink.packByProduct.set("p1", 12);
      return {
        id: "o-1",
        lineItems: [line("l1", "p1", 24, { boxes: 2, pieces: 0, unitsPerBox: 12 })],
      };
    });
    const res: any = await create([{ productId: "p1", qty: 24 }]);
    expect(res.lineItems[0].backorderPieces).toBe(14);
  });

  it("C6 post-create consolidation: the merged order lines are decorated too", async () => {
    await build();
    orders.create.mockImplementation(async (_d, _u, opts) => {
      fill(opts.stockSink, { p1: 4 });
      return { id: "o-new", lineItems: [line("l1", "p1", 7)] };
    });
    orders.mergeAllPendingForCustomer.mockResolvedValue({
      id: "o-old",
      lineItems: [line("l0", "p1", 2), line("l1", "p1", 7)],
    });
    const res: any = await create([{ productId: "p1", qty: 7 }]);
    expect(res.id).toBe("o-old");
    // stock-first in line order: the older line keeps its stock, the new one carries the 4
    expect(res.lineItems.map((l: any) => l.backorderPieces)).toEqual([0, 4]);
  });

  it("C9 edit up: updateOrderItems gets a sink and the response uses THIS edit's overshoot", async () => {
    await build();
    orders.updateOrderItems.mockImplementation(async (_id, _dto, _user, opts) => {
      fill(opts.stockSink, { p1: 2 });
      return { id: "o-1", lineItems: [line("l1", "p1", 7)] };
    });
    const res: any = await controller.updateOrderItems("o-1", { items: [] } as any, CTX);
    expect(orders.updateOrderItems.mock.calls[0][3]).toEqual(
      expect.objectContaining({ stockSink: expect.any(Object) }),
    );
    expect(res.lineItems[0].backorderPieces).toBe(2);
  });

  it("C9 edit down to <= stock: nothing was overshot, so the line says 0", async () => {
    await build();
    orders.updateOrderItems.mockResolvedValue({ id: "o-1", lineItems: [line("l1", "p1", 2)] });
    const res: any = await controller.updateOrderItems("o-1", { items: [] } as any, CTX);
    expect(res.lineItems[0].backorderPieces).toBe(0);
  });

  it("C4 a refusal from the stock write reaches the buyer unchanged", async () => {
    await build();
    const refusal = Object.assign(new Error("x"), {
      getResponse: () => ({ code: "INVENTORY_QUANTITY_INVALID" }),
    });
    orders.create.mockRejectedValue(refusal);
    await expect(create([{ productId: "p1", qty: 7 }])).rejects.toBe(refusal);
  });

  it("an order with no lineItems array passes through untouched", async () => {
    await build();
    orders.updateOrderItems.mockResolvedValue({ id: "o-1" });
    const res: any = await controller.updateOrderItems("o-1", { items: [] } as any, CTX);
    expect(res).toEqual({ id: "o-1" });
  });
});
