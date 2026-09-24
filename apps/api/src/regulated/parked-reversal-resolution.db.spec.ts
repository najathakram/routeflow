/**
 * SA-089a (amends SA-089, SA error E50) / SA-134 (SA error E51) — real-Postgres proof of
 * `ParkedReversalResolutionService.resolve()` / `RegulatedLedgerService.resolveParkedReversal`
 * for a legacy (box-axis) line, through the REAL service + REAL advisory lock, not a mocked
 * Prisma client. `regulated-ledger.service.spec.ts`'s mocked suite already pins the same
 * formulas at the unit level (`resolveParkedReversal — SA-089` describe block) — this file
 * proves the same money math survives the real DB round-trip AND the real order-keyed
 * `order-merge` advisory lock (SA-089a(c)), which a mock can't exercise.
 *
 * Scenarios, per SA-089a's own worked examples:
 *  (i)   legacy fully voided -> CLOSES, zero rows written, filing unaffected.
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
 *        order-keyed advisory lock -> the second's booking sees the first's correction already
 *        applied, never a lost update.
 * Plus the two SA-089 pins still missing from the branch:
 *  - cancel-after-resolve: the booked REVERSAL is gone, the parked row stays resolved (its
 *    resolvedEntryId now dangles — the Opus LOW this file also documents), the corrections
 *    (which carry no returnId) survive.
 *  - `listParkedReversals`/`assertNoParkedReversals` (the filing gate's own reader) refuses
 *    while parked, passes once resolved — the real-Postgres proof of the existing mocked pin
 *    in `regulated-filing-gate.spec.ts`.
 *
 * WHY THE DB LANE: SA-089a(c)'s lock is a REAL `pg_advisory_lock` on a dedicated connection
 * (`common/db-locks.ts`) — a mocked Prisma client cannot exercise a genuine two-connection race,
 * only real Postgres can. Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via
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
      },
    ): Promise<SeedResult> {
      const product = await raw.product.create({
        data: {
          name: `${tag} product`,
          unit: "box",
          pricePerUnit: "10.00",
          unitsPerBox: null, // legacy: no live pack snapshot either — exactly why it parked
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

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();

      ledger = new RegulatedLedgerService(prisma);
      // Object.create bypasses Nest DI (mirrors return-reversal-unit-axis.db.spec.ts) — audit
      // logging isn't what this file proves, so it's stubbed; prisma/ledger are the REAL,
      // connected instances, so resolve() runs its real transaction and its real advisory lock.
      svc = Object.assign(Object.create(ParkedReversalResolutionService.prototype), {
        prisma,
        audit: { log: async () => undefined },
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

    it("(i) legacy fully voided -> CLOSES, zero rows written, filing unchanged", async () => {
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
