import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { createMockPrisma } from "../testing/prisma-mock";

const mockAnthropicCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn(() => ({ messages: { create: mockAnthropicCreate } })),
}));

const mockSharpToBuffer = jest.fn();
jest.mock("sharp", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    rotate: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: mockSharpToBuffer,
  })),
}));

const D = (n: number | string) => new Prisma.Decimal(n);

const linkedItem = (overrides: Record<string, unknown> = {}) => ({
  id: "item-1",
  productId: "prod-1",
  description: "Flour 25lb",
  qty: D(5),
  unitCost: D(3.5),
  product: { id: "prod-1", name: "Flour 25lb", currentStock: D(10), averageCost: D(2) },
  ...overrides,
});

const bill = (overrides: Record<string, unknown> = {}) => ({
  id: "bill-1",
  billNumber: "BILL-2026-0001",
  supplierId: "sup-1",
  status: "DRAFT",
  billDate: new Date("2026-06-01"),
  items: [linkedItem()],
  supplier: { id: "sup-1", name: "Acme Foods" },
  ...overrides,
});

/** An existing bill as the matcher reports it. */
const duplicateMatch = (overrides: Record<string, unknown> = {}) => ({
  id: "vb-9",
  billNumber: "BILL-2026-0009",
  status: "RECEIVED",
  totalOwed: 100,
  billDate: new Date("2026-06-01"),
  receivedDate: new Date("2026-06-02"),
  supplierId: "sup-1",
  itemCount: 4,
  matchedBy: "number" as const,
  totalMatches: true,
  ...overrides,
});

const dupMatch = {
  normalizeNumber: (raw: string) => (raw ?? "").toUpperCase().replace(/\s+/g, ""),
  findVendorBillDuplicate: jest.fn(),
};

describe("VendorBillsService", () => {
  let service: VendorBillsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    dupMatch.findVendorBillDuplicate.mockReset();
    dupMatch.findVendorBillDuplicate.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorBillsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: DuplicateMatchService, useValue: dupMatch },
      ],
    }).compile();

    service = module.get<VendorBillsService>(VendorBillsService);
  });

  // ─── receive ────────────────────────────────────────────────────────────────

  describe("receive", () => {
    it("throws UNLINKED_ITEMS 409 for a bill with no line items", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ items: [] }));

      await expect(service.receive("bill-1")).rejects.toMatchObject({
        constructor: ConflictException,
        response: expect.objectContaining({ code: "UNLINKED_ITEMS" }),
      });
      expect(prisma.vendorBill.update).not.toHaveBeenCalled();
    });

    it("throws UNLINKED_ITEMS 409 listing partially-unlinked lines", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({
          items: [
            linkedItem(),
            linkedItem({
              id: "item-2",
              productId: null,
              product: null,
              description: "Freight",
              qty: D(1),
              unitCost: D(25),
            }),
          ],
        }),
      );

      await expect(service.receive("bill-1")).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "UNLINKED_ITEMS",
          unlinkedItems: [{ id: "item-2", description: "Freight", qty: 1, unitCost: 25 }],
        }),
      });
    });

    it("receives with acknowledgeUnlinked, syncing only the linked lines", async () => {
      prisma.vendorBill.findUnique.mockResolvedValueOnce(
        bill({
          items: [
            linkedItem(),
            linkedItem({ id: "item-2", productId: null, product: null, description: "Freight" }),
          ],
        }),
      );
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(10), averageCost: D(2) });

      await service.receive("bill-1", { acknowledgeUnlinked: true }, "user-1");

      // One movement + one lot for the single linked line
      expect(prisma.stockMovement.create).toHaveBeenCalledTimes(1);
      expect(prisma.stockLot.create).toHaveBeenCalledTimes(1);
    });

    it("updates the weighted average, creates a StockLot, and stamps snapshots", async () => {
      prisma.vendorBill.findUnique.mockResolvedValueOnce(bill());
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(10), averageCost: D(2) });

      await service.receive("bill-1", undefined, "user-1");

      // (10×2 + 5×3.5) / 15 = 2.5
      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(movementArgs.type).toBe("PURCHASE");
      expect(movementArgs.unitCost.toString()).toBe("3.5");
      expect(movementArgs.avgCostAfter.toString()).toBe("2.5");
      expect(movementArgs.stockAfter.toString()).toBe("15");
      expect(movementArgs.performedById).toBe("user-1");

      const lotArgs = prisma.stockLot.create.mock.calls[0][0].data;
      expect(lotArgs.reference).toBe("BILL-2026-0001");
      expect(lotArgs.remainingQty.toString()).toBe("5");
      expect(lotArgs.unitCost.toString()).toBe("3.5");

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.averageCost.toString()).toBe("2.5");
    });

    it("still rejects double-receive (RF-084)", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ status: "RECEIVED" }));

      await expect(service.receive("bill-1")).rejects.toThrow("Bill already received");
    });
  });

  // ─── revertToDraft ──────────────────────────────────────────────────────────

  describe("revertToDraft", () => {
    it("restores the prior average exactly", async () => {
      // Product is at 15 @ 2.50 after receiving 5 @ 3.50 — reverting must yield 2.00
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ status: "RECEIVED" }));
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(15), averageCost: D(2.5) });
      prisma.stockLot.findMany.mockResolvedValue([]);

      await service.revertToDraft("bill-1");

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.averageCost.toString()).toBe("2");
      expect(productArgs.currentStock).toEqual({ decrement: D(5) });
    });

    it("KEEPS the average when the revert empties stock (no more zeroing)", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ status: "RECEIVED" }));
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(5), averageCost: D(3.5) });
      prisma.stockLot.findMany.mockResolvedValue([]);

      await service.revertToDraft("bill-1");

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.averageCost).toBeUndefined();
      expect(productArgs.currentStock).toEqual({ decrement: D(5) });
    });

    it("deletes untouched lots and zeroes partially-consumed ones", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ status: "RECEIVED" }));
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(15), averageCost: D(2.5) });
      prisma.stockLot.findMany.mockResolvedValue([
        { id: "lot-1", qty: D(5), remainingQty: D(5), notes: null },
        { id: "lot-2", qty: D(5), remainingQty: D(2), notes: null },
      ]);

      await service.revertToDraft("bill-1");

      expect(prisma.stockLot.delete).toHaveBeenCalledWith({ where: { id: "lot-1" } });
      expect(prisma.stockLot.update).toHaveBeenCalledWith({
        where: { id: "lot-2" },
        data: expect.objectContaining({ remainingQty: 0 }),
      });
    });
  });

  // ─── voidBill ───────────────────────────────────────────────────────────────

  describe("voidBill", () => {
    it("writes a costed compensating ADJUSTMENT with snapshots and keeps avg on stock-empty", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ status: "RECEIVED" }));
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(5), averageCost: D(3.5) });
      prisma.stockLot.findMany.mockResolvedValue([]);

      await service.voidBill("bill-1", "user-1");

      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(movementArgs.type).toBe("ADJUSTMENT");
      expect(movementArgs.quantity.toString()).toBe("-5");
      expect(movementArgs.unitCost.toString()).toBe("3.5");
      // Reversal empties stock → average carried forward, not zeroed
      expect(movementArgs.avgCostAfter.toString()).toBe("3.5");
      expect(movementArgs.stockAfter.toString()).toBe("0");
      expect(movementArgs.performedById).toBe("user-1");

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.averageCost).toBeUndefined();
    });
  });

  // ─── findAll needsMapping ───────────────────────────────────────────────────

  describe("findAll", () => {
    it("always returns needsMappingCount in meta", async () => {
      prisma.vendorBill.findMany.mockResolvedValue([]);
      prisma.vendorBill.count.mockResolvedValueOnce(0).mockResolvedValueOnce(3);

      const result = await service.findAll();

      expect(result.meta.needsMappingCount).toBe(3);
      expect(prisma.vendorBill.count).toHaveBeenCalledWith({
        where: {
          status: "DRAFT",
          OR: [{ items: { none: {} } }, { items: { some: { productId: null } } }],
        },
      });
    });

    it("filters to DRAFT bills with missing/unlinked items when needsMapping is set", async () => {
      prisma.vendorBill.findMany.mockResolvedValue([]);

      await service.findAll(undefined, undefined, undefined, undefined, undefined, 1, 20, true);

      const where = prisma.vendorBill.findMany.mock.calls[0][0].where;
      expect(where.status).toBe("DRAFT");
      expect(where.AND).toEqual([
        { OR: [{ items: { none: {} } }, { items: { some: { productId: null } } }] },
      ]);
    });
  });

  // ─── create ─────────────────────────────────────────────────────────────────

  describe("create", () => {
    beforeEach(() => {
      prisma.vendorBill.findFirst.mockResolvedValue(null); // nextBillNumber
      prisma.vendorBill.create.mockResolvedValue(bill());
    });

    it("rounds totalOwed computed from items (no float artifacts)", async () => {
      await service.create({
        requireSupplier: false,
        items: [
          { description: "A", qty: 3, unitCost: 0.1 },
          { description: "B", qty: 1, unitCost: 0.2 },
        ],
      });

      // 3×0.1 + 0.2 = 0.5000000000000001 unrounded — must be written as 0.5
      const data = prisma.vendorBill.create.mock.calls[0][0].data;
      expect(data.totalOwed).toBe(0.5);
    });

    it("folds taxAmount into totalOwed (scanned supplier invoices carry sales tax)", async () => {
      await service.create({
        requireSupplier: false,
        taxAmount: 5.999,
        items: [{ description: "A", qty: 3, unitCost: 1.4849 }],
      });

      // 3×1.4849 = 4.4547; + 5.999 = 10.4537 → rounded to cents
      const data = prisma.vendorBill.create.mock.calls[0][0].data;
      expect(data.totalOwed).toBe(10.45);
    });

    it("ignores a missing/garbage taxAmount", async () => {
      await service.create({
        requireSupplier: false,
        taxAmount: "not-a-number",
        items: [{ description: "A", qty: 2, unitCost: 10 }],
      });

      const data = prisma.vendorBill.create.mock.calls[0][0].data;
      expect(data.totalOwed).toBe(20);
    });
  });

  // ─── duplicate guard ────────────────────────────────────────────────────────

  describe("create — duplicate guard", () => {
    beforeEach(() => {
      prisma.vendorBill.findFirst.mockResolvedValue(null); // nextBillNumber
      prisma.vendorBill.create.mockResolvedValue(bill());
      prisma.supplier.findUnique.mockResolvedValue({ name: "Acme Foods" });
    });

    const scanned = (overrides: Record<string, unknown> = {}) => ({
      requireSupplier: false,
      supplierInvoiceNumber: "INV-1",
      items: [{ description: "A", qty: 1, unitCost: 100 }],
      ...overrides,
    });

    it("blocks a re-scan of the same supplier invoice with a structured 409", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue(duplicateMatch());

      await expect(service.create(scanned())).rejects.toMatchObject({
        constructor: ConflictException,
        response: expect.objectContaining({
          code: "DUPLICATE_VENDOR_BILL",
          duplicate: expect.objectContaining({
            billId: "vb-9",
            billNumber: "BILL-2026-0009",
            resumable: false,
            supplierName: "Acme Foods",
            itemCount: 4,
            matchedBy: "number",
            totalMatches: true,
          }),
        }),
      });
      expect(prisma.vendorBill.create).not.toHaveBeenCalled();
    });

    it("writes a message that stands alone for clients that only surface the text", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue(duplicateMatch());

      const err = await service.create(scanned()).catch((e) => e);
      const message = err.response.message as string;
      expect(message).toContain("INV-1");
      expect(message).toContain("BILL-2026-0009");
      expect(message).toContain("double stock");
    });

    it("points a DRAFT match at finishing the existing bill instead of a second one", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue(duplicateMatch({ status: "DRAFT" }));

      const err = await service.create(scanned()).catch((e) => e);
      expect(err.response.duplicate.resumable).toBe(true);
      expect(err.response.message).toContain("open it to finish receiving");
    });

    it("records the bill on a FUZZY match — same supplier, day and amount isn't identity", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue(duplicateMatch({ matchedBy: "fuzzy" }));

      await service.create({
        supplierId: "sup-1",
        billDate: "2026-06-01",
        items: [{ description: "A", qty: 1, unitCost: 100 }],
      });

      expect(dupMatch.findVendorBillDuplicate).toHaveBeenCalled();
      expect(prisma.vendorBill.create).toHaveBeenCalled();
    });

    it("records the bill anyway when the operator sends allowDuplicate", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue(duplicateMatch());

      await service.create(scanned({ allowDuplicate: true }));

      expect(dupMatch.findVendorBillDuplicate).not.toHaveBeenCalled();
      expect(prisma.vendorBill.create).toHaveBeenCalled();
    });

    it("records the bill when nothing live matches (a VOID prior bill never does)", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue(null);

      await service.create(scanned());

      expect(prisma.vendorBill.create).toHaveBeenCalled();
    });

    it("persists the supplier invoice number normalized", async () => {
      await service.create(scanned({ supplierInvoiceNumber: "inv 088 41" }));

      expect(prisma.vendorBill.create.mock.calls[0][0].data.supplierInvoiceNumber).toBe("INV08841");
      expect(dupMatch.findVendorBillDuplicate).toHaveBeenCalledWith(
        expect.objectContaining({ number: "INV08841" }),
      );
    });

    it("falls back to the notes phrase when only notes carry the number", async () => {
      await service.create({
        requireSupplier: false,
        notes: "Batch import — Supplier invoice #VB-7",
        items: [{ description: "A", qty: 1, unitCost: 10 }],
      });

      expect(prisma.vendorBill.create.mock.calls[0][0].data.supplierInvoiceNumber).toBe("VB-7");
      expect(dupMatch.findVendorBillDuplicate).toHaveBeenCalledWith(
        expect.objectContaining({ number: "VB-7" }),
      );
    });

    it.each([
      ["neither a number nor a supplier", { requireSupplier: false }],
      ["a supplier but no bill date", { supplierId: "sup-1" }],
    ])("skips the check with %s — nothing identifies the document", async (_label, extra) => {
      await service.create({ items: [{ description: "A", qty: 1, unitCost: 10 }], ...extra });

      expect(dupMatch.findVendorBillDuplicate).not.toHaveBeenCalled();
      expect(prisma.vendorBill.create).toHaveBeenCalled();
    });

    it("checks on supplier + bill date even with no number at all", async () => {
      await service.create({
        supplierId: "sup-1",
        billDate: "2026-06-01",
        items: [{ description: "A", qty: 1, unitCost: 10 }],
      });

      expect(dupMatch.findVendorBillDuplicate).toHaveBeenCalledWith({
        supplierId: "sup-1",
        number: null,
        total: 10,
        issueDate: new Date("2026-06-01"),
      });
    });
  });

  // ─── checkDuplicate ─────────────────────────────────────────────────────────

  describe("checkDuplicate", () => {
    it("maps a match to the wire payload, resolving the supplier name", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue(duplicateMatch({ status: "DRAFT" }));
      prisma.supplier.findUnique.mockResolvedValue({ name: "Acme Foods" });

      await expect(
        service.checkDuplicate({ supplierInvoiceNumber: "inv-1", total: 100 }),
      ).resolves.toEqual({
        duplicate: {
          billId: "vb-9",
          billNumber: "BILL-2026-0009",
          status: "DRAFT",
          resumable: true,
          totalOwed: 100,
          billDate: new Date("2026-06-01"),
          receivedDate: new Date("2026-06-02"),
          supplierName: "Acme Foods",
          itemCount: 4,
          matchedBy: "number",
          totalMatches: true,
        },
      });
    });

    it("returns null without querying when nothing identifies the document", async () => {
      await expect(service.checkDuplicate({ total: 100 })).resolves.toEqual({ duplicate: null });
      expect(dupMatch.findVendorBillDuplicate).not.toHaveBeenCalled();
    });

    it("still reports a fuzzy match so a client can warn before the operator commits", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue(duplicateMatch({ matchedBy: "fuzzy" }));
      prisma.supplier.findUnique.mockResolvedValue({ name: "Acme Foods" });

      await expect(
        service.checkDuplicate({ supplierId: "sup-1", billDate: "2026-06-01" }),
      ).resolves.toMatchObject({ duplicate: { billId: "vb-9", matchedBy: "fuzzy" } });
    });

    it("returns null when the matcher finds nothing", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue(null);

      await expect(
        service.checkDuplicate({ supplierId: "sup-1", billDate: "2026-06-01" }),
      ).resolves.toEqual({ duplicate: null });
    });
  });

  // ─── scanInvoice ────────────────────────────────────────────────────────────

  describe("scanInvoice", () => {
    const jpegPage = { buffer: Buffer.from("img"), mimeType: "image/jpeg" };

    beforeEach(async () => {
      // Provide an API key so the scan reaches the Anthropic call.
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          VendorBillsService,
          { provide: PrismaService, useValue: prisma },
          { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("test-key") } },
          { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
          { provide: DuplicateMatchService, useValue: dupMatch },
        ],
      }).compile();
      service = module.get<VendorBillsService>(VendorBillsService);
      mockAnthropicCreate.mockReset();
      mockSharpToBuffer.mockReset();
      prisma.product.findMany.mockResolvedValue([]);
      prisma.productMapping.findMany.mockResolvedValue([]);
    });

    it("maps an Anthropic auth failure to a typed AI_KEY_INVALID 400 (not an opaque 500)", async () => {
      mockAnthropicCreate.mockRejectedValue({ status: 401 });

      await expect(service.scanInvoice([jpegPage])).rejects.toMatchObject({
        constructor: BadRequestException,
        response: expect.objectContaining({ code: "AI_KEY_INVALID" }),
      });
    });

    it("maps Anthropic overload/rate-limit to AI_UNAVAILABLE 503", async () => {
      mockAnthropicCreate.mockRejectedValue({ status: 529 });

      await expect(service.scanInvoice([jpegPage])).rejects.toMatchObject({
        constructor: ServiceUnavailableException,
        response: expect.objectContaining({ code: "AI_UNAVAILABLE" }),
      });
    });

    it("maps a non-transient Anthropic 4xx (e.g. a rejected/corrupt image) to AI_SCAN_REJECTED 400, not AI_UNAVAILABLE", async () => {
      mockAnthropicCreate.mockRejectedValue({ status: 400 });

      await expect(service.scanInvoice([jpegPage])).rejects.toMatchObject({
        constructor: BadRequestException,
        response: expect.objectContaining({ code: "AI_SCAN_REJECTED" }),
      });
    });

    it("keeps a 429 rate-limit mapped to the retryable AI_UNAVAILABLE, not AI_SCAN_REJECTED", async () => {
      mockAnthropicCreate.mockRejectedValue({ status: 429 });

      await expect(service.scanInvoice([jpegPage])).rejects.toMatchObject({
        constructor: ServiceUnavailableException,
        response: expect.objectContaining({ code: "AI_UNAVAILABLE" }),
      });
    });

    it("maps an unparseable AI response to AI_PARSE_FAILED 422", async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: "text", text: "sorry, no JSON here" }],
      });

      await expect(service.scanInvoice([jpegPage])).rejects.toMatchObject({
        constructor: UnprocessableEntityException,
        response: expect.objectContaining({ code: "AI_PARSE_FAILED" }),
      });
    });

    it("skips an unreadable HEIC page and discloses it in notes instead of failing the scan", async () => {
      mockSharpToBuffer.mockRejectedValue(new Error("bad heic"));
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify({ supplier: "Acme", items: [] }) }],
      });

      const result = await service.scanInvoice([
        jpegPage,
        { buffer: Buffer.from("heic"), mimeType: "image/heic" },
      ]);

      expect(result.notes).toMatch(/page 2 couldn't be read/i);
      // Only the readable page was sent to Claude.
      const content = mockAnthropicCreate.mock.calls[0][0].messages[0].content;
      expect(content.filter((b: { type: string }) => b.type === "image")).toHaveLength(1);
    });

    it("rejects when every page is unreadable", async () => {
      mockSharpToBuffer.mockRejectedValue(new Error("bad heic"));

      await expect(
        service.scanInvoice([{ buffer: Buffer.from("heic"), mimeType: "image/heic" }]),
      ).rejects.toThrow(/couldn't read any/i);
      expect(mockAnthropicCreate).not.toHaveBeenCalled();
    });

    it("does NOT auto-assign a weak (0.35-0.6) fuzzy match — line comes back unlinked with candidates", async () => {
      prisma.product.findMany.mockResolvedValue([
        {
          id: "prod-1",
          name: "Wheat Bread",
          sku: null,
          barcode: null,
          parentProductId: null,
          parent: null,
        },
      ]);
      mockAnthropicCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              supplier: "Acme Foods",
              items: [{ extractedName: "Wheat Bread Multigrain Extra", qty: 1, unitCost: 2.5 }],
            }),
          },
        ],
      });

      const result = await service.scanInvoice([jpegPage]);

      expect(result.items[0]).toMatchObject({
        matchedProductId: null,
        matchedProductName: null,
        confidence: "low",
      });
      expect(result.items[0].candidates?.length).toBeGreaterThan(0);
      expect(result.items[0].candidates[0]).toMatchObject({ productId: "prod-1" });
    });

    it("a learned product mapping wins over a competing exact-name catalog match and returns the composed name", async () => {
      prisma.productMapping.findMany.mockResolvedValue([
        {
          supplierName: "Acme Foods",
          rawDescription: "big red cinnamon gum",
          productId: "prod-9",
          product: {
            id: "prod-9",
            name: "Cinnamon",
            sku: null,
            barcode: null,
            parentProductId: "parent-1",
            parent: { name: "Big Red Chewing Gum" },
          },
        },
      ]);
      // A decoy catalog product that would otherwise win an EXACT name match —
      // the learned mapping must be checked first and take priority regardless.
      prisma.product.findMany.mockResolvedValue([
        {
          id: "prod-decoy",
          name: "Big Red Cinnamon Gum",
          sku: null,
          barcode: null,
          parentProductId: null,
          parent: null,
        },
      ]);
      mockAnthropicCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              supplier: "Acme Foods",
              items: [{ extractedName: "Big Red Cinnamon Gum", qty: 2, unitCost: 3 }],
            }),
          },
        ],
      });

      const result = await service.scanInvoice([jpegPage]);

      expect(result.items[0]).toMatchObject({
        matchedProductId: "prod-9",
        matchedProductName: "Big Red Chewing Gum - Cinnamon",
        confidence: "high",
      });
      expect(result.items[0].candidates).toBeUndefined();
    });

    it("carries the per-line sku through from the OCR JSON to the response", async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              supplier: "Acme Foods",
              items: [{ extractedName: "Widget", sku: "SKU-777", qty: 1, unitCost: 5 }],
            }),
          },
        ],
      });

      const result = await service.scanInvoice([jpegPage]);

      expect(result.items[0].sku).toBe("SKU-777");
    });

    it("carries the per-line packSize through from the OCR JSON to the response", async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              supplier: "Acme Foods",
              items: [{ extractedName: "Widget", packSize: 12, qty: 1, unitCost: 5 }],
            }),
          },
        ],
      });

      const result = await service.scanInvoice([jpegPage]);

      expect(result.items[0].packSize).toBe(12);
    });

    it("leaves packSize null/absent when the OCR JSON doesn't include it", async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              supplier: "Acme Foods",
              items: [{ extractedName: "Widget", qty: 1, unitCost: 5 }],
            }),
          },
        ],
      });

      const result = await service.scanInvoice([jpegPage]);

      expect(result.items[0].packSize).toBeUndefined();
    });
  });

  describe("recordPayment", () => {
    it("rejects a payment that exceeds the remaining balance", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({ totalOwed: 100, payments: [{ amount: 40 }] }),
      );

      await expect(service.recordPayment("bill-1", { amount: 61, method: "CASH" })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.billPayment.create).not.toHaveBeenCalled();
    });

    it("records a payment within the remaining balance and rounds the running total", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({ totalOwed: 100, payments: [{ amount: 40 }] }),
      );
      prisma.billPayment.create.mockResolvedValue({});
      prisma.vendorBill.update.mockResolvedValue({});

      await service.recordPayment("bill-1", { amount: 60, method: "CASH" });

      const data = prisma.vendorBill.update.mock.calls[0][0].data;
      expect(data.totalPaid).toBe(100);
      expect(data.status).toBe("PAID");
    });
  });
});
