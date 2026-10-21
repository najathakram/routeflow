import { Test } from "@nestjs/testing";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * SA-835: resync -> return -> credit -> void on one order line, against an in-memory ledger, asserting the
 * line's total never goes below 0 and ends at exactly 0. Generation A (old invoice item) is already offset
 * by the resync's REVERSAL; generation B is the live one.
 */
describe("regulated ledger: resync, return, credit, void on one order line (SA-835)", () => {
  let service: RegulatedLedgerService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ledger: any[];
  let seq = 0;

  // Just enough of Prisma's where for the queries these three paths issue.
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
      if (k === "OR") return v.some((w: any) => matches(row, w));
      if (k === "AND") return v.every((w: any) => matches(row, w));
      if (v === null) return row[k] == null;
      if (v && typeof v === "object" && "in" in v) return v.in.includes(row[k]);
      if (v && typeof v === "object" && "not" in v) return row[k] !== v.not;
      return row[k] === v;
    });

  const row = (over: any) => ({
    id: `led-${++seq}`,
    tenantId: "t1",
    trackedCategoryId: "cat-A",
    trackedSubcategoryId: null,
    orderId: "ord-1",
    orderItemId: "oi-1",
    invoiceId: "inv-1",
    correctsEntryId: null,
    categoryTax: 0,
    createdAt: new Date(`2026-10-${String(1 + seq).padStart(2, "0")}T00:00:00Z`),
    ...over,
  });

  const lineTotals = () => {
    const rows = ledger.filter((r) => r.orderItemId === "oi-1");
    return {
      qty: rows.reduce((n, r) => n + Number(r.qty), 0),
      net: Math.round(rows.reduce((n, r) => n + Number(r.netSales), 0) * 100) / 100,
    };
  };

  beforeEach(async () => {
    seq = 0;
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [RegulatedLedgerService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(RegulatedLedgerService);

    ledger = [
      // generation A: the old invoice item, sold 75 for 87.50 and then offset by the resync
      row({
        entryType: "SALE",
        invoiceItemId: "ii-old",
        qty: 75,
        unitBasisQty: 75,
        netSales: 87.5,
      }),
      row({
        entryType: "REVERSAL",
        invoiceItemId: "ii-old",
        qty: -75,
        unitBasisQty: -75,
        netSales: -87.5,
      }),
      // generation B: the live invoice item
      row({
        entryType: "SALE",
        invoiceItemId: "ii-new",
        qty: 75,
        unitBasisQty: 75,
        netSales: 87.5,
      }),
    ];
    prisma.regulatedSalesLedger.findMany.mockImplementation(async ({ where }: any) =>
      ledger.filter((r) => matches(r, where)),
    );
    prisma.regulatedSalesLedger.createMany.mockImplementation(async ({ data }: any) => {
      for (const d of data) ledger.push(row(d));
      return { count: data.length };
    });
    const live = {
      id: "ii-new",
      orderItemId: "oi-1",
      invoiceId: "inv-1",
      productId: "p1",
      qty: 75,
      boxes: null,
      pieces: null,
      unitLabel: null,
      unitsPerBox: null,
    };
    prisma.invoiceItem.findMany.mockImplementation(async ({ where }: any) =>
      where.id.in.includes("ii-new") ? [live] : [],
    );
    prisma.orderItem.findMany.mockResolvedValue([{ ...live, id: "oi-1" }]);
    prisma.product.findMany.mockResolvedValue([{ id: "p1", unitsPerBox: 1 }]);
    prisma.creditNoteItem.findMany.mockResolvedValue([
      {
        id: "cni-1",
        tenantId: "t1",
        trackedCategoryId: "cat-A",
        invoiceItemId: "ii-new",
        amount: 11.67,
        qty: 10,
        categoryTax: 0,
      },
    ]);
  });

  it("the line total stays at or above 0 at every step and ends at exactly 0", async () => {
    expect(lineTotals()).toEqual({ qty: 75, net: 87.5 });

    await service.reverseReturnEntries({
      returnId: "ret-1",
      orderId: "ord-1",
      returnedByProduct: new Map([["p1", 10]]),
      returnedUnit: "PIECES",
      db: prisma,
    });
    expect(lineTotals().qty).toBe(65);
    // The return hit the live generation B, not the offset generation A.
    const ret = ledger.find((r) => r.returnId === "ret-1");
    expect(ret.invoiceItemId).toBe("ii-new");

    await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
    expect(lineTotals().qty).toBe(55);
    expect(lineTotals().net).toBeGreaterThanOrEqual(0);

    await service.reverseInvoiceEntries({ invoiceId: "inv-1", db: prisma });
    expect(lineTotals()).toEqual({ qty: 0, net: 0 });
  });
});
