import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { DuplicateMatchService } from "./duplicate-match.service";
import { BatchImportService } from "./batch-import.service";

describe("BatchImportService", () => {
  let service: BatchImportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let vendorBills: {
    scanInvoice: jest.Mock;
    create: jest.Mock;
    receive: jest.Mock;
    saveProductMapping: jest.Mock;
  };
  let dupMatch: { findInvoiceDuplicate: jest.Mock; findVendorBillDuplicate: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    vendorBills = {
      scanInvoice: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: "bill1" }),
      receive: jest.fn().mockResolvedValue({}),
      saveProductMapping: jest.fn().mockResolvedValue({}),
    };
    dupMatch = {
      findInvoiceDuplicate: jest.fn().mockResolvedValue(null),
      findVendorBillDuplicate: jest.fn().mockResolvedValue(null),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        BatchImportService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: vendorBills },
        { provide: DuplicateMatchService, useValue: dupMatch },
      ],
    }).compile();
    service = moduleRef.get(BatchImportService);
    prisma.importBatch.findUnique.mockResolvedValue({ id: "b1" });
    prisma.importQueueItem.create.mockResolvedValue({ id: "i1" });
    prisma.importQueueItem.update.mockImplementation((args: any) =>
      Promise.resolve({ id: "i1", ...args.data }),
    );
    // No suppliers by default — tests that care about matching set this explicitly.
    prisma.supplier.findMany.mockResolvedValue([]);
  });

  const scan = (files = [{ buffer: Buffer.from("x"), mimeType: "application/pdf" }]) =>
    service.scanAndRecord("b1", files, "inv.pdf");

  describe("scanAndRecord classification", () => {
    it("marks CLEAN when every line is matched at high confidence", async () => {
      vendorBills.scanInvoice.mockResolvedValue({
        invoiceNumber: "VB-1",
        invoiceDate: "2026-07-01",
        total: 100,
        items: [
          { matchedProductId: "p1", confidence: "high" },
          { matchedProductId: "p2", confidence: "high" },
        ],
      });
      await scan();
      expect(prisma.importQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "CLEAN" }) }),
      );
    });

    it("marks NEEDS_REVIEW when a line is unmatched", async () => {
      vendorBills.scanInvoice.mockResolvedValue({
        invoiceNumber: "VB-2",
        invoiceDate: "2026-07-01",
        total: 50,
        items: [
          { matchedProductId: "p1", confidence: "high" },
          { matchedProductId: null, confidence: "none" },
        ],
      });
      await scan();
      expect(prisma.importQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "NEEDS_REVIEW", unmatchedLines: 1 }),
        }),
      );
    });

    it("marks NEEDS_REVIEW when a matched line is only low-confidence", async () => {
      vendorBills.scanInvoice.mockResolvedValue({
        invoiceNumber: "VB-2b",
        invoiceDate: "2026-07-01",
        total: 20,
        items: [{ matchedProductId: "p1", confidence: "low" }],
      });
      await scan();
      expect(prisma.importQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "NEEDS_REVIEW" }) }),
      );
    });

    it("marks DUPLICATE against an existing VENDOR BILL (not the customer Invoice table)", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue({
        id: "vb-dup1",
        billNumber: "BILL-2026-0009",
      });
      vendorBills.scanInvoice.mockResolvedValue({
        invoiceNumber: "VB-3",
        invoiceDate: "2026-07-01",
        total: 75,
        items: [{ matchedProductId: "p1", confidence: "high" }],
      });
      await scan();
      expect(dupMatch.findVendorBillDuplicate).toHaveBeenCalledWith(
        expect.objectContaining({ number: "VB-3", total: 75 }),
      );
      expect(dupMatch.findInvoiceDuplicate).not.toHaveBeenCalled();
      expect(prisma.importQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "DUPLICATE", duplicateOfInvoiceId: "vb-dup1" }),
        }),
      );
    });

    it("marks FAILED and keeps the file when extraction throws", async () => {
      vendorBills.scanInvoice.mockRejectedValue(new Error("no api key"));
      await expect(scan()).rejects.toThrow();
      expect(prisma.importQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }),
      );
    });

    it("resolves the extracted supplier name to a Supplier and stores supplierMatchId", async () => {
      prisma.supplier.findMany.mockResolvedValue([
        { id: "sup-1", name: "Acme Wholesale" },
        { id: "sup-2", name: "Other Foods" },
      ]);
      vendorBills.scanInvoice.mockResolvedValue({
        supplier: "acme wholesale", // case-insensitive exact match
        invoiceNumber: "VB-4",
        invoiceDate: "2026-07-01",
        total: 30,
        items: [{ matchedProductId: "p1", confidence: "high" }],
      });
      await scan();
      expect(prisma.importQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "CLEAN", supplierMatchId: "sup-1" }),
        }),
      );
      // findVendorBillDuplicate should narrow by the resolved supplier
      expect(dupMatch.findVendorBillDuplicate).toHaveBeenCalledWith(
        expect.objectContaining({ supplierId: "sup-1" }),
      );
    });

    it("routes to NEEDS_REVIEW when a supplier name was detected but can't be resolved to exactly one supplier", async () => {
      prisma.supplier.findMany.mockResolvedValue([{ id: "sup-1", name: "Unrelated Co" }]);
      vendorBills.scanInvoice.mockResolvedValue({
        supplier: "Some New Vendor",
        invoiceNumber: "VB-5",
        invoiceDate: "2026-07-01",
        total: 40,
        items: [{ matchedProductId: "p1", confidence: "high" }], // lines are otherwise clean
      });
      await scan();
      expect(prisma.importQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "NEEDS_REVIEW", supplierMatchId: null }),
        }),
      );
    });

    it("marks NEEDS_REVIEW and counts a null-matched line that only carries candidate suggestions", async () => {
      vendorBills.scanInvoice.mockResolvedValue({
        invoiceNumber: "VB-7",
        invoiceDate: "2026-07-01",
        total: 15,
        items: [
          {
            extractedName: "Big Red Cinnamon Gum",
            matchedProductId: null,
            confidence: "low",
            candidates: [
              { productId: "p1", name: "Big Red Chewing Gum - Cinnamon", sku: null, score: 0.5 },
            ],
          },
        ],
      });
      await scan();
      expect(prisma.importQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "NEEDS_REVIEW", unmatchedLines: 1 }),
        }),
      );
    });

    it("does not require a supplier when the scan detected none (unnamed/blank supplier)", async () => {
      vendorBills.scanInvoice.mockResolvedValue({
        supplier: null,
        invoiceNumber: "VB-6",
        invoiceDate: "2026-07-01",
        total: 10,
        items: [{ matchedProductId: "p1", confidence: "high" }],
      });
      await scan();
      expect(prisma.importQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "CLEAN" }) }),
      );
    });
  });

  describe("postBatch", () => {
    it("creates + receives a vendor bill per CLEAN item, using the invoice's OWN date and a parseable supplier-invoice note", async () => {
      prisma.importQueueItem.findMany.mockResolvedValue([
        {
          id: "i1",
          batchId: "b1",
          supplierMatchId: "s1",
          invoiceNumber: "VB-1",
          total: "100.00",
          extractedPayload: {
            invoiceDate: "2026-06-15",
            items: [{ matchedProductId: "p1", extractedName: "Widget", qty: 2, unitCost: 5 }],
          },
        },
      ]);
      const res = await service.postBatch("b1", "user-1");
      expect(vendorBills.create).toHaveBeenCalledWith(
        expect.objectContaining({
          requireSupplier: false,
          supplierId: "s1",
          items: [expect.objectContaining({ productId: "p1", qty: 2, unitCost: 5 })],
          notes: "Batch import — Supplier invoice #VB-1",
        }),
      );
      // billDate must reflect the EXTRACTED invoice date, not "today".
      const billDateArg = vendorBills.create.mock.calls[0][0].billDate as Date;
      expect(billDateArg.toISOString().slice(0, 10)).toBe("2026-06-15");
      expect(vendorBills.receive).toHaveBeenCalledWith(
        "bill1",
        { acknowledgeUnlinked: true },
        "user-1",
      );
      expect(prisma.importQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "POSTED", vendorBillId: "bill1" } }),
      );
      expect(res.posted).toBe(1);
    });

    it("passes the supplier invoice number so the bill carries the dedup key", async () => {
      prisma.importQueueItem.findMany.mockResolvedValue([
        {
          id: "i1",
          batchId: "b1",
          supplierMatchId: "s1",
          invoiceNumber: "VB-1",
          total: "100.00",
          extractedPayload: { items: [{ matchedProductId: "p1", qty: 1, unitCost: 100 }] },
        },
      ]);
      await service.postBatch("b1", "user-1");
      expect(vendorBills.create).toHaveBeenCalledWith(
        expect.objectContaining({ supplierInvoiceNumber: "VB-1" }),
      );
    });

    it("falls back to today's date when the scan didn't extract an invoice date", async () => {
      prisma.importQueueItem.findMany.mockResolvedValue([
        {
          id: "i1",
          batchId: "b1",
          supplierMatchId: null,
          invoiceNumber: null,
          total: "10.00",
          extractedPayload: { items: [{ matchedProductId: "p1", qty: 1, unitCost: 10 }] },
        },
      ]);
      await service.postBatch("b1", "user-1");
      const billDateArg = vendorBills.create.mock.calls[0][0].billDate as Date;
      expect(billDateArg.toISOString().slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    });

    describe("when create reports an existing bill", () => {
      const duplicateConflict = (overrides: Record<string, unknown> = {}) =>
        new ConflictException({
          code: "DUPLICATE_VENDOR_BILL",
          message: "already recorded",
          duplicate: {
            billId: "vb-existing",
            billNumber: "BILL-2026-0009",
            resumable: false,
            matchedBy: "number",
            ...overrides,
          },
        });

      const queueItems = (count = 1) =>
        prisma.importQueueItem.findMany.mockResolvedValue(
          Array.from({ length: count }, (_, n) => ({
            id: `i${n + 1}`,
            batchId: "b1",
            supplierMatchId: "s1",
            invoiceNumber: `VB-${n + 1}`,
            total: "10.00",
            extractedPayload: { items: [{ matchedProductId: "p1", qty: 1, unitCost: 10 }] },
          })),
        );

      it("adopts a NUMBER match, links it, and counts it apart from a fresh post", async () => {
        queueItems();
        vendorBills.create.mockRejectedValue(duplicateConflict());

        const res = await service.postBatch("b1", "user-1");

        expect(res).toMatchObject({ posted: 0, adopted: 1, duplicates: 0 });
        expect(prisma.importQueueItem.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: {
              status: "POSTED",
              vendorBillId: "vb-existing",
              duplicateOfInvoiceId: "vb-existing",
            },
          }),
        );
      });

      it("leaves a FUZZY match unposted for review rather than discarding its lines", async () => {
        queueItems();
        vendorBills.create.mockRejectedValue(duplicateConflict({ matchedBy: "fuzzy" }));

        const res = await service.postBatch("b1", "user-1");

        expect(res).toMatchObject({ posted: 0, adopted: 0, duplicates: 1 });
        expect(vendorBills.receive).not.toHaveBeenCalled();
        const data = prisma.importQueueItem.update.mock.calls[0][0].data;
        expect(data.status).toBe("DUPLICATE");
        expect(data.vendorBillId).toBeUndefined();
        expect(data.duplicateOfInvoiceId).toBe("vb-existing");
        expect(data.errorMessage).toContain("BILL-2026-0009");
      });

      it("does not adopt a 409 that never says what matched", async () => {
        queueItems();
        vendorBills.create.mockRejectedValue(duplicateConflict({ matchedBy: undefined }));

        const res = await service.postBatch("b1", "user-1");

        expect(res).toMatchObject({ posted: 0, adopted: 0, duplicates: 1 });
        expect(vendorBills.receive).not.toHaveBeenCalled();
      });

      it("receives a DRAFT match — the first attempt's stock never landed", async () => {
        queueItems();
        vendorBills.create.mockRejectedValue(duplicateConflict({ resumable: true }));

        await service.postBatch("b1", "user-1");

        expect(vendorBills.receive).toHaveBeenCalledWith(
          "vb-existing",
          { acknowledgeUnlinked: true },
          "user-1",
        );
      });

      it("swallows an 'already received' race while resuming a DRAFT match", async () => {
        queueItems();
        vendorBills.create.mockRejectedValue(duplicateConflict({ resumable: true }));
        vendorBills.receive.mockRejectedValue(new ConflictException("Bill already received"));

        const res = await service.postBatch("b1", "user-1");

        expect(res).toMatchObject({ posted: 0, adopted: 1 });
      });

      it("does not re-receive an already-received match", async () => {
        queueItems();
        vendorBills.create.mockRejectedValue(duplicateConflict());

        await service.postBatch("b1", "user-1");

        expect(vendorBills.receive).not.toHaveBeenCalled();
      });

      it("keeps posting the rest of the batch", async () => {
        queueItems(2);
        vendorBills.create
          .mockRejectedValueOnce(duplicateConflict())
          .mockResolvedValueOnce({ id: "bill2" });

        const res = await service.postBatch("b1", "user-1");

        expect(res).toMatchObject({ posted: 1, adopted: 1 });
        expect(vendorBills.receive).toHaveBeenCalledWith(
          "bill2",
          { acknowledgeUnlinked: true },
          "user-1",
        );
      });

      it("still fails the item on any other error", async () => {
        queueItems();
        vendorBills.create.mockRejectedValue(new Error("db down"));

        await expect(service.postBatch("b1", "user-1")).rejects.toThrow("db down");
        expect(prisma.importQueueItem.update).not.toHaveBeenCalled();
      });
    });
  });

  describe("updateItemLines", () => {
    it("maps an unmatched line to a product, marks it reviewed, and flips to CLEAN once nothing else is pending", async () => {
      prisma.importQueueItem.findUnique.mockResolvedValue({
        id: "i1",
        batchId: "b1",
        status: "NEEDS_REVIEW",
        supplierMatchId: "s1",
        duplicateOfInvoiceId: null,
        extractedPayload: {
          supplier: "Acme",
          items: [{ extractedName: "Mystery Item", qty: 1, unitCost: 5, matchedProductId: null }],
        },
      });
      prisma.product.findMany.mockResolvedValue([{ id: "p9", name: "Widget 9" }]);

      const result = await service.updateItemLines("i1", {
        lines: [{ index: 0, productId: "p9" }],
      });

      const data = prisma.importQueueItem.update.mock.calls[0][0].data;
      expect(data.status).toBe("CLEAN");
      expect(data.unmatchedLines).toBe(0);
      expect(data.extractedPayload.items[0]).toMatchObject({
        matchedProductId: "p9",
        matchedProductName: "Widget 9",
        confidence: "high",
        reviewed: true,
      });
      expect(result.unreviewedLines).toBe(0);
      expect(vendorBills.saveProductMapping).toHaveBeenCalledWith("Acme", "Mystery Item", "p9");
    });

    it("does not write a product mapping when the supplier name is missing", async () => {
      prisma.importQueueItem.findUnique.mockResolvedValue({
        id: "i1",
        batchId: "b1",
        status: "NEEDS_REVIEW",
        supplierMatchId: null,
        duplicateOfInvoiceId: null,
        extractedPayload: {
          items: [{ extractedName: "Mystery Item", qty: 1, unitCost: 5, matchedProductId: null }],
        },
      });
      prisma.product.findMany.mockResolvedValue([{ id: "p9", name: "Widget 9" }]);

      await service.updateItemLines("i1", { lines: [{ index: 0, productId: "p9" }] });

      expect(vendorBills.saveProductMapping).not.toHaveBeenCalled();
    });

    it("does not write a product mapping when the line has no extractedName", async () => {
      prisma.importQueueItem.findUnique.mockResolvedValue({
        id: "i1",
        batchId: "b1",
        status: "NEEDS_REVIEW",
        supplierMatchId: "s1",
        duplicateOfInvoiceId: null,
        extractedPayload: {
          supplier: "Acme",
          items: [{ qty: 1, unitCost: 5, matchedProductId: null }],
        },
      });
      prisma.product.findMany.mockResolvedValue([{ id: "p9", name: "Widget 9" }]);

      await service.updateItemLines("i1", { lines: [{ index: 0, productId: "p9" }] });

      expect(vendorBills.saveProductMapping).not.toHaveBeenCalled();
    });

    it("keeps a line custom (unmatched but reviewed) without blocking on that line again", async () => {
      prisma.importQueueItem.findUnique.mockResolvedValue({
        id: "i1",
        batchId: "b1",
        status: "NEEDS_REVIEW",
        supplierMatchId: "s1",
        duplicateOfInvoiceId: null,
        extractedPayload: {
          items: [{ extractedName: "Freight", qty: 1, unitCost: 25, matchedProductId: null }],
        },
      });

      const result = await service.updateItemLines("i1", {
        lines: [{ index: 0, keepCustom: true }],
      });

      const data = prisma.importQueueItem.update.mock.calls[0][0].data;
      // Still "unmatched" for the badge count, but NOT "unreviewed" — the
      // operator explicitly decided this stays a custom line.
      expect(data.unmatchedLines).toBe(1);
      expect(data.status).toBe("NEEDS_REVIEW"); // unmatchedLines > 0 keeps it in review
      expect(result.unreviewedLines).toBe(0);
    });

    it("links a supplier and clears supplierUnresolved", async () => {
      prisma.importQueueItem.findUnique.mockResolvedValue({
        id: "i1",
        batchId: "b1",
        status: "NEEDS_REVIEW",
        supplierMatchId: null,
        duplicateOfInvoiceId: null,
        extractedPayload: { supplier: "Some Vendor", items: [{ matchedProductId: "p1" }] },
      });
      prisma.supplier.findUnique.mockResolvedValue({ id: "sup-9", name: "Some Vendor Inc" });

      const result = await service.updateItemLines("i1", { supplierId: "sup-9" });

      const data = prisma.importQueueItem.update.mock.calls[0][0].data;
      expect(data.supplierMatchId).toBe("sup-9");
      expect(data.status).toBe("CLEAN");
      expect(result.supplierUnresolved).toBe(false);
    });

    it("rejects a supplierId that doesn't exist in this tenant", async () => {
      prisma.importQueueItem.findUnique.mockResolvedValue({
        id: "i1",
        batchId: "b1",
        status: "NEEDS_REVIEW",
        supplierMatchId: null,
        duplicateOfInvoiceId: null,
        extractedPayload: { items: [] },
      });
      prisma.supplier.findUnique.mockResolvedValue(null);

      await expect(service.updateItemLines("i1", { supplierId: "nope" })).rejects.toThrow(
        "Supplier not found",
      );
    });

    it("rejects an already-POSTED item", async () => {
      prisma.importQueueItem.findUnique.mockResolvedValue({ id: "i1", status: "POSTED" });
      await expect(
        service.updateItemLines("i1", { lines: [{ index: 0, keepCustom: true }] }),
      ).rejects.toThrow("Item already posted.");
    });
  });

  describe("resolveItem", () => {
    it("promotes a NEEDS_REVIEW item to CLEAN when there's nothing pending", async () => {
      prisma.importQueueItem.findUnique.mockResolvedValue({
        id: "i1",
        batchId: "b1",
        status: "NEEDS_REVIEW",
      });
      await service.resolveItem("i1");
      expect(prisma.importQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "CLEAN", unmatchedLines: 0 } }),
      );
    });

    it("blocks resolution while a line has never been reviewed — no silent skip-to-CLEAN", async () => {
      prisma.importQueueItem.findUnique.mockResolvedValue({
        id: "i1",
        batchId: "b1",
        status: "NEEDS_REVIEW",
        extractedPayload: {
          items: [{ extractedName: "Mystery", matchedProductId: null, reviewed: false }],
        },
      });
      await expect(service.resolveItem("i1")).rejects.toThrow(/1 line still needs review/);
      expect(prisma.importQueueItem.update).not.toHaveBeenCalled();
    });

    it("allows resolution once an unmatched line was explicitly reviewed (kept custom)", async () => {
      prisma.importQueueItem.findUnique.mockResolvedValue({
        id: "i1",
        batchId: "b1",
        status: "NEEDS_REVIEW",
        supplierMatchId: null,
        extractedPayload: {
          items: [{ extractedName: "Freight", matchedProductId: null, reviewed: true }],
        },
      });
      await service.resolveItem("i1");
      expect(prisma.importQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "CLEAN", unmatchedLines: 1 } }),
      );
    });

    it("blocks resolution while a detected supplier is still unlinked", async () => {
      prisma.importQueueItem.findUnique.mockResolvedValue({
        id: "i1",
        batchId: "b1",
        status: "NEEDS_REVIEW",
        supplierMatchId: null,
        extractedPayload: { supplier: "Acme Foods", items: [] },
      });
      await expect(service.resolveItem("i1")).rejects.toThrow(/Pick a supplier/);
      expect(prisma.importQueueItem.update).not.toHaveBeenCalled();
    });

    it("rejects resolving a DUPLICATE item", async () => {
      prisma.importQueueItem.findUnique.mockResolvedValue({
        id: "i1",
        batchId: "b1",
        status: "DUPLICATE",
      });
      await expect(service.resolveItem("i1")).rejects.toThrow(/matches an existing vendor bill/);
    });
  });

  describe("listBatches", () => {
    it("returns recent batches for the tenant, most recent first", async () => {
      prisma.importBatch.findMany.mockResolvedValue([{ id: "b2" }, { id: "b1" }]);
      const result = await service.listBatches();
      expect(prisma.importBatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: "desc" } }),
      );
      expect(result).toEqual([{ id: "b2" }, { id: "b1" }]);
    });
  });
});
