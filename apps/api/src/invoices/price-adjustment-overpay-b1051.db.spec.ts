/**
 * B1051 — real-Postgres proof that `applyPriceAdjustment` never writes a total BELOW the invoice's
 * CONFIRMED payments. A lower re-price on a PARTIAL invoice used to recompute straight to PAID while
 * the customer was overpaid: `balanceDue` floors at 0, so nothing anywhere said so. Re-pricing an
 * already-PAID invoice is refused ("issue a credit note instead"); a re-price that would MAKE the
 * invoice overpaid is the same act and is now refused the same way, whole (item writes roll back).
 *
 * Real: PrismaService, InvoicesService (recordPayment writes the payment and its status), the
 * regulated ledger. Stubbed collaborators are the set every invoices DB spec stubs, none of which the
 * adjustment's money depends on.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Every tenant is a throwaway
 * `qa-b1051-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order in afterAll.
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));
// A pass-through spy: the service still runs the REAL pre-flight; the spec reads the projected totals it returned.
jest.mock("./price-adjustment-ledger", () => {
  const actual = jest.requireActual("./price-adjustment-ledger");
  return { ...actual, preflightBulkPriceAdjustment: jest.fn(actual.preflightBulkPriceAdjustment) };
});

import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { BadRequestException } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import { InvoicesService } from "./invoices.service";
import { preflightBulkPriceAdjustment } from "./price-adjustment-ledger";
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

describeDb("a lower re-price never leaves an invoice overpaid or silently PAID (B1051)", () => {
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
   * A SENT $150.00 invoice (one line: 10 x $15.00, no tax) with `paid` of cash recorded through the
   * production `recordPayment` writer, which also derives the status (PARTIAL for a part payment).
   * `opts.second` seeds a second SENT $150.00 invoice for the same customer (bulk scope).
   */
  async function seedBase(label: string, opts: { categoryRate?: number } = {}) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-b1051-${RUN}-${seq}-${label}`,
      "price-adjustment-overpay-b1051.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `B1051 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
    });
    // A PERCENT_OF_SALE category (a fraction, 0.1 = 10%) makes the product's lines category-taxed.
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
        pricePerUnit: 15,
        trackedCategoryId: category?.id ?? null,
      },
    });
    const makeInvoice = async (n: number) => {
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          invoiceNumber: `INV-B1051-${RUN}-${seq}-${n}`,
          status: "SENT",
          subtotal: 150,
          taxAmount: 0,
          total: 150,
        },
      });
      const line = await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          productId: product.id,
          description: `p ${label}`,
          qty: 10,
          unitPrice: 15,
          taxRate: 0,
          subtotal: 150,
        },
      });
      return { invoiceId: invoice.id, lineId: line.id };
    };
    return {
      tenantId,
      customerId: customer.id,
      productId: product.id,
      categoryId: category?.id ?? null,
      makeInvoice,
    };
  }

  const pay = (tenantId: string, invoiceId: string, amount: number) =>
    tenantCtx.run(tenantId, () =>
      invoices.recordPayment(invoiceId, { amount, method: "CASH" } as any),
    );

  async function seed(label: string, paid: number, opts: { second?: boolean } = {}) {
    const base = await seedBase(label);
    const first = await base.makeInvoice(1);
    const second = opts.second ? await base.makeInvoice(2) : null;
    if (paid > 0) await pay(base.tenantId, first.invoiceId, paid);
    return { tenantId: base.tenantId, productId: base.productId, ...first, second };
  }

  /** One SENT $150.00 invoice per entry of `paid` (0 = unpaid), one customer: a bulk batch of N targets. */
  async function seedBatch(label: string, paid: number[]) {
    const base = await seedBase(label);
    const rows: Array<{ invoiceId: string; lineId: string; number: string }> = [];
    for (const [i, amount] of paid.entries()) {
      const row = await base.makeInvoice(i + 1);
      if (amount > 0) await pay(base.tenantId, row.invoiceId, amount);
      rows.push({ ...row, number: `INV-B1051-${RUN}-${seq}-${i + 1}` });
    }
    return { tenantId: base.tenantId, rows };
  }

  const reprice = (
    s: { tenantId: string; invoiceId: string; lineId: string },
    newUnitPrice: number,
  ) =>
    tenantCtx.run(s.tenantId, () =>
      invoices.applyPriceAdjustment(s.invoiceId, {
        items: [{ itemId: s.lineId, newUnitPrice }],
        scope: "SINGLE",
      } as any),
    );

  /** Run the adjustment and report how it ended; the persisted rows are read afterwards. */
  const attempt = (p: Promise<unknown>) =>
    p.then(
      () => "applied" as const,
      (e: unknown) => e,
    );

  const read = async (s: { invoiceId: string; lineId: string }) => {
    const inv = await prisma.invoice.findUnique({
      where: { id: s.invoiceId },
      include: { items: true },
    });
    return {
      status: inv!.status,
      total: Number(inv!.total),
      paidAt: inv!.paidAt,
      unitPrice: Number(inv!.items.find((i) => i.id === s.lineId)!.unitPrice),
      notes: inv!.internalNotes,
    };
  };

  it("REG-B1051: a $150 -> $80 re-price of a PARTIAL invoice with $100 paid is refused, not PAID", async () => {
    const s = await seed("overpay", 100);
    expect((await read(s)).status).toBe("PARTIAL"); // the production writer's own state

    const outcome = await attempt(reprice(s, 8)); // 10 x $8 = $80 < $100 already paid

    // Persisted state first, so a red run names the wrong value: today the invoice lands
    // status PAID / total 80 / paidAt set with $20 of the customer's money unaccounted for.
    const after = await read(s);
    expect(after.status).toBe("PARTIAL");
    expect(after.total).toBe(150);
    expect(after.paidAt).toBeNull();
    expect(after.unitPrice).toBe(15); // the line write rolled back with the refusal
    expect(after.notes).toBeNull(); // and so did the audit breadcrumb
    expect(outcome).toBeInstanceOf(BadRequestException);
    expect((outcome as Error).message).toContain("overpaid by $20.00");
    // B1058: the SINGLE-scope 400 carries the same one-entry list the bulk 400 does (the client renders from it).
    const number = (await prisma.invoice.findUnique({ where: { id: s.invoiceId } }))!.invoiceNumber;
    expect((outcome as BadRequestException).getResponse()).toMatchObject({
      code: "PRICE_ADJUSTMENT_OVERPAYS",
      overpaid: [
        { invoiceId: s.invoiceId, invoiceNumber: number, paid: 100, newTotal: 80, overpaidBy: 20 },
      ],
    });
  });

  it("pin: a re-price that lands EXACTLY on the paid amount ($100 paid, new total $100) settles PAID", async () => {
    const s = await seed("exact", 100);

    const outcome = await attempt(reprice(s, 10)); // 10 x $10 = $100

    expect(outcome).toBe("applied");
    const after = await read(s);
    expect(after.status).toBe("PAID");
    expect(after.total).toBe(100);
    expect(after.paidAt).toBeInstanceOf(Date);
  });

  it("pin: a lower re-price that stays above the paid amount ($60 paid, new total $80) stays PARTIAL", async () => {
    const s = await seed("above", 60);

    const outcome = await attempt(reprice(s, 8)); // 10 x $8 = $80 > $60

    expect(outcome).toBe("applied");
    const after = await read(s);
    expect(after.status).toBe("PARTIAL");
    expect(after.total).toBe(80);
    expect(after.paidAt).toBeNull();
  });

  it("pin: a re-price of an unpaid invoice is untouched by the guard ($0 paid, new total $80 -> SENT)", async () => {
    const s = await seed("unpaid", 0);

    const outcome = await attempt(reprice(s, 8));

    expect(outcome).toBe("applied");
    const after = await read(s);
    expect(after.status).toBe("SENT");
    expect(after.total).toBe(80);
  });

  /** The bulk request that re-prices the batch's first invoice's product to `newUnitPrice` across the customer. */
  const bulk = (
    b: { tenantId: string; rows: Array<{ invoiceId: string; lineId: string }> },
    p: number,
  ) =>
    tenantCtx.run(b.tenantId, () =>
      invoices.applyPriceAdjustment(b.rows[0].invoiceId, {
        items: [{ itemId: b.rows[0].lineId, newUnitPrice: p }],
        scope: "ALL_CUSTOMER_SINCE",
        sinceDate: "2000-01-01",
      } as any),
    );

  it("sibling: the bulk scope refuses the overpaying invoice too and leaves the batch whole", async () => {
    const s = await seed("bulk", 100, { second: true });
    // The second invoice has no payment: re-pricing it is fine. The first (PARTIAL, $100 paid)
    // would land at $80, so the WHOLE batch is refused before any write.
    const outcome = await attempt(
      tenantCtx.run(s.tenantId, () =>
        invoices.applyPriceAdjustment(s.invoiceId, {
          items: [{ itemId: s.lineId, newUnitPrice: 8 }],
          scope: "ALL_CUSTOMER_SINCE",
          sinceDate: "2000-01-01",
        } as any),
      ),
    );

    const first = await read(s);
    expect(first.status).toBe("PARTIAL");
    expect(first.total).toBe(150);
    expect(first.unitPrice).toBe(15);
    const second = await read({ invoiceId: s.second!.invoiceId, lineId: s.second!.lineId });
    expect(second.total).toBe(150); // the unpaid sibling was NOT re-priced either
    expect(second.unitPrice).toBe(15);
    expect(outcome).toBeInstanceOf(BadRequestException);
  });

  // B1058 (SA-683): five targets re-priced $150 -> $80. Invoices 2 and 4 are paid above $80.
  it("REG-B1058: 5 targets, invoices 2 and 4 overpay: ONE 400 lists both and the database is unchanged", async () => {
    const b = await seedBatch("five", [80, 100, 50, 90, 0]);
    const before = await Promise.all(b.rows.map(read));
    expect(before.map((r) => r.status)).toEqual([
      "PARTIAL",
      "PARTIAL",
      "PARTIAL",
      "PARTIAL",
      "SENT",
    ]);

    const outcome = await attempt(bulk(b, 8));

    // Persisted state first, so a red run names the wrong value (a committed prefix, or a PAID row).
    expect(await Promise.all(b.rows.map(read))).toEqual(before);
    expect(outcome).toBeInstanceOf(BadRequestException);
    const body = (outcome as BadRequestException).getResponse() as any;
    expect(body.code).toBe("PRICE_ADJUSTMENT_OVERPAYS");
    expect(body.overpaid).toEqual([
      {
        invoiceId: b.rows[1].invoiceId,
        invoiceNumber: b.rows[1].number,
        paid: 100,
        newTotal: 80,
        overpaidBy: 20,
      },
      {
        invoiceId: b.rows[3].invoiceId,
        invoiceNumber: b.rows[3].number,
        paid: 90,
        newTotal: 80,
        overpaidBy: 10,
      },
    ]);
    expect(body.message).toContain(`${b.rows[1].number} by $20.00`);
    expect(body.message).toContain(`${b.rows[3].number} by $10.00`);
  });

  it("pin: the same batch without the two offenders re-prices all five, settling the one paid exactly $80", async () => {
    const b = await seedBatch("five-ok", [80, 60, 50, 20, 0]);

    const outcome = await attempt(bulk(b, 8));

    expect(outcome).toBe("applied");
    const after = await Promise.all(b.rows.map(read));
    expect(after.map((r) => r.status)).toEqual(["PAID", "PARTIAL", "PARTIAL", "PARTIAL", "SENT"]);
    expect(after.map((r) => r.total)).toEqual([80, 80, 80, 80, 80]);
    expect(after.map((r) => r.unitPrice)).toEqual([8, 8, 8, 8, 8]);
  });

  // ── The pre-flight's PROJECTED total is the total the real run WRITES (B1058) ────────────────────
  // The overpay judgment is only as good as the total it compares against. Each case runs the REAL bulk
  // re-price through the service (real tenant client, real transactions); the spy above hands back what
  // the real pre-flight projected for each target, and the stored invoice total is read afterwards.
  describe("projected total == written total, to the cent", () => {
    const preflightSpy = preflightBulkPriceAdjustment as unknown as jest.Mock;

    /** What the pre-flight projected on the last real run, by invoice id (the spy wraps the real one). */
    const projectedOfLastRun = async (): Promise<ReadonlyMap<string, number>> =>
      preflightSpy.mock.results[preflightSpy.mock.results.length - 1].value;

    const rePrice = (tenantId: string, invoiceId: string, lineId: string, newUnitPrice: number) =>
      tenantCtx.run(tenantId, () =>
        invoices.applyPriceAdjustment(invoiceId, {
          items: [{ itemId: lineId, newUnitPrice }],
          scope: "ALL_CUSTOMER_SINCE",
          sinceDate: "2000-01-01",
        } as any),
      );

    const storedTotal = async (invoiceId: string) =>
      Number((await prisma.invoice.findUnique({ where: { id: invoiceId } }))!.total);

    /** A SENT invoice: 10 x $15.00 at a 5% regular tax and a 10% category tax (stored: 7.50 + 15.00 on 150.00). */
    async function categoryTaxedInvoice(
      b: Awaited<ReturnType<typeof seedBase>>,
      n: number,
      createdAt?: Date,
    ) {
      const invoice = await prisma.invoice.create({
        data: {
          tenantId: b.tenantId,
          customerId: b.customerId,
          invoiceNumber: `INV-B1058-${RUN}-${seq}-${n}`,
          status: "SENT",
          subtotal: 150,
          taxAmount: 22.5,
          total: 172.5,
          ...(createdAt ? { createdAt } : {}),
        },
      });
      const line = await prisma.invoiceItem.create({
        data: {
          tenantId: b.tenantId,
          invoiceId: invoice.id,
          productId: b.productId,
          description: "category taxed",
          qty: 10,
          unitPrice: 15,
          taxRate: 0.05,
          subtotal: 150,
          trackedCategoryId: b.categoryId,
          categoryTaxAmount: 15,
        },
      });
      return { invoiceId: invoice.id, lineId: line.id };
    }

    it("(1) a CATEGORY-TAXED line: the levy is re-derived from the new subtotal in the projection exactly as in the write", async () => {
      const b = await seedBase("cat", { categoryRate: 0.1 });
      const s = await categoryTaxedInvoice(b, 1);

      await rePrice(b.tenantId, s.invoiceId, s.lineId, 8.37); // 10 x 8.37 = 83.70

      const projected = (await projectedOfLastRun()).get(s.invoiceId)!;
      const inv = await prisma.invoice.findUnique({
        where: { id: s.invoiceId },
        include: { items: true },
      });
      const written = Number(inv!.total);
      const line = inv!.items[0];
      // The levy moved with the price (stored 15.00 -> 8.37), so a projection that kept the stored levy
      // cannot equal the write.
      expect(Number(line.categoryTaxAmount)).toBe(8.37);
      expect(Number(line.subtotal)).toBe(83.7);
      expect(roundMoney(projected)).toBe(roundMoney(written));
      expect(written).toBe(96.26); // 83.70 + 4.19 regular + 8.37 category
    });

    it("(2) a legacy B294 FLAT-RATE invoice (every line taxRate 0, a real header tax, an untaxed NSF fee): the stamped rate is in the projection", async () => {
      const b = await seedBase("flat");
      const invoice = await prisma.invoice.create({
        data: {
          tenantId: b.tenantId,
          customerId: b.customerId,
          invoiceNumber: `INV-B1058-${RUN}-${seq}-flat`,
          status: "SENT",
          subtotal: 125, // goods 100.00 + NSF fee 25.00
          taxAmount: 7.5, // 7.5% of the goods only
          total: 132.5,
        },
      });
      const goods = await prisma.invoiceItem.create({
        data: {
          tenantId: b.tenantId,
          invoiceId: invoice.id,
          productId: b.productId,
          description: "legacy goods",
          qty: 10,
          unitPrice: 10,
          taxRate: 0,
          subtotal: 100,
        },
      });
      await prisma.invoiceItem.create({
        data: {
          tenantId: b.tenantId,
          invoiceId: invoice.id,
          description: "NSF fee — returned check P-1058",
          qty: 1,
          unitPrice: 25,
          taxRate: 0,
          subtotal: 25,
          systemKind: "NSF_FEE",
        },
      });

      await rePrice(b.tenantId, invoice.id, goods.id, 9.37); // goods 93.70

      const projected = (await projectedOfLastRun()).get(invoice.id)!;
      const inv = await prisma.invoice.findUnique({
        where: { id: invoice.id },
        include: { items: true },
      });
      const written = Number(inv!.total);
      // The tx stamped the inferred 7.5% on the goods line and not on the fee, so the tax is on the goods alone.
      expect(Number(inv!.items.find((i) => i.id === goods.id)!.taxRate)).toBe(0.075);
      expect(roundMoney(projected)).toBe(roundMoney(written));
      expect(written).toBe(125.73); // 93.70 goods + 25.00 fee + 7.03 tax (93.70 x 7.5%)
    });

    it("(3) the OVERPAY judgment uses that same projection: a sibling paid exactly the written total is fine, one cent more is refused by one cent", async () => {
      const b = await seedBase("pair", { categoryRate: 0.1 });
      const old = new Date("2020-01-01T00:00:00Z"); // outside the first run's sinceDate
      const overpaying = await categoryTaxedInvoice(b, 1, old);
      const sibling = await categoryTaxedInvoice(b, 2);

      // Run 1 targets the sibling only (sinceDate after `old`): its projected total vs what it then stores.
      await tenantCtx.run(b.tenantId, () =>
        invoices.applyPriceAdjustment(sibling.invoiceId, {
          items: [{ itemId: sibling.lineId, newUnitPrice: 8.37 }],
          scope: "ALL_CUSTOMER_SINCE",
          sinceDate: "2021-01-01",
        } as any),
      );
      const projected = (await projectedOfLastRun()).get(sibling.invoiceId)!;
      const written = await storedTotal(sibling.invoiceId);
      expect(roundMoney(projected)).toBe(roundMoney(written));
      expect(written).toBe(96.26);

      // The old invoice is now paid ONE CENT above that total (it still owes 172.50, so the payment is valid).
      await pay(b.tenantId, overpaying.invoiceId, roundMoney(written + 0.01));
      const before = await read(overpaying);

      // Run 2 (both targets, same price): the sibling re-derives the same 96.26 and is not overpaid; the
      // old invoice would be overpaid by exactly 0.01 against the SAME projected total. One 400, no writes.
      const outcome = await attempt(
        rePrice(b.tenantId, overpaying.invoiceId, overpaying.lineId, 8.37),
      );

      expect(await read(overpaying)).toEqual(before); // unchanged
      expect(await storedTotal(sibling.invoiceId)).toBe(written); // the sibling's write was not repeated or lost
      expect(outcome).toBeInstanceOf(BadRequestException);
      const body = (outcome as BadRequestException).getResponse() as any;
      expect(body.code).toBe("PRICE_ADJUSTMENT_OVERPAYS");
      expect(body.overpaid).toEqual([
        {
          invoiceId: overpaying.invoiceId,
          invoiceNumber: `INV-B1058-${RUN}-${seq}-1`,
          paid: 96.27,
          newTotal: written,
          overpaidBy: 0.01,
        },
      ]);

      // And at exactly the written total it settles: top the payment down by a cent via a fresh pair.
      const b2 = await seedBase("settle", { categoryRate: 0.1 });
      const exact = await categoryTaxedInvoice(b2, 1);
      await pay(b2.tenantId, exact.invoiceId, 96.26);
      expect(await attempt(rePrice(b2.tenantId, exact.invoiceId, exact.lineId, 8.37))).toBe(
        "applied",
      );
      const settled = await prisma.invoice.findUnique({ where: { id: exact.invoiceId } });
      expect(Number(settled!.total)).toBe(96.26);
      expect(settled!.status).toBe("PAID");
    });
  });
});
