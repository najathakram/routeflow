import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
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

/**
 * Units/PO step 7 — a vendor bill linked to a purchase order:
 *  - create() links an existing PO (validated, one bill per PO, hard-gated against
 *    the PO) or raises a DRAFT PO from its own lines in the same transaction;
 *  - update() keeps a linked draft bill within the PO;
 *  - guard (e): a PO-linked bill NEVER touches stock on receive / revert / void —
 *    the PO is the stock mover, so a scanned delivery is never counted twice.
 */

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

/** A PO for 24 pieces of prod-1 @ $1.25/piece. */
const po = (o: Record<string, unknown> = {}) => ({
  id: "po-1",
  poNumber: "PO-2026-0001",
  supplierId: "sup-1",
  status: "SENT",
  items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: D(24), unitCost: D(1.25) }],
  ...o,
});

/** One case of 24 @ $30 == 24 pieces @ $1.25 — within the PO above. */
const billLine = (o: Record<string, unknown> = {}) => ({
  productId: "prod-1",
  description: "Widget 24pk",
  qty: 1,
  unitCost: 30,
  packSize: 24,
  sku: "W-24",
  ...o,
});

const linkedItem = (o: Record<string, unknown> = {}) => ({
  id: "item-1",
  productId: "prod-1",
  description: "Widget 24pk",
  qty: D(1),
  unitCost: D(30),
  packSize: 24,
  qtyReceived: null as Prisma.Decimal | null,
  product: { id: "prod-1", name: "Widget 24pk", currentStock: D(0), averageCost: null },
  ...o,
});

const bill = (o: Record<string, unknown> = {}) => ({
  id: "bill-1",
  billNumber: "BILL-2026-0042",
  supplierId: "sup-1",
  status: "DRAFT",
  billDate: new Date("2026-06-01"),
  receivedDate: null as Date | null,
  purchaseOrderId: null as string | null,
  totalPaid: D(0),
  items: [linkedItem()],
  supplier: { id: "sup-1", name: "Acme Supply" },
  ...o,
});

describe("VendorBillsService — PO-linked bills (units/PO step 7)", () => {
  let service: VendorBillsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let inventory: {
    recomputeProductInTx: jest.Mock;
    lockProducts: jest.Mock;
    fireStockAlerts: jest.Mock;
    createDraftPurchaseOrderInTx: jest.Mock;
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    // B1236: bill lines are validated against the catalog; by default every named id resolves.
    prisma.product.findMany.mockImplementation(async (args: any) =>
      (args?.where?.id?.in ?? []).map((id: string) => ({ id })),
    );
    // receive() re-reads the bill inside its transaction (B285 row lock): repeat the last bill read
    prisma.vendorBill.findUnique.mockImplementation(
      () =>
        prisma.vendorBill.findUnique.mock.results.filter((r) => r.type === "return").at(-1)?.value,
    );
    inventory = {
      recomputeProductInTx: jest.fn(),
      lockProducts: jest.fn(),
      fireStockAlerts: jest.fn(),
      createDraftPurchaseOrderInTx: jest
        .fn()
        .mockResolvedValue({ id: "po-new", poNumber: "PO-2026-0002", status: "DRAFT" }),
    };
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
        { provide: InventoryService, useValue: inventory },
        {
          provide: ProductAliasService,
          useValue: { resolveMany: jest.fn(), learn: jest.fn(), unlearn: jest.fn() },
        },
      ],
    }).compile();
    service = module.get(VendorBillsService);
    prisma.vendorBill.create.mockResolvedValue({ id: "bill-new" });
  });

  const createdData = () => prisma.vendorBill.create.mock.calls[0][0].data;
  const expectNoStockWrites = () => {
    for (const fn of [
      prisma.stockMovement.create,
      prisma.stockMovement.deleteMany,
      prisma.stockLot.create,
      prisma.stockLot.delete,
      prisma.stockLot.update,
      prisma.product.update,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  };

  // ─── create: link an existing PO ───────────────────────────────────────────

  describe("create — link an existing purchase order", () => {
    it("stores the link when the bill is within the PO (a case of 24 @ $30 == 24 pcs @ $1.25)", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      await service.create({ supplierId: "sup-1", purchaseOrderId: "po-1", items: [billLine()] });
      expect(createdData().purchaseOrderId).toBe("po-1");
      expect(inventory.createDraftPurchaseOrderInTx).not.toHaveBeenCalled();
    });

    it("hard-blocks a bill for more pieces than the PO ordered — and creates nothing", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      await expect(
        service.create({
          supplierId: "sup-1",
          purchaseOrderId: "po-1",
          items: [billLine({ qty: 2 })], // 2 cases = 48 pcs
        }),
      ).rejects.toMatchObject({ response: { code: "BILL_EXCEEDS_PO" } });
      expect(prisma.vendorBill.create).not.toHaveBeenCalled();
    });

    it("hard-blocks a per-piece price above the PO's", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      await expect(
        service.create({
          supplierId: "sup-1",
          purchaseOrderId: "po-1",
          items: [billLine({ unitCost: 36 })], // $1.50/piece vs $1.25
        }),
      ).rejects.toMatchObject({ response: { code: "BILL_EXCEEDS_PO" } });
      expect(prisma.vendorBill.create).not.toHaveBeenCalled();
    });

    it("refuses a PO that already has a bill (one bill per PO)", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.vendorBill.findFirst
        .mockResolvedValueOnce(null) // nextBillNumber
        .mockResolvedValueOnce({ billNumber: "BILL-2026-0007" });
      const err: any = await service
        .create({ supplierId: "sup-1", purchaseOrderId: "po-1", items: [billLine()] })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: "PO_ALREADY_BILLED" });
      expect(err.getResponse().message).toMatch(/BILL-2026-0007/);
      expect(prisma.vendorBill.create).not.toHaveBeenCalled();
    });

    it("refuses an unknown PO, a closed PO, and another supplier's PO", async () => {
      const dto = { supplierId: "sup-1", purchaseOrderId: "po-1", items: [billLine()] };
      prisma.purchaseOrder.findUnique.mockResolvedValueOnce(null);
      await expect(service.create(dto)).rejects.toBeInstanceOf(NotFoundException);
      prisma.purchaseOrder.findUnique.mockResolvedValueOnce(po({ status: "CLOSED" }));
      await expect(service.create(dto)).rejects.toThrow(/closed/);
      prisma.purchaseOrder.findUnique.mockResolvedValueOnce(po({ supplierId: "sup-other" }));
      await expect(service.create(dto)).rejects.toThrow(/different supplier/);
      expect(prisma.vendorBill.create).not.toHaveBeenCalled();
    });

    it("refuses a mapped line whose product is not on the PO", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      await expect(
        service.create({
          supplierId: "sup-1",
          purchaseOrderId: "po-1",
          items: [billLine(), billLine({ productId: "prod-2", description: "Gadget" })],
        }),
      ).rejects.toMatchObject({ response: { code: "BILL_EXCEEDS_PO" } });
    });

    it("a bill with no PO is untouched by any of this", async () => {
      await service.create({ supplierId: "sup-1", items: [billLine()] });
      expect(createdData()).not.toHaveProperty("purchaseOrderId");
      expect(prisma.purchaseOrder.findUnique).not.toHaveBeenCalled();
    });
  });

  // ─── create: raise a draft PO from the bill's lines ────────────────────────

  describe("create — raise a draft purchase order from the bill's lines", () => {
    it("B677: a bill line of 1,000 cases of 12 at $11.00 hands the PO its exact $11,000.00, not pieces x 0.9167", async () => {
      await service.create({
        supplierId: "sup-1",
        createPurchaseOrder: true,
        items: [billLine({ qty: 1000, unitCost: 11, packSize: 12, sku: undefined })],
      });
      const input = inventory.createDraftPurchaseOrderInTx.mock.calls[0][1];
      expect(input.lines[0].qtyOrdered.toString()).toBe("12000");
      expect(input.lines[0].unitCost.toString()).toBe("0.9167"); // costing only
      expect(input.lines[0].totalCost).toBe(11000);
      expect(12000 * 0.9167).toBeCloseTo(11000.4, 6); // what the per-piece derivation stored
    });

    it("creates the PO in the bill's own transaction from the same lines (pieces, per-piece cost, sku, pack) and links it", async () => {
      await service.create({
        supplierId: "sup-1",
        createPurchaseOrder: true,
        notes: "Dock 3",
        items: [
          billLine(),
          billLine({
            productId: "prod-2",
            description: "Gadget",
            qty: 10,
            unitCost: 2,
            packSize: undefined,
            sku: undefined,
          }),
        ],
      });
      expect(inventory.createDraftPurchaseOrderInTx).toHaveBeenCalledTimes(1);
      const [tx, input] = inventory.createDraftPurchaseOrderInTx.mock.calls[0];
      expect(tx).toBeDefined();
      expect(input.supplierId).toBe("sup-1");
      expect(input.notes).toBe("Dock 3");
      expect(input.lines).toHaveLength(2);
      expect(input.lines[0].productId).toBe("prod-1");
      expect(input.lines[0].qtyOrdered.toString()).toBe("24"); // 1 case × 24
      expect(input.lines[0].unitCost.toString()).toBe("1.25"); // $30 ÷ 24
      expect(input.lines[0].sku).toBe("W-24");
      expect(input.lines[0].packSize).toBe(24);
      expect(input.lines[0].totalCost).toBe(30); // the bill line's own exact total
      expect(input.lines[1].qtyOrdered.toString()).toBe("10");
      expect(input.lines[1].packSize).toBeNull();
      // the bill links to the PO that was just raised
      expect(createdData().purchaseOrderId).toBe("po-new");
      // and the PO was created BEFORE the bill (the bill holds the FK)
      expect(inventory.createDraftPurchaseOrderInTx.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.vendorBill.create.mock.invocationCallOrder[0],
      );
    });

    it("refuses when a line is not mapped to a product", async () => {
      await expect(
        service.create({
          supplierId: "sup-1",
          createPurchaseOrder: true,
          items: [billLine(), billLine({ productId: undefined, description: "Freight" })],
        }),
      ).rejects.toThrow(/Map every line to a product/);
      expect(inventory.createDraftPurchaseOrderInTx).not.toHaveBeenCalled();
      expect(prisma.vendorBill.create).not.toHaveBeenCalled();
    });

    it("refuses without a supplier, without lines, and combined with purchaseOrderId", async () => {
      await expect(
        service.create({ createPurchaseOrder: true, requireSupplier: false, items: [billLine()] }),
      ).rejects.toThrow(/supplier/);
      await expect(
        service.create({ supplierId: "sup-1", createPurchaseOrder: true, items: [] }),
      ).rejects.toThrow(/Map every line/);
      await expect(
        service.create({
          supplierId: "sup-1",
          createPurchaseOrder: true,
          purchaseOrderId: "po-1",
          items: [billLine()],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(inventory.createDraftPurchaseOrderInTx).not.toHaveBeenCalled();
    });
  });

  // ─── update: a linked draft bill stays within the PO ───────────────────────

  describe("update — a linked draft bill", () => {
    it("blocks a line edit that goes past the PO, before deleting anything", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ purchaseOrderId: "po-1" }));
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      await expect(
        service.update("bill-1", { items: [billLine({ qty: 3 })] }),
      ).rejects.toMatchObject({ response: { code: "BILL_EXCEEDS_PO" } });
      expect(prisma.vendorBill.update).not.toHaveBeenCalled(); // nothing deleted, nothing written
    });

    it("allows an edit that stays within the PO", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ purchaseOrderId: "po-1" }));
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.vendorBill.update.mockResolvedValue({ id: "bill-1", supplierId: null });
      await service.update("bill-1", { items: [billLine({ qty: 1, unitCost: 28 })] });
      // the old lines go through the PARENT (a child-scoped delete cannot see null-tenant lines)
      expect(prisma.vendorBill.update).toHaveBeenCalledWith({
        where: { id: "bill-1" },
        data: { items: { deleteMany: {} } },
      });
      expect(prisma.vendorBillItem.deleteMany).not.toHaveBeenCalled();
    });

    it("an unlinked bill's edit never consults a PO", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill());
      prisma.vendorBill.update.mockResolvedValue({ id: "bill-1", supplierId: null });
      await service.update("bill-1", { items: [billLine({ qty: 99 })] });
      expect(prisma.purchaseOrder.findUnique).not.toHaveBeenCalled();
    });
  });

  // ─── guard (e): a PO-linked bill never touches stock ───────────────────────

  describe("guard (e) — a PO-linked bill never touches stock", () => {
    it("receive: the bill's receipt state advances but no stock, lot, average or alert is written", async () => {
      prisma.vendorBill.findUnique.mockResolvedValueOnce(bill({ purchaseOrderId: "po-1" }));
      prisma.vendorBill.update.mockResolvedValue({ id: "bill-1", status: "RECEIVED", items: [] });
      await service.receive("bill-1", undefined, "user-1");
      expectNoStockWrites();
      expect(prisma.product.findFirst).not.toHaveBeenCalled();
      expect(inventory.fireStockAlerts).not.toHaveBeenCalled();
      const data = prisma.vendorBill.update.mock.calls[0][0].data;
      expect(data.status).toBe("RECEIVED");
      expect(data.receivedDate).toBeInstanceOf(Date);
    });

    it("CONTROL — the same bill without a PO still posts stock on receive", async () => {
      prisma.vendorBill.findUnique.mockResolvedValueOnce(bill());
      prisma.product.findFirst.mockResolvedValue({
        currentStock: D(0),
        averageCost: null,
        costingMethod: "AVCO",
      });
      prisma.vendorBill.update.mockResolvedValue({ id: "bill-1", status: "RECEIVED", items: [] });
      await service.receive("bill-1", undefined, "user-1");
      expect(prisma.stockMovement.create).toHaveBeenCalledTimes(1);
      expect(prisma.stockLot.create).toHaveBeenCalledTimes(1);
    });

    it("revertToDraft: nothing to reverse — no movement, lot or stock write — but the bill goes back to DRAFT", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({
          purchaseOrderId: "po-1",
          status: "RECEIVED",
          receivedDate: new Date("2026-06-02"),
          items: [linkedItem({ qtyReceived: D(1) })],
        }),
      );
      prisma.vendorBill.update.mockResolvedValue({ id: "bill-1", status: "DRAFT" });
      await service.revertToDraft("bill-1");
      expectNoStockWrites();
      expect(prisma.vendorBill.update.mock.calls[0][0].data.status).toBe("DRAFT");
    });

    it("CONTROL — an unlinked received bill still reverses its stock on revertToDraft", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({
          status: "RECEIVED",
          receivedDate: new Date("2026-06-02"),
          items: [linkedItem({ qtyReceived: D(1) })],
        }),
      );
      prisma.product.findFirst.mockResolvedValue({ currentStock: D(24), averageCost: D(1.25) });
      prisma.vendorBill.update.mockResolvedValue({ id: "bill-1", status: "DRAFT" });
      await service.revertToDraft("bill-1");
      expect(prisma.stockMovement.deleteMany).toHaveBeenCalled();
      expect(prisma.product.update).toHaveBeenCalled();
    });

    it("voidBill: a received linked bill is voided with no compensating stock movement", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({
          purchaseOrderId: "po-1",
          status: "RECEIVED",
          receivedDate: new Date("2026-06-02"),
          items: [linkedItem({ qtyReceived: D(1) })],
        }),
      );
      prisma.vendorBill.update.mockResolvedValue({ id: "bill-1", status: "VOID" });
      // real stock to reverse — so removing the guard makes this test FAIL rather than no-op
      prisma.product.findFirst.mockResolvedValue({ currentStock: D(24), averageCost: D(1.25) });
      await service.voidBill("bill-1", "user-1");
      expectNoStockWrites();
      expect(prisma.vendorBill.update.mock.calls[0][0].data.status).toBe("VOID");
    });

    it("CONTROL — an unlinked received bill still writes its compensating movement on void", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({
          status: "RECEIVED",
          receivedDate: new Date("2026-06-02"),
          items: [linkedItem({ qtyReceived: D(1) })],
        }),
      );
      prisma.product.findFirst.mockResolvedValue({ currentStock: D(24), averageCost: D(1.25) });
      prisma.vendorBill.update.mockResolvedValue({ id: "bill-1", status: "VOID" });
      await service.voidBill("bill-1", "user-1");
      expect(prisma.stockMovement.create).toHaveBeenCalledTimes(1);
    });
  });

  // ─── review hardening (Opus refute-first round 1) ──────────────────────────

  describe("review hardening", () => {
    it("create: an UNMAPPED line on a linked bill is refused — money the PO never authorised", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      await expect(
        service.create({
          supplierId: "sup-1",
          purchaseOrderId: "po-1",
          items: [
            billLine(),
            billLine({ productId: undefined, description: "Widget", qty: 100, unitCost: 50 }),
          ],
        }),
      ).rejects.toMatchObject({ response: { code: "BILL_EXCEEDS_PO" } });
      expect(prisma.vendorBill.create).not.toHaveBeenCalled();
    });

    it("create: linking a PO needs a supplier — a supplier-less bill can't skip the PO/supplier match", async () => {
      await expect(
        service.create({
          purchaseOrderId: "po-1",
          requireSupplier: false,
          items: [billLine()],
        }),
      ).rejects.toThrow(/Select the supplier before linking/);
      expect(prisma.purchaseOrder.findUnique).not.toHaveBeenCalled();
    });

    it("create: a linked bill with no lines is refused (it would consume the PO's single bill slot)", async () => {
      await expect(
        service.create({ supplierId: "sup-1", purchaseOrderId: "po-1", items: [] }),
      ).rejects.toThrow(/at least one line/);
      expect(prisma.purchaseOrder.findUnique).not.toHaveBeenCalled();
    });

    it("create: a unique-constraint race on the PO link becomes a retryable 409, not a 500", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      prisma.vendorBill.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
        }),
      );
      await expect(
        service.create({ supplierId: "sup-1", purchaseOrderId: "po-1", items: [billLine()] }),
      ).rejects.toMatchObject({ response: { code: "PO_LINK_CONFLICT" } });
    });

    it("create: the same P2002 on an UNLINKED bill is not disguised", async () => {
      const boom = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      });
      prisma.vendorBill.create.mockRejectedValue(boom);
      await expect(service.create({ supplierId: "sup-1", items: [billLine()] })).rejects.toBe(boom);
    });

    it("update: a linked bill's supplier can't be re-pointed", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ purchaseOrderId: "po-1" }));
      await expect(service.update("bill-1", { supplierId: "sup-other" })).rejects.toThrow(
        /supplier can't be changed/,
      );
      expect(prisma.vendorBill.update).not.toHaveBeenCalled();
    });

    it("update: re-sending the SAME supplier on a linked bill is fine", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ purchaseOrderId: "po-1" }));
      prisma.vendorBill.update.mockResolvedValue({ id: "bill-1", supplierId: null });
      await service.update("bill-1", { supplierId: "sup-1", notes: "x" });
      expect(prisma.vendorBill.update).toHaveBeenCalled();
    });

    it("update: emptying a linked bill's lines is refused", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ purchaseOrderId: "po-1" }));
      await expect(service.update("bill-1", { items: [] })).rejects.toThrow(/at least one line/);
      expect(prisma.vendorBillItem.deleteMany).not.toHaveBeenCalled();
    });

    it("update: FAILS CLOSED when the linked PO can no longer be found", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ purchaseOrderId: "po-gone" }));
      prisma.purchaseOrder.findUnique.mockResolvedValue(null);
      await expect(service.update("bill-1", { items: [billLine()] })).rejects.toMatchObject({
        response: { code: "PO_LINK_BROKEN" },
      });
      expect(prisma.vendorBillItem.deleteMany).not.toHaveBeenCalled();
    });

    it("update: packSize is stored TRUNCATED, exactly as create() and the gate read it", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill());
      prisma.vendorBill.update.mockResolvedValue({ id: "bill-1", supplierId: null });
      await service.update("bill-1", { items: [billLine({ packSize: 2.5 })] });
      const main = prisma.vendorBill.update.mock.calls.find(
        (c: any[]) => c[0].data.items?.createMany,
      );
      const rows = main![0].data.items.createMany.data;
      expect(rows[0].packSize).toBe(2);
    });

    it("receive: a PO-linked bill with an unmapped line is NOT asked to 'acknowledge unlinked items' — it moves no stock at all", async () => {
      prisma.vendorBill.findUnique.mockResolvedValueOnce(
        bill({
          purchaseOrderId: "po-1",
          items: [linkedItem(), linkedItem({ id: "item-2", productId: null, product: null })],
        }),
      );
      prisma.vendorBill.update.mockResolvedValue({ id: "bill-1", status: "RECEIVED", items: [] });
      await expect(service.receive("bill-1", undefined, "user-1")).resolves.toBeDefined();
    });

    it("CONTROL — the same unmapped line on an UNLINKED bill still asks for acknowledgement", async () => {
      prisma.vendorBill.findUnique.mockResolvedValueOnce(
        bill({
          items: [linkedItem(), linkedItem({ id: "item-2", productId: null, product: null })],
        }),
      );
      await expect(service.receive("bill-1", undefined, "user-1")).rejects.toMatchObject({
        response: { code: "UNLINKED_ITEMS" },
      });
    });
  });

  // ─── the lead's blocker: a VOID bill must release its PO ───────────────────

  describe("void releases the purchase order", () => {
    const received = (o: Record<string, unknown> = {}) =>
      bill({
        purchaseOrderId: "po-1",
        notes: "Dock 3",
        status: "RECEIVED",
        receivedDate: new Date("2026-06-02"),
        items: [linkedItem({ qtyReceived: D(1) })],
        ...o,
      });

    it("voiding a received PO-linked bill nulls purchaseOrderId and keeps the old link in the notes", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(received());
      prisma.purchaseOrder.findUnique.mockResolvedValue({ poNumber: "PO-2026-0001" });
      prisma.vendorBill.update.mockResolvedValue({ id: "bill-1", status: "VOID" });
      await service.voidBill("bill-1", "user-1");
      const data = prisma.vendorBill.update.mock.calls[0][0].data;
      expect(data.status).toBe("VOID");
      expect(data.purchaseOrderId).toBeNull();
      expect(data.notes).toBe("Dock 3\nVoided — unlinked from purchase order PO-2026-0001.");
    });

    it("voiding a DRAFT linked bill (the no-reversal branch) releases the PO too", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({ purchaseOrderId: "po-1", notes: null }),
      );
      prisma.purchaseOrder.findUnique.mockResolvedValue({ poNumber: "PO-2026-0001" });
      prisma.vendorBill.update.mockResolvedValue({ id: "bill-1", status: "VOID" });
      await service.voidBill("bill-1", "user-1");
      const data = prisma.vendorBill.update.mock.calls[0][0].data;
      expect(data.purchaseOrderId).toBeNull();
      expect(data.notes).toBe("Voided — unlinked from purchase order PO-2026-0001.");
    });

    it("an unlinked bill's void touches neither the link nor the notes", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill());
      prisma.vendorBill.update.mockResolvedValue({ id: "bill-1", status: "VOID" });
      await service.voidBill("bill-1", "user-1");
      const data = prisma.vendorBill.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty("purchaseOrderId");
      expect(data).not.toHaveProperty("notes");
      expect(prisma.purchaseOrder.findUnique).not.toHaveBeenCalled();
    });

    it("the one-bill-per-PO check ignores VOID bills", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(po());
      await service.create({ supplierId: "sup-1", purchaseOrderId: "po-1", items: [billLine()] });
      const call = prisma.vendorBill.findFirst.mock.calls.find(
        (c: any) => c[0]?.where?.purchaseOrderId === "po-1",
      );
      expect(call?.[0].where).toEqual({ purchaseOrderId: "po-1", status: { not: "VOID" } });
    });
  });
});
