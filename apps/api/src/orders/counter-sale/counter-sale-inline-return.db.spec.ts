/**
 * W-863 (SA-945 PR-1, MUST 8) — a named customer's counter sale carries Create Order's inline return, the REAL chain on
 * Postgres: CounterSaleService.ring -> OrdersService.createSale -> create() (the ONE return writer: capture + credit note +
 * order-credit intent in the sale's own transaction) -> createInvoiceFromOrder -> InvoicesService.send (the intent settles
 * onto the invoice as a PAID CREDIT_NOTE row) -> the tender plan (reads balances net of non-tender rows).
 *
 * Cases (red on master: the field is ignored, so no Return, no credit, and the whole total is due):
 *   (a) a $10.00 sale with a $4.00 return, tendered $6.00 CASH: due $6.00, paid, ONE Return, the credit used $4.00;
 *   (b) a $12.00 return on a $10.00 sale: nothing to tender, the customer keeps $2.00 of credit;
 *   (c) a replay of the same attempt: one sale, one Return row, one credit note;
 *   (d) the add-on off: 403 and nothing written (no order, no Return).
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Throwaway `qa-cs-inlret-*` tenants; placeholders only (acme).
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

describeDb("W-863 — a counter sale with an inline return, the real chain on Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: CounterSaleService;
  let inlineSvcRef: InlineReturnsService; // case (g) stubs its dry-run pricing
  let addonOn = true;
  let tenantId = "";
  let operatorId = "";
  let customerId = "";
  let big: string; // $10.00: the item sold
  let snack: string; // $4.00: the item returned (priced from the catalogue: not sold on a source order)
  let large: string; // $12.00: the item returned in case (b)
  let bulk: string; // $92.00: a customer's existing balance (case e)
  let limitedId = ""; // a $100.00 credit limit (case e)
  let limitedSale: { orderId: string; total: number } | undefined; // the sale case (e) rang, re-checked by case (f)
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const slug = assertTestTenant(`qa-cs-inlret-${RUN}`, "counter-sale-inline-return.db.spec.ts");

  const staff = (): JwtPayload =>
    ({
      sub: operatorId,
      username: `op-${slug}`,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
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
    const inlineSvc = Object.assign(Object.create(InlineReturnsService.prototype), {
      prisma,
      gateway: { emitCreditNoteCreated: jest.fn() },
      ledger,
      creditNotes,
      numbering,
      addonService: { hasAddon: async () => addonOn },
      quoteService: new InlineReturnsQuoteService(prisma, systemConfig),
      idempotency: new IdempotencyService(),
    });
    inlineSvcRef = inlineSvc;
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

    const tenant = await raw.tenant.create({ data: { slug, name: `CS inline return ${slug}` } });
    tenantId = tenant.id;
    tenantIds.push(tenantId);
    await raw.tenantConfig.create({ data: { tenantId, timezone: "America/New_York" } });
    const mkUser = async (role: "OPERATOR" | "CUSTOMER", tag: string) => {
      const u = await raw.user.create({
        data: { email: `${tag}-${slug}@example.test`, username: `${tag}-${slug}`, role, tenantId },
      });
      userIds.push(u.id);
      return u.id;
    };
    operatorId = await mkUser("OPERATOR", "op");
    customerId = (
      await raw.customer.create({
        data: {
          userId: await mkUser("CUSTOMER", "c1"),
          businessName: "Acme Shop",
          contactName: "T",
          tenantId,
        },
      })
    ).id;
    const product = async (name: string, price: string) =>
      (
        await raw.product.create({
          data: {
            name: `${name} ${slug}`,
            unit: "each",
            pricePerUnit: price,
            currentStock: "50",
            tenantId,
          } as never,
        })
      ).id;
    big = await product("big", "10.00");
    snack = await product("snack", "4.00");
    large = await product("large", "12.00");
    bulk = await product("bulk", "92.00");
    // SA-945 MUST 6: a customer with a $100.00 limit, and the credit gate ENFORCED for new orders
    limitedId = (
      await raw.customer.create({
        data: {
          userId: await mkUser("CUSTOMER", "c2"),
          businessName: "Acme Limited",
          contactName: "T",
          tenantId,
          creditLimit: "100.00",
        },
      })
    ).id;
    await raw.systemConfig.create({
      data: { tenantId, key: "credit_limit.enforce_new_orders", value: "true" },
    });
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

  const returnOf = (productId: string, key: string) => ({
    returnKey: key,
    items: [{ productId, qty: 1, boxes: 0, pieces: 1 }],
  });
  const ring = (
    key: string,
    inlineReturn: ReturnType<typeof returnOf> | undefined,
    payment: CounterSaleDto["payment"],
    who = { customerId, productId: big },
  ) =>
    tenantCtx.run(tenantId, () =>
      service.ring(
        {
          customerId: who.customerId,
          items: [{ productId: who.productId, qty: 1 }],
          payment,
          ...(inlineReturn ? { inlineReturn } : {}),
        } as CounterSaleDto,
        staff(),
        key,
      ),
    );

  /** What the sale left behind, by its Idempotency-Key. */
  async function footprint(key: string) {
    const orders = await raw.order.findMany({ where: { tenantId, idempotencyKey: key } });
    const orderIds = orders.map((o) => o.id);
    const invoices = await raw.invoice.findMany({ where: { tenantId, orderId: { in: orderIds } } });
    const payments = await raw.invoicePayment.findMany({
      where: { tenantId, invoiceId: { in: invoices.map((i) => i.id) } },
    });
    const returns = await raw.return.findMany({ where: { tenantId, orderId: { in: orderIds } } });
    return { orders, invoices, payments, returns };
  }
  const sum = (rows: Array<{ amount: unknown }>) => rows.reduce((s, r) => s + Number(r.amount), 0);

  it("(a) $10.00 sale, $4.00 return, $6.00 cash: due $6.00, paid, ONE Return, the credit used $4.00", async () => {
    addonOn = true;
    const key = randomUUID();
    const res = await ring(key, returnOf(snack, `rk-${key}`), { method: "CASH", amount: 6 });
    expect(res.paymentRecorded).toBe(true);
    expect(res.balanceDue).toBeCloseTo(0, 2);
    // SA-1077 / W-1090 R13: the response carries the split the reprint reads, on the real mint (its credit note has no invoice
    // link, so the credit stays a tender there: Cash $6.00 + Store credit $4.00, Paid $10.00) and the STORED cash tendered
    expect(res.cashTendered).toBeCloseTo(6, 2);
    expect(res.tenderPaid).toBeCloseTo(10, 2);
    expect(res.tenderMethods).toEqual([
      { method: "CASH", amount: 6 },
      { method: "STORE_CREDIT", amount: 4 },
    ]);
    const f = await footprint(key);
    expect(f.returns).toHaveLength(1);
    expect(f.orders).toHaveLength(1);
    expect(f.invoices).toHaveLength(1);
    expect(Number(f.invoices[0].total)).toBeCloseTo(10, 2);
    const paid = f.payments.filter((p) => p.status !== "VOID");
    expect(sum(paid.filter((p) => p.method === "CASH"))).toBeCloseTo(6, 2);
    expect(sum(paid.filter((p) => p.method === "CREDIT_NOTE"))).toBeCloseTo(4, 2);
    const cns = await raw.creditNote.findMany({ where: { customerId, tenantId } });
    expect(sum(cns.filter((c) => Number(c.amount) === 4))).toBeCloseTo(4, 2);
  }, 60_000);

  it("(b) a $12.00 return on a $10.00 sale: nothing to tender, the customer keeps $2.00 of credit", async () => {
    addonOn = true;
    const before = await raw.creditNote.findMany({ where: { customerId, tenantId } });
    const beforeLeft = sum(
      before.map((c) => ({ amount: Number(c.amount) - Number(c.amountUsed) })),
    );
    const key = randomUUID();
    const res = await ring(key, returnOf(large, `rk-${key}`), { method: "CASH" });
    expect(res.balanceDue).toBeCloseTo(0, 2);
    const f = await footprint(key);
    expect(f.returns).toHaveLength(1);
    expect(sum(f.payments.filter((p) => p.method === "CASH" && p.status !== "VOID"))).toBeCloseTo(
      0,
      2,
    );
    const after = await raw.creditNote.findMany({ where: { customerId, tenantId } });
    const afterLeft = sum(after.map((c) => ({ amount: Number(c.amount) - Number(c.amountUsed) })));
    expect(afterLeft - beforeLeft).toBeCloseTo(2, 2);
  }, 60_000);

  it("(c) a replay of the same attempt: one sale, one Return row, one credit note", async () => {
    addonOn = true;
    const key = randomUUID();
    const rk = `rk-${key}`;
    const first = await ring(key, returnOf(snack, rk), { method: "CASH", amount: 6 });
    const notesAfterFirst = await raw.creditNote.count({ where: { tenantId, customerId } });
    const second = await ring(key, returnOf(snack, rk), { method: "CASH", amount: 6 });
    expect(second.orderId).toBe(first.orderId);
    expect(second.replayed).toBe(true);
    const f = await footprint(key);
    expect(f.orders).toHaveLength(1);
    expect(f.returns).toHaveLength(1);
    expect(f.payments.filter((p) => p.method === "CASH" && p.status !== "VOID")).toHaveLength(1);
    // the replay minted no second credit note, and the sale carries exactly ONE credit link (counted by the sale's link and
    // by the customer's notes before and after, never by the note's own primary key)
    expect(f.returns[0].creditNoteId).toBeTruthy();
    expect(await raw.creditNote.count({ where: { tenantId, customerId } })).toBe(notesAfterFirst);
    expect(await raw.orderCreditNote.count({ where: { orderId: first.orderId } })).toBe(1);
  }, 60_000);

  it("(e) the credit gate nets the SERVER-priced return: limit 100, balance 92, $10.00 on account with a $4.00 return is exposure 98, allowed", async () => {
    addonOn = true;
    const who = { customerId: limitedId, productId: big };
    await ring(
      randomUUID(),
      undefined,
      { method: "ON_ACCOUNT" },
      {
        customerId: limitedId,
        productId: bulk,
      },
    ); // the balance: 92.00
    // control (the gate is live): the same $10.00 with no return would take exposure to 102
    await expect(
      ring(randomUUID(), undefined, { method: "ON_ACCOUNT" }, who),
    ).rejects.toMatchObject({
      status: 409,
    });
    const key = randomUUID();
    const res = await ring(key, returnOf(snack, `rk-${key}`), { method: "ON_ACCOUNT" }, who);
    expect(res.paymentRecorded).toBe(true);
    const f = await footprint(key);
    expect(f.returns).toHaveLength(1);
    // the $4.00 credit paid this sale down: $6.00 is left on the sale, so exposure is 98.00
    expect(res.balanceDue).toBeCloseTo(6, 2);
    limitedSale = { orderId: f.orders[0].id, total: Number(f.orders[0].total) };
  }, 60_000);

  it("(f) creditRecheck nets the STORED return credit when it judges what is left: the case (e) sale re-checked with a $6.00 cash tender that did not record is not over the limit", async () => {
    expect(limitedSale).toBeDefined();
    // balance 92 (the other sale), this sale $10.00 with a $4.00 stored return credit, a $6.00 cash tender not recorded:
    // gross it judges 102 (over 100, the figures come back); net of the credit it judges 98 (nothing to report).
    const over = await tenantCtx.run(tenantId, () =>
      (
        service as unknown as {
          creditRecheck: (...a: unknown[]) => Promise<{ limit: number; exposure: number } | null>;
        }
      ).creditRecheck(
        limitedSale!.orderId,
        limitedId,
        limitedSale!.total,
        { method: "CASH", amount: 6 },
        undefined,
        "COUNTER_PAYMENT_NOT_RECORDED",
        staff(),
      ),
    );
    expect(over).toBeNull();
  }, 60_000);

  it("(g) SA-945 G5: when the credit really issued is below what the gate netted, the sale is refused 409 RETURN_CREDIT_CHANGED and nothing is written", async () => {
    addonOn = true;
    // the preview (dry-run) says $9.00; the in-transaction capture prices the real $4.00: a concurrent return landed between
    const spy = jest.spyOn(inlineSvcRef, "preflightNewOrderReturn").mockResolvedValue(9);
    const key = randomUUID();
    const before = await raw.creditNote.count({ where: { tenantId } });
    let refused: { status?: number; response?: { code?: string } } | undefined;
    try {
      await ring(key, returnOf(snack, `rk-${key}`), { method: "ON_ACCOUNT" }).catch(
        (e) => (refused = e),
      );
    } finally {
      spy.mockRestore();
    }
    expect(refused?.status).toBe(409);
    expect(refused?.response?.code).toBe("RETURN_CREDIT_CHANGED");
    const f = await footprint(key);
    expect(f.orders).toHaveLength(0);
    expect(f.returns).toHaveLength(0);
    expect(await raw.creditNote.count({ where: { tenantId } })).toBe(before);
  }, 60_000);

  it("(d) with the add-on off the field is refused 403 and nothing is written", async () => {
    addonOn = false;
    const key = randomUUID();
    await expect(
      ring(key, returnOf(snack, `rk-${key}`), { method: "CASH", amount: 6 }),
    ).rejects.toMatchObject({ status: 403 });
    const f = await footprint(key);
    expect(f.orders).toHaveLength(0);
    expect(f.returns).toHaveLength(0);
    addonOn = true;
  }, 60_000);

  it("(WI-G1, SA-1036) a walk-in sale with an inlineReturn is refused 409 WALK_IN_STORE_CREDIT_REFUSED before any write", async () => {
    addonOn = true;
    const key = randomUUID();
    const before = await raw.creditNote.count({ where: { tenantId } });
    let refused: { status?: number; response?: { code?: string } } | undefined;
    await tenantCtx
      .run(tenantId, () =>
        service.ring(
          {
            walkIn: true,
            items: [{ productId: big, qty: 1 }],
            payment: { method: "CASH", amount: 10 },
            inlineReturn: returnOf(snack, `rk-${key}`),
          } as CounterSaleDto,
          staff(),
          key,
        ),
      )
      .catch((e) => (refused = e));
    expect(refused?.status).toBe(409);
    expect(refused?.response?.code).toBe("WALK_IN_STORE_CREDIT_REFUSED");
    const f = await footprint(key);
    expect(f.orders).toHaveLength(0);
    expect(f.returns).toHaveLength(0);
    expect(await raw.creditNote.count({ where: { tenantId } })).toBe(before);
  }, 60_000);
});
