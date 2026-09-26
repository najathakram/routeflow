/**
 * SA-167 (Opus REQUIRED on #1324): resolving a parked reversal RESUMES THE SAME walk the live
 * path runs over the product's sale rows. The park recorded the product's whole leftover on the
 * FIRST legacy row, so booking one chunk against that row silently dropped the rest.
 * Stateful fake (no DB) — the DB lane re-proves the same cases against real Postgres.
 */
import { Test } from "@nestjs/testing";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("resolveParkedReversal — resume the live walk (SA-167)", () => {
  let service: RegulatedLedgerService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ledger: any[];
  let parkedStore: any[];
  let invoiceItems: any[];

  const sale = (n: number, qty: number, over: Record<string, unknown> = {}) => ({
    id: `s-${n}`,
    tenantId: "t1",
    trackedCategoryId: "cat-A",
    trackedSubcategoryId: null,
    entryType: "SALE",
    orderId: "ord-1",
    orderItemId: `oi-${n}`,
    invoiceId: "inv-1",
    invoiceItemId: `ii-${n}`,
    correctsEntryId: null,
    qty,
    unitBasisQty: qty, // legacy: box count stored as pieces (the pre-B661 defect)
    netSales: qty * 10,
    categoryTax: qty * 2,
    soldAt: new Date("2026-07-01T00:00:00Z"),
    ...over,
  });
  const ii = (n: number) => ({
    id: `ii-${n}`,
    productId: "p1",
    boxes: null,
    pieces: null,
    unitLabel: null,
    unitsPerBox: null,
  });
  const parked = (n: number, returnedPieces: number) => ({
    returnId: "ret-1",
    orderId: "ord-1",
    orderItemId: `oi-${n}`,
    saleEntryId: `s-${n}`,
    returnedPieces,
  });
  const reversals = () =>
    ledger.filter((r) => r.entryType === "REVERSAL" && r.correctsEntryId == null);
  const net = (field: "unitBasisQty" | "qty") =>
    ledger.reduce((sum, r) => sum + Number(r[field]), 0);

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [RegulatedLedgerService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(RegulatedLedgerService);
    ledger = [];
    parkedStore = [];
    invoiceItems = [];

    prisma.regulatedSalesLedger.findFirst.mockImplementation(
      async ({ where }: any) => ledger.find((s) => s.id === where.id) ?? null,
    );
    prisma.regulatedSalesLedger.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.correctsEntryId?.in) {
        return ledger.filter(
          (s) => s.correctsEntryId != null && where.correctsEntryId.in.includes(s.correctsEntryId),
        );
      }
      if (where?.orderId != null && where?.entryType === "SALE") {
        return ledger.filter((s) => s.orderId === where.orderId && s.entryType === "SALE");
      }
      if (where?.entryType === "REVERSAL") {
        return ledger.filter((r) => r.entryType === "REVERSAL");
      }
      return [];
    });
    prisma.regulatedSalesLedger.create.mockImplementation(async ({ data }: any) => {
      const row = { id: `new-${ledger.length + 1}`, ...data };
      ledger.push(row);
      return row;
    });
    prisma.invoiceItem.findMany.mockImplementation(async ({ where }: any) =>
      invoiceItems.filter((i) => where.id.in.includes(i.id)),
    );
    prisma.orderItem.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([{ id: "p1", unitsPerBox: 12 }]);
    prisma.regulatedLedgerParkedReversal.createMany.mockImplementation(async ({ data }: any) => {
      for (const d of data) {
        if (!parkedStore.some((p) => p.returnId === d.returnId && p.saleEntryId === d.saleEntryId))
          parkedStore.push({ id: `parked-${parkedStore.length + 1}`, ...d });
      }
      return { count: data.length };
    });
    prisma.regulatedLedgerParkedReversal.create.mockImplementation(async ({ data }: any) => {
      const row = { id: `parked-${parkedStore.length + 1}`, ...data };
      parkedStore.push(row);
      return row;
    });
    prisma.regulatedLedgerParkedReversal.update.mockImplementation(async ({ where, data }: any) => {
      const row = parkedStore.find((p) => p.id === where.id);
      Object.assign(row, data);
      return row;
    });
    prisma.regulatedLedgerParkedReversal.findMany.mockImplementation(async ({ where }: any) =>
      parkedStore.filter(
        (p) => p.returnId === where.returnId && where.saleEntryId.in.includes(p.saleEntryId),
      ),
    );
  });

  it("(a) two legacy rows (2 and 3 boxes at 12), full 60-piece return: resolve row 1 books 24 and PARKS the other 36 on row 2; resolving row 2 books 36; the line nets to zero", async () => {
    ledger = [sale(1, 2), sale(2, 3)];
    invoiceItems = [ii(1), ii(2)];

    const first = await service.resolveParkedReversal(prisma, parked(1, 60), 12);
    expect(first.outcome).toBe("partial");
    expect(first.bookedPieces).toBe(24);
    expect(first.parkedPieces).toBe(36);
    expect(first.unbookedPieces).toBe(0);
    expect(parkedStore).toHaveLength(1);
    expect(parkedStore[0]).toMatchObject({
      returnId: "ret-1",
      saleEntryId: "s-2",
      returnedPieces: 36,
    });
    expect(first.parkedRowIds).toEqual([parkedStore[0].id]);

    const second = await service.resolveParkedReversal(prisma, parked(2, 36), 12);
    expect(second.outcome).toBe("booked");
    expect(second.bookedPieces).toBe(36);
    expect(second.parkedPieces).toBe(0);
    expect(reversals()).toHaveLength(2);
    expect(reversals().map((r) => Number(r.unitBasisQty))).toEqual([-24, -36]);
    expect(net("unitBasisQty")).toBe(0); // both lines: 24 + 36 sold in pieces, all reversed
    expect(reversals().reduce((s, r) => s + Number(r.netSales), 0)).toBeCloseTo(-50, 2);
  });

  it("(b) row 2 already piece-axis: ONE resolution books 24 then 36, nothing parked", async () => {
    ledger = [sale(1, 2), sale(2, 3, { unitBasisQty: 36 })];
    invoiceItems = [ii(1), ii(2)];

    const res = await service.resolveParkedReversal(prisma, parked(1, 60), 12);
    expect(res.outcome).toBe("booked");
    expect(res.bookedPieces).toBe(60);
    expect(res.parkedPieces).toBe(0);
    expect(res.unbookedPieces).toBe(0);
    expect(parkedStore).toHaveLength(0);
    expect(reversals().map((r) => Number(r.unitBasisQty))).toEqual([-24, -36]);
    expect(res.resolvedEntryId).toBe(reversals()[0].id); // the FIRST reversal booked
  });

  it("(c) 70 returned over 60 sold: 60 booked and 10 reported UNBOOKED (never a bare 'booked')", async () => {
    ledger = [sale(1, 2), sale(2, 3, { unitBasisQty: 36 })];
    invoiceItems = [ii(1), ii(2)];

    const res = await service.resolveParkedReversal(prisma, parked(1, 70), 12);
    expect(res.bookedPieces).toBe(60);
    expect(res.unbookedPieces).toBe(10);
    expect(res.outcome).toBe("partial");
    expect(parkedStore).toHaveLength(0);
  });

  it("(d) SA-169: row 1 fully voided, row 2 live at 3 boxes, 36 parked on row 1: nothing on row 1, 36 booked on row 2, outcome booked", async () => {
    ledger = [
      sale(1, 2),
      // row 1's line was fully reversed (a void) before the operator resolved it
      {
        id: "v-1",
        tenantId: "t1",
        trackedCategoryId: "cat-A",
        trackedSubcategoryId: null,
        entryType: "REVERSAL",
        orderId: "ord-1",
        orderItemId: "oi-1",
        invoiceId: "inv-1",
        invoiceItemId: "ii-1",
        correctsEntryId: null,
        qty: -2,
        unitBasisQty: -2,
        netSales: -20,
        categoryTax: -4,
        soldAt: new Date("2026-08-01T00:00:00Z"),
      },
      sale(2, 3, { unitBasisQty: 36 }),
    ];
    invoiceItems = [ii(1), ii(2)];

    const res = await service.resolveParkedReversal(prisma, parked(1, 36), 12);
    expect(res.outcome).toBe("booked");
    expect(res.correctionEntryId).toBeNull();
    expect(res.bookedPieces).toBe(36);
    expect(res.parkedPieces).toBe(0);
    const mine = reversals().filter((r) => r.id !== "v-1");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ orderItemId: "oi-2", unitBasisQty: -36 });
    expect(
      ledger.filter((r) => r.orderItemId === "oi-1" && r.id !== "v-1" && r.id !== "s-1"),
    ).toHaveLength(0);
  });

  it("(e) SA-169: the same with row 2 still legacy: 36 parked on row 2, outcome partial, nothing on row 1", async () => {
    ledger = [
      sale(1, 2),
      {
        id: "v-1",
        tenantId: "t1",
        trackedCategoryId: "cat-A",
        trackedSubcategoryId: null,
        entryType: "REVERSAL",
        orderId: "ord-1",
        orderItemId: "oi-1",
        invoiceId: "inv-1",
        invoiceItemId: "ii-1",
        correctsEntryId: null,
        qty: -2,
        unitBasisQty: -2,
        netSales: -20,
        categoryTax: -4,
        soldAt: new Date("2026-08-01T00:00:00Z"),
      },
      sale(2, 3),
    ];
    invoiceItems = [ii(1), ii(2)];

    const res = await service.resolveParkedReversal(prisma, parked(1, 36), 12);
    expect(res.outcome).toBe("partial");
    expect(res.bookedPieces).toBe(0);
    expect(res.parkedPieces).toBe(36);
    expect(parkedStore).toHaveLength(1);
    expect(parkedStore[0]).toMatchObject({ saleEntryId: "s-2", returnedPieces: 36 });
    expect(res.correctionEntryId).toBeNull();
  });

  it("SA-193: a closed row with no other live row books and parks nothing but is PARTIAL, with the leftover reported", async () => {
    ledger = [
      sale(1, 2),
      {
        id: "v-1",
        tenantId: "t1",
        trackedCategoryId: "cat-A",
        trackedSubcategoryId: null,
        entryType: "REVERSAL",
        orderId: "ord-1",
        orderItemId: "oi-1",
        invoiceId: "inv-1",
        invoiceItemId: "ii-1",
        correctsEntryId: null,
        qty: -2,
        unitBasisQty: -2,
        netSales: -20,
        categoryTax: -4,
        soldAt: new Date("2026-08-01T00:00:00Z"),
      },
    ];
    invoiceItems = [ii(1)];
    const res = await service.resolveParkedReversal(prisma, parked(1, 24), 12);
    expect(res.outcome).toBe("partial");
    expect(res.unbookedPieces).toBe(24);
    expect(res.bookedPieces).toBe(0);
    expect(ledger).toHaveLength(2); // nothing written
  });

  it("SA-170 W/N: the resumed walk visits EVERY other row, including rows before the parked one", async () => {
    // Row 1 is piece-axis with 24 pieces still unreversed; the park sits on row 2 (legacy, 3 boxes).
    ledger = [sale(1, 2, { unitBasisQty: 24 }), sale(2, 3)];
    invoiceItems = [ii(1), ii(2)];

    const res = await service.resolveParkedReversal(prisma, parked(2, 40), 12);
    expect(res.outcome).toBe("booked");
    expect(res.bookedPieces).toBe(40);
    expect(res.unbookedPieces).toBe(0);
    const bookedByLine = Object.fromEntries(
      reversals().map((r) => [r.orderItemId, Number(r.unitBasisQty)]),
    );
    expect(bookedByLine).toEqual({ "oi-2": -36, "oi-1": -4 });
  });

  it("SA-173: with the live product carrying NO pack, the operator's attested pack still governs the walk: row 2 parks 36 (partial), row 1 books 24 — never row 2's box count as pieces", async () => {
    ledger = [sale(1, 2), sale(2, 3)];
    invoiceItems = [ii(1), ii(2)];
    prisma.product.findMany.mockResolvedValue([{ id: "p1", unitsPerBox: null }]);
    const res = await service.resolveParkedReversal(prisma, parked(1, 60), 12);
    expect(res.outcome).toBe("partial");
    expect(res.bookedPieces).toBe(24);
    expect(res.parkedPieces).toBe(36);
    expect(parkedStore).toHaveLength(1);
    expect(parkedStore[0]).toMatchObject({ saleEntryId: "s-2", returnedPieces: 36 });
  });

  it("Opus REQUIRED (#1324): a pack of 1 attests nothing about SIBLING rows: on a product boxed today (live pack 12) row 2 stays legacy and PARKS, never booked as 3 'pieces' at full net and tax", async () => {
    ledger = [sale(1, 2), sale(2, 3)];
    invoiceItems = [ii(1), ii(2)];
    prisma.product.findMany.mockResolvedValue([{ id: "p1", unitsPerBox: 12 }]);
    const res = await service.resolveParkedReversal(prisma, parked(1, 60), 1);
    expect(res.outcome).toBe("partial");
    expect(res.bookedPieces).toBe(2); // row 1 on the operator's pack of 1: its 2 units
    expect(res.parkedPieces).toBe(58);
    expect(parkedStore).toHaveLength(1);
    expect(parkedStore[0]).toMatchObject({ saleEntryId: "s-2", returnedPieces: 58 });
    // Nothing was booked against row 2: no reversal on oi-2, so its $30 net / $6 tax stay.
    expect(reversals().filter((r) => r.orderItemId === "oi-2")).toHaveLength(0);
    expect(reversals().reduce((a, r) => a + Number(r.netSales), 0)).toBeCloseTo(-20, 2);
  });

  describe("SA-182 / #2081: the reversal lands in the PARKED row's period", () => {
    const parkedAt = new Date("2026-08-15T12:00:00.000Z");
    const inAugust = (n: number, pieces: number) => ({
      ...parked(n, pieces),
      periodBucket: "2026-08",
      parkedAt,
    });

    it("(1) a park from August resolved later books the REVERSAL in 2026-08 with the return's date as soldAt", async () => {
      ledger = [sale(1, 2)];
      invoiceItems = [ii(1)];
      (prisma as any).regulatedFiling.findFirst = jest.fn().mockResolvedValue(null);
      const res = await service.resolveParkedReversal(prisma, inAugust(1, 24), 12);
      expect(res.outcome).toBe("booked");
      expect(res.amendedPeriod).toBeNull();
      expect(reversals()[0]).toMatchObject({ periodBucket: "2026-08", soldAt: parkedAt });
      expect(reversals()[0].originalSoldAt).toBeUndefined();
    });

    it("(2) the parked period already GENERATED: books in the CURRENT period with originalSoldAt = the return date, and says so", async () => {
      ledger = [sale(1, 2)];
      invoiceItems = [ii(1)];
      (prisma as any).regulatedFiling.findFirst = jest
        .fn()
        .mockResolvedValue({ periodKey: "2026-08", status: "GENERATED" });
      const res = await service.resolveParkedReversal(prisma, inAugust(1, 24), 12);
      expect(res.outcome).toBe("booked");
      expect(res.amendedPeriod).toEqual({ periodKey: "2026-08", status: "GENERATED" });
      const currentBucket = new Date().toISOString().slice(0, 7);
      expect(reversals()[0]).toMatchObject({
        periodBucket: currentBucket,
        originalSoldAt: parkedAt,
      });
      expect(reversals()[0].periodBucket).not.toBe("2026-08");
    });

    it("(3) leftover parked on row 2 by the resumed walk carries the same bucket and date", async () => {
      ledger = [sale(1, 2), sale(2, 3)];
      invoiceItems = [ii(1), ii(2)];
      (prisma as any).regulatedFiling.findFirst = jest.fn().mockResolvedValue(null);
      const res = await service.resolveParkedReversal(prisma, inAugust(1, 60), 12);
      expect(res.outcome).toBe("partial");
      expect(parkedStore).toHaveLength(1);
      expect(parkedStore[0]).toMatchObject({
        saleEntryId: "s-2",
        periodBucket: "2026-08",
        createdAt: parkedAt,
      });
      expect(reversals()[0]).toMatchObject({ periodBucket: "2026-08", soldAt: parkedAt });
    });
  });

  describe("SA-193: the resumed walk never mints onto an existing park key", () => {
    const resolvedPark = (n: number, pack: number, pieces: number) => ({
      id: `parked-r${n}`,
      returnId: "ret-1",
      saleEntryId: `s-${n}`,
      returnedPieces: pieces,
      resolvedAt: new Date("2026-09-01T00:00:00Z"),
      unitsPerBoxSupplied: pack,
    });
    const reversal = (n: number, qty: number) => ({
      id: `v-${n}`,
      tenantId: "t1",
      trackedCategoryId: "cat-A",
      trackedSubcategoryId: null,
      entryType: "REVERSAL",
      orderId: "ord-1",
      orderItemId: `oi-${n}`,
      invoiceId: "inv-1",
      invoiceItemId: `ii-${n}`,
      correctsEntryId: null,
      qty: -qty,
      unitBasisQty: -qty,
      netSales: -qty * 10,
      categoryTax: -qty * 2,
      soldAt: new Date("2026-08-01T00:00:00Z"),
    });

    it("r1 resolved at pack 1 and r2 resolved at 12 with 22 left: the 22 BOOK on s-1 as pieces (its attestation), parkedPieces 0, nothing re-parked", async () => {
      ledger = [sale(1, 22), sale(2, 3)];
      invoiceItems = [ii(1), ii(2)];
      parkedStore = [resolvedPark(1, 1, 22)];
      const res = await service.resolveParkedReversal(prisma, parked(2, 58), 12);
      expect(res.outcome).toBe("booked");
      expect(res.bookedPieces).toBe(58); // 36 on row 2 + 22 on row 1
      expect(res.parkedPieces).toBe(0);
      expect(res.unbookedPieces).toBe(0);
      expect(parkedStore).toHaveLength(1); // no new key, r1 untouched
      expect(parkedStore[0].resolvedAt).not.toBeNull();
      const onRow1 = reversals().filter((r) => r.orderItemId === "oi-1");
      expect(onRow1.map((r) => Number(r.unitBasisQty))).toEqual([-22]);
    });

    it("a CLOSED attested row is skipped and the leftover lands on the next live row (s-3)", async () => {
      ledger = [sale(1, 2), reversal(1, 2), sale(2, 3), sale(3, 22, { unitBasisQty: 264 })];
      invoiceItems = [ii(1), ii(2), ii(3)];
      parkedStore = [resolvedPark(1, 1, 2)];
      const res = await service.resolveParkedReversal(prisma, parked(2, 58), 12);
      expect(res.parkedPieces).toBe(0);
      const onRow3 = reversals().filter((r) => r.orderItemId === "oi-3");
      expect(onRow3).toHaveLength(1);
      expect(Number(onRow3[0].unitBasisQty)).toBe(-22);
    });

    it("an UNRESOLVED live park on s-1: its returnedPieces GROWS by the leftover, no second key, the gate still holds", async () => {
      ledger = [sale(1, 2), sale(2, 3)];
      invoiceItems = [ii(1), ii(2)];
      parkedStore = [
        {
          id: "parked-r1",
          returnId: "ret-1",
          saleEntryId: "s-1",
          returnedPieces: 10,
          resolvedAt: null,
        },
      ];
      const res = await service.resolveParkedReversal(prisma, parked(2, 58), 12);
      // row 2 books its 36; the 22 left reach s-1 (legacy, not attested) and grow its open park.
      expect(res.outcome).toBe("partial");
      expect(res.parkedPieces).toBe(22);
      expect(res.grownParks).toEqual([{ id: "parked-r1", added: 22 }]);
      expect(res.parkedRowIds).toEqual(["parked-r1"]);
      expect(parkedStore).toHaveLength(1);
      expect(Number(parkedStore[0].returnedPieces)).toBe(32);
      expect(parkedStore[0].resolvedAt).toBeNull();
    });

    it("the resolution walk NEVER calls createMany on the parked table (first chunk and resumed walk alike)", async () => {
      const createMany = (prisma as any).regulatedLedgerParkedReversal.createMany as jest.Mock;
      // three shapes that park, grow, and attest across the walk
      ledger = [sale(1, 2), sale(2, 3)];
      invoiceItems = [ii(1), ii(2)];
      await service.resolveParkedReversal(prisma, parked(1, 60), 12); // parks the leftover on s-2
      ledger = [sale(1, 22), sale(2, 3)];
      parkedStore = [resolvedPark(1, 1, 22)];
      await service.resolveParkedReversal(prisma, parked(2, 58), 12); // attested row books
      ledger = [sale(1, 2), sale(2, 3)];
      parkedStore = [
        {
          id: "parked-r1",
          returnId: "ret-1",
          saleEntryId: "s-1",
          returnedPieces: 10,
          resolvedAt: null,
        },
      ];
      await service.resolveParkedReversal(prisma, parked(2, 58), 12); // grows the open park
      expect(createMany).not.toHaveBeenCalled();
    });
  });

  describe("SA-193 (3)/(4): one source for date and bucket; leftovers carry the original date", () => {
    const parkedAt = new Date("2026-08-15T12:00:00.000Z");

    it("(3) the DATE derives the bucket: a stored bucket that disagrees loses (2026-07 stored, Aug 15 date -> books in 2026-08)", async () => {
      ledger = [sale(1, 2)];
      invoiceItems = [ii(1)];
      (prisma as any).regulatedFiling.findFirst = jest.fn().mockResolvedValue(null);
      const res = await service.resolveParkedReversal(
        prisma,
        { ...parked(1, 24), periodBucket: "2026-07", parkedAt },
        12,
      );
      expect(res.outcome).toBe("booked");
      expect(reversals()[0]).toMatchObject({ periodBucket: "2026-08", soldAt: parkedAt });
    });

    it("(4) a leftover from a FILED-period park keeps the original date and month; resolving it later books in the current period with originalSoldAt and amendedPeriod", async () => {
      ledger = [sale(1, 2), sale(2, 3)];
      invoiceItems = [ii(1), ii(2)];
      const filed = { periodKey: "2026-08", status: "GENERATED" };
      (prisma as any).regulatedFiling.findFirst = jest.fn().mockResolvedValue(filed);
      const first = await service.resolveParkedReversal(
        prisma,
        { ...parked(1, 60), periodBucket: "2026-08", parkedAt },
        12,
      );
      expect(first.amendedPeriod).toEqual(filed);
      expect(parkedStore).toHaveLength(1);
      // the leftover park carries the ORIGINAL date and month, not a flag and not the current month
      expect(parkedStore[0]).toMatchObject({
        saleEntryId: "s-2",
        periodBucket: "2026-08",
        createdAt: parkedAt,
      });

      const second = await service.resolveParkedReversal(
        prisma,
        {
          ...parked(2, 36),
          periodBucket: parkedStore[0].periodBucket,
          parkedAt: parkedStore[0].createdAt,
        },
        12,
      );
      const currentBucket = new Date().toISOString().slice(0, 7);
      expect(second.amendedPeriod).toEqual(filed);
      const last = reversals()[reversals().length - 1];
      expect(last).toMatchObject({ periodBucket: currentBucket, originalSoldAt: parkedAt });
    });
  });

  it("SA-196: the filed check is conservative across categories — a product re-categorised between two sales counts as filed if ANY touched category has a filing for the bucket", async () => {
    const parkedAt = new Date("2026-08-15T12:00:00.000Z");
    ledger = [sale(1, 2), sale(2, 3, { trackedCategoryId: "cat-B" })];
    invoiceItems = [ii(1), ii(2)];
    const findFirst = jest.fn().mockResolvedValue({ periodKey: "2026-08", status: "LOCKED" });
    (prisma as any).regulatedFiling.findFirst = findFirst;
    const res = await service.resolveParkedReversal(
      prisma,
      { ...parked(1, 24), periodBucket: "2026-08", parkedAt },
      12,
    );
    // both categories were asked about, in ONE lookup
    const where = findFirst.mock.calls[0][0].where;
    expect([...where.trackedCategoryId.in].sort()).toEqual(["cat-A", "cat-B"]);
    // filed in (any of) them: the whole resolution books in the CURRENT period with originalSoldAt
    expect(res.amendedPeriod).toEqual({ periodKey: "2026-08", status: "LOCKED" });
    expect(reversals()[0]).toMatchObject({
      periodBucket: new Date().toISOString().slice(0, 7),
      originalSoldAt: parkedAt,
    });
  });

  describe("#2108: the shared filed-period fold and lookup", () => {
    const parkedAt = new Date("2026-08-15T12:00:00.000Z");
    const filing = (cat: string, key: string, status = "GENERATED") => ({
      trackedCategoryId: cat,
      periodKey: key,
      status,
    });

    it("findFiledPeriod is deterministic (orderBy) and names the MATCHED category", async () => {
      const findFirst = jest.fn().mockResolvedValue(filing("cat-B", "2026-08", "LOCKED"));
      (prisma as any).regulatedFiling.findFirst = findFirst;
      const hit = await service.findFiledPeriod(prisma, ["cat-A", "cat-B"], "2026-08");
      expect(hit).toEqual({ periodKey: "2026-08", status: "LOCKED", trackedCategoryId: "cat-B" });
      const args = findFirst.mock.calls[0][0];
      expect(args.orderBy).toEqual([{ trackedCategoryId: "asc" }, { periodKey: "asc" }]);
      expect(args.select).toMatchObject({ trackedCategoryId: true });
      // no categories means nothing to look up
      findFirst.mockClear();
      expect(await service.findFiledPeriod(prisma, [], "2026-08")).toBeNull();
      expect(findFirst).not.toHaveBeenCalled();
    });

    it("resolve returns the matched category in amendedPeriod, through the shared fold", async () => {
      ledger = [sale(1, 2), sale(2, 3, { trackedCategoryId: "cat-B" })];
      invoiceItems = [ii(1), ii(2)];
      (prisma as any).regulatedFiling.findFirst = jest
        .fn()
        .mockResolvedValue(filing("cat-B", "2026-08"));
      const res = await service.resolveParkedReversal(
        prisma,
        { ...parked(1, 24), periodBucket: "2026-08", parkedAt },
        12,
      );
      expect(res.amendedPeriod).toEqual({
        periodKey: "2026-08",
        status: "GENERATED",
        trackedCategoryId: "cat-B",
      });
    });

    it("filedPeriodForParked (what list() calls) folds the SAME categories as the resolution: the parked row's plus every live row of the product", async () => {
      ledger = [sale(1, 2), sale(2, 3, { trackedCategoryId: "cat-B" })];
      invoiceItems = [ii(1), ii(2)];
      const findFirst = jest.fn().mockResolvedValue(filing("cat-B", "2026-08"));
      (prisma as any).regulatedFiling.findFirst = findFirst;
      const hit = await service.filedPeriodForParked(prisma, {
        saleEntryId: "s-1",
        orderId: "ord-1",
        createdAt: parkedAt,
      });
      expect(hit).toMatchObject({ periodKey: "2026-08", trackedCategoryId: "cat-B" });
      expect([...findFirst.mock.calls[0][0].where.trackedCategoryId.in].sort()).toEqual([
        "cat-A",
        "cat-B",
      ]);
    });

    it("filedPeriodForParked: a park in the CURRENT month is never filed (no lookup)", async () => {
      ledger = [sale(1, 2)];
      invoiceItems = [ii(1)];
      const findFirst = jest.fn();
      (prisma as any).regulatedFiling.findFirst = findFirst;
      const hit = await service.filedPeriodForParked(prisma, {
        saleEntryId: "s-1",
        orderId: "ord-1",
        createdAt: new Date(),
      });
      expect(hit).toBeNull();
      expect(findFirst).not.toHaveBeenCalled();
    });

    it("SA-213 pin: a filing on a SIBLING row the walk never reaches still routes the whole reversal to the CURRENT period", async () => {
      // 3 rows of one product; the parked row's return quantity is tiny (2 pieces), so the walk would stop
      // on the parked row itself, yet a filing on the third row's category must still decide the period.
      ledger = [sale(1, 2), sale(2, 3), sale(3, 4, { trackedCategoryId: "cat-C" })];
      invoiceItems = [ii(1), ii(2), ii(3)];
      const findFirst = jest.fn().mockResolvedValue(filing("cat-C", "2026-08"));
      (prisma as any).regulatedFiling.findFirst = findFirst;
      const res = await service.resolveParkedReversal(
        prisma,
        { ...parked(1, 2), periodBucket: "2026-08", parkedAt },
        12,
      );
      expect([...findFirst.mock.calls[0][0].where.trackedCategoryId.in].sort()).toEqual([
        "cat-A",
        "cat-C",
      ]);
      expect(res.amendedPeriod).toMatchObject({ periodKey: "2026-08", trackedCategoryId: "cat-C" });
      expect(reversals()[0]).toMatchObject({
        periodBucket: new Date().toISOString().slice(0, 7),
        originalSoldAt: parkedAt,
      });
    });

    describe.each([
      ["no label", {}],
      ["unitLabel 'each'", { unitLabel: "each" }],
    ])("#2108: parked row with NO resolvable product, productless line (%s)", (_n, extra) => {
      it("never walks onto a productless line in another category", async () => {
        // Row 1: invoice item rotated away and order item gone, so its product id is null. Row 2 is a
        // productless (freeform) line in cat-B. null must never equal null in the resumed walk.
        ledger = [
          sale(1, 2, { invoiceItemId: "ii-gone" }),
          sale(2, 3, { trackedCategoryId: "cat-B" }),
        ];
        invoiceItems = [{ ...ii(2), productId: null, ...extra }];
        const findFirst = jest.fn().mockResolvedValue(filing("cat-B", "2026-08"));
        (prisma as any).regulatedFiling.findFirst = findFirst;
        const res = await service.resolveParkedReversal(
          prisma,
          { ...parked(1, 60), periodBucket: "2026-08", parkedAt },
          12,
        );
        expect(reversals().filter((r) => r.trackedCategoryId === "cat-B")).toHaveLength(0);
        expect(parkedStore).toHaveLength(0);
        expect(res.parkedPieces).toBe(0);
        expect(res.unbookedPieces).toBe(36);
        // the fold looked only at the parked row's own category (the mock ignores `where`)
        expect([...findFirst.mock.calls[0][0].where.trackedCategoryId.in]).toEqual(["cat-A"]);
      });
    });

    it("SA-213 pin: the same inputs give the same amendedPeriod AND the same category fold from resolve and from list()'s helper", async () => {
      ledger = [sale(1, 2), sale(2, 3, { trackedCategoryId: "cat-B" })];
      invoiceItems = [ii(1), ii(2)];
      const findFirst = jest.fn().mockResolvedValue(filing("cat-B", "2026-08", "LOCKED"));
      (prisma as any).regulatedFiling.findFirst = findFirst;
      const fromList = await service.filedPeriodForParked(prisma, {
        saleEntryId: "s-1",
        orderId: "ord-1",
        createdAt: parkedAt,
      });
      const fromResolve = await service.resolveParkedReversal(
        prisma,
        { ...parked(1, 24), periodBucket: "2026-08", parkedAt },
        12,
      );
      expect(fromResolve.amendedPeriod).toEqual(fromList);
      const sets = findFirst.mock.calls.map((c) => [...c[0].where.trackedCategoryId.in].sort());
      expect(sets).toHaveLength(2);
      expect(sets[0]).toEqual(["cat-A", "cat-B"]);
      expect(sets[1]).toEqual(sets[0]);
    });

    it("SA-213 pin: a product reachable ONLY via the order item (InvoiceItem rotated away) folds the same categories in list() and resolve", async () => {
      // Row 1's invoice item was deleted by a reconcile (ii-gone is not in invoiceItems); its product
      // is known only through the order item. Row 2 (cat-B) is the same product on a live invoice item.
      ledger = [
        sale(1, 2, { invoiceItemId: "ii-gone" }),
        sale(2, 3, { trackedCategoryId: "cat-B" }),
      ];
      invoiceItems = [ii(2)];
      prisma.orderItem.findMany.mockResolvedValue([
        {
          id: "oi-1",
          productId: "p1",
          boxes: null,
          pieces: null,
          unitLabel: null,
          unitsPerBox: null,
        },
      ]);
      const findFirst = jest.fn().mockResolvedValue(filing("cat-B", "2026-08", "LOCKED"));
      (prisma as any).regulatedFiling.findFirst = findFirst;
      const fromList = await service.filedPeriodForParked(prisma, {
        saleEntryId: "s-1",
        orderId: "ord-1",
        createdAt: parkedAt,
      });
      const fromResolve = await service.resolveParkedReversal(
        prisma,
        { ...parked(1, 24), periodBucket: "2026-08", parkedAt },
        12,
      );
      const sets = findFirst.mock.calls.map((c) => [...c[0].where.trackedCategoryId.in].sort());
      expect(sets[0]).toEqual(["cat-A", "cat-B"]);
      expect(sets[1]).toEqual(sets[0]);
      expect(fromResolve.amendedPeriod).toEqual(fromList);
    });
  });
});
