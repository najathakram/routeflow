import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { wireStockHelper } from "./testing/stock-helper-mock";

/**
 * SA-1227 MEDIUM-2: a PO line that carries a lot (label and pack above 1) is received in whole packs,
 * through the same assertWholeLotReceive the bill uses. A plain case line (no label) still takes any piece qty.
 */
const D = (n: number) => new Prisma.Decimal(n);
const line = (over: any = {}) => ({
  id: "poi-1",
  productId: "prod-1",
  qtyOrdered: D(12),
  qtyReceived: D(0),
  unitCost: D(3),
  packSize: 6,
  unitLabel: "6 Pieces",
  ...over,
});

async function receive(item: any, recv: any) {
  const prisma = createMockPrisma();
  wireStockHelper(prisma);
  const po = {
    id: "po-1",
    poNumber: "PO-2026-0001",
    supplierId: "sup-1",
    status: "SENT",
    items: [item],
  };
  // The post-receive re-read (status roll-up) sees the received quantity.
  const after = { ...po, items: [{ ...item, qtyReceived: D(recv.receivedQty ?? 0) }] };
  prisma.purchaseOrder.findUnique.mockResolvedValueOnce(po).mockResolvedValue(after);
  prisma.purchaseOrder.update.mockResolvedValue({ id: "po-1", status: "PARTIAL" });
  prisma.purchaseOrderItem.update.mockResolvedValue({});
  prisma.product.findUnique.mockResolvedValue({
    id: "prod-1",
    name: "Soda",
    currentStock: D(5),
    averageCost: D(2),
    costingMethod: "AVCO",
    unitsPerBox: null,
  });
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
  const service = mod.get(InventoryService);
  jest.spyOn(service, "fireStockAlerts").mockImplementation(() => undefined);
  const e: any = await service
    .receivePurchaseOrder("po-1", { items: [{ id: "poi-1", ...recv }] } as any, "u1")
    .then(
      () => null,
      (x) => x,
    );
  return {
    status: e?.getStatus?.(),
    code: e?.getResponse?.()?.code,
    message: e?.getResponse?.()?.message,
    lots: prisma.stockLot.create.mock.calls.length,
    itemUpdates: prisma.purchaseOrderItem.update.mock.calls.length,
    poStatus: prisma.purchaseOrder.update.mock.calls.at(-1)?.[0]?.data?.status,
  };
}

describe("receivePurchaseOrder: a lot line is received in whole packs (SA-1227 MEDIUM-2)", () => {
  it("3 pieces of a 6-piece lot is 400 RECEIVE_PARTIAL_UNIT and posts no stock", async () => {
    const r = await receive(line(), { receivedQty: 3 });
    expect(r).toMatchObject({ status: 400, code: "RECEIVE_PARTIAL_UNIT", lots: 0, itemUpdates: 0 });
    expect(r.message).toBe(
      '"Soda" is one unit of 6 pieces and can\'t be received in part. Add it again as a new line in whole packs, save, then remove this line.',
    );
    expect(await receive(line(), { boxes: 1, pieces: 3 })).toMatchObject({
      status: 400,
      code: "RECEIVE_PARTIAL_UNIT",
      lots: 0,
      itemUpdates: 0,
    });
  });

  it("green: 6 pieces (one whole pack) and 12 pieces receive", async () => {
    expect((await receive(line(), { receivedQty: 6 })).status).toBeUndefined();
    expect((await receive(line(), { receivedQty: 12 })).status).toBeUndefined();
  });

  it("R3 leg: a line edited 12 to 18 pieces receives 18 and the PO is RECEIVED", async () => {
    const r = await receive(line({ qtyOrdered: D(18) }), { receivedQty: 18 });
    expect(r).toMatchObject({ status: undefined, poStatus: "RECEIVED" });
  });

  it("R2' leg: an edited-then-carried 6 Pieces/6 line takes whole packs and refuses a part pack", async () => {
    expect((await receive(line(), { receivedQty: 12 })).status).toBeUndefined();
    expect((await receive(line(), { receivedQty: 4 })).code).toBe("RECEIVE_PARTIAL_UNIT");
  });

  it("R6 leg: a carried 1 Piece line (no pack) receives its 9 pieces", async () => {
    const piece = line({ unitLabel: "1 Piece", packSize: null, qtyOrdered: D(9) });
    expect((await receive(piece, { receivedQty: 9 })).status).toBeUndefined();
  });

  it("green: a case line (pack, no label) still takes any piece qty", async () => {
    expect((await receive(line({ unitLabel: null }), { receivedQty: 3 })).status).toBeUndefined();
  });
});
