/**
 * B1120 — real-Postgres proof that `applyPriceAdjustment` stores a WHOLE-CENT unit price and a line total
 * equal to qty x that price. A typed 8.355 used to be stored by numeric(10,2) as 8.36 while the line total
 * was computed from the raw 8.355 (6 x $8.36 read $50.13, not $50.16), and the next adjust recovered the
 * multiplier as 50.13 / 8.36 = 5.9964 and drifted again. Every figure below is a real SELECT of the rows the
 * production writer committed (the stored text, so the column's scale is visible), never the writer's own
 * return value.
 *
 * Real: PrismaService, InvoicesService, the regulated ledger. Stubbed collaborators are the set every
 * invoices DB spec stubs, none of which the adjustment's money depends on.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Every tenant is a throwaway
 * `qa-b1120-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order in afterAll.
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));
import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { BadRequestException } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("price adjustments keep whole-cent unit prices and exact line totals (B1120)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoices: InvoicesService;
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const mod = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        EstimatesService,
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: RouteFlowGateway,
          useValue: {
            emitInvoiceUpdated: jest.fn(),
            emitOrderCreated: jest.fn(),
            emitOrderStatusChanged: jest.fn(),
            emitLowStock: jest.fn(),
            emitStopCompleted: jest.fn(),
            emitUrgentOrder: jest.fn(),
          },
        },
        {
          provide: EmailService,
          useValue: {
            sendInvoice: jest.fn(),
            isEmailConfigured: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
        },
        RegulatedLedgerService,
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        {
          provide: CreditNotesService,
          useValue: {
            autoApplyOldestCreditsInTx: jest
              .fn()
              .mockResolvedValue({ applied: 0, invoiceStatus: null }),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: MessagingService,
          useValue: { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() },
        },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
        },
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
        },
        entitlementAuthorityFromEntitlements, // #2241
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    invoices = mod.get(InvoicesService);
  });

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.regulatedSalesLedger.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.orderItem.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.trackedCategory.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  /**
   * One seeded invoice line, written as the stored row (so a legacy shape, such as a box split with no
   * pack snapshot, can be planted exactly). Every invoice a spec seeds is SENT and untaxed unless the line
   * says otherwise; a part payment is recorded afterwards through the production `recordPayment` writer.
   */
  type Line = {
    qty: number;
    unitPrice: number;
    subtotal: number;
    taxRate?: number;
    boxes?: number | null;
    pieces?: number | null;
    unitsPerBox?: number | null;
    unitLabel?: string | null;
    promoFreeUnits?: number | null;
    discount?: number;
  };

  /** One customer, one product, N SENT invoices (each with the given lines): the bulk scope's batch. */
  async function seed(label: string, perInvoice: Line[][], opts: { categoryRate?: number } = {}) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-b1120-${RUN}-${seq}-${label}`,
      "price-adjustment-whole-cents-b1120.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `B1120 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
    });
    const category =
      opts.categoryRate != null
        ? await prisma.trackedCategory.create({
            data: {
              tenantId,
              name: `cat ${label}`,
              taxType: "PERCENT_OF_SALE",
              rate: opts.categoryRate,
            },
          })
        : null;
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `p ${label}`,
        unit: "each",
        pricePerUnit: 10,
        trackedCategoryId: category?.id ?? null,
      },
    });
    const rows: Array<{ invoiceId: string; lineIds: string[] }> = [];
    for (const [n, lines] of perInvoice.entries()) {
      const subtotal = lines.reduce((s, l) => s + l.subtotal, 0);
      const tax = lines.reduce((s, l) => s + l.subtotal * (l.taxRate ?? 0), 0);
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          invoiceNumber: `INV-B1120-${RUN}-${seq}-${n + 1}`,
          status: "SENT",
          subtotal,
          taxAmount: Math.round(tax * 100) / 100,
          total: subtotal + Math.round(tax * 100) / 100,
        },
      });
      const lineIds: string[] = [];
      for (const l of lines) {
        const row = await prisma.invoiceItem.create({
          data: {
            tenantId,
            invoiceId: invoice.id,
            productId: product.id,
            description: `p ${label}`,
            qty: l.qty,
            unitPrice: l.unitPrice,
            discount: l.discount ?? 0,
            taxRate: l.taxRate ?? 0,
            subtotal: l.subtotal,
            boxes: l.boxes ?? null,
            pieces: l.pieces ?? null,
            unitsPerBox: l.unitsPerBox ?? null,
            unitLabel: l.unitLabel ?? null,
            promoFreeUnits: l.promoFreeUnits ?? null,
            trackedCategoryId: category?.id ?? null,
          },
        });
        lineIds.push(row.id);
      }
      rows.push({ invoiceId: invoice.id, lineIds });
    }
    return { tenantId, rows };
  }
  type Seeded = Awaited<ReturnType<typeof seed>>;

  const single = (s: Seeded, prices: number[], invoice = 0) =>
    tenantCtx.run(s.tenantId, () =>
      invoices.applyPriceAdjustment(s.rows[invoice].invoiceId, {
        items: s.rows[invoice].lineIds.map((itemId, i) => ({ itemId, newUnitPrice: prices[i] })),
        scope: "SINGLE",
      } as any),
    );
  /** Re-prices the FIRST invoice's first line's product across every invoice of the customer. */
  const bulk = (s: Seeded, price: number) =>
    tenantCtx.run(s.tenantId, () =>
      invoices.applyPriceAdjustment(s.rows[0].invoiceId, {
        items: [{ itemId: s.rows[0].lineIds[0], newUnitPrice: price }],
        scope: "ALL_CUSTOMER_SINCE",
        sinceDate: "2000-01-01",
      } as any),
    );

  /** The persisted rows as TEXT, straight from Postgres: numeric(10,2) scale and all. */
  async function stored(invoiceId: string) {
    const lines = await prisma.$queryRaw<
      Array<{ id: string; unitPrice: string; subtotal: string; categoryTax: string }>
    >`SELECT id, "unitPrice"::text AS "unitPrice", "subtotal"::text AS "subtotal",
             "categoryTaxAmount"::text AS "categoryTax"
        FROM "InvoiceItem" WHERE "invoiceId" = ${invoiceId} ORDER BY id`;
    const [inv] = await prisma.$queryRaw<
      Array<{ subtotal: string; taxAmount: string; total: string }>
    >`SELECT "subtotal"::text AS "subtotal", "taxAmount"::text AS "taxAmount", "total"::text AS "total"
        FROM "Invoice" WHERE id = ${invoiceId}`;
    return { lines, invoice: inv };
  }
  const line = async (invoiceId: string, lineId: string) =>
    (await stored(invoiceId)).lines.find((l) => l.id === lineId)!;

  /** SQL-side invariant for LOOSE lines: price x qty - discount, rounded to cents, IS the stored subtotal. */
  async function lineTotalsDisagreeWithPrice(invoiceId: string): Promise<number> {
    const [r] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM "InvoiceItem"
       WHERE "invoiceId" = ${invoiceId}
         AND round("unitPrice" * "qty" - "discount", 2) <> "subtotal"`;
    return Number(r.n);
  }

  it("SINGLE 8.355 / 17.335 / 24.985: the rows hold 8.36, 17.34, 24.99 and qty x those prices", async () => {
    const s = await seed("single", [
      [
        { qty: 6, unitPrice: 10, subtotal: 60 },
        { qty: 3, unitPrice: 20, subtotal: 60 },
        { qty: 4, unitPrice: 30, subtotal: 120 },
      ],
    ]);

    await single(s, [8.355, 17.335, 24.985]);

    // today: 8.36 / 50.13, 17.34 / 52.01, 24.99 / 99.94 and an invoice of 202.08
    const after = await stored(s.rows[0].invoiceId);
    const byId = Object.fromEntries(after.lines.map((l) => [l.id, [l.unitPrice, l.subtotal]]));
    expect(s.rows[0].lineIds.map((id) => byId[id])).toEqual([
      ["8.36", "50.16"],
      ["17.34", "52.02"],
      ["24.99", "99.96"],
    ]);
    expect(after.invoice).toEqual({ subtotal: "202.14", taxAmount: "0.00", total: "202.14" });
    expect(await lineTotalsDisagreeWithPrice(s.rows[0].invoiceId)).toBe(0);
  });

  it("a SECOND adjust with the same typed prices changes no row and no total (no drift)", async () => {
    const s = await seed("repeat", [[{ qty: 6, unitPrice: 10, subtotal: 60 }]]);
    await single(s, [8.355]);
    const first = await stored(s.rows[0].invoiceId);
    expect(first.invoice.total).toBe("50.16");

    await single(s, [8.355]); // today: 8.355 x (50.13 / 8.36) = 50.10
    await single(s, [8.36]);
    await single(s, [8.36]);

    expect(await stored(s.rows[0].invoiceId)).toEqual(first);
  });

  it("BULK from a date: both invoices hold qty x 8.36, and a repeat of the bulk changes nothing", async () => {
    const s = await seed("bulk", [
      [{ qty: 6, unitPrice: 10, subtotal: 60 }],
      [{ qty: 3, unitPrice: 10, subtotal: 30 }],
    ]);

    await bulk(s, 8.355);

    const [a, b] = await Promise.all(s.rows.map((r) => stored(r.invoiceId)));
    expect(a.lines[0]).toMatchObject({ unitPrice: "8.36", subtotal: "50.16" });
    expect(b.lines[0]).toMatchObject({ unitPrice: "8.36", subtotal: "25.08" });
    expect([a.invoice.total, b.invoice.total]).toEqual(["50.16", "25.08"]);

    await bulk(s, 8.355);
    expect(await Promise.all(s.rows.map((r) => stored(r.invoiceId)))).toEqual([a, b]);
  });

  it("BULK at 9.99 over the rows the demo left drifted (8.36 / 50.13): 6 x 9.99 = 59.94 on both", async () => {
    const s = await seed("drifted", [
      [{ qty: 6, unitPrice: 8.36, subtotal: 50.13 }],
      [{ qty: 6, unitPrice: 8.36, subtotal: 50.13 }],
    ]);

    await bulk(s, 9.99);

    // today: 59.90 (9.99 x 5.9964) on both
    for (const r of s.rows) {
      const after = await stored(r.invoiceId);
      expect(after.lines[0]).toMatchObject({ unitPrice: "9.99", subtotal: "59.94" });
      expect(after.invoice.total).toBe("59.94");
      expect(await lineTotalsDisagreeWithPrice(r.invoiceId)).toBe(0);
    }
  });

  it("a regular-taxed line: the tax and the total are summed from the whole-cent line total", async () => {
    const s = await seed("taxed", [[{ qty: 6, unitPrice: 10, subtotal: 60, taxRate: 0.0825 }]]);

    await single(s, [8.355]);

    // 6 x 8.36 = 50.16; tax round(50.16 x 0.0825 = 4.1382) = 4.14; total 54.30
    expect((await stored(s.rows[0].invoiceId)).invoice).toEqual({
      subtotal: "50.16",
      taxAmount: "4.14",
      total: "54.30",
    });
  });

  it("a regulated line: the category tax follows the whole-cent line total", async () => {
    const s = await seed("regulated", [[{ qty: 6, unitPrice: 10, subtotal: 60 }]], {
      categoryRate: 0.1,
    });

    await single(s, [8.355]);

    const after = await stored(s.rows[0].invoiceId);
    expect(after.lines[0]).toMatchObject({
      unitPrice: "8.36",
      subtotal: "50.16",
      categoryTax: "5.02",
    });
    expect(after.invoice).toEqual({ subtotal: "50.16", taxAmount: "5.02", total: "55.18" });
  });

  it("a boxed line (12 per box, 1 box + 5 pieces): 10 -> 100 -> 0.50 -> 10 lands back on 14.17, never qty x price", async () => {
    const boxed = { qty: 17, boxes: 1, pieces: 5, unitsPerBox: 12 };
    const s = await seed("boxed", [[{ ...boxed, unitPrice: 10, subtotal: 14.17 }]]);
    const { invoiceId, lineIds } = s.rows[0];

    await single(s, [100]);
    expect(await line(invoiceId, lineIds[0])).toMatchObject({
      unitPrice: "100.00",
      subtotal: "141.67",
    }); // today 141.70
    await single(s, [0.5]);
    expect(await line(invoiceId, lineIds[0])).toMatchObject({
      unitPrice: "0.50",
      subtotal: "0.71",
    });
    await single(s, [10]);

    expect(await line(invoiceId, lineIds[0])).toMatchObject({
      unitPrice: "10.00",
      subtotal: "14.17",
    }); // today 14.20
    expect((await stored(invoiceId)).invoice.total).toBe("14.17");
  });

  it("a Case line (3 Cases of 12, priced per Case) and a BUY_N_GET_M line (12 boxes, 2 free) price exactly", async () => {
    const s = await seed("units", [
      [
        { qty: 36, boxes: 3, unitsPerBox: 12, unitLabel: "Case", unitPrice: 8, subtotal: 24 },
        {
          qty: 144,
          boxes: 12,
          pieces: 0,
          unitsPerBox: 12,
          promoFreeUnits: 2,
          unitPrice: 35,
          subtotal: 350,
        },
      ],
    ]);
    const { invoiceId, lineIds } = s.rows[0];

    await single(s, [7.99, 36]);

    expect(await line(invoiceId, lineIds[0])).toMatchObject({
      unitPrice: "7.99",
      subtotal: "23.97",
    });
    expect(await line(invoiceId, lineIds[1])).toMatchObject({
      unitPrice: "36.00",
      subtotal: "360.00",
    });
    expect((await stored(invoiceId)).invoice.total).toBe("383.97");
  });

  it("a PART-PAID invoice re-priced down stays PARTIAL, and its balance is the new total less what was paid, to the cent", async () => {
    const s = await seed("partpaid", [[{ qty: 6, unitPrice: 10, subtotal: 60 }]]);
    const { invoiceId } = s.rows[0];
    await tenantCtx.run(s.tenantId, () =>
      invoices.recordPayment(invoiceId, { amount: 20.01, method: "CASH" } as any),
    );
    const before = await tenantCtx.run(s.tenantId, () => invoices.findOne(invoiceId));
    expect(before).toMatchObject({ status: "PARTIAL", balanceDue: 39.99 }); // the production writer's own state

    await single(s, [8.355]); // typed 8.355 is stored as 8.36: 6 x 8.36 = 50.16

    const after = await tenantCtx.run(s.tenantId, () => invoices.findOne(invoiceId));
    const [row] = await prisma.$queryRaw<Array<{ status: string; total: string; paid: string }>>`
      SELECT i.status::text AS status, i."total"::text AS total,
             coalesce((SELECT sum(p.amount) FROM "InvoicePayment" p
                        WHERE p."invoiceId" = i.id AND p.status = 'PAID'), 0)::text AS paid
        FROM "Invoice" i WHERE i.id = ${invoiceId}`;
    expect(row).toEqual({ status: "PARTIAL", total: "50.16", paid: "20.01" });
    // the read path's balance is the stored total minus the confirmed cash, rounded to cents: 50.16 - 20.01
    expect(after).toMatchObject({ status: "PARTIAL", paidAmount: 20.01 });
    expect((after as any).balanceDue).toBe(roundMoney(Number(row.total) - Number(row.paid)));
    expect((after as any).balanceDue).toBe(30.15);
  });

  /**
   * The ONE line shape `buildPriceAdjustmentUpdates` cannot price from the line's own fields: a box split
   * with no pack anywhere (boxes 0, pieces 5, no unitsPerBox snapshot, so the pack is not derivable). It keeps
   * the proportional recovery `newSubtotal = round(newPrice x (storedSubtotal / oldPrice))`, which re-derives
   * its multiplier from an already-rounded subtotal on every call. So a round trip A -> B -> A is NOT exactly
   * the identity here. The bound: one step moves the multiplier by at most (1/2 cent) / B, so back at A the
   * subtotal is within (1/2 cent) x A / B + 1/2 cent of where it began, which is at most 1 cent whenever the
   * intermediate price B is at least half of A, and wider as B falls further below A. Pinned at 5.01 -> 3.01
   * -> 5.01, a pair where the drift is a real, whole cent (2.09 -> 2.10), never more. It applies only to this
   * legacy shape (update() refuses it through `unpackableSplit`, update-pack-resolution.ts, but a row stored
   * before that can still carry it); every other line prices from qty, boxes, pieces and pack through
   * computeLineSubtotal and round-trips exactly (the boxed case above).
   */
  it("a line with a box split but NO derivable pack: A -> B -> A drifts by at most 1 cent (B at least half of A)", async () => {
    const s = await seed("nopack", [
      [{ qty: 5, boxes: 0, pieces: 5, unitsPerBox: null, unitPrice: 5.01, subtotal: 2.09 }],
    ]);
    const { invoiceId, lineIds } = s.rows[0];

    await single(s, [3.01]);
    expect(await line(invoiceId, lineIds[0])).toMatchObject({
      unitPrice: "3.01",
      subtotal: "1.26",
    });
    await single(s, [5.01]);

    const back = await line(invoiceId, lineIds[0]);
    expect(back).toMatchObject({ unitPrice: "5.01", subtotal: "2.10" });
    expect(Math.abs(roundMoney(Number(back.subtotal) - 2.09))).toBeLessThanOrEqual(0.01);
    expect((await stored(invoiceId)).invoice.total).toBe("2.10");
  });

  /** Runs the adjustment and reports how it ended; the persisted rows are read afterwards, before anything else. */
  const attempt = (p: Promise<unknown>) =>
    p.then(
      () => "applied" as const,
      (e: unknown) => e,
    );
  const codeOf = (e: unknown): unknown =>
    ((e as BadRequestException).getResponse?.() as { code?: string } | undefined)?.code;

  /** qty 5 stored as boxes 0 + pieces 5 with no pack snapshot and none derivable: 5/12 of a case at $10 = $4.17. */
  const packless = (price: number, subtotal: number): Line => ({
    qty: 5,
    boxes: 0,
    pieces: 5,
    unitsPerBox: null,
    unitPrice: price,
    subtotal,
  });
  /** A second, plain line so the invoice total never reaches $0 (a $0 invoice settles to PAID and refuses re-prices). */
  const plain: Line = { qty: 1, unitPrice: 5, subtotal: 5 };

  it("a pack-less legacy row: 10 -> 0 -> 10 refuses the step up from $0 (400 MONEY_INVARIANT) and leaves the rows as they were", async () => {
    const s = await seed("packless0", [[packless(10, 4.17), plain]]);
    const { invoiceId, lineIds } = s.rows[0];
    expect(await line(invoiceId, lineIds[0])).toMatchObject({
      unitPrice: "10.00",
      subtotal: "4.17",
    });

    await single(s, [0, 5]);
    expect(await line(invoiceId, lineIds[0])).toMatchObject({
      unitPrice: "0.00",
      subtotal: "0.00",
    });
    const out = await attempt(single(s, [10, 5]));

    // persisted state first, so a red run names the wrong value: today the row lands at 10.00 / 50.00
    expect(await line(invoiceId, lineIds[0])).toMatchObject({
      unitPrice: "0.00",
      subtotal: "0.00",
    });
    expect((await stored(invoiceId)).invoice.total).toBe("5.00");
    expect(out).toBeInstanceOf(BadRequestException);
    expect(codeOf(out)).toBe("MONEY_INVARIANT");
    expect((out as Error).message).toContain("Re-enter this line's quantity and price");
  });

  it("a pack-less legacy row: 10 -> 0.01 -> 10 refuses the step up from a $0.00 total, never a $0.00 line at $10 forever", async () => {
    const s = await seed("packlesscent", [[packless(10, 4.17), plain]]);
    const { invoiceId, lineIds } = s.rows[0];

    await single(s, [0.01, 5]);
    expect(await line(invoiceId, lineIds[0])).toMatchObject({
      unitPrice: "0.01",
      subtotal: "0.00",
    }); // 0.0417 -> 0.00
    const out = await attempt(single(s, [10, 5]));

    // today: unitPrice 10.00 with subtotal 0.00, a line that bills nothing at a price of $10
    expect(await line(invoiceId, lineIds[0])).toMatchObject({
      unitPrice: "0.01",
      subtotal: "0.00",
    });
    expect(out).toBeInstanceOf(BadRequestException);
    expect(codeOf(out)).toBe("MONEY_INVARIANT");
  });

  it("a boxed line with a DERIVABLE pack: 10 -> 0 -> 10 restores $14.17 (master bills $170.00, 17 x $10)", async () => {
    const s = await seed("boxed0", [
      [{ qty: 17, boxes: 1, pieces: 5, unitsPerBox: 12, unitPrice: 10, subtotal: 14.17 }, plain],
    ]);
    const { invoiceId, lineIds } = s.rows[0];

    await single(s, [0, 5]);
    expect(await line(invoiceId, lineIds[0])).toMatchObject({
      unitPrice: "0.00",
      subtotal: "0.00",
    });
    await single(s, [10, 5]);

    expect(await line(invoiceId, lineIds[0])).toMatchObject({
      unitPrice: "10.00",
      subtotal: "14.17",
    });
    expect((await stored(invoiceId)).invoice.total).toBe("19.17");
  });

  it("BULK: a pack-less row at $0 on a LATER invoice refuses the whole batch (named, coded) and re-prices none of it", async () => {
    const s = await seed("packlessbulk", [
      [{ qty: 6, unitPrice: 10, subtotal: 60 }],
      [packless(0, 0), plain],
    ]);
    const [first, second] = s.rows;

    const out = await attempt(bulk(s, 9));

    // today both invoices are re-priced and the pack-less row lands at 9.00 / 45.00
    expect(await line(first.invoiceId, first.lineIds[0])).toMatchObject({
      unitPrice: "10.00",
      subtotal: "60.00",
    });
    expect(await line(second.invoiceId, second.lineIds[0])).toMatchObject({
      unitPrice: "0.00",
      subtotal: "0.00",
    });
    expect((await stored(first.invoiceId)).invoice.total).toBe("60.00");
    expect(out).toBeInstanceOf(BadRequestException);
    expect(codeOf(out)).toBe("MONEY_INVARIANT");
    expect((out as Error).message).toContain(`Invoice INV-B1120-${RUN}-`);
  });
});
