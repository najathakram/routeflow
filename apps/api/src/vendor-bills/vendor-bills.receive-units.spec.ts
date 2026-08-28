import { Test, TestingModule } from "@nestjs/testing";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { Prisma } from "@prisma/client";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { StorageService } from "../storage/storage.service";
import { InventoryService } from "../inventory/inventory.service";
import { ProductAliasService } from "../import/product-alias.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * PR-5 (WP6) — server-side equivalence spec for the boxes/pieces toggle.
 *
 * `vendor-bills.service.spec.ts` already pins `lineInventoryDelta` behaviour
 * line by line (G2 etc.); the client-side `scan-line-units.ts` unit specs
 * (WP1) pin `toBillLine`'s pure conversion. Neither proves that a line the
 * operator denominated in BOXES and the SAME line denominated in PIECES move
 * identical money and stock once they hit the API — which is the actual
 * failure mode of the #335/#336 corruption class (a Boxes line posted
 * without `packSize` books 1 piece at $30 instead of 24 at $1.25).
 *
 * This file pins that invariant directly: receiving `{qty:1, unitCost:30,
 * packSize:24}` and `{qty:24, unitCost:1.25, packSize:null}` — the same 24
 * pieces at $1.25/piece, quoted two ways — must produce IDENTICAL
 * `stockMovement`/`stockLot`/`Product` writes on receive, and IDENTICAL
 * reversals on revertToDraft/voidBill.
 */

// VendorBillsService imports these at module scope for scanInvoice(); mock
// them so loading the service here never reaches a real SDK/native binary.
// receive/revertToDraft/voidBill never call either — mirrors
// vendor-bills.service.spec.ts's mocking style.
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn(() => ({ messages: { create: jest.fn() } })),
}));
jest.mock("sharp", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    rotate: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: jest.fn(),
  })),
}));

const D = (n: number | string) => new Prisma.Decimal(n);

/** The same 24 pieces @ $1.25/piece, quoted in BOXES on the supplier invoice. */
const BOXED_ITEM = { qty: D(1), unitCost: D(30), packSize: 24 as number | null };
/** The same 24 pieces @ $1.25/piece, quoted in PIECES on the supplier invoice. */
const PIECE_ITEM = { qty: D(24), unitCost: D(1.25), packSize: null as number | null };

const linkedItem = (overrides: Record<string, unknown> = {}) => ({
  id: "item-1",
  productId: "prod-1",
  description: "Widget 24pk",
  qty: D(1),
  unitCost: D(30),
  packSize: null as number | null,
  qtyReceived: null as Prisma.Decimal | null,
  product: { id: "prod-1", name: "Widget 24pk", currentStock: D(0), averageCost: null },
  ...overrides,
});

const bill = (overrides: Record<string, unknown> = {}) => ({
  id: "bill-1",
  billNumber: "BILL-2026-0042",
  supplierId: "sup-1",
  status: "DRAFT",
  billDate: new Date("2026-06-01"),
  receivedDate: null as Date | null,
  items: [linkedItem()],
  supplier: { id: "sup-1", name: "Acme Supply" },
  ...overrides,
});

/** Fresh service + prisma mock per call — the two denominations never share state. */
async function makeService(): Promise<{
  service: VendorBillsService;
  prisma: ReturnType<typeof createMockPrisma>;
}> {
  const prisma = createMockPrisma();
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      VendorBillsService,
      { provide: PrismaService, useValue: prisma },
      {
        provide: PlatformConfigService,
        useValue: {
          resolveAnthropicKey: jest.fn().mockResolvedValue(null),
          recordAiUsage: jest.fn(),
        },
      },
      { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
      {
        provide: DuplicateMatchService,
        useValue: {
          normalizeNumber: (raw: string) => (raw ?? "").toUpperCase().replace(/\s+/g, ""),
          findVendorBillDuplicate: jest.fn().mockResolvedValue(null),
          findScanDuplicate: jest.fn().mockResolvedValue(null),
        },
      },
      { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
      {
        provide: InventoryService,
        useValue: { recomputeProductInTx: jest.fn(), fireStockAlerts: jest.fn() },
      },
      // receive/revertToDraft/voidBill never touch alias resolution — a bare
      // stub is enough to satisfy the constructor (added by WP2).
      {
        provide: ProductAliasService,
        useValue: { resolveMany: jest.fn(), learn: jest.fn(), unlearn: jest.fn() },
      },
    ],
  }).compile();
  return { service: module.get<VendorBillsService>(VendorBillsService), prisma };
}

/** Receive one line (boxed or piece-denominated) against a product with the given starting state. */
async function receiveLine(
  item: Record<string, unknown>,
  startingProduct: { currentStock: Prisma.Decimal; averageCost: Prisma.Decimal | null },
) {
  const { service, prisma } = await makeService();
  prisma.vendorBill.findUnique.mockResolvedValueOnce(bill({ items: [linkedItem(item)] }));
  prisma.product.findFirst.mockResolvedValue({ ...startingProduct, costingMethod: "AVCO" });

  await service.receive("bill-1", undefined, "user-1");

  const movement: any = prisma.stockMovement.create.mock.calls[0][0].data;
  const lot: any = prisma.stockLot.create.mock.calls[0][0].data;
  const product: any = prisma.product.update.mock.calls[0][0].data;
  return {
    movementType: movement.type as string,
    movementQty: movement.quantity.toString(),
    movementUnitCost: movement.unitCost.toString(),
    movementAvgCostAfter: movement.avgCostAfter.toString(),
    movementStockAfter: movement.stockAfter.toString(),
    lotQty: lot.qty.toString(),
    lotRemainingQty: lot.remainingQty.toString(),
    lotUnitCost: lot.unitCost.toString(),
    productStockIncrement: product.currentStock.increment.toString(),
    productAverageCost:
      product.averageCost === undefined ? undefined : product.averageCost.toString(),
  };
}

/** Revert a fully-received line (boxed or piece-denominated) back to DRAFT. */
async function revertLine(
  item: Record<string, unknown>,
  receivedQty: Prisma.Decimal,
  postReceiveProduct: { currentStock: Prisma.Decimal; averageCost: Prisma.Decimal | null },
) {
  const { service, prisma } = await makeService();
  prisma.vendorBill.findUnique.mockResolvedValue(
    bill({
      status: "RECEIVED",
      receivedDate: new Date("2026-06-02"),
      items: [linkedItem({ ...item, qtyReceived: receivedQty })],
    }),
  );
  prisma.product.findFirst.mockResolvedValue(postReceiveProduct);
  prisma.stockLot.findMany.mockResolvedValue([]);

  await service.revertToDraft("bill-1");

  const deleteArgs: any = prisma.stockMovement.deleteMany.mock.calls[0][0];
  const product: any = prisma.product.update.mock.calls[0][0].data;
  return {
    deleteType: deleteArgs.where.type as string,
    productStockDecrement: product.currentStock.decrement.toString(),
    productAverageCost:
      product.averageCost === undefined ? undefined : product.averageCost.toString(),
  };
}

/** Void a fully-received line (boxed or piece-denominated). */
async function voidLine(
  item: Record<string, unknown>,
  receivedQty: Prisma.Decimal,
  postReceiveProduct: { currentStock: Prisma.Decimal; averageCost: Prisma.Decimal | null },
) {
  const { service, prisma } = await makeService();
  prisma.vendorBill.findUnique.mockResolvedValue(
    bill({
      status: "RECEIVED",
      receivedDate: new Date("2026-06-02"),
      items: [linkedItem({ ...item, qtyReceived: receivedQty })],
    }),
  );
  prisma.product.findFirst.mockResolvedValue(postReceiveProduct);
  prisma.stockLot.findMany.mockResolvedValue([]);

  await service.voidBill("bill-1", "user-1");

  const movement: any = prisma.stockMovement.create.mock.calls[0][0].data;
  const product: any = prisma.product.update.mock.calls[0][0].data;
  return {
    movementType: movement.type as string,
    movementQty: movement.quantity.toString(),
    movementUnitCost: movement.unitCost.toString(),
    movementAvgCostAfter: movement.avgCostAfter.toString(),
    movementStockAfter: movement.stockAfter.toString(),
    productStockDecrement: product.currentStock.decrement.toString(),
    productAverageCost:
      product.averageCost === undefined ? undefined : product.averageCost.toString(),
  };
}

describe("VendorBillsService — receive-path denomination equivalence (WP6)", () => {
  describe("receive()", () => {
    it("moves IDENTICAL stock + AVCO for the boxed and piece denominations, from an empty product", async () => {
      const zeroStart = { currentStock: D(0), averageCost: null };
      const boxed = await receiveLine(BOXED_ITEM, zeroStart);
      const pieces = await receiveLine(PIECE_ITEM, zeroStart);

      expect(boxed).toEqual(pieces);

      // Pin the actual numbers too — a shared conversion bug that made BOTH
      // denominations equally wrong would still pass a bare mutual-equality
      // check. 1 case of 24 @ $30/case === 24 pieces @ $1.25/piece.
      expect(boxed.movementType).toBe("PURCHASE");
      expect(boxed.movementQty).toBe("24");
      expect(boxed.movementUnitCost).toBe("1.25");
      expect(boxed.movementAvgCostAfter).toBe("1.25");
      expect(boxed.movementStockAfter).toBe("24");
      expect(boxed.lotQty).toBe("24");
      expect(boxed.lotUnitCost).toBe("1.25");
      expect(boxed.productStockIncrement).toBe("24");
      expect(boxed.productAverageCost).toBe("1.25");
    });

    it("stays IDENTICAL when blended into existing stock — not just the trivial zero-stock reset", async () => {
      const existingStock = { currentStock: D(10), averageCost: D(2) };
      const boxed = await receiveLine(BOXED_ITEM, existingStock);
      const pieces = await receiveLine(PIECE_ITEM, existingStock);

      expect(boxed).toEqual(pieces);

      // (10×2 + 24×1.25) / 34 = 50/34 = 1.470588... → 1.4706 (4dp half-up).
      expect(boxed.movementAvgCostAfter).toBe("1.4706");
      expect(boxed.movementStockAfter).toBe("34");
      expect(boxed.productAverageCost).toBe("1.4706");
      expect(boxed.productStockIncrement).toBe("24");
    });
  });

  describe("revertToDraft()", () => {
    it("reverses each denomination by the exact same stock + AVCO delta receive() applied", async () => {
      // Both lines were received as 24 pieces @ $1.25/piece from empty stock
      // (averageCost reset to 1.25) — reverting must drain exactly that back out.
      const postReceive = { currentStock: D(24), averageCost: D(1.25) };
      const boxed = await revertLine(BOXED_ITEM, BOXED_ITEM.qty, postReceive);
      const pieces = await revertLine(PIECE_ITEM, PIECE_ITEM.qty, postReceive);

      expect(boxed).toEqual(pieces);
      expect(boxed.deleteType).toBe("PURCHASE");
      expect(boxed.productStockDecrement).toBe("24");
      // Reversal empties stock (24 - 24 = 0) — average is KEPT, not zeroed.
      expect(boxed.productAverageCost).toBeUndefined();
    });
  });

  describe("voidBill()", () => {
    it("posts an IDENTICAL compensating ADJUSTMENT for each denomination", async () => {
      const postReceive = { currentStock: D(24), averageCost: D(1.25) };
      const boxed = await voidLine(BOXED_ITEM, BOXED_ITEM.qty, postReceive);
      const pieces = await voidLine(PIECE_ITEM, PIECE_ITEM.qty, postReceive);

      expect(boxed).toEqual(pieces);
      expect(boxed.movementType).toBe("ADJUSTMENT");
      expect(boxed.movementQty).toBe("-24");
      expect(boxed.movementUnitCost).toBe("1.25");
      // Reversal empties stock → average carried forward, not zeroed.
      expect(boxed.movementAvgCostAfter).toBe("1.25");
      expect(boxed.movementStockAfter).toBe("0");
      expect(boxed.productStockDecrement).toBe("24");
      expect(boxed.productAverageCost).toBeUndefined();
    });
  });
});
