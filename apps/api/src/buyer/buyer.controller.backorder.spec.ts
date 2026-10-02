/**
 * SA-606m/n/o: the BUYER controller puts the committed write's per-line `backorderPieces` on its
 * create / merge / forceNew / PATCH-items responses (and ONLY those). Everything that cannot compute
 * it OMITS the key: the standing-order Reorder, a replay, a lost write, a failure after the commit.
 * `OrdersService` is mocked; the carrier (`withStockWrite`) is how the real service hands the locked
 * write back, so a mocked order that carries one stands in for a write that happened.
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

import { ConflictException } from "@nestjs/common";
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
  lineItems: rows.map(([i, p, q]) => line(i, p, q)),
});
const figures = (o: any) => o.lineItems.map((l: any) => l.backorderPieces);
const noKey = (o: any) => o.lineItems.every((l: any) => !("backorderPieces" in l));

describe("BuyerController backorderPieces on the response (SA-606o)", () => {
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

  describe("merge branch (an active order exists)", () => {
    beforeEach(() => orders.findActiveOrder.mockResolvedValue(activeOrder));

    it("the fold's locked write lands on the re-read order's lines, stock-first", async () => {
      orders.updateOrderItems.mockResolvedValue(
        withStockWrite({ id: "o-active" }, write([["p", 3]])),
      );
      orders.findOne.mockResolvedValue(
        orderOf("o-active", [
          ["l1", "p", 5],
          ["l2", "p", 3],
        ]),
      );
      const res = await controller.createOrder(cart as any, CTX as any);
      expect(figures(res)).toEqual([0, 3]);
    });

    it("a replayed merge wrote nothing: the key is ABSENT, never 0", async () => {
      orders.updateOrderItems.mockResolvedValue({ id: "o-active" }); // no carrier
      orders.findOne.mockResolvedValue(orderOf("o-active", [["l1", "p", 8]]));
      expect(noKey(await controller.createOrder(cart as any, CTX as any))).toBe(true);
    });

    it("a lowering edit between the write and the re-read (lost write) omits the key on the whole order", async () => {
      orders.updateOrderItems.mockResolvedValue(
        withStockWrite({ id: "o-active" }, write([["p", 3]])),
      );
      orders.findOne.mockResolvedValue(orderOf("o-active", [["l1", "p", 2]]));
      expect(noKey(await controller.createOrder(cart as any, CTX as any))).toBe(true);
    });

    it("a failure while building the figures after the commit still returns the order, key absent", async () => {
      orders.updateOrderItems.mockResolvedValue(
        withStockWrite({ id: "o-active" }, write([["p", 3]])),
      );
      const broken: any = { id: "o-active" };
      Object.defineProperty(broken, "lineItems", {
        get() {
          throw new Error("boom after commit");
        },
      });
      orders.findOne.mockResolvedValue(broken);
      await expect(controller.createOrder(cart as any, CTX as any)).resolves.toBe(broken);
    });
  });

  describe("create branch (no active order, or forceNew)", () => {
    it.each([
      ["no active order", {}],
      ["forceNew", { forceNew: true }],
    ])("%s: the created order carries the figure", async (_n, extra) => {
      if ((extra as any).forceNew) orders.findActiveOrder.mockResolvedValue(activeOrder); // must be ignored
      orders.create.mockResolvedValue(
        withStockWrite(orderOf("o-new", [["c1", "p", 8]]), write([["p", 3]])),
      );
      const res = await controller.createOrder(
        { ...cart, ...(extra as object) } as any,
        { ...CTX } as any,
      );
      expect(figures(res)).toEqual([3]);
    });

    it("a fold into another order attributes onto the MERGED order's lines (same rule)", async () => {
      orders.create.mockResolvedValue(
        withStockWrite(orderOf("o-new", [["c1", "p", 8]]), write([["p", 3]])),
      );
      orders.mergeAllPendingForCustomer.mockResolvedValue(
        orderOf("o-old", [
          ["m1", "p", 5],
          ["m2", "p", 8],
        ]),
      );
      expect(figures(await controller.createOrder(cart as any, CTX as any))).toEqual([0, 3]);
    });

    it("a deferred / contended fold falls back to the created order", async () => {
      orders.create.mockResolvedValue(
        withStockWrite(orderOf("o-new", [["c1", "p", 8]]), write([["p", 3]])),
      );
      orders.mergeAllPendingForCustomer.mockRejectedValue(
        new ConflictException({
          code: MERGE_IN_PROGRESS,
          message: MERGE_IN_PROGRESS_MESSAGE,
        }),
      );
      expect(figures(await controller.createOrder(cart as any, CTX as any))).toEqual([3]);
    });
  });

  describe("PATCH orders/:id/items", () => {
    it("an edit's settle figure lands on the response lines", async () => {
      orders.updateOrderItems.mockResolvedValue(
        withStockWrite(orderOf("o-1", [["l1", "p", 6]]), write([["p", 2]])),
      );
      const res = await controller.updateOrderItems("o-1", { items: [] } as any, CTX as any);
      expect(figures(res)).toEqual([2]);
    });

    it("an edit with nothing written (DRAFT) omits the key", async () => {
      orders.updateOrderItems.mockResolvedValue(orderOf("o-1", [["l1", "p", 6]]));
      expect(
        noKey(await controller.updateOrderItems("o-1", { items: [] } as any, CTX as any)),
      ).toBe(true);
    });
  });

  describe("buyer Reorder (generateOrder) PRESENT; staff manual run and cron ABSENT (B975, SA-606q)", () => {
    it("a Reorder that wrote stock reports the figure on its lines, same rule as checkout", async () => {
      templates.generateOrder.mockResolvedValue(
        withStockWrite(orderOf("o-r", [["r1", "p", 8]]), write([["p", 3]])),
      );
      const res = await controller.reorderFromTemplate("t-1", CTX as any);
      expect(figures(res)).toEqual([3]);
    });

    it("a Reorder order with no write behind it omits the key, never 0", async () => {
      templates.generateOrder.mockResolvedValue(orderOf("o-r", [["r1", "p", 4]]));
      const res = await controller.reorderFromTemplate("t-1", CTX as any);
      expect(noKey(res)).toBe(true);
      expect(JSON.stringify(res)).not.toMatch(/backorder/i);
    });

    it("a lost write on the Reorder (lines lowered before the re-read) omits the key on the whole order", async () => {
      templates.generateOrder.mockResolvedValue(
        withStockWrite(orderOf("o-r", [["r1", "p", 2]]), write([["p", 3]])),
      );
      expect(noKey(await controller.reorderFromTemplate("t-1", CTX as any))).toBe(true);
    });

    it("a failure while attributing after the commit still returns the Reorder order, key absent", async () => {
      const broken: any = withStockWrite({ id: "o-r" }, write([["p", 3]]));
      Object.defineProperty(broken, "lineItems", {
        get() {
          throw new Error("boom after commit");
        },
      });
      templates.generateOrder.mockResolvedValue(broken);
      await expect(controller.reorderFromTemplate("t-1", CTX as any)).resolves.toBe(broken);
    });

    it("the staff controllers never map it (static pin: no import of the response helper)", () => {
      for (const f of [
        "orders/orders.controller.ts",
        "order-templates/order-templates.controller.ts",
      ]) {
        const text = readFileSync(join(__dirname, "..", f), "utf8");
        expect(text).not.toMatch(/withBackorderPieces|backorder-response|stockWriteOf/);
      }
    });
  });
});
