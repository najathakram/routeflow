/**
 * The operator RESOLUTION of a parked return reversal. The operator supplies only the PACK; the reversal is
 * booked from the row's stored pieces and stored SALE row through the SAME maths as the automatic path
 * (reverseReturnEntries), and the filing gate lifts once nothing is parked.
 */
import { Test } from "@nestjs/testing";
import { NotFoundException, UnprocessableEntityException, ConflictException } from "@nestjs/common";
import { ParkedResolutionService } from "./parked-resolution.service";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { RegulatedFilingService } from "./regulated-filing.service";
import { RegulatedReportService } from "./regulated-report.service";
import { RegulatedService } from "./regulated.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { periodBucketOf } from "./period";

const YEAR = new Date().getUTCFullYear() - 2;
const SOLD_AT = new Date(`${YEAR}-01-15T12:00:00Z`);

/** A box-unaware line: 6 BOXES of a 12-pack sold, $240 net, $60 levy. */
const sale = (over: Record<string, unknown> = {}) => ({
  id: "sale-1",
  tenantId: "t1",
  trackedCategoryId: "cat-1",
  trackedSubcategoryId: null,
  entryType: "SALE",
  orderId: "ord-1",
  orderItemId: "oi-1",
  invoiceId: "inv-1",
  invoiceItemId: "ii-1",
  returnId: null,
  qty: 6,
  unitBasisQty: 6,
  netSales: 240,
  categoryTax: 60,
  soldAt: SOLD_AT,
  periodBucket: `${YEAR}-01`,
  ...over,
});
const parkedRow = (over: Record<string, unknown> = {}) => ({
  id: "pk-1",
  tenantId: "t1",
  returnId: "ret-1",
  orderId: "ord-1",
  orderItemId: "oi-1",
  saleEntryId: "sale-1",
  returnedPieces: 12,
  reason: "no own split and no same-product source line with a split",
  periodBucket: `${YEAR}-01`,
  createdAt: new Date(`${YEAR}-01-20T00:00:00Z`),
  resolvedAt: null as Date | null,
  resolvedById: null as string | null,
  unitsPerBoxSupplied: null as number | null,
  resolvedEntryId: null as string | null,
  ...over,
});

describe("ParkedResolutionService", () => {
  let service: ParkedResolutionService;
  let ledger: RegulatedLedgerService;
  let filing: RegulatedFilingService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let audit: { log: jest.Mock };
  let storage: { upload: jest.Mock };
  let table: ReturnType<typeof parkedRow>[];
  let sales: any[];
  let priorReversals: any[];
  let siblingReversals: any[];

  beforeEach(async () => {
    prisma = createMockPrisma();
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    storage = { upload: jest.fn().mockResolvedValue("key") };
    table = [parkedRow()];
    sales = [sale()];
    priorReversals = [];
    siblingReversals = [];

    // An in-memory parked table shared by the resolver (through the tx) and the filing gate's reader.
    const parked: any = (prisma as any).regulatedLedgerParkedReversal;
    parked.findFirst = jest.fn(
      async ({ where }: any) => table.find((r) => r.id === where.id) ?? null,
    );
    parked.updateMany = jest.fn(async ({ where, data }: any) => {
      const hit = table.filter(
        (r) => r.id === where.id && (where.resolvedAt === null ? r.resolvedAt === null : true),
      );
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    });
    parked.findMany = jest.fn(async ({ where }: any) =>
      table.filter(
        (r) =>
          (where.resolvedAt === null ? r.resolvedAt === null : true) &&
          (!where.periodBucket || where.periodBucket.in.includes(r.periodBucket)),
      ),
    );
    prisma.regulatedSalesLedger.findMany.mockImplementation(async ({ where }: any) => {
      if (where.entryType === "SALE") return sales;
      if (where.returnId) return siblingReversals; // the (returnId, orderId) already-reversed probe
      if (where.entryType === "REVERSAL") return priorReversals;
      if (where.id?.in) return sales.filter((s) => where.id.in.includes(s.id));
      return [];
    });
    prisma.regulatedSalesLedger.findFirst.mockImplementation(
      async ({ where }: any) => sales.find((s) => s.id === where.id) ?? null,
    );
    prisma.regulatedSalesLedger.createMany.mockResolvedValue({ count: 1 });
    prisma.invoiceItem.findFirst.mockResolvedValue({ productId: "p1" });
    prisma.invoiceItem.findMany.mockResolvedValue([{ id: "ii-1", productId: "p1" }]);
    prisma.trackedCategory.findUnique.mockResolvedValue({
      id: "cat-1",
      name: "Tobacco",
      reportTemplate: "GENERIC",
      reportCadence: "MONTHLY",
      unitBasis: "pack",
    });
    prisma.regulatedFiling.findFirst.mockResolvedValue(null);
    prisma.regulatedFiling.create.mockImplementation((a: any) =>
      Promise.resolve({ id: "f1", ...a.data }),
    );

    const mod = await Test.createTestingModule({
      providers: [
        ParkedResolutionService,
        RegulatedLedgerService,
        RegulatedFilingService,
        RegulatedReportService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: StorageService, useValue: storage },
        {
          provide: RegulatedService,
          useValue: { getLedger: jest.fn().mockResolvedValue({ rows: [] }) },
        },
      ],
    }).compile();
    service = mod.get(ParkedResolutionService);
    ledger = mod.get(RegulatedLedgerService);
    filing = mod.get(RegulatedFilingService);
  });

  const written = () =>
    (prisma.regulatedSalesLedger.createMany.mock.calls[0]?.[0].data ?? []) as any[];
  const actor = { id: "u-op" };

  it("books EXACTLY the stored pieces against the stored SALE row: 12 pieces of a 6-box line at pack 12 = 1 box, 1/6 of net and levy", async () => {
    const res = await service.resolve("pk-1", 12, actor);
    expect(written()).toHaveLength(1);
    expect(written()[0]).toMatchObject({
      entryType: "REVERSAL",
      orderId: "ord-1",
      orderItemId: "oi-1",
      invoiceItemId: "ii-1",
      returnId: "ret-1",
      qty: -1,
      unitBasisQty: -1,
      netSales: -40,
      categoryTax: -10,
    });
    expect(res).toEqual({ alreadyResolved: false, resolvedEntryId: written()[0].id });
  });

  it("books into the CURRENT period with originalSoldAt = the SALE's date; never backdated into the filed one", async () => {
    await service.resolve("pk-1", 12, actor);
    const row = written()[0];
    expect(row.originalSoldAt).toEqual(SOLD_AT);
    expect(row.periodBucket).toBe(periodBucketOf(new Date()));
    expect(row.periodBucket).not.toBe(`${YEAR}-01`);
    expect(row.soldAt.getTime()).toBeGreaterThan(SOLD_AT.getTime());
  });

  it("stamps resolvedAt / resolvedById / unitsPerBoxSupplied on the claim and resolvedEntryId on the row it booked", async () => {
    await service.resolve("pk-1", 12, actor);
    const parked: any = (prisma as any).regulatedLedgerParkedReversal;
    expect(parked.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "pk-1", resolvedAt: null }, // the conditional claim IS the idempotency guard
      data: { resolvedById: "u-op", unitsPerBoxSupplied: 12 },
    });
    expect(table[0]).toMatchObject({ resolvedById: "u-op", unitsPerBoxSupplied: 12 });
    expect(table[0].resolvedAt).toBeInstanceOf(Date);
    expect(table[0].resolvedEntryId).toBe(written()[0].id);
  });

  it("uses the SAME maths as the automatic path: the classifier route books the identical row for the same pack", async () => {
    await service.resolve("pk-1", 12, actor);
    const resolved = written()[0];
    prisma.regulatedSalesLedger.createMany.mockClear();
    // automatic path, same fixtures: the line's pack is recovered from its InvoiceItem's split (6 boxes = 72)
    prisma.orderItem.findMany.mockResolvedValue([
      {
        id: "oi-1",
        productId: "p1",
        qty: 6,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        product: { unitsPerBox: 12 },
      },
    ]);
    prisma.invoiceItem.findMany.mockResolvedValue([
      { id: "ii-1", productId: "p1", qty: 72, boxes: 6, pieces: 0, unitsPerBox: 12 },
    ]);
    await ledger.reverseReturnEntries({
      returnId: "ret-auto",
      orderId: "ord-1",
      returnedByProduct: new Map([["p1", 12]]),
      returnedUnit: "PIECES",
      db: prisma,
    });
    const pick = (r: any) => ({
      qty: r.qty,
      unitBasisQty: r.unitBasisQty,
      netSales: r.netSales,
      categoryTax: r.categoryTax,
    });
    expect(pick(written()[0])).toEqual(pick(resolved));
  });

  it("a SECOND resolve is a no-op: nothing booked, nothing re-stamped, no second audit", async () => {
    await service.resolve("pk-1", 12, actor);
    prisma.regulatedSalesLedger.createMany.mockClear();
    audit.log.mockClear();
    const again = await service.resolve("pk-1", 6, { id: "u-other" });
    expect(again).toMatchObject({ alreadyResolved: true });
    expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    expect(table[0]).toMatchObject({ resolvedById: "u-op", unitsPerBoxSupplied: 12 }); // the first answer stands
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("a concurrent resolve that loses the claim (count 0) books nothing", async () => {
    const parked: any = (prisma as any).regulatedLedgerParkedReversal;
    parked.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await service.resolve("pk-1", 12, actor);
    expect(res.alreadyResolved).toBe(true);
    expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
  });

  describe("THE SIBLING-REVERSAL TRAP: reverseReturnEntries returns early when any REVERSAL exists for (returnId, orderId)", () => {
    beforeEach(() => {
      siblingReversals = [{ id: "sibling-reversal" }]; // another product of the SAME return already booked
    });

    it("a naive re-call books NOTHING, silently (why the resolution mode exists)", async () => {
      prisma.orderItem.findMany.mockResolvedValue([]);
      await ledger.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 12]]),
        returnedUnit: "PIECES",
        db: prisma,
      });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("the resolver STILL books the parked row, because it skips that guard and its claim is the idempotency", async () => {
      const res = await service.resolve("pk-1", 12, actor);
      expect(written()).toHaveLength(1);
      expect(written()[0]).toMatchObject({ qty: -1, netSales: -40, categoryTax: -10 });
      expect(res.resolvedEntryId).toBe(written()[0].id);
    });
  });

  it("the operator's pack is stored ONLY on the parked row: never written back to a line, invoice line or product", async () => {
    await service.resolve("pk-1", 12, actor);
    for (const model of ["orderItem", "invoiceItem", "product"] as const) {
      for (const verb of [
        "update",
        "updateMany",
        "create",
        "createMany",
        "upsert",
        "delete",
        "deleteMany",
      ]) {
        expect({ model, verb, calls: (prisma as any)[model][verb].mock.calls.length }).toEqual({
          model,
          verb,
          calls: 0,
        });
      }
    }
    expect(prisma.regulatedSalesLedger.updateMany).not.toHaveBeenCalled(); // no historical ledger row rewritten
    expect((prisma.regulatedSalesLedger as any).update).not.toHaveBeenCalled();
  });

  it("clamps to the line's remaining: 500 stored pieces on a 6-box line book exactly the 6 boxes (closing balance)", async () => {
    table[0].returnedPieces = 500;
    await service.resolve("pk-1", 12, actor);
    expect(written()[0]).toMatchObject({ qty: -6, netSales: -240, categoryTax: -60 });
  });

  describe("the line's remaining is already 0 (closed elsewhere)", () => {
    beforeEach(() => {
      priorReversals = [
        { invoiceItemId: "ii-1", orderItemId: "oi-1", qty: -6, netSales: -240, categoryTax: -60 },
      ];
    });

    it("resolves with resolvedEntryId NULL and books nothing: it can never double-book", async () => {
      const res = await service.resolve("pk-1", 12, actor);
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
      expect(res).toEqual({ alreadyResolved: false, resolvedEntryId: null });
      expect(table[0].resolvedAt).toBeInstanceOf(Date);
      expect(table[0].resolvedEntryId).toBeNull();
    });

    it("records an audit NOTE saying nothing was booked", async () => {
      await service.resolve("pk-1", 12, actor);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "regulated_ledger.parked_resolved",
          meta: expect.objectContaining({
            resolvedEntryId: null,
            note: expect.stringMatching(/remaining was already 0.*nothing booked/),
          }),
        }),
      );
    });
  });

  it("audits the actor and the supplied pack (and the entry it booked)", async () => {
    await service.resolve("pk-1", 12, actor);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u-op",
        action: "regulated_ledger.parked_resolved",
        entityType: "RegulatedLedgerParkedReversal",
        entityId: "pk-1",
        meta: expect.objectContaining({
          returnId: "ret-1",
          saleEntryId: "sale-1",
          returnedPieces: 12,
          unitsPerBoxSupplied: 12,
          resolvedEntryId: table[0].resolvedEntryId,
        }),
      }),
    );
  });

  it("404s a row that is not visible to the tenant (another tenant's row reads as absent), booking nothing", async () => {
    const parked: any = (prisma as any).regulatedLedgerParkedReversal;
    parked.findFirst.mockResolvedValueOnce(null);
    await expect(service.resolve("pk-x", 12, actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("an unresolvable row (its sale entry is gone) is a 422 and books nothing, so it keeps blocking", async () => {
    sales = [];
    await expect(service.resolve("pk-1", 12, actor)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  describe("the filing gate", () => {
    const prepare = () =>
      filing.prepareFiling({ trackedCategoryId: "cat-1", year: YEAR, index: 1, userId: "u" });

    it("refuses BEFORE resolving and passes AFTER", async () => {
      await expect(prepare()).rejects.toBeInstanceOf(ConflictException);
      expect(storage.upload).not.toHaveBeenCalled();
      await service.resolve("pk-1", 12, actor);
      await expect(prepare()).resolves.toBeDefined();
      expect(storage.upload).toHaveBeenCalledTimes(1);
    });
  });

  it("lists the tenant's unresolved rows oldest first, optionally for one category", async () => {
    table.push(
      parkedRow({
        id: "pk-0",
        createdAt: new Date(`${YEAR}-01-02T00:00:00Z`),
        saleEntryId: "sale-1",
      }),
    );
    const rows = await service.list();
    expect(rows.map((r) => r.id)).toEqual(["pk-1", "pk-0"]); // the fake returns table order; the reader passes the sort key
    const parked: any = (prisma as any).regulatedLedgerParkedReversal;
    expect(parked.findMany.mock.calls[0][0]).toMatchObject({
      where: { resolvedAt: null },
      orderBy: { createdAt: "asc" },
    });
    expect(await service.list("cat-other")).toEqual([]);
  });
});
