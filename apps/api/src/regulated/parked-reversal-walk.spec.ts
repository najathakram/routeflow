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

  it("closed stays closed when the walk books and parks nothing (no other live row)", async () => {
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
    expect(res.outcome).toBe("closed");
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
});
