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

async function edit(line: any, patch: any, more?: { line: any; patch: any }) {
  const prisma = createMockPrisma();
  wireStockHelper(prisma);
  prisma.purchaseOrder.findUnique.mockResolvedValue({
    id: "po-1",
    poNumber: "PO-2026-0001",
    supplierId: "sup-1",
    status: "SENT",
    items: more ? [line, more.line] : [line],
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
      {
        items: [
          { id: "poi-1", productId: "prod-1", unitCost: 3, ...patch },
          ...(more ? [{ id: more.line.id, productId: "prod-1", unitCost: 3, ...more.patch }] : []),
        ],
      } as any,
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
    expect(r.message).toBe(
      '"Soda" comes in packs of 6. Use a whole number of packs, or remove the line and add it again.',
    ); // the one shared text, pinned
  });

  it("R2': a labelled line sent pack 4 keeps its stored pack 6 (SA-1238 A2)", async () => {
    const r = await edit(stored(), { qtyOrdered: 12, packSize: 4 });
    expect(r.status).toBeUndefined();
    expect(r.update).toMatchObject({ packSize: 6, qtyOrdered: 12 });
  });

  it("R6: a '1 Piece' line with no pack, sent pack 6 and qty 9, keeps its null pack", async () => {
    const piece = stored({ unitLabel: "1 Piece", packSize: null });
    const r = await edit(piece, { qtyOrdered: 9, packSize: 6 });
    expect(r.status).toBeUndefined();
    expect(r.update).toMatchObject({ packSize: null, qtyOrdered: 9 });
  });

  it("R7: an explicit null pack on a labelled 6-piece line keeps pack 6", async () => {
    const r = await edit(stored(), { qtyOrdered: 12, packSize: null });
    expect(r.status).toBeUndefined();
    expect(r.update.packSize).toBe(6);
    // the next edit, from the stored result: 7 pieces of a 6-piece lot is still refused
    const next = await edit(stored({ packSize: r.update.packSize }), { qtyOrdered: 7 });
    expect(next).toMatchObject({ status: 400, code: "LOT_QTY_NOT_WHOLE" });
  });

  it("R9: an untouched legacy part lot does not block the other lines; only a change is judged", async () => {
    const legacy = stored({ qtyOrdered: D(9) });
    const other = stored({ id: "poi-2", unitLabel: null, packSize: null, qtyOrdered: D(10) });
    const keep = { qtyOrdered: 9 };
    expect(
      (await edit(legacy, keep, { line: other, patch: { qtyOrdered: 11 } })).status,
    ).toBeUndefined();
    expect(
      (await edit(legacy, { qtyOrdered: 12 }, { line: other, patch: { qtyOrdered: 10 } })).status,
    ).toBeUndefined();
    expect(
      (await edit(legacy, { qtyOrdered: 10 }, { line: other, patch: { qtyOrdered: 10 } })).code,
    ).toBe("LOT_QTY_NOT_WHOLE");
  });

  it("R8': an unlabelled line is no lot, so null to 6 takes qty 9 and 12 alike (observed)", async () => {
    const plain = stored({ unitLabel: null, packSize: null });
    expect((await edit(plain, { qtyOrdered: 9, packSize: 6 })).update.packSize).toBe(6);
    expect((await edit(plain, { qtyOrdered: 12, packSize: 6 })).status).toBeUndefined();
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
