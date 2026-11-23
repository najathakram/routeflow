import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { wireStockHelper } from "./testing/stock-helper-mock";

/**
 * SA-1238 M1: a PO edit is a lot write path too. An existing labelled line ("6 Pieces", pack 6) keeps its
 * whole-pack quantity (the bill's assertWholeLotQty, on the RESULTING row) and its pack (a re-pack is the
 * bill's locked refusal). Entry: the linked bill is voided, so the line edit is open.
 */
const D = (n: number) => new Prisma.Decimal(n);
const stored = (over: any = {}) => ({
  id: "poi-1",
  poId: "po-1",
  productId: "prod-1",
  qtyOrdered: D(12),
  qtyReceived: D(0),
  unitCost: D(3),
  totalCost: D(36),
  sku: null,
  packSize: 6,
  unitLabel: "6 Pieces",
  ...over,
});

async function edit(line: any, patch: any) {
  const prisma = createMockPrisma();
  wireStockHelper(prisma);
  prisma.purchaseOrder.findUnique.mockResolvedValue({
    id: "po-1",
    poNumber: "PO-2026-0001",
    supplierId: "sup-1",
    status: "SENT",
    items: [line],
  });
  prisma.vendorBill.findFirst.mockResolvedValue(null); // the linked bill is void
  prisma.purchaseOrder.update.mockResolvedValue({});
  prisma.purchaseOrder.findUniqueOrThrow.mockResolvedValue({ id: "po-1" });
  prisma.product.findMany.mockResolvedValue([{ id: "prod-1", name: "Soda", kind: "SIMPLE" }]);
  const mod = await Test.createTestingModule({
    providers: [
      InventoryService,
      { provide: PrismaService, useValue: prisma },
      {
        provide: StockAlertService,
        useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
      },
    ],
  }).compile();
  const e: any = await mod
    .get(InventoryService)
    .updatePurchaseOrder(
      "po-1",
      { items: [{ id: "poi-1", productId: "prod-1", unitCost: 3, ...patch }] } as any,
      "u1",
    )
    .then(
      () => null,
      (x) => x,
    );
  return {
    status: e?.getStatus?.(),
    code: e?.getResponse?.()?.code,
    message: e?.getResponse?.()?.message,
    update: prisma.purchaseOrder.update.mock.calls[0]?.[0]?.data?.items?.update?.[0]?.data,
  };
}

describe("updatePurchaseOrder: a labelled lot line (SA-1238 M1)", () => {
  it("R1: 12 to 9 pieces of a 6-piece lot is 400 LOT_QTY_NOT_WHOLE and writes nothing", async () => {
    const r = await edit(stored(), { qtyOrdered: 9 });
    expect(r).toMatchObject({ status: 400, code: "LOT_QTY_NOT_WHOLE", update: undefined });
  });

  it("R2: re-packing the labelled line 6 to 4 is refused like a bill re-pack (409)", async () => {
    const r = await edit(stored(), { qtyOrdered: 12, packSize: 4 });
    expect(r).toEqual({
      status: 409,
      code: "SPLIT_LINE_LOCKED",
      message:
        "A pack line's pack size can't change. Remove the line and add it again in whole packs.",
      update: undefined,
    });
  });

  it("R3: 12 to 18 pieces (3 whole packs) is accepted and written", async () => {
    const r = await edit(stored(), { qtyOrdered: 18 });
    expect(r.status).toBeUndefined();
    expect(Number(r.update.qtyOrdered)).toBe(18);
  });

  it("G1: an unlabelled line takes any quantity and any pack, as before", async () => {
    const plain = stored({ unitLabel: null });
    expect((await edit(plain, { qtyOrdered: 9 })).status).toBeUndefined();
    expect((await edit(plain, { qtyOrdered: 9, packSize: 4 })).status).toBeUndefined();
  });
});
