import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { DuplicateMatchService } from "./duplicate-match.service";

/**
 * `createMockPrisma` predates InvoiceScan. Graft the model onto the very object
 * `forTenant()` hands back, so a tenant-scoped call and a direct one see the
 * same jest mocks.
 */
function graftInvoiceScan(prisma: ReturnType<typeof createMockPrisma>) {
  const model = { findFirst: jest.fn().mockResolvedValue(null) };
  (prisma as any).invoiceScan = model;
  (prisma.forTenant() as any).invoiceScan = model;
  return model;
}

describe("DuplicateMatchService", () => {
  let service: DuplicateMatchService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoiceScan: ReturnType<typeof graftInvoiceScan>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    invoiceScan = graftInvoiceScan(prisma);
    const moduleRef = await Test.createTestingModule({
      providers: [DuplicateMatchService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(DuplicateMatchService);
  });

  describe("normalizeNumber", () => {
    it("strips whitespace and uppercases", () => {
      expect(service.normalizeNumber("inv 088 41")).toBe("INV08841");
    });
  });

  describe("findInvoiceDuplicate", () => {
    it("matches a same-number candidate within the date/total window", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        { id: "inv-a", invoiceNumber: "INV-08841" },
        { id: "inv-b", invoiceNumber: "OTHER-1" },
      ]);
      const match = await service.findInvoiceDuplicate({
        number: "inv-08841",
        total: 2202.04,
        issueDate: new Date("2026-07-01"),
      });
      expect(match).toEqual({ id: "inv-a", invoiceNumber: "INV-08841" });
    });

    it("queries a ±1 day window and total-to-the-cent range", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      await service.findInvoiceDuplicate({
        number: "X",
        total: 100,
        issueDate: new Date("2026-07-10T12:00:00Z"),
      });
      const where = prisma.invoice.findMany.mock.calls[0][0].where;
      expect(where.total).toEqual({ gte: 100 - 0.005, lte: 100 + 0.005 });
      expect(where.issueDate.gte).toEqual(new Date("2026-07-09T12:00:00Z"));
      expect(where.issueDate.lte).toEqual(new Date("2026-07-11T12:00:00Z"));
    });

    it("returns null when no candidate shares the number", async () => {
      prisma.invoice.findMany.mockResolvedValue([{ id: "x", invoiceNumber: "DIFFERENT" }]);
      await expect(
        service.findInvoiceDuplicate({ number: "INV-1", total: 5, issueDate: new Date() }),
      ).resolves.toBeNull();
    });

    it("matches on total+date alone when no number is supplied", async () => {
      prisma.invoice.findMany.mockResolvedValue([{ id: "y", invoiceNumber: "ANY" }]);
      await expect(
        service.findInvoiceDuplicate({ total: 5, issueDate: new Date() }),
      ).resolves.toEqual({ id: "y", invoiceNumber: "ANY" });
    });
  });

  describe("findVendorBillDuplicate", () => {
    const billRow = (overrides: Record<string, unknown> = {}) => ({
      id: "vb-1",
      billNumber: "BILL-2026-0001",
      status: "DRAFT",
      totalOwed: 100,
      billDate: new Date("2026-07-01"),
      receivedDate: null,
      supplierId: "sup-1",
      notes: null,
      _count: { items: 3 },
      ...overrides,
    });

    /** Layer 1 queries the column; layers 2/3 query the date/total window. */
    const respond = (byNumber: unknown[], fuzzy: unknown[]) =>
      prisma.vendorBill.findMany.mockImplementation((args: any) =>
        Promise.resolve(args.where.supplierInvoiceNumber !== undefined ? byNumber : fuzzy),
      );

    it("prefers the persisted column over the legacy notes scan", async () => {
      respond([billRow({ id: "vb-column" })], [billRow({ id: "vb-notes" })]);

      const match = await service.findVendorBillDuplicate({
        supplierId: "sup-1",
        number: "INV-1",
        total: 100,
        issueDate: new Date("2026-07-01"),
      });

      expect(match).toMatchObject({ id: "vb-column", matchedBy: "number" });
      expect(prisma.vendorBill.findMany).toHaveBeenCalledTimes(1);
    });

    it("falls back to the notes phrase for rows written before the column existed", async () => {
      respond([], [billRow({ id: "vb-legacy", notes: "Batch import — Supplier invoice #INV-1" })]);

      const match = await service.findVendorBillDuplicate({
        supplierId: "sup-1",
        number: "inv-1",
        total: 100,
        issueDate: new Date("2026-07-01"),
      });

      expect(match).toMatchObject({ id: "vb-legacy", matchedBy: "number" });
    });

    it("excludes VOID bills in both the column and the notes layer", async () => {
      respond([], []);

      await service.findVendorBillDuplicate({
        supplierId: "sup-1",
        number: "INV-1",
        total: 100,
        issueDate: new Date("2026-07-01"),
      });

      const wheres = prisma.vendorBill.findMany.mock.calls.map((c: any[]) => c[0].where);
      expect(wheres).toHaveLength(2);
      for (const where of wheres) expect(where.status).toEqual({ not: "VOID" });
    });

    it("reaches a supplier-less bill on an exact number match", async () => {
      respond([billRow({ id: "vb-unassigned", supplierId: null })], []);

      await expect(
        service.findVendorBillDuplicate({ supplierId: "sup-1", number: "INV-1", total: 100 }),
      ).resolves.toMatchObject({ id: "vb-unassigned", matchedBy: "number" });

      const where = prisma.vendorBill.findMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([{ supplierId: "sup-1" }, { supplierId: null }]);
      expect(where.supplierId).toBeUndefined();
    });

    it("prefers the caller's own supplier over a supplier-less row carrying the number", async () => {
      respond(
        [billRow({ id: "vb-unassigned", supplierId: null }), billRow({ id: "vb-exact" })],
        [],
      );

      await expect(
        service.findVendorBillDuplicate({ supplierId: "sup-1", number: "INV-1", total: 100 }),
      ).resolves.toMatchObject({ id: "vb-exact" });
    });

    it("reaches a supplier-less row through the legacy notes layer too", async () => {
      respond(
        [],
        [billRow({ id: "vb-legacy", supplierId: null, notes: "Supplier invoice #INV-1" })],
      );

      await expect(
        service.findVendorBillDuplicate({
          supplierId: "sup-1",
          number: "INV-1",
          total: 100,
          issueDate: new Date("2026-07-01"),
        }),
      ).resolves.toMatchObject({ id: "vb-legacy", matchedBy: "number" });

      const notesWhere = prisma.vendorBill.findMany.mock.calls[1][0].where;
      expect(notesWhere.OR).toEqual([{ supplierId: "sup-1" }, { supplierId: null }]);
    });

    it("keeps the numberless fuzzy layer scoped to the caller's supplier alone", async () => {
      respond([], [billRow({ id: "vb-fuzzy" })]);

      await service.findVendorBillDuplicate({
        supplierId: "sup-1",
        total: 100,
        issueDate: new Date("2026-07-01"),
      });

      const where = prisma.vendorBill.findMany.mock.calls[0][0].where;
      expect(where.supplierId).toBe("sup-1");
      expect(where.OR).toBeUndefined();
    });

    it("requires the totals to agree when a number arrives without a supplier", async () => {
      respond([billRow({ totalOwed: 250 })], []);

      await expect(
        service.findVendorBillDuplicate({ number: "INV-1", total: 100 }),
      ).resolves.toBeNull();
      await expect(
        service.findVendorBillDuplicate({ number: "INV-1", total: 250 }),
      ).resolves.toMatchObject({ id: "vb-1", totalMatches: true });
    });

    it("matches on supplier + number even when the total drifted, flagging the mismatch", async () => {
      respond([billRow({ totalOwed: 250 })], []);

      await expect(
        service.findVendorBillDuplicate({ supplierId: "sup-1", number: "INV-1", total: 100 }),
      ).resolves.toMatchObject({ id: "vb-1", totalMatches: false });
    });

    it("normalizes both sides of the number comparison", async () => {
      respond([], [billRow({ id: "vb-legacy", notes: "Supplier invoice #AB12" })]);

      const match = await service.findVendorBillDuplicate({
        supplierId: "sup-1",
        number: "ab 12",
        total: 100,
        issueDate: new Date("2026-07-01"),
      });

      expect(match).toMatchObject({ id: "vb-legacy" });
      expect(prisma.vendorBill.findMany.mock.calls[0][0].where.supplierInvoiceNumber).toBe("AB12");
    });

    describe("without a number", () => {
      it("matches the first candidate when supplier, date and total are all present", async () => {
        respond([], [billRow({ id: "vb-fuzzy" })]);

        await expect(
          service.findVendorBillDuplicate({
            supplierId: "sup-1",
            total: 100,
            issueDate: new Date("2026-07-01"),
          }),
        ).resolves.toMatchObject({ id: "vb-fuzzy", matchedBy: "fuzzy" });
      });

      it.each([
        ["supplier", { total: 100, issueDate: new Date("2026-07-01") }],
        ["date", { supplierId: "sup-1", total: 100 }],
        ["total", { supplierId: "sup-1", issueDate: new Date("2026-07-01") }],
      ])("returns null without querying when the %s is missing", async (_label, params) => {
        respond([], [billRow()]);

        await expect(service.findVendorBillDuplicate(params)).resolves.toBeNull();
        expect(prisma.vendorBill.findMany).not.toHaveBeenCalled();
      });
    });

    it("returns the enriched payload the caller needs to explain the block", async () => {
      respond(
        [
          billRow({
            id: "vb-9",
            billNumber: "BILL-2026-0009",
            status: "RECEIVED",
            totalOwed: 100,
            receivedDate: new Date("2026-07-03"),
            _count: { items: 7 },
          }),
        ],
        [],
      );

      await expect(
        service.findVendorBillDuplicate({ supplierId: "sup-1", number: "INV-1", total: 100 }),
      ).resolves.toEqual({
        id: "vb-9",
        billNumber: "BILL-2026-0009",
        status: "RECEIVED",
        totalOwed: 100,
        billDate: new Date("2026-07-01"),
        receivedDate: new Date("2026-07-03"),
        supplierId: "sup-1",
        itemCount: 7,
        matchedBy: "number",
        totalMatches: true,
      });
    });
  });

  describe("findScanDuplicate", () => {
    const scanRow = (overrides: Record<string, unknown> = {}) => ({
      id: "scan-1",
      status: "POSTED",
      createdAt: new Date("2026-08-01"),
      vendorBillId: "vb-1",
      supplierInvoiceNumber: "INV-1",
      total: 117,
      ...overrides,
    });

    /** Each key is a separate findFirst; answer per the `where` it was given. */
    const respondByKey = (byKey: Record<string, unknown>) =>
      invoiceScan.findFirst.mockImplementation((args: any) => {
        if (args.where.fileHash !== undefined) return Promise.resolve(byKey.file ?? null);
        if (args.where.lineFingerprint !== undefined) return Promise.resolve(byKey.lines ?? null);
        return Promise.resolve(byKey.number ?? null);
      });

    it("prefers the file hash over the line fingerprint and the number", async () => {
      respondByKey({
        file: scanRow({ id: "by-file" }),
        lines: scanRow({ id: "by-lines" }),
        number: scanRow({ id: "by-number" }),
      });

      await expect(
        service.findScanDuplicate({ fileHash: "h", lineFingerprint: "f", number: "INV-1" }),
      ).resolves.toMatchObject({ id: "by-file", matchedBy: "file" });
      expect(invoiceScan.findFirst).toHaveBeenCalledTimes(1);
    });

    it("prefers the line fingerprint over the number", async () => {
      respondByKey({ lines: scanRow({ id: "by-lines" }), number: scanRow({ id: "by-number" }) });

      await expect(
        service.findScanDuplicate({ fileHash: "h", lineFingerprint: "f", number: "INV-1" }),
      ).resolves.toMatchObject({ id: "by-lines", matchedBy: "lines" });
    });

    it("falls through to the printed invoice number, normalized", async () => {
      respondByKey({ number: scanRow({ id: "by-number" }) });

      await expect(
        service.findScanDuplicate({ fileHash: "h", lineFingerprint: "f", number: "inv 1" }),
      ).resolves.toMatchObject({ id: "by-number", matchedBy: "number" });
      expect(invoiceScan.findFirst.mock.calls[2][0].where.supplierInvoiceNumber).toBe("INV1");
    });

    it("returns null when no key hits", async () => {
      respondByKey({});
      await expect(
        service.findScanDuplicate({ fileHash: "h", lineFingerprint: "f", number: "INV-1" }),
      ).resolves.toBeNull();
    });

    it("ignores DISCARDED scans on every key", async () => {
      respondByKey({});
      await service.findScanDuplicate({ fileHash: "h", lineFingerprint: "f", number: "INV-1" });

      const wheres = invoiceScan.findFirst.mock.calls.map((c: any[]) => c[0].where);
      expect(wheres).toHaveLength(3);
      for (const where of wheres) expect(where.status).toEqual({ not: "DISCARDED" });
    });

    it("is tenant-scoped — every read goes through forTenant()", async () => {
      respondByKey({});
      await service.findScanDuplicate({ fileHash: "h" });
      expect(prisma.forTenant).toHaveBeenCalled();
    });

    it("narrows the fingerprint and number lookups by supplier, but not the file lookup", async () => {
      // Identical bytes are the same document whoever sent it, so fileHash must
      // stay unscoped. Identical qty/unit-cost figures from a different supplier
      // are a coincidence — a repeat standing order must not be flagged against
      // an unrelated vendor — so lines and number both narrow.
      respondByKey({});
      await service.findScanDuplicate({
        fileHash: "h",
        lineFingerprint: "f",
        number: "INV-1",
        supplierId: "sup-1",
      });

      const fileWhere = invoiceScan.findFirst.mock.calls[0][0].where;
      expect(fileWhere.OR).toBeUndefined();
      expect(fileWhere.supplierId).toBeUndefined();

      const linesWhere = invoiceScan.findFirst.mock.calls[1][0].where;
      expect(linesWhere.OR).toEqual([{ supplierId: "sup-1" }, { supplierId: null }]);

      const numberWhere = invoiceScan.findFirst.mock.calls[2][0].where;
      expect(numberWhere.OR).toEqual([{ supplierId: "sup-1" }, { supplierId: null }]);
    });

    it("skips a key that wasn't supplied instead of matching on an empty value", async () => {
      respondByKey({ file: scanRow() });
      await expect(service.findScanDuplicate({ lineFingerprint: "f" })).resolves.toBeNull();
      expect(invoiceScan.findFirst).toHaveBeenCalledTimes(1);
    });

    it("reports the newest handling of the document", async () => {
      respondByKey({ file: scanRow({ status: "SCANNED", vendorBillId: null, total: null }) });

      await expect(service.findScanDuplicate({ fileHash: "h" })).resolves.toEqual({
        id: "scan-1",
        status: "SCANNED",
        createdAt: new Date("2026-08-01"),
        vendorBillId: null,
        supplierInvoiceNumber: "INV-1",
        total: null,
        matchedBy: "file",
      });
      expect(invoiceScan.findFirst.mock.calls[0][0].orderBy).toEqual({ createdAt: "desc" });
    });
  });
});
