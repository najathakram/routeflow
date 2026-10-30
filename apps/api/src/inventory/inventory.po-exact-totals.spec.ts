/**
 * PO line money (Senior Architect ruling 2026-09-22, no migration): a line entered PER CASE ($11.00 a box of 12)
 * used to be stored as a per-piece unitCost at 4 dp (0.9167) and totalled as pieces x that cost, so 1,000 boxes
 * came to $11,000.40 on the PO total instead of the $11,000.00 that was typed. Now packSize is the denomination
 * (non-null = entered per case) and the SERVER computes totalCost from the ENTERED figures,
 * roundMoney(caseCost x (cases + loosePieces / packSize)), through the one @routeflow/pricing builder. The
 * per-piece unitCost stays 4 dp for COSTING only and is never multiplied back into a document total. A client's
 * own total or per-piece figure is ignored on a case line. Existing rows are read as stored, never rewritten.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { wireStockHelper, StockHelperMock } from "./testing/stock-helper-mock";
import { UpdatePurchaseOrderDto } from "./dto/update-purchase-order.dto";

const D = (n: number | string) => new Prisma.Decimal(n);

describe("purchase order line money: exact totals from the entered case cost", () => {
  let service: InventoryService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let stock: StockHelperMock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    stock = wireStockHelper(prisma); // SA-927: the real stock helper over the mock
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn(stock.wrapTx({ ...prisma, $executeRaw: jest.fn().mockResolvedValue(0) })),
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
    prisma.supplier.findUnique.mockResolvedValue({ id: "sup-1", name: "Acme Wholesale" });
    prisma.product.findMany.mockResolvedValue([{ id: "prod-1" }, { id: "prod-2" }]);
    prisma.purchaseOrder.create.mockImplementation(async (a: any) => ({ id: "po-1", ...a.data }));
    prisma.purchaseOrder.findFirst.mockResolvedValue(null);
  });

  const created = () => prisma.purchaseOrder.create.mock.calls[0][0].data;
  const createdItem = (i = 0) => created().items.create[i];
  const create = (items: any[]) =>
    service.createPurchaseOrder({ supplierId: "sup-1", items }, "u1");

  describe("createPurchaseOrder", () => {
    it("RED FIRST: 1,000 cases of 12 at $11.00 total exactly $11,000.00 on the line AND the PO", async () => {
      await create([{ productId: "prod-1", packSize: 12, caseCost: 11, cases: 1000 }]);
      expect(createdItem()).toMatchObject({
        qtyOrdered: 12000,
        unitCost: 0.9167, // per piece, 4 dp, for costing only
        totalCost: 11000,
        packSize: 12,
      });
      expect(created().totalAmount).toBe(11000);
      expect(created().totalAmount).not.toBe(11000.4);
    });

    it("loose pieces: 5 cases + 6 pieces of 12 at $11.00 = 66 pieces, $60.50", async () => {
      await create([{ productId: "prod-1", packSize: 12, caseCost: 11, cases: 5, loosePieces: 6 }]);
      expect(createdItem()).toMatchObject({ qtyOrdered: 66, totalCost: 60.5, packSize: 12 });
      expect(created().totalAmount).toBe(60.5);
    });

    it("the PO total is the sum of the EXACT line totals (two case lines + a per-piece line)", async () => {
      await create([
        { productId: "prod-1", packSize: 12, caseCost: 11, cases: 1000 },
        { productId: "prod-2", packSize: 24, caseCost: 30.5, cases: 3 },
        { productId: "prod-2", qty: 2.5, unitCost: 4 },
      ]);
      expect(created().items.create.map((i: any) => i.totalCost)).toEqual([11000, 91.5, 10]);
      expect(created().totalAmount).toBe(11101.5);
    });

    it("the SERVER ignores a client's own total and per-piece figures on a case line", async () => {
      await create([
        {
          productId: "prod-1",
          packSize: 12,
          caseCost: 11,
          cases: 1000,
          qtyOrdered: 1,
          qty: 1,
          unitCost: 999,
          totalCost: 5,
        },
      ]);
      expect(createdItem()).toMatchObject({
        qtyOrdered: 12000,
        unitCost: 0.9167,
        totalCost: 11000,
      });
    });

    it("RED FIRST: a per-piece line's total is ROUNDED to cents (qty 3 x 0.3333 was stored as 0.9999)", async () => {
      await create([{ productId: "prod-1", qty: 3, unitCost: 0.3333 }]);
      expect(createdItem().totalCost).toBe(1);
      expect(created().totalAmount).toBe(1);
      expect(createdItem().packSize).toBeUndefined(); // null packSize = per piece: nothing stored
    });

    it("a per-piece line keeps roundMoney(qty x unitCost) and its own per-piece cost untouched", async () => {
      await create([{ productId: "prod-1", qtyOrdered: 12000, unitCost: 0.9167 }]);
      expect(createdItem()).toMatchObject({
        qtyOrdered: 12000,
        unitCost: 0.9167,
        totalCost: 11000.4,
      });
    });

    it("refuses a case line with no pack, a pack of 1, no quantity, or a negative cost (400)", async () => {
      for (const bad of [
        { caseCost: 11, cases: 1 },
        { packSize: 1, caseCost: 11, cases: 1 },
        { packSize: 12, caseCost: 11, cases: 0, loosePieces: 0 },
        { packSize: 12, caseCost: -1, cases: 1 },
        { packSize: 12, caseCost: 11, cases: 1.5 },
      ]) {
        await expect(create([{ productId: "prod-1", ...bad }])).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
      expect(prisma.purchaseOrder.create).not.toHaveBeenCalled();
    });
  });

  describe("updatePurchaseOrder", () => {
    const poLine = (o: Record<string, unknown> = {}) => ({
      id: "poi-1",
      poId: "po-1",
      productId: "prod-1",
      qtyOrdered: D(12000),
      qtyReceived: D(0),
      unitCost: D("0.9167"),
      totalCost: D("11000.40"), // an EXISTING row, read as stored
      sku: null,
      packSize: null,
      ...o,
    });
    const arm = (status: string, items = [poLine()]) => {
      prisma.purchaseOrder.findUnique.mockResolvedValue({
        id: "po-1",
        poNumber: "PO-2026-0001",
        supplierId: "sup-1",
        status,
        items,
      });
      prisma.purchaseOrder.update.mockResolvedValue({});
      prisma.purchaseOrder.findUniqueOrThrow.mockResolvedValue({ id: "po-1" });
      prisma.vendorBill.findFirst.mockResolvedValue(null);
    };
    const nested = () => prisma.purchaseOrder.update.mock.calls[0][0].data;

    it("RED FIRST: re-entering the line as 1,000 cases at $11.00 stores $11,000.00 (not the 11,000.40 the per-piece cost implied)", async () => {
      arm("DRAFT");
      await service.updatePurchaseOrder(
        "po-1",
        {
          items: [{ id: "poi-1", productId: "prod-1", packSize: 12, caseCost: 11, cases: 1000 }],
        } as any,
        "u1",
      );
      const line = nested().items.update[0].data;
      expect(line).toMatchObject({
        qtyOrdered: 12000,
        unitCost: 0.9167,
        totalCost: 11000,
        packSize: 12,
      });
      expect(nested().totalAmount).toBe(11000);
    });

    it("MUST-FIX: a PATCH case line with cases 0 and no loose pieces is a 400 (the DTO allows cases 0, the service is the gate)", async () => {
      arm("DRAFT");
      for (const bad of [
        { packSize: 12, caseCost: 11, cases: 0 },
        { packSize: 12, caseCost: 11, cases: 0, loosePieces: 0 },
      ]) {
        await expect(
          service.updatePurchaseOrder(
            "po-1",
            { items: [{ id: "poi-1", productId: "prod-1", ...bad }] } as any,
            "u1",
          ),
        ).rejects.toThrow("Item quantity must be positive");
      }
      expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
    });

    it("loose pieces alone are a valid case-line quantity (cases 0, 6 pieces of 12 at $11 = $5.50)", async () => {
      arm("DRAFT");
      await service.updatePurchaseOrder(
        "po-1",
        {
          items: [
            {
              id: "poi-1",
              productId: "prod-1",
              packSize: 12,
              caseCost: 11,
              cases: 0,
              loosePieces: 6,
            },
          ],
        } as any,
        "u1",
      );
      expect(nested().items.update[0].data).toMatchObject({ qtyOrdered: 6, totalCost: 5.5 });
    });

    it("a NEW case line on an edit gets the same exact total and stores its pack", async () => {
      arm("DRAFT");
      await service.updatePurchaseOrder(
        "po-1",
        {
          items: [
            { id: "poi-1", productId: "prod-1", qtyOrdered: 12000, unitCost: 0.9167 },
            { productId: "prod-2", packSize: 24, caseCost: 30.5, cases: 3 },
          ],
        } as any,
        "u1",
      );
      const added = nested().items.create[0];
      expect(added).toMatchObject({
        qtyOrdered: 72,
        unitCost: 1.2708,
        totalCost: 91.5,
        packSize: 24,
      });
      expect(nested().totalAmount).toBe(11091.9); // 11000.40 (the untouched per-piece line, as stored) + 91.50
    });

    it("an existing per-piece line sent back UNCHANGED keeps its stored total: rows are read as stored, never rewritten", async () => {
      arm("DRAFT");
      await service.updatePurchaseOrder(
        "po-1",
        {
          items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 12000, unitCost: 0.9167 }],
        } as any,
        "u1",
      );
      expect(nested().items.update[0].data).toMatchObject({ totalCost: 11000.4 });
      expect(nested().items.update[0].data).not.toHaveProperty("packSize"); // untouched
    });

    it("the honest case cost of the stored row is 11.0004 (shown, not masked), and 11.0004 x 1,000 = 11,000.40 unchanged", async () => {
      arm("DRAFT");
      await service.updatePurchaseOrder(
        "po-1",
        {
          items: [
            { id: "poi-1", productId: "prod-1", packSize: 12, caseCost: 11.0004, cases: 1000 },
          ],
        } as any,
        "u1",
      );
      expect(nested().items.update[0].data).toMatchObject({ totalCost: 11000.4 });
    });

    it("a received PO re-applied with a case line costs stock PER PIECE at 4 dp and keeps the exact document total", async () => {
      arm("RECEIVED", [poLine({ qtyReceived: D(12000) })]);
      prisma.stockMovement.findMany.mockResolvedValue([
        {
          id: "mv-1",
          productId: "prod-1",
          type: "PURCHASE",
          quantity: D(12000),
          unitCost: D("0.9167"),
          supplierId: "sup-1",
          notes: null,
          createdAt: new Date("2026-08-01T00:00:00.000Z"),
        },
      ]);
      prisma.stockLot.findMany.mockResolvedValue([
        {
          id: "lot-1",
          productId: "prod-1",
          qty: D(12000),
          remainingQty: D(12000),
          notes: null,
          purchaseDate: new Date("2026-08-01T00:00:00.000Z"),
        },
      ]);
      prisma.product.findUnique.mockResolvedValue({
        id: "prod-1",
        name: "Cola",
        currentStock: D(12000),
        averageCost: D("0.9167"),
        costingMethod: "AVCO",
      });
      await service.updatePurchaseOrder(
        "po-1",
        {
          reapplyInventory: true,
          items: [{ id: "poi-1", productId: "prod-1", packSize: 12, caseCost: 11, cases: 1000 }],
        } as any,
        "u1",
      );
      expect(nested().totalAmount).toBe(11000);
      const purchase: any = stock.written().find((d: any) => d.type === "PURCHASE");
      expect(Number(purchase.unitCost)).toBe(0.9167); // costing: per piece, 4 dp, not widened
    });
  });

  describe("receivePurchaseOrder", () => {
    it("receiving never rewrites the line or PO total: $11,000.00 stays, stock is costed per piece at 4 dp", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue({
        id: "po-1",
        poNumber: "PO-2026-0001",
        supplierId: "sup-1",
        status: "SENT",
        items: [
          {
            id: "poi-1",
            productId: "prod-1",
            qtyOrdered: D(12000),
            qtyReceived: D(0),
            unitCost: D("0.9167"),
            totalCost: D("11000.00"),
            packSize: 12,
          },
        ],
      });
      prisma.product.findUnique.mockResolvedValue({
        id: "prod-1",
        name: "Cola",
        currentStock: D(0),
        averageCost: D(0),
        costingMethod: "AVCO",
        unitsPerBox: 12,
      });
      prisma.purchaseOrder.update.mockResolvedValue({ id: "po-1" });
      await service.receivePurchaseOrder(
        "po-1",
        { items: [{ itemId: "poi-1", receivedQty: 12000 }] },
        "u1",
      );
      const poUpdate = prisma.purchaseOrder.update.mock.calls[0][0].data;
      expect(poUpdate).not.toHaveProperty("totalAmount");
      expect(prisma.purchaseOrderItem.update.mock.calls[0][0].data).not.toHaveProperty("totalCost");
      const mv = stock.written()[0];
      expect(Number(mv.unitCost)).toBe(0.9167);
    });
  });

  describe("UpdatePurchaseOrderItemDto (the wire)", () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const run = (items: unknown[]) =>
      pipe.transform({ items }, { type: "body", metatype: UpdatePurchaseOrderDto });

    it("accepts a case line without qtyOrdered/unitCost", async () => {
      await expect(
        run([
          {
            productId: "11111111-1111-4111-8111-111111111111",
            packSize: 12,
            caseCost: 11,
            cases: 1000,
          },
        ]),
      ).resolves.toBeDefined();
    });

    it("still accepts the legacy per-piece line", async () => {
      await expect(
        run([
          {
            productId: "11111111-1111-4111-8111-111111111111",
            qtyOrdered: 12000,
            unitCost: 0.9167,
          },
        ]),
      ).resolves.toBeDefined();
    });

    it("refuses a line with neither form, and a case line with no whole case count", async () => {
      const productId = "11111111-1111-4111-8111-111111111111";
      await expect(run([{ productId }])).rejects.toBeInstanceOf(BadRequestException);
      await expect(run([{ productId, packSize: 12, caseCost: 11 }])).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
