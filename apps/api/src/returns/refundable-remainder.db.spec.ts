/**
 * SA-773: the refundable remainder's REAL queries on Postgres - the formula itself is pinned over fixtures in
 * `refundable-remainder.spec.ts`; this proves every select / where reads columns and relations that exist and returns the same
 * numbers from stored rows. Collected only by jest.db.config.js (`.db.spec.ts$`), run via `npm run local:test:db`.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb } from "../common/testing/db-spec";
import {
  addCreditNote,
  addInlineReturn,
  addStandardReturn,
  cleanupSeeded,
  seedRefundable,
  type Seeded,
  type SeedInvoice,
} from "../../test/refundable-seed";
import {
  creditableGroupInvoiceIds,
  poolKey,
  refundableRefusal,
  refundableRemainder,
} from "./refundable-remainder";

const RUN = randomUUID().slice(0, 8);
const SPEC = "refundable-remainder.db.spec.ts";

describeDb("SA-773 refundableRemainder - real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  const tenantIds: string[] = [];
  let n = 0;

  beforeAll(async () => {
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
  }, 120_000);

  afterAll(async () => {
    await cleanupSeeded(prisma, tenantIds);
    await prisma?.$disconnect();
  }, 120_000);

  const seed = (label: string, invoices: SeedInvoice[]) =>
    seedRefundable(prisma, tenantIds, { run: RUN, spec: SPEC, label, invoices });
  const remainder = (
    s: Seeded,
    extra: { invoiceIds?: string[]; excludeReturnId?: string; excludeCreditNoteId?: string } = {},
  ) =>
    tenantCtx.run(s.tenantId, () =>
      prisma.tenantTransaction((tx: any) =>
        refundableRemainder(tx, { invoiceIds: extra.invoiceIds ?? [s.invoices[0].id], ...extra }),
      ),
    );
  const pool = (
    rem: Awaited<ReturnType<typeof remainder>>,
    s: Seeded,
    product: string,
    invoice = 0,
  ) => rem.byInvoiceProduct.get(poolKey(s.invoices[invoice].id, s.products[product]));
  const cn = () => `CN-SA773-${RUN}-${++n}`;

  it("nothing credited: the pool is the billed qty and the billed gross value", async () => {
    const s = await seed("plain", [
      { lines: [{ product: "A", qty: 10, subtotal: 100, taxRate: 0.1, categoryTaxAmount: 2 }] },
    ]);
    const rem = await remainder(s);
    expect(pool(rem, s, "A")).toMatchObject({ qty: 10, value: 112 });
    expect(rem.byInvoice.get(s.invoices[0].id)).toMatchObject({ value: 112 });
  });

  it("a $20 standalone credit note item takes its qty and gross value (tax at the line's stored rate)", async () => {
    const s = await seed("cn-item", [
      { lines: [{ product: "A", qty: 10, subtotal: 100, taxRate: 0.1 }] },
    ]);
    await addCreditNote(prisma, s, { number: cn(), items: [{ line: 0, amount: 20, qty: 2 }] });
    expect(pool(await remainder(s), s, "A")).toMatchObject({ qty: 8, value: 88 });
  });

  it("a partial credit note ($8 of $20) leaves $12; a VOID one is not netted", async () => {
    const s = await seed("partial", [{ lines: [{ product: "A", qty: 4, subtotal: 20 }] }]);
    await addCreditNote(prisma, s, { number: cn(), items: [{ line: 0, amount: 8, qty: 1.6 }] });
    await addCreditNote(prisma, s, {
      number: cn(),
      status: "VOID",
      items: [{ line: 0, amount: 10, qty: 2 }],
    });
    expect(pool(await remainder(s), s, "A")).toMatchObject({ qty: 2.4, value: 12 });
  });

  it("a REJECTED or CANCELLED return is not netted; PENDING, APPROVED, RECEIVED and REFUNDED are", async () => {
    const s = await seed("returns", [{ lines: [{ product: "A", qty: 10, subtotal: 100 }] }]);
    for (const status of ["REJECTED", "CANCELLED", "PENDING", "APPROVED", "RECEIVED", "REFUNDED"])
      await addStandardReturn(prisma, s, {
        number: `RTN-${RUN}-${++n}`,
        status,
        items: [{ product: "A", qty: 1 }],
      });
    expect(pool(await remainder(s), s, "A")).toMatchObject({ qty: 6, value: 60 });
  });

  it("excludeReturnId leaves the return being refunded out", async () => {
    const s = await seed("exclude", [{ lines: [{ product: "A", qty: 10, subtotal: 100 }] }]);
    const mine = await addStandardReturn(prisma, s, {
      number: `RTN-${RUN}-${++n}`,
      status: "RECEIVED",
      items: [{ product: "A", qty: 4 }],
    });
    expect(pool(await remainder(s), s, "A")).toMatchObject({ qty: 6 });
    expect(pool(await remainder(s, { excludeReturnId: mine.id }), s, "A")).toMatchObject({
      qty: 10,
      value: 100,
    });
  });

  it("a Return's own credit note is counted once (through the Return), not again as a standalone credit", async () => {
    const s = await seed("return-cn", [{ lines: [{ product: "A", qty: 10, subtotal: 100 }] }]);
    const note = await addCreditNote(prisma, s, {
      number: cn(),
      items: [{ line: 0, amount: 40, qty: 4 }],
    });
    await addStandardReturn(prisma, s, {
      number: `RTN-${RUN}-${++n}`,
      status: "REFUNDED",
      items: [{ product: "A", qty: 4 }],
      creditNoteId: note.id,
      refundMethod: "CREDIT_NOTE",
      refundAmount: 40,
    });
    expect(pool(await remainder(s), s, "A")).toMatchObject({ qty: 6, value: 60 });
  });

  it("an amount-only invoice credit note of $15 on a $50 invoice caps the invoice at $35", async () => {
    const s = await seed("amount-only", [
      {
        lines: [
          { product: "A", qty: 5, subtotal: 30 },
          { product: "B", qty: 2, subtotal: 20 },
        ],
      },
    ]);
    await addCreditNote(prisma, s, { number: cn(), invoice: 0, amount: 15 });
    const rem = await remainder(s);
    expect(rem.byInvoice.get(s.invoices[0].id)?.value).toBe(35);
    expect(
      refundableRefusal(rem, [
        { invoiceId: s.invoices[0].id, productId: s.products.A, qty: 5, value: 30 },
        { invoiceId: s.invoices[0].id, productId: s.products.B, qty: 2, value: 20 },
      ]),
    ).toEqual({ invoiceId: s.invoices[0].id, remainingQty: null, remainingValue: 35 });
  });

  it("two invoices of one order are ONE pool, reached from either id", async () => {
    const s = await seed("pooled", [
      { lines: [{ product: "A", qty: 4, subtotal: 40 }] },
      { lines: [{ product: "A", qty: 6, subtotal: 60 }] },
    ]);
    await addStandardReturn(prisma, s, {
      number: `RTN-${RUN}-${++n}`,
      status: "RECEIVED",
      items: [{ product: "A", qty: 3 }],
    });
    const rem = await remainder(s, { invoiceIds: [s.invoices[0].id] });
    expect(pool(rem, s, "A", 0)).toBe(pool(rem, s, "A", 1));
    expect(pool(rem, s, "A", 0)).toMatchObject({ qty: 7, value: 70 });
    expect(
      await tenantCtx.run(s.tenantId, () =>
        prisma.tenantTransaction((tx: any) => creditableGroupInvoiceIds(tx, [s.invoices[0].id])),
      ),
    ).toEqual([s.invoices[0].id, s.invoices[1].id].sort());
  });

  it("an INLINE return counts its stored item qty and money", async () => {
    const s = await seed("inline", [
      { lines: [{ product: "A", qty: 10, subtotal: 100, taxRate: 0.1 }] },
    ]);
    await addInlineReturn(prisma, s, {
      number: `RTN-${RUN}-${++n}`,
      status: "RECEIVED",
      items: [{ line: 0, qty: 3, subtotal: 30, taxAmount: 3 }],
    });
    await addInlineReturn(prisma, s, {
      number: `RTN-${RUN}-${++n}`,
      status: "CANCELLED",
      items: [{ line: 0, qty: 5, subtotal: 50, taxAmount: 5 }],
    });
    expect(pool(await remainder(s), s, "A")).toMatchObject({ qty: 7, value: 77 });
  });

  it("an old pool credited twice reads <= 0", async () => {
    const s = await seed("over", [{ lines: [{ product: "A", qty: 4, subtotal: 20 }] }]);
    await addCreditNote(prisma, s, { number: cn(), items: [{ line: 0, amount: 20, qty: 4 }] });
    await addStandardReturn(prisma, s, {
      number: `RTN-${RUN}-${++n}`,
      status: "REFUNDED",
      items: [{ product: "A", qty: 4 }],
    });
    const p = pool(await remainder(s), s, "A");
    expect(p?.qty).toBeLessThanOrEqual(0);
    expect(p?.value).toBeLessThanOrEqual(0);
  });
});
