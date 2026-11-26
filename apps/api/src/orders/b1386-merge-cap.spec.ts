/**
 * B1386 (REG-B1386 M1-M3, supersedes SA-1285 section 3 "the cart fold does not cap"): POST /buyer/orders folds a
 * cart into the buyer's open order, and the fold writes ABSOLUTE totals, so repeated carts used to grow one line
 * with no bound. The controller now caps each folded line on the piece total the replace write will store,
 * rise-only against the line it merges into, before `updateOrderItems` is called. `pairEditLines` stays uncapped
 * (see the P3 pin in buyer-edit-lines.b1386.spec.ts): the cap lives here. Synthetic data only.
 */
jest.mock("../common/db-locks", () => ({
  LockTimeoutError: class LockTimeoutError extends Error {},
  LockUnavailableError: class LockUnavailableError extends Error {},
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { oversellReaderOffProvider } from "./testing/policy-reader-provider";
import { BuyerController } from "../buyer/buyer.controller";
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
import { OrdersService } from "./orders.service";
import { ChangeRequestsService } from "./change-requests.service";
import { BUYER_LINE_QTY_OVER_MAX_MESSAGE } from "./buyer-line-cap";
import { assertFoldedBuyerLinesWithinCap } from "./buyer-edit-lines";

const CTX = {
  customerId: "cust-1",
  tenantId: "tenant-xyz",
  tenantSlug: "acme",
  userId: null,
  customer: { id: "cust-1", businessName: "Acme Buyer" },
};

/** Live packs: `boxed` is a 12-pack; `single` and `other` have none. */
const PACKS = [
  { id: "boxed", unitsPerBox: 12 },
  { id: "single", unitsPerBox: null },
  { id: "other", unitsPerBox: null },
];

const plainLine = (id: string, productId: string, qty: number) => ({
  id,
  productId,
  qty,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitPrice: 10,
  priceType: "STANDARD",
});

const boxLine = (id: string, productId: string, boxes: number, pack = 12) => ({
  id,
  productId,
  qty: boxes * pack,
  boxes,
  pieces: 0,
  unitsPerBox: pack,
  unitPrice: 10,
  priceType: "STANDARD",
});

async function boot(
  lineItems: object[],
  reads: { packs?: typeof PACKS; firstRead?: typeof PACKS } = {},
) {
  const svc = {
    findActiveOrder: jest
      .fn()
      .mockResolvedValue({ id: "ord-open", customerId: "cust-1", lineItems }),
    findOrderIdByIdempotencyKey: jest.fn().mockResolvedValue(null),
    replayMergeReconcile: jest.fn(),
    liveTrioByProduct: jest.fn().mockResolvedValue(new Map()),
    updateOrderItems: jest.fn().mockResolvedValue({ id: "ord-open", lineItems: [] }),
    recordIdempotencyKey: jest.fn(),
    applyBuyerMergeHeader: jest.fn(),
    mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: "ord-new", customerId: "cust-1", lineItems: [] }),
    findOne: jest.fn().mockResolvedValue({ id: "ord-open", customerId: "cust-1", lineItems: [] }),
  };
  const prisma = createMockPrisma();
  prisma.forTenant().product.findMany.mockResolvedValue(reads.packs ?? PACKS);
  // the FIRST product read of createOrder is the pre-lock cap read; the in-lock read follows
  if (reads.firstRead) prisma.forTenant().product.findMany.mockResolvedValueOnce(reads.firstRead);
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
    svc,
    merge: (items: object[]) => controller.createOrder({ items } as never, CTX as never),
  };
}

const expectRefusedUnwritten = async (
  h: Awaited<ReturnType<typeof boot>>,
  items: object[],
  productId: string,
) => {
  const err = await h.merge(items).then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(BadRequestException);
  expect((err as BadRequestException).getResponse()).toEqual({
    code: "BUYER_LINE_QTY_OVER_MAX",
    message: BUYER_LINE_QTY_OVER_MAX_MESSAGE,
    productIds: [productId],
  });
  expect(h.svc.updateOrderItems).not.toHaveBeenCalled();
  expect(h.svc.applyBuyerMergeHeader).not.toHaveBeenCalled();
  expect(h.svc.create).not.toHaveBeenCalled();
};

describe("BuyerController.createOrder: the fold into an open order is capped (REG-B1386 M1-M3)", () => {
  it("REG-B1386 M1: a stored 60,000-piece line + an incoming 60,000 is a coded 400, nothing written", async () => {
    const h = await boot([plainLine("L1", "single", 60_000)]);
    await expectRefusedUnwritten(h, [{ productId: "single", qty: 60_000 }], "single");
  });

  it("REG-B1386 M2: repeated merges: a stored 90,000 + an incoming 20,000 is a coded 400, nothing written", async () => {
    const h = await boot([plainLine("L1", "single", 90_000)]);
    await expectRefusedUnwritten(h, [{ productId: "single", qty: 20_000 }], "single");
  });

  it("REG-B1386 M3: a 12-pack box line holding 8,000 boxes + an incoming 400 boxes (100,800 pieces) is a coded 400", async () => {
    const h = await boot([boxLine("L1", "boxed", 8_000)]);
    await expectRefusedUnwritten(
      h,
      [{ productId: "boxed", qty: 4_800, boxes: 400, pieces: 0 }],
      "boxed",
    );
  });

  it("M4: a pack line (no split) of 8,000 packs of 12 + 400 packs is refused too (100,800 pieces)", async () => {
    const h = await boot([plainLine("L1", "boxed", 8_000)]);
    await expectRefusedUnwritten(h, [{ productId: "boxed", qty: 400 }], "boxed");
  });

  it("pin: a stored 50,000 + an incoming 50,000 (exactly 100,000) is accepted and written", async () => {
    const h = await boot([plainLine("L1", "single", 50_000)]);
    await h.merge([{ productId: "single", qty: 50_000 }]);
    expect(h.svc.updateOrderItems).toHaveBeenCalledTimes(1);
    const written = h.svc.updateOrderItems.mock.calls[0][1].items as Array<{ qty: number }>;
    expect(written.map((i) => Number(i.qty))).toEqual([100_000]);
  });

  it("pin: 7,000 stored packs of 12 + 1,333 (8,333 packs, 99,996 pieces) is accepted", async () => {
    const h = await boot([plainLine("L1", "boxed", 7_000)]);
    await h.merge([{ productId: "boxed", qty: 1_333 }]);
    expect(h.svc.updateOrderItems).toHaveBeenCalledTimes(1);
  });

  it("pin: a stored 120,000 line (pre-fix) stays editable: a cart for another product is accepted and the line is resent unchanged", async () => {
    const h = await boot([plainLine("L1", "single", 120_000)]);
    await h.merge([{ productId: "other", qty: 5 }]);
    expect(h.svc.updateOrderItems).toHaveBeenCalledTimes(1);
    const written = h.svc.updateOrderItems.mock.calls[0][1].items as Array<{
      productId: string;
      qty: number;
    }>;
    expect(written.find((i) => i.productId === "single")?.qty).toBe(120_000);
  });

  it("the same stored 120,000 line may not be RAISED by a cart for its own product", async () => {
    const h = await boot([plainLine("L1", "single", 120_000)]);
    await expectRefusedUnwritten(h, [{ productId: "single", qty: 1 }], "single");
  });

  it("pin: a merge into a different product's line is independent (90,000 of one product, 20,000 of another)", async () => {
    const h = await boot([plainLine("L1", "single", 90_000)]);
    await h.merge([{ productId: "other", qty: 20_000 }]);
    expect(h.svc.updateOrderItems).toHaveBeenCalledTimes(1);
  });
});

describe("the fold's packs (L1-d, L2-d)", () => {
  it("L1-d: a repack: a split item is counted at the pack the fold resolved (the line's own 12), not today's live 6", () => {
    // Through the controller a bare add into a repacked line is refused by the fold itself (MERGE_PACK_MISMATCH, 409), so the
    // two packs only meet in the helper: the line holds 8,400 boxes of 12 = 100,800 pieces, which a live pack of 6 would
    // read as 50,400.
    const stored = [boxLine("L1", "boxed", 8_000, 12)];
    const folded = {
      productId: "boxed",
      qty: 100_800,
      boxes: 8_400,
      pieces: 0,
      unitsPerBox: 12,
      sourceLineId: "L1",
    };
    expect(() =>
      assertFoldedBuyerLinesWithinCap([folded], stored, new Map([["boxed", 6]])),
    ).toThrow(BadRequestException);
    // an item with no resolved pack falls back to the live one (the fold's own deferral to updateOrderItems)
    expect(() =>
      assertFoldedBuyerLinesWithinCap(
        [{ ...folded, unitsPerBox: undefined, qty: 0 }],
        stored,
        new Map([["boxed", 6]]),
      ),
    ).not.toThrow();
  });

  it("L2-d: the in-lock pack read wins over the pre-lock cap read", async () => {
    // pre-lock read says a pack of 6, the in-lock read (the one the fold uses) says 12: 8,400 packs of 12 = 100,800
    const h = await boot([plainLine("L1", "boxed", 8_000)], {
      firstRead: [{ id: "boxed", unitsPerBox: 6 }],
    });
    await expectRefusedUnwritten(h, [{ productId: "boxed", qty: 400 }], "boxed");
  });
});

describe("assertFoldedBuyerLinesWithinCap (the pure piece logic)", () => {
  const stored = [plainLine("L1", "boxed", 8_000), boxLine("L2", "other", 100, 12)];
  const packs = new Map([
    ["boxed", 12],
    ["other", 12],
  ]);

  it("counts a pack line (no split) in packs and its stored side the same way (rise-only)", () => {
    expect(() =>
      assertFoldedBuyerLinesWithinCap(
        [{ productId: "boxed", qty: 8_000, sourceLineId: "L1" }],
        stored,
        packs,
      ),
    ).not.toThrow();
    expect(() =>
      assertFoldedBuyerLinesWithinCap(
        [{ productId: "boxed", qty: 8_400, sourceLineId: "L1" }],
        stored,
        packs,
      ),
    ).toThrow(BadRequestException);
  });

  it("an item with a split counts boxes x pack + pieces at the pack the fold resolved", () => {
    const split = (boxes: number, pieces: number) => ({
      productId: "other",
      qty: boxes * 12 + pieces,
      boxes,
      pieces,
      unitsPerBox: 12,
      sourceLineId: "L2",
    });
    expect(() => assertFoldedBuyerLinesWithinCap([split(8_400, 0)], stored, packs)).toThrow(
      BadRequestException,
    );
    expect(() => assertFoldedBuyerLinesWithinCap([split(8_333, 4)], stored, packs)).not.toThrow();
  });

  it("a split with no resolved pack falls back to the live pack (the fold's live-pack deferral)", () => {
    expect(() =>
      assertFoldedBuyerLinesWithinCap(
        [{ productId: "other", qty: 0, boxes: 9_000, pieces: 0 }],
        [],
        packs,
      ),
    ).toThrow(BadRequestException);
  });

  it("a new bucket (no sourceLineId) has stored pieces 0, and an unlisted item is skipped", () => {
    expect(() =>
      assertFoldedBuyerLinesWithinCap([{ productId: "x", qty: 100_001 }], [], new Map()),
    ).toThrow(BadRequestException);
    expect(() =>
      assertFoldedBuyerLinesWithinCap([{ name: "Setup fee", qty: 999_999 }], [], new Map()),
    ).not.toThrow();
  });
});
