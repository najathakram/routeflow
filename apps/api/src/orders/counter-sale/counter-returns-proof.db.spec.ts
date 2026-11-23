/**
 * D8 (SA-1228, SA-1231 R5) - the counter return money, proven on Postgres. The till's $100 sale with a $40 return and $60 cash is
 * proven on the web screen only, on a mocked quote; this file rings the same sale through the REAL chain
 * (CounterSaleService.ring -> OrdersService.createSale -> InlineReturnsService, the one return writer -> invoice -> tender plan)
 * and reads what Postgres stores and what the server serves. Test-only: no product code.
 *
 * Cases: R1 (cash $60 against a $100 sale with a $40 return), R1b (cash with the amount omitted), R2 (on account), R3 (a return
 * that covers the sale), R4 (the credit carries the sale's tax), R5 (a returned box: stored pieces, served line), R6a/b/c (a refused
 * then retried ring, a cancelled then replayed ring, a used returnKey), T1 (a return captured against a posted, unpaid sale).
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Throwaway `qa-d8-*` tenants (assertTestTenant); acme placeholders only.
 */
jest.mock("../../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { Test } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { confirmedRemaining, roundMoney } from "@routeflow/pricing";
import type { FulfilmentCapability } from "@routeflow/types";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { _resetLockPoolForTests } from "../../common/db-locks";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { EncryptionService } from "../../common/encryption.service";
import { SystemConfigService } from "../../system-config/system-config.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { InvoicePdfService } from "../../invoices/invoice-pdf.service";
import { RouteFlowGateway } from "../../gateways/routeflow.gateway";
import { EmailService } from "../../email/email.service";
import { RegulatedLedgerService } from "../../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../../authorizations/authorization-guard.service";
import { CreditNotesService } from "../../credit-notes/credit-notes.service";
import { MessagingService } from "../../messaging/messaging.service";
import { StorageService } from "../../storage/storage.service";
import { EntitlementsService } from "../../billing/entitlements.service";
import { CommissionEngineService } from "../../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../../estimates/estimates.service";
import { NumberingService } from "../../import/numbering.service";
import { IdempotencyService } from "../../common/idempotency.service";
import { InlineReturnsQuoteService } from "../../returns/inline-returns-quote.service";
import { InlineReturnsService } from "../../returns/inline-returns.service";
import { buildOperatorStatement } from "../../customers/customer-statement";
import { entitlementAuthorityFromEntitlements } from "../../testing/entitlement-authority-provider";
import { OrdersService } from "../orders.service";
import type { AuditService } from "../../audit/audit.service";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import type { CounterSaleDto } from "./counter-sale.dto";
import { CounterSaleService } from "./counter-sale.service";
import type { WalkInCustomerService } from "./walk-in-customer";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const capability = {
  methods: ["PICKUP", "SHIP"],
  staffDefault: "PICKUP",
  staffOpensAs: "counter",
  portalMethods: [],
  portalDefault: null,
  counter: "always",
  fleet: true,
  consistent: true,
} as FulfilmentCapability;

const RUN = randomUUID().slice(0, 8);

type Env = { slug: string; tenantId: string; operatorId: string; big: string; ret40: string };
type Item = NonNullable<CounterSaleDto["items"]>[number];
type Pay = CounterSaleDto["payment"];
type InlineReturn = { returnKey: string; reason?: string; items: Record<string, unknown>[] };

/** What the spec observed, printed so the PR can quote the served values. */
const obs = (label: string, value: unknown) =>
  // eslint-disable-next-line no-console
  console.log(`[D8] ${label} ${JSON.stringify(value)}`);

describeDb("D8 - the counter return money on Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: CounterSaleService;
  let inlineSvc: InlineReturnsService;
  let plain: Env; // no tax
  let taxed: Env; // settings.taxRate 8.25 (percent)
  const tenantIds: string[] = [];
  const userIds: string[] = [];

  const staff = (env: Env): JwtPayload =>
    ({
      sub: env.operatorId,
      username: `op-${env.slug}`,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId: env.tenantId,
      tenantSlug: env.slug,
    }) as JwtPayload;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl(), max: 8 });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const systemConfig = new SystemConfigService(
      prisma,
      new EncryptionService({ get: () => undefined } as never),
    );
    const numbering = new NumberingService(prisma);
    const ledger = new RegulatedLedgerService(prisma);
    const creditNotes = Object.assign(Object.create(CreditNotesService.prototype), {
      prisma,
      gateway: { emitCreditNoteCreated: jest.fn() },
      ledger,
      commissionEngine: { syncInvoiceCommissionSafe: async () => undefined },
      numbering,
      logger: new Logger(CreditNotesService.name),
    });
    inlineSvc = Object.assign(Object.create(InlineReturnsService.prototype), {
      prisma,
      gateway: { emitCreditNoteCreated: jest.fn(), emitCreditNoteVoided: jest.fn() },
      ledger,
      creditNotes,
      numbering,
      addonService: { hasAddon: async () => true },
      quoteService: new InlineReturnsQuoteService(prisma, systemConfig),
      idempotency: new IdempotencyService(),
    });
    const mod = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: async () => undefined },
        },
        EstimatesService,
        { provide: NumberingService, useValue: numbering },
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
        { provide: SystemConfigService, useValue: systemConfig },
        { provide: RegulatedLedgerService, useValue: ledger },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        { provide: CreditNotesService, useValue: creditNotes },
        {
          provide: MessagingService,
          useValue: {
            notify: jest.fn().mockResolvedValue([]),
            notifyEvent: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
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
    const invoices = mod.get(InvoicesService);
    const orders = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      creditNotes,
      gateway: { emitOrderCreated: jest.fn(), emitUrgentOrder: jest.fn() },
      systemConfig,
      entitlements: { hasFlag: async () => true },
      sellingRestrictions: { assertLinesSellable: async () => undefined },
      authGuard: { assertAuthorizedOrThrow: async () => undefined },
      promotionsService: { activeForCatalog: async () => [] },
      ledger,
      tenantCtx,
      logger: new Logger(OrdersService.name),
      invoicesService: invoices,
      inlineReturns: inlineSvc,
    }) as OrdersService;
    service = new CounterSaleService(
      orders,
      invoices,
      {
        getOrCreateWalkIn: async () => {
          throw new Error("walk-in is not used by this spec");
        },
      } as unknown as WalkInCustomerService,
      prisma,
      { get: async () => capability },
      { log: async () => undefined } as unknown as AuditService,
    );

    const mkEnv = async (slug: string, taxRate?: string): Promise<Env> => {
      const tenant = await raw.tenant.create({ data: { slug, name: `D8 returns proof ${slug}` } });
      tenantIds.push(tenant.id);
      await raw.tenantConfig.create({
        data: { tenantId: tenant.id, timezone: "America/New_York" },
      });
      if (taxRate)
        await raw.systemConfig.create({
          data: { tenantId: tenant.id, key: "settings.taxRate", value: taxRate },
        });
      const op = await raw.user.create({
        data: {
          email: `op-${slug}@example.test`,
          username: `op-${slug}`,
          role: "OPERATOR",
          tenantId: tenant.id,
        },
      });
      userIds.push(op.id);
      const env = { slug, tenantId: tenant.id, operatorId: op.id } as Env;
      env.big = await mkProduct(env, "big", "100.00");
      env.ret40 = await mkProduct(env, "ret40", "40.00");
      return env;
    };
    plain = await mkEnv(assertTestTenant(`qa-d8-ret-${RUN}`, "counter-returns-proof.db.spec.ts"));
    taxed = await mkEnv(
      assertTestTenant(`qa-d8-tax-${RUN}`, "counter-returns-proof.db.spec.ts"),
      "8.25",
    );
  }, 180_000);

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    const where = { where: { tenantId: { in: tenantIds } } };
    const orderIds = (
      await raw.order.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true } })
    ).map((o) => o.id);
    await raw.orderCreditNote.deleteMany({ where: { orderId: { in: orderIds } } }).catch(swallow);
    await raw.invoicePayment.deleteMany(where).catch(swallow);
    await raw.paymentCounter.deleteMany(where).catch(swallow);
    await raw.creditNote.deleteMany(where).catch(swallow);
    await raw.returnItem
      .deleteMany({ where: { return: { orderId: { in: orderIds } } } })
      .catch(swallow);
    await raw.return.deleteMany(where).catch(swallow);
    await raw.regulatedSalesLedger.deleteMany(where).catch(swallow);
    await raw.invoiceItem.deleteMany(where).catch(swallow);
    await raw.invoice.deleteMany(where).catch(swallow);
    await raw.stockMovement
      .deleteMany({ where: { product: { tenantId: { in: tenantIds } } } })
      .catch(swallow);
    await raw.orderItem.deleteMany(where).catch(swallow);
    await raw.order.deleteMany(where).catch(swallow);
    await raw.auditLog.deleteMany(where).catch(swallow);
    await raw.product.deleteMany(where).catch(swallow);
    await raw.customer.deleteMany(where).catch(swallow);
    await raw.systemConfig.deleteMany(where).catch(swallow);
    await raw.tenantConfig.deleteMany(where).catch(swallow);
    await raw.user.deleteMany({ where: { id: { in: userIds } } }).catch(swallow);
    await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(swallow);
    await _resetLockPoolForTests();
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  async function mkProduct(env: Env, name: string, price: string, unitsPerBox?: number) {
    return (
      await raw.product.create({
        data: {
          name: `${name} ${env.slug} ${randomUUID().slice(0, 6)}`,
          unit: unitsPerBox ? "Box" : "each",
          pricePerUnit: price,
          currentStock: "500",
          tenantId: env.tenantId,
          ...(unitsPerBox ? { unitsPerBox } : {}),
        } as never,
      })
    ).id;
  }

  /** A new named customer per case, so one case's credit can never pay another case's sale. */
  async function mkCustomer(env: Env): Promise<string> {
    const tag = randomUUID().slice(0, 8);
    const u = await raw.user.create({
      data: {
        email: `c-${tag}@example.test`,
        username: `c-${tag}-${env.slug}`,
        role: "CUSTOMER",
        tenantId: env.tenantId,
      },
    });
    userIds.push(u.id);
    return (
      await raw.customer.create({
        data: {
          userId: u.id,
          businessName: "Acme Shop",
          contactName: "T",
          tenantId: env.tenantId,
        },
      })
    ).id;
  }

  const ring = (
    env: Env,
    customerId: string,
    items: Item[],
    payment: Pay,
    opts: { key?: string; inlineReturn?: InlineReturn } = {},
  ) => {
    const key = opts.key ?? randomUUID();
    return tenantCtx.run(env.tenantId, () =>
      service.ring(
        {
          customerId,
          items,
          payment,
          ...(opts.inlineReturn ? { inlineReturn: opts.inlineReturn } : {}),
        } as CounterSaleDto,
        staff(env),
        key,
      ),
    );
  };
  const lines = (productId: string, qty = 1): Item[] => [{ productId, qty } as Item];
  const returnOf = (productId: string, rk: string, boxes = 0, pieces = 1): InlineReturn => ({
    returnKey: rk,
    items: [{ productId, qty: 1, boxes, pieces, restock: true }],
  });

  /** What a sale left behind, by its Idempotency-Key. */
  async function footprint(env: Env, key: string) {
    const orders = await raw.order.findMany({
      where: { tenantId: env.tenantId, idempotencyKey: key },
    });
    const orderIds = orders.map((o) => o.id);
    const invoices = await raw.invoice.findMany({
      where: { tenantId: env.tenantId, orderId: { in: orderIds } },
    });
    const payments = await raw.invoicePayment.findMany({
      where: { tenantId: env.tenantId, invoiceId: { in: invoices.map((i) => i.id) } },
    });
    const returns = await raw.return.findMany({
      where: { tenantId: env.tenantId, orderId: { in: orderIds } },
      include: { items: true },
    });
    return {
      orders,
      invoices,
      payments,
      returns,
      live: payments.filter((p) => p.status !== "VOID"),
    };
  }
  const sum = (rows: Array<{ amount: unknown }>) => rows.reduce((s, r) => s + Number(r.amount), 0);
  const ofMethod = <T extends { method: string | null }>(rows: T[], ...m: string[]): T[] =>
    rows.filter((r) => m.includes(String(r.method)));
  const TENDER = ["CASH", "CREDIT_CARD", "CHECK"];
  const creditNotesOf = (env: Env, customerId: string) =>
    raw.creditNote.findMany({ where: { tenantId: env.tenantId, customerId } });
  const creditLeft = async (env: Env, customerId: string) =>
    roundMoney(
      (await creditNotesOf(env, customerId))
        .filter((c) => c.status !== "VOID")
        .reduce((s, c) => s + Number(c.amount) - Number(c.amountUsed), 0),
    );
  /** The restock movements a product carries: `RET-<id8>` (a capture) and `RET-CANCEL-<id8>` (a cancel). */
  async function movements(productId: string) {
    const rows = await raw.stockMovement.findMany({
      where: { productId, reference: { startsWith: "RET-" } },
    });
    return {
      ret: rows.filter((m) => !String(m.reference).startsWith("RET-CANCEL-")),
      cancel: rows.filter((m) => String(m.reference).startsWith("RET-CANCEL-")),
    };
  }

  /** The $100 sale with a $40 inline return, the demo's till sale. */
  async function demoSale(env: Env, payment: Pay) {
    const customerId = await mkCustomer(env);
    const key = randomUUID();
    const res = await ring(env, customerId, lines(env.big), payment, {
      key,
      inlineReturn: returnOf(env.ret40, `rk-${key}`),
    });
    const f = await footprint(env, key);
    return { customerId, key, res, f };
  }

  it("R1) $100 sale + $40 inline return, cash $60: the stored rows, the credit, and the served split", async () => {
    const { customerId, res, f } = await demoSale(plain, { method: "CASH", amount: 60 });
    obs("R1 served", {
      total: res.total,
      paid: res.paid,
      balanceDue: res.balanceDue,
      cashTendered: res.cashTendered,
      change: res.change,
      tenderPaid: res.tenderPaid,
      returnCredit: res.returnCredit,
      returnLines: res.returnLines,
      tenderMethods: res.tenderMethods,
    });
    expect(Number(f.invoices[0].total)).toBeCloseTo(100, 2);
    expect(sum(ofMethod(f.live, "CASH"))).toBeCloseTo(60, 2);
    expect(sum(ofMethod(f.live, "CREDIT_NOTE"))).toBeCloseTo(40, 2);
    expect(confirmedRemaining(Number(f.invoices[0].total), f.payments)).toBeCloseTo(0, 2);
    expect(res.balanceDue).toBeCloseTo(0, 2);
    expect(f.returns).toHaveLength(1);
    expect(f.returns[0].status).toBe("REFUNDED");
    const cn = await raw.creditNote.findUniqueOrThrow({
      where: { id: f.returns[0].creditNoteId! },
    });
    expect(Number(cn.amount)).toBeCloseTo(40, 2);
    expect(Number(cn.amountUsed)).toBeCloseTo(40, 2);
    expect(await creditLeft(plain, customerId)).toBeCloseTo(0, 2);
    expect(res.tenderMethods).toEqual([
      { method: "CASH", amount: 60 },
      { method: "STORE_CREDIT", amount: 40 },
    ]);
  }, 60_000);

  it("R1b) the same sale with the cash amount omitted: cash tendered $60, one CASH row, no change", async () => {
    const { res, f } = await demoSale(plain, { method: "CASH" });
    obs("R1b served", { cashTendered: res.cashTendered, change: res.change, paid: res.paid });
    expect(res.cashTendered).toBeCloseTo(60, 2);
    const cash = ofMethod(f.live, "CASH");
    expect(cash).toHaveLength(1);
    expect(Number(cash[0].amount)).toBeCloseTo(60, 2);
    expect(res.change ?? 0).toBeCloseTo(0, 2); // nothing handed back (served as 0)
    const order = await raw.order.findUniqueOrThrow({ where: { id: f.orders[0].id } });
    expect(Number(order.counterCashTendered)).toBeCloseTo(60, 2);
  }, 60_000);

  it("R2) the same sale on account: $60 still due, no tender row, the $40 credit fully used", async () => {
    const { byKey } = {
      byKey: (k: string) => tenantCtx.run(plain.tenantId, () => service.byKey(k)),
    };
    const { customerId, key, res, f } = await demoSale(plain, { method: "ON_ACCOUNT" });
    expect(res.balanceDue).toBeCloseTo(60, 2);
    expect(roundMoney(confirmedRemaining(Number(f.invoices[0].total), f.payments))).toBeCloseTo(
      60,
      2,
    );
    expect(ofMethod(f.live, ...TENDER)).toHaveLength(0);
    const cn = await raw.creditNote.findUniqueOrThrow({
      where: { id: f.returns[0].creditNoteId! },
    });
    expect(Number(cn.amount)).toBeCloseTo(40, 2);
    expect(Number(cn.amountUsed)).toBeCloseTo(40, 2);
    expect(await creditLeft(plain, customerId)).toBeCloseTo(0, 2);
    expect((await byKey(key)).balanceDue).toBeCloseTo(60, 2);
  }, 60_000);

  it("R3) a $100 return on a $100 sale: nothing due, no tender row, the credit fully used, none left over", async () => {
    const full = await mkProduct(plain, "full", "100.00");
    const customerId = await mkCustomer(plain);
    const before = await creditLeft(plain, customerId);
    const key = randomUUID();
    const res = await ring(
      plain,
      customerId,
      lines(plain.big),
      { method: "CASH" },
      {
        key,
        inlineReturn: returnOf(full, `rk-${key}`),
      },
    );
    const f = await footprint(plain, key);
    obs("R3 served", {
      balanceDue: res.balanceDue,
      returnLines: res.returnLines,
      cashTendered: res.cashTendered,
    });
    expect(res.balanceDue).toBeCloseTo(0, 2);
    expect(ofMethod(f.live, ...TENDER)).toHaveLength(0);
    const cn = await raw.creditNote.findUniqueOrThrow({
      where: { id: f.returns[0].creditNoteId! },
    });
    expect(Number(cn.amount)).toBeCloseTo(100, 2);
    expect(Number(cn.amountUsed)).toBeCloseTo(100, 2);
    expect((await creditLeft(plain, customerId)) - before).toBeCloseTo(0, 2);
    expect(res.returnLines?.kept).toBeCloseTo(0, 2);
  }, 60_000);

  it("R4) a taxed return credits the sale's tax: credit 43.30 (not 40.00), cash is the sale total less the credit", async () => {
    const customerId = await mkCustomer(taxed);
    // an earlier sale of the returned product, so the return matches it (a never-sold chunk credits no tax)
    await ring(taxed, customerId, lines(taxed.ret40), { method: "ON_ACCOUNT" });
    const key = randomUUID();
    const res = await ring(
      taxed,
      customerId,
      lines(taxed.big),
      { method: "CASH" },
      {
        key,
        inlineReturn: returnOf(taxed.ret40, `rk-${key}`),
      },
    );
    const f = await footprint(taxed, key);
    const ret = f.returns[0];
    const cn = await raw.creditNote.findUniqueOrThrow({ where: { id: ret.creditNoteId! } });
    const invoiceTotal = Number(f.invoices[0].total);
    const item = ret.items[0];
    obs("R4 stored", {
      invoiceTotal,
      itemSubtotal: Number(item.subtotal),
      itemTax: Number(item.taxAmount),
      creditTax: Number(ret.creditTax),
      creditCategoryTax: Number(ret.creditCategoryTax),
      creditNote: Number(cn.amount),
      cash: sum(ofMethod(f.live, "CASH")),
      served: { cashTendered: res.cashTendered, balanceDue: res.balanceDue },
    });
    expect(Number(item.subtotal)).toBeCloseTo(40, 2);
    expect(Number(item.taxAmount)).toBeCloseTo(3.3, 2);
    expect(Number(ret.creditTax)).toBeCloseTo(3.3, 2);
    const expected = roundMoney(
      Number(ret.creditSubtotal) + Number(ret.creditTax) + Number(ret.creditCategoryTax ?? 0),
    );
    expect(Number(cn.amount)).toBeCloseTo(expected, 2);
    expect(Number(cn.amount)).toBeCloseTo(43.3, 2);
    expect(sum(ofMethod(f.live, "CASH"))).toBeCloseTo(roundMoney(invoiceTotal - 43.3), 2);
    expect(confirmedRemaining(invoiceTotal, f.payments)).toBeCloseTo(0, 2);
    expect(res.balanceDue).toBeCloseTo(0, 2);
  }, 60_000);

  it("R5) a returned box: stored 24 pieces and one 24-piece restock, the credit is the box's subtotal, the served item carries its line", async () => {
    const case24 = await mkProduct(plain, "case24", "48.00", 24);
    const customerId = await mkCustomer(plain);
    const source = await ring(
      plain,
      customerId,
      [{ productId: case24, boxes: 1, pieces: 0 } as Item],
      {
        method: "ON_ACCOUNT",
      },
    );
    const sourceLine = await raw.orderItem.findFirstOrThrow({ where: { orderId: source.orderId } });
    const key = randomUUID();
    const res = await ring(
      plain,
      customerId,
      lines(plain.big),
      { method: "CASH" },
      {
        key,
        inlineReturn: { ...returnOf(case24, `rk-${key}`, 1, 0), reason: "DAMAGED" },
      },
    );
    const f = await footprint(plain, key);
    const item = f.returns[0].items[0];
    const cn = await raw.creditNote.findUniqueOrThrow({
      where: { id: f.returns[0].creditNoteId! },
    });
    const mv = await movements(case24);
    obs("R5", {
      sourceLine: {
        unitPrice: Number(sourceLine.unitPrice),
        subtotal: Number(sourceLine.subtotal),
        qty: Number(sourceLine.qty),
        boxes: sourceLine.boxes,
        pieces: sourceLine.pieces,
        unitsPerBox: sourceLine.unitsPerBox,
      },
      stored: { qty: Number(item.qty), subtotal: Number(item.subtotal), credit: Number(cn.amount) },
      movements: mv.ret.map((m) => ({ ref: m.reference, qty: Number(m.quantity) })),
      served: res.returnItems,
    });
    expect(Number(item.qty)).toBe(24);
    expect(mv.ret).toHaveLength(1);
    expect(Number(mv.ret[0].quantity)).toBe(24);
    expect(Number(cn.amount)).toBeCloseTo(Number(sourceLine.subtotal), 2);
    expect(res.returnItems).toHaveLength(1);
    expect(res.returnItems?.[0]).toMatchObject({
      name: expect.stringContaining("case24"),
      qty: 24,
      kind: "INLINE",
      reason: "DAMAGED",
      line: { unitsPerBox: 24, boxes: 1, pieces: 0 },
    });
  }, 60_000);

  it("R6a) a refused ring writes nothing, and the retry (same Idempotency-Key, fresh returnKey) books one order, one return, one credit note, one restock", async () => {
    const widget = await mkProduct(plain, "widget", "10.00");
    const customerId = await mkCustomer(plain);
    await ring(plain, customerId, lines(widget), { method: "ON_ACCOUNT" }); // the source sale, so the return restocks
    const key = randomUUID();
    const notesBefore = (await creditNotesOf(plain, customerId)).length;
    const spy = jest.spyOn(inlineSvc, "preflightNewOrderReturn").mockResolvedValue(99);
    let refused: { status?: number; response?: { code?: string } } | undefined;
    try {
      await ring(
        plain,
        customerId,
        lines(plain.big),
        { method: "ON_ACCOUNT" },
        {
          key,
          inlineReturn: returnOf(widget, `rk-${key}-1`),
        },
      ).catch((e) => (refused = e));
    } finally {
      spy.mockRestore();
    }
    expect(refused?.status).toBe(409);
    expect(refused?.response?.code).toBe("RETURN_CREDIT_CHANGED");
    const mid = await footprint(plain, key);
    expect(mid.orders).toHaveLength(0);
    expect(mid.returns).toHaveLength(0);
    expect((await creditNotesOf(plain, customerId)).length).toBe(notesBefore);
    expect((await movements(widget)).ret).toHaveLength(0);

    let retry: unknown;
    let retryErr: { status?: number; response?: unknown } | undefined;
    try {
      retry = await ring(
        plain,
        customerId,
        lines(plain.big),
        { method: "ON_ACCOUNT" },
        {
          key,
          inlineReturn: returnOf(widget, `rk-${key}-2`),
        },
      );
    } catch (e) {
      retryErr = e as { status?: number; response?: unknown };
    }
    obs("R6a retry", retryErr ? { status: retryErr.status, body: retryErr.response } : "ok");
    expect(retryErr).toBeUndefined();
    expect(retry).toBeDefined();
    const f = await footprint(plain, key);
    expect(f.orders).toHaveLength(1);
    expect(f.returns).toHaveLength(1);
    expect((await creditNotesOf(plain, customerId)).length).toBe(notesBefore + 1);
    expect((await movements(widget)).ret).toHaveLength(1);
  }, 60_000);

  it("R6b) a cancelled return, then the same ring replayed: replayed, one return (CANCELLED), the note VOID, one restock and one cancel movement", async () => {
    const widget = await mkProduct(plain, "widget", "10.00");
    const customerId = await mkCustomer(plain);
    await ring(plain, customerId, lines(widget), { method: "ON_ACCOUNT" });
    const key = randomUUID();
    const rk = `rk-${key}`;
    const first = await ring(
      plain,
      customerId,
      lines(plain.big),
      { method: "ON_ACCOUNT" },
      {
        key,
        inlineReturn: returnOf(widget, rk),
      },
    );
    const before = await footprint(plain, key);
    const notesBefore = (await creditNotesOf(plain, customerId)).length;
    await tenantCtx.run(plain.tenantId, () => inlineSvc.cancel(before.returns[0].id, staff(plain)));
    const afterCancel = await footprint(plain, key);
    obs("R6b after cancel", {
      balance: confirmedRemaining(Number(afterCancel.invoices[0].total), afterCancel.payments),
      invoiceStatus: afterCancel.invoices[0].status,
      payments: afterCancel.payments.map((p) => ({
        m: p.method,
        s: p.status,
        a: Number(p.amount),
      })),
    });
    let replay: Awaited<ReturnType<typeof ring>> | undefined;
    let replayErr: { status?: number; response?: unknown } | undefined;
    try {
      replay = await ring(
        plain,
        customerId,
        lines(plain.big),
        { method: "ON_ACCOUNT" },
        {
          key,
          inlineReturn: returnOf(widget, rk),
        },
      );
    } catch (e) {
      replayErr = e as { status?: number; response?: unknown };
    }
    obs(
      "R6b replay",
      replayErr
        ? { status: replayErr.status, body: replayErr.response }
        : { replayed: replay?.replayed },
    );
    expect(replayErr).toBeUndefined();
    expect(replay?.replayed).toBe(true);
    expect(replay?.orderId).toBe(first.orderId);
    const f = await footprint(plain, key);
    expect(f.returns).toHaveLength(1);
    expect(f.returns[0].status).toBe("CANCELLED");
    const notes = await creditNotesOf(plain, customerId);
    expect(notes).toHaveLength(notesBefore);
    expect(notes.filter((c) => c.status === "VOID")).toHaveLength(1);
    const mv = await movements(widget);
    expect(mv.ret).toHaveLength(1);
    expect(mv.cancel).toHaveLength(1);
  }, 60_000);

  it("R6c) a new Idempotency-Key with a used returnKey is refused 409 INLINE_RETURN_KEY_TAKEN and writes nothing", async () => {
    const widget = await mkProduct(plain, "widget", "10.00");
    const customerId = await mkCustomer(plain);
    await ring(plain, customerId, lines(widget), { method: "ON_ACCOUNT" });
    const key = randomUUID();
    const rk = `rk-${key}`;
    await ring(
      plain,
      customerId,
      lines(plain.big),
      { method: "ON_ACCOUNT" },
      {
        key,
        inlineReturn: returnOf(widget, rk),
      },
    );
    const notesBefore = (await creditNotesOf(plain, customerId)).length;
    const movementsBefore = (await movements(widget)).ret.length;
    const key2 = randomUUID();
    let refused: { status?: number; response?: { code?: string } } | undefined;
    await ring(
      plain,
      customerId,
      lines(plain.big),
      { method: "ON_ACCOUNT" },
      {
        key: key2,
        inlineReturn: returnOf(widget, rk),
      },
    ).catch((e) => (refused = e));
    obs("R6c", { status: refused?.status, body: refused?.response });
    expect(refused?.status).toBe(409);
    expect(refused?.response?.code).toBe("INLINE_RETURN_KEY_TAKEN");
    const f = await footprint(plain, key2);
    expect(f.orders).toHaveLength(0);
    expect(f.returns).toHaveLength(0);
    expect((await creditNotesOf(plain, customerId)).length).toBe(notesBefore);
    expect((await movements(widget)).ret).toHaveLength(movementsBefore);
  }, 60_000);

  it("T1) a return captured against a posted, unpaid sale lands on THAT invoice: credit $40, balance $100 -> $60, one restock, replay-safe", async () => {
    const widget = await mkProduct(plain, "widget", "10.00");
    const customerId = await mkCustomer(plain);
    const key = randomUUID();
    const sale = await ring(
      plain,
      customerId,
      lines(widget, 10),
      { method: "ON_ACCOUNT" },
      { key },
    );
    expect(sale.total).toBeCloseTo(100, 2);
    const returnKey = `rk-${key}`;
    const dto = {
      customerId,
      orderId: sale.orderId,
      returnKey,
      items: [{ productId: widget, boxes: 0, pieces: 4 }],
    };
    const notesBefore = (await creditNotesOf(plain, customerId)).length;
    let captured: Record<string, unknown> | undefined;
    let capErr: { status?: number; response?: unknown } | undefined;
    try {
      captured = await tenantCtx.run(plain.tenantId, () =>
        inlineSvc.capture(dto as never, staff(plain)),
      );
    } catch (e) {
      capErr = e as { status?: number; response?: unknown };
    }
    obs(
      "T1 capture",
      capErr
        ? { status: capErr.status, body: capErr.response }
        : {
            status: captured?.status,
            creditNoteId: captured?.creditNoteId,
            restock: (captured?.items as Array<{ restock: boolean }> | undefined)?.map(
              (i) => i.restock,
            ),
          },
    );
    expect(capErr).toBeUndefined();
    expect(captured?.creditNoteId).toBeTruthy();
    const replay = await tenantCtx.run(plain.tenantId, () =>
      inlineSvc.capture(dto as never, staff(plain)),
    );
    expect(replay.id).toBe(captured?.id);
    expect(replay.creditNoteId).toBe(captured?.creditNoteId);

    const notes = await creditNotesOf(plain, customerId);
    expect(notes).toHaveLength(notesBefore + 1);
    const f = await footprint(plain, key);
    const applied = ofMethod(f.live, "CREDIT_NOTE");
    obs("T1 invoice", {
      applied: applied.map((p) => Number(p.amount)),
      creditNote: notes.map((c) => ({ a: Number(c.amount), used: Number(c.amountUsed) })),
    });
    expect(sum(applied)).toBeCloseTo(40, 2);
    expect(confirmedRemaining(Number(f.invoices[0].total), f.payments)).toBeCloseTo(60, 2);
    expect(await creditLeft(plain, customerId)).toBeCloseTo(0, 2);
    const ret = await raw.return.findUniqueOrThrow({
      where: { id: String(captured?.id) },
      include: { items: true },
    });
    expect(ret.items).toHaveLength(1);
    const mv = await movements(widget);
    if (ret.items[0].restock) {
      expect(mv.ret).toHaveLength(1);
      expect(Number(mv.ret[0].quantity)).toBe(4);
    } else {
      expect(mv.ret).toHaveLength(0);
    }
    obs("T1 return", {
      status: ret.status,
      restock: ret.items[0].restock,
      movements: mv.ret.length,
    });
    const byKey = await tenantCtx.run(plain.tenantId, () => service.byKey(key));
    expect(byKey.balanceDue).toBeCloseTo(60, 2);
    const statement = await tenantCtx.run(plain.tenantId, () =>
      buildOperatorStatement(prisma, customerId),
    );
    const row = statement.transactions.find(
      (t) => t.type === "INVOICE" && t.id === f.invoices[0].id,
    );
    expect(row?.runningBalance).toBeCloseTo(-60, 2);
  }, 60_000);
});
