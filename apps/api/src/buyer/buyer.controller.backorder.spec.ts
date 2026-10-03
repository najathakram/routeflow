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

import { ConflictException, NotFoundException } from "@nestjs/common";
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

  describe("create branch (no active order, or forceNew): the holder is re-read by existence (SA-631d)", () => {
    const notFound = () => Promise.reject(new NotFoundException("Order not found"));
    /** findOne over fixed rows; an id with no row rejects like the real 404. */
    const rowsOf = (rows: Record<string, unknown>) =>
      orders.findOne.mockImplementation(async (id: string) => rows[id] ?? notFound());
    const created = (extra: Record<string, unknown> = {}) =>
      withStockWrite({ ...orderOf("o-new", [["c1", "p", 8]]), ...extra }, write([["p", 3]]));

    it.each([
      ["no active order", {}],
      ["forceNew", { forceNew: true }],
    ])("%s: the created order carries the figure", async (_n, extra) => {
      if ((extra as any).forceNew) orders.findActiveOrder.mockResolvedValue(activeOrder); // must be ignored
      orders.create.mockResolvedValue(created());
      rowsOf({ "o-new": orderOf("o-new", [["c1", "p", 8]]) });
      const res = await controller.createOrder(
        { ...cart, ...(extra as object) } as any,
        { ...CTX } as any,
      );
      expect(figures(res)).toEqual([3]);
    });

    it("a PLAIN checkout: the sweep returns the BARE created row, the response is the created order re-read in full, with the figure", async () => {
      orders.create.mockResolvedValue(created());
      orders.mergeAllPendingForCustomer.mockResolvedValue({
        id: "o-new",
        customerId: CTX.customerId,
        lineItems: [{ id: "c1", productId: "p", qty: 8, status: "PENDING" }],
      });
      rowsOf({ "o-new": orderOf("o-new", [["c1", "p", 8]]) });
      const res: any = await controller.createOrder(cart as any, CTX as any);
      expect(res.id).toBe("o-new");
      expect(figures(res)).toEqual([3]);
    });

    it("(i) other orders folded INTO the created one: the response is the post-sweep order with the merged lines", async () => {
      orders.create.mockResolvedValue(created());
      orders.mergeAllPendingForCustomer.mockResolvedValue({ id: "o-new", lineItems: [] });
      rowsOf({
        "o-new": orderOf("o-new", [
          ["x1", "p", 4],
          ["c1", "p", 8],
        ]),
      });
      const res: any = await controller.createOrder(cart as any, CTX as any);
      expect(res.lineItems).toHaveLength(2);
      expect(figures(res)).toEqual([0, 3]);
    });

    it("(ii) the created order was folded INTO another (its row is gone): the survivor is returned with the figure", async () => {
      orders.create.mockResolvedValue(created());
      orders.mergeAllPendingForCustomer.mockResolvedValue({ id: "o-old", lineItems: [] });
      rowsOf({
        "o-old": orderOf("o-old", [
          ["m1", "p", 5],
          ["m2", "p", 8],
        ]),
      });
      const res: any = await controller.createOrder(cart as any, CTX as any);
      expect(res.id).toBe("o-old");
      expect(figures(res)).toEqual([0, 3]);
    });

    it("(iii) created not merge-eligible while another pair was swept: the response is the CREATED order, with the figure", async () => {
      orders.create.mockResolvedValue(created({ skipAutoMerge: true }));
      orders.mergeAllPendingForCustomer.mockResolvedValue({ id: "o-other", lineItems: [] });
      rowsOf({ "o-new": orderOf("o-new", [["c1", "p", 8]]) });
      const res: any = await controller.createOrder(cart as any, CTX as any);
      expect(res.id).toBe("o-new");
      expect(figures(res)).toEqual([3]);
    });

    it("a deferred / contended fold falls back to the created order, re-read, with the figure", async () => {
      orders.create.mockResolvedValue(created());
      orders.mergeAllPendingForCustomer.mockRejectedValue(
        new ConflictException({ code: MERGE_IN_PROGRESS, message: MERGE_IN_PROGRESS_MESSAGE }),
      );
      rowsOf({ "o-new": orderOf("o-new", [["c1", "p", 8]]) });
      expect(figures(await controller.createOrder(cart as any, CTX as any))).toEqual([3]);
    });

    it("(iv) neither row can be read: the sweep's order (or created) comes back untouched, key omitted, no throw", async () => {
      orders.create.mockResolvedValue(created());
      const sweep = { id: "o-old", lineItems: [] };
      orders.mergeAllPendingForCustomer.mockResolvedValue(sweep);
      rowsOf({});
      await expect(controller.createOrder(cart as any, CTX as any)).resolves.toBe(sweep);
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

  describe("buyer Reorder (generateOrder): the holder is decided by EXISTENCE, like checkout (B975, SA-631d)", () => {
    const notFound = () => Promise.reject(new NotFoundException("Order not found"));
    const rowsOf = (rows: Record<string, unknown>) =>
      orders.findOne.mockImplementation(async (id: string) => rows[id] ?? notFound());
    /** What the template service returns: the SWEPT order (or the created one), carrying the created order's write + id. */
    const swept = (id: string, lines: Array<[string, string, number]> = []) =>
      withStockWrite(orderOf(id, lines), { ...write([["p", 3]]), orderId: "o-new" });

    it("(iii) the sweep's BARE row (same id, no product): created is re-read in full and carries the figure", async () => {
      templates.generateOrder.mockResolvedValue(
        swept("o-new", [["c1", "p", 8]]), // bare shape is irrelevant: only its id and carrier are used
      );
      rowsOf({ "o-new": orderOf("o-new", [["c1", "p", 8]]) });
      const res: any = await controller.reorderFromTemplate("t-1", CTX as any);
      expect(res.id).toBe("o-new");
      expect(figures(res)).toEqual([3]);
    });

    it("(i) other orders folded INTO the created one: the response is the post-sweep order with the merged lines", async () => {
      templates.generateOrder.mockResolvedValue(swept("o-new"));
      rowsOf({
        "o-new": orderOf("o-new", [
          ["x1", "p", 4],
          ["c1", "p", 8],
        ]),
      });
      const res: any = await controller.reorderFromTemplate("t-1", CTX as any);
      expect(res.lineItems).toHaveLength(2);
      expect(figures(res)).toEqual([0, 3]);
    });

    it("(ii) the created order was folded INTO another (its row is gone): the survivor is returned with the figure", async () => {
      templates.generateOrder.mockResolvedValue(swept("o-old"));
      rowsOf({
        "o-old": orderOf("o-old", [
          ["m1", "p", 5],
          ["m2", "p", 8],
        ]),
      });
      const res: any = await controller.reorderFromTemplate("t-1", CTX as any);
      expect(res.id).toBe("o-old");
      expect(figures(res)).toEqual([0, 3]);
    });

    it("(iii) the created order still EXISTS while the sweep returned a DIFFERENT order: the response is the created order, never the swept one", async () => {
      // the carried id (o-new), not the swept order's id (o-other), decides which row is read first
      templates.generateOrder.mockResolvedValue(swept("o-other", [["m1", "p", 9]]));
      rowsOf({
        "o-new": orderOf("o-new", [["c1", "p", 8]]),
        "o-other": orderOf("o-other", [["m1", "p", 9]]),
      });
      const res: any = await controller.reorderFromTemplate("t-1", CTX as any);
      expect(res.id).toBe("o-new");
      expect(figures(res)).toEqual([3]);
      expect(orders.findOne).toHaveBeenCalledTimes(1); // o-other was never read
    });

    it("(iv) neither row can be read: the order comes back untouched, key omitted, no throw", async () => {
      const order = swept("o-old");
      templates.generateOrder.mockResolvedValue(order);
      rowsOf({});
      await expect(controller.reorderFromTemplate("t-1", CTX as any)).resolves.toBe(order);
      // the created order is tried FIRST, then the survivor (a version that skips either read is red)
      expect(orders.findOne.mock.calls.map((c) => c[0])).toEqual(["o-new", "o-old"]);
    });

    it("(v) a lowering edit between the sweep and the re-read (lost write): the key is omitted on the whole order", async () => {
      const sweptOrder = swept("o-new");
      templates.generateOrder.mockResolvedValue(sweptOrder);
      const fresh = orderOf("o-new", [["c1", "p", 2]]);
      rowsOf({ "o-new": fresh });
      const res = await controller.reorderFromTemplate("t-1", CTX as any);
      expect(res).toBe(fresh); // the FRESH re-read row came back, not the swept order handed in
      expect(res).not.toBe(sweptOrder);
      expect(noKey(res)).toBe(true);
    });

    it("the Reorder's re-read runs as the BUYER (customer role, tenant of the request), never as staff", async () => {
      templates.generateOrder.mockResolvedValue(swept("o-new"));
      rowsOf({ "o-new": orderOf("o-new", [["c1", "p", 8]]) });
      await controller.reorderFromTemplate("t-1", CTX as any);
      expect(orders.findOne).toHaveBeenCalledWith(
        "o-new",
        expect.objectContaining({ role: "CUSTOMER", type: "BUYER", tenantId: CTX.tenantId }),
      );
    });

    it("a BOXED Reorder line sizes the same as the decrement did (2 cases of 12 = 24 pieces, overshoot 20): the figure needs the re-read row's pack", async () => {
      templates.generateOrder.mockResolvedValue(
        withStockWrite(orderOf("o-new", []), { ...write([["p", 20]]), orderId: "o-new" }),
      );
      // the findOne row carries the product pack (the decrement's own fallback); without it the line is unsizable
      const boxed = { ...line("c1", "p", 2), product: { id: "p", unitsPerBox: 12 } };
      rowsOf({ "o-new": { id: "o-new", skipAutoMerge: false, lineItems: [boxed] } });
      expect(figures(await controller.reorderFromTemplate("t-1", CTX as any))).toEqual([20]);
    });

    it("a non-NotFound failure on the created read is UNKNOWN: the order comes back untouched and the survivor is NOT read", async () => {
      const order = swept("o-old");
      templates.generateOrder.mockResolvedValue(order);
      orders.findOne.mockRejectedValue(new Error("db down"));
      await expect(controller.reorderFromTemplate("t-1", CTX as any)).resolves.toBe(order);
      expect(orders.findOne).toHaveBeenCalledTimes(1); // only o-new, never o-old
    });

    it("an order with NO write behind it (no carrier, or a carrier without the created id) omits the key, never 0", async () => {
      const plain = orderOf("o-r", [["r1", "p", 4]]);
      templates.generateOrder.mockResolvedValue(plain);
      const res: any = await controller.reorderFromTemplate("t-1", CTX as any);
      expect(noKey(res)).toBe(true);
      expect(orders.findOne).not.toHaveBeenCalled();
      const noId = withStockWrite(orderOf("o-r", [["r1", "p", 4]]), write([["p", 3]]));
      templates.generateOrder.mockResolvedValue(noId);
      expect(noKey(await controller.reorderFromTemplate("t-1", CTX as any))).toBe(true);
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
