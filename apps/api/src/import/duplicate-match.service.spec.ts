import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { DuplicateMatchService } from "./duplicate-match.service";

describe("DuplicateMatchService", () => {
  let service: DuplicateMatchService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
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
});
