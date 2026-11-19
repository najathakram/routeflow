// REG-B639: stock-lot reversal was keyed on the free-text reference, so a vendor bill numbered like a default lot reference
// ("ADJUSTMENT") deleted or zeroed unrelated lots when it was unreceived or voided. reverseBillLots now matches each receipt row
// by (productId, reference, qty, unit cost, purchaseDate) through lotShapeWhere, one lot per receipt. The wrong value is any lot
// other than the bill's own receipt lot being deleted or zeroed.
import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { StorageService } from "../storage/storage.service";
import { InventoryService } from "../inventory/inventory.service";
import { ProductAliasService } from "../import/product-alias.service";
import { createMockPrisma } from "../testing/prisma-mock";

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
type Row = Record<string, any>;

/** A tiny where-matcher for the lot lookups: equality, Decimal and Date compares, OR. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Row[]).some((w) => matches(row, w));
    const v = row[key];
    if (cond === undefined) return true;
    if (cond === null) return v == null;
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    if (Prisma.Decimal.isDecimal(cond) || typeof cond === "number") {
      return v != null && D(v).eq(cond as Prisma.Decimal.Value);
    }
    return v === cond;
  });
}

const BILL_DATE = new Date("2026-09-15T00:00:00.000Z");
const lot = (id: string, over: Row = {}): Row => ({
  id,
  productId: "p1",
  reference: "ADJUSTMENT", // the bill number a user typed, equal to the default adjustment reference
  qty: D(10),
  remainingQty: D(10),
  unitCost: D(2),
  purchaseDate: BILL_DATE,
  notes: null,
  ...over,
});

async function build(lots: Row[]) {
  const prisma = createMockPrisma();
  const module = await Test.createTestingModule({
    providers: [
      VendorBillsService,
      { provide: PrismaService, useValue: prisma },
      { provide: PlatformConfigService, useValue: {} },
      { provide: SystemConfigService, useValue: { get: jest.fn(), getAll: jest.fn() } },
      { provide: DuplicateMatchService, useValue: {} },
      { provide: StorageService, useValue: {} },
      { provide: InventoryService, useValue: {} },
      { provide: ProductAliasService, useValue: {} },
    ],
  }).compile();
  const tx = {
    stockLot: {
      findMany: jest.fn(async ({ where }: any) => lots.filter((l) => matches(l, where))),
      delete: jest.fn(async () => ({})),
      update: jest.fn(async () => ({})),
    },
    // nothing left the product after the receipt
    stockMovement: { findMany: jest.fn(async () => []) },
  };
  const reverse = (
    billNumber: string,
    action: "reverted to draft" | "voided" = "reverted to draft",
  ) =>
    (module.get(VendorBillsService) as any).reverseBillLots(
      tx,
      billNumber,
      [
        {
          id: "mv-1",
          productId: "p1",
          name: "Widget",
          quantity: D(10),
          unitCost: D(2),
          effectiveAt: BILL_DATE,
          supplierId: "sup-1",
          createdAt: BILL_DATE,
        },
      ],
      BILL_DATE,
      action,
    );
  return { tx, reverse };
}

describe("REG-B639: a bill number equal to a default lot reference reverses only the bill's own lot", () => {
  const unrelated = () => [
    lot("adj-other-qty", { qty: D(3), remainingQty: D(3) }),
    lot("adj-other-cost", { unitCost: D(5) }),
    lot("adj-other-product", { productId: "p2" }),
    lot("adj-other-date", { purchaseDate: new Date("2026-07-01T00:00:00.000Z") }),
    lot("adj-other-reference", { reference: "ADJUSTMENT-2" }),
  ];

  it.each(["reverted to draft", "voided"] as const)(
    "REG-B639: unreceiving (%s) a bill numbered ADJUSTMENT deletes its own lot and touches no unrelated adjustment lot",
    async (action) => {
      const { tx, reverse } = await build([lot("bill-lot"), ...unrelated()]);
      await reverse("ADJUSTMENT", action);
      expect(tx.stockLot.delete).toHaveBeenCalledTimes(1);
      expect(tx.stockLot.delete).toHaveBeenCalledWith({ where: { id: "bill-lot" } });
      expect(tx.stockLot.update).not.toHaveBeenCalled();
    },
  );

  it("REG-B639: with no lot of the bill's own shape, nothing at all is deleted or zeroed", async () => {
    const { tx, reverse } = await build(unrelated());
    await reverse("ADJUSTMENT");
    expect(tx.stockLot.delete).not.toHaveBeenCalled();
    expect(tx.stockLot.update).not.toHaveBeenCalled();
  });
});
