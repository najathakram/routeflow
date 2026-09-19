import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";

/**
 * LANE-U step 6 — `InventoryService.updatePurchaseOrder` (PATCH purchase-orders/:id).
 * Mock-level proof of the state table + operation order; the real-stock equality
 * proof (edit → re-apply == a fresh receive of the edited lines) lives in
 * inventory.po-edit.db.spec.ts.
 */

const D = (n: number | string) => new Prisma.Decimal(n);

const poLine = (o: Record<string, unknown> = {}) => ({
  id: "poi-1",
  poId: "po-1",
  productId: "prod-1",
  qtyOrdered: D(10),
  qtyReceived: D(10),
  unitCost: D(3),
  totalCost: D(30),
  sku: null,
  packSize: null,
  ...o,
});

const po = (o: Record<string, unknown> = {}) => ({
  id: "po-1",
  poNumber: "PO-2026-0001",
  supplierId: "sup-1",
  status: "RECEIVED",
  items: [poLine()],
  ...o,
});

const product = (o: Record<string, unknown> = {}) => ({
  id: "prod-1",
  name: "Widget",
  currentStock: D(10),
  averageCost: D(3),
  costingMethod: "AVCO",
  ...o,
});

const movement = (o: Record<string, unknown> = {}) => ({
  id: "mv-1",
  productId: "prod-1",
  quantity: D(10),
  unitCost: D(3),
  ...o,
});

describe("InventoryService.updatePurchaseOrder (LANE-U step 6)", () => {
  let service: InventoryService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let lock: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    lock = jest.fn().mockResolvedValue(0);
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({ ...prisma, $executeRaw: lock }),
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
      ],
    }).compile();
    service = module.get(InventoryService);

    prisma.purchaseOrder.update.mockResolvedValue({});
    prisma.purchaseOrder.findUniqueOrThrow.mockResolvedValue({ id: "po-1" });
    prisma.product.findMany.mockResolvedValue([{ id: "prod-1" }, { id: "prod-2" }]);
    prisma.product.findUnique.mockResolvedValue(product());
    prisma.stockMovement.findMany.mockResolvedValue([movement()]);
    prisma.stockLot.findMany.mockResolvedValue([
      { id: "lot-1", qty: D(10), remainingQty: D(10), notes: null },
    ]);
  });

  const stockWrites = () => [
    prisma.stockMovement.create,
    prisma.stockMovement.deleteMany,
    prisma.stockLot.create,
    prisma.stockLot.delete,
    prisma.stockLot.update,
    prisma.product.update,
  ];
  const expectNoStockWrites = () => {
    for (const fn of stockWrites()) expect(fn).not.toHaveBeenCalled();
  };
  const nestedItems = () => prisma.purchaseOrder.update.mock.calls[0][0].data.items;

  // ─── guards ────────────────────────────────────────────────────────────────

  it("locks the PO row before reading it", async () => {
    prisma.purchaseOrder.findUnique.mockResolvedValue(po({ status: "DRAFT" }));
    await service.updatePurchaseOrder("po-1", { notes: "hi" }, "user-1");
    expect(lock).toHaveBeenCalledTimes(1);
    expect(String((lock.mock.calls[0][0] as TemplateStringsArray).join("?"))).toMatch(
      /FROM "PurchaseOrder" WHERE id = \? FOR UPDATE/,
    );
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.purchaseOrder.findUnique.mock.invocationCallOrder[0],
    );
  });

  it("receivePurchaseOrder takes the same row lock", async () => {
    prisma.purchaseOrder.findUnique.mockResolvedValue(
      po({ status: "SENT", items: [poLine({ qtyReceived: D(0) })] }),
    );
    await service.receivePurchaseOrder(
      "po-1",
      { items: [{ itemId: "poi-1", receivedQty: 4 }] },
      "u",
    );
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.purchaseOrder.findUnique.mock.invocationCallOrder[0],
    );
  });

  it("404s a missing PO and rejects a CLOSED one", async () => {
    prisma.purchaseOrder.findUnique.mockResolvedValueOnce(null);
    await expect(service.updatePurchaseOrder("po-x", { notes: "a" }, "u")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.purchaseOrder.findUnique.mockResolvedValueOnce(po({ status: "CLOSED" }));
    await expect(service.updatePurchaseOrder("po-1", { notes: "a" }, "u")).rejects.toThrow(
      /closed/,
    );
  });

  it("refuses a line edit on a received PO unless reapplyInventory is stated", async () => {
    prisma.purchaseOrder.findUnique.mockResolvedValue(po());
    await expect(
      service.updatePurchaseOrder(
        "po-1",
        { items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 3 }] },
        "u",
      ),
    ).rejects.toThrow(/reapplyInventory/);
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
    expectNoStockWrites();
  });

  it("refuses an empty line set and an unknown line id / product", async () => {
    prisma.purchaseOrder.findUnique.mockResolvedValue(po({ status: "DRAFT" }));
    await expect(service.updatePurchaseOrder("po-1", { items: [] }, "u")).rejects.toThrow(
      /At least one item/,
    );
    await expect(
      service.updatePurchaseOrder(
        "po-1",
        { items: [{ id: "someone-elses", productId: "prod-1", qtyOrdered: 1, unitCost: 1 }] },
        "u",
      ),
    ).rejects.toThrow(/does not belong/);
    await expect(
      service.updatePurchaseOrder(
        "po-1",
        { items: [{ productId: "ghost", qtyOrdered: 1, unitCost: 1 }] },
        "u",
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ─── DRAFT / SENT: free edit, no stock ─────────────────────────────────────

  it("DRAFT: edits lines freely, rounds the money, keeps status, touches no stock", async () => {
    prisma.purchaseOrder.findUnique.mockResolvedValue(
      po({ status: "DRAFT", items: [poLine({ qtyReceived: D(0) })] }),
    );
    await service.updatePurchaseOrder(
      "po-1",
      {
        items: [
          {
            id: "poi-1",
            productId: "prod-1",
            qtyOrdered: 12.5,
            unitCost: 1.1,
            sku: "W-1",
            packSize: 12,
          },
          { productId: "prod-2", qtyOrdered: 3, unitCost: 0.333 },
        ],
      },
      "u",
    );
    const data = prisma.purchaseOrder.update.mock.calls[0][0].data;
    // 12.5 × 1.1 = 13.75 (13.750000000000002 in float) and 3 × 0.333 = 1 (0.999): each line rounded first
    expect(data.totalAmount).toBe(14.75);
    expect(data.status).toBe("DRAFT");
    expect(data.items.update[0]).toMatchObject({
      where: { id: "poi-1" },
      data: { qtyOrdered: 12.5, unitCost: 1.1, totalCost: 13.75, sku: "W-1", packSize: 12 },
    });
    expect(data.items.create[0]).toMatchObject({ productId: "prod-2", sku: null, packSize: null });
    expect(data.items.create[0].qtyReceived.toString()).toBe("0");
    expectNoStockWrites();
  });

  it("removes a line the payload omits", async () => {
    prisma.purchaseOrder.findUnique.mockResolvedValue(
      po({
        status: "SENT",
        items: [poLine({ qtyReceived: D(0) }), poLine({ id: "poi-2", qtyReceived: D(0) })],
      }),
    );
    await service.updatePurchaseOrder(
      "po-1",
      { items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 3 }] },
      "u",
    );
    expect(nestedItems().deleteMany).toEqual({ id: { in: ["poi-2"] } });
  });

  it("a header-only edit of a received PO needs no reapplyInventory and writes no lines", async () => {
    prisma.purchaseOrder.findUnique.mockResolvedValue(po());
    await service.updatePurchaseOrder("po-1", { notes: "Dock 3", expectedDate: null }, "u");
    expect(prisma.purchaseOrder.update.mock.calls[0][0].data).toEqual({
      notes: "Dock 3",
      expectedDate: null,
    });
    expectNoStockWrites();
  });

  // ─── PARTIAL / RECEIVED, document-only ─────────────────────────────────────

  describe("reapplyInventory: false (document-only)", () => {
    it("changes cost/qty at or above what was received without touching stock", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      await service.updatePurchaseOrder(
        "po-1",
        {
          reapplyInventory: false,
          items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 12, unitCost: 5 }],
        },
        "u",
      );
      const data = prisma.purchaseOrder.update.mock.calls[0][0].data;
      expect(data.items.update[0].data.qtyReceived.toString()).toBe("10");
      expect(data.items.update[0].data.totalCost).toBe(60);
      // ordered 12 > received 10 → no longer fully received
      expect(data.status).toBe("PARTIAL");
      expectNoStockWrites();
    });

    it("rejects lowering a line below what was received", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      await expect(
        service.updatePurchaseOrder(
          "po-1",
          {
            reapplyInventory: false,
            items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 8, unitCost: 3 }],
          },
          "u",
        ),
      ).rejects.toThrow(/already received/);
      expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
    });

    it("rejects re-pointing a received line at another product, and removing it", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      await expect(
        service.updatePurchaseOrder(
          "po-1",
          {
            reapplyInventory: false,
            items: [{ id: "poi-1", productId: "prod-2", qtyOrdered: 10, unitCost: 3 }],
          },
          "u",
        ),
      ).rejects.toThrow(/change product/);
      await expect(
        service.updatePurchaseOrder(
          "po-1",
          {
            reapplyInventory: false,
            items: [{ productId: "prod-2", qtyOrdered: 4, unitCost: 2 }],
          },
          "u",
        ),
      ).rejects.toThrow(/can't be removed/);
      expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
    });

    it("refuses a supplier change without re-applying", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.supplier.findUnique.mockResolvedValue({ id: "sup-2" });
      await expect(
        service.updatePurchaseOrder("po-1", { supplierId: "sup-2", reapplyInventory: false }, "u"),
      ).rejects.toThrow(/supplier/);
    });
  });

  // ─── PARTIAL / RECEIVED, re-apply ──────────────────────────────────────────

  describe("reapplyInventory: true", () => {
    it("RECEIVED: reverses movements + lots + stock, then re-receives the edit in full — in that order", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      await service.updatePurchaseOrder(
        "po-1",
        {
          reapplyInventory: true,
          items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 8, unitCost: 4 }],
        },
        "user-9",
      );

      // reversal
      expect(prisma.stockMovement.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["mv-1"] } },
      });
      expect(prisma.stockLot.delete).toHaveBeenCalledWith({ where: { id: "lot-1" } });
      const reversal = prisma.product.update.mock.calls[0][0].data;
      expect(reversal.currentStock.decrement.toString()).toBe("10");
      // reversing the only receipt empties stock → the average is KEPT, not zeroed
      expect(reversal.averageCost).toBeUndefined();

      // edit: received target = the new ordered qty; status stays RECEIVED
      const data = prisma.purchaseOrder.update.mock.calls[0][0].data;
      expect(data.items.update[0].data.qtyReceived.toString()).toBe("8");
      expect(data.totalAmount).toBe(32);
      expect(data.status).toBe("RECEIVED");

      // re-post: 8 pieces @ the EDITED cost, same reference, the caller's id
      const created = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(created).toMatchObject({
        productId: "prod-1",
        type: "PURCHASE",
        reference: "PO-2026-0001",
        supplierId: "sup-1",
        performedById: "user-9",
      });
      expect(created.quantity.toString()).toBe("8");
      expect(created.unitCost.toString()).toBe("4");
      expect(prisma.stockLot.create.mock.calls[0][0].data.qty.toString()).toBe("8");
      const repost = prisma.product.update.mock.calls[1][0].data;
      expect(repost.currentStock.increment.toString()).toBe("8");

      // order: reverse → edit → re-post
      const at = (fn: jest.Mock, n = 0) => fn.mock.invocationCallOrder[n];
      expect(at(prisma.stockMovement.deleteMany as jest.Mock)).toBeLessThan(
        at(prisma.purchaseOrder.update as jest.Mock),
      );
      expect(at(prisma.purchaseOrder.update as jest.Mock)).toBeLessThan(
        at(prisma.stockMovement.create as jest.Mock),
      );
    });

    it("a STANDARD product's average is never moved by the reversal", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.product.findUnique.mockResolvedValue(
        product({ costingMethod: "STANDARD", currentStock: D(25), averageCost: D(2) }),
      );
      await service.updatePurchaseOrder(
        "po-1",
        {
          reapplyInventory: true,
          items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 9 }],
        },
        "u",
      );
      for (const call of prisma.product.update.mock.calls) {
        expect(call[0].data.averageCost).toBeUndefined();
      }
    });

    it("restates the average exactly when other stock remains (inverse of the weighted average)", async () => {
      // 10 pcs @ $2 on hand, then this PO received 10 @ $4 → 20 pcs @ $3.
      prisma.purchaseOrder.findUnique.mockResolvedValue(
        po({ items: [poLine({ unitCost: D(4) })] }),
      );
      prisma.stockMovement.findMany.mockResolvedValue([movement({ unitCost: D(4) })]);
      prisma.product.findUnique.mockResolvedValue(
        product({ currentStock: D(20), averageCost: D(3) }),
      );
      await service.updatePurchaseOrder(
        "po-1",
        {
          reapplyInventory: true,
          items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 4 }],
        },
        "u",
      );
      const reversal = prisma.product.update.mock.calls[0][0].data;
      expect(reversal.currentStock.decrement.toString()).toBe("10");
      expect(reversal.averageCost.toString()).toBe("2");
    });

    it("PARTIAL: re-posts only what each surviving line had received, capped at its new ordered qty", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(
        po({ status: "PARTIAL", items: [poLine({ qtyOrdered: D(10), qtyReceived: D(4) })] }),
      );
      prisma.stockMovement.findMany.mockResolvedValue([movement({ quantity: D(4) })]);
      prisma.stockLot.findMany.mockResolvedValue([
        { id: "lot-1", qty: D(4), remainingQty: D(4), notes: null },
      ]);
      await service.updatePurchaseOrder(
        "po-1",
        {
          reapplyInventory: true,
          items: [
            { id: "poi-1", productId: "prod-1", qtyOrdered: 3, unitCost: 3 },
            { productId: "prod-2", qtyOrdered: 5, unitCost: 2 },
          ],
        },
        "u",
      );
      const data = prisma.purchaseOrder.update.mock.calls[0][0].data;
      expect(data.items.update[0].data.qtyReceived.toString()).toBe("3"); // min(4, 3)
      expect(data.items.create[0].qtyReceived.toString()).toBe("0"); // new line: nothing received
      expect(data.status).toBe("PARTIAL"); // the new line is still outstanding
      expect(prisma.stockMovement.create).toHaveBeenCalledTimes(1);
      expect(prisma.stockMovement.create.mock.calls[0][0].data.quantity.toString()).toBe("3");
    });

    it("a consumed lot surrenders what remains instead of being deleted", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.stockLot.findMany.mockResolvedValue([
        { id: "lot-1", qty: D(10), remainingQty: D(6), notes: null },
      ]);
      await service.updatePurchaseOrder(
        "po-1",
        {
          reapplyInventory: true,
          items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 3 }],
        },
        "u",
      );
      expect(prisma.stockLot.delete).not.toHaveBeenCalled();
      expect(prisma.stockLot.update).toHaveBeenCalledWith({
        where: { id: "lot-1" },
        data: { remainingQty: 0, notes: "(PO edited; 4 already consumed)" },
      });
    });

    it("a supplier change re-posts under the new supplier", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.supplier.findUnique.mockResolvedValue({ id: "sup-2" });
      await service.updatePurchaseOrder(
        "po-1",
        {
          supplierId: "sup-2",
          reapplyInventory: true,
          items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 3 }],
        },
        "u",
      );
      expect(prisma.stockMovement.create.mock.calls[0][0].data.supplierId).toBe("sup-2");
      expect(prisma.purchaseOrder.update.mock.calls[0][0].data.supplierId).toBe("sup-2");
    });

    it("refuses — writing nothing — when the movements on record do not match the lines' receipts", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.stockMovement.findMany.mockResolvedValue([movement({ quantity: D(6) })]);
      await expect(
        service.updatePurchaseOrder(
          "po-1",
          {
            reapplyInventory: true,
            items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 3 }],
          },
          "u",
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
      expectNoStockWrites();
    });
  });
});
