/**
 * B662 — DB-lane proof that a price correction leaves the ledger SUM equal to the invoice, through
 * adjust -> partial return -> adjust (where the Senior Architect's TARGET rule bites), stays idempotent,
 * and cannot orphan when the invoice returns to draft (a draft re-sync reverses the SALE AND its
 * corrections). Real Postgres, real `RegulatedLedgerService`; it needs the ledger-correction migration
 * applied (originalSoldAt / correctsEntryId) and its schema PR merged, so it carries B662's merge gate.
 *
 * The ledger's pointers are scalars with no FK, so the seed needs only a tenant and a tracked category. The
 * partial return in the first case is booked as the REVERSAL row `reverseReturnEntries` writes (1/6 of the
 * held net and tax, carrying a returnId). The "Opus R2" cases at the end DRIVE `reverseReturnEntries`
 * itself (over a real customer, product, invoice and invoice line), so a return after a price correction is
 * proven to reverse its share of the CORRECTED figures, not a hand-written number.
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
  const cleanups: Array<() => Promise<unknown>> = []; // rows the driven-return cases add (run first)
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
    for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
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

  // ─── Opus R2: a partial return AFTER a price correction reverses the CORRECTED amount ───
  //
  // The reversal walk pro-rated the base SALE row only, so a return after a correction under-reversed
  // (a $100 line corrected to $125, 40% back: -$40, leaving $85 held against a $75 invoice share).
  // These drive the real `reverseReturnEntries` over a real invoice line; the pieces are not boxed.
  async function seedDriven(label: string, net: number, tax: number, qty: number) {
    tenantSeq += 1;
    const n = tenantSeq;
    const slug = assertTestTenant(
      `qa-b662-${RUN_SUFFIX}-${n}-${label}`,
      "regulated-ledger-price-correction.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `B662 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const cat = await prisma.trackedCategory.create({ data: { tenantId, name: "B662 category" } });
    const custUser = await prisma.user.create({
      data: {
        email: `b662-${RUN_SUFFIX}-${n}@example.test`,
        username: `b662-${RUN_SUFFIX}-${n}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await prisma.customer.create({
      data: { userId: custUser.id, businessName: "B662 Co", contactName: "B662 Tester", tenantId },
    });
    const product = await prisma.product.create({
      data: { name: `b662 ${n}`, unit: "each", pricePerUnit: "10.00", tenantId },
    });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-B662-${RUN_SUFFIX}-${n}`,
        customerId: customer.id,
        status: "SENT",
        subtotal: String(net),
        taxAmount: String(tax),
        total: String(net + tax),
        tenantId,
      },
    });
    const item = await prisma.invoiceItem.create({
      data: {
        invoiceId: invoice.id,
        description: "b662 line",
        productId: product.id,
        qty,
        unitPrice: String(net / qty),
        subtotal: String(net),
        tenantId,
      },
    });
    cleanups.push(
      () => prisma.invoiceItem.deleteMany({ where: { invoiceId: invoice.id } }),
      () => prisma.invoice.deleteMany({ where: { id: invoice.id } }),
      () => prisma.product.deleteMany({ where: { id: product.id } }),
      () => prisma.customer.deleteMany({ where: { id: customer.id } }),
      () => prisma.user.deleteMany({ where: { id: custUser.id } }),
    );
    const orderId = `ord-b662-${RUN_SUFFIX}-${n}`;
    await db().regulatedSalesLedger.create({
      data: {
        tenantId,
        trackedCategoryId: cat.id,
        entryType: "SALE",
        orderId,
        invoiceId: invoice.id,
        invoiceItemId: item.id,
        qty,
        unitBasisQty: qty,
        netSales: net,
        categoryTax: tax,
        soldAt: new Date("2026-08-15T00:00:00Z"),
        periodBucket: "2026-08",
      },
    });
    const drivenSums = async () => {
      const a = await db().regulatedSalesLedger.aggregate({
        where: { tenantId, invoiceItemId: item.id },
        _sum: { netSales: true, categoryTax: true, qty: true },
      });
      return {
        net: roundMoney(Number(a._sum.netSales)),
        tax: roundMoney(Number(a._sum.categoryTax)),
        qty: Number(a._sum.qty),
      };
    };
    const correctTo = (newNet: number, newTax: number) =>
      ledger.correctSaleForPriceChange({
        invoiceId: invoice.id,
        lines: [
          {
            invoiceItemId: item.id,
            qty,
            netSales: newNet,
            categoryTax: newTax,
            boxes: null,
            unitsPerBox: null,
            promoFreeUnits: null,
          },
        ],
        db: prisma,
      });
    const returnPieces = (
      returnId: string,
      pieces: number,
      returnedUnit: "PIECES" | "LINE_UNIT" = "PIECES",
    ) =>
      ledger.reverseReturnEntries({
        returnId,
        orderId,
        returnedByProduct: new Map([[product.id, pieces]]),
        returnedUnit,
        db: prisma,
      });
    const reversalOf = (returnId: string) =>
      db().regulatedSalesLedger.findFirst({ where: { tenantId, returnId, entryType: "REVERSAL" } });
    return { tenantId, drivenSums, correctTo, returnPieces, reversalOf };
  }

  it("R2 (a): a $100 line corrected to $125, then 40% back: the reversal is exactly $50 and its tax share, not $40", async () => {
    const f = await seedDriven("r2a", 100, 20, 10);
    expect(await f.correctTo(125, 25)).toBe(1);
    await f.returnPieces("ret-r2a", 4);
    const rev = await f.reversalOf("ret-r2a");
    expect(Number(rev.netSales)).toBe(-50); // 40% of the CORRECTED $125, not of the base $100 (-40)
    expect(Number(rev.categoryTax)).toBe(-10); // 40% of the corrected $25 tax, not of $20 (-8)
    expect(await f.drivenSums()).toEqual({ net: 75, tax: 15, qty: 6 }); // the ledger SUM = 60% held
  }, 60_000);

  it("R2 (b): the rest comes back in parts: the tie rounds up, the last chunk takes the exact remainder, the SUM ends at 0", async () => {
    const f = await seedDriven("r2b", 100, 20, 10);
    // 125.01 / 25.01 tell the old (base-sale) and the new (remaining-net) formulas apart AND hit a tie.
    expect(await f.correctTo(125.01, 25.01)).toBe(1);
    await f.returnPieces("ret-r2b-1", 4); // 125.01 x 4/10 = 50.004 -> 50.00; tax 10.004 -> 10.00
    await f.returnPieces("ret-r2b-2", 3); // (75.01 x 3/6) = 37.505 tie -> rounds up 37.51; tax 7.505 -> 7.51
    const r1 = await f.reversalOf("ret-r2b-1");
    const r2 = await f.reversalOf("ret-r2b-2");
    expect([Number(r1.netSales), Number(r1.categoryTax)]).toEqual([-50, -10]);
    expect([Number(r2.netSales), Number(r2.categoryTax)]).toEqual([-37.51, -7.51]);
    await f.returnPieces("ret-r2b-3", 3); // the closing chunk books the remaining balance exactly
    const r3 = await f.reversalOf("ret-r2b-3");
    expect([Number(r3.netSales), Number(r3.categoryTax)]).toEqual([-37.5, -7.5]);
    expect(await f.drivenSums()).toEqual({ net: 0, tax: 0, qty: 0 });
  }, 60_000);

  // The ledger must equal the invoice pro-rate at EVERY step: invoice amount x pieces still held / sold.
  const expectHeld = async (
    f: Awaited<ReturnType<typeof seedDriven>>,
    invoiceNet: number,
    invoiceTax: number,
    sold: number,
  ) => {
    const held = await f.drivenSums();
    expect(held.net).toBe(roundMoney((invoiceNet * held.qty) / sold));
    expect(held.tax).toBe(roundMoney((invoiceTax * held.qty) / sold));
    return held;
  };

  it("R-2: return -> adjust -> return: the second return books exactly its share of the CORRECTED amount (-50, not -48.33)", async () => {
    const f = await seedDriven("r2-order1", 240, 48, 72);
    await f.returnPieces("ret-o1-1", 12);
    expect(Number((await f.reversalOf("ret-o1-1")).netSales)).toBe(-40); // 12/72 of $240
    await expectHeld(f, 240, 48, 72);
    expect(await f.correctTo(300, 60)).toBe(1); // over the 60 pieces still held: +$50 / +$12
    await expectHeld(f, 300, 60, 72);
    await f.returnPieces("ret-o1-2", 12);
    const rev = await f.reversalOf("ret-o1-2");
    expect(Number(rev.netSales)).toBe(-50); // 12/60 of the $250 still held
    expect(Number(rev.categoryTax)).toBe(-10);
    await expectHeld(f, 300, 60, 72);
  }, 60_000);

  it("R-1: a STANDARD (LINE_UNIT) return after a correction reverses its share of the corrected amount: -50 / -10, not -40 / -8", async () => {
    const f = await seedDriven("r1-lineunit", 240, 48, 72);
    expect(await f.correctTo(300, 60)).toBe(1);
    await f.returnPieces("ret-lu-1", 12, "LINE_UNIT");
    const rev = await f.reversalOf("ret-lu-1");
    expect(Number(rev.netSales)).toBe(-50);
    expect(Number(rev.categoryTax)).toBe(-10);
    await expectHeld(f, 300, 60, 72);
    // ... and return -> adjust -> return on the LINE_UNIT axis too
    await f.returnPieces("ret-lu-2", 12, "LINE_UNIT");
    expect(await f.correctTo(360, 72)).toBe(1);
    await f.returnPieces("ret-lu-3", 12, "LINE_UNIT");
    await expectHeld(f, 360, 72, 72);
  }, 60_000);

  it("R-2: adjust -> return -> adjust -> return on the PIECES axis keeps the ledger on the invoice pro-rate at every step, net AND tax", async () => {
    const f = await seedDriven("r2-order2", 240, 48, 72);
    await f.correctTo(300, 60);
    await expectHeld(f, 300, 60, 72);
    await f.returnPieces("ret-o2-1", 12);
    await expectHeld(f, 300, 60, 72);
    await f.correctTo(330, 66);
    await expectHeld(f, 330, 66, 72);
    await f.returnPieces("ret-o2-2", 12);
    await expectHeld(f, 330, 66, 72);
  }, 60_000);
});
