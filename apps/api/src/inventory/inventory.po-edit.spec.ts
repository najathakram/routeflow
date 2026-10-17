import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PRODUCT_LOCK_RANK_SQL } from "../common/product-locks";
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

const movement = (o: Record<string, unknown> = {}) => {
  const createdAt = (o.createdAt as Date | undefined) ?? new Date("2026-08-01T00:00:00.000Z");
  return {
    id: "mv-1",
    productId: "prod-1",
    type: "PURCHASE",
    quantity: D(10),
    unitCost: D(3),
    supplierId: "sup-1",
    notes: null as string | null,
    createdAt,
    effectiveAt: createdAt, // the accounting date (B562); a receipt's equals its insertion time here
    ...o,
  };
};

const lot = (o: Record<string, unknown> = {}) => ({
  id: "lot-1",
  productId: "prod-1",
  qty: D(10),
  remainingQty: D(10),
  notes: null as string | null,
  purchaseDate: new Date("2026-08-01T00:00:00.000Z"),
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
      // The helper's lock_timeout default (SA-767 r-note 2 (c); a set_config) is not a lock statement: `lock` sees only those.
      fn({
        ...prisma,
        $executeRaw: (strings: TemplateStringsArray, ...rest: unknown[]) =>
          /set_config\('lock_timeout'/.test(strings.join("?"))
            ? Promise.resolve(0)
            : lock(strings, ...rest),
      }),
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
    prisma.stockLot.findMany.mockResolvedValue([lot()]);
  });

  const stockWrites = () => [
    prisma.stockMovement.create,
    prisma.stockMovement.deleteMany,
    prisma.stockLot.create,
    prisma.stockLot.delete,
    prisma.stockLot.deleteMany,
    prisma.stockLot.update,
    prisma.product.update,
  ];
  const expectNoStockWrites = () => {
    for (const fn of stockWrites()) expect(fn).not.toHaveBeenCalled();
  };
  const sql = (n: number) => String((lock.mock.calls[n][0] as TemplateStringsArray).join("?"));
  const nestedItems = () => prisma.purchaseOrder.update.mock.calls[0][0].data.items;

  // ─── guards ────────────────────────────────────────────────────────────────

  it("locks the PO row before reading it", async () => {
    prisma.purchaseOrder.findUnique.mockResolvedValue(po({ status: "DRAFT" }));
    await service.updatePurchaseOrder("po-1", { notes: "hi" }, "user-1");
    // header-only edit: just the PO row lock - and it is tenant-scoped
    expect(lock).toHaveBeenCalledTimes(1);
    expect(sql(0)).toMatch(/FROM "PurchaseOrder" WHERE id = \? AND "tenantId" = \? FOR UPDATE/);
    expect(lock.mock.calls[0].slice(1)).toEqual(["po-1", "test-tenant"]);
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
    // PO row first (before the read), then the product it will restock
    expect(lock).toHaveBeenCalledTimes(2);
    expect(sql(0)).toMatch(/"PurchaseOrder".*FOR UPDATE/);
    expect(sql(1)).toMatch(/"Product"[\s\S]*FOR UPDATE/);
    // SA-767 L-1: one tenant-filtered statement, (tenantId, ids)
    expect(lock.mock.calls[1].slice(1)).toEqual(["test-tenant", ["prod-1"], PRODUCT_LOCK_RANK_SQL]);
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.purchaseOrder.findUnique.mock.invocationCallOrder[0],
    );
    // a plain receive stamps no date - the movement defaults to now()
    expect(prisma.stockMovement.create.mock.calls[0][0].data).not.toHaveProperty("createdAt");
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
    // nested creates get no tenantId from the tenant proxy - it must be explicit
    expect(data.items.create[0].tenantId).toBe("test-tenant");
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

  // ─── PARTIAL / RECEIVED: rules that hold for BOTH modes ────────────────────

  describe.each([false, true])(
    "received-line guards (reapplyInventory: %s)",
    (reapplyInventory) => {
      it("refuses lowering a line below what was received — a return is the only way out", async () => {
        prisma.purchaseOrder.findUnique.mockResolvedValue(po());
        await expect(
          service.updatePurchaseOrder(
            "po-1",
            {
              reapplyInventory,
              items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 8, unitCost: 3 }],
            },
            "u",
          ),
        ).rejects.toThrow(/already received.*recording a return/);
        expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
        expectNoStockWrites();
      });

      it("refuses re-pointing a received line at another product, and removing it", async () => {
        prisma.purchaseOrder.findUnique.mockResolvedValue(po());
        await expect(
          service.updatePurchaseOrder(
            "po-1",
            {
              reapplyInventory,
              items: [{ id: "poi-1", productId: "prod-2", qtyOrdered: 10, unitCost: 3 }],
            },
            "u",
          ),
        ).rejects.toThrow(/change product/);
        await expect(
          service.updatePurchaseOrder(
            "po-1",
            { reapplyInventory, items: [{ productId: "prod-2", qtyOrdered: 4, unitCost: 2 }] },
            "u",
          ),
        ).rejects.toThrow(/can't be removed/);
        expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
        expectNoStockWrites();
      });
    },
  );

  // ─── PARTIAL / RECEIVED, document-only ─────────────────────────────────────

  describe("reapplyInventory: false (document-only)", () => {
    it("changes cost and raises qty without touching stock — the extra qty is outstanding", async () => {
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
    const movementCalls = () => prisma.stockMovement.create.mock.calls.map((c: any) => c[0].data);

    it("RECEIVED: compensates the receipt (never deletes it), then re-posts the SAME quantity at the edited cost — in that order", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      await service.updatePurchaseOrder(
        "po-1",
        {
          reapplyInventory: true,
          items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 4 }],
        },
        "user-9",
      );

      // the ledger is append-only: nothing deleted, one compensating (negative) PURCHASE + one PURCHASE
      expect(prisma.stockMovement.deleteMany).not.toHaveBeenCalled();
      const [comp, repost] = movementCalls();
      expect(comp).toMatchObject({
        productId: "prod-1",
        type: "PURCHASE", // SA-808 §5: the filing sums signed PURCHASE rows
        reference: "PO-2026-0001",
        supplierId: "sup-1",
        performedById: "user-9",
        notes: "PO edit reversal — reverses mv-1",
      });
      expect(comp.quantity.toString()).toBe("-10");
      expect(comp.unitCost.toString()).toBe("3"); // the ORIGINAL cost is what is reversed
      expect(comp.stockAfter.toString()).toBe("0");
      expect(repost).toMatchObject({
        productId: "prod-1",
        type: "PURCHASE",
        reference: "PO-2026-0001",
        supplierId: "sup-1",
        performedById: "user-9",
      });
      expect(repost.quantity.toString()).toBe("10");
      expect(repost.unitCost.toString()).toBe("4");
      // the re-post is stamped now and strictly AFTER its compensation (the cost replay orders by
      // effectiveAt, then createdAt, then a random id); both book at the receipt's own date
      // (SA-808 §5) so the pair lands in one month — see inventory.po-edit-reversal.spec.ts
      expect(repost.createdAt).toBeInstanceOf(Date);
      expect(repost.createdAt.getTime()).toBeGreaterThan(comp.createdAt.getTime());
      expect(Math.abs(repost.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
      expect(comp.effectiveAt).toEqual(new Date("2026-08-01T00:00:00.000Z"));
      expect(repost.effectiveAt).toEqual(comp.effectiveAt);

      // stock + lot
      const reversal = prisma.product.update.mock.calls[0][0].data;
      expect(reversal.currentStock.decrement.toString()).toBe("10");
      expect(reversal.averageCost).toBeUndefined(); // empties stock → average KEPT, not zeroed
      expect(prisma.stockLot.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["lot-1"] } } });
      expect(prisma.stockLot.create.mock.calls[0][0].data.qty.toString()).toBe("10");
      expect(prisma.product.update.mock.calls[1][0].data.currentStock.increment.toString()).toBe(
        "10",
      );

      // edit: received quantity is exactly what was received; status stays RECEIVED
      const data = prisma.purchaseOrder.update.mock.calls[0][0].data;
      expect(data.items.update[0].data.qtyReceived.toString()).toBe("10");
      expect(data.totalAmount).toBe(40);
      expect(data.status).toBe("RECEIVED");

      // order: compensate → edit → re-post
      const at = (fn: jest.Mock, n = 0) => fn.mock.invocationCallOrder[n];
      expect(at(prisma.stockMovement.create as jest.Mock, 0)).toBeLessThan(
        at(prisma.purchaseOrder.update as jest.Mock),
      );
      expect(at(prisma.purchaseOrder.update as jest.Mock)).toBeLessThan(
        at(prisma.stockMovement.create as jest.Mock, 1),
      );
    });

    it("B583: a partly-consumed FIFO/LIFO lot refuses the re-apply (409) — nothing is written, no stock is invented", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.stockLot.findMany.mockResolvedValue([lot({ remainingQty: D(6) })]); // 4 already sold
      const err: any = await service
        .updatePurchaseOrder(
          "po-1",
          {
            reapplyInventory: true,
            items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 4 }],
          },
          "u",
        )
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: "PO_LOT_PARTIALLY_CONSUMED",
        lotIds: ["lot-1"],
      });
      expect(err.getResponse().message).toMatch(/document-only/);
      expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
      expectNoStockWrites();
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    });

    it("B583: the refusal is by ANY lot — a fully-consumed one (remaining 0) refuses too", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.stockLot.findMany.mockResolvedValue([lot({ remainingQty: D(0) })]);
      await expect(
        service.updatePurchaseOrder(
          "po-1",
          {
            reapplyInventory: true,
            items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 4 }],
          },
          "u",
        ),
      ).rejects.toMatchObject({ response: { code: "PO_LOT_PARTIALLY_CONSUMED" } });
      expectNoStockWrites();
    });

    it("refuses a regulated product — writing nothing", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.product.findFirst.mockResolvedValueOnce({ name: "Cigars" });
      await expect(
        service.updatePurchaseOrder(
          "po-1",
          {
            reapplyInventory: true,
            items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 4 }],
          },
          "u",
        ),
      ).rejects.toThrow(/regulated product/);
      expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
      expectNoStockWrites();
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    });

    it("a raised qtyOrdered and an added line are OUTSTANDING — no stock the old movements don't prove", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      await service.updatePurchaseOrder(
        "po-1",
        {
          reapplyInventory: true,
          items: [
            { id: "poi-1", productId: "prod-1", qtyOrdered: 15, unitCost: 3 },
            { productId: "prod-2", qtyOrdered: 5, unitCost: 2 },
          ],
        },
        "u",
      );
      const data = prisma.purchaseOrder.update.mock.calls[0][0].data;
      expect(data.items.update[0].data.qtyReceived.toString()).toBe("10"); // NOT 15
      expect(data.items.create[0].qtyReceived.toString()).toBe("0"); // the added line: nothing arrived
      expect(data.status).toBe("PARTIAL"); // a RECEIVED PO with outstanding qty is PARTIAL
      // one compensation + one re-post, both for prod-1 — nothing for prod-2
      expect(movementCalls().map((m: any) => `${m.type}:${m.productId}`)).toEqual([
        "PURCHASE:prod-1", // the compensation (negative)
        "PURCHASE:prod-1", // the re-post
      ]);
      expect(prisma.stockLot.create).toHaveBeenCalledTimes(1);
    });

    it("PARTIAL: reverses and re-posts exactly what was received (4), whatever the new ordered qty", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(
        po({ status: "PARTIAL", items: [poLine({ qtyOrdered: D(10), qtyReceived: D(4) })] }),
      );
      prisma.stockMovement.findMany.mockResolvedValue([movement({ quantity: D(4) })]);
      prisma.stockLot.findMany.mockResolvedValue([lot({ qty: D(4), remainingQty: D(4) })]);
      await service.updatePurchaseOrder(
        "po-1",
        {
          reapplyInventory: true,
          items: [
            { id: "poi-1", productId: "prod-1", qtyOrdered: 12, unitCost: 5 },
            { productId: "prod-2", qtyOrdered: 5, unitCost: 2 },
          ],
        },
        "u",
      );
      const data = prisma.purchaseOrder.update.mock.calls[0][0].data;
      expect(data.items.update[0].data.qtyReceived.toString()).toBe("4");
      expect(data.items.create[0].qtyReceived.toString()).toBe("0");
      expect(data.status).toBe("PARTIAL");
      const [comp, repost] = movementCalls();
      expect(comp.quantity.toString()).toBe("-4");
      expect(repost.quantity.toString()).toBe("4");
      expect(repost.unitCost.toString()).toBe("5");
    });

    it("a second re-apply reverses only the LIVE receipt — a receipt an earlier re-apply already compensated is not reversed again", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      // history after ONE earlier re-apply: original 10@3 (mv-1) + its compensation (mv-2) + the re-post 10@4 (mv-3)
      prisma.stockMovement.findMany.mockResolvedValue([
        movement({ id: "mv-3", unitCost: D(4), createdAt: new Date("2026-09-02T00:00:00Z") }),
        movement({
          id: "mv-2",
          type: "ADJUSTMENT",
          quantity: D(-10),
          notes: "PO edit reversal — reverses mv-1",
          createdAt: new Date("2026-09-01T00:00:00Z"),
        }),
        movement({ id: "mv-1", createdAt: new Date("2026-08-01T00:00:00Z") }),
      ]);
      await service.updatePurchaseOrder(
        "po-1",
        {
          reapplyInventory: true,
          items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 5 }],
        },
        "u",
      );
      const [comp] = movementCalls();
      expect(comp.notes).toBe("PO edit reversal — reverses mv-3"); // the live one only
      expect(comp.quantity.toString()).toBe("-10");
      expect(comp.unitCost.toString()).toBe("4");
      expect(prisma.product.update.mock.calls[0][0].data.currentStock.decrement.toString()).toBe(
        "10",
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
      expect(movementCalls()[0].avgCostAfter.toString()).toBe("2"); // carried forward unchanged
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
      const comp = movementCalls()[0];
      expect(comp.avgCostAfter.toString()).toBe("2"); // the replay reads this snapshot
      expect(comp.stockAfter.toString()).toBe("10");
    });

    it("a supplier change re-posts under the new supplier (the compensation keeps the original's)", async () => {
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
      const [comp, repost] = movementCalls();
      expect(comp.supplierId).toBe("sup-1");
      expect(repost.supplierId).toBe("sup-2");
      expect(prisma.purchaseOrder.update.mock.calls[0][0].data.supplierId).toBe("sup-2");
    });

    it("the re-created lot keeps the ORIGINAL lot's purchase date (FIFO/LIFO order); the movement is dated now", async () => {
      const original = new Date("2026-08-20T10:00:00.000Z");
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.stockLot.findMany.mockResolvedValue([lot({ purchaseDate: original })]);
      await service.updatePurchaseOrder(
        "po-1",
        {
          reapplyInventory: true,
          items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 4 }],
        },
        "u",
      );
      expect(prisma.stockLot.create.mock.calls[0][0].data.purchaseDate).toEqual(original);
      expect(movementCalls()[1].createdAt.getTime()).toBeGreaterThan(original.getTime());
    });

    it("only reverses THIS PO's product lots - the lot query is filtered by product, not just reference", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      await service.updatePurchaseOrder(
        "po-1",
        {
          reapplyInventory: true,
          items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 3 }],
        },
        "u",
      );
      expect(prisma.stockLot.findMany).toHaveBeenCalledWith({
        where: { reference: "PO-2026-0001", productId: { in: ["prod-1"] } },
      });
    });

    it("locks every product it will read-modify-write, in sorted id order, after the PO row", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      await service.updatePurchaseOrder(
        "po-1",
        {
          reapplyInventory: true,
          items: [
            { id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 3 },
            { productId: "prod-2", qtyOrdered: 2, unitCost: 1 },
          ],
        },
        "u",
      );
      expect(sql(0)).toMatch(/"PurchaseOrder"/);
      // SA-767 L-1: ONE tenant-filtered statement for every product (the SQL orders the rows)
      expect(lock).toHaveBeenCalledTimes(2);
      expect(lock.mock.calls[1].slice(1)).toEqual([
        "test-tenant",
        ["prod-1", "prod-2"],
        PRODUCT_LOCK_RANK_SQL,
      ]);
      expect(lock.mock.invocationCallOrder[1]).toBeLessThan(
        prisma.stockMovement.create.mock.invocationCallOrder[0],
      );
    });

    it("refuses - writing nothing - when the live movements do not match the lines' receipts", async () => {
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
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    });
  });

  // ─── B583 follow-ups (lead): deterministic replay order + legacy-lot remediation ─────────

  describe("B583 follow-ups", () => {
    const calls = () => prisma.stockMovement.create.mock.calls.map((c: any) => c[0].data);
    const edit = () =>
      service.updatePurchaseOrder(
        "po-1",
        {
          reapplyInventory: true,
          items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 4 }],
        },
        "u",
      );

    it("every movement a re-apply writes has its own, strictly increasing createdAt — compensations first, then the re-post", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      // two live receipts of one PO (6 + 4) → two compensations, then one re-post PER receipt (SA-808 §5)
      prisma.stockMovement.findMany.mockResolvedValue([
        movement({ id: "mv-b", quantity: D(4), createdAt: new Date("2026-08-02T00:00:00Z") }),
        movement({ id: "mv-a", quantity: D(6), createdAt: new Date("2026-08-01T00:00:00Z") }),
      ]);
      await edit();
      const times = calls().map((m: any) => m.createdAt.getTime());
      expect(calls().map((m: any) => m.type)).toEqual([
        "PURCHASE",
        "PURCHASE",
        "PURCHASE",
        "PURCHASE",
      ]);
      expect(calls().map((m: any) => m.quantity.toString())).toEqual(["-4", "-6", "6", "4"]);
      expect(times).toHaveLength(4);
      // strictly increasing: no two rows tie, so the replay's id tie-break can never decide the order
      expect(times[0]).toBeLessThan(times[1]);
      expect(times[1]).toBeLessThan(times[2]);
      expect(times[2]).toBeLessThan(times[3]);
    });

    // B608: a lot's free-text `notes` is operator input (receiveStock writes `reference` AND `notes`
    // straight from the DTO), and reversePoReceipts finds lots by `reference`. The old #966
    // "(PO edited; N already consumed)" annotation is therefore NOT trusted: nothing parses it, a lot
    // that drained to zero refuses like any other consumed lot, and no stock is credited from text.
    it("a PO re-applied under #966 (a zeroed, annotated lot + the re-created full lot) now REFUSES, and writes nothing", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.stockLot.findMany.mockResolvedValue([
        lot({ id: "lot-old", remainingQty: D(0), notes: "(PO edited; 4 already consumed)" }),
        lot({ id: "lot-new" }),
      ]);
      await expect(edit()).rejects.toMatchObject({
        response: { code: "PO_LOT_PARTIALLY_CONSUMED", lotIds: ["lot-old"] },
      });
      expectNoStockWrites();
      expect(prisma.stockLot.deleteMany).not.toHaveBeenCalled();
      expect(prisma.stockLot.create).not.toHaveBeenCalled();
    });

    it("several annotated, zeroed lots all refuse, each named, and none is summed into a credit", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.stockLot.findMany.mockResolvedValue([
        lot({ id: "old-1", remainingQty: D(0), notes: "(PO edited; 4 already consumed)" }),
        lot({ id: "old-2", remainingQty: D(0), notes: "(PO edited; 1.5 already consumed)" }),
        lot({ id: "lot-new" }),
      ]);
      await expect(edit()).rejects.toMatchObject({
        response: { code: "PO_LOT_PARTIALLY_CONSUMED", lotIds: ["old-1", "old-2"] },
      });
      expectNoStockWrites();
    });

    it("a crafted operator note on a DRAINED lot naming this PO earns no credit: it refuses, nothing is minted", async () => {
      // What a user with receive-stock permission can write: reference = a real PO number, notes = the
      // old annotation with a large N. Once the lot drains to zero, the parsed N used to be credited
      // as free stock on the next re-apply.
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.stockLot.findMany.mockResolvedValue([
        lot({ id: "crafted", remainingQty: D(0), notes: "(PO edited; 9999 already consumed)" }),
      ]);
      await expect(edit()).rejects.toMatchObject({
        response: { code: "PO_LOT_PARTIALLY_CONSUMED", lotIds: ["crafted"] },
      });
      expectNoStockWrites();
      expect(prisma.stockLot.create).not.toHaveBeenCalled();
    });

    it("the same crafted note on an UNTOUCHED lot changes nothing: the rebuilt lot is the full receipt", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.stockLot.findMany.mockResolvedValue([
        lot({ id: "lot-1", notes: "(PO edited; 4 already consumed)" }),
      ]);
      await edit();
      const rebuilt = prisma.stockLot.create.mock.calls[0][0].data;
      expect(rebuilt.qty.toString()).toBe("10");
      // no carried consumption: remaining is the whole receipt, never received - 4
      expect(rebuilt.remainingQty.toString()).toBe("10");
    });

    it("a partly-consumed live lot refuses, whatever a sibling lot's notes say", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.stockLot.findMany.mockResolvedValue([
        lot({ id: "old", remainingQty: D(0), notes: "(PO edited; 4 already consumed)" }),
        lot({ id: "lot-new", remainingQty: D(7) }),
      ]);
      await expect(edit()).rejects.toMatchObject({
        response: { code: "PO_LOT_PARTIALLY_CONSUMED" },
      });
      expectNoStockWrites();
    });

    it("a zeroed lot WITHOUT the #966 annotation is a real fully-consumed lot and still refuses", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.stockLot.findMany.mockResolvedValue([lot({ remainingQty: D(0), notes: "sold out" })]);
      await expect(edit()).rejects.toMatchObject({
        response: { code: "PO_LOT_PARTIALLY_CONSUMED" },
      });
    });
  });

  // ─── a PO with a LIVE linked bill can't move what it authorised ────────────

  describe("a purchase order that has been billed", () => {
    const linked = () =>
      prisma.vendorBill.findFirst.mockResolvedValue({ billNumber: "BILL-2026-0007" });

    it("refuses a line edit (409 PO_HAS_LINKED_BILL) and names the bill — nothing is written", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(
        po({ status: "SENT", items: [poLine({ qtyReceived: D(0) })] }),
      );
      linked();
      const err: any = await service
        .updatePurchaseOrder(
          "po-1",
          { items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 12, unitCost: 3 }] },
          "u",
        )
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: "PO_HAS_LINKED_BILL",
        billNumber: "BILL-2026-0007",
      });
      expect(err.getResponse().message).toMatch(/BILL-2026-0007/);
      expect(err.getResponse().message).toMatch(/Void the bill/);
      expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
      expectNoStockWrites();
    });

    it("refuses a supplier change too", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.supplier.findUnique.mockResolvedValue({ id: "sup-2" });
      linked();
      await expect(
        service.updatePurchaseOrder("po-1", { supplierId: "sup-2", reapplyInventory: true }, "u"),
      ).rejects.toMatchObject({ response: { code: "PO_HAS_LINKED_BILL" } });
      expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
    });

    it("refuses a re-apply line edit on a RECEIVED, billed PO as well", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      linked();
      await expect(
        service.updatePurchaseOrder(
          "po-1",
          {
            reapplyInventory: true,
            items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 4 }],
          },
          "u",
        ),
      ).rejects.toMatchObject({ response: { code: "PO_HAS_LINKED_BILL" } });
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    });

    it("still allows a header-only edit (notes, expected date) — and does not even look for a bill", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      linked();
      await service.updatePurchaseOrder("po-1", { notes: "Dock 5", expectedDate: null }, "u");
      expect(prisma.purchaseOrder.update.mock.calls[0][0].data).toEqual({
        notes: "Dock 5",
        expectedDate: null,
      });
      expect(prisma.vendorBill.findFirst).not.toHaveBeenCalled();
    });

    it("only a LIVE bill locks it — the lookup excludes VOID bills", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(
        po({ status: "SENT", items: [poLine({ qtyReceived: D(0) })] }),
      );
      // no live bill found (a voided one is filtered out by the query itself)
      await service.updatePurchaseOrder(
        "po-1",
        { items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 12, unitCost: 3 }] },
        "u",
      );
      expect(prisma.vendorBill.findFirst).toHaveBeenCalledWith({
        where: { purchaseOrderId: "po-1", status: { not: "VOID" } },
        select: { billNumber: true },
      });
      expect(prisma.purchaseOrder.update).toHaveBeenCalled();
    });
  });
});
