import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { DuplicateMatchService } from "./duplicate-match.service";
import { BatchImportService } from "./batch-import.service";

describe("BatchImportService", () => {
  let service: BatchImportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let vendorBills: { scanInvoice: jest.Mock; create: jest.Mock; receive: jest.Mock };
  let dupMatch: { findInvoiceDuplicate: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    vendorBills = {
      scanInvoice: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: "bill1" }),
      receive: jest.fn().mockResolvedValue({}),
    };
    dupMatch = { findInvoiceDuplicate: jest.fn().mockResolvedValue(null) };
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
  });

  const scan = (files = [{ buffer: Buffer.from("x"), mimeType: "application/pdf" }]) =>
    service.scanAndRecord("b1", files, "inv.pdf");

  describe("scanAndRecord classification", () => {
    it("marks CLEAN when every line matched and confidence is high", async () => {
      vendorBills.scanInvoice.mockResolvedValue({
        invoiceNumber: "VB-1",
        total: 100,
        confidence: 0.9,
        lines: [{ productId: "p1" }, { productId: "p2" }],
      });
      await scan();
      expect(prisma.importQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "CLEAN" }) }),
      );
    });

    it("marks NEEDS_REVIEW when a line is unmatched", async () => {
      vendorBills.scanInvoice.mockResolvedValue({
        invoiceNumber: "VB-2",
        total: 50,
        confidence: 0.95,
        lines: [{ productId: "p1" }, { productId: null }],
      });
      await scan();
      expect(prisma.importQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "NEEDS_REVIEW", unmatchedLines: 1 }),
        }),
      );
    });

    it("marks DUPLICATE and links the matched invoice", async () => {
      dupMatch.findInvoiceDuplicate.mockResolvedValue({ id: "dup1", invoiceNumber: "VB-3" });
      vendorBills.scanInvoice.mockResolvedValue({
        invoiceNumber: "VB-3",
        total: 75,
        lines: [{ productId: "p1" }],
      });
      await scan();
      expect(prisma.importQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "DUPLICATE", duplicateOfInvoiceId: "dup1" }),
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
  });

  describe("postBatch", () => {
    it("creates + receives a vendor bill per CLEAN item and marks it POSTED", async () => {
      prisma.importQueueItem.findMany.mockResolvedValue([
        {
          id: "i1",
          batchId: "b1",
          supplierMatchId: "s1",
          invoiceNumber: "VB-1",
          total: "100.00",
          extractedPayload: { lines: [{ productId: "p1" }] },
        },
      ]);
      const res = await service.postBatch("b1", "user-1");
      expect(vendorBills.create).toHaveBeenCalledWith(
        expect.objectContaining({ requireSupplier: false, billNumber: "VB-1" }),
      );
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
  });

  describe("resolveItem", () => {
    it("promotes a NEEDS_REVIEW item to CLEAN", async () => {
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
  });
});
