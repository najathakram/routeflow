/**
 * #2052 / SA-609 (red pins): a SNAPSHOT-LESS legacy SALE row (line.unitsPerBox null) whose live
 * product pack is now null/1 (the product was un-boxed after the sale) must not short-circuit to
 * piece-axis. A pre-B661 row (createdAt before B661_CUTOFF) with unitBasisQty == qty is still
 * indistinguishable from a box count stored as pieces, so the live return PARKS (nothing booked);
 * a post-cutoff row is genuinely piece-axis and books normally. "Parked" = a
 * RegulatedLedgerParkedReversal row.
 */
import { Test } from "@nestjs/testing";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("reverseReturnEntries — product un-boxed since the sale (#2052)", () => {
  let service: RegulatedLedgerService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [RegulatedLedgerService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(RegulatedLedgerService);
    jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
  });

  const saleRow = (createdAt: Date | string | null, soldAt: Date | null = null) => ({
    id: "s-2052",
    entryType: "SALE",
    tenantId: "t1",
    trackedCategoryId: "cat-A",
    orderId: "ord-1",
    orderItemId: "oi-1",
    invoiceId: "inv-1",
    invoiceItemId: "ii-1",
    qty: 3,
    unitBasisQty: 3, // 3 boxes of 12, stored as if they were 3 pieces (the pre-B661 shape)
    netSales: 30,
    categoryTax: 6,
    createdAt,
    soldAt: soldAt ?? createdAt,
  });

  const arrange = (opts: {
    createdAt: Date | string | null;
    soldAt?: Date;
    linePack: number | null;
    livePack: number | null;
  }) => {
    prisma.regulatedSalesLedger.findMany
      .mockResolvedValueOnce([]) // prior-reversal idempotency
      .mockResolvedValueOnce([saleRow(opts.createdAt, opts.soldAt ?? null)]) // sales
      .mockResolvedValueOnce([]) // priorReversals
      .mockResolvedValueOnce([]); // loadCorrectionsBySaleId
    prisma.invoiceItem.findMany.mockResolvedValue([
      {
        id: "ii-1",
        productId: "p1",
        boxes: null,
        pieces: null,
        unitLabel: null,
        unitsPerBox: opts.linePack,
      },
    ]);
    prisma.orderItem.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([{ id: "p1", unitsPerBox: opts.livePack }]);
  };

  const ret = () =>
    service.reverseReturnEntries({
      returnId: "ret-1",
      orderId: "ord-1",
      returnedByProduct: new Map([["p1", 36]]), // 36 PIECES back
      returnedUnit: "PIECES",
      db: prisma,
    });

  describe.each([
    ["product pack null", null],
    ["product pack 1", 1],
  ])("REG-2052: pre-cutoff snapshot-less row, %s", (_label, livePack) => {
    it("parks the 36-piece return and writes ZERO reversal rows", async () => {
      arrange({ createdAt: new Date("2026-09-10T00:00:00Z"), linePack: null, livePack });
      await ret();
      // today this books the 3 pieces of the box count as if they were the whole sale (-3)
      expect(prisma.regulatedSalesLedger.createMany.mock.calls).toEqual([]);
      expect(prisma.regulatedLedgerParkedReversal.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            tenantId: "t1",
            returnId: "ret-1",
            saleEntryId: "s-2052",
            returnedPieces: 36,
          }),
        ],
        skipDuplicates: true,
      });
    });
  });

  it("post-cutoff snapshot-less row (genuinely piece-axis) books normally, no park", async () => {
    arrange({ createdAt: new Date("2026-10-05T00:00:00Z"), linePack: null, livePack: null });
    await ret();
    expect(prisma.regulatedLedgerParkedReversal.createMany).not.toHaveBeenCalled();
    expect(prisma.regulatedSalesLedger.createMany).toHaveBeenCalledTimes(1);
    const data = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ entryType: "REVERSAL" });
    expect(Number(data[0].unitBasisQty)).toBe(-3);
  });

  it("snapshot line (unitsPerBox 12) on a pre-cutoff row: unchanged, parks on the pack-12 legacy shape", async () => {
    arrange({ createdAt: new Date("2026-09-10T00:00:00Z"), linePack: 12, livePack: null });
    await ret();
    expect(prisma.regulatedLedgerParkedReversal.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ saleEntryId: "s-2052", returnedPieces: 36 })],
      skipDuplicates: true,
    });
    expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
  });

  // SA-609: the axis is a property of the code that WROTE the row (createdAt), never of soldAt —
  // a business date that can be back-dated or imported.
  it("soldAt AFTER the cutoff but createdAt BEFORE it: still parks (soldAt is ignored)", async () => {
    arrange({
      createdAt: new Date("2026-09-10T00:00:00Z"),
      soldAt: new Date("2026-10-05T00:00:00Z"),
      linePack: null,
      livePack: null,
    });
    await ret();
    expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    expect(prisma.regulatedLedgerParkedReversal.createMany).toHaveBeenCalledTimes(1);
  });

  it("soldAt BEFORE the cutoff (back-dated) but createdAt AFTER it: books, never parks", async () => {
    arrange({
      createdAt: new Date("2026-10-05T00:00:00Z"),
      soldAt: new Date("2026-09-10T00:00:00Z"),
      linePack: null,
      livePack: null,
    });
    await ret();
    expect(prisma.regulatedLedgerParkedReversal.createMany).not.toHaveBeenCalled();
    expect(prisma.regulatedSalesLedger.createMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["createdAt null", null],
    ["createdAt an unparseable string", "not-a-date"],
  ])("%s (unknown write time) is treated as pre-cutoff: parks", async (_label, createdAt) => {
    arrange({ createdAt, linePack: null, livePack: null });
    await ret();
    expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    expect(prisma.regulatedLedgerParkedReversal.createMany).toHaveBeenCalledTimes(1);
  });
});
