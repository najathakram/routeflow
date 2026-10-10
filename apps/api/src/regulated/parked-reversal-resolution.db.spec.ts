/**
 * SA-089a (amends SA-089, SA error E50) / SA-134 (SA error E51) — real-Postgres proof of
 * `ParkedReversalResolutionService.resolve()` / `RegulatedLedgerService.resolveParkedReversal`
 * for a legacy (box-axis) line, through the REAL service + REAL Postgres row locks (Return, then
 * Order), not a mocked Prisma client. `regulated-ledger.service.spec.ts`'s mocked suite already pins the same
 * formulas at the unit level (`resolveParkedReversal — SA-089` describe block) — this file
 * proves the same money math survives the real DB round-trip AND the real `Return`/`Order`
 * `FOR UPDATE` row locks (SA-089a(c), SA-170), which a mock can't exercise.
 *
 * Scenarios, per SA-089a's own worked examples:
 *  (i)   legacy fully voided (nothing returned) -> closed, zero rows written, filing unaffected.
 *  (ii)  legacy 5 boxes, 2 already returned LINE_UNIT, resolved at pack 12 with 24 pieces
 *        requested -> SALE +55, ONE reversal correction -22, remaining 36, booked -24, line
 *        ends at 12. Uses the SAME shared cross-lane fixture
 *        (`parked-reversal-correction.fixture.ts`'s `buildCorrectionCase`) #1246/B681's
 *        backfill script also consumes, and pins this live path writes BYTE-IDENTICAL
 *        correction rows to what that fixture expects.
 *  (iii) a fractional box count (a credit-note-ratio-shaped prior reversal) -> a fractional
 *        correction, same formula.
 *  (iv)  after (ii), the SALE re-classifies as piece-axis on its own -> a LATER return against
 *        the same line does not park again (SA-070 hazard 2, through the real classifier).
 *  (v)   two concurrent resolve() calls on parked rows sharing ONE order serialize on the
 *        Order row lock -> the second's booking sees the first's correction already
 *        applied, never a lost update.
 * Plus the two SA-089 pins still missing from the branch:
 *  - cancel-after-resolve: the booked REVERSAL is gone, the parked row stays resolved (its
 *    resolvedEntryId now dangles — the Opus LOW this file also documents), the corrections
 *    (which carry no returnId) survive.
 *  - `listParkedReversals`/`assertNoParkedReversals` (the filing gate's own reader) refuses
 *    while parked, passes once resolved — the real-Postgres proof of the existing mocked pin
 *    in `regulated-filing-gate.spec.ts`.
 *
 * WHY THE DB LANE: SA-089a(c)/SA-170's locks are REAL `SELECT ... FOR UPDATE` row locks taken
 * inside the resolution's own transaction — a mocked Prisma client cannot exercise a genuine
 * two-connection race, only real Postgres can. Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via
 * `npm run local:test:db`.
 *
 * SAFETY: a throwaway `qa-parkres-<run>` tenant (`assertTestTenant`); `afterAll` deletes exactly
 * the rows this run created, in FK order.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { ParkedReversalResolutionService } from "./parked-reversal-resolution.service";
import { listParkedReversals, assertNoParkedReversals } from "./parked-reversals";
import { buildCorrectionCase } from "./parked-reversal-correction.fixture";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "Real-Postgres — ParkedReversalResolutionService.resolve() (SA-089a legacy-line correction)",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let ledger: RegulatedLedgerService;
    let svc: ParkedReversalResolutionService;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-parkres-${run}`, "parked-reversal-resolution.db.spec.ts");
    let tenantId = "";
    let categoryId = "";
    let userId = "";
    let customerId = "";
    const orderIds: string[] = [];
    const invoiceIds: string[] = [];
    const productIds: string[] = [];
    const periodBucket = new Date().toISOString().slice(0, 7);

    interface SeedResult {
      orderId: string;
      orderItemId: string;
      invoiceId: string;
      invoiceItemId: string;
      productId: string;
      saleId: string;
      reversalId: string | null;
      returnId: string;
      parkedRowId: string;
    }

    /**
     * One legacy (box-axis) SALE row — `qty`/`unitBasisQty` both the box count, the pre-B661
     * defect shape — optionally with ONE prior box-axis reversal already booked LINE_UNIT
     * against it (`priorReversalBoxes`, |unitBasisQty| == |qty|), and a `Return` +
     * `RegulatedLedgerParkedReversal` row ready for `resolve()` to act on.
     */
    async function seedLegacyLine(
      tag: string,
      opts: {
        qty: number;
        netSales: number;
        categoryTax: number;
        priorReversalBoxes?: number;
        priorReversalNet?: number;
        priorReversalTax?: number;
        returnedPieces: number;
        returnStatus?: "RECEIVED" | "CANCELLED";
        /** The live product's box size. Default null (the single-row cases resolve on the operator's
         *  pack); a multi-row case needs a live pack so the OTHER rows classify legacy (not
         *  non-boxed-now) and park instead of booking their box count as pieces. */
        livePack?: number;
      },
    ): Promise<SeedResult> {
      const product = await raw.product.create({
        data: {
          name: `${tag} product`,
          unit: "box",
          pricePerUnit: "10.00",
          unitsPerBox: opts.livePack ?? null, // legacy: no live pack snapshot either — exactly why it parked
          trackedCategoryId: categoryId,
          tenantId,
        },
      });
      productIds.push(product.id);
      const order = await raw.order.create({
        data: {
          customerId,
          status: "DELIVERED",
          subtotal: String(opts.netSales),
          total: String(opts.netSales + opts.categoryTax),
          tenantId,
        },
      });
      orderIds.push(order.id);
      const orderItem = await raw.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          status: "DELIVERED",
          qty: opts.qty,
          unitPrice: String(opts.netSales / opts.qty),
          subtotal: String(opts.netSales),
          categoryTaxAmount: String(opts.categoryTax),
          trackedCategoryId: categoryId,
          tenantId,
        },
      });
      const invoice = await raw.invoice.create({
        data: {
          invoiceNumber: `INV-PARKRES-${run}-${tag}`,
          customerId,
          orderId: order.id,
          status: "SENT",
          subtotal: String(opts.netSales),
          taxAmount: String(opts.categoryTax),
          total: String(opts.netSales + opts.categoryTax),
          tenantId,
        },
      });
      invoiceIds.push(invoice.id);
      const invoiceItem = await raw.invoiceItem.create({
        data: {
          invoiceId: invoice.id,
          description: `${tag} product`,
          productId: product.id,
          orderItemId: orderItem.id,
          qty: opts.qty,
          unitPrice: String(opts.netSales / opts.qty),
          subtotal: String(opts.netSales),
          categoryTaxAmount: String(opts.categoryTax),
          trackedCategoryId: categoryId,
          tenantId,
        },
      });
      const sale = await raw.regulatedSalesLedger.create({
        data: {
          tenantId,
          trackedCategoryId: categoryId,
          entryType: "SALE",
          orderId: order.id,
          orderItemId: orderItem.id,
          invoiceId: invoice.id,
          invoiceItemId: invoiceItem.id,
          qty: opts.qty,
          unitBasisQty: opts.qty, // legacy: straight copy of qty, the pre-B661 defect
          netSales: opts.netSales,
          categoryTax: opts.categoryTax,
          soldAt: new Date("2026-07-01T00:00:00Z"),
          periodBucket: "2026-07",
        },
      });

      let reversalId: string | null = null;
      if (opts.priorReversalBoxes) {
        const reversal = await raw.regulatedSalesLedger.create({
          data: {
            tenantId,
            trackedCategoryId: categoryId,
            entryType: "REVERSAL",
            orderId: order.id,
            orderItemId: orderItem.id,
            invoiceId: invoice.id,
            invoiceItemId: invoiceItem.id,
            returnId: `ret-prior-${tag}`, // a DIFFERENT, already-settled return — not this test's
            qty: -opts.priorReversalBoxes,
            unitBasisQty: -opts.priorReversalBoxes, // box-axis: |unitBasisQty| == |qty|
            netSales: -(opts.priorReversalNet ?? 0),
            categoryTax: -(opts.priorReversalTax ?? 0),
            soldAt: new Date("2026-08-01T00:00:00Z"),
            periodBucket: "2026-08",
          },
        });
        reversalId = reversal.id;
      }

      const ret = await raw.return.create({
        data: {
          orderId: order.id,
          customerId,
          reason: "EXCESS_ORDER",
          status: opts.returnStatus ?? "RECEIVED",
          tenantId,
        },
      });

      const parkedRow = await raw.regulatedLedgerParkedReversal.create({
        data: {
          tenantId,
          returnId: ret.id,
          orderId: order.id,
          orderItemId: orderItem.id,
          saleEntryId: sale.id,
          returnedPieces: opts.returnedPieces,
          reason: "no live pack snapshot",
          periodBucket,
        },
      });

      return {
        orderId: order.id,
        orderItemId: orderItem.id,
        invoiceId: invoice.id,
        invoiceItemId: invoiceItem.id,
        productId: product.id,
        saleId: sale.id,
        reversalId,
        returnId: ret.id,
        parkedRowId: parkedRow.id,
      };
    }

    async function resolveAs(parkedRowId: string, pack: number, reason = "operator confirmed") {
      return tenantCtx.run(tenantId, () => svc.resolve(parkedRowId, pack, reason, { id: userId }));
    }

    /**
     * A SECOND live sale row of the SAME product on the SAME order as an already-seeded legacy line —
     * its own order line, invoice item and SALE row. `legacy: false` stores it piece-axis
     * (`unitBasisQty` = qty * pack), so it is classifiable without a resolution of its own.
     */
    async function addSecondRow(
      f: SeedResult,
      opts: { qty: number; netSales: number; categoryTax: number; legacy: boolean; pack?: number },
    ) {
      const orderItem = await raw.orderItem.create({
        data: {
          orderId: f.orderId,
          productId: f.productId,
          status: "DELIVERED",
          qty: opts.qty,
          unitPrice: String(opts.netSales / opts.qty),
          subtotal: String(opts.netSales),
          categoryTaxAmount: String(opts.categoryTax),
          trackedCategoryId: categoryId,
          tenantId,
        },
      });
      const invoiceItem = await raw.invoiceItem.create({
        data: {
          invoiceId: f.invoiceId,
          description: "second row",
          productId: f.productId,
          orderItemId: orderItem.id,
          qty: opts.qty,
          unitPrice: String(opts.netSales / opts.qty),
          subtotal: String(opts.netSales),
          categoryTaxAmount: String(opts.categoryTax),
          trackedCategoryId: categoryId,
          tenantId,
        },
      });
      const sale = await raw.regulatedSalesLedger.create({
        data: {
          tenantId,
          trackedCategoryId: categoryId,
          entryType: "SALE",
          orderId: f.orderId,
          orderItemId: orderItem.id,
          invoiceId: f.invoiceId,
          invoiceItemId: invoiceItem.id,
          qty: opts.qty,
          unitBasisQty: opts.legacy ? opts.qty : opts.qty * (opts.pack ?? 12),
          netSales: opts.netSales,
          categoryTax: opts.categoryTax,
          soldAt: new Date("2026-07-02T00:00:00Z"),
          periodBucket: "2026-07",
        },
      });
      return { orderItemId: orderItem.id, saleId: sale.id };
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();

      ledger = new RegulatedLedgerService(prisma);
      // Object.create bypasses Nest DI (mirrors return-reversal-unit-axis.db.spec.ts) — audit
      // logging isn't what this file proves, so it's stubbed; prisma/ledger are the REAL,
      // connected instances, so resolve() runs its real transaction and its real row locks.
      svc = Object.assign(Object.create(ParkedReversalResolutionService.prototype), {
        prisma,
        ledger,
      });

      tenantId = (await raw.tenant.create({ data: { slug, name: `Park Res ${slug}` } })).id;
      categoryId = (
        await raw.trackedCategory.create({
          data: { name: "Tobacco", taxType: "NONE", tenantId },
        })
      ).id;
      const user = await raw.user.create({
        data: {
          email: `op-${run}@example.test`,
          username: `op-${run}`,
          role: "OPERATOR",
          tenantId,
        },
      });
      userId = user.id;
      const custUser = await raw.user.create({
        data: {
          email: `cust-${run}@example.test`,
          username: `cust-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      const customer = await raw.customer.create({
        data: {
          userId: custUser.id,
          businessName: "Park Res Co",
          contactName: "Park Res Co",
          tenantId,
        },
      });
      customerId = customer.id;
    }, 120_000);

    afterAll(async () => {
      // the resolution now writes a REAL in-tx audit row per resolve (#2108)
      await raw.auditLog.deleteMany({ where: { tenantId } });
      await raw.regulatedLedgerParkedReversal.deleteMany({ where: { tenantId } });
      await raw.regulatedSalesLedger.deleteMany({ where: { tenantId } });
      for (const orderId of orderIds) {
        await raw.return.deleteMany({ where: { orderId } });
      }
      await raw.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.product.deleteMany({ where: { id: { in: productIds } } });
      await raw.customer.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.trackedCategory.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    it("(i) legacy fully voided, nothing returned -> closed, zero rows written, filing unchanged", async () => {
      const f = await seedLegacyLine("voided", {
        qty: 5,
        netSales: 50,
        categoryTax: 10,
        priorReversalBoxes: 5,
        priorReversalNet: 50,
        priorReversalTax: 10,
        returnedPieces: 0,
      });

      const result = await resolveAs(f.parkedRowId, 12);
      expect(result.outcome).toBe("closed");
      expect(result.resolvedEntryId).toBeNull();

      const rows = await raw.regulatedSalesLedger.findMany({
        where: { orderItemId: f.orderItemId },
      });
      // Exactly the two seeded rows (the original SALE + the prior REVERSAL) — nothing added.
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.correctsEntryId == null)).toBe(true);
    }, 30_000);

    it("(ii) SA-089a(b) worked example, byte-identical to the shared cross-lane fixture: SALE +55, reversal correction -22, remaining 36, booked -24, line ends at 12", async () => {
      const now = new Date();
      const expectedCase = buildCorrectionCase(now);

      const f = await seedLegacyLine("worked-ii", {
        qty: 5,
        netSales: 50,
        categoryTax: 10,
        priorReversalBoxes: 2,
        priorReversalNet: 20,
        priorReversalTax: 4,
        returnedPieces: 24,
      });

      const result = await resolveAs(f.parkedRowId, 12);
      expect(result.outcome).toBe("booked");
      expect(result.bookedPieces).toBe(24);
      expect(result.verdictAfter).toBe("piece-axis");

      const corrections = await raw.regulatedSalesLedger.findMany({
        where: { orderItemId: f.orderItemId, correctsEntryId: { not: null } },
        orderBy: { entryType: "asc" }, // REVERSAL before SALE alphabetically — asserted by type below, not order
      });
      expect(corrections).toHaveLength(2);
      const saleCorrection = corrections.find((c) => c.entryType === "SALE")!;
      const reversalCorrection = corrections.find((c) => c.entryType === "REVERSAL")!;

      expect(saleCorrection.correctsEntryId).toBe(f.saleId);
      expect(Number(saleCorrection.unitBasisQty)).toBe(
        expectedCase.expected.saleCorrectionUnitBasisQty,
      );
      expect(Number(saleCorrection.qty)).toBe(0);
      expect(Number(saleCorrection.netSales)).toBe(0);
      expect(Number(saleCorrection.categoryTax)).toBe(0);

      expect(reversalCorrection.correctsEntryId).toBe(f.reversalId);
      expect(Number(reversalCorrection.unitBasisQty)).toBe(
        expectedCase.expected.reversalCorrectionUnitBasisQty,
      );
      expect(Number(reversalCorrection.qty)).toBe(0);
      expect(Number(reversalCorrection.netSales)).toBe(0);
      expect(Number(reversalCorrection.categoryTax)).toBe(0);

      // The booked reversal itself: -24 pieces, matching remaining 36 capped at nothing (24 < 36).
      const booked = await raw.regulatedSalesLedger.findFirst({
        where: { id: result.resolvedEntryId! },
      });
      expect(Number(booked!.unitBasisQty)).toBe(-expectedCase.expected.bookedPieces);

      // The line's ending balance: Σ unitBasisQty across every row on the line now equals
      // -(SA-089a's own "line ends at 12" figure) short of exactly 0 — i.e. remaining is 12.
      const allRows = await raw.regulatedSalesLedger.findMany({
        where: { orderItemId: f.orderItemId },
      });
      const netUnitBasis = allRows.reduce((s, r) => s + Number(r.unitBasisQty), 0);
      expect(netUnitBasis).toBe(expectedCase.expected.lineEndingBalance);
    }, 30_000);

    it("(iii) a fractional prior box count (credit-note-ratio shape) produces a fractional correction, same formula", async () => {
      // 0.5 "boxes" already reversed (a credit note prorated at ratio 0.5 of one box) — SA-089a:
      // "a fractional credit-note ratio gives a fractional r".
      const f = await seedLegacyLine("fractional", {
        qty: 5,
        netSales: 50,
        categoryTax: 10,
        priorReversalBoxes: 0.5,
        priorReversalNet: 5,
        priorReversalTax: 1,
        returnedPieces: 6,
      });

      const result = await resolveAs(f.parkedRowId, 12);
      expect(result.outcome).toBe("booked");

      const reversalCorrection = await raw.regulatedSalesLedger.findFirst({
        where: { orderItemId: f.orderItemId, entryType: "REVERSAL", correctsEntryId: f.reversalId },
      });
      expect(reversalCorrection).not.toBeNull();
      // -|0.5| * (12-1) = -5.5
      expect(Number(reversalCorrection!.unitBasisQty)).toBeCloseTo(-5.5, 3);

      // remaining = (5 - 0.5) * 12 = 54; booked = min(6, 54) = 6.
      expect(result.bookedPieces).toBe(6);
    }, 30_000);

    it("(iv) hazard 2 through the real classifier: after (ii)'s resolution, the SAME sale reads piece-axis, and a LATER return on it does not park again", async () => {
      const f = await seedLegacyLine("hazard2", {
        qty: 5,
        netSales: 50,
        categoryTax: 10,
        priorReversalBoxes: 2,
        priorReversalNet: 20,
        priorReversalTax: 4,
        returnedPieces: 24,
      });
      await resolveAs(f.parkedRowId, 12);

      // A SECOND, independent parked row against the SAME sale entry (a later return finding
      // the same legacy-shaped sale) — resolving it again must NOT re-park as unknown/legacy;
      // it must read piece-axis directly and book against the TRUE remaining (12 pieces left).
      const laterReturn = await raw.return.create({
        data: {
          orderId: f.orderId,
          customerId,
          reason: "EXCESS_ORDER",
          status: "RECEIVED",
          tenantId,
        },
      });
      const laterParked = await raw.regulatedLedgerParkedReversal.create({
        data: {
          tenantId,
          returnId: laterReturn.id,
          orderId: f.orderId,
          orderItemId: f.orderItemId,
          saleEntryId: f.saleId,
          returnedPieces: 12,
          reason: "no live pack snapshot",
          periodBucket,
        },
      });

      const result2 = await resolveAs(laterParked.id, 12);
      expect(result2.outcome).toBe("booked");
      expect(result2.verdictAfter).toBe("piece-axis");
      expect(result2.bookedPieces).toBe(12);
      // No THIRD correction was written — the sale and its one prior reversal were already
      // corrected once; the SA-070 hazard-2 idempotency fold means this call adds none.
      const corrections = await raw.regulatedSalesLedger.findMany({
        where: { orderItemId: f.orderItemId, correctsEntryId: { not: null } },
      });
      expect(corrections).toHaveLength(2);
    }, 30_000);

    it("(v) SA-089b: a live create()-shaped Order lock and a resolution on the SAME order serialize on the Order row; the second sees the first's remaining", async () => {
      // A second line on the order the resolution will act on — the "live create" side holds
      // the Order FOR UPDATE and books a reversal against THIS second line (the exact shape
      // inline-returns.service.ts's capture() takes: Order FOR UPDATE, then a regulated-ledger
      // write) while the resolution races it for the SAME row lock on the SAME order. A second,
      // fully-wired InlineReturnsService is out of scope for this pin — the property under test
      // is the Postgres lock semantics (two transactions serializing on one Order row), which a
      // faithful hand-rolled transaction proves identically to the real service call.
      const f = await seedLegacyLine("concurrent-lock", {
        qty: 5,
        netSales: 50,
        categoryTax: 10,
        returnedPieces: 60,
      });
      const sibling = await raw.product.create({
        data: { name: "sibling", unit: "each", pricePerUnit: "5.00", tenantId },
      });
      productIds.push(sibling.id);

      const order: string[] = [];
      const liveCreate = pool.connect().then(async (client) => {
        try {
          await client.query("BEGIN");
          order.push("live:locked-start");
          await client.query('SELECT id FROM "Order" WHERE id = $1 FOR UPDATE', [f.orderId]);
          order.push("live:locked");
          // Hold the lock briefly so the resolution's own FOR UPDATE genuinely queues behind it.
          await new Promise((r) => setTimeout(r, 200));
          await client.query(
            'INSERT INTO "RegulatedSalesLedger" (id, "tenantId", "trackedCategoryId", "entryType", "orderId", qty, "unitBasisQty", "netSales", "categoryTax", "soldAt", "periodBucket") VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, now(), $9)',
            [tenantId, categoryId, "SALE", f.orderId, 1, 1, 5, 0, periodBucket],
          );
          order.push("live:committed");
          await client.query("COMMIT");
        } finally {
          client.release();
        }
      });
      const resolution = (async () => {
        // Give the live side a head start acquiring the lock first.
        await new Promise((r) => setTimeout(r, 50));
        order.push("resolve:start");
        const result = await resolveAs(f.parkedRowId, 12);
        order.push("resolve:done");
        return result;
      })();

      const [, resolveResult] = await Promise.all([liveCreate, resolution]);

      expect(resolveResult.outcome).toBe("booked");
      // The live transaction's lock-then-commit fully finished BEFORE the resolution's own
      // read-then-book started making progress past its own lock acquisition — i.e. they did
      // not interleave freely; the resolution's work waited on the live side's commit.
      expect(order.indexOf("live:committed")).toBeLessThan(order.indexOf("resolve:done"));

      const rows = await raw.regulatedSalesLedger.findMany({ where: { orderId: f.orderId } });
      // The live side's extra SALE row is visible — proves the resolution ran its
      // buildLineRemainingBalances AFTER the live transaction committed, never against a
      // snapshot from before it (both share one order; a stale read would be silently
      // consistent regardless, but a real serialization failure would show as this row
      // being invisible to a resolution that started concurrently and read too early).
      expect(rows.some((r) => r.orderId === f.orderId && Number(r.qty) === 1)).toBe(true);
    }, 30_000);

    it.each([
      ["a live pack of 12", 12],
      ["NO live pack (product un-boxed after the sale)", undefined],
    ])(
      "SA-167 (a)/SA-173: two legacy rows (2 and 3 boxes at 12), 60 pieces parked on row 1, product with %s: resolving row 1 books 24 and parks 36 on row 2; resolving that books 36; every piece is reversed",
      async (_label, livePack) => {
        const f = await seedLegacyLine(`walk-a-${livePack ?? "null"}`, {
          qty: 2,
          netSales: 20,
          categoryTax: 4,
          returnedPieces: 60,
          livePack,
        });
        const second = await addSecondRow(f, {
          qty: 3,
          netSales: 30,
          categoryTax: 6,
          legacy: true,
        });

        const first = await resolveAs(f.parkedRowId, 12);
        expect(first.outcome).toBe("partial");
        expect(first.bookedPieces).toBe(24);
        expect(first.parkedPieces).toBe(36);
        expect(first.unbookedPieces).toBe(0);
        expect(first.parkedRowIds).toHaveLength(1);

        const newParked = await raw.regulatedLedgerParkedReversal.findMany({
          where: { returnId: f.returnId, saleEntryId: second.saleId },
        });
        expect(newParked).toHaveLength(1);
        expect(Number(newParked[0].returnedPieces)).toBe(36);
        expect(newParked[0].resolvedAt).toBeNull();

        const next = await resolveAs(newParked[0].id, 12);
        expect(next.outcome).toBe("booked");
        expect(next.bookedPieces).toBe(36);
        expect(next.parkedPieces).toBe(0);

        const rows = await raw.regulatedSalesLedger.findMany({ where: { orderId: f.orderId } });
        const sum = (
          pred: (r: (typeof rows)[number]) => boolean,
          field: "unitBasisQty" | "netSales",
        ) => rows.filter(pred).reduce((acc, r) => acc + Number(r[field]), 0);
        expect(
          sum((r) => r.entryType === "REVERSAL" && r.correctsEntryId == null, "unitBasisQty"),
        ).toBe(-60);
        // The whole order nets to zero in pieces and in money.
        expect(sum(() => true, "unitBasisQty")).toBe(0);
        expect(sum(() => true, "netSales")).toBeCloseTo(0, 2);
      },
      30_000,
    );

    it("SA-169 (d): the first row's line already fully reversed: nothing on row 1, the 36 pieces are booked on row 2, outcome booked", async () => {
      const f = await seedLegacyLine("walk-d", {
        qty: 2,
        netSales: 20,
        categoryTax: 4,
        priorReversalBoxes: 2,
        priorReversalNet: 20,
        priorReversalTax: 4,
        returnedPieces: 36,
      });
      const second = await addSecondRow(f, {
        qty: 3,
        netSales: 30,
        categoryTax: 6,
        legacy: false,
        pack: 12,
      });

      const res = await resolveAs(f.parkedRowId, 12);
      expect(res.outcome).toBe("booked");
      expect(res.correctionEntryId).toBeNull();
      expect(res.bookedPieces).toBe(36);

      const onRow1 = await raw.regulatedSalesLedger.findMany({
        where: { orderItemId: f.orderItemId, correctsEntryId: { not: null } },
      });
      expect(onRow1).toHaveLength(0); // no correction, no reversal on the already-closed row
      const onRow2 = await raw.regulatedSalesLedger.findMany({
        where: { orderItemId: second.orderItemId, entryType: "REVERSAL" },
      });
      expect(onRow2).toHaveLength(1);
      expect(Number(onRow2[0].unitBasisQty)).toBe(-36);
    }, 30_000);

    it("SA-170: a CANCELLED return cannot be resolved (404) and nothing is claimed or booked", async () => {
      const f = await seedLegacyLine("walk-cancelled", {
        qty: 5,
        netSales: 50,
        categoryTax: 10,
        returnedPieces: 60,
        returnStatus: "CANCELLED",
      });
      await expect(resolveAs(f.parkedRowId, 12)).rejects.toThrow(/not found/i);
      const row = await raw.regulatedLedgerParkedReversal.findFirst({
        where: { id: f.parkedRowId },
      });
      expect(row!.resolvedAt).toBeNull();
      const booked = await raw.regulatedSalesLedger.findMany({
        where: { orderId: f.orderId, entryType: "REVERSAL", returnId: f.returnId },
      });
      expect(booked).toHaveLength(0);
    }, 30_000);

    it("Opus (#1324): the claim stamps resolvedReason / unitsPerBoxSupplied / resolvedById / resolvedAt / resolvedEntryId on the ROW itself, read back from Postgres", async () => {
      const f = await seedLegacyLine("stamp", {
        qty: 5,
        netSales: 50,
        categoryTax: 10,
        returnedPieces: 60,
      });
      const result = await resolveAs(f.parkedRowId, 12, "confirmed the case size on the invoice");
      expect(result.outcome).toBe("booked");
      const row = await raw.regulatedLedgerParkedReversal.findFirst({
        where: { id: f.parkedRowId },
      });
      expect(row!.resolvedReason).toBe("confirmed the case size on the invoice");
      expect(row!.unitsPerBoxSupplied).toBe(12);
      expect(row!.resolvedById).toBe(userId);
      expect(row!.resolvedAt).not.toBeNull();
      expect(row!.resolvedEntryId).toBe(result.resolvedEntryId);
    }, 30_000);

    it("Opus (#1324): an UNRESOLVABLE verdict throws 409 and ROLLS BACK the claim — the row stays unresolved with no reason stamped and nothing written", async () => {
      const f = await seedLegacyLine("rollback", {
        qty: 5,
        netSales: 50,
        categoryTax: 10,
        returnedPieces: 60,
      });
      // unitBasisQty below qty: even after the supplied pack the classifier reads it malformed.
      await raw.regulatedSalesLedger.update({ where: { id: f.saleId }, data: { unitBasisQty: 3 } });

      await expect(resolveAs(f.parkedRowId, 12, "trying a pack")).rejects.toMatchObject({
        response: { code: "PARKED_REVERSAL_UNRESOLVABLE" },
      });

      const row = await raw.regulatedLedgerParkedReversal.findFirst({
        where: { id: f.parkedRowId },
      });
      expect(row!.resolvedAt).toBeNull();
      expect(row!.resolvedReason).toBeNull();
      expect(row!.unitsPerBoxSupplied).toBeNull();
      const written = await raw.regulatedSalesLedger.findMany({
        where: {
          orderId: f.orderId,
          OR: [{ entryType: "REVERSAL" }, { correctsEntryId: { not: null } }],
        },
      });
      expect(
        written.filter((r) => r.returnId === f.returnId || r.correctsEntryId != null),
      ).toHaveLength(0);
    }, 30_000);

    it("Opus (#1324): list() returns the tenant's UNRESOLVED parked reversals, oldest first, and drops a resolved one", async () => {
      const open = await seedLegacyLine("list-open", {
        qty: 5,
        netSales: 50,
        categoryTax: 10,
        returnedPieces: 60,
      });
      const done = await seedLegacyLine("list-done", {
        qty: 5,
        netSales: 50,
        categoryTax: 10,
        returnedPieces: 60,
      });
      await resolveAs(done.parkedRowId, 12);
      const listed = await tenantCtx.run(tenantId, () => svc.list());
      const ids = (listed as any[]).map((r) => r.id);
      expect(ids).toContain(open.parkedRowId);
      expect(ids).not.toContain(done.parkedRowId);
      const created = (listed as any[]).map((r) => new Date(r.createdAt).getTime());
      expect(created).toEqual([...created].sort((a, b) => a - b));
    }, 30_000);

    it("SA-182 / #2081 (Opus): a park backdated to month M and resolved in M+1 books the REVERSAL in M (the period the gate held open), the axis corrections in M+1, and M's gate then passes with the reversal included", async () => {
      const now = new Date();
      const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12, 0, 0));
      const M = prev.toISOString().slice(0, 7);
      const current = now.toISOString().slice(0, 7);
      expect(M).not.toBe(current);

      const f = await seedLegacyLine("backdated", {
        qty: 5,
        netSales: 50,
        categoryTax: 10,
        priorReversalBoxes: 2,
        priorReversalNet: 20,
        priorReversalTax: 4,
        returnedPieces: 36,
      });
      // The park happened in M: its own bucket and the return's date.
      await raw.regulatedLedgerParkedReversal.update({
        where: { id: f.parkedRowId },
        data: { periodBucket: M, createdAt: prev },
      });

      const before = await listParkedReversals(prisma.forTenant(), {
        trackedCategoryId: categoryId,
        buckets: [M],
      });
      expect(before.filter((p) => p.id === f.parkedRowId)).toHaveLength(1); // M held open

      const result = await resolveAs(f.parkedRowId, 12);
      expect(result.outcome).toBe("booked");
      expect(result.amendedPeriod).toBeNull();

      const reversal = await raw.regulatedSalesLedger.findFirst({
        where: { id: result.resolvedEntryId! },
      });
      expect(reversal!.periodBucket).toBe(M);
      expect(reversal!.soldAt.toISOString()).toBe(prev.toISOString());

      // The axis-restatement rows are booked NOW (SA-134), each pointing back at the original.
      const corrections = await raw.regulatedSalesLedger.findMany({
        where: { orderItemId: f.orderItemId, correctsEntryId: { not: null } },
      });
      expect(corrections.length).toBeGreaterThan(0);
      for (const c of corrections) expect(c.periodBucket).toBe(current);

      // M's gate passes once resolved, and the reversal sits in M's rows.
      const after = await listParkedReversals(prisma.forTenant(), {
        trackedCategoryId: categoryId,
        buckets: [M],
      });
      expect(after.filter((p) => p.id === f.parkedRowId)).toHaveLength(0);
      expect(() =>
        assertNoParkedReversals(
          after.filter((p) => p.id === f.parkedRowId),
          { categoryName: "Tobacco", periodKey: M },
        ),
      ).not.toThrow();
      const inM = await raw.regulatedSalesLedger.findMany({
        where: {
          orderId: f.orderId,
          periodBucket: M,
          entryType: "REVERSAL",
          correctsEntryId: null,
        },
      });
      expect(inM.map((r) => r.id)).toContain(result.resolvedEntryId);
    }, 30_000);

    /** A sibling park for the SAME return on a second row of the seeded order. */
    async function parkSecondRow(
      f: SeedResult,
      second: { orderItemId: string; saleId: string },
      returnedPieces: number,
    ) {
      return raw.regulatedLedgerParkedReversal.create({
        data: {
          tenantId,
          returnId: f.returnId,
          orderId: f.orderId,
          orderItemId: second.orderItemId,
          saleEntryId: second.saleId,
          returnedPieces,
          reason: "no live pack snapshot",
          periodBucket,
        },
      });
    }

    it("SA-193 attest-resolved: a leftover reaching a row whose park THIS return already resolved (pack 1) BOOKS there as pieces; nothing re-parked, the resolved row untouched", async () => {
      const f = await seedLegacyLine("attest", {
        qty: 22,
        netSales: 220,
        categoryTax: 44,
        returnedPieces: 22,
        livePack: 12,
      });
      const second = await addSecondRow(f, { qty: 3, netSales: 30, categoryTax: 6, legacy: true });
      const p2 = await parkSecondRow(f, second, 58);
      await raw.regulatedLedgerParkedReversal.update({
        where: { id: f.parkedRowId },
        data: { resolvedAt: new Date(), resolvedById: userId, unitsPerBoxSupplied: 1 },
      });

      const res = await resolveAs(p2.id, 12);
      expect(res.outcome).toBe("booked");
      expect(res.bookedPieces).toBe(58); // 36 on the second row + 22 on the attested first row
      expect(res.parkedPieces).toBe(0);
      expect(res.unbookedPieces).toBe(0);

      const onRow1 = await raw.regulatedSalesLedger.findMany({
        where: {
          orderItemId: f.orderItemId,
          entryType: "REVERSAL",
          correctsEntryId: null,
          returnId: f.returnId,
        },
      });
      expect(onRow1.map((r) => Number(r.unitBasisQty))).toEqual([-22]);
      const parks = await raw.regulatedLedgerParkedReversal.findMany({
        where: { returnId: f.returnId },
      });
      expect(parks).toHaveLength(2); // no third key was minted
      expect(parks.find((p) => p.id === f.parkedRowId)!.resolvedAt).not.toBeNull(); // never re-opened
    }, 30_000);

    it("SA-193 grow-unresolved: a leftover reaching a row with an UNRESOLVED park adds to that park's returnedPieces (no second key), and the park stays open", async () => {
      const f = await seedLegacyLine("grow", {
        qty: 22,
        netSales: 220,
        categoryTax: 44,
        returnedPieces: 10,
        livePack: 12,
      });
      const second = await addSecondRow(f, { qty: 3, netSales: 30, categoryTax: 6, legacy: true });
      const p2 = await parkSecondRow(f, second, 58);

      const res = await resolveAs(p2.id, 12);
      expect(res.outcome).toBe("partial");
      expect(res.parkedPieces).toBe(22);
      expect(res.grownParks).toEqual([{ id: f.parkedRowId, added: 22 }]);

      const parks = await raw.regulatedLedgerParkedReversal.findMany({
        where: { returnId: f.returnId },
      });
      expect(parks).toHaveLength(2);
      const grown = parks.find((p) => p.id === f.parkedRowId)!;
      expect(Number(grown.returnedPieces)).toBe(32);
      expect(grown.resolvedAt).toBeNull(); // the filing gate still holds
    }, 30_000);

    it("SA-193 filed leftover: a leftover from a park in an already-FILED period keeps the original date and month; resolved later it books in the CURRENT period with originalSoldAt and amendedPeriod", async () => {
      const now = new Date();
      const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12, 0, 0));
      const M = prev.toISOString().slice(0, 7);
      const current = now.toISOString().slice(0, 7);
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

      const f = await seedLegacyLine("filed-leftover", {
        qty: 2,
        netSales: 20,
        categoryTax: 4,
        returnedPieces: 60,
        livePack: 12,
      });
      const second = await addSecondRow(f, { qty: 3, netSales: 30, categoryTax: 6, legacy: true });
      await raw.regulatedLedgerParkedReversal.update({
        where: { id: f.parkedRowId },
        data: { periodBucket: M, createdAt: prev },
      });
      await raw.regulatedFiling.create({
        data: {
          tenantId,
          trackedCategoryId: categoryId,
          reportTemplate: "generic",
          periodKey: M,
          periodStart: start,
          periodEnd: end,
          rows: [],
        },
      });
      try {
        const first = await resolveAs(f.parkedRowId, 12);
        expect(first.outcome).toBe("partial");
        expect(first.amendedPeriod).toMatchObject({ periodKey: M });
        const booked = await raw.regulatedSalesLedger.findFirst({
          where: { id: first.resolvedEntryId! },
        });
        expect(booked!.periodBucket).toBe(current);
        expect(booked!.originalSoldAt!.toISOString()).toBe(prev.toISOString());

        // the leftover park carries the ORIGINAL date and month, not the current ones
        const leftover = await raw.regulatedLedgerParkedReversal.findFirst({
          where: { returnId: f.returnId, saleEntryId: second.saleId },
        });
        expect(leftover!.periodBucket).toBe(M);
        expect(leftover!.createdAt.toISOString()).toBe(prev.toISOString());
        expect(Number(leftover!.returnedPieces)).toBe(36);

        const next = await resolveAs(leftover!.id, 12);
        expect(next.outcome).toBe("booked");
        expect(next.amendedPeriod).toMatchObject({ periodKey: M });
        const later = await raw.regulatedSalesLedger.findFirst({
          where: { id: next.resolvedEntryId! },
        });
        expect(later!.periodBucket).toBe(current);
        expect(later!.originalSoldAt!.toISOString()).toBe(prev.toISOString());
      } finally {
        await raw.regulatedFiling.deleteMany({ where: { tenantId } });
      }
    }, 30_000);

    it("cancel-after-resolve: the booked REVERSAL is gone, the parked row stays resolved (resolvedEntryId dangles), the corrections survive", async () => {
      const f = await seedLegacyLine("cancel-after", {
        qty: 5,
        netSales: 50,
        categoryTax: 10,
        priorReversalBoxes: 2,
        priorReversalNet: 20,
        priorReversalTax: 4,
        returnedPieces: 24,
      });
      const result = await resolveAs(f.parkedRowId, 12);
      expect(result.outcome).toBe("booked");
      const resolvedEntryId = result.resolvedEntryId!;

      await tenantCtx.run(tenantId, () =>
        ledger.unreverseReturnEntries({ returnId: f.returnId, db: prisma.forTenant() }),
      );

      const bookedReversal = await raw.regulatedSalesLedger.findFirst({
        where: { id: resolvedEntryId },
      });
      expect(bookedReversal).toBeNull(); // gone

      const parkedRow = await raw.regulatedLedgerParkedReversal.findFirst({
        where: { id: f.parkedRowId },
      });
      expect(parkedRow!.resolvedAt).not.toBeNull(); // still resolved
      expect(parkedRow!.resolvedEntryId).toBe(resolvedEntryId); // dangles — points at the row just deleted

      const corrections = await raw.regulatedSalesLedger.findMany({
        where: { orderItemId: f.orderItemId, correctsEntryId: { not: null } },
      });
      expect(corrections).toHaveLength(2); // both restatements survive — neither carries a returnId
    }, 30_000);

    it("the filing gate's own reader refuses while parked, passes once resolved", async () => {
      const f = await seedLegacyLine("filing-gate", {
        qty: 5,
        netSales: 50,
        categoryTax: 10,
        returnedPieces: 60,
      });

      const before = await listParkedReversals(prisma.forTenant(), {
        trackedCategoryId: categoryId,
        buckets: [periodBucket],
      });
      const beforeForThisRow = before.filter((p) => p.id === f.parkedRowId);
      expect(beforeForThisRow).toHaveLength(1);
      expect(() =>
        assertNoParkedReversals(beforeForThisRow, {
          categoryName: "Tobacco",
          periodKey: periodBucket,
        }),
      ).toThrow(/PARKED_REVERSALS_UNRESOLVED|parked/i);

      await resolveAs(f.parkedRowId, 12);

      const after = await listParkedReversals(prisma.forTenant(), {
        trackedCategoryId: categoryId,
        buckets: [periodBucket],
      });
      expect(after.some((p) => p.id === f.parkedRowId)).toBe(false);
      expect(() =>
        assertNoParkedReversals(
          after.filter((p) => p.id === f.parkedRowId),
          { categoryName: "Tobacco", periodKey: periodBucket },
        ),
      ).not.toThrow();
    }, 30_000);
  },
);
