/**
 * The FILING GATE (Senior Architect ruling 2026-09-21). A return reversal the ledger could not book (pack
 * unknown) is PARKED (RegulatedLedgerParkedReversal, parked <=> resolvedAt IS NULL) and is not in the period's
 * figures. prepareFiling — the artifact an operator files from — refuses while one exists for the tenant,
 * category and period, and the report lists parked rows first and marks its export "do not file".
 */
import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { RegulatedFilingService } from "./regulated-filing.service";
import { RegulatedService } from "./regulated.service";
import { RegulatedReportService } from "./regulated-report.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";

const YEAR = new Date().getUTCFullYear() - 2;
const category = {
  id: "cat-1",
  name: "Tobacco",
  reportTemplate: "GENERIC",
  reportCadence: "MONTHLY",
  unitBasis: "pack",
  wholesalerLicenseNo: null,
  txItemType: null,
  txUom: null,
};

interface ParkedFake {
  id: string;
  returnId: string;
  orderId: string;
  orderItemId: string | null;
  saleEntryId: string;
  returnedPieces: number;
  reason: string;
  periodBucket: string;
  createdAt: Date;
  resolvedAt: Date | null;
}
const parkedRow = (over: Partial<ParkedFake> = {}): ParkedFake => ({
  id: "pk-1",
  returnId: "ret-1",
  orderId: "ord-1",
  orderItemId: "oi-1",
  saleEntryId: "sale-1",
  returnedPieces: 12,
  reason: "no own split and no same-product source line with a split",
  periodBucket: `${YEAR}-01`,
  createdAt: new Date("2026-01-02T00:00:00Z"),
  resolvedAt: null,
  ...over,
});

describe("filing gate: unresolved parked reversals", () => {
  let filing: RegulatedFilingService;
  let reports: RegulatedReportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let storage: { upload: jest.Mock; presignedUrl: jest.Mock };
  let parkedTable: ParkedFake[];
  let salesCategory: Record<string, string>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    storage = {
      upload: jest.fn().mockResolvedValue("key"),
      presignedUrl: jest.fn().mockResolvedValue("https://signed"),
    };
    parkedTable = [];
    salesCategory = { "sale-1": "cat-1" };
    // In-memory stand-ins that honour the two filters the reader depends on (resolvedAt, periodBucket) so
    // "resolve it -> passes" and "another period does not block" are behaviours, not mock plumbing.
    (prisma as any).regulatedLedgerParkedReversal.findMany = jest.fn(async (args: any) =>
      parkedTable
        .filter((r) => (args.where.resolvedAt === null ? r.resolvedAt === null : true))
        .filter((r) => args.where.periodBucket.in.includes(r.periodBucket))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    );
    prisma.regulatedSalesLedger.findMany.mockImplementation(async (args: any) =>
      args.where.id.in
        .filter((id: string) => id in salesCategory)
        .map((id: string) => ({ id, trackedCategoryId: salesCategory[id] })),
    );
    prisma.trackedCategory.findUnique.mockResolvedValue(category);
    prisma.regulatedFiling.findFirst.mockResolvedValue(null);
    prisma.regulatedFiling.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "filing-1", ...args.data }),
    );
    prisma.regulatedFiling.update.mockImplementation((args: any) =>
      Promise.resolve({ id: args.where.id, ...args.data }),
    );
    const regulated = { getLedger: jest.fn().mockResolvedValue({ rows: [], totals: {} }) };
    const mod = await Test.createTestingModule({
      providers: [
        RegulatedFilingService,
        RegulatedReportService,
        { provide: PrismaService, useValue: prisma },
        { provide: RegulatedService, useValue: regulated },
        { provide: StorageService, useValue: storage },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    filing = mod.get(RegulatedFilingService);
    reports = mod.get(RegulatedReportService);
  });

  const prepare = (over: Record<string, unknown> = {}) =>
    filing.prepareFiling({
      trackedCategoryId: "cat-1",
      year: YEAR,
      index: 1,
      userId: "u1",
      ...over,
    });

  describe("prepareFiling", () => {
    it("REFUSES with a 409 naming the count and the action when one parked reversal exists, and writes nothing", async () => {
      parkedTable.push(parkedRow());
      const err: any = await prepare().catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: "PARKED_REVERSALS_UNRESOLVED",
        count: 1,
        returnIds: ["ret-1"],
        message: expect.stringMatching(/1 return reversal\(s\).*parked.*Resolve them/),
      });
      // nothing uploaded, nothing upserted, no existing row overwritten
      expect(storage.upload).not.toHaveBeenCalled();
      expect(prisma.regulatedFiling.create).not.toHaveBeenCalled();
      expect(prisma.regulatedFiling.update).not.toHaveBeenCalled();
    });

    it("PASSES once the row is resolved (resolvedAt set)", async () => {
      parkedTable.push(parkedRow({ resolvedAt: new Date() }));
      await expect(prepare()).resolves.toMatchObject({ id: "filing-1" });
      expect(storage.upload).toHaveBeenCalledTimes(1);
    });

    it("reads through the tenant-scoped client, so another tenant's parked row cannot block", async () => {
      const forTenant = jest.spyOn(prisma as any, "forTenant");
      await prepare();
      expect(forTenant).toHaveBeenCalled();
      const where = (prisma as any).regulatedLedgerParkedReversal.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ resolvedAt: null, periodBucket: { in: [`${YEAR}-01`] } });
    });

    it("a row parked in ANOTHER period does not block", async () => {
      parkedTable.push(parkedRow({ periodBucket: `${YEAR}-02` }));
      await expect(prepare()).resolves.toBeDefined();
    });

    it("a QUARTERLY filing is blocked by a row in any of its three months, and not by the next quarter's", async () => {
      parkedTable.push(parkedRow({ periodBucket: `${YEAR}-03` }));
      await expect(prepare({ cadence: "QUARTERLY", index: 1 })).rejects.toBeInstanceOf(
        ConflictException,
      );
      parkedTable[0].periodBucket = `${YEAR}-04`;
      await expect(prepare({ cadence: "QUARTERLY", index: 1 })).resolves.toBeDefined();
    });

    it("a row whose sale entry belongs to ANOTHER category does not block", async () => {
      salesCategory["sale-1"] = "cat-2";
      parkedTable.push(parkedRow());
      await expect(prepare()).resolves.toBeDefined();
    });

    it("an UNRESOLVABLE row (sale entry not found) blocks every category, and its reason is in the 409", async () => {
      salesCategory = {}; // the pointer has no FK: the sale row cannot be found
      parkedTable.push(parkedRow({ reason: "sale entry gone" }));
      const err: any = await prepare().catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().message).toMatch(
        /cannot be found.*block every category.*sale entry gone/,
      );
    });

    it("a REGENERATION of an existing filing refuses too, leaving the existing row untouched", async () => {
      prisma.regulatedFiling.findFirst.mockResolvedValue({ id: "f-old", generationCount: 1 });
      parkedTable.push(parkedRow());
      await expect(prepare()).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.regulatedFiling.update).not.toHaveBeenCalled();
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it("counts every parked row (two returns) in one refusal", async () => {
      parkedTable.push(
        parkedRow(),
        parkedRow({ id: "pk-2", returnId: "ret-2", saleEntryId: "sale-1" }),
      );
      const err: any = await prepare().catch((e) => e);
      expect(err.getResponse()).toMatchObject({ count: 2, returnIds: ["ret-1", "ret-2"] });
    });
  });

  describe("buildReport (the preview)", () => {
    const range = { category: "cat-1", from: `${YEAR}-01-01`, to: `${YEAR}-01-31` };

    it("lists the parked rows FIRST: first payload key, first warning, first CSV line, marked PREVIEW", async () => {
      parkedTable.push(parkedRow());
      const report = await reports.buildReport(range);
      expect(Object.keys(report)[0]).toBe("parked");
      expect(report.parked).toEqual([
        expect.objectContaining({ returnId: "ret-1", returnedPieces: 12, categoryResolved: true }),
      ]);
      expect(report.warnings[0]).toMatchObject({ code: "PARKED_REVERSALS" });
      expect(report.csv.preamble[0]).toEqual([
        "PREVIEW — 1 unresolved parked reversal(s); do not file from this export",
      ]);
      const csv = (await reports.buildReportCsv(range)).csv;
      expect(csv.split("\n")[0]).toBe(
        "PREVIEW — 1 unresolved parked reversal(s); do not file from this export",
      );
    });

    it("the preview is NOT blocked (it must show the rows), and lists oldest first", async () => {
      parkedTable.push(
        parkedRow({
          id: "pk-late",
          returnId: "ret-late",
          createdAt: new Date("2026-01-20T00:00:00Z"),
        }),
        parkedRow({
          id: "pk-early",
          returnId: "ret-early",
          createdAt: new Date("2026-01-03T00:00:00Z"),
        }),
      );
      const report = await reports.buildReport(range);
      expect(report.parked!.map((p) => p.returnId)).toEqual(["ret-early", "ret-late"]);
    });

    it("a resolved, other-period or other-category row adds nothing: the report is unchanged", async () => {
      parkedTable.push(
        parkedRow({ resolvedAt: new Date() }),
        parkedRow({ id: "pk-2", periodBucket: `${YEAR}-06` }),
      );
      const report = await reports.buildReport(range);
      expect(report).not.toHaveProperty("parked");
      expect(report.warnings.some((w) => w.code === "PARKED_REVERSALS")).toBe(false);
      expect(report.csv.preamble.flat().join(" ")).not.toMatch(/PREVIEW/);
    });

    it("a parked RESTOCK adds only a stock note: no gate, no PREVIEW line", async () => {
      prisma.product.findMany.mockResolvedValue([{ id: "p1" }]);
      prisma.returnParkedRestock.count.mockResolvedValue(2);
      const report = await reports.buildReport(range);
      expect(report.parkedRestockNote).toMatch(/2 return restock\(s\) are parked/);
      expect(report.parked ?? []).toEqual([]);
      expect(report.csv.preamble.flat().join(" ")).not.toMatch(/PREVIEW/);
      await expect(prepare()).resolves.toBeDefined(); // a parked restock never blocks a filing
    });

    it("REJECTS a null-tenant context (SUPER_ADMIN) with the SAME error prepareFiling throws, instead of reading parked rows through an unscoped forTenant() and leaking another tenant's returnIds/orderIds", async () => {
      prisma.getTenantId.mockReturnValue(null);
      const err: any = await reports.buildReport(range).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe("Filings are tenant-scoped");
    });
  });

  describe("downloadUrl / listFilings — re-gated the SAME way prepareFiling is", () => {
    const filingRow = (over: Record<string, unknown> = {}) => ({
      id: "filing-1",
      trackedCategoryId: "cat-1",
      periodKey: `${YEAR}-01`,
      periodStart: new Date(Date.UTC(YEAR, 0, 1)),
      periodEnd: new Date(Date.UTC(YEAR, 1, 1)),
      csvKey: "k",
      pdfKey: null,
      ...over,
    });

    it("downloadUrl REFUSES with the identical 409 body prepareFiling throws when a reversal was parked AFTER this filing was prepared", async () => {
      prisma.regulatedFiling.findUnique.mockResolvedValue(filingRow());
      parkedTable.push(parkedRow());
      const err: any = await filing.downloadUrl("filing-1", "csv").catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: "PARKED_REVERSALS_UNRESOLVED",
        count: 1,
        returnIds: ["ret-1"],
      });
      expect(storage.presignedUrl).not.toHaveBeenCalled();
    });

    it("downloadUrl PASSES (signed url) once nothing is parked for the filing's own period", async () => {
      prisma.regulatedFiling.findUnique.mockResolvedValue(filingRow());
      await expect(filing.downloadUrl("filing-1", "csv")).resolves.toEqual({
        url: "https://signed",
      });
    });

    it("listFilings adds parkedUnresolved via the SAME reader: 0 when clean, the live count once a row is parked", async () => {
      prisma.regulatedFiling.findMany.mockResolvedValue([filingRow()]);
      let rows = await filing.listFilings("cat-1");
      expect(rows).toEqual([expect.objectContaining({ id: "filing-1", parkedUnresolved: 0 })]);

      parkedTable.push(parkedRow());
      rows = await filing.listFilings("cat-1");
      expect(rows).toEqual([expect.objectContaining({ id: "filing-1", parkedUnresolved: 1 })]);
    });

    it("PINS all three surfaces to the identical count for one parked row: listFilings' parkedUnresolved, downloadUrl's 409, and prepareFiling's 409 — they read through the same listParkedReversals and can never disagree", async () => {
      prisma.regulatedFiling.findMany.mockResolvedValue([filingRow()]);
      prisma.regulatedFiling.findUnique.mockResolvedValue(filingRow());
      parkedTable.push(parkedRow()); // ONE parked row, booked after the filing existed

      const listed = await filing.listFilings("cat-1");
      expect(listed[0].parkedUnresolved).toBe(1);

      const downloadErr: any = await filing.downloadUrl("filing-1", "csv").catch((e) => e);
      expect(downloadErr).toBeInstanceOf(ConflictException);
      expect(downloadErr.getResponse().count).toBe(1);

      const prepareErr: any = await prepare().catch((e) => e);
      expect(prepareErr).toBeInstanceOf(ConflictException);
      expect(prepareErr.getResponse().count).toBe(1);
    });
  });
});
