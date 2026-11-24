import { readFileSync } from "fs";
import { join } from "path";
import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { wireStockHelper } from "./testing/stock-helper-mock";

/**
 * W-1318 (SA-1236 M2): the server refuses a FAMILY product on every PO write path (create, bill-raised draft,
 * edit) and on receive. The client list is never the only guard (L-305). Receive matters for a PO line written
 * before the guard existed: it must not post a StockLot or movement against a container product.
 */
const D = (n: number) => new Prisma.Decimal(n);
const FAMILY = { id: "fam-1", name: "Soda Family", kind: "FAMILY" };

async function build(prisma: ReturnType<typeof createMockPrisma>) {
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
  return service;
}

const outcome = (e: any) => ({
  status: e?.getStatus?.(),
  code: e?.getResponse?.()?.code,
  productIds: e?.getResponse?.()?.productIds,
});

describe("PO writers refuse a FAMILY product (W-1318)", () => {
  it("create: 400 FAMILY_NOT_SELLABLE and no PO row", async () => {
    const prisma = createMockPrisma();
    prisma.supplier.findUnique.mockResolvedValue({ id: "sup-1" });
    prisma.product.findMany.mockResolvedValue([FAMILY]);
    const service = await build(prisma);
    const e = await service
      .createPurchaseOrder(
        { supplierId: "sup-1", items: [{ productId: FAMILY.id, qty: 1, unitCost: 1 }] } as any,
        "u1",
      )
      .catch((x) => x);
    expect(outcome(e)).toEqual({
      status: 400,
      code: "FAMILY_NOT_SELLABLE",
      productIds: ["fam-1"],
    });
    expect(prisma.purchaseOrder.create).not.toHaveBeenCalled();
  });

  it("receive: a FAMILY line is 400 FAMILY_NOT_SELLABLE and posts no lot, no item update", async () => {
    const prisma = createMockPrisma();
    wireStockHelper(prisma);
    const item = {
      id: "poi-1",
      productId: FAMILY.id,
      qtyOrdered: D(6),
      qtyReceived: D(0),
      unitCost: D(2),
      packSize: null,
      unitLabel: null,
    };
    const po = {
      id: "po-1",
      poNumber: "PO-2026-0001",
      supplierId: "sup-1",
      status: "SENT",
      items: [item],
    };
    prisma.purchaseOrder.findUnique.mockResolvedValueOnce(po).mockResolvedValue(po);
    prisma.purchaseOrder.update.mockResolvedValue({ id: "po-1", status: "PARTIAL" });
    prisma.purchaseOrderItem.update.mockResolvedValue({});
    prisma.product.findUnique.mockResolvedValue({
      ...FAMILY,
      currentStock: D(0),
      averageCost: null,
      costingMethod: "AVCO",
      unitsPerBox: null,
    });
    const service = await build(prisma);
    const e = await service
      .receivePurchaseOrder("po-1", { items: [{ id: "poi-1", receivedQty: 6 }] } as any, "u1")
      .catch((x) => x);
    expect({
      ...outcome(e),
      lots: prisma.stockLot.create.mock.calls.length,
      itemUpdates: prisma.purchaseOrderItem.update.mock.calls.length,
    }).toEqual({
      status: 400,
      code: "FAMILY_NOT_SELLABLE",
      productIds: ["fam-1"],
      lots: 0,
      itemUpdates: 0,
    });
  });

  it("inventory pin: every PO write method calls assertSellableLines (a new PO write path cannot skip it)", () => {
    const src = readFileSync(join(__dirname, "inventory.service.ts"), "utf8");
    const body = (name: string): string => {
      const start = src.search(new RegExp(`\\n  (?:async )?${name}\\(`));
      expect(start).toBeGreaterThan(-1);
      const next = src.slice(start + 1).search(/\n {2}(?:private |public )?(?:async )?\w+\(/);
      return src.slice(start, next < 0 ? undefined : start + 1 + next);
    };
    for (const m of [
      "createPurchaseOrder",
      "createDraftPurchaseOrderInTx",
      "updatePurchaseOrder",
      "receivePurchaseOrder",
    ]) {
      expect({ method: m, guarded: /assertSellableLines\(/.test(body(m)) }).toEqual({
        method: m,
        guarded: true,
      });
    }
    // every method that writes a purchaseOrderItem or posts a PO receipt is one of the four above
    const writers = [
      ...src.matchAll(
        /\n  (?:private )?(?:async )?(\w+)\([^)]*[\s\S]*?(?=\n  (?:private |public )?(?:async )?\w+\()/g,
      ),
    ]
      .filter((m) =>
        /purchaseOrderItem\.(?:create|update)|postPoReceipt\(|items:\s*\{\s*create/.test(m[0]),
      )
      .map((m) => m[1])
      .filter((n) => n !== "postPoReceipt");
    expect(new Set(writers)).toEqual(
      new Set([
        "createPurchaseOrder",
        "createDraftPurchaseOrderInTx",
        "updatePurchaseOrder",
        "receivePurchaseOrder",
      ]),
    );
  });
});

// R-60 F2: web and mobile send every PO line, zeros included. A legacy FAMILY line at qty 0 receives nothing,
// so it is skipped like any qty-0 line and the rest of the PO receives; only a FAMILY line with qty > 0 is refused.
describe("receive: a FAMILY line is refused only when it receives stock (W-1318, R-60 F2)", () => {
  const VARIANT = { id: "var-1", name: "Soda Cola", kind: "VARIANT" };
  const line = (id: string, productId: string) => ({
    id,
    productId,
    qtyOrdered: D(6),
    qtyReceived: D(0),
    unitCost: D(2),
    packSize: null,
    unitLabel: null,
  });

  async function receiveMixed(variantQty: number, familyQty: number) {
    const prisma = createMockPrisma();
    wireStockHelper(prisma);
    const items = [line("poi-v", VARIANT.id), line("poi-f", FAMILY.id)];
    const po = {
      id: "po-1",
      poNumber: "PO-2026-0001",
      supplierId: "sup-1",
      status: "SENT",
      items,
    };
    prisma.purchaseOrder.findUnique.mockResolvedValueOnce(po).mockResolvedValue(po);
    prisma.purchaseOrder.update.mockResolvedValue({ id: "po-1", status: "PARTIAL" });
    prisma.purchaseOrderItem.update.mockResolvedValue({});
    prisma.product.findUnique.mockImplementation(async (a: any) => ({
      ...(a.where.id === FAMILY.id ? FAMILY : VARIANT),
      currentStock: D(0),
      averageCost: null,
      costingMethod: "AVCO",
      unitsPerBox: null,
    }));
    const service = await build(prisma);
    const e = await service
      .receivePurchaseOrder(
        "po-1",
        {
          items: [
            { id: "poi-v", receivedQty: variantQty },
            { id: "poi-f", receivedQty: familyQty },
          ],
        } as any,
        "u1",
      )
      .catch((x) => x);
    return {
      code: e?.getResponse?.()?.code,
      lots: prisma.stockLot.create.mock.calls.length,
      updatedItemIds: prisma.purchaseOrderItem.update.mock.calls.map((c: any) => c[0].where.id),
    };
  }

  it("a FAMILY line at qty 0 is skipped and the variant line still receives", async () => {
    expect(await receiveMixed(5, 0)).toEqual({
      code: undefined,
      lots: 1,
      updatedItemIds: ["poi-v"],
    });
  });

  it("a FAMILY line at qty > 0 is still refused: 400 FAMILY_NOT_SELLABLE, and the PO fails as a whole", async () => {
    const r = await receiveMixed(5, 3);
    expect(r.code).toBe("FAMILY_NOT_SELLABLE");
    // the variant line ran first in the same transaction; the throw rolls it back (the tx helper is mocked here)
    expect(r.updatedItemIds).toEqual(["poi-v"]);
  });
});
