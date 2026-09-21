/**
 * B662 — DB-lane proof that a price correction leaves the ledger SUM equal to the invoice, through
 * adjust -> partial return -> adjust (where the Senior Architect's TARGET rule bites), stays idempotent,
 * and cannot orphan when the invoice returns to draft (a draft re-sync reverses the SALE AND its
 * corrections). Real Postgres, real `RegulatedLedgerService`; it needs the ledger-correction migration
 * applied (originalSoldAt / correctsEntryId) and its schema PR merged, so it carries B662's merge gate.
 *
 * The ledger's pointers are scalars with no FK, so the seed needs only a tenant and a tracked category. The
 * partial return is booked as the REVERSAL row `reverseReturnEntries` writes (1/6 of the held net and tax,
 * carrying a returnId) rather than driving that method, which would drag in orders, invoices and products
 * this proof does not need; that method has its own specs.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * SAFETY: one throwaway `qa-b662-<run>-<n>-<label>` tenant per test, approved by `assertTestTenant`;
 * `afterAll` deletes exactly what THIS run created.
 */
import { randomUUID } from "crypto";
import { roundMoney } from "@routeflow/pricing";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { RegulatedLedgerService } from "./regulated-ledger.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;

describeDb("B662 ledger price correction — real Postgres", () => {
  let prisma: PrismaService;
  let ledger: RegulatedLedgerService;
  const tenantIds: string[] = [];
  // Unique per test: the ledger's pointers are not tenant-filtered by the methods under test.
  let ids = { invoiceId: "", itemId: "", returnId: "" };
  const db = () => prisma as any; // the new columns exist only in a client generated after the schema PR

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    ledger = new RegulatedLedgerService(prisma);
  });

  afterAll(async () => {
    for (const id of tenantIds) {
      await db()
        .regulatedSalesLedger.deleteMany({ where: { tenantId: id } })
        .catch(() => undefined);
      await prisma.trackedCategory.deleteMany({ where: { tenantId: id } }).catch(() => undefined);
      await prisma.tenant.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  /** A tenant, a category and the SALE for 6 boxes of 12 at $40: qty 72, net $240, category tax $60. */
  async function seed(label: string) {
    tenantSeq += 1;
    const slug = assertTestTenant(
      `qa-b662-${RUN_SUFFIX}-${tenantSeq}-${label}`,
      "regulated-ledger-price-correction.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `B662 ${slug}` } });
    tenantIds.push(tenant.id);
    ids = {
      invoiceId: `inv-b662-${RUN_SUFFIX}-${tenantSeq}`,
      itemId: `ii-b662-${RUN_SUFFIX}-${tenantSeq}`,
      returnId: `ret-b662-${RUN_SUFFIX}-${tenantSeq}`,
    };
    const cat = await prisma.trackedCategory.create({
      data: { tenantId: tenant.id, name: "B662 category" },
    });
    const sale = await db().regulatedSalesLedger.create({
      data: {
        tenantId: tenant.id,
        trackedCategoryId: cat.id,
        entryType: "SALE",
        invoiceId: ids.invoiceId,
        invoiceItemId: ids.itemId,
        qty: 72,
        unitBasisQty: 72,
        netSales: 240,
        categoryTax: 60,
        soldAt: new Date("2026-08-15T00:00:00Z"),
        periodBucket: "2026-08",
      },
    });
    return { tenantId: tenant.id, sale };
  }
  const line = (net: number, tax: number) => ({
    invoiceItemId: ids.itemId,
    qty: 72,
    netSales: net,
    categoryTax: tax,
    boxes: 6,
    unitsPerBox: 12,
    promoFreeUnits: null,
  });
  const correct = (net: number, tax: number) =>
    ledger.correctSaleForPriceChange({
      invoiceId: ids.invoiceId,
      lines: [line(net, tax)],
      db: prisma,
    });
  const sums = async (tenantId: string) => {
    const a = await db().regulatedSalesLedger.aggregate({
      where: { tenantId, invoiceItemId: ids.itemId },
      _sum: { netSales: true, categoryTax: true, qty: true },
    });
    return {
      net: Number(a._sum.netSales),
      tax: Number(a._sum.categoryTax),
      qty: Number(a._sum.qty),
    };
  };

  it("adjust -> partial return -> adjust: the ledger SUM equals the prorated target at every step", async () => {
    const { tenantId, sale } = await seed("sum");

    // 1. price up: $40 -> $50 per box. 240 -> 300 net, 60 -> 75 tax.
    expect(await correct(300, 75)).toBe(1);
    expect(await sums(tenantId)).toEqual({ net: 300, tax: 75, qty: 72 });
    const corr = await db().regulatedSalesLedger.findFirst({
      where: { tenantId, correctsEntryId: sale.id },
    });
    expect(corr).toMatchObject({ entryType: "SALE", qty: expect.anything() });
    expect(Number(corr.qty)).toBe(0);
    expect(corr.originalSoldAt).toEqual(sale.soldAt); // the sale date it corrects
    expect(corr.periodBucket).not.toBe("2026-08"); // booked in the CURRENT period

    // 2. one box (12 pieces) comes back: the reversal takes 1/6 of what is held.
    await db().regulatedSalesLedger.create({
      data: {
        tenantId,
        trackedCategoryId: sale.trackedCategoryId,
        entryType: "REVERSAL",
        invoiceId: ids.invoiceId,
        invoiceItemId: ids.itemId,
        returnId: ids.returnId,
        qty: -12,
        unitBasisQty: -12,
        netSales: -50,
        categoryTax: -12.5,
        soldAt: new Date(),
        periodBucket: "2026-09",
      },
    });
    expect(await sums(tenantId)).toEqual({ net: 250, tax: 62.5, qty: 60 });

    // 3. price up again: $50 -> $60 per box (invoice line 360 net, 90 tax) on the 60 pieces still held.
    expect(await correct(360, 90)).toBe(1);
    const held = await sums(tenantId);
    const oracle = (invoiceAmount: number) => roundMoney((invoiceAmount * held.qty) / 72);
    expect(held.net).toBe(oracle(360)); // 300
    expect(held.tax).toBe(oracle(90)); // 75

    // 4. idempotent: repeating the same adjustment writes nothing and changes no sum.
    expect(await correct(360, 90)).toBe(0);
    expect(await sums(tenantId)).toEqual(held);
  });

  it("a draft re-sync after corrections reverses the SALE AND its corrections: no orphan, no double count", async () => {
    const { tenantId } = await seed("draft");
    await correct(300, 75);
    await correct(330, 82.5);
    expect(await sums(tenantId)).toEqual({ net: 330, tax: 82.5, qty: 72 });

    await ledger.reverseInvoiceEntries({
      invoiceId: ids.invoiceId,
      db: prisma,
      preserveReturns: true,
    });
    expect(await sums(tenantId)).toEqual({ net: 0, tax: 0, qty: 0 });
  });

  it("an increase and a decrease both stay one row per adjustment, typed by sign", async () => {
    const { tenantId } = await seed("sign");
    await correct(300, 75);
    await correct(200, 50);
    const rows = await db().regulatedSalesLedger.findMany({
      where: { tenantId, NOT: { correctsEntryId: null } },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r: any) => r.entryType)).toEqual(["SALE", "REVERSAL"]);
    expect(await sums(tenantId)).toEqual({ net: 200, tax: 50, qty: 72 });
  });
});
