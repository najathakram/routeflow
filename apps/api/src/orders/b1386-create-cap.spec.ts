/**
 * B1386 (SA-1285 section 1, order CREATE): a buyer's new order line is capped on the PIECE total create builds
 * (`buyerCreateLinePieces`: boxes x pack + pieces for a named split, qty x pack for a plain qty), not on each DTO
 * field alone. Three entry points reach `OrdersService.create` for a CUSTOMER: POST /buyer/orders, POST
 * /buyer/cart/quote and POST /orders. Each refuses a line past `BUYER_LINE_QTY_MAX` with a coded 400, before
 * anything is written or quoted. Synthetic data only.
 *
 *  - REG-B1386 K1: BuyerController.createOrder (the create path and the merge path both sit behind the check).
 *  - REG-B1386 K2: BuyerQuoteController.quote.
 *  - REG-B1386 K3: OrdersController.create, a CUSTOMER caller only (staff keep the DTO's own field bounds).
 *
 * Note on K1/K2: the portal routes also refuse a contradictory qty/box split (QTY_SPLIT_MISMATCH), so the shape
 * `{qty: 1, boxes: 100000}` is 400 there for two reasons. The cap runs FIRST so the answer does not depend on
 * that other check staying in enforce mode; the plain-qty shape (8,334 packs of 12) is the one only this cap stops.
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
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { oversellReaderOffProvider } from "./testing/policy-reader-provider";
import { BuyerController } from "../buyer/buyer.controller";
import { BuyerQuoteController } from "../buyer/buyer-quote.controller";
import { BuyerService } from "../buyer/buyer.service";
import { BuyerCatalogService } from "../buyer/buyer-catalog.service";
import { BuyerDashboardService } from "../buyer/buyer-dashboard.service";
import { ReplenishmentService } from "../buyer/replenishment.service";
import { ShelfService } from "../buyer/shelf.service";
import { StatementService } from "../buyer/statement.service";
import { StatementPdfService } from "../buyer/statement-pdf.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { PromotionsService } from "../promotions/promotions.service";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { CustomersService } from "../customers/customers.service";
import { OrderTemplatesService } from "../order-templates/order-templates.service";
import { AuthorizationsService } from "../authorizations/authorizations.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";
import { ChangeRequestsService } from "./change-requests.service";
import { OrderBatchShipService } from "./order-batch-ship";
import { PackingSlipService } from "./packing-slip.service";
import { StockAvailabilityService } from "./stock-availability.service";
import { BUYER_LINE_QTY_OVER_MAX_MESSAGE, assertBuyerCreateItemsWithinCap } from "./buyer-line-cap";
import { assertMayUseUnits } from "./unit-line-build";
import type { JwtPayload } from "../auth/jwt-payload.interface";

/** Live packs: `boxed` is a 12-pack, `single` has no pack. */
const PACKS: Record<string, number | null> = { boxed: 12, single: null };
const packRows = () => Object.entries(PACKS).map(([id, unitsPerBox]) => ({ id, unitsPerBox }));

type Item = { productId: string; qty: number; boxes?: number; pieces?: number };

interface EntryPoint {
  name: string;
  reg: string;
  /** Builds a fresh harness; `run` sends a cart, `wrote` says whether anything was created, folded or quoted. */
  boot: () => Promise<{ run: (items: Item[]) => Promise<unknown>; wrote: () => boolean }>;
}

const BUYER_CTX = {
  customerId: "cust-1",
  tenantId: "tenant-xyz",
  tenantSlug: "acme",
  userId: "u1",
  customer: { id: "cust-1", businessName: "Acme Buyer" },
};

const principal = (role: JwtPayload["role"]): JwtPayload => ({
  sub: `user-${role.toLowerCase()}`,
  username: "u",
  role,
  status: "ACTIVE",
  forcePasswordChange: false,
  tenantId: null,
  tenantSlug: null,
});

const createdOrder = { id: "ord-1", customerId: "cust-1", lineItems: [], status: "PENDING" };

const buyerCreate: EntryPoint = {
  name: "BuyerController.createOrder",
  reg: "REG-B1386 K1",
  boot: async () => {
    withAdvisoryLock.mockClear();
    const svc: Record<string, jest.Mock> = {
      findActiveOrder: jest.fn().mockResolvedValue(null),
      findOrderIdByIdempotencyKey: jest.fn().mockResolvedValue(null),
      replayMergeReconcile: jest.fn(),
      liveTrioByProduct: jest.fn().mockResolvedValue(new Map()),
      updateOrderItems: jest.fn().mockResolvedValue(createdOrder),
      recordIdempotencyKey: jest.fn(),
      applyBuyerMergeHeader: jest.fn(),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(createdOrder),
      findOne: jest.fn().mockResolvedValue(createdOrder),
    };
    const prisma = createMockPrisma();
    prisma.forTenant().product.findMany.mockResolvedValue(packRows());
    const module = await Test.createTestingModule({
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
    const controller = module.get(BuyerController);
    return {
      run: (items) => controller.createOrder({ items } as never, BUYER_CTX as never),
      wrote: () =>
        svc.create.mock.calls.length > 0 ||
        svc.updateOrderItems.mock.calls.length > 0 ||
        svc.findActiveOrder.mock.calls.length > 0 ||
        withAdvisoryLock.mock.calls.length > 0 ||
        svc.recordIdempotencyKey.mock.calls.length > 0,
    };
  },
};

const buyerQuote: EntryPoint = {
  name: "BuyerQuoteController.quote",
  reg: "REG-B1386 K2",
  boot: async () => {
    const orders = {
      create: jest.fn(async (_dto: unknown, _user: unknown, o: any) => {
        o.beforeWrite({ total: 10, subtotal: 10, tax: 0, categoryTax: 0, isTaxExempt: false });
      }),
    };
    const prisma = createMockPrisma();
    prisma.forTenant().product.findMany.mockResolvedValue(packRows());
    const ctrl = new BuyerQuoteController(orders as never, prisma as never);
    return {
      run: (items) => ctrl.quote({ items } as never, BUYER_CTX as never),
      wrote: () => orders.create.mock.calls.length > 0,
    };
  },
};

const staffJwtCreate = (role: JwtPayload["role"]) => async () => {
  const ordersService = {
    create: jest.fn().mockResolvedValue(createdOrder),
    mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
    liveUnitsPerBoxByProduct: jest.fn(async (ids: string[]) => {
      const packs = new Map<string, number>();
      for (const id of ids) if (id in PACKS) packs.set(id, Number(PACKS[id] ?? 0));
      return packs;
    }),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [OrdersController],
    providers: [
      { provide: OrdersService, useValue: ordersService },
      { provide: ChangeRequestsService, useValue: {} },
      { provide: OrderBatchShipService, useValue: {} },
      { provide: PackingSlipService, useValue: {} },
      { provide: StockAvailabilityService, useValue: {} },
    ],
  }).compile();
  const controller = moduleRef.get(OrdersController);
  return {
    run: (items: Item[]) => controller.create({ items } as never, principal(role)),
    wrote: () => ordersService.create.mock.calls.length > 0,
    ordersService,
  };
};

const ordersCreateAsCustomer: EntryPoint = {
  name: "OrdersController.create (CUSTOMER)",
  reg: "REG-B1386 K3",
  boot: staffJwtCreate("CUSTOMER"),
};

const expectCapRefusal = async (p: Promise<unknown>, productId: string) => {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(BadRequestException);
  expect((err as BadRequestException).getResponse()).toEqual({
    code: "BUYER_LINE_QTY_OVER_MAX",
    message: BUYER_LINE_QTY_OVER_MAX_MESSAGE,
    productIds: [productId],
  });
};

describe.each([buyerCreate, buyerQuote, ordersCreateAsCustomer])("$name", (entry) => {
  it(`${entry.reg} a: {qty 1, boxes 100000, pieces 0} on a 12-pack (1,200,000 pieces) is a coded 400, nothing written`, async () => {
    const h = await entry.boot();
    await expectCapRefusal(
      h.run([{ productId: "boxed", qty: 1, boxes: 100_000, pieces: 0 }]),
      "boxed",
    );
    expect(h.wrote()).toBe(false);
  });

  it(`${entry.reg} b: a plain qty of 8,334 on a 12-pack (100,008 pieces) is a coded 400, nothing written`, async () => {
    const h = await entry.boot();
    await expectCapRefusal(h.run([{ productId: "boxed", qty: 8_334 }]), "boxed");
    expect(h.wrote()).toBe(false);
  });

  it(`${entry.reg} c: one line over the cap refuses the whole cart (a good line before it is not written)`, async () => {
    const h = await entry.boot();
    await expectCapRefusal(
      h.run([
        { productId: "single", qty: 5 },
        { productId: "boxed", qty: 8_334 },
      ]),
      "boxed",
    );
    expect(h.wrote()).toBe(false);
  });

  it("pin: 8,333 plain packs on a 12-pack (99,996 pieces) is accepted", async () => {
    const h = await entry.boot();
    await expect(h.run([{ productId: "boxed", qty: 8_333 }])).resolves.not.toThrow();
    expect(h.wrote()).toBe(true);
  });

  it("pin: a split of 8,333 boxes + 4 pieces on a 12-pack (exactly 100,000) is accepted", async () => {
    const h = await entry.boot();
    await expect(
      h.run([{ productId: "boxed", qty: 100_000, boxes: 8_333, pieces: 4 }]),
    ).resolves.not.toThrow();
    expect(h.wrote()).toBe(true);
  });

  it("pin: a plain qty of 100,000 on a product with no pack is accepted", async () => {
    const h = await entry.boot();
    await expect(h.run([{ productId: "single", qty: 100_000 }])).resolves.not.toThrow();
    expect(h.wrote()).toBe(true);
  });
});

describe("OrdersController.create: staff are not capped by the buyer rule", () => {
  it.each(["OPERATOR", "DRIVER"] as const)(
    "pin: %s create at 240,000 pieces (20,000 boxes of 12) reaches the service, with no pack lookup",
    async (role) => {
      const h = await staffJwtCreate(role)();
      await h.run([{ productId: "boxed", qty: 1, boxes: 20_000, pieces: 0 }]);
      expect(h.ordersService.create).toHaveBeenCalledTimes(1);
      expect(h.ordersService.liveUnitsPerBoxByProduct).not.toHaveBeenCalled();
    },
  );
});

describe("assertBuyerCreateItemsWithinCap", () => {
  const packs = new Map([["boxed", 12]]);

  it("skips a line with no productId (an unlisted line is refused by create itself)", () => {
    expect(() =>
      assertBuyerCreateItemsWithinCap(
        [{ productId: undefined, qty: 100_000, boxes: 100_000 }],
        packs,
      ),
    ).not.toThrow();
  });

  it("a product the pack map does not return counts as a pack of 1", () => {
    expect(() =>
      assertBuyerCreateItemsWithinCap([{ productId: "other", qty: 100_000 }], packs),
    ).not.toThrow();
    expect(() =>
      assertBuyerCreateItemsWithinCap([{ productId: "other", qty: 100_001 }], packs),
    ).toThrow(BadRequestException);
  });

  it("every line is a new line: there is no rise-only allowance on create", () => {
    expect(() =>
      assertBuyerCreateItemsWithinCap([{ productId: "boxed", qty: 9_000 }], packs),
    ).toThrow(BadRequestException);
  });

  it("no items is nothing to check", () => {
    expect(() => assertBuyerCreateItemsWithinCap(undefined, packs)).not.toThrow();
    expect(() => assertBuyerCreateItemsWithinCap([], packs)).not.toThrow();
  });
});

/**
 * Evidence for "a CUSTOMER cannot author a `unitLabel` line on create": the buyer DTO has no such field (the global
 * pipe is whitelist + forbidNonWhitelisted), and the staff-JWT create resolves units only for staff, before any write.
 */
describe("a CUSTOMER cannot send a unit (unitLabel) line on create", () => {
  it("assertMayUseUnits refuses any non-staff unit request before a ladder is read or a line is built", async () => {
    await expect(
      assertMayUseUnits([{ productId: "boxed", unitLabel: "Case" }], {
        isStaff: false,
        tenantId: "tenant-xyz",
        hasFlag: async () => true,
      }),
    ).rejects.toThrow("Only staff can choose a selling unit on an order line.");
  });

  it("a blank unitLabel is the pack (no unit request), so it is the plain-qty case the cap already covers", async () => {
    await expect(
      assertMayUseUnits([{ productId: "boxed", unitLabel: "" }], {
        isStaff: false,
        tenantId: "tenant-xyz",
        hasFlag: async () => false,
      }),
    ).resolves.toBeUndefined();
  });
});
