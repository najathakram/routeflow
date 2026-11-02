/**
 * SA-1091 A-1 on REAL Postgres: an inline return is priced as the invoice CHARGED, so a whole taxed, multi-line sale comes back
 * at exactly the invoice's total and the order-wide bound (still exact) never refuses an honest return. Master priced per line
 * and could pass `Invoice.total` by a cent (the #4127 hold).
 *
 * Every case is a throwaway `qa-ac1-<run>-<n>` tenant (approved by `assertTestTenant`) with a DELIVERED order, its PAID
 * invoice (totals as `sumInvoiceTotals` would write them: tax rounded once across the lines) and the real services, wired like
 * order-refund-bound-sa1091.db.spec.ts. Run with `npm run local:test:db`.
 *
 *   AC-1  $6.50 + $2.50 at 8.25% (invoice 9.74): the whole sale, inline REFUND, is captured at 9.74
 *   AC-2  same, inline STORE_CREDIT: one note of 9.74
 *   AC-3  same, line by line, each its own return: 7.03 then 2.71
 *   AC-4  three $1.06 lines, $1.00 off, no tax (invoice 2.18): the whole sale is captured at 2.18
 *   AC-5  $10 + $20 at 8.25% (invoice 32.48): the whole sale is captured at 32.48 (guard, unchanged)
 *   AC-6  line 1 stored at the OLD price (7.04): line 2 prices at 2.70 and passes, the total is 9.74
 *   AC-7  RR-6 still exact on one line: a $5 lump on $20 refuses the 4th piece (guard, in the sibling spec)
 *   AC-8  a $5 lump on the taxed sale: the whole sale is refused naming the room left, line 2 alone passes
 */
import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { ReturnsService } from "./returns.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NumberingService } from "../import/numbering.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { IdempotencyService } from "../common/idempotency.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { InlineReturnsService } from "./inline-returns.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

interface SaleLine {
  price: number;
  taxRate?: number;
}
interface Sale {
  lines: SaleLine[];
  /** the invoice's header: tax rounded ONCE across the lines, and the discount */
  tax: number;
  discount?: number;
}
type Seed = {
  tenantId: string;
  userId: string;
  customerId: string;
  orderId: string;
  invoiceId: string;
  productIds: string[];
  itemIds: string[];
  total: number;
};

const cents = (n: number) => Math.round(n * 100) / 100;

describeDb("SA-1091 A-1: inline returns priced as charged — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let creditNotes: CreditNotesService;
  let inline: any;
  const tenantIds: string[] = [];
  let seq = 0;
  let numSeq = 0;
  let keySeq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const anyMethod = new Proxy(
      {},
      { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
    );
    const numbering = {
      reserveNext: jest.fn().mockImplementation(async () => `N-AC1-${RUN}-${++numSeq}`),
    };
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        ReturnsService,
        RegulatedLedgerService,
        CommissionEngineService,
        AuditService,
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: RouteFlowGateway, useValue: anyMethod },
        { provide: NumberingService, useValue: numbering },
      ],
    }).compile();
    creditNotes = mod.get(CreditNotesService);
    const systemConfig = new SystemConfigService(
      prisma,
      new EncryptionService({ get: () => undefined } as any),
    );
    inline = Object.assign(Object.create(InlineReturnsService.prototype), {
      prisma,
      gateway: anyMethod,
      ledger: mod.get(RegulatedLedgerService),
      creditNotes,
      numbering,
      addonService: { hasAddon: async () => true },
      quoteService: new InlineReturnsQuoteService(prisma, systemConfig),
      idempotency: new IdempotencyService(),
    });
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.orderCreditNote.deleteMany(where).catch(swallow);
      await prisma.returnItem.deleteMany(where).catch(swallow);
      await prisma.return.deleteMany(where).catch(swallow);
      await prisma.creditNoteItem.deleteMany(where).catch(swallow);
      await prisma.creditNote.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.orderItem.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.stockMovement.deleteMany({ where: { product: { tenantId } } }).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  /** A DELIVERED order of one piece per line and its PAID invoice, totalled as the invoice builder does. */
  async function seed(label: string, sale: Sale): Promise<Seed> {
    seq += 1;
    const slug = assertTestTenant(
      `qa-ac1-${RUN}-${seq}-${label}`,
      "inline-priced-as-charged-sa1091.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `ac1 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `ac1 ${label}`,
        contactName: `ac1 ${label}`,
        tenantId,
      } as any,
    });
    const subtotal = cents(sale.lines.reduce((t, l) => t + l.price, 0));
    const discount = sale.discount ?? 0;
    const total = cents(subtotal - discount + sale.tax);
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderNumber: `ORD-AC1-${RUN}-${seq}`,
        subtotal,
        tax: sale.tax,
        total,
        status: "DELIVERED",
      } as any,
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderId: order.id,
        invoiceNumber: `INV-AC1-${RUN}-${seq}`,
        status: "PAID",
        subtotal,
        discount,
        taxAmount: sale.tax,
        total,
      },
    });
    const productIds: string[] = [];
    const itemIds: string[] = [];
    for (const [i, l] of sale.lines.entries()) {
      const product = await prisma.product.create({
        data: {
          tenantId,
          name: `Widget ${i} ${slug}`,
          unit: "each",
          pricePerUnit: l.price,
          currentStock: 0,
        } as any,
      });
      const orderItem = await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          name: product.name,
          qty: 1,
          unitPrice: l.price,
          subtotal: l.price,
        } as any,
      });
      const item = await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          orderItemId: orderItem.id,
          productId: product.id,
          description: `Widget ${i}`,
          qty: 1,
          unitPrice: l.price,
          subtotal: l.price,
          taxRate: l.taxRate ?? 0,
        } as any,
      });
      productIds.push(product.id);
      itemIds.push(item.id);
    }
    await prisma.invoicePayment.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        amount: total,
        method: "CASH",
        status: "PAID",
      } as any,
    });
    return {
      tenantId,
      userId: user.id,
      customerId: customer.id,
      orderId: order.id,
      invoiceId: invoice.id,
      productIds,
      itemIds,
      total,
    };
  }

  const staff = (s: Seed) => ({
    sub: s.userId,
    username: "operator",
    role: "OPERATOR" as any,
    status: "ACTIVE" as any,
    forcePasswordChange: false,
    tenantId: s.tenantId,
    tenantSlug: "x",
  });
  const inTenant = (s: Seed, fn: () => Promise<any>): Promise<any> =>
    tenantCtx.run(s.tenantId, fn) as Promise<any>;
  const status = (e: any) => e?.status ?? e?.getStatus?.();
  const body = (e: any) => e?.getResponse?.() ?? {};
  const settle = (p: Promise<unknown>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );

  /** An inline capture of one piece of each listed product (by index into the sale). */
  const capture = (s: Seed, which: number[], resolution: "STORE_CREDIT" | "REFUND") =>
    settle(
      inTenant(s, () =>
        inline.capture(
          {
            customerId: s.customerId,
            orderId: s.orderId,
            items: which.map((i) => ({ productId: s.productIds[i], qty: 1, boxes: 0, pieces: 1 })),
            returnKey: `ac1-${RUN}-${++keySeq}`,
            resolution,
          },
          staff(s),
        ),
      ),
    );
  const lump = (s: Seed, amount: number) =>
    settle(
      inTenant(s, () =>
        creditNotes.create({
          customerId: s.customerId,
          invoiceId: s.invoiceId,
          amount,
        } as any),
      ),
    );
  const ok = (r: { ok: boolean; error?: any }) =>
    expect(r.ok ? "ok" : `${status(r.error)} ${JSON.stringify(body(r.error))}`).toBe("ok");

  /** What the live inline returns on the order credited in all: net + tax + levy, to the cent. */
  async function credited(s: Seed): Promise<number> {
    const rows = await prisma.return.findMany({ where: { tenantId: s.tenantId, kind: "INLINE" } });
    return cents(
      rows.reduce(
        (t, r) =>
          t +
          Number(r.creditSubtotal ?? 0) +
          Number(r.creditTax ?? 0) +
          Number(r.creditCategoryTax ?? 0),
        0,
      ),
    );
  }

  // $6.50 + $2.50 at 8.25%: tax rounded once on the invoice is 0.74, total 9.74
  const nine74: Sale = {
    lines: [
      { price: 6.5, taxRate: 0.0825 },
      { price: 2.5, taxRate: 0.0825 },
    ],
    tax: 0.74,
  };

  it("AC-1: the whole $9.74 taxed sale, inline REFUND, is captured at 9.74 (it was refused: 7.04 + 2.71 = 9.75)", async () => {
    const s = await seed("ac1", nine74);
    expect(s.total).toBe(9.74);
    ok(await capture(s, [0, 1], "REFUND"));
    expect(await credited(s)).toBe(9.74);
  }, 90_000);

  it("AC-2: the same whole sale as inline STORE_CREDIT is one note of 9.74 (it was 9.75 on master)", async () => {
    const s = await seed("ac2", nine74);
    ok(await capture(s, [0, 1], "STORE_CREDIT"));
    const notes = await prisma.creditNote.findMany({
      where: { tenantId: s.tenantId, status: { not: "VOID" } },
    });
    expect(notes).toHaveLength(1);
    expect(Number(notes[0].amount)).toBe(9.74);
  }, 90_000);

  it("AC-3: line by line, each its own return, prices 7.03 then 2.71, and both pass (the last was refused)", async () => {
    const s = await seed("ac3", nine74);
    ok(await capture(s, [0], "REFUND"));
    expect(await credited(s)).toBe(7.03);
    ok(await capture(s, [1], "REFUND"));
    expect(await credited(s)).toBe(9.74);
  }, 90_000);

  it("AC-3: the other way round (line 2 first) also adds up to 9.74", async () => {
    const s = await seed("ac3b", nine74);
    ok(await capture(s, [1], "REFUND"));
    ok(await capture(s, [0], "REFUND"));
    expect(await credited(s)).toBe(9.74);
  }, 90_000);

  it("AC-4: three $1.06 lines with $1.00 off and no tax (invoice 2.18): the whole sale is captured at 2.18", async () => {
    const s = await seed("ac4", {
      lines: [{ price: 1.06 }, { price: 1.06 }, { price: 1.06 }],
      tax: 0,
      discount: 1,
    });
    expect(s.total).toBe(2.18);
    ok(await capture(s, [0, 1, 2], "REFUND"));
    expect(await credited(s)).toBe(2.18);
  }, 90_000);

  it("AC-5 (guard): $10 + $20 at 8.25% (invoice 32.48): the whole sale is captured at 32.48", async () => {
    const s = await seed("ac5", {
      lines: [
        { price: 10, taxRate: 0.0825 },
        { price: 20, taxRate: 0.0825 },
      ],
      tax: 2.48,
    });
    expect(s.total).toBe(32.48);
    ok(await capture(s, [0, 1], "REFUND"));
    expect(await credited(s)).toBe(32.48);
  }, 90_000);

  it("AC-6: line 1 already stored at the OLD price (7.04) — line 2 prices at 2.70 and passes, the order gives back 9.74", async () => {
    const s = await seed("ac6", nine74);
    ok(await capture(s, [0], "REFUND"));
    // make the stored row what master wrote: net 6.50, tax 0.54 (rounded per line), 7.04
    const ret = await prisma.return.findFirstOrThrow({
      where: { tenantId: s.tenantId, kind: "INLINE" },
    });
    await prisma.return.update({ where: { id: ret.id }, data: { creditTax: 0.54 } });
    await prisma.returnItem.updateMany({ where: { returnId: ret.id }, data: { taxAmount: 0.54 } });
    expect(await credited(s)).toBe(7.04);
    ok(await capture(s, [1], "REFUND"));
    expect(await credited(s)).toBe(9.74);
  }, 90_000);

  it("AC-8 (guard): a $5 lump on the taxed sale — the whole sale is refused with the room left, line 2 alone (2.71) passes", async () => {
    const s = await seed("ac8", nine74);
    ok(await lump(s, 5));
    const whole = await capture(s, [0, 1], "REFUND");
    expect(whole.ok).toBe(false);
    if (!whole.ok) {
      expect(status(whole.error)).toBe(409);
      expect(body(whole.error).code).toBe(API_ERROR_CODES.RETURN_REFUND_OVER_LINE_HEADROOM);
      expect(body(whole.error)).toMatchObject({ orderBound: true, remaining: 4.74 });
    }
    ok(await capture(s, [1], "REFUND"));
    const line1 = await capture(s, [0], "REFUND");
    expect(line1.ok).toBe(false);
    if (!line1.ok) expect(body(line1.error)).toMatchObject({ orderBound: true, remaining: 2.03 });
  }, 120_000);
});
