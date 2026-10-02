/**
 * B687 (#1709) — a return reversal and a credit-note reversal COMPOSE on one order line.
 *
 * #1221 (return axis) and #1219 (credit note) were each proven red-first on their own, but no test
 * booked BOTH kinds of reversal against the SAME order line. The reviewer accepted that on a
 * structural argument (the per-order-line remaining balance is source-agnostic and additive, so the
 * two net correctly by construction). This turns that argument into an executable proof: it books
 * one regulated SALE, applies a partial return AND a partial credit note to the same line, in both
 * orders, and asserts every intermediate row and the per-line remaining balance, then closes the
 * line and asserts the category nets to EXACTLY zero and never goes negative.
 *
 * Fixture (a plain, non-boxed line so the assertions are about the composition, not the box axis):
 *   SALE  qty 10, unitBasisQty 10, net $100.00, category tax $10.00.
 *
 *   A — return, then credit, then a closing return
 *     return 4 (LINE_UNIT)   -> -4 qty / -4 basis / -$40.00 net / -$4.00 tax   (remaining 6 / 6 / $60 / $6)
 *     credit $33.33 (qty 3, tax $3.33) -> -3 / -3 / -$33.33 / -$3.33            (remaining 3 / 3 / $26.67 / $2.67)
 *     return 3 (closes the line) -> books the EXACT remainder -3 / -3 / -$26.67 / -$2.67 (remaining 0)
 *       (a pro-rata 3/10 would book -$30.00: the odd cents are what tells a closing chunk that
 *        counts the credit note from one that does not)
 *   B — credit, then return, then an OVERSHOOTING closing credit
 *     credit $33.33 (qty 3, tax $3.33) -> -3 / -3 / -$33.33 / -$3.33            (remaining 7 / 7 / $66.67 / $6.67)
 *     return 4                   -> -4 / -4 / -$38.10 / -$3.81                   (remaining 3 / 3 / $28.57 / $2.86)
 *       (SA-293 R-2: a NON-closing return chunk is its share of what the line STILL HOLDS, 4/7 of $66.67 / $6.67,
 *        not 4/10 of the original $100 / $10 = $40.00 / $4.00; B and A differ here because only B has a credit note
 *        ahead of the return)
 *     credit $100 (qty 10, tax $10) -> CLAMPED to the remaining -3 / -3 / -$28.57 / -$2.86 (remaining 0)
 *
 * WHY THE DB LANE (B685): the ledger reads its own rows back between the two reversals
 * (`buildLineRemainingBalances` / `reverseCreditNoteEntries`' `lineRows`), so the composition is only
 * proven against real rows in real Postgres, not a mocked findMany. Collected only by
 * `jest.db.config.js`; run via `npm run local:test:db`; `requireLocalDatabaseUrl()` refuses any
 * non-local host.
 *
 * SAFETY: throwaway `qa-b687-<run>-<n>-<label>` tenants approved by `assertTestTenant`; `afterAll`
 * deletes exactly the tenants THIS run created, best-effort.
 */

import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b687-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "return-credit-compose.db.spec.ts",
  );
}

type Bag = { qty: number; basis: number; net: number; tax: number };
const bagOf = (rows: any[]): Bag =>
  rows.reduce(
    (b, r) => ({
      qty: round3(b.qty + Number(r.qty)),
      basis: round3(b.basis + Number(r.unitBasisQty)),
      net: round2(b.net + Number(r.netSales)),
      tax: round2(b.tax + Number(r.categoryTax)),
    }),
    { qty: 0, basis: 0, net: 0, tax: 0 },
  );
const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

describeDb("B687 return + credit-note reversals compose on one order line — real Postgres", () => {
  let prisma: PrismaService;
  let ledger: RegulatedLedgerService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    ledger = new RegulatedLedgerService(prisma);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.regulatedSalesLedger.deleteMany({ where: { tenantId } });
    await prisma.creditNoteItem.deleteMany({ where: { tenantId } });
    await prisma.creditNote.deleteMany({ where: { tenantId } });
    await prisma.returnItem.deleteMany({ where: { tenantId } });
    await prisma.return.deleteMany({ where: { tenantId } });
    await prisma.invoiceItem.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { tenantId } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.trackedCategory.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  /** One regulated SALE (qty 10, $100.00 net, $10.00 tax) on a single order line. */
  async function seedSale(label: string) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `B687 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const idBase = `${tenantId}-${label}`;
    const user = await prisma.user.create({
      data: { email: `${idBase}@example.invalid`, username: idBase, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `B687 customer ${label}`,
        contactName: `B687 contact ${label}`,
        tenantId,
      },
    });
    const category = await prisma.trackedCategory.create({
      data: { tenantId, name: `B687 category ${label}` },
    });
    const product = await prisma.product.create({
      data: { name: `B687 product ${label}`, unit: "each", pricePerUnit: 10, tenantId },
    });
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        status: "DELIVERED",
        orderNumber: `B687-${RUN_SUFFIX}-${label}`,
        subtotal: 100,
        tax: 0,
        total: 110,
        tenantId,
      },
    });
    const orderItem = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: product.id,
        qty: 10,
        unitPrice: 10,
        subtotal: 100,
        tenantId,
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderId: order.id,
        invoiceNumber: `INV-B687-${RUN_SUFFIX}-${label}`,
        status: "SENT",
        subtotal: 100,
        total: 110,
      },
    });
    const invoiceItem = await prisma.invoiceItem.create({
      data: {
        invoiceId: invoice.id,
        orderItemId: orderItem.id,
        productId: product.id,
        description: `B687 line ${label}`,
        qty: 10,
        unitPrice: 10,
        subtotal: 100,
        trackedCategoryId: category.id,
        categoryTaxAmount: 10,
        tenantId,
      },
    });
    await ledger.writeSaleEntries({
      tenantId,
      orderId: order.id,
      invoiceId: invoice.id,
      soldAt: new Date(),
      db: prisma,
      lines: [
        {
          invoiceItemId: invoiceItem.id,
          orderItemId: orderItem.id,
          trackedCategoryId: category.id,
          qty: 10,
          netSales: 100,
          categoryTax: 10,
        },
      ],
    });
    return { tenantId, customer, category, product, order, orderItem, invoice, invoiceItem };
  }

  type Seed = Awaited<ReturnType<typeof seedSale>>;

  /** A partial return of `qty` units, booked through the real service (LINE_UNIT axis). */
  async function bookReturn(s: Seed, qty: number, label: string) {
    const ret = await prisma.return.create({
      data: {
        tenantId: s.tenantId,
        orderId: s.order.id,
        customerId: s.customer.id,
        reason: "DAMAGED",
        returnNumber: `RET-B687-${RUN_SUFFIX}-${label}`,
      },
    });
    await prisma.returnItem.create({
      data: { tenantId: s.tenantId, returnId: ret.id, productId: s.product.id, qty },
    });
    await ledger.reverseReturnEntries({
      returnId: ret.id,
      orderId: s.order.id,
      returnedByProduct: new Map([[s.product.id, qty]]),
      returnedUnit: "LINE_UNIT",
      db: prisma,
    });
    return ret;
  }

  /** A credit note crediting `net` (with `qty` units and `tax`) against the sold line. */
  async function bookCredit(s: Seed, net: number, qty: number, tax: number, label: string) {
    const cn = await prisma.creditNote.create({
      data: {
        tenantId: s.tenantId,
        customerId: s.customer.id,
        invoiceId: s.invoice.id,
        creditNoteNumber: `CN-B687-${RUN_SUFFIX}-${label}`,
        amount: net + tax,
      },
    });
    await prisma.creditNoteItem.create({
      data: {
        tenantId: s.tenantId,
        creditNoteId: cn.id,
        invoiceItemId: s.invoiceItem.id,
        trackedCategoryId: s.category.id,
        amount: net,
        qty,
        categoryTax: tax,
      },
    });
    await ledger.reverseCreditNoteEntries({ creditNoteId: cn.id, db: prisma });
    return cn;
  }

  const allRows = (s: Seed) =>
    prisma.regulatedSalesLedger.findMany({
      where: { tenantId: s.tenantId, orderItemId: s.orderItem.id },
      orderBy: { createdAt: "asc" },
    });
  /** The line's remaining balance: Σ(SALE + REVERSAL), signed. */
  const remaining = async (s: Seed): Promise<Bag> => bagOf(await allRows(s));
  const reversalsOf = async (s: Seed, key: "returnId" | "creditNoteId", id: string) =>
    bagOf((await allRows(s)).filter((r) => r.entryType === "REVERSAL" && r[key] === id));

  it("A: a return, then a credit note, then a closing return net the line to exactly zero", async () => {
    const s = await seedSale("a");
    expect(await remaining(s)).toEqual({ qty: 10, basis: 10, net: 100, tax: 10 });

    const r1 = await bookReturn(s, 4, "a1");
    expect(await reversalsOf(s, "returnId", r1.id)).toEqual({
      qty: -4,
      basis: -4,
      net: -40,
      tax: -4,
    });
    expect(await remaining(s)).toEqual({ qty: 6, basis: 6, net: 60, tax: 6 });

    const cn = await bookCredit(s, 33.33, 3, 3.33, "a");
    expect(await reversalsOf(s, "creditNoteId", cn.id)).toEqual({
      qty: -3,
      basis: -3,
      net: -33.33,
      tax: -3.33,
    });
    expect(await remaining(s)).toEqual({ qty: 3, basis: 3, net: 26.67, tax: 2.67 });

    // The return that consumes everything left CLOSES the line: the EXACT remainder ($26.67, not the
    // pro-rata $30.00), which is only right if the credit note above was counted against the line.
    const r2 = await bookReturn(s, 3, "a2");
    expect(await reversalsOf(s, "returnId", r2.id)).toEqual({
      qty: -3,
      basis: -3,
      net: -26.67,
      tax: -2.67,
    });
    expect(await remaining(s)).toEqual({ qty: 0, basis: 0, net: 0, tax: 0 });
  });

  it("B: a credit note, then a return, then an OVERSHOOTING credit clamp to the remainder and net to exactly zero", async () => {
    const s = await seedSale("b");

    const cn1 = await bookCredit(s, 33.33, 3, 3.33, "b1");
    expect(await reversalsOf(s, "creditNoteId", cn1.id)).toEqual({
      qty: -3,
      basis: -3,
      net: -33.33,
      tax: -3.33,
    });
    expect(await remaining(s)).toEqual({ qty: 7, basis: 7, net: 66.67, tax: 6.67 });

    // SA-293 R-2: the non-closing return chunk is its share of what the line STILL HOLDS after the credit
    // note (4 of the 7 remaining: 4/7 of $66.67 = $38.10, tax 4/7 of $6.67 = $3.81), not 4/10 of the original.
    const r1 = await bookReturn(s, 4, "b");
    expect(await reversalsOf(s, "returnId", r1.id)).toEqual({
      qty: -4,
      basis: -4,
      net: -38.1,
      tax: -3.81,
    });
    expect(await remaining(s)).toEqual({ qty: 3, basis: 3, net: 28.57, tax: 2.86 });

    // A credit for MORE than is left (the whole $100 line again) must book only the remainder:
    // the two earlier reversals of different kinds are already counted against the line.
    const cn2 = await bookCredit(s, 100, 10, 10, "b2");
    expect(await reversalsOf(s, "creditNoteId", cn2.id)).toEqual({
      qty: -3,
      basis: -3,
      net: -28.57,
      tax: -2.86,
    });
    expect(await remaining(s)).toEqual({ qty: 0, basis: 0, net: 0, tax: 0 });
  });

  it("the category never goes negative at any step, whichever kind of reversal comes first", async () => {
    const s = await seedSale("neg");
    const steps: Array<() => Promise<unknown>> = [
      () => bookCredit(s, 30, 3, 3, "n1"),
      () => bookReturn(s, 4, "n2"),
      () => bookCredit(s, 100, 10, 10, "n3"),
      // Nothing left: a further return and credit are no-ops, never a negative row.
      () => bookReturn(s, 2, "n4"),
      () => bookCredit(s, 10, 1, 1, "n5"),
    ];
    for (const step of steps) {
      // eslint-disable-next-line no-await-in-loop
      await step();
      // eslint-disable-next-line no-await-in-loop
      const r = await remaining(s);
      expect(r.net).toBeGreaterThanOrEqual(0);
      expect(r.qty).toBeGreaterThanOrEqual(0);
      expect(r.basis).toBeGreaterThanOrEqual(0);
      expect(r.tax).toBeGreaterThanOrEqual(0);
    }
    expect(await remaining(s)).toEqual({ qty: 0, basis: 0, net: 0, tax: 0 });
  });
});
