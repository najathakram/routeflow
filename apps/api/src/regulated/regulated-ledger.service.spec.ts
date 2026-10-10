import { Test } from "@nestjs/testing";
import { classifySaleAxis, creditedThrough } from "@routeflow/pricing";
import { RegulatedLedgerService, priceCorrectionTarget } from "./regulated-ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("RegulatedLedgerService", () => {
  let service: RegulatedLedgerService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [RegulatedLedgerService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(RegulatedLedgerService);
  });

  describe("writeSaleEntries", () => {
    it("writes a SALE row per REGULATED line, skips standard lines, buckets by month", async () => {
      await service.writeSaleEntries({
        tenantId: "t1",
        orderId: "ord-1",
        invoiceId: "inv-1",
        soldAt: new Date("2026-07-15T00:00:00Z"),
        lines: [
          {
            invoiceItemId: "ii-1",
            orderItemId: null,
            trackedCategoryId: "cat-tob",
            qty: 3,
            netSales: 30,
            categoryTax: 0,
          },
          {
            invoiceItemId: "ii-2",
            orderItemId: null,
            trackedCategoryId: null,
            qty: 2,
            netSales: 20,
            categoryTax: 0,
          },
        ],
        db: prisma,
      });
      expect(prisma.regulatedSalesLedger.createMany).toHaveBeenCalledTimes(1);
      const data = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data;
      expect(data).toHaveLength(1); // only the regulated line
      expect(data[0]).toMatchObject({
        tenantId: "t1",
        trackedCategoryId: "cat-tob",
        entryType: "SALE",
        invoiceId: "inv-1",
        invoiceItemId: "ii-1",
        netSales: 30,
        categoryTax: 0,
        periodBucket: "2026-07",
      });
    });

    it("RF-3: passes trackedSubcategoryId through onto the SALE row (null when absent)", async () => {
      await service.writeSaleEntries({
        tenantId: "t1",
        orderId: "ord-1",
        invoiceId: "inv-1",
        soldAt: new Date("2026-07-15T00:00:00Z"),
        lines: [
          {
            invoiceItemId: "ii-1",
            orderItemId: null,
            trackedCategoryId: "cat-tob",
            trackedSubcategoryId: "sub-cig",
            qty: 3,
            netSales: 30,
            categoryTax: 0,
          },
          {
            invoiceItemId: "ii-2",
            orderItemId: null,
            trackedCategoryId: "cat-tob",
            // no trackedSubcategoryId → null on the row
            qty: 1,
            netSales: 10,
            categoryTax: 0,
          },
        ],
        db: prisma,
      });
      const data = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data;
      expect(data).toHaveLength(2);
      expect(data[0]).toMatchObject({ invoiceItemId: "ii-1", trackedSubcategoryId: "sub-cig" });
      expect(data[1]).toMatchObject({ invoiceItemId: "ii-2", trackedSubcategoryId: null });
    });

    it("no-ops with no regulated lines and for a null tenant", async () => {
      await service.writeSaleEntries({
        tenantId: "t1",
        orderId: null,
        invoiceId: "inv-1",
        soldAt: new Date(),
        lines: [
          {
            invoiceItemId: "ii-1",
            orderItemId: null,
            trackedCategoryId: null,
            qty: 1,
            netSales: 5,
            categoryTax: 0,
          },
        ],
        db: prisma,
      });
      await service.writeSaleEntries({
        tenantId: null,
        orderId: null,
        invoiceId: "inv-1",
        soldAt: new Date(),
        lines: [
          {
            invoiceItemId: "ii-1",
            orderItemId: null,
            trackedCategoryId: "cat",
            qty: 1,
            netSales: 5,
            categoryTax: 0,
          },
        ],
        db: prisma,
      });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });
  });

  // ─── B661/B671: the ledger derives unitBasisQty from the line's OWN shape ───
  //
  // writeSaleEntries is the ONLY place unitBasisQty is computed (regulatedUnitBasis, from
  // @routeflow/pricing) — no caller passes one. See that function's own spec
  // (packages/pricing/src/regulated-unit-basis.spec.ts) for the branch-by-branch unit tests;
  // these prove the LEDGER wires it correctly end to end, off the row it actually writes.
  describe("writeSaleEntries — B661 unit basis", () => {
    const line = (over: Record<string, unknown> = {}) => ({
      invoiceItemId: "ii-1",
      orderItemId: "oi-1",
      trackedCategoryId: "cat-tob",
      qty: 5,
      netSales: 50,
      categoryTax: 10,
      ...over,
    });
    const written = () => prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data;

    it("(1) a 5 boxes × 12 split line books 60, not 300 — qty already stores pieces (OrderItem invariant), boxes/pieces are the entry-snapshot only", async () => {
      await service.writeSaleEntries({
        tenantId: "t1",
        orderId: "ord-1",
        invoiceId: "inv-1",
        soldAt: new Date("2026-09-01"),
        lines: [line({ qty: 60, boxes: 5, pieces: 0, unitsPerBox: 12, packAtSale: 12 })],
        db: prisma,
      });
      expect(written()[0]).toMatchObject({ qty: 60, unitBasisQty: 60 });
    });

    it("(2) a Case line with unitLabel and qty 60 books 60, never 720", async () => {
      await service.writeSaleEntries({
        tenantId: "t1",
        orderId: "ord-1",
        invoiceId: "inv-1",
        soldAt: new Date("2026-09-01"),
        lines: [line({ qty: 60, unitLabel: "Case", packAtSale: 12 })],
        db: prisma,
      });
      expect(written()[0]).toMatchObject({ qty: 60, unitBasisQty: 60 });
    });

    it("(3) a box-unaware line of 5 with packAtSale 12 books 60, logs the warn reason, ledger qty stays 5", async () => {
      const warnSpy = jest.spyOn((service as any).logger, "warn").mockImplementation(() => {});
      await service.writeSaleEntries({
        tenantId: "t1",
        orderId: "ord-1",
        invoiceId: "inv-1",
        soldAt: new Date("2026-09-01"),
        lines: [line({ qty: 5, boxes: null, pieces: null, packAtSale: 12 })],
        db: prisma,
      });
      expect(written()[0]).toMatchObject({ qty: 5, unitBasisQty: 60 });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/B644/);
      warnSpy.mockRestore();
    });

    it("(4) a non-boxed line of 7 books 7 (no packAtSale, no split)", async () => {
      await service.writeSaleEntries({
        tenantId: "t1",
        orderId: "ord-1",
        invoiceId: "inv-1",
        soldAt: new Date("2026-09-01"),
        lines: [line({ qty: 7, boxes: null, pieces: null, packAtSale: null })],
        db: prisma,
      });
      expect(written()[0]).toMatchObject({ qty: 7, unitBasisQty: 7 });
    });

    // (7) a caller cannot pass a precomputed unitBasisQty — pinned in
    // `sale-ledger-line.type-pin.ts`, NOT here: `apps/api/tsconfig.json` excludes every
    // `*.spec.ts` from `check-types`, so a `@ts-expect-error` written inside THIS file is never
    // actually type-checked and silently pins nothing. This smoke test only proves the pin file
    // itself still imports and evaluates cleanly at jest's (transpile-only) runtime; the real
    // enforcement is `check-types` failing on that file if the excess property stops erroring.
    it("(7) the SaleLedgerLine caller-shape pin exists and its non-error half still holds", () => {
      const line: import("./regulated-ledger.service").SaleLedgerLine = {
        invoiceItemId: "ii-1",
        orderItemId: null,
        trackedCategoryId: "cat",
        qty: 5,
        netSales: 50,
        categoryTax: 0,
      };
      expect(line.qty).toBe(5);
      expect(require("fs").existsSync(`${__dirname}/sale-ledger-line.type-pin.ts`)).toBe(true);
    });

    it("(8) the reversal of a box-unaware line nets its SALE row's unitBasisQty to exactly zero", async () => {
      const warnSpy = jest.spyOn((service as any).logger, "warn").mockImplementation(() => {});
      await service.writeSaleEntries({
        tenantId: "t1",
        orderId: "ord-1",
        invoiceId: "inv-1",
        soldAt: new Date("2026-09-01"),
        lines: [line({ qty: 5, boxes: null, pieces: null, packAtSale: 12, netSales: 50 })],
        db: prisma,
      });
      const sale = written()[0];
      expect(sale.unitBasisQty).toBe(60); // the SALE row the reversal will act on
      warnSpy.mockRestore();
      prisma.regulatedSalesLedger.createMany.mockClear();
      prisma.regulatedSalesLedger.findMany.mockResolvedValueOnce([{ ...sale, entryType: "SALE" }]);
      await service.reverseInvoiceEntries({ invoiceId: "inv-1", db: prisma });
      const reversal = written()[0];
      expect(reversal).toMatchObject({ entryType: "REVERSAL", unitBasisQty: -60 });
      expect(sale.unitBasisQty + reversal.unitBasisQty).toBe(0); // net exactly zero
    });

    // (8b) B671, must-fix (Opus review of PR #1207): reverseReturnEntries's `returnedByProduct`
    // is PIECE-denominated, but a box-unaware line's own `qty` is a BOX count — comparing pieces
    // against boxes silently closed a whole multi-box sale on a fractional-box return (a 12-piece
    // return on a 5-box/60-piece line read as "12 >= 5 boxes", closing the entire $50 sale
    // instead of reversing 12/60 of it). Fixed by capping/closesRow off unitBasisQty (pieces),
    // never `qty`.
    describe("(8b) reverseReturnEntries on a box-unaware line compares PIECES to PIECES", () => {
      const writeBoxUnawareSale = async () => {
        await service.writeSaleEntries({
          tenantId: "t1",
          orderId: "ord-1",
          invoiceId: "inv-1",
          soldAt: new Date("2026-09-01"),
          lines: [
            {
              invoiceItemId: "ii-1",
              orderItemId: "oi-1",
              trackedCategoryId: "cat-tob",
              qty: 5, // 5 BOXES — the line's own unit
              boxes: null,
              pieces: null,
              packAtSale: 12,
              netSales: 50,
              categoryTax: 10,
            },
          ],
          db: prisma,
        });
        const sale = written()[0];
        expect(sale).toMatchObject({ qty: 5, unitBasisQty: 60 }); // fixture sanity
        prisma.regulatedSalesLedger.createMany.mockClear();
        return sale;
      };
      const arrangeReturn = (sale: any) => {
        prisma.regulatedSalesLedger.findMany
          .mockResolvedValueOnce([]) // prior-reversal idempotency check
          .mockResolvedValueOnce([{ id: "sale-1", ...sale, entryType: "SALE" }]) // sales
          .mockResolvedValueOnce([]); // priorReversals
        // B681: this line IS genuinely boxed (packAtSale 12 above) — its own snapshot says so,
        // matching the shape classifySaleAxis needs. Without it, the park guard cannot tell this
        // row's qty(5) != unitBasisQty(60) is a post-B661 row that expanded correctly and would
        // (correctly, per its own conservative design) park on "can't tell if it's boxed" before
        // ever reaching the qty/unitBasisQty comparison that would have cleared it.
        prisma.invoiceItem.findMany.mockResolvedValue([
          {
            id: "ii-1",
            productId: "p1",
            boxes: null,
            pieces: null,
            unitLabel: null,
            unitsPerBox: 12,
          },
        ]);
      };

      it("a 12-piece return reverses exactly 1/5 (12/60) of the net and books -12 unitBasisQty, NOT the whole 5-box sale", async () => {
        const sale = await writeBoxUnawareSale();
        arrangeReturn(sale);
        await service.reverseReturnEntries({
          returnId: "ret-1",
          orderId: "ord-1",
          returnedByProduct: new Map([["p1", 12]]),
          returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
          db: prisma,
        });
        expect(written()).toHaveLength(1);
        expect(written()[0]).toMatchObject({
          entryType: "REVERSAL",
          qty: -1, // 1 of the 5 boxes' worth — NOT -5 (the B671 bug: closing the whole line)
          unitBasisQty: -12,
          netSales: -10, // 12/60 of $50
          categoryTax: -2, // 12/60 of $10
        });
      });

      it("a 60-piece return (the full sale) closes the line exactly — qty -5, unitBasisQty -60", async () => {
        const sale = await writeBoxUnawareSale();
        arrangeReturn(sale);
        await service.reverseReturnEntries({
          returnId: "ret-1",
          orderId: "ord-1",
          returnedByProduct: new Map([["p1", 60]]),
          returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
          db: prisma,
        });
        expect(written()[0]).toMatchObject({
          entryType: "REVERSAL",
          qty: -5,
          unitBasisQty: -60,
          netSales: -50,
          categoryTax: -10,
        });
      });
    });
  });

  describe("reverseInvoiceEntries (net-aware)", () => {
    it("SELF-HEAL: a line whose MONEY is fully reversed but whose PIECE axis still has a residue is not skipped", async () => {
      // Rows written before the credit-note axis fix carry a line-unit `unitBasisQty` against a
      // piece-denominated SALE: money, qty and tax all net to zero while pieces do not. The skip guard
      // used to test only qty/net/tax, so a later void looked at such a line, concluded it was already
      // fully reversed, and left the phantom pieces on the filing forever. It must book the residue.
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat",
          entryType: "SALE",
          orderId: "ord-1",
          orderItemId: "oi-1",
          invoiceId: "inv-1",
          invoiceItemId: "ii-1",
          qty: 5,
          unitBasisQty: 60, // B661: pieces
          netSales: 50,
          categoryTax: 10,
        },
        {
          tenantId: "t1",
          trackedCategoryId: "cat",
          entryType: "REVERSAL",
          orderId: "ord-1",
          orderItemId: "oi-1",
          invoiceId: "inv-1",
          invoiceItemId: "ii-1",
          creditNoteId: "cn-legacy",
          qty: -5,
          unitBasisQty: -5, // the legacy bug: the LINE's unit, not pieces
          netSales: -50,
          categoryTax: -10,
        },
      ]);
      await service.reverseInvoiceEntries({ invoiceId: "inv-1", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).toHaveBeenCalledTimes(1);
      const row = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data[0];
      expect(row.unitBasisQty).toBe(-55); // 60 - 5 still outstanding
      // Money was already square, so nothing is double-reversed. Compared with toBeCloseTo because the
      // negation of a zero sum is -0, which Object.is distinguishes from 0; Decimal stores either as 0.
      expect(Number(row.netSales)).toBeCloseTo(0);
      expect(Number(row.categoryTax)).toBeCloseTo(0);
      expect(Number(row.qty)).toBeCloseTo(0);
    });

    // Ledger-row factories (the shape findMany returns).
    //
    // A case that overrides `qty` without saying anything about `unitBasisQty` gets the two kept in
    // step. B661 made them different axes — `qty` in the line's own unit, `unitBasisQty` in pieces —
    // and before that these factories defaulted `unitBasisQty` independently, so an overridden `qty`
    // left a stale piece count behind and the row modelled a shape no writer produces. A case that
    // genuinely wants the two to disagree (the legacy credit-note residue) sets both explicitly.
    const inStep = (row: any, over: any) =>
      over.unitBasisQty === undefined && over.qty !== undefined
        ? { ...row, unitBasisQty: over.qty }
        : row;
    const sale = (over: any = {}) =>
      inStep(
        {
          tenantId: "t1",
          trackedCategoryId: "cat",
          entryType: "SALE",
          orderId: "ord-1",
          orderItemId: "oi-1",
          invoiceId: "inv-1",
          invoiceItemId: "ii-1",
          qty: 10,
          unitBasisQty: 10,
          netSales: 50,
          categoryTax: 0,
          ...over,
        },
        over,
      );
    const reversal = (over: any = {}) =>
      inStep(
        sale({
          entryType: "REVERSAL",
          qty: -3,
          unitBasisQty: -3,
          netSales: -15,
          categoryTax: 0,
          ...over,
        }),
        over,
      );
    // A RETURN reversal carries a returnId (a credit-note reversal a creditNoteId) — the
    // provenance preserveReturns keys on. A void/re-sync reversal carries neither.
    const returnReversal = (over: any = {}) => reversal({ returnId: "ret-1", ...over });
    const written = (call = 0) => prisma.regulatedSalesLedger.createMany.mock.calls[call][0].data;

    it("plain void — reverses the full sale (no prior reversal)", async () => {
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ qty: 10, netSales: 50, categoryTax: 2 }),
      ]);
      await service.reverseInvoiceEntries({ invoiceId: "inv-1", db: prisma });
      const data = written();
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({
        entryType: "REVERSAL",
        invoiceItemId: "ii-1",
        qty: -10,
        netSales: -50,
        categoryTax: -2,
      });
    });

    it("reverses only each line's REMAINING net; a fully-reversed line is skipped", async () => {
      // ii-1: SALE 3, no reversal → reverse -3. ii-2: SALE 1 + REVERSAL -1 → net 0 → skip.
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ invoiceItemId: "ii-1", qty: 3, netSales: 30, categoryTax: 2 }),
        sale({ invoiceItemId: "ii-2", qty: 1, netSales: 10, categoryTax: 0 }),
        reversal({ invoiceItemId: "ii-2", qty: -1, netSales: -10, categoryTax: 0 }),
      ]);
      await service.reverseInvoiceEntries({ invoiceId: "inv-1", db: prisma });
      const data = written();
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({
        invoiceItemId: "ii-1",
        qty: -3,
        netSales: -30,
        categoryTax: -2,
      });
    });

    it("PARTIAL return then void reverses ONLY the un-returned remainder (no over-report)", async () => {
      // SALE(+10) with a prior return REVERSAL(-3) → remaining 7 → reverse -7 (NOT skipped,
      // NOT the full -10). Ledger nets to 0 (voided): 10 − 3 − 7 = 0.
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ qty: 10, netSales: 50 }),
        reversal({ qty: -3, netSales: -15 }),
      ]);
      await service.reverseInvoiceEntries({ invoiceId: "inv-1", db: prisma });
      const data = written();
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({ invoiceItemId: "ii-1", qty: -7, netSales: -35 });
    });

    it("FULL return then void nets to 0 — writes nothing", async () => {
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ qty: 10, netSales: 50 }),
        reversal({ qty: -10, netSales: -50 }),
      ]);
      await service.reverseInvoiceEntries({ invoiceId: "inv-1", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("double void is a no-op (line already fully reversed)", async () => {
      // First void already wrote REVERSAL(-10); a second call finds net 0.
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ qty: 10, netSales: 50 }),
        reversal({ qty: -10, netSales: -50 }),
      ]);
      await service.reverseInvoiceEntries({ invoiceId: "inv-1", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("preserveReturns re-sync: cancels only the sale-record, LEAVES the return standing", async () => {
      // SALE(+10) + a RETURN reversal(−3, returnId). preserveReturns excludes the return
      // from the remaining → reverse the full sale −10 (not the net −7), so the return's
      // reduction survives into the net.
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ qty: 10, netSales: 50 }),
        returnReversal({ qty: -3, netSales: -15 }),
      ]);
      await service.reverseInvoiceEntries({
        invoiceId: "inv-1",
        db: prisma,
        preserveReturns: true,
      });
      const data = written();
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({ invoiceItemId: "ii-1", qty: -10, netSales: -50 });
    });

    it("preserveReturns re-sync with no prior return reverses the full sale (unchanged)", async () => {
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([sale({ qty: 10, netSales: 50 })]);
      await service.reverseInvoiceEntries({
        invoiceId: "inv-1",
        db: prisma,
        preserveReturns: true,
      });
      expect(written()[0]).toMatchObject({ qty: -10, netSales: -50 });
    });

    it("preserveReturns re-sync is idempotent — a prior re-sync reversal is counted, skips", async () => {
      // After pass 1: SALE(+10), return(−3, returnId), re-sync REVERSAL(−10, no returnId).
      // Pass 2 excludes the return but COUNTS the prior re-sync reversal → remaining 0 → skip.
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ qty: 10, netSales: 50 }),
        returnReversal({ qty: -3, netSales: -15 }),
        reversal({ qty: -10, netSales: -50 }), // prior re-sync reversal (no returnId)
      ]);
      await service.reverseInvoiceEntries({
        invoiceId: "inv-1",
        db: prisma,
        preserveReturns: true,
      });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("re-sync after a partial return nets to delivered − returned (returns preserved)", async () => {
      // Full InvoicesService#resyncInvoiceLedger flow. Pre-existing: SALE(+10) + return(−3).
      // preserveReturns reverse cancels the sale (−10, return left), then re-book delivered 4.
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ qty: 10, netSales: 50 }),
        returnReversal({ qty: -3, netSales: -15 }),
      ]);
      await service.reverseInvoiceEntries({
        invoiceId: "inv-1",
        db: prisma,
        preserveReturns: true,
      });
      const reverse = written(0);
      expect(reverse[0]).toMatchObject({ qty: -10, netSales: -50 });

      await service.writeSaleEntries({
        tenantId: "t1",
        orderId: "ord-1",
        invoiceId: "inv-1",
        soldAt: new Date(),
        lines: [
          {
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            trackedCategoryId: "cat",
            qty: 4,
            netSales: 20,
            categoryTax: 0,
          },
        ],
        db: prisma,
      });
      const newSale = written(1);
      expect(newSale[0]).toMatchObject({ entryType: "SALE", qty: 4, netSales: 20 });

      // Net = original SALE(+10) + return(−3) + reverse(−10) + new SALE(+4) = +1 =
      // delivered(4) − returned(3). The return's reduction is preserved (no over-report).
      const netQty = [
        10,
        -3,
        ...reverse.map((r: any) => r.qty),
        ...newSale.map((r: any) => r.qty),
      ].reduce((a, b) => a + b, 0);
      expect(netQty).toBe(1);
    });

    it("RF-3: carries the SALE's trackedSubcategoryId onto the REVERSAL row", async () => {
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([
        sale({ qty: 10, netSales: 50, categoryTax: 0, trackedSubcategoryId: "sub-cig" }),
      ]);
      await service.reverseInvoiceEntries({ invoiceId: "inv-1", db: prisma });
      expect(written()[0]).toMatchObject({
        entryType: "REVERSAL",
        trackedSubcategoryId: "sub-cig",
        qty: -10,
      });
    });

    it("no-ops when the invoice has no ledger rows", async () => {
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([]);
      await service.reverseInvoiceEntries({ invoiceId: "inv-x", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });
  });

  describe("reverseReturnEntries", () => {
    // B681: classifySaleAxis's first check is `entryType !== "SALE"` — the pre-B681 fixture never
    // set this (the real query already filters entryType: "SALE", so it never mattered before
    // anything read the field on the mock row itself). Every row also needs its OWN `id` now, so
    // the park guard's per-row Maps (line shape / corrections) key correctly instead of every row
    // colliding on one shared default — a fresh counter per row, not a fixed string, so a test
    // building several rows without naming each one still gets distinct keys.
    let saleRowSeq = 0;
    const saleRow = (over: Record<string, unknown> = {}) => ({
      id: `sale-${++saleRowSeq}`,
      entryType: "SALE",
      tenantId: "t1",
      trackedCategoryId: "cat-A",
      orderId: "ord-1",
      orderItemId: null,
      invoiceId: "inv-1",
      invoiceItemId: "ii-1",
      qty: 3,
      unitBasisQty: 3,
      netSales: 30,
      categoryTax: 6,
      ...over,
    });

    // Arrange the 3 regulatedSalesLedger.findMany calls (prior→sales→priorReversals)
    // + the invoiceItem.findMany bridge.
    //
    // B681/SA-067: the PIECES branch now also calls loadSaleLineShapes (invoiceItem.findMany,
    // already stubbed above, plus orderItem.findMany — defaults to [] via createMockPrisma,
    // fine since these fixtures use invoiceItemId), loadCorrectionsBySaleId (one more
    // regulatedSalesLedger.findMany call, past this helper's 3-deep mockResolvedValueOnce
    // queue — falls through to the mock's persistent default `[]`, i.e. "no corrections",
    // harmless) and loadProductPackNow (product.findMany). That last one is NOT harmless by
    // default: an unconfigured product.findMany resolves `[]`, so `packNowByProduct` has no
    // entry for "p1" and classifySaleAxis reads that as `productPackNow: undefined` — "caller
    // doesn't know" — parking every one of THESE pre-existing fixtures, which predate B681 and
    // were never meant to exercise it. Default it to "not boxed" (unitsPerBox: 1) so every
    // existing PIECES-branch test keeps proceeding to a normal reversal, matching what it was
    // actually testing; a test that wants a DIFFERENT product shape passes its own `products`.
    const arrange = (opts: {
      prior?: unknown[];
      sales: unknown[];
      priorReversals?: unknown[];
      items: unknown[];
      products?: unknown[];
    }) => {
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce(opts.prior ?? [])
        .mockResolvedValueOnce(opts.sales)
        .mockResolvedValueOnce(opts.priorReversals ?? []);
      prisma.invoiceItem.findMany.mockResolvedValue(opts.items);
      prisma.product.findMany.mockResolvedValue(
        opts.products ??
          [...new Set(opts.items.map((i: any) => i.productId))].map((id) => ({
            id,
            unitsPerBox: 1,
          })),
      );
    };

    const written = () => prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data;

    it("fully reverses a single SALE row, using the row's category snapshot", async () => {
      arrange({ sales: [saleRow()], items: [{ id: "ii-1", productId: "p1" }] });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 3]]),
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      expect(prisma.regulatedSalesLedger.createMany).toHaveBeenCalledTimes(1);
      expect(written()).toHaveLength(1);
      expect(written()[0]).toMatchObject({
        entryType: "REVERSAL",
        returnId: "ret-1",
        invoiceItemId: "ii-1",
        trackedCategoryId: "cat-A", // from the SALE snapshot, not the live product
        qty: -3,
        unitBasisQty: -3,
        netSales: -30,
        categoryTax: -6,
      });
    });

    // B662 (Opus R2): a price correction restates the held money on the SALE (a SALE-typed row with
    // correctsEntryId). A partial return pro-rates the sale's CURRENT held net/tax: the base row alone
    // under-reversed (a $240 sale corrected to $300, 12 of 72 pieces back booked -$40, not -$50), leaving
    // $260 held against a $250 invoice share. Driven through reverseReturnEntries, not a hand-written -50.
    it("B662: a partial return after a price correction reverses its share of the CORRECTED net and tax", async () => {
      const base = saleRow({ qty: 72, unitBasisQty: 72, netSales: 240, categoryTax: 48 });
      const correction = saleRow({
        correctsEntryId: base.id,
        qty: 0,
        unitBasisQty: 0,
        netSales: 60,
        categoryTax: 12,
      });
      arrange({ sales: [base, correction], items: [{ id: "ii-1", productId: "p1" }] });
      prisma.regulatedSalesLedger.findMany.mockResolvedValueOnce([
        {
          correctsEntryId: base.id,
          qty: 0,
          unitBasisQty: 0,
          netSales: 60,
          categoryTax: 12,
        },
      ]);
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 12]]),
        returnedUnit: "PIECES",
        db: prisma,
      });
      expect(written()).toHaveLength(1);
      expect(written()[0]).toMatchObject({
        entryType: "REVERSAL",
        qty: -12,
        unitBasisQty: -12,
        netSales: -50, // 12/72 of $300, not of the base $240 (-40)
        categoryTax: -10, // 12/72 of $60, not of the base $48 (-8)
      });
    });

    it("R-1: a STANDARD (LINE_UNIT) return after a price correction reverses its share of the CORRECTED net and tax (no correction map needed)", async () => {
      const base = saleRow({ qty: 72, unitBasisQty: 72, netSales: 240, categoryTax: 48 });
      const correction = saleRow({
        correctsEntryId: base.id,
        qty: 0,
        unitBasisQty: 0,
        netSales: 60,
        categoryTax: 12,
      });
      arrange({ sales: [base, correction], items: [{ id: "ii-1", productId: "p1" }] });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 12]]),
        returnedUnit: "LINE_UNIT",
        db: prisma,
      });
      expect(written()).toHaveLength(1);
      expect(written()[0]).toMatchObject({
        entryType: "REVERSAL",
        qty: -12,
        unitBasisQty: -12,
        netSales: -50, // 12/72 of $300, not of the base $240 (-40)
        categoryTax: -10, // 12/72 of $60, not of the base $48 (-8)
      });
    });

    // B661/B671 rd2 (live production regression) — the regression pin CI actually runs. The
    // DB-lane spec (return-reversal-unit-axis.db.spec.ts) proves this through the real caller,
    // but nothing in CI invokes `npm run local:test:db`; this mock-level case is what a future
    // refactor deleting the returnedUnit axis selection would actually break in the default
    // test lane. Confirmed this fails (qty -0.417, unitBasisQty -5) with the fix reverted.
    it("B661/B671 rd2: a LINE_UNIT caller (the standard return path) closes a box-unaware line on the QTY axis, not the pieces axis", async () => {
      // Box-unaware: 5 boxes at pack 12 -> SALE.qty 5 (boxes), SALE.unitBasisQty 60 (pieces).
      arrange({
        sales: [saleRow({ qty: 5, unitBasisQty: 60, netSales: 50, categoryTax: 10 })],
        items: [{ id: "ii-1", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        // The standard caller's returnedByProduct is in the LINE's own unit (boxes) — 5, a
        // FULL return, never 60 (pieces).
        returnedByProduct: new Map([["p1", 5]]),
        returnedUnit: "LINE_UNIT",
        db: prisma,
      });
      expect(written()[0]).toMatchObject({
        entryType: "REVERSAL",
        qty: -5, // NOT -0.417 (the pre-fix bug: 5 compared against the PIECES axis, frac 5/60)
        unitBasisQty: -60, // NOT -5
        netSales: -50, // NOT -4.17
        categoryTax: -10, // NOT -0.83
      });
    });

    // ─── PR-1a (§5): idempotency key widened from returnId alone to (returnId, orderId) ───

    it("PR-1a: the prior-reversal check is keyed on (returnId, orderId), not returnId alone", async () => {
      arrange({ sales: [saleRow()], items: [{ id: "ii-1", productId: "p1" }] });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 3]]),
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      // Revert probe: dropping `orderId` from this where clause (back to `{ returnId,
      // entryType: "REVERSAL" }`) fails this exact-match assertion.
      expect(prisma.regulatedSalesLedger.findMany).toHaveBeenNthCalledWith(1, {
        where: { returnId: "ret-1", orderId: "ord-1", entryType: "REVERSAL" },
        select: { id: true },
      });
    });

    it("PR-1a fix-round (a REAL prior-reversal store, not a blind mockResolvedValueOnce queue): order B is not blocked by order A's REVERSAL, and a SECOND call for order A IS blocked", async () => {
      // The `arrange()` helper's `findMany` stub is a call-order queue that never
      // inspects `where` — it would pass this exact scenario even against the
      // UN-WIDENED key (`{returnId, entryType}` alone), so it cannot prove the fix.
      // This mock actually tracks which (returnId, orderId) pairs have a REVERSAL,
      // keyed off the real `where` clause each call site sends.
      const reversedPairs = new Set<string>();
      const writtenRows: any[] = [];

      prisma.regulatedSalesLedger.findMany.mockImplementation(async (args: any) => {
        const where = args.where ?? {};
        if (where.entryType === "REVERSAL" && "returnId" in where && "orderId" in where) {
          // The prior-reversal idempotency check this fix-round targets.
          return reversedPairs.has(`${where.returnId}:${where.orderId}`) ? [{ id: "prior-1" }] : [];
        }
        if (where.entryType === "SALE") {
          return [saleRow({ orderId: where.orderId, invoiceItemId: `ii-${where.orderId}` })];
        }
        // priorReversals (keyed by invoiceItemId) — none to fold in for this scenario.
        return [];
      });
      prisma.invoiceItem.findMany.mockImplementation(async (args: any) =>
        (args.where.id.in as string[]).map((id) => ({ id, productId: "p1" })),
      );
      // B681: not boxed, so the park guard's classify step clears every row straight to
      // piece-axis and this test exercises only what it says on the tin (the idempotency key).
      prisma.product.findMany.mockResolvedValue([{ id: "p1", unitsPerBox: 1 }]);
      prisma.regulatedSalesLedger.createMany.mockImplementation(async (args: any) => {
        writtenRows.push(...args.data);
        for (const row of args.data) reversedPairs.add(`${row.returnId}:${row.orderId}`);
        return { count: args.data.length };
      });

      // Order A: nothing reversed yet — reverses.
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-a",
        returnedByProduct: new Map([["p1", 3]]),
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      expect(reversedPairs.has("ret-1:ord-a")).toBe(true);

      // Order B, SAME returnId: (ret-1, ord-a) already has a REVERSAL, but (ret-1,
      // ord-b) does not — the widened key must not treat this as already-reversed.
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-b",
        returnedByProduct: new Map([["p1", 3]]),
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      expect(reversedPairs.has("ret-1:ord-b")).toBe(true);
      expect(writtenRows.filter((r) => r.orderId === "ord-a")).toHaveLength(1);
      expect(writtenRows.filter((r) => r.orderId === "ord-b")).toHaveLength(1);

      // A THIRD call repeating order A must now be a no-op — proves the guard is a
      // real per-pair check, not "always allow" dressed up in a wider where clause.
      writtenRows.length = 0;
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-a",
        returnedByProduct: new Map([["p1", 3]]),
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      expect(writtenRows).toHaveLength(0);
    });

    it("RF-3: carries the SALE's trackedSubcategoryId onto the return REVERSAL row", async () => {
      arrange({
        sales: [saleRow({ trackedSubcategoryId: "sub-cig" })],
        items: [{ id: "ii-1", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 3]]),
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      expect(written()[0]).toMatchObject({
        entryType: "REVERSAL",
        returnId: "ret-1",
        trackedSubcategoryId: "sub-cig",
      });
    });

    it("PRO-RATES a partial return off the original row (rounded to cents)", async () => {
      arrange({
        sales: [saleRow({ qty: 3, unitBasisQty: 3, netSales: 10, categoryTax: 6 })],
        items: [{ id: "ii-1", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 1]]), // 1 of 3
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      expect(written()[0]).toMatchObject({
        qty: -1,
        unitBasisQty: -1,
        netSales: -3.33,
        categoryTax: -2,
      });
    });

    it("is idempotent — a return already reversed writes nothing", async () => {
      prisma.regulatedSalesLedger.findMany.mockResolvedValueOnce([{ id: "existing-rev" }]);
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 1]]),
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("no-ops when the order has no SALE rows (return of an un-invoiced sale)", async () => {
      arrange({ sales: [], items: [] });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 1]]),
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("allocates a return across MULTIPLE SALE rows (W4 split invoices) FIFO", async () => {
      arrange({
        sales: [
          saleRow({
            invoiceItemId: "ii-1",
            invoiceId: "inv-1",
            qty: 2,
            unitBasisQty: 2,
            netSales: 20,
            categoryTax: 4,
          }),
          saleRow({
            invoiceItemId: "ii-2",
            invoiceId: "inv-2",
            qty: 3,
            unitBasisQty: 3,
            netSales: 30,
            categoryTax: 6,
          }),
        ],
        items: [
          { id: "ii-1", productId: "p1" },
          { id: "ii-2", productId: "p1" },
        ],
      });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 4]]), // 2 from ii-1, 2 from ii-2
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      const rows = written();
      expect(rows).toHaveLength(2);
      expect(rows.reduce((s: number, r: any) => s + r.qty, 0)).toBe(-4);
      expect(rows.reduce((s: number, r: any) => s + r.netSales, 0)).toBe(-40); // 20 + (30*2/3)
    });

    it("subtracts prior partial reversals so cumulative reversal can't exceed sold qty", async () => {
      arrange({
        sales: [saleRow({ qty: 3, unitBasisQty: 3, netSales: 30, categoryTax: 0 })],
        // 2 units already reversed elsewhere (-$20 of the $30 row).
        priorReversals: [
          { invoiceItemId: "ii-1", qty: -2, unitBasisQty: -2, netSales: -20, categoryTax: 0 },
        ],
        items: [{ id: "ii-1", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-2",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 3]]), // wants 3, only 1 remains
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      expect(written()[0]).toMatchObject({ qty: -1, unitBasisQty: -1, netSales: -10 });
    });

    it("closing chunk absorbs rounding drift so a fully-returned line nets to exactly 0", async () => {
      // Two prior 1-unit returns booked -3.33 each; this 3rd unit CLOSES the row and
      // must book the exact remaining balance (-3.34), not another pro-rated -3.33,
      // so the +10.00 SALE nets to exactly 0 (not a phantom +0.01).
      arrange({
        sales: [saleRow({ qty: 3, unitBasisQty: 3, netSales: 10, categoryTax: 0 })],
        priorReversals: [
          { invoiceItemId: "ii-1", qty: -1, unitBasisQty: -1, netSales: -3.33, categoryTax: 0 },
          { invoiceItemId: "ii-1", qty: -1, unitBasisQty: -1, netSales: -3.33, categoryTax: 0 },
        ],
        items: [{ id: "ii-1", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-3",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 1]]),
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      expect(written()[0]).toMatchObject({ qty: -1, unitBasisQty: -1, netSales: -3.34 });
    });

    it("does not double-reverse when a CREDIT NOTE already reversed the same line", async () => {
      // Reachable path: the returns page can both process the return AND issue a credit
      // note. The credit-note REVERSAL (keyed by invoiceItemId) must count against the
      // return's cap so the SALE isn't reversed twice into a negative filing.
      arrange({
        sales: [saleRow({ qty: 3, unitBasisQty: 3, netSales: 30, categoryTax: 0 })],
        priorReversals: [
          { invoiceItemId: "ii-1", qty: -3, unitBasisQty: -3, netSales: -30, categoryTax: 0 },
        ],
        items: [{ id: "ii-1", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-dup",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 3]]), // wants all 3, but 0 remain
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    // A delivered-basis reconcile DELETES the open draft's InvoiceItems and re-books
    // the SALE under fresh ids (ii-1 → ii-2) on the SAME order line (oi-1). The
    // cumulative-reversal cap keys on orderItemId, so it survives the rotation.
    it("caps a 2nd full return after a reconcile — SUM floors at 0, not negative", async () => {
      // Ledger: SALE ii-1(+10) → return ret-1(-10) → resync(-10) → SALE ii-2(+10) = net 0.
      // A 2nd full return must reverse NOTHING (order line already fully returned).
      arrange({
        sales: [
          saleRow({
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: 10,
            unitBasisQty: 10,
            netSales: 100,
            categoryTax: 0,
          }),
          saleRow({
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            qty: 10,
            unitBasisQty: 10,
            netSales: 100,
            categoryTax: 0,
          }),
        ],
        priorReversals: [
          {
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: -10,
            unitBasisQty: -10,
            netSales: -100,
            categoryTax: 0,
          },
          {
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: -10,
            unitBasisQty: -10,
            netSales: -100,
            categoryTax: 0,
          },
        ],
        items: [{ id: "ii-2", productId: "p1" }], // ii-1 was deleted by the reconcile
      });
      await service.reverseReturnEntries({
        returnId: "ret-2",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 10]]),
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("still books a VALID partial return after a reconcile (cap survives item recreation)", async () => {
      // SALE ii-1(+10) → return ret-1 of 3(-3) → resync(-10) → SALE ii-2(+10): net 7 / $70.
      // A 2nd return of 2 (total 5 ≤ 10) is valid and books -2 / -20 against the live row.
      arrange({
        sales: [
          saleRow({
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: 10,
            unitBasisQty: 10,
            netSales: 100,
            categoryTax: 0,
          }),
          saleRow({
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            qty: 10,
            unitBasisQty: 10,
            netSales: 100,
            categoryTax: 0,
          }),
        ],
        priorReversals: [
          {
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: -3,
            unitBasisQty: -3,
            netSales: -30,
            categoryTax: 0,
          },
          {
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: -10,
            unitBasisQty: -10,
            netSales: -100,
            categoryTax: 0,
          },
        ],
        items: [{ id: "ii-2", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-2",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 2]]),
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      expect(written()).toHaveLength(1);
      expect(written()[0]).toMatchObject({ qty: -2, unitBasisQty: -2, netSales: -20 });
    });

    it("floors a 2nd over-return after a reconcile at the line's remaining (never negative)", async () => {
      // After a partial return of 3 + reconcile, 7 remain. A 2nd return of 10 books only
      // -7 / -70 (closing the line to exactly 0), not -10.
      arrange({
        sales: [
          saleRow({
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: 10,
            unitBasisQty: 10,
            netSales: 100,
            categoryTax: 0,
          }),
          saleRow({
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            qty: 10,
            unitBasisQty: 10,
            netSales: 100,
            categoryTax: 0,
          }),
        ],
        priorReversals: [
          {
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: -3,
            unitBasisQty: -3,
            netSales: -30,
            categoryTax: 0,
          },
          {
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: -10,
            unitBasisQty: -10,
            netSales: -100,
            categoryTax: 0,
          },
        ],
        items: [{ id: "ii-2", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-2",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 10]]),
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      expect(written()).toHaveLength(1);
      expect(written()[0]).toMatchObject({ qty: -7, unitBasisQty: -7, netSales: -70 });
    });

    it("clamps a fractional partial after a RE-PRICED reconcile so net can't over-reverse", async () => {
      // Reconcile re-priced the line DOWN: dead ii-1 was $12/u, live ii-2 is $10/u, and a
      // pre-reconcile return of 2 (-$24) is preserved. Line remaining = 8 qty / $76. A
      // fractional return of 7.7 pro-rates off the live row's $10/u = $77 > $76 remaining —
      // it must CLAMP to -$76 (net floors at 0), not book -$77 (SUM would go negative).
      arrange({
        sales: [
          saleRow({
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: 10,
            unitBasisQty: 10,
            netSales: 120,
            categoryTax: 0,
          }),
          saleRow({
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            qty: 10,
            unitBasisQty: 10,
            netSales: 100,
            categoryTax: 0,
          }),
        ],
        priorReversals: [
          {
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: -2,
            unitBasisQty: -2,
            netSales: -24,
            categoryTax: 0,
          },
          {
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: -10,
            unitBasisQty: -10,
            netSales: -120,
            categoryTax: 0,
          },
        ],
        items: [{ id: "ii-2", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-2",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 7.7]]),
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      // B662: a non-closing chunk books its share of what the line STILL HOLDS: $76 x 7.7/8 = $73.15
      // (it can no longer exceed the remaining, so the clamp below it is defense in depth only).
      expect(written()[0]).toMatchObject({ qty: -7.7, unitBasisQty: -7.7, netSales: -73.15 });
    });

    it("a non-closing partial return can NEVER drive the line net below 0 (reprice-to-zero)", async () => {
      // Canonical counterexample: SALE ii-1(+10/$100) → return 5(-$50) → reprice to $5/u
      // → resync(-$100) → SALE ii-2(+10/$50). Line net is already $0 (delivered $50 −
      // returned $50) with 5 qty remaining. A 2nd non-closing return of 4 pro-rates off
      // the live $5/u row = -$20 — it MUST clamp to $0 so the category SUM stays 0.
      arrange({
        sales: [
          saleRow({
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: 10,
            unitBasisQty: 10,
            netSales: 100,
            categoryTax: 0,
          }),
          saleRow({
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            qty: 10,
            unitBasisQty: 10,
            netSales: 50,
            categoryTax: 0,
          }),
        ],
        priorReversals: [
          {
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: -5,
            unitBasisQty: -5,
            netSales: -50,
            categoryTax: 0,
          },
          {
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: -10,
            unitBasisQty: -10,
            netSales: -100,
            categoryTax: 0,
          },
        ],
        items: [{ id: "ii-2", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-2",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 4]]),
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      const row = written()[0];
      expect(row.qty).toBe(-4);
      expect(row.netSales).toBeGreaterThanOrEqual(0); // clamped: never a negative-SUM over-reversal
    });

    it("clamps the categoryTax dimension too after a RE-PRICED reconcile", async () => {
      // Same reprice-down shape but with a NON-ZERO tax rate, guarding the taxRem clamp
      // (every other test carries categoryTax 0). Dead ii-1 $12/u + $2.40/u tax, live ii-2
      // $10/u + $2/u tax, pre-reconcile return of 2 preserved. Line remaining = 8 qty /
      // $76 net / $15.20 tax. A 7.7 return pro-rates tax off the live $2/u = $15.40 > the
      // $15.20 remaining — it must CLAMP to -$15.20, not book -$15.40 (tax SUM would go < 0).
      arrange({
        sales: [
          saleRow({
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: 10,
            unitBasisQty: 10,
            netSales: 120,
            categoryTax: 24,
          }),
          saleRow({
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            qty: 10,
            unitBasisQty: 10,
            netSales: 100,
            categoryTax: 20,
          }),
        ],
        priorReversals: [
          {
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: -2,
            unitBasisQty: -2,
            netSales: -24,
            categoryTax: -4.8,
          },
          {
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: -10,
            unitBasisQty: -10,
            netSales: -120,
            categoryTax: -24,
          },
        ],
        items: [{ id: "ii-2", productId: "p1" }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-2",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 7.7]]),
        returnedUnit: "PIECES", // B671 rd2: this fixture is piece-denominated, matching the INLINE caller
        db: prisma,
      });
      expect(written()[0]).toMatchObject({
        qty: -7.7,
        unitBasisQty: -7.7,
        netSales: -73.15,
        categoryTax: -14.63,
      });
    });

    // B660a characterization — pinning the extracted booker's exit translations. Every test
    // above uses ONE product with ONE live row, so a mutation turning `bookReversalChunk`'s
    // "skip this row" (`continue`) into "stop this product" (as if parked) still passes them
    // all; these three fail on that exact mutation.

    it("B660a(a): a line already fully reversed is skipped (continue), and the return books against the SECOND line for the same product", async () => {
      arrange({
        sales: [
          saleRow({ id: "s-1", orderItemId: "oi-1", invoiceItemId: "ii-1" }),
          saleRow({ id: "s-2", orderItemId: "oi-2", invoiceItemId: "ii-2" }),
        ],
        priorReversals: [
          {
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            qty: -3,
            unitBasisQty: -3,
            netSales: -30,
            categoryTax: -6,
          },
        ],
        items: [
          { id: "ii-1", productId: "p1" },
          { id: "ii-2", productId: "p1" },
        ],
      });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 3]]),
        returnedUnit: "PIECES",
        db: prisma,
      });
      expect(written()).toHaveLength(1);
      expect(written()[0]).toMatchObject({ invoiceItemId: "ii-2", orderItemId: "oi-2", qty: -3 });
    });

    it("B660a(b): a zero-native-axis row is skipped (continue), and the return books against the SECOND live row", async () => {
      arrange({
        sales: [
          saleRow({
            id: "s-1",
            orderItemId: "oi-1",
            invoiceItemId: "ii-1",
            qty: 0,
            unitBasisQty: 0,
            netSales: 0,
            categoryTax: 0,
          }),
          saleRow({ id: "s-2", orderItemId: "oi-2", invoiceItemId: "ii-2" }),
        ],
        items: [
          { id: "ii-1", productId: "p1" },
          { id: "ii-2", productId: "p1" },
        ],
      });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 3]]),
        returnedUnit: "PIECES",
        db: prisma,
      });
      expect(written()).toHaveLength(1);
      expect(written()[0]).toMatchObject({ invoiceItemId: "ii-2", orderItemId: "oi-2", qty: -3 });
    });

    it("B660a(c): one product parks (break, stops only ITS OWN product loop) while a second product in the same return still reverses", async () => {
      arrange({
        sales: [
          // p1: legacy box-unaware -> parks (same shape as the B681 park guard's case (a)).
          saleRow({
            id: "s-p1",
            orderItemId: "oi-p1",
            invoiceItemId: "ii-p1",
            qty: 5,
            unitBasisQty: 5,
            netSales: 50,
            categoryTax: 10,
          }),
          // p2: ordinary non-boxed live row -> reverses normally.
          saleRow({ id: "s-p2", orderItemId: "oi-p2", invoiceItemId: "ii-p2" }),
        ],
        items: [
          {
            id: "ii-p1",
            productId: "p1",
            boxes: null,
            pieces: null,
            unitLabel: null,
            unitsPerBox: 12,
          },
          { id: "ii-p2", productId: "p2" },
        ],
        products: [
          { id: "p1", unitsPerBox: 12 },
          { id: "p2", unitsPerBox: 1 },
        ],
      });
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => undefined);
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([
          ["p1", 12],
          ["p2", 3],
        ]),
        returnedUnit: "PIECES",
        db: prisma,
      });
      expect(warnSpy).toHaveBeenCalled(); // p1 parked
      expect(prisma.regulatedLedgerParkedReversal.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [expect.objectContaining({ saleEntryId: "s-p1", returnedPieces: 12 })],
        }),
      );
      expect(written()).toHaveLength(1); // only p2 reversed
      expect(written()[0]).toMatchObject({ invoiceItemId: "ii-p2", qty: -3 });
    });
  });

  // ─── B681/SA-067: the park guard — reverseReturnEntries, PIECES branch only ───
  //
  // Red-first cases (a)-(h) from SA-067(6), observed and reported. `classifySaleAxis`
  // (@routeflow/pricing, #1239) is the ONE shared predicate — imported by name, never a second
  // copy. "Parked" here always means a RegulatedLedgerParkedReversal row; the B681 correction
  // routine's OWN "parked" (an unknown-basis line it refuses and reports) is a different thing
  // at a different layer and the two meanings are never conflated in these tests either.
  describe("B681 park guard (SA-067) — reverseReturnEntries, PIECES branch", () => {
    const arrangeParkTest = (opts: {
      sale: Record<string, unknown>;
      item: Record<string, unknown>;
      corrections?: unknown[];
      products?: unknown[];
    }) => {
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // prior-reversal idempotency
        .mockResolvedValueOnce([opts.sale]) // sales
        .mockResolvedValueOnce([]) // priorReversals
        .mockResolvedValueOnce(opts.corrections ?? []); // loadCorrectionsBySaleId
      prisma.invoiceItem.findMany.mockResolvedValue([opts.item]);
      prisma.product.findMany.mockResolvedValue(
        opts.products ?? [{ id: opts.item.productId, unitsPerBox: opts.item.unitsPerBox ?? null }],
      );
    };

    it("(a) a legacy box-unaware SALE row (qty 5, unitBasisQty 5, pack 12) → NOT reversed, one parked row, warn logged", async () => {
      const sale = {
        id: "s-a",
        entryType: "SALE",
        tenantId: "t1",
        trackedCategoryId: "cat-A",
        orderId: "ord-1",
        orderItemId: "oi-1",
        invoiceId: "inv-1",
        invoiceItemId: "ii-a",
        qty: 5,
        unitBasisQty: 5,
        netSales: 50,
        categoryTax: 10,
      };
      arrangeParkTest({
        sale,
        item: {
          id: "ii-a",
          productId: "p1",
          boxes: null,
          pieces: null,
          unitLabel: null,
          unitsPerBox: 12,
        },
      });
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => undefined);
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 12]]), // "inline 12 pieces" per SA-067(6)(a)
        returnedUnit: "PIECES",
        db: prisma,
      });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled(); // no REVERSAL
      expect(prisma.regulatedLedgerParkedReversal.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            tenantId: "t1",
            returnId: "ret-1",
            orderId: "ord-1",
            orderItemId: "oi-1",
            saleEntryId: "s-a",
            returnedPieces: 12,
          }),
        ],
        skipDuplicates: true,
      });
      expect(warnSpy).toHaveBeenCalled();
    });

    // Architect condition on the PASS at 5183e1d5: SA-067(2) says "a row with NO readable line
    // parks too" — the code path exists (loadSaleLineShapes falls through to `null` when NEITHER
    // the invoiceItemId nor the orderItemId resolves to anything), but nothing proved it directly.
    //
    // reverseReturnEntries only ever considers a SALE row a candidate once its invoiceItemId has
    // ALREADY resolved to a live product (`productByItem`, built from the same InvoiceItem table
    // earlier in this method) — so a row whose invoice item is genuinely gone is filtered out long
    // before classifySaleAxis runs, by pre-existing logic this PR does not change. Proving "no
    // readable line still parks, never guesses" therefore has to separate that PRE-EXISTING
    // productId lookup (which must succeed for the row to reach this guard at all) from
    // loadSaleLineShapes's OWN, later, fuller re-read of the same id (which is what can come back
    // empty in reality: a reconcile can delete/rotate an invoice item's ROW between when the return
    // service first resolves productByItem for its own separate purposes and when this guard reads
    // the line's shape). Two sequential invoiceItem.findMany resolutions model exactly that: the
    // first (productByItem's) still finds the old row's bare id/productId either from an
    // in-progress read or a stale index entry; the second (loadSaleLineShapes's own) reflects the
    // row already being gone. orderItem.findMany also finding nothing rules out the fallback.
    it('(a2) invoiceItemId resolves a product (so the row is a live candidate) but loadSaleLineShapes\'s own line-shape re-read of that id finds nothing, and orderItemId has no fallback either → line null → unknown → parked ("no line to read a shape from")', async () => {
      const sale = {
        id: "s-a2",
        entryType: "SALE",
        tenantId: "t1",
        trackedCategoryId: "cat-A",
        orderId: "ord-1",
        orderItemId: "oi-gone", // no OrderItem row for this id either — no fallback
        invoiceId: "inv-1",
        invoiceItemId: "ii-a2",
        qty: 5,
        unitBasisQty: 5,
        netSales: 50,
        categoryTax: 10,
      };
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // prior-reversal idempotency
        .mockResolvedValueOnce([sale]) // sales
        .mockResolvedValueOnce([]) // priorReversals
        .mockResolvedValueOnce([]); // loadCorrectionsBySaleId
      prisma.invoiceItem.findMany
        // 1st call: productByItem — must resolve, or the row never becomes a candidate at all
        // (pre-existing gate, unrelated to this guard) and this test would prove nothing.
        .mockResolvedValueOnce([{ id: "ii-a2", productId: "p1" }])
        // 2nd call: loadSaleLineShapes's own re-read of the SAME id — comes back empty.
        .mockResolvedValueOnce([]);
      prisma.orderItem.findMany.mockResolvedValue([]); // no fallback either
      prisma.product.findMany.mockResolvedValue([]);
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => undefined);
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 5]]),
        returnedUnit: "PIECES",
        db: prisma,
      });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled(); // no REVERSAL
      expect(prisma.regulatedLedgerParkedReversal.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            saleEntryId: "s-a2",
            reason: "no line to read a shape from",
          }),
        ],
        skipDuplicates: true,
      });
      expect(warnSpy).toHaveBeenCalled();
    });

    it("(c) a SPLIT line (boxes 5) with qty 60 == unitBasisQty 60 → NOT parked (the false-positive guard)", async () => {
      const sale = {
        id: "s-c",
        entryType: "SALE",
        tenantId: "t1",
        trackedCategoryId: "cat-A",
        orderId: "ord-1",
        orderItemId: "oi-1",
        invoiceId: "inv-1",
        invoiceItemId: "ii-c",
        qty: 60,
        unitBasisQty: 60,
        netSales: 50,
        categoryTax: 10,
      };
      arrangeParkTest({
        sale,
        item: {
          id: "ii-c",
          productId: "p1",
          boxes: 5,
          pieces: 0,
          unitLabel: null,
          unitsPerBox: 12,
        },
      });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 60]]),
        returnedUnit: "PIECES",
        db: prisma,
      });
      expect(prisma.regulatedLedgerParkedReversal.createMany).not.toHaveBeenCalled();
      expect(prisma.regulatedSalesLedger.createMany).toHaveBeenCalledTimes(1);
    });

    it('(d) a unit line (unitLabel "Case") with qty 60 == unitBasisQty 60 → NOT parked', async () => {
      const sale = {
        id: "s-d",
        entryType: "SALE",
        tenantId: "t1",
        trackedCategoryId: "cat-A",
        orderId: "ord-1",
        orderItemId: "oi-1",
        invoiceId: "inv-1",
        invoiceItemId: "ii-d",
        qty: 60,
        unitBasisQty: 60,
        netSales: 50,
        categoryTax: 10,
      };
      arrangeParkTest({
        sale,
        item: {
          id: "ii-d",
          productId: "p1",
          boxes: null,
          pieces: null,
          unitLabel: "Case",
          unitsPerBox: null,
        },
      });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 60]]),
        returnedUnit: "PIECES",
        db: prisma,
      });
      expect(prisma.regulatedLedgerParkedReversal.createMany).not.toHaveBeenCalled();
      expect(prisma.regulatedSalesLedger.createMany).toHaveBeenCalledTimes(1);
    });

    it("(e) a non-boxed product (no line snapshot, live pack 1) with qty 7 == unitBasisQty 7 → NOT parked", async () => {
      const sale = {
        id: "s-e",
        entryType: "SALE",
        tenantId: "t1",
        trackedCategoryId: "cat-A",
        orderId: "ord-1",
        orderItemId: "oi-1",
        invoiceId: "inv-1",
        invoiceItemId: "ii-e",
        qty: 7,
        unitBasisQty: 7,
        netSales: 50,
        categoryTax: 10,
      };
      arrangeParkTest({
        sale,
        item: {
          id: "ii-e",
          productId: "p1",
          boxes: null,
          pieces: null,
          unitLabel: null,
          unitsPerBox: null,
        },
        products: [{ id: "p1", unitsPerBox: 1 }],
      });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 7]]),
        returnedUnit: "PIECES",
        db: prisma,
      });
      expect(prisma.regulatedLedgerParkedReversal.createMany).not.toHaveBeenCalled();
      expect(prisma.regulatedSalesLedger.createMany).toHaveBeenCalledTimes(1);
    });

    it("(f) the same return re-run parks exactly once (createMany skipDuplicates against (returnId, saleEntryId))", async () => {
      const sale = {
        id: "s-f",
        entryType: "SALE",
        tenantId: "t1",
        trackedCategoryId: "cat-A",
        orderId: "ord-1",
        orderItemId: "oi-1",
        invoiceId: "inv-1",
        invoiceItemId: "ii-f",
        qty: 5,
        unitBasisQty: 5,
        netSales: 50,
        categoryTax: 10,
      };
      arrangeParkTest({
        sale,
        item: {
          id: "ii-f",
          productId: "p1",
          boxes: null,
          pieces: null,
          unitLabel: null,
          unitsPerBox: 12,
        },
      });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 12]]),
        returnedUnit: "PIECES",
        db: prisma,
      });
      expect(prisma.regulatedLedgerParkedReversal.createMany).toHaveBeenCalledTimes(1);
      expect(prisma.regulatedLedgerParkedReversal.createMany.mock.calls[0][0].skipDuplicates).toBe(
        true,
      );
    });

    it("(h) a LINE_UNIT (standard) return against the same legacy-shaped row is UNCHANGED — never parked, reverses normally", async () => {
      const sale = {
        id: "s-h",
        entryType: "SALE",
        tenantId: "t1",
        trackedCategoryId: "cat-A",
        orderId: "ord-1",
        orderItemId: "oi-1",
        invoiceId: "inv-1",
        invoiceItemId: "ii-h",
        qty: 5,
        unitBasisQty: 5,
        netSales: 50,
        categoryTax: 10,
      };
      arrangeParkTest({
        sale,
        item: {
          id: "ii-h",
          productId: "p1",
          boxes: null,
          pieces: null,
          unitLabel: null,
          unitsPerBox: 12,
        },
      });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 5]]),
        returnedUnit: "LINE_UNIT", // SA-067(1): the guard is PIECES-branch only
        db: prisma,
      });
      expect(prisma.regulatedLedgerParkedReversal.createMany).not.toHaveBeenCalled();
      expect(prisma.regulatedSalesLedger.createMany).toHaveBeenCalledTimes(1);
      // classifySaleAxis / product / corrections were never even queried for a LINE_UNIT call.
      expect(prisma.product.findMany).not.toHaveBeenCalled();
    });

    // The argument trap the fleet lead asked to be spec'd explicitly: an explicit `null` for
    // productPackNow decides "not boxed" and PASSES; a genuinely OMITTED argument (no product
    // found at all) means "caller doesn't know" and PARKS. Passing null when you mean "I don't
    // know" silently turns a park into a pass — this is the seam most likely to be got backwards.
    it("productPackNow: an explicit null (product found, unitsPerBox null) is NOT boxed → reverses normally, never parks", async () => {
      const sale = {
        id: "s-null",
        entryType: "SALE",
        tenantId: "t1",
        trackedCategoryId: "cat-A",
        orderId: "ord-1",
        orderItemId: "oi-1",
        invoiceId: "inv-1",
        invoiceItemId: "ii-null",
        qty: 5,
        unitBasisQty: 5,
        netSales: 50,
        categoryTax: 10,
      };
      arrangeParkTest({
        sale,
        item: {
          id: "ii-null",
          productId: "p1",
          boxes: null,
          pieces: null,
          unitLabel: null,
          unitsPerBox: null,
        },
        products: [{ id: "p1", unitsPerBox: null }], // product EXISTS, explicitly not boxed
      });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 5]]),
        returnedUnit: "PIECES",
        db: prisma,
      });
      expect(prisma.regulatedLedgerParkedReversal.createMany).not.toHaveBeenCalled();
      expect(prisma.regulatedSalesLedger.createMany).toHaveBeenCalledTimes(1);
    });

    it("productPackNow: product genuinely NOT FOUND (omitted, not null) → parks, never guesses", async () => {
      const sale = {
        id: "s-omit",
        entryType: "SALE",
        tenantId: "t1",
        trackedCategoryId: "cat-A",
        orderId: "ord-1",
        orderItemId: "oi-1",
        invoiceId: "inv-1",
        invoiceItemId: "ii-omit",
        qty: 5,
        unitBasisQty: 5,
        netSales: 50,
        categoryTax: 10,
      };
      arrangeParkTest({
        sale,
        item: {
          id: "ii-omit",
          productId: "p1",
          boxes: null,
          pieces: null,
          unitLabel: null,
          unitsPerBox: null,
        },
        products: [], // product NOT FOUND — packNowByProduct has no entry for "p1" at all
      });
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 5]]),
        returnedUnit: "PIECES",
        db: prisma,
      });
      expect(prisma.regulatedLedgerParkedReversal.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [expect.objectContaining({ reason: "no snapshot and no product to gate on" })],
        }),
      );
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    // SA-070(b) Hazard 1, red-first from the spec verbatim: a SALE(5,5,$50) with a +55-unit
    // correction row, PIECES return of 12 → books -1/-12/-$10 against the ORIGINAL row, the
    // correction row is NEVER a source for the reversal, and the line's remaining unit basis
    // started at 60 (5 + 55) — proven by returning MORE than the un-corrected row's own
    // unitBasisQty(5) without over-reversing.
    it("SA-070(b): a correction row is folded into remaining but never iterated as a candidate SALE row", async () => {
      const original = {
        id: "s-orig",
        entryType: "SALE",
        tenantId: "t1",
        trackedCategoryId: "cat-A",
        orderId: "ord-1",
        orderItemId: "oi-1",
        invoiceId: "inv-1",
        invoiceItemId: "ii-corr",
        qty: 5,
        unitBasisQty: 5,
        netSales: 50,
        categoryTax: 10,
      };
      // The correction row itself: money-neutral (qty 0, net 0), units-only (+55), typed SALE,
      // pointing back at the original via correctsEntryId — exactly B681's own shape.
      const correction = {
        id: "s-corr",
        entryType: "SALE",
        correctsEntryId: "s-orig",
        tenantId: "t1",
        trackedCategoryId: "cat-A",
        orderId: "ord-1",
        orderItemId: "oi-1",
        invoiceId: "inv-1",
        invoiceItemId: "ii-corr",
        qty: 0,
        unitBasisQty: 55,
        netSales: 0,
        categoryTax: 0,
      };
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // prior-reversal idempotency
        .mockResolvedValueOnce([original, correction]) // sales — BOTH rows, as the real query would return
        .mockResolvedValueOnce([]) // priorReversals
        .mockResolvedValueOnce([{ correctsEntryId: "s-orig", qty: 0, unitBasisQty: 55 }]); // loadCorrectionsBySaleId
      prisma.invoiceItem.findMany.mockResolvedValue([
        {
          id: "ii-corr",
          productId: "p1",
          boxes: null,
          pieces: null,
          unitLabel: null,
          unitsPerBox: 12,
        },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "p1", unitsPerBox: 12 }]);
      await service.reverseReturnEntries({
        returnId: "ret-1",
        orderId: "ord-1",
        returnedByProduct: new Map([["p1", 12]]),
        returnedUnit: "PIECES",
        db: prisma,
      });
      // Corrected: effUbq(60) > effQty(5) -> piece-axis, never parked; the classic reversal math
      // proceeds against the ORIGINAL row (s-orig), never the correction row.
      expect(prisma.regulatedLedgerParkedReversal.createMany).not.toHaveBeenCalled();
      const data = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data;
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({
        invoiceItemId: "ii-corr",
        qty: -1, // 12/60 of the ORIGINAL row's own qty(5) — never re-derived from the correction
        unitBasisQty: -12,
        netSales: -10, // 12/60 of $50
        categoryTax: -2, // 12/60 of $10
      });
    });
  });

  describe("unreverseReturnEntries", () => {
    it("deletes the return's REVERSAL rows", async () => {
      await service.unreverseReturnEntries({ returnId: "ret-1", db: prisma });
      expect(prisma.regulatedSalesLedger.deleteMany).toHaveBeenCalledWith({
        where: { returnId: "ret-1", entryType: "REVERSAL" },
      });
    });

    // SA-067(4) / red-first (g): a return this guard parked leaves a RegulatedLedgerParkedReversal
    // row that would otherwise block its period's filing forever once the return is cancelled.
    it("B681/SA-067(4): also deletes the return's UNRESOLVED parked-reversal rows, never a resolved one", async () => {
      await service.unreverseReturnEntries({ returnId: "ret-1", db: prisma });
      expect(prisma.regulatedLedgerParkedReversal.deleteMany).toHaveBeenCalledWith({
        where: { returnId: "ret-1", resolvedAt: null },
      });
    });
  });

  describe("reverseCreditNoteEntries", () => {
    describe("B661 axis: unitBasisQty is PIECES, the credited qty is the line's own unit", () => {
      /** A box-unaware line: 5 boxes at pack 12. B661 books the SALE in PIECES. */
      const boxUnawareSale = (over: Record<string, unknown> = {}) => ({
        entryType: "SALE",
        invoiceItemId: "ii-1",
        orderItemId: "oi-1",
        qty: 5, // the LINE's own unit: 5 boxes
        unitBasisQty: 60, // B661: the piece count the levy is computed on
        netSales: 50,
        categoryTax: 10,
        ...over,
      });
      const armCredit = (lineRows: unknown[], creditItems: unknown[]) => {
        prisma.regulatedSalesLedger.findMany
          .mockResolvedValueOnce([]) // idempotency
          .mockResolvedValueOnce([
            {
              invoiceItemId: "ii-1",
              netSales: 50,
              qty: 5,
              unitBasisQty: 60,
              categoryTax: 10,
              orderId: "ord-1",
              orderItemId: "oi-1",
              invoiceId: "inv-1",
            },
          ]) // live SALE rows
          .mockResolvedValueOnce(lineRows); // SALE + REVERSAL rows for the cap
        prisma.creditNoteItem.findMany.mockResolvedValue(creditItems);
      };
      const booked = () =>
        prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data[0] as Record<string, number>;

      it("MONEY-SHAPE: a FULL credit of a 5-box pack-12 line reverses all 60 PIECES, not 5", async () => {
        // The defect: `unitBasisQty: bookedQty` books the line-unit qty (5) against a SALE row whose
        // unitBasisQty is 60, so the two never cancel and 55 phantom pieces stay on the filing forever.
        armCredit(
          [boxUnawareSale()],
          [
            {
              tenantId: "t1",
              trackedCategoryId: "cat-A",
              invoiceItemId: "ii-1",
              amount: 50, // full credit
              qty: 5,
              categoryTax: 10,
            },
          ],
        );
        await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
        expect(booked()).toMatchObject({ qty: -5, netSales: -50, categoryTax: -10 });
        expect(booked().unitBasisQty).toBe(-60);
      });

      it("a HALF credit reverses half the pieces (30), on the same axis as the SALE", async () => {
        armCredit(
          [boxUnawareSale()],
          [
            {
              tenantId: "t1",
              trackedCategoryId: "cat-A",
              invoiceItemId: "ii-1",
              amount: 25,
              qty: 2.5,
              categoryTax: 5,
            },
          ],
        );
        await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
        expect(booked()).toMatchObject({ qty: -2.5, netSales: -25, categoryTax: -5 });
        expect(booked().unitBasisQty).toBe(-30);
      });

      it("the SECOND half CLOSES the line on the piece axis too: no residue after both credits", async () => {
        // The interesting failure: a partial leaves a residue the closing credit must consume EXACTLY.
        armCredit(
          [
            boxUnawareSale(),
            {
              entryType: "REVERSAL",
              invoiceItemId: "ii-1",
              orderItemId: "oi-1",
              qty: -2.5,
              unitBasisQty: -30,
              netSales: -25,
              categoryTax: -5,
            },
          ],
          [
            {
              tenantId: "t1",
              trackedCategoryId: "cat-A",
              invoiceItemId: "ii-1",
              amount: 25,
              qty: 2.5,
              categoryTax: 5,
            },
          ],
        );
        await service.reverseCreditNoteEntries({ creditNoteId: "cn-2", db: prisma });
        expect(booked()).toMatchObject({ qty: -2.5, netSales: -25, categoryTax: -5 });
        expect(booked().unitBasisQty).toBe(-30);
        // SALE 60 + first credit -30 + this -30 = 0 pieces remaining.
      });

      it("takes the ratio from the CREDITED line's own SALE rows, not the order line's mixed-pack aggregate", async () => {
        // A reconcile rotated the invoice item AFTER the product was repacked 12 -> 10, so the order
        // line carries two SALE rows of different packs (the first already offset by a re-sync
        // reversal). Averaging them gives 110/10 = 11 pieces per box and books -22 for a 2-box credit
        // when the truth is 2 x 10 = -20. The total still closes, so the error is a FILING PERIOD
        // mis-attribution: 2 phantom pieces this period, 2 too few in the closing one.
        prisma.regulatedSalesLedger.findMany
          .mockResolvedValueOnce([]) // idempotency
          .mockResolvedValueOnce([
            {
              invoiceItemId: "ii-2",
              netSales: 30,
              qty: 5,
              unitBasisQty: 50, // the LIVE credited line: pack 10
              categoryTax: 0,
              orderId: "ord-1",
              orderItemId: "oi-1",
              invoiceId: "inv-1",
            },
          ])
          .mockResolvedValueOnce([
            // the pre-reconcile row (pack 12) and its re-sync reversal, plus the live row
            {
              entryType: "SALE",
              invoiceItemId: "ii-1",
              orderItemId: "oi-1",
              qty: 5,
              unitBasisQty: 60,
              netSales: 50,
              categoryTax: 0,
            },
            {
              entryType: "REVERSAL",
              invoiceItemId: "ii-1",
              orderItemId: "oi-1",
              qty: -5,
              unitBasisQty: -60,
              netSales: -50,
              categoryTax: 0,
            },
            {
              entryType: "SALE",
              invoiceItemId: "ii-2",
              orderItemId: "oi-1",
              qty: 5,
              unitBasisQty: 50,
              netSales: 30,
              categoryTax: 0,
            },
          ]);
        prisma.creditNoteItem.findMany.mockResolvedValue([
          {
            tenantId: "t1",
            trackedCategoryId: "cat-A",
            invoiceItemId: "ii-2",
            amount: 12, // a partial: 2 of the 5 boxes
            qty: 2,
            categoryTax: 0,
          },
        ]);
        await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
        expect(booked().unitBasisQty).toBe(-20); // 2 boxes x the CREDITED line's own pack of 10
      });

      it("an ordinary line where qty already IS the piece count is unchanged (unitBasisQty === qty)", async () => {
        armCredit(
          [boxUnawareSale({ qty: 60, unitBasisQty: 60 })],
          [
            {
              tenantId: "t1",
              trackedCategoryId: "cat-A",
              invoiceItemId: "ii-1",
              amount: 50,
              qty: 60,
              categoryTax: 10,
            },
          ],
        );
        await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
        expect(booked().qty).toBe(-60);
        expect(booked().unitBasisQty).toBe(-60);
      });

      it("SA-052 / B687: a money-only credit (CreditNoteItem.qty 0, amount > 0) books qty 0 and unitBasisQty 0; net still moves", async () => {
        // A price adjustment on an otherwise-open line: goods did not come back, so
        // pieces must not move even though net does.
        armCredit(
          [boxUnawareSale()],
          [
            {
              tenantId: "t1",
              trackedCategoryId: "cat-A",
              invoiceItemId: "ii-1",
              amount: 10, // a price adjustment, not a full credit — remaining stays open
              qty: 0,
              categoryTax: 0,
            },
          ],
        );
        await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
        // Math.abs to tolerate -0 (a zero-qty credit naturally negates to -0 in JS;
        // Jest's toMatchObject/toBe distinguish -0 from 0, but the ledger does not).
        expect(Math.abs(booked().qty)).toBe(0);
        expect(Math.abs(booked().unitBasisQty)).toBe(0);
        expect(booked().netSales).toBe(-10);
      });

      it("SA-052 / B687: a prior RETURN of 12 pieces is folded into the remaining unitBasisQty a credit-note close can book", async () => {
        // Same 5-box pack-12 line, but a RETURN already reversed 1 box (12 pieces,
        // $10/$2 tax) before this credit. A full close of the remaining balance must
        // book -48 pieces, not -60 (which would double-count the pieces the return
        // already accounted for).
        armCredit(
          [
            boxUnawareSale(),
            {
              entryType: "REVERSAL",
              invoiceItemId: "ii-1",
              orderItemId: "oi-1",
              qty: -1,
              unitBasisQty: -12,
              netSales: -10,
              categoryTax: -2,
            },
          ],
          [
            {
              tenantId: "t1",
              trackedCategoryId: "cat-A",
              invoiceItemId: "ii-1",
              amount: 40, // exactly the remaining $40 after the $10 return — closes
              qty: 4,
              categoryTax: 8,
            },
          ],
        );
        await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
        expect(booked()).toMatchObject({ qty: -4, netSales: -40, categoryTax: -8 });
        expect(booked().unitBasisQty).toBe(-48);
      });

      it("SA-052 / B687 (case C): unitBasisQty prorates off the GOODS share, never the MONEY share, when the two diverge", async () => {
        // 1 box of a 5-box pack-12 line, credited at $20 of $50 — a money share (0.4)
        // that differs from a goods share (0.2, since 1 box out of 5). No historical
        // code reverts to this shape: it pins against the REFUSED alternative
        // (SA-047), a money-prorated implementation, which would book -24 (60 * 0.4)
        // instead of the correct -12 (60 * 1/5, the goods share).
        armCredit(
          [boxUnawareSale()],
          [
            {
              tenantId: "t1",
              trackedCategoryId: "cat-A",
              invoiceItemId: "ii-1",
              amount: 20, // 0.4 of the $50 SALE — a money share of 0.4
              qty: 1, // 1 of 5 boxes — a goods share of 0.2
              categoryTax: 2,
            },
          ],
        );
        await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
        expect(booked()).toMatchObject({ qty: -1, netSales: -20, categoryTax: -2 });
        expect(booked().unitBasisQty).toBe(-12); // NOT -24 (60 * money share 0.4)
      });
    });

    it("reverses a credited regulated line against its matching SALE row (stamps source ids)", async () => {
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency: none prior for this creditNoteId
        .mockResolvedValueOnce([
          {
            invoiceItemId: "ii-1",
            netSales: 30,
            qty: 3,
            categoryTax: 6,
            orderId: "ord-1",
            orderItemId: "oi-1",
            invoiceId: "inv-1",
          },
        ]) // live SALE rows (meta + existence)
        .mockResolvedValueOnce([
          {
            entryType: "SALE",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: 30,
            qty: 3,
            categoryTax: 6,
          },
        ]); // all order-line rows (SALE + REVERSAL) for the cap
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-1",
          amount: 15, // partial credit of the $30 line
          qty: 1.5,
          categoryTax: 3,
        },
      ]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).toHaveBeenCalledTimes(1);
      expect(prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data[0]).toMatchObject({
        entryType: "REVERSAL",
        creditNoteId: "cn-1",
        trackedCategoryId: "cat-A",
        invoiceItemId: "ii-1",
        orderId: "ord-1", // stamped from the SALE so the return path's cap sees it
        orderItemId: "oi-1",
        invoiceId: "inv-1",
        qty: -1.5,
        netSales: -15,
        categoryTax: -3,
      });
    });

    it("RF-3: carries the live SALE's trackedSubcategoryId onto the credit-note REVERSAL", async () => {
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency
        .mockResolvedValueOnce([
          {
            invoiceItemId: "ii-1",
            netSales: 30,
            qty: 3,
            categoryTax: 0,
            orderId: "ord-1",
            orderItemId: "oi-1",
            invoiceId: "inv-1",
            trackedSubcategoryId: "sub-cig", // reporting breakdown on the live SALE
          },
        ])
        .mockResolvedValueOnce([
          {
            entryType: "SALE",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: 30,
            qty: 3,
            categoryTax: 0,
          },
        ]);
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-1",
          amount: 15,
          qty: 1.5,
          categoryTax: 0,
        },
      ]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data[0]).toMatchObject({
        entryType: "REVERSAL",
        creditNoteId: "cn-1",
        trackedSubcategoryId: "sub-cig", // copied from the SALE row, not the credit item
      });
    });

    it("does NOT book a naked reversal when the credited line has no SALE row", async () => {
      // e.g. a pre-W5 / non-split invoice: CreditNoteItem exists but no SALE was ledgered.
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency
        .mockResolvedValueOnce([]) // SALE rows: NONE
        .mockResolvedValueOnce([]); // prior reversals
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-1",
          amount: 15,
          qty: 1.5,
          categoryTax: 3,
        },
      ]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("clamps so a credit can't reverse more than the line's remaining un-reversed balance", async () => {
      // SALE $30/qty3; a prior return already reversed the whole line (-$30/-3).
      // A $30 credit of the same line must reverse NOTHING (already fully reversed).
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency
        .mockResolvedValueOnce([{ invoiceItemId: "ii-1", netSales: 30, orderItemId: "oi-1" }]) // live SALE
        .mockResolvedValueOnce([
          {
            entryType: "SALE",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: 30,
            qty: 3,
            categoryTax: 0,
          },
          {
            entryType: "REVERSAL",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: -30,
            qty: -3,
            categoryTax: 0,
          },
        ]); // all order-line rows: SALE fully reversed by a prior return
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-1",
          amount: 30,
          qty: 3,
          categoryTax: 0,
        },
      ]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-2", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("clamps WITHIN a batch: two items on the same line can't over-reverse the SALE", async () => {
      // Defense-in-depth for the duplicate-invoiceItemId vector: even if two
      // CreditNoteItems reference the same line, cumulative reversal is capped at the SALE.
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency
        .mockResolvedValueOnce([{ invoiceItemId: "ii-1", netSales: 100, orderItemId: "oi-1" }]) // live SALE
        .mockResolvedValueOnce([
          {
            entryType: "SALE",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: 100,
            qty: 10,
            categoryTax: 0,
          },
        ]); // all order-line rows: SALE, no prior reversals
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-1",
          amount: 100,
          qty: 10,
          categoryTax: 0,
        },
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-1",
          amount: 100,
          qty: 10,
          categoryTax: 0,
        },
      ]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-dup", db: prisma });
      const data = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data;
      const totalNet = data.reduce((s: number, r: any) => s + r.netSales, 0);
      const totalQty = data.reduce((s: number, r: any) => s + r.qty, 0);
      expect(totalNet).toBe(-100); // NOT -200
      expect(totalQty).toBe(-10);
    });

    it("is idempotent — a credit note already reversed writes nothing", async () => {
      prisma.regulatedSalesLedger.findMany.mockResolvedValueOnce([{ id: "existing-rev" }]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("no-ops when the credit note has no regulated items", async () => {
      prisma.regulatedSalesLedger.findMany.mockResolvedValueOnce([]);
      prisma.creditNoteItem.findMany.mockResolvedValue([]); // only non-regulated (filtered out by the query)
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("closing credit books the exact remaining balance (no multi-credit drift)", async () => {
      // SALE net 90; two earlier credits already reversed -60.01; this credit's item
      // is -30 nominal but must CLOSE to -29.99 so the line nets to exactly 0.
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency: none for this creditNoteId
        .mockResolvedValueOnce([{ invoiceItemId: "ii-1", netSales: 90, orderItemId: "oi-1" }]) // live SALE
        .mockResolvedValueOnce([
          {
            entryType: "SALE",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: 90,
            qty: 3,
            categoryTax: 0,
          },
          {
            entryType: "REVERSAL",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: -30.01,
            qty: -1,
            categoryTax: 0,
          },
          {
            entryType: "REVERSAL",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: -30.0,
            qty: -1,
            categoryTax: 0,
          },
        ]); // all order-line rows: SALE + two prior partial credits
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-1",
          amount: 30,
          qty: 1,
          categoryTax: 0,
        },
      ]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-3", db: prisma });
      const row = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data[0];
      expect(row.netSales).toBe(-29.99); // -90 - (-60.01); total across the 3 credits = -90.00
    });

    // A delivered-basis reconcile re-books the credited line's SALE under a fresh
    // invoiceItemId (ii-1 → ii-2) on the same order line (oi-1). The cap keys on
    // orderItemId so a 2nd credit after the reconcile can't re-consume the SALE.
    it("caps a 2nd full credit after a reconcile — SUM floors at 0, not negative", async () => {
      // Ledger: SALE ii-1(+100) → credit cn-1(-100) → resync(-100) → SALE ii-2(+100) = net 0.
      // cn-2 credits the LIVE line (ii-2) in full; it must reverse NOTHING.
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency: none for cn-2
        .mockResolvedValueOnce([
          {
            invoiceItemId: "ii-2",
            netSales: 100,
            orderId: "ord-1",
            orderItemId: "oi-1",
            invoiceId: "inv-1",
          },
        ]) // live SALE
        .mockResolvedValueOnce([
          {
            entryType: "SALE",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: 100,
            qty: 10,
            categoryTax: 0,
          },
          {
            entryType: "REVERSAL",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: -100,
            qty: -10,
            categoryTax: 0,
          },
          {
            entryType: "REVERSAL",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: -100,
            qty: -10,
            categoryTax: 0,
          },
          {
            entryType: "SALE",
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            netSales: 100,
            qty: 10,
            categoryTax: 0,
          },
        ]); // all order-line rows
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-2",
          amount: 100,
          qty: 10,
          categoryTax: 0,
        },
      ]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-2", db: prisma });
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("still books a VALID partial credit after a reconcile (cap survives item recreation)", async () => {
      // SALE ii-1(+100) → credit cn-1 of 3(-30) → resync(-100) → SALE ii-2(+100): net 7 / $70.
      // cn-2 credits 4 units / $40 (total 70 ≤ 100) — valid, books -40 / -4 on the live line.
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency
        .mockResolvedValueOnce([
          {
            invoiceItemId: "ii-2",
            netSales: 100,
            orderId: "ord-1",
            orderItemId: "oi-1",
            invoiceId: "inv-1",
          },
        ]) // live SALE
        .mockResolvedValueOnce([
          {
            entryType: "SALE",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: 100,
            qty: 10,
            categoryTax: 0,
          },
          {
            entryType: "REVERSAL",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: -30,
            qty: -3,
            categoryTax: 0,
          },
          {
            entryType: "REVERSAL",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: -100,
            qty: -10,
            categoryTax: 0,
          },
          {
            entryType: "SALE",
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            netSales: 100,
            qty: 10,
            categoryTax: 0,
          },
        ]);
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-2",
          amount: 40,
          qty: 4,
          categoryTax: 0,
        },
      ]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-2", db: prisma });
      const row = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data[0];
      expect(row).toMatchObject({ netSales: -40, qty: -4 });
    });

    it("floors a 2nd over-credit after a reconcile at the line's remaining (never negative)", async () => {
      // After a partial credit of $30 + reconcile, $70 remains. A 2nd credit of $100 books
      // only -70 / -7 (closing the line to exactly 0), not -100.
      prisma.regulatedSalesLedger.findMany
        .mockResolvedValueOnce([]) // idempotency
        .mockResolvedValueOnce([
          {
            invoiceItemId: "ii-2",
            netSales: 100,
            orderId: "ord-1",
            orderItemId: "oi-1",
            invoiceId: "inv-1",
          },
        ]) // live SALE
        .mockResolvedValueOnce([
          {
            entryType: "SALE",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: 100,
            qty: 10,
            categoryTax: 0,
          },
          {
            entryType: "REVERSAL",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: -30,
            qty: -3,
            categoryTax: 0,
          },
          {
            entryType: "REVERSAL",
            invoiceItemId: "ii-1",
            orderItemId: "oi-1",
            netSales: -100,
            qty: -10,
            categoryTax: 0,
          },
          {
            entryType: "SALE",
            invoiceItemId: "ii-2",
            orderItemId: "oi-1",
            netSales: 100,
            qty: 10,
            categoryTax: 0,
          },
        ]);
      prisma.creditNoteItem.findMany.mockResolvedValue([
        {
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          invoiceItemId: "ii-2",
          amount: 100,
          qty: 10,
          categoryTax: 0,
        },
      ]);
      await service.reverseCreditNoteEntries({ creditNoteId: "cn-2", db: prisma });
      const row = prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data[0];
      expect(row).toMatchObject({ netSales: -70, qty: -7 });
    });

    it("unreverseCreditNoteEntries deletes the credit note's REVERSAL rows", async () => {
      await service.unreverseCreditNoteEntries({ creditNoteId: "cn-1", db: prisma });
      expect(prisma.regulatedSalesLedger.deleteMany).toHaveBeenCalledWith({
        where: { creditNoteId: "cn-1", entryType: "REVERSAL" },
      });
    });
  });

  // SA-089 — B660 PR B: the operator resolution of ONE parked reversal row. Query-inspecting
  // mocks (not ordered mockResolvedValueOnce chains) because resolveParkedReversal's own call
  // sequence differs from reverseReturnEntries' — findFirst by saleEntryId, not a findMany
  // sweep — and a legacy verdict inserts a correction row and re-reads corrections mid-call.
  describe("resolveParkedReversal — SA-089", () => {
    let saleRows: any[];
    let invoiceItems: any[];
    let priorReversals: any[];
    let createdRows: any[];

    const saleRow = (over: Record<string, unknown> = {}) => ({
      id: "s-1",
      tenantId: "t1",
      trackedCategoryId: "cat-A",
      trackedSubcategoryId: null,
      entryType: "SALE",
      orderId: "ord-1",
      orderItemId: "oi-1",
      invoiceId: "inv-1",
      invoiceItemId: "ii-1",
      correctsEntryId: null,
      qty: 5, // selling units (boxes) — a box-unaware, unsplit line
      unitBasisQty: 5, // legacy: stored as a straight copy of qty (the pre-B661 defect)
      netSales: 50,
      categoryTax: 10,
      soldAt: new Date("2026-07-01T00:00:00Z"),
      ...over,
    });

    const invoiceItem = (over: Record<string, unknown> = {}) => ({
      id: "ii-1",
      productId: "p1",
      boxes: null,
      pieces: null,
      unitLabel: null,
      unitsPerBox: null, // box-unaware: no split, no snapshot — exactly why it parked
      ...over,
    });

    const parked = (over: Record<string, unknown> = {}) => ({
      returnId: "ret-1",
      orderId: "ord-1",
      orderItemId: "oi-1",
      saleEntryId: "s-1",
      returnedPieces: 5,
      ...over,
    });

    beforeEach(() => {
      saleRows = [saleRow()];
      invoiceItems = [invoiceItem()];
      priorReversals = [];
      createdRows = [];

      prisma.regulatedSalesLedger.findFirst.mockImplementation(
        async ({ where }: any) => saleRows.find((s) => s.id === where.id) ?? null,
      );
      prisma.regulatedSalesLedger.findMany.mockImplementation(async ({ where }: any) => {
        if (where?.correctsEntryId?.in) {
          return saleRows.filter(
            (s) =>
              s.correctsEntryId != null && where.correctsEntryId.in.includes(s.correctsEntryId),
          );
        }
        if (where?.orderId != null && where?.entryType === "SALE") {
          return saleRows.filter((s) => s.orderId === where.orderId);
        }
        if (where?.OR && where?.entryType === "REVERSAL") {
          // SA-167(2): the restatement selects by the balance builder's own line key.
          return priorReversals.filter((r) =>
            where.OR.some((c: any) =>
              c.invoiceItemId?.in
                ? c.invoiceItemId.in.includes(r.invoiceItemId)
                : c.orderItemId === r.orderItemId,
            ),
          );
        }
        if (where?.invoiceItemId?.in && where?.entryType === "REVERSAL") {
          return priorReversals.filter((r) => where.invoiceItemId.in.includes(r.invoiceItemId));
        }
        return [];
      });
      prisma.regulatedSalesLedger.create.mockImplementation(async ({ data }: any) => {
        const row = { id: `created-${createdRows.length + 1}`, ...data };
        createdRows.push(row);
        saleRows.push(row); // a correction row is itself typed SALE — visible to later reads
        return row;
      });
      prisma.invoiceItem.findMany.mockImplementation(async ({ where }: any) =>
        invoiceItems.filter((i) => where.id.in.includes(i.id)),
      );
      prisma.orderItem.findMany.mockResolvedValue([]);
    });

    const corrections = () => createdRows.filter((r) => r.correctsEntryId != null);
    // A REAL, newly-booked reversal, never a REVERSAL-typed correction row (SA-089a(b) restates
    // an earlier box-axis reversal with its OWN correction, also entryType REVERSAL but
    // correctsEntryId-tagged — see `corrections()` above for those).
    const reversals = () =>
      createdRows.filter((r) => r.entryType === "REVERSAL" && r.correctsEntryId == null);

    it("legacy row + pack 12: appends ONE correction row (+11*qty basis), then books the REVERSAL of min(returned, remaining)", async () => {
      // The line sold 5 selling-units at pack 12 = 60 TRUE pieces (post-correction). Returning
      // all 60 (a full return of the line) closes it — netSales/categoryTax book the exact
      // remaining, not a pro-rated share. returnedPieces is in PIECES (the return's own known
      // quantity), never the pre-pack "5" — conflating the two axes is exactly the class of
      // bug this whole guard exists to prevent.
      const result = await service.resolveParkedReversal(
        prisma,
        parked({ returnedPieces: 60 }),
        12,
      );

      expect(corrections()).toHaveLength(1);
      expect(corrections()[0]).toMatchObject({
        entryType: "SALE",
        correctsEntryId: "s-1",
        orderItemId: "oi-1",
        invoiceItemId: "ii-1",
        qty: 0,
        unitBasisQty: 55, // 5 * (12 - 1)
        netSales: 0,
        categoryTax: 0,
      });

      // Full line remaining (60 corrected pieces, no prior reversal): the reversal books the
      // WHOLE thing, closing the line.
      expect(reversals()).toHaveLength(1);
      expect(reversals()[0]).toMatchObject({
        entryType: "REVERSAL",
        orderItemId: "oi-1",
        invoiceItemId: "ii-1",
        netSales: -50,
        categoryTax: -10,
      });
      expect(result.outcome).toBe("booked");
      // Opus LOW: verdictAfter is the POST-correction verdict — this row was legacy before the
      // fix landed, but reads piece-axis now that it has (proves the restatement actually took).
      expect(result.verdictAfter).toBe("piece-axis");
      expect(result.correctionEntryId).toBe(corrections()[0].id);
      expect(result.resolvedEntryId).toBe(reversals()[0].id);
    });

    it("legacy row + pack 12, a PARTIAL return (5 of the 60 corrected pieces): pro-rates 5/60 of the line, never the full amount", async () => {
      const result = await service.resolveParkedReversal(prisma, parked({ returnedPieces: 5 }), 12);
      expect(result.outcome).toBe("booked");
      // 5/60 of $50 = $4.17, 5/60 of $10 tax = $0.83 — never the full $50/$10 a pre-fix
      // conflation of "5 selling units" with "5 pieces" would have booked.
      expect(reversals()[0].netSales).toBeCloseTo(-4.17, 2);
      expect(reversals()[0].categoryTax).toBeCloseTo(-0.83, 2);
      expect(reversals()[0].netSales).not.toBe(-50);
    });

    it("piece-axis after the pack: NO correction row — the row already holds pieces, books directly", async () => {
      // unitBasisQty already > qty (60 vs 5) — already the pieces axis, nothing to correct.
      saleRows = [saleRow({ unitBasisQty: 60 })];
      const result = await service.resolveParkedReversal(prisma, parked(), 12);

      expect(corrections()).toHaveLength(0);
      expect(reversals()).toHaveLength(1);
      expect(result.outcome).toBe("booked");
      expect(result.verdictAfter).toBe("piece-axis");
      expect(result.correctionEntryId).toBeNull();
    });

    it("unknown after the pack: refuses — no correction row, no reversal row, still parked", async () => {
      // unitBasisQty (3) < qty (5) even after folding the supplied pack in: classifySaleAxis's
      // own "malformed" branch — never silently treated as either axis.
      saleRows = [saleRow({ unitBasisQty: 3 })];
      const result = await service.resolveParkedReversal(prisma, parked(), 12);

      expect(result.outcome).toBe("unresolvable");
      expect(result.unresolvableReason).toMatch(/unitBasisQty is less than qty/);
      expect(corrections()).toHaveLength(0);
      expect(reversals()).toHaveLength(0);
    });

    it("remaining shrunk since parking (a later credit note reversed part of the line): books the CAPPED amount, not the original returnedPieces", async () => {
      // The line sold 60 pieces (post-pack); a credit note already reversed 50 of them, so only
      // 10 remain. The parked row still says 5 pieces returned — well under the 10 remaining,
      // so this specific case books the full 5. Prove the CAP itself with a bigger request.
      priorReversals = [
        {
          invoiceItemId: "ii-1",
          orderItemId: "oi-1",
          qty: -1,
          unitBasisQty: -50,
          netSales: -45,
          categoryTax: -9,
        },
      ];
      const result = await service.resolveParkedReversal(
        prisma,
        parked({ returnedPieces: 20 }),
        12,
      );

      // Only 10 pieces remained (60 - 50); the requested 20 is capped there, not booked in full.
      // SA-167: the 10 that could not be booked are REPORTED (a bare "booked" never hides them).
      expect(result.outcome).toBe("partial");
      expect(result.unbookedPieces).toBe(10);
      expect(result.bookedPieces).toBe(10);
      expect(result.bookedPieces).not.toBe(20);
    });

    it("SA-089a(a) / SA error E50 fix: fully voided BEFORE any correction — nothing written on that row (not even the SALE correction); leftover pieces are reported as partial", async () => {
      // The prior fixture here (unitBasisQty: -60 against a still-legacy qty:5 sale) was
      // IMPOSSIBLE: a reversal booked LINE_UNIT against a sale that was never yet corrected can
      // only be box-denominated (|unitBasisQty| == |qty|), never already piece-denominated. The
      // real box-axis reversal for "all 5 boxes already returned" is qty:-5/unitBasisQty:-5.
      priorReversals = [
        {
          invoiceItemId: "ii-1",
          orderItemId: "oi-1",
          qty: -5,
          unitBasisQty: -5,
          netSales: -50,
          categoryTax: -10,
        },
      ];
      const result = await service.resolveParkedReversal(prisma, parked(), 12);

      // SA-193: nothing was written, but the returned pieces that no row could take are REPORTED —
      // a leftover is never hidden behind "closed".
      expect(result.outcome).toBe("partial");
      expect(result.unbookedPieces).toBeGreaterThan(0);
      expect(result.resolvedEntryId).toBeNull();
      expect(result.bookedPieces).toBe(0);
      expect(reversals()).toHaveLength(0);
      // E50: the old code decided "closed" only AFTER unconditionally writing the SALE's
      // +qty*(pack-1) correction, manufacturing Σr*(pack-1) phantom units on an
      // already-fully-reversed line (a voided 5-box line at pack 12 read +50 instead of 0).
      // SA-089a(a): closed is decided on the box axis FIRST, so a truly voided line writes
      // NOTHING — no SALE correction, no reversal correction, no REVERSAL row.
      expect(corrections()).toHaveLength(0);
      expect(result.verdictAfter).toBe("legacy"); // unchanged: nothing was corrected
    });

    it("SA-089a(b) worked example (ii): restates BOTH the SALE and an earlier box-axis reversal — SALE +55, reversal correction −22, remaining 36, booked −24, line ends at 12", async () => {
      // 2 of the 5 boxes already returned LINE_UNIT against the still-legacy sale — box-axis
      // (|unitBasisQty| == |qty| == 2), same worked example the shared cross-lane fixture
      // (parked-reversal-correction.fixture.ts's buildCorrectionCase) uses.
      priorReversals = [
        {
          id: "r-prior-1",
          tenantId: "t1",
          trackedCategoryId: "cat-A",
          trackedSubcategoryId: null,
          orderId: "ord-1",
          invoiceId: "inv-1",
          invoiceItemId: "ii-1",
          orderItemId: "oi-1",
          correctsEntryId: null,
          qty: -2,
          unitBasisQty: -2,
          netSales: -20,
          categoryTax: -4,
          soldAt: new Date("2026-08-01T00:00:00Z"),
        },
      ];
      const result = await service.resolveParkedReversal(
        prisma,
        parked({ returnedPieces: 24 }),
        12,
      );

      expect(corrections()).toHaveLength(2);
      const saleCorrection = corrections().find((c) => c.entryType === "SALE");
      const reversalCorrection = corrections().find((c) => c.entryType === "REVERSAL");
      expect(saleCorrection).toMatchObject({ correctsEntryId: "s-1", unitBasisQty: 55 });
      // The reversal correction points at the PRIOR reversal's own id, never at the sale.
      expect(reversalCorrection).toMatchObject({
        correctsEntryId: "r-prior-1",
        unitBasisQty: -22,
      });
      // E50's bug would have left remaining at qty*pack - Σr = 58 and booked -24 against that —
      // the fix's remaining is (qty-Σr)*pack = 36.
      expect(result.outcome).toBe("booked");
      expect(result.bookedPieces).toBe(24);
      expect(reversals()).toHaveLength(1);
      expect(reversals()[0]).toMatchObject({ unitBasisQty: -24 });
      // Line ends at 12 (36 remaining - 24 booked) — not directly asserted here (that's the
      // NEXT call's remaining, proven by the shared cross-lane fixture's real-Postgres spec),
      // but 36 - 24 = 12 is exactly SA-089a(ii)'s own worked figure.
      expect(result.verdictAfter).toBe("piece-axis");
    });

    it("SA-070 hazard 2: after the correction row lands, the SAME sale row re-classifies as piece-axis — a second resolution attempt on it would never re-park", async () => {
      await service.resolveParkedReversal(prisma, parked(), 12);
      expect(corrections()).toHaveLength(1);

      // Simulate the classifier being asked about this row again later (e.g. a subsequent
      // return on the same line) — it must now read piece-axis on its own, corrections and all,
      // never legacy/unknown again.
      const corrected = saleRows.find((s) => s.id === "s-1");
      const verdict = classifySaleAxis(
        {
          entryType: corrected.entryType,
          qty: corrected.qty,
          unitBasisQty: corrected.unitBasisQty,
        },
        { boxes: null, pieces: null, unitLabel: null, unitsPerBox: 12 },
        corrections().map((c) => ({ qty: c.qty, unitBasisQty: c.unitBasisQty })),
        12,
      );
      expect(verdict.state).toBe("piece-axis");
    });

    it("no line at all (deleted invoice item, no order item): the supplied pack stands in as the WHOLE shape, never an unconditional unknown", async () => {
      invoiceItems = []; // the line resolves to null — loadSaleLineShapes finds nothing
      const result = await service.resolveParkedReversal(prisma, parked(), 12);

      // With no line, the ONLY shape info is the supplied pack itself — boxed, no split, no
      // label — so the classify proceeds exactly as a box-unaware line would, not an immediate
      // "unknown: no line to read a shape from" refusal.
      expect(result.outcome).toBe("booked");
      // Opus LOW: verdictAfter is the POST-correction verdict — piece-axis once restated.
      expect(result.verdictAfter).toBe("piece-axis");
    });

    it("a pack of 1 resolves a line that was never really boxed: piece-axis directly, no correction", async () => {
      const result = await service.resolveParkedReversal(prisma, parked(), 1);
      expect(result.verdictAfter).toBe("piece-axis");
      expect(corrections()).toHaveLength(0);
      expect(result.outcome).toBe("booked");
    });
  });

  // ─── B662: a price change on an ISSUED invoice books an append-only correction row ───
  describe("correctSaleForPriceChange (B662)", () => {
    // 6 boxes of 12 (72 pieces) at $40/box: SALE qty 72, net $240, category tax $60.
    const sale = (over: Record<string, unknown> = {}) => ({
      id: "sale-1",
      tenantId: "t1",
      trackedCategoryId: "cat-A",
      trackedSubcategoryId: "sub-1",
      entryType: "SALE",
      orderId: "ord-1",
      orderItemId: "oi-1",
      invoiceId: "inv-1",
      invoiceItemId: "ii-1",
      qty: 72,
      unitBasisQty: 72,
      netSales: 240,
      categoryTax: 60,
      soldAt: new Date("2026-08-15T00:00:00Z"),
      createdAt: new Date("2026-08-15T00:00:00Z"),
      correctsEntryId: null,
      returnId: null,
      ...over,
    });
    const line = (over: Record<string, unknown> = {}) => ({
      invoiceItemId: "ii-1",
      qty: 72,
      netSales: 300, // re-priced: $50/box
      categoryTax: 75,
      boxes: 6,
      unitsPerBox: 12,
      promoFreeUnits: null,
      ...over,
    });
    const run = (rows: unknown[], lines: any[]) => {
      prisma.regulatedSalesLedger.findMany.mockResolvedValue(rows);
      prisma.regulatedSalesLedger.createMany.mockClear();
      return service.correctSaleForPriceChange({ invoiceId: "inv-1", lines, db: prisma });
    };
    const rows = () => prisma.regulatedSalesLedger.createMany.mock.calls[0][0].data;

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      jest.setSystemTime(new Date("2026-09-21T15:00:00.000Z"));
    });
    afterEach(() => jest.useRealTimers());

    it("an INCREASE books one SALE-type correction: signed deltas, qty 0, both new columns, current period", async () => {
      expect(await run([sale()], [line()])).toBe(1);
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toEqual({
        tenantId: "t1",
        trackedCategoryId: "cat-A",
        trackedSubcategoryId: "sub-1",
        entryType: "SALE",
        orderId: "ord-1",
        orderItemId: "oi-1",
        invoiceId: "inv-1",
        invoiceItemId: "ii-1",
        qty: 0,
        unitBasisQty: 0,
        netSales: 60, // 300 - 240
        categoryTax: 15, // 75 - 60
        soldAt: new Date("2026-09-21T15:00:00.000Z"), // never backdated
        originalSoldAt: new Date("2026-08-15T00:00:00Z"), // the sale date it corrects
        correctsEntryId: "sale-1",
        periodBucket: "2026-09", // the CURRENT month, not the sale's
      });
    });

    it("a DECREASE books a REVERSAL-type correction with negative deltas", async () => {
      await run([sale()], [line({ netSales: 180, categoryTax: 45 })]);
      expect(rows()[0]).toMatchObject({
        entryType: "REVERSAL",
        netSales: -60,
        categoryTax: -15,
        qty: 0,
        correctsEntryId: "sale-1",
      });
    });

    it("is IDEMPOTENT: repeating the same adjustment (the correction is now held) writes nothing", async () => {
      const correction = sale({
        id: "corr-1",
        qty: 0,
        unitBasisQty: 0,
        netSales: 60,
        categoryTax: 15,
        correctsEntryId: "sale-1",
      });
      expect(await run([sale(), correction], [line()])).toBe(0);
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("a second, different adjustment corrects only the difference and still points at the ORIGINAL sale", async () => {
      const correction = sale({
        id: "corr-1",
        qty: 0,
        unitBasisQty: 0,
        netSales: 60,
        categoryTax: 15,
        correctsEntryId: "sale-1",
      });
      await run([sale(), correction], [line({ netSales: 330, categoryTax: 82.5 })]);
      expect(rows()[0]).toMatchObject({
        entryType: "SALE",
        netSales: 30, // 330 - (240 + 60)
        categoryTax: 7.5,
        correctsEntryId: "sale-1", // never the earlier correction
      });
    });

    it("PARTIAL RETURN in between: the TARGET is the new subtotal prorated to the qty still held", async () => {
      // 12 pieces (1 box) came back at the OLD price: reversal qty -12, net -40, tax -10.
      const returned = sale({
        id: "rev-1",
        entryType: "REVERSAL",
        qty: -12,
        unitBasisQty: -12,
        netSales: -40,
        categoryTax: -10,
        returnId: "ret-1",
      });
      await run([sale(), returned], [line()]);
      // held: qty 60 net 200 tax 50. target = 300 x 60/72 = 250 -> +50; tax 75 x 60/72 = 62.5 -> +12.5
      expect(rows()[0]).toMatchObject({ entryType: "SALE", netSales: 50, categoryTax: 12.5 });
      // repeating it is a no-op: the correction now brings the held net to the target exactly
      const applied = sale({
        id: "corr-1",
        qty: 0,
        unitBasisQty: 0,
        netSales: 50,
        categoryTax: 12.5,
        correctsEntryId: "sale-1",
      });
      expect(await run([sale(), returned, applied], [line()])).toBe(0);
    });

    it("B894/SA-576: the target is the pricing package's LINEAR slice — free units do not bend it", async () => {
      const held = [sale({ netSales: 200, categoryTax: 50 })];
      const l = line({ promoFreeUnits: 1, netSales: 250, categoryTax: 62.5 });
      await run(held, [l]);
      // full qty held: the whole new figure, verbatim
      expect(creditedThrough(250, 72, 72)).toBe(250);
      expect(rows()[0]).toMatchObject({ netSales: 50, categoryTax: 12.5 });
      // and priceCorrectionTarget IS that helper — the same slice rule as a return credit — whatever the free units / split
      expect(priceCorrectionTarget(250, 60, l)).toBe(creditedThrough(250, 60, 72));
      const noSplit = { ...l, boxes: null };
      expect(priceCorrectionTarget(250, 60, noSplit)).toBe(208.33);
    });

    it("skips a line with no live SALE, a fully returned line, and rounding noise", async () => {
      expect(await run([], [line()])).toBe(0); // never booked
      const fullyReturned = sale({
        id: "rev-1",
        entryType: "REVERSAL",
        qty: -72,
        unitBasisQty: -72,
        netSales: -240,
        categoryTax: -60,
        returnId: "ret-1",
      });
      expect(await run([sale(), fullyReturned], [line()])).toBe(0);
      expect(await run([sale()], [line({ netSales: 240.004, categoryTax: 60.003 })])).toBe(0);
      expect(prisma.regulatedSalesLedger.createMany).not.toHaveBeenCalled();
    });

    it("writes one row per changed line, none for an unchanged one, and one query for all of them", async () => {
      const second = sale({ id: "sale-2", invoiceItemId: "ii-2", orderItemId: "oi-2" });
      await run(
        [sale(), second],
        [line(), line({ invoiceItemId: "ii-2", netSales: 240, categoryTax: 60 })],
      );
      expect(rows()).toHaveLength(1);
      expect(rows()[0].invoiceItemId).toBe("ii-1");
      expect(prisma.regulatedSalesLedger.findMany).toHaveBeenCalledTimes(1);
    });

    it("no lines: no query, no rows", async () => {
      prisma.regulatedSalesLedger.findMany.mockClear();
      expect(
        await service.correctSaleForPriceChange({ invoiceId: "inv-1", lines: [], db: prisma }),
      ).toBe(0);
      expect(prisma.regulatedSalesLedger.findMany).not.toHaveBeenCalled();
    });

    it("update()'s re-sync reverses the NET the ledger holds: the SALE plus every correction pointing at it", async () => {
      const correction = sale({
        id: "corr-1",
        qty: 0,
        unitBasisQty: 0,
        netSales: 60,
        categoryTax: 15,
        correctsEntryId: "sale-1",
      });
      prisma.regulatedSalesLedger.findMany.mockResolvedValue([sale(), correction]);
      prisma.regulatedSalesLedger.createMany.mockClear();
      await service.reverseInvoiceEntries({
        invoiceId: "inv-1",
        db: prisma,
        preserveReturns: true,
      });
      // 240 + 60 = 300 net, 60 + 15 = 75 tax: reversed in full, so a draft re-sync cannot double count
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        entryType: "REVERSAL",
        invoiceItemId: "ii-1",
        qty: -72,
        netSales: -300,
        categoryTax: -75,
      });
    });
  });
});
