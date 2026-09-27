/**
 * #2118 — real-Postgres pins for every plan §E risk row of the sales-facts layer (plan
 * local-assets/work/analytics-plan-2026-09-25.md). WHY THE DB LANE: the null-tenant nested-write
 * trap, the through-parent relation filters, keyset paging and timestamp windows are only
 * provable against a real Postgres — a mocked `findMany` returns whatever it is told.
 *
 * Run through `npm run local:test:db` (or `npm run test:db -w apps/api` with RUN_DB_SPECS and a
 * local DATABASE_URL); `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * SAFETY: every tenant is a throwaway `qa-2118-<run>-<n>-<label>` slug approved by
 * `assertTestTenant`; `afterAll` deletes exactly the rows THIS run created. Every test seeds
 * everything its own expectation depends on. No live client names anywhere.
 */
import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Client } from "pg";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import {
  describeDb,
  relaxTenantIdGuards,
  requireLocalDatabaseUrl,
} from "../common/testing/db-spec";
import { fetchAccrualNetSales, fetchInvoicedSaleLines } from "../common/invoiced-sales";
import { ProductInsightsService } from "./product-insights.service";
import { SalesFactsService } from "./sales-facts.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const stamp = (day: string) => new Date(`${day}T00:00:00.000Z`);

interface LineSeed {
  productId: string | null;
  qty: number;
  subtotal: number;
  unitPrice?: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  unitLabel?: string | null;
  /** Default: the invoice's tenant. `null` plants the legacy nested-write shape. */
  tenantId?: string | null;
}

describeDb("sales-facts — real Postgres (#2118, plan §E)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let insights: ProductInsightsService;
  let facts: SalesFactsService;
  let pg: Client;
  const tenantIds: string[] = [];
  const buyerAccountIds: string[] = [];

  beforeAll(async () => {
    const url = requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    pg = new Client({ connectionString: url });
    await pg.connect();
    const module = await Test.createTestingModule({
      providers: [
        ProductInsightsService,
        SalesFactsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    insights = module.get(ProductInsightsService);
    facts = module.get(SalesFactsService);
  });

  afterAll(async () => {
    // Newest first: E4's second tenant holds a line pointing at the first tenant's product.
    for (const tenantId of [...tenantIds].reverse()) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => undefined);
    }
    if (buyerAccountIds.length) {
      await prisma.buyerAccount
        .deleteMany({ where: { id: { in: buyerAccountIds } } })
        .catch(() => undefined);
    }
    await pg?.end().catch(() => undefined);
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string) {
    await prisma.creditNoteItem.deleteMany({ where: { tenantId } });
    await prisma.creditNote.deleteMany({ where: { tenantId } });
    await prisma.returnItem.deleteMany({ where: { return: { tenantId } } });
    await prisma.return.deleteMany({ where: { tenantId } });
    // Items by PARENT: a planted null-tenant line has no tenantId of its own.
    await prisma.invoiceItem.deleteMany({ where: { invoice: { tenantId } } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.customerLink.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.tenantConfig.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  // ─── Seed helpers (direct writes — the reads are under test, not the writers) ───────

  async function seedTenant(label: string, timezone: string | null = "UTC") {
    seq += 1;
    const slug = assertTestTenant(`qa-2118-${RUN}-${seq}-${label}`, "sales-facts.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `Insights QA ${slug}` } });
    tenantIds.push(tenant.id);
    if (timezone) await prisma.tenantConfig.create({ data: { tenantId: tenant.id, timezone } });
    return tenant.id;
  }

  async function seedCustomer(tenantId: string, label: string, extra: { deletedAt?: Date } = {}) {
    const base = `${tenantId.slice(0, 8)}-${label}-${randomUUID().slice(0, 6)}`;
    const user = await prisma.user.create({
      data: { email: `${base}@example.invalid`, username: base, role: "CUSTOMER", tenantId },
    });
    return prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `Acme ${label}`,
        contactName: `Contact ${label}`,
        tenantId,
        ...extra,
      },
    });
  }

  async function seedProduct(
    tenantId: string,
    label: string,
    extra: { unitsPerBox?: number | null; isActive?: boolean } = {},
  ) {
    return prisma.product.create({
      data: {
        tenantId,
        name: `Widget ${label}`,
        sku: `SKU-${label}-${randomUUID().slice(0, 6)}`,
        unit: "case",
        pricePerUnit: 10,
        unitsPerBox: extra.unitsPerBox ?? null,
        isActive: extra.isActive ?? true,
      },
    });
  }

  let invSeq = 0;
  async function seedInvoice(
    tenantId: string,
    customerId: string,
    opts: {
      issueDate: string;
      lines: LineSeed[];
      status?: "SENT" | "PAID" | "WRITTEN_OFF" | "VOID" | "DRAFT";
      orderId?: string | null;
      discount?: number;
      shippingFee?: number;
      taxAmount?: number;
      createdAt?: Date;
      /** Every line gets THIS createdAt — the shape of lines written in one statement. */
      lineCreatedAt?: Date;
    },
  ) {
    invSeq += 1;
    const subtotal = opts.lines.reduce((s, l) => s + l.subtotal, 0);
    const discount = opts.discount ?? 0;
    const shippingFee = opts.shippingFee ?? 0;
    const taxAmount = opts.taxAmount ?? 0;
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `INV-2118-${RUN}-${invSeq}`,
        status: opts.status ?? "SENT",
        issueDate: stamp(opts.issueDate),
        orderId: opts.orderId ?? null,
        subtotal,
        discount,
        shippingFee,
        taxAmount,
        total: subtotal - discount + shippingFee + taxAmount,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
    });
    const items: Awaited<ReturnType<typeof prisma.invoiceItem.create>>[] = [];
    for (const [i, l] of opts.lines.entries()) {
      // eslint-disable-next-line no-await-in-loop
      const item = await prisma.invoiceItem.create({
        data: {
          invoiceId: invoice.id,
          tenantId: l.tenantId === undefined ? tenantId : l.tenantId,
          productId: l.productId,
          description: `line ${i + 1}`,
          qty: l.qty,
          unitPrice: l.unitPrice ?? (l.qty ? l.subtotal / l.qty : l.subtotal),
          subtotal: l.subtotal,
          boxes: l.boxes ?? null,
          pieces: l.pieces ?? null,
          unitsPerBox: l.unitsPerBox ?? null,
          unitLabel: l.unitLabel ?? null,
          // Distinct, increasing entry times unless the test plants identical ones.
          createdAt:
            opts.lineCreatedAt ??
            new Date((opts.createdAt ?? invoice.createdAt).getTime() + (i + 1) * 1_000),
        },
      });
      items.push(item);
    }
    return { invoice, items };
  }

  async function seedOrder(tenantId: string, customerId: string) {
    return prisma.order.create({ data: { tenantId, customerId } });
  }

  /** The order line a STANDARD return's typed qty is read against (B665). */
  async function seedOrderItem(
    tenantId: string,
    orderId: string,
    line: { productId: string; qty: number; subtotal: number },
  ) {
    return prisma.orderItem.create({
      data: {
        tenantId,
        orderId,
        productId: line.productId,
        qty: line.qty,
        unitPrice: line.subtotal / line.qty,
        subtotal: line.subtotal,
      },
    });
  }

  let cnSeq = 0;
  async function seedCreditNote(
    tenantId: string,
    customerId: string,
    opts: {
      amount: number;
      createdAt: Date;
      invoiceId?: string | null;
      status?: "ISSUED" | "VOID";
      items?: {
        invoiceItemId: string;
        amount: number;
        qty?: number;
        trackedCategoryId?: string | null;
      }[];
    },
  ) {
    cnSeq += 1;
    const cn = await prisma.creditNote.create({
      data: {
        tenantId,
        customerId,
        creditNoteNumber: `CN-2118-${RUN}-${cnSeq}`,
        amount: opts.amount,
        invoiceId: opts.invoiceId ?? null,
        status: opts.status ?? "ISSUED",
        createdAt: opts.createdAt,
      },
    });
    for (const it of opts.items ?? []) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.creditNoteItem.create({
        data: {
          tenantId,
          creditNoteId: cn.id,
          invoiceItemId: it.invoiceItemId,
          amount: it.amount,
          qty: it.qty ?? 0,
          trackedCategoryId: it.trackedCategoryId ?? null,
        },
      });
    }
    return cn;
  }

  async function seedReturn(
    tenantId: string,
    customerId: string,
    orderId: string,
    opts: {
      kind?: "STANDARD" | "INLINE";
      refundMethod: "CREDIT_NOTE" | "EXTERNAL_REFUND" | null;
      refundAmount?: number;
      refundedAt?: Date | null;
      creditNoteId?: string | null;
      items: { productId: string; qty: number; subtotal?: number; sourceInvoiceItemId?: string }[];
    },
  ) {
    const ret = await prisma.return.create({
      data: {
        tenantId,
        customerId,
        orderId,
        reason: "DAMAGED",
        status: opts.refundMethod ? "REFUNDED" : "RECEIVED",
        kind: opts.kind ?? "STANDARD",
        refundMethod: opts.refundMethod,
        refundAmount: opts.refundAmount ?? null,
        refundedAt: opts.refundedAt ?? null,
        creditNoteId: opts.creditNoteId ?? null,
      },
    });
    for (const it of opts.items) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.returnItem.create({
        data: {
          tenantId,
          returnId: ret.id,
          productId: it.productId,
          qty: it.qty,
          subtotal: it.subtotal ?? null,
          sourceInvoiceItemId: it.sourceInvoiceItemId ?? null,
        },
      });
    }
    return ret;
  }

  const asTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  // ─── §E rows ────────────────────────────────────────────────────────────────

  it("E1 CN vs return double count: a CN-method return nets once (CreditNote term), an external refund once (Return term); attributed = CreditNoteItem.amount", async () => {
    const t = await seedTenant("e1");
    const c = await seedCustomer(t, "e1");
    const p = await seedProduct(t, "e1");
    const order = await seedOrder(t, c.id);
    // A never-boxed product's order line: a STANDARD return typed against it is already pieces.
    await seedOrderItem(t, order.id, { productId: p.id, qty: 10, subtotal: 100 });
    const { invoice, items } = await seedInvoice(t, c.id, {
      issueDate: "2026-06-05",
      orderId: order.id,
      lines: [{ productId: p.id, qty: 10, subtotal: 100 }],
    });
    // A STANDARD credit-note return: processRefund mints a lump-sum (item-less) note.
    const cn1 = await seedCreditNote(t, c.id, {
      amount: 30,
      invoiceId: invoice.id,
      createdAt: new Date("2026-06-10T15:00:00Z"),
    });
    await seedReturn(t, c.id, order.id, {
      refundMethod: "CREDIT_NOTE",
      refundAmount: 30,
      refundedAt: new Date("2026-06-10T15:00:00Z"),
      creditNoteId: cn1.id,
      items: [{ productId: p.id, qty: 3 }],
    });
    // A STANDARD external refund: money outside RouteFlow, nothing minted.
    await seedReturn(t, c.id, order.id, {
      refundMethod: "EXTERNAL_REFUND",
      refundAmount: 20,
      refundedAt: new Date("2026-06-12T15:00:00Z"),
      items: [{ productId: p.id, qty: 2 }],
    });
    // A line-itemized credit note (the W5c allocator's shape).
    await seedCreditNote(t, c.id, {
      amount: 15,
      invoiceId: invoice.id,
      createdAt: new Date("2026-06-15T15:00:00Z"),
      items: [{ invoiceItemId: items[0].id, amount: 15, qty: 1.5 }],
    });

    const tenantNet = await fetchAccrualNetSales(prisma, t, {
      gte: new Date("2026-06-01T00:00:00Z"),
      lte: new Date("2026-06-30T23:59:59.999Z"),
    });
    expect(tenantNet).toEqual({ gross: 100, creditNotes: 45, externalRefunds: 20, net: 35 });

    const res = await asTenant(t, () =>
      insights.getProductInsights(p.id, { from: "2026-06-01", to: "2026-06-30" }),
    );
    expect(res.totals).toMatchObject({
      lineGross: 100,
      attributedCredits: 15, // exactly the CreditNoteItem.amount
      lineNet: 85,
      unattributedCredits: 50, // the lump-sum note 30 + the standard refund 20, each ONCE
      invoicedQtyPieces: 10,
      returnedQtyPieces: 5, // 3 (netted by its note) + 2 (netted by the refund)
      netQtyPieces: 5,
    });

    const split = await asTenant(t, () =>
      facts.tenantCreditBreakdown(t, {
        gte: new Date("2026-06-01T00:00:00Z"),
        lt: new Date("2026-07-01T00:00:00Z"),
      }),
    );
    expect(split.byProduct.get(p.id)).toBe(15);
    expect(split.unattributed).toBe(50);
    expect(split.creditNotes + split.externalRefunds).toBe(
      tenantNet.creditNotes + tenantNet.externalRefunds,
    );
  });

  it("E1b B665: a STANDARD return typed against a box-unaware boxed line is reported unresolved, never counted as pieces", async () => {
    const t = await seedTenant("e1b");
    const c = await seedCustomer(t, "e1b");
    const p = await seedProduct(t, "e1b", { unitsPerBox: 12 });
    const order = await seedOrder(t, c.id);
    // qty 3 with no split on a product boxed by 12: 3 BOXES or 3 pieces? No invoice line says.
    await seedOrderItem(t, order.id, { productId: p.id, qty: 3, subtotal: 90 });
    await seedInvoice(t, c.id, {
      issueDate: "2026-06-05",
      orderId: order.id,
      lines: [{ productId: p.id, qty: 36, subtotal: 90, boxes: 3, pieces: 0, unitsPerBox: 12 }],
    });
    await seedReturn(t, c.id, order.id, {
      refundMethod: "EXTERNAL_REFUND",
      refundAmount: 30,
      refundedAt: new Date("2026-06-12T15:00:00Z"),
      items: [{ productId: p.id, qty: 1 }],
    });

    const res = await asTenant(t, () =>
      insights.getProductInsights(p.id, { from: "2026-06-01", to: "2026-06-30" }),
    );
    expect(res.totals).toMatchObject({
      returnedQtyPieces: 0,
      unresolvedReturnLines: 1,
      unattributedCredits: 30, // the money still nets (footnote), only the pieces are unknown
    });
  });

  it("E1c SA-289: every line-itemized credit attributes through its items — an ordinary-product line (trackedCategoryId NULL) exactly like a regulated one", async () => {
    const t = await seedTenant("e1c");
    const c = await seedCustomer(t, "e1c");
    const ordinary = await seedProduct(t, "e1c-ord");
    const regulated = await seedProduct(t, "e1c-reg");
    const { invoice, items } = await seedInvoice(t, c.id, {
      issueDate: "2026-06-05",
      lines: [
        { productId: ordinary.id, qty: 10, subtotal: 100 },
        { productId: regulated.id, qty: 4, subtotal: 80 },
      ],
    });
    await seedCreditNote(t, c.id, {
      amount: 30,
      invoiceId: invoice.id,
      createdAt: new Date("2026-06-10T15:00:00Z"),
      items: [
        { invoiceItemId: items[0].id, amount: 12, trackedCategoryId: null },
        // A plain id: CreditNoteItem.trackedCategoryId carries no relation.
        { invoiceItemId: items[1].id, amount: 18, trackedCategoryId: `cat-${RUN}` },
      ],
    });

    const [ord, reg] = await asTenant(t, () =>
      Promise.all([
        insights.getProductInsights(ordinary.id, { from: "2026-06-01", to: "2026-06-30" }),
        insights.getProductInsights(regulated.id, { from: "2026-06-01", to: "2026-06-30" }),
      ]),
    );
    expect(ord.totals).toMatchObject({
      attributedCredits: 12,
      lineNet: 88,
      unattributedCredits: 0,
    });
    expect(reg.totals).toMatchObject({
      attributedCredits: 18,
      lineNet: 62,
      unattributedCredits: 0,
    });
    const page = await asTenant(t, () =>
      insights.getProductSalesPage(ordinary.id, { from: "2026-06-01", to: "2026-06-30" }),
    );
    expect(page.lines[0]).toMatchObject({ lineId: items[0].id, creditedAmount: 12 });
  });

  it("E1d bounded returns read: a credit-note return whose note is OUTSIDE the window changes no figure; one whose note is inside still nets, whatever its refundedAt says", async () => {
    const t = await seedTenant("e1d");
    const c = await seedCustomer(t, "e1d");
    const p = await seedProduct(t, "e1d");
    const order = await seedOrder(t, c.id);
    await seedOrderItem(t, order.id, { productId: p.id, qty: 10, subtotal: 100 });
    const { invoice } = await seedInvoice(t, c.id, {
      issueDate: "2026-06-05",
      orderId: order.id,
      lines: [{ productId: p.id, qty: 10, subtotal: 100 }],
    });
    const june = { from: "2026-06-01", to: "2026-06-30" };
    const read = () => asTenant(t, () => insights.getProductInsights(p.id, june));
    const base = await read();

    // OUTSIDE: its note was created in May (a legacy row with no refundedAt).
    const may = await seedCreditNote(t, c.id, {
      amount: 7,
      invoiceId: invoice.id,
      createdAt: new Date("2026-05-20T15:00:00Z"),
    });
    await seedReturn(t, c.id, order.id, {
      refundMethod: "CREDIT_NOTE",
      refundAmount: 7,
      refundedAt: null,
      creditNoteId: may.id,
      items: [{ productId: p.id, qty: 4 }],
    });
    const afterOutside = await read();
    expect(afterOutside.totals).toEqual(base.totals);
    expect(afterOutside.series).toEqual(base.series);
    expect(afterOutside.buyers).toEqual(base.buyers);

    // INSIDE: its note was created in June — it nets, even with no refundedAt on the return.
    const standalone = await seedCreditNote(t, c.id, {
      amount: 9,
      invoiceId: null, // the inline-return shape: a standalone note
      createdAt: new Date("2026-06-20T15:00:00Z"),
    });
    await seedReturn(t, c.id, order.id, {
      refundMethod: "CREDIT_NOTE",
      refundAmount: 9,
      refundedAt: null,
      creditNoteId: standalone.id,
      items: [{ productId: p.id, qty: 2 }],
    });
    const afterInside = await read();
    expect(afterInside.totals).toMatchObject({
      returnedQtyPieces: base.totals.returnedQtyPieces + 2,
      netQtyPieces: base.totals.netQtyPieces - 2,
      unattributedCredits: base.totals.unattributedCredits + 9,
      lineNet: base.totals.lineNet, // amount-only: beside the net, never subtracted
    });
  });

  it("E2 reconciliation identities: Σ product gross + unlisted + shipping − header discount = tenant gross; attributed + unattributed = tenant credits", async () => {
    const t = await seedTenant("e2");
    const c = await seedCustomer(t, "e2");
    const p1 = await seedProduct(t, "e2a");
    const p2 = await seedProduct(t, "e2b");
    const order = await seedOrder(t, c.id);
    const a = await seedInvoice(t, c.id, {
      issueDate: "2026-06-03",
      orderId: order.id,
      discount: 5,
      shippingFee: 8,
      taxAmount: 6,
      lines: [
        { productId: p1.id, qty: 4, subtotal: 40 },
        { productId: p2.id, qty: 5, subtotal: 25 },
        { productId: null, qty: 1, subtotal: 10 }, // unlisted (ad-hoc) line
      ],
    });
    await seedInvoice(t, c.id, {
      issueDate: "2026-06-20",
      lines: [{ productId: p1.id, qty: 2, subtotal: 20 }],
    });
    // An item-less note, a note split across a listed and an unlisted line, an INLINE refund.
    await seedCreditNote(t, c.id, {
      amount: 12,
      invoiceId: a.invoice.id,
      createdAt: new Date("2026-06-11T12:00:00Z"),
    });
    await seedCreditNote(t, c.id, {
      amount: 8,
      invoiceId: a.invoice.id,
      createdAt: new Date("2026-06-12T12:00:00Z"),
      items: [
        { invoiceItemId: a.items[1].id, amount: 5 },
        { invoiceItemId: a.items[2].id, amount: 3 },
      ],
    });
    await seedReturn(t, c.id, order.id, {
      kind: "INLINE",
      refundMethod: "EXTERNAL_REFUND",
      refundAmount: 4.4, // 4.00 line + 0.40 tax
      refundedAt: new Date("2026-06-14T12:00:00Z"),
      items: [{ productId: p1.id, qty: 1, subtotal: 4, sourceInvoiceItemId: a.items[0].id }],
    });

    const june = {
      gte: new Date("2026-06-01T00:00:00Z"),
      lte: new Date("2026-06-30T23:59:59.999Z"),
    };
    const tenantNet = await fetchAccrualNetSales(prisma, t, june);
    expect(tenantNet).toEqual({ gross: 98, creditNotes: 20, externalRefunds: 4.4, net: 73.6 });

    const [r1, r2, gross, credits] = await asTenant(t, async () =>
      Promise.all([
        insights.getProductInsights(p1.id, { from: "2026-06-01", to: "2026-06-30" }),
        insights.getProductInsights(p2.id, { from: "2026-06-01", to: "2026-06-30" }),
        facts.tenantGrossBreakdown(t, facts.issueWindow("2026-06-01", "2026-06-30")),
        facts.tenantCreditBreakdown(t, facts.instantWindow("2026-06-01", "2026-06-30", "UTC")),
      ]),
    );

    // Gross identity, through the product endpoints themselves.
    const productGross = r1.totals.lineGross + r2.totals.lineGross;
    expect(productGross).toBe(85);
    expect(productGross + gross.unlisted + gross.shipping - gross.headerDiscount).toBe(
      tenantNet.gross,
    );
    expect(gross.gross).toBe(tenantNet.gross);

    // Credit identity: attributed (per product) + unlisted lines + unattributed = the tenant's
    // two credit terms.
    expect(r1.totals.attributedCredits).toBe(4);
    expect(r2.totals.attributedCredits).toBe(5);
    expect(credits.byProduct.get(p1.id)).toBe(4);
    expect(credits.byProduct.get(p2.id)).toBe(5);
    expect(credits.unlisted).toBe(3); // an item on the unlisted line: attributed, to no product
    expect(credits.unattributed).toBe(12.4); // 12 item-less + 0.40 INLINE tax — amount-only
    expect(
      Math.round(
        (r1.totals.attributedCredits +
          r2.totals.attributedCredits +
          credits.unlisted +
          credits.unattributed) *
          100,
      ) / 100,
    ).toBe(Math.round((tenantNet.creditNotes + tenantNet.externalRefunds) * 100) / 100);
    // SA-289: a product's footnote carries only amount-only credits — p2's is the item-less 12,
    // never the 3 its note put on the unlisted line.
    expect(r2.totals.unattributedCredits).toBe(12);
  });

  it("E3 partial invoices: one order billed on two invoices counts each line once and one purchase event", async () => {
    const t = await seedTenant("e3");
    const c = await seedCustomer(t, "e3");
    const p = await seedProduct(t, "e3");
    const order = await seedOrder(t, c.id);
    await seedInvoice(t, c.id, {
      issueDate: "2026-05-02",
      orderId: order.id,
      lines: [{ productId: p.id, qty: 12, subtotal: 36 }],
    });
    await seedInvoice(t, c.id, {
      issueDate: "2026-05-09",
      orderId: order.id,
      lines: [{ productId: p.id, qty: 8, subtotal: 24 }],
    });

    const res = await asTenant(t, () =>
      insights.getProductInsights(p.id, { from: "2026-05-01", to: "2026-05-31" }),
    );
    expect(res.totals).toMatchObject({
      invoicedQtyPieces: 20,
      lineGross: 60,
      invoices: 2,
      orders: 1,
      buyers: 1,
    });
    expect(res.buyers[0]).toMatchObject({ customerId: c.id, orders: 1, qtyPieces: 20 });
    const page = await asTenant(t, () =>
      insights.getProductSalesPage(p.id, { from: "2026-05-01", to: "2026-05-31" }),
    );
    expect(page.lines.map((l) => l.qty)).toEqual([8, 12]);
  });

  it("E4 null-tenant lines: a nested-write line with tenantId NULL under this tenant's invoice counts; another tenant's invoice never does", async () => {
    const restore = await relaxTenantIdGuards(pg, ["InvoiceItem"]);
    try {
      const t1 = await seedTenant("e4a");
      const t2 = await seedTenant("e4b");
      const c1 = await seedCustomer(t1, "e4a");
      const c2 = await seedCustomer(t2, "e4b");
      const p = await seedProduct(t1, "e4");
      await seedInvoice(t1, c1.id, {
        issueDate: "2026-04-10",
        lines: [
          { productId: p.id, qty: 5, subtotal: 50, tenantId: null }, // legacy nested-write shape
          { productId: p.id, qty: 1, subtotal: 10 },
        ],
      });
      // Cross-tenant probe: another tenant's invoice pointing at this product id.
      await seedInvoice(t2, c2.id, {
        issueDate: "2026-04-11",
        lines: [{ productId: p.id, qty: 99, subtotal: 990 }],
      });

      const res = await asTenant(t1, () =>
        insights.getProductInsights(p.id, { from: "2026-04-01", to: "2026-04-30" }),
      );
      expect(res.totals).toMatchObject({
        invoicedQtyPieces: 6,
        lineGross: 60,
        invoices: 1,
        buyers: 1,
      });
      const page = await asTenant(t1, () =>
        insights.getProductSalesPage(p.id, { from: "2026-04-01", to: "2026-04-30" }),
      );
      expect(page.lines).toHaveLength(2);
      // And from the other tenant, the product does not exist.
      await expect(
        asTenant(t2, () =>
          insights.getProductInsights(p.id, { from: "2026-04-01", to: "2026-04-30" }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await restore();
    }
  });

  it("E5 deactivated product, soft-deleted customer and a merged buyer account: history stays reachable by id and unchanged", async () => {
    const t = await seedTenant("e5");
    const c = await seedCustomer(t, "e5", { deletedAt: new Date("2026-07-01T00:00:00Z") });
    const p = await seedProduct(t, "e5", { isActive: false });
    await seedInvoice(t, c.id, {
      issueDate: "2026-03-03",
      lines: [{ productId: p.id, qty: 7, subtotal: 70 }],
    });

    const before = await asTenant(t, () =>
      insights.getProductInsights(p.id, { from: "2026-03-01", to: "2026-03-31" }),
    );
    expect(before.product.isActive).toBe(false);
    expect(before.totals.lineGross).toBe(70);
    expect(before.buyers[0]).toMatchObject({ customerId: c.id, name: "Acme e5" });

    // A buyer-account merge moves the portal LINK, never the invoices.
    const primary = await prisma.buyerAccount.create({
      data: {
        email: `p-${RUN}-${randomUUID().slice(0, 6)}@example.invalid`,
        passwordHash: "x",
        name: "Primary",
      },
    });
    const secondary = await prisma.buyerAccount.create({
      data: {
        email: `s-${RUN}-${randomUUID().slice(0, 6)}@example.invalid`,
        passwordHash: "x",
        name: "Secondary",
      },
    });
    buyerAccountIds.push(primary.id, secondary.id);
    await prisma.customerLink.create({
      data: { tenantId: t, customerId: c.id, buyerAccountId: secondary.id, status: "ACTIVE" },
    });
    await prisma.customerLink.update({
      where: { customerId: c.id },
      data: { buyerAccountId: primary.id },
    });
    await prisma.buyerAccount.update({
      where: { id: secondary.id },
      data: { mergedIntoId: primary.id },
    });

    const after = await asTenant(t, () =>
      insights.getProductInsights(p.id, { from: "2026-03-01", to: "2026-03-31" }),
    );
    expect(after.series).toEqual(before.series);
    expect(after.totals).toEqual(before.totals);
  });

  it("E6 boxed, unit and legacy pack lines: per-piece prices exact, legacy lines out of selling units, mixed packs flagged", async () => {
    const t = await seedTenant("e6");
    const c = await seedCustomer(t, "e6");
    const p = await seedProduct(t, "e6", { unitsPerBox: 12 });
    await seedInvoice(t, c.id, {
      issueDate: "2026-02-02",
      lines: [
        {
          productId: p.id,
          qty: 27,
          subtotal: 67.5,
          unitPrice: 30,
          boxes: 2,
          pieces: 3,
          unitsPerBox: 12,
        }, // 2.25 boxes at $30
        { productId: p.id, qty: 6, subtotal: 18, unitPrice: 3, unitsPerBox: 1, unitLabel: "each" }, // factor-1 unit
        { productId: p.id, qty: 10, subtotal: 25, unitPrice: 2.5 }, // no snapshot, boxed today: legacy
      ],
    });

    const res = await asTenant(t, () =>
      insights.getProductInsights(p.id, { from: "2026-02-01", to: "2026-02-28" }),
    );
    expect(res.totals).toMatchObject({
      invoicedQtyPieces: 33, // 27 + 6 — the legacy line's pieces are unknown (10 boxes or 10 pieces?)
      unresolvedSaleLines: 1,
      sellingUnits: 8.25, // 27/12 + 6/1 — the legacy line is excluded
      legacyLines: 1,
      mixedPackSizes: true,
      sellingUnitPack: null,
      lineGross: 110.5, // its revenue still counts
    });
    expect(res.price).toMatchObject({
      avgPerPiece: 2.59, // (67.5 + 18) / 33 — never the legacy line's bare qty
      minPerPiece: 2.5, // 67.5/27 — never the $30 box price
      maxPerPiece: 3,
    });
  });

  it("E6b pack-snapshot rule on real rows: a stored line's own snapshot decides, never today's product pack", async () => {
    const t = await seedTenant("e6b");
    const c = await seedCustomer(t, "e6b");
    // Boxed by 12 when sold; NOT boxed today.
    const p = await seedProduct(t, "e6b", { unitsPerBox: null });
    await seedInvoice(t, c.id, {
      issueDate: "2026-02-02",
      lines: [
        // B644 shape: snapshot 12, no split — qty 3 may be 3 boxes. Unknown, whatever today says.
        { productId: p.id, qty: 3, subtotal: 90, unitPrice: 30, unitsPerBox: 12 },
        {
          productId: p.id,
          qty: 24,
          subtotal: 60,
          unitPrice: 30,
          boxes: 2,
          pieces: 0,
          unitsPerBox: 12,
        },
      ],
    });

    const res = await asTenant(t, () =>
      insights.getProductInsights(p.id, { from: "2026-02-01", to: "2026-02-28" }),
    );
    expect(res.totals).toMatchObject({
      invoicedQtyPieces: 24,
      unresolvedSaleLines: 1,
      lineGross: 150,
    });
    expect(res.price).toMatchObject({ avgPerPiece: 2.5, minPerPiece: 2.5, maxPerPiece: 2.5 });
    const page = await asTenant(t, () =>
      insights.getProductSalesPage(p.id, { from: "2026-02-01", to: "2026-02-28" }),
    );
    expect(page.lines.map((l) => [l.qty, l.perPiece])).toEqual(
      expect.arrayContaining([
        [3, null],
        [24, 2.5],
      ]),
    );
  });

  it("E7 written-off invoices are sales, badged; REAL_INVOICE_STATUSES callers are untouched", async () => {
    const t = await seedTenant("e7");
    const c = await seedCustomer(t, "e7");
    const p = await seedProduct(t, "e7");
    await seedInvoice(t, c.id, {
      issueDate: "2026-01-10",
      status: "WRITTEN_OFF",
      lines: [{ productId: p.id, qty: 4, subtotal: 40 }],
    });
    await seedInvoice(t, c.id, {
      issueDate: "2026-01-11",
      status: "VOID",
      lines: [{ productId: p.id, qty: 9, subtotal: 90 }],
    });
    await seedInvoice(t, c.id, {
      issueDate: "2026-01-12",
      status: "DRAFT",
      lines: [{ productId: p.id, qty: 9, subtotal: 90 }],
    });

    const res = await asTenant(t, () =>
      insights.getProductInsights(p.id, { from: "2026-01-01", to: "2026-01-31" }),
    );
    expect(res.totals).toMatchObject({ lineGross: 40, invoicedQtyPieces: 4 });
    const page = await asTenant(t, () =>
      insights.getProductSalesPage(p.id, { from: "2026-01-01", to: "2026-01-31" }),
    );
    expect(page.lines).toHaveLength(1);
    expect(page.lines[0].writtenOff).toBe(true);

    const cogsLines = await asTenant(t, () =>
      fetchInvoicedSaleLines(prisma.forTenant(), {
        from: stamp("2026-01-01"),
        to: new Date("2026-01-31T23:59:59.999Z"),
        dateBasis: "issueDate",
      }),
    );
    expect(cogsLines).toEqual([]); // the forecasting/COGS predicate still excludes WRITTEN_OFF
  });

  it("E8 month and DST edges (America/New_York): a T00:00Z stamp on the 1st is that month; a credit at 23:30 local on the 31st is that month; both window edges hold", async () => {
    const t = await seedTenant("e8", "America/New_York");
    const c = await seedCustomer(t, "e8");
    const p = await seedProduct(t, "e8");
    const { invoice, items } = await seedInvoice(t, c.id, {
      issueDate: "2026-11-01", // stored 2026-11-01T00:00Z — November, whatever the zone
      lines: [{ productId: p.id, qty: 10, subtotal: 100 }],
    });
    // Line-itemized notes always carry their source invoice (the writer refuses items without one).
    const note = (amount: number, at: string) =>
      seedCreditNote(t, c.id, {
        amount,
        invoiceId: invoice.id,
        createdAt: new Date(at),
        items: [{ invoiceItemId: items[0].id, amount }],
      });
    await note(1, "2026-10-01T03:59:00Z"); // Sep 30 23:59 EDT — before the window
    await note(2, "2026-10-01T04:00:00Z"); // Oct 1 00:00 EDT — first instant IN
    await note(3, "2026-11-01T03:30:00Z"); // Oct 31 23:30 EDT — October (a UTC key says November)
    await note(4, "2026-11-01T04:30:00Z"); // Nov 1 00:30 EDT — November
    await note(5, "2026-12-01T04:59:00Z"); // Nov 30 23:59 EST (after the DST change) — IN
    await note(6, "2026-12-01T05:00:00Z"); // Dec 1 00:00 EST — first instant OUT

    const res = await asTenant(t, () =>
      insights.getProductInsights(p.id, { from: "2026-10-01", to: "2026-11-30", grain: "month" }),
    );
    expect(res.series.map((s) => [s.date, s.lineGross, s.credits])).toEqual([
      ["2026-10-01", 0, 5], // 2 + 3
      ["2026-11-01", 100, 9], // 4 + 5
    ]);
    expect(res.totals.attributedCredits).toBe(14);
  });

  it("E9 paging: 3 invoices × 2 lines with limit 4 → 4 lines and a cursor; the cursor returns the last 2, no line twice", async () => {
    const t = await seedTenant("e9");
    const c = await seedCustomer(t, "e9");
    const p = await seedProduct(t, "e9");
    for (const d of ["2026-08-01", "2026-08-02", "2026-08-03"]) {
      // eslint-disable-next-line no-await-in-loop
      await seedInvoice(t, c.id, {
        issueDate: d,
        lines: [
          { productId: p.id, qty: 1, subtotal: 1 },
          { productId: p.id, qty: 2, subtotal: 2 },
        ],
      });
    }
    const q = { from: "2026-08-01", to: "2026-08-31", limit: 4 };
    const page1 = await asTenant(t, () => insights.getProductSalesPage(p.id, q));
    expect(page1.lines).toHaveLength(4);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await asTenant(t, () =>
      insights.getProductSalesPage(p.id, { ...q, cursor: page1.nextCursor as string }),
    );
    expect(page2.lines).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();

    const all = [...page1.lines, ...page2.lines];
    expect(new Set(all.map((l) => l.lineId)).size).toBe(6);
    // Newest first: issue day desc, then the later-entered line first.
    expect(all.map((l) => `${l.date.slice(0, 10)}:${l.qty}`)).toEqual([
      "2026-08-03:2",
      "2026-08-03:1",
      "2026-08-02:2",
      "2026-08-02:1",
      "2026-08-01:2",
      "2026-08-01:1",
    ]);

    // A page boundary INSIDE an invoice (limit 3) also never repeats or skips a line.
    const a = await asTenant(t, () => insights.getProductSalesPage(p.id, { ...q, limit: 3 }));
    const b = await asTenant(t, () =>
      insights.getProductSalesPage(p.id, { ...q, limit: 3, cursor: a.nextCursor as string }),
    );
    expect([...a.lines, ...b.lines].map((l) => l.lineId)).toEqual(all.map((l) => l.lineId));
    expect(b.nextCursor).toBeNull();
  });

  it("E9b SA-289 ordering: lines written in one statement (identical createdAt) on invoices tied on issue day AND entry time — every page size walks every line exactly once, in one fixed order", async () => {
    const t = await seedTenant("e9b");
    const c = await seedCustomer(t, "e9b");
    const p = await seedProduct(t, "e9b");
    const same = new Date("2026-08-10T12:00:00.000Z");
    for (let n = 0; n < 3; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      await seedInvoice(t, c.id, {
        issueDate: "2026-08-10",
        createdAt: same, // invoice-level tie → decided by invoice id
        lineCreatedAt: same, // line-level tie → decided by line id
        lines: [1, 2, 3].map((k) => ({ productId: p.id, qty: k, subtotal: k })),
      });
    }
    const q = { from: "2026-08-01", to: "2026-08-31" };
    const whole = await asTenant(t, () => insights.getProductSalesPage(p.id, { ...q, limit: 500 }));
    expect(whole.lines).toHaveLength(9);
    expect(whole.nextCursor).toBeNull();
    const order = whole.lines.map((l) => l.lineId);
    expect(new Set(order).size).toBe(9);

    for (const limit of [1, 2, 4, 8]) {
      const walked: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 20; guard += 1) {
        // eslint-disable-next-line no-await-in-loop
        const page = await asTenant(t, () =>
          insights.getProductSalesPage(p.id, { ...q, limit, cursor }),
        );
        walked.push(...page.lines.map((l) => l.lineId));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      // Never overlaps, never skips, and every page size agrees on ONE order.
      expect(walked).toEqual(order);
    }

    // The CSV walks the same key: one row per line, same count.
    const text = await asTenant(t, async () => {
      const { csv } = await insights.prepareCsvExport(p.id, q);
      let out = "";
      for await (const chunk of csv) out += chunk;
      return out;
    });
    expect(text.split("\r\n").filter((r) => r.startsWith("2026-08-10,"))).toHaveLength(9);
  });

  it("legacy delegates keep their shapes on real data: product-sales counts LINES, demand buckets invoiced pieces", async () => {
    const t = await seedTenant("legacy");
    const c = await seedCustomer(t, "legacy");
    const p = await seedProduct(t, "legacy");
    // One invoice carrying the product on THREE lines: `limit` must count lines, not invoices.
    await seedInvoice(t, c.id, {
      issueDate: "2026-09-01",
      lines: [
        { productId: p.id, qty: 1, subtotal: 1 },
        { productId: p.id, qty: 2, subtotal: 2 },
        { productId: p.id, qty: 3, subtotal: 3 },
      ],
    });
    const history = await asTenant(t, () => insights.getSalesHistory(p.id, 2));
    expect(history.lines).toHaveLength(2);
    expect(history.summary).toMatchObject({ count: 2, totalQty: 5, totalRevenue: 5 });
  });
});
