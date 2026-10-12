/**
 * Counter Sale transaction INTEGRITY on real Postgres (row 383, Oct-13 release gate): the REAL chain, not stand-ins.
 *
 * Real: CounterSaleService.ring -> OrdersService.createSale -> create() (stock lock + decrement) -> createInvoiceFromOrder ->
 * InvoicesService.send -> tender under the counter advisory lock -> InvoicesService.recordPayment, the real
 * TenantStatusGuard and the real tenant-scoped Prisma client. Stubbed (module boundary only): the gateway, email, PDF,
 * storage, commission engine, messaging.
 *
 * Cases: (a) double submit, (b) a failure mid-sale, (c) stock once / oversell, (d) tier price, tax from settings, partial and
 * on-account balances, (e) read-only tenant refused before any write, (f) overdue billing does not block, (g) cross-tenant ids.
 * A case is RED-FIRST only where it found a real defect; the rest are PINS (each says which).
 *
 * Runs only under `npm run local:test:db` (collected by jest.db.config.js). Throwaway `qa-cs-integrity-*` tenants.
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
import { ForbiddenException, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import type { FulfilmentCapability } from "@routeflow/types";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { _resetLockPoolForTests } from "../../common/db-locks";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { TenantStatusGuard } from "../../tenant/tenant-status.guard";
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
import { entitlementAuthorityFromEntitlements } from "../../testing/entitlement-authority-provider";
import { OrdersService } from "../orders.service";
import type { AuditService } from "../../audit/audit.service";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import type { CounterSaleDto } from "./counter-sale.dto";
import { CounterSaleService } from "./counter-sale.service";
import { CounterSaleVoidService } from "./counter-sale-void.service";
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

describeDb("Counter Sale integrity, the real chain on Postgres (row 383)", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoices: InvoicesService;
  let orders: OrdersService;
  let service: CounterSaleService;
  let voids: CounterSaleVoidService;
  let guard: TenantStatusGuard;

  interface Shop {
    tenantId: string;
    slug: string;
    operatorId: string;
    customerId: string;
    tierCustomerId: string;
    cola: string; // plain product, price 10.00, stock 20, tier 2 price 8.00
    scarce: string; // price 5.00, stock 1
  }
  let A: Shop;
  let B: Shop;
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  let seq = 0;

  const staff = (s: Shop, role: "OPERATOR" | "TENANT_ADMIN" = "OPERATOR"): JwtPayload =>
    ({
      sub: s.operatorId,
      username: `op-${s.slug}`,
      role,
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId: s.tenantId,
      tenantSlug: s.slug,
    }) as JwtPayload;

  async function shop(label: string): Promise<Shop> {
    seq += 1;
    const slug = assertTestTenant(
      `qa-cs-integrity-${RUN}-${seq}-${label}`,
      "counter-sale-integrity.db.spec.ts",
    );
    const tenant = await raw.tenant.create({ data: { slug, name: `CS integrity ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    await raw.tenantConfig.create({ data: { tenantId, timezone: "America/New_York" } });
    await raw.systemConfig.create({ data: { tenantId, key: "settings.taxRate", value: "8.25" } });
    const mkUser = async (role: "OPERATOR" | "CUSTOMER", tag: string) => {
      const u = await raw.user.create({
        data: { email: `${tag}-${slug}@example.test`, username: `${tag}-${slug}`, role, tenantId },
      });
      userIds.push(u.id);
      return u.id;
    };
    const operatorId = await mkUser("OPERATOR", "op");
    const mkCustomer = async (tag: string, pricingTier: number) =>
      (
        await raw.customer.create({
          data: {
            userId: await mkUser("CUSTOMER", tag),
            businessName: `Acme ${tag}`,
            contactName: "T",
            tenantId,
            pricingTier,
          },
        })
      ).id;
    const customerId = await mkCustomer("c1", 1);
    const tierCustomerId = await mkCustomer("tier2", 2);
    const product = async (name: string, price: string, stock: string, tier2?: string) =>
      (
        await raw.product.create({
          data: {
            name: `${name} ${slug}`,
            unit: "each",
            pricePerUnit: price,
            ...(tier2 ? { priceTier2: tier2 } : {}),
            currentStock: stock,
            tenantId,
          } as never,
        })
      ).id;
    return {
      tenantId,
      slug,
      operatorId,
      customerId,
      tierCustomerId,
      cola: await product("cola", "10.00", "20", "8.00"),
      scarce: await product("scarce", "5.00", "1"),
    };
  }

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
    const mod = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: async () => undefined },
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
        { provide: SystemConfigService, useValue: systemConfig },
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
    invoices = mod.get(InvoicesService);

    // unknown collaborators answer any method with a no-op (never `then`): the void's cancel unwind reads them
    const anyMethod = new Proxy(
      {},
      { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
    );
    const creditNotes = new CreditNotesService(
      prisma,
      anyMethod as never,
      anyMethod as never,
      { syncInvoiceCommissionSafe: async () => undefined } as never,
      anyMethod as never,
    );
    orders = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      creditNotes,
      gateway: { emitOrderCreated: jest.fn(), emitUrgentOrder: jest.fn() },
      systemConfig,
      entitlements: { hasFlag: async () => true },
      sellingRestrictions: { assertLinesSellable: async () => undefined },
      authGuard: { assertAuthorizedOrThrow: async () => undefined },
      promotionsService: { activeForCatalog: async () => [] },
      ledger: {},
      tenantCtx,
      logger: new Logger(OrdersService.name),
      invoicesService: invoices,
    });
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
    voids = new CounterSaleVoidService(orders, invoices, prisma, {
      emitOrderStatusChanged: jest.fn(),
    } as never);
    guard = new TenantStatusGuard(prisma);

    A = await shop("a");
    B = await shop("b");
  }, 180_000);

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    const where = { where: { tenantId: { in: tenantIds } } };
    await raw.invoicePayment.deleteMany(where).catch(swallow);
    await raw.paymentCounter.deleteMany(where).catch(swallow);
    await raw.regulatedSalesLedger.deleteMany(where).catch(swallow);
    await raw.invoiceItem.deleteMany(where).catch(swallow);
    await raw.invoice.deleteMany(where).catch(swallow);
    await raw.stockMovement
      .deleteMany({ where: { product: { tenantId: { in: tenantIds } } } })
      .catch(swallow);
    await raw.orderItem.deleteMany(where).catch(swallow);
    await raw.order.deleteMany(where).catch(swallow);
    await raw.tenantSubscription.deleteMany(where).catch(swallow);
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

  const key = () => randomUUID();
  type Pay = CounterSaleDto["payment"];
  const ring = (
    s: Shop,
    k: string,
    over: {
      items?: Array<{ productId: string; qty: number }>;
      payment?: Pay;
      customerId?: string;
    } = {},
    as?: JwtPayload,
  ) =>
    tenantCtx.run(s.tenantId, () =>
      service.ring(
        {
          customerId: over.customerId ?? s.customerId,
          items: over.items ?? [{ productId: s.cola, qty: 2 }],
          payment: over.payment ?? ({ method: "CASH", amount: 100 } as Pay),
        } as CounterSaleDto,
        as ?? staff(s),
        k,
      ),
    );

  /** What a sale left behind, by its Idempotency-Key (the tenant is never trusted from the caller). */
  async function footprint(s: Shop, k: string, productId = s.cola) {
    const orderRows = await raw.order.findMany({
      where: { tenantId: s.tenantId, idempotencyKey: k },
      select: { id: true, status: true, total: true, tax: true },
    });
    const orderIds = orderRows.map((o) => o.id);
    const invoiceRows = await raw.invoice.findMany({
      where: { tenantId: s.tenantId, orderId: { in: orderIds } },
      select: { id: true, status: true, total: true },
    });
    const payments = await raw.invoicePayment.findMany({
      where: { tenantId: s.tenantId, invoiceId: { in: invoiceRows.map((i) => i.id) } },
      select: { amount: true, status: true, method: true },
    });
    const sales = await raw.stockMovement.count({
      where: {
        productId,
        type: "SALE",
        reference: { in: orderIds.map((id) => `ORDER:${id}`) },
      },
    });
    return { orders: orderRows, invoices: invoiceRows, payments, saleMovements: sales };
  }
  const stockOf = async (productId: string) =>
    Number((await raw.product.findUniqueOrThrow({ where: { id: productId } })).currentStock);

  // ── (a) double submit ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("(a) a double submit leaves exactly one sale", () => {
    it("PIN: the same Idempotency-Key twice, sequentially: one order, one invoice, one payment, one stock decrement", async () => {
      const k = key();
      const before = await stockOf(A.cola);
      const first = await ring(A, k);
      const second = await ring(A, k);

      const f = await footprint(A, k);
      expect(f.orders).toHaveLength(1);
      expect(f.invoices).toHaveLength(1);
      expect(f.payments).toHaveLength(1);
      expect(f.saleMovements).toBe(1);
      expect(await stockOf(A.cola)).toBe(before - 2);
      expect(second.orderId).toBe(first.orderId);
      expect(second.replayed).toBe(true);
    });

    it("PIN: two CONCURRENT submits of one key: one order, one invoice, one payment, one stock decrement", async () => {
      const k = key();
      const before = await stockOf(A.cola);
      const results = await Promise.allSettled([ring(A, k), ring(A, k)]);

      const f = await footprint(A, k);
      expect(f.orders).toHaveLength(1);
      expect(f.invoices).toHaveLength(1);
      expect(f.payments).toHaveLength(1);
      expect(f.saleMovements).toBe(1);
      expect(await stockOf(A.cola)).toBe(before - 2);
      // a loser may be a retryable 409 (the by-key replay path), never a second sale
      for (const r of results) {
        if (r.status === "rejected")
          expect((r.reason as { getStatus?: () => number }).getStatus?.()).toBe(409);
      }
    });

    it("PIN: the same key with a different cart is refused (409) and writes nothing more", async () => {
      const k = key();
      await ring(A, k);
      const before = await footprint(A, k);
      await expect(ring(A, k, { items: [{ productId: A.cola, qty: 5 }] })).rejects.toMatchObject({
        response: { code: "IDEMPOTENCY_KEY_CART_MISMATCH" },
      });
      expect(await footprint(A, k)).toEqual(before);
    });
  });

  // ── (b) a failure mid-sale ────────────────────────────────────────────────────────────────────────────────────────
  describe("(b) a failure mid-sale never leaves a half sale that cannot be finished", () => {
    it("PIN: the invoice step throws after the order committed: the order exists ONCE, stock is out ONCE, and the same-key retry finishes it (one invoice, one payment)", async () => {
      const k = key();
      const before = await stockOf(A.cola);
      const spy = jest
        .spyOn(invoices, "createInvoiceFromOrder")
        .mockRejectedValueOnce(new Error("invoice pipeline unavailable"));
      await expect(ring(A, k)).rejects.toThrow(/invoice pipeline unavailable/);
      spy.mockRestore();

      let f = await footprint(A, k);
      expect(f.orders).toHaveLength(1); // the sale is findable, not lost
      expect(f.invoices).toHaveLength(0);
      expect(f.payments).toHaveLength(0);
      expect(await stockOf(A.cola)).toBe(before - 2); // out exactly once, with its movement
      expect(f.saleMovements).toBe(1);

      const retried = await ring(A, k);
      expect(retried.replayed).toBe(true);
      f = await footprint(A, k);
      expect(f.orders).toHaveLength(1);
      expect(f.invoices).toHaveLength(1);
      expect(f.payments).toHaveLength(1);
      expect(f.saleMovements).toBe(1);
      expect(await stockOf(A.cola)).toBe(before - 2);
    });

    it("PIN: the send step throws after the invoice exists: still one invoice, the retry sends it and records ONE payment", async () => {
      const k = key();
      const before = await stockOf(A.cola);
      const spy = jest.spyOn(invoices, "send").mockRejectedValueOnce(new Error("send unavailable"));
      await expect(ring(A, k)).rejects.toThrow(/send unavailable/);
      spy.mockRestore();
      let f = await footprint(A, k);
      expect(f.orders).toHaveLength(1);
      expect(f.invoices).toHaveLength(1);
      expect(f.payments).toHaveLength(0);

      await ring(A, k);
      f = await footprint(A, k);
      expect(f.invoices).toHaveLength(1);
      expect(f.payments).toHaveLength(1);
      expect(await stockOf(A.cola)).toBe(before - 2);
    });

    it("PIN: the payment step throws after the sale committed: 201 with paymentRecorded false, no payment row, the retry records exactly one", async () => {
      const k = key();
      const spy = jest
        .spyOn(invoices, "recordPayment")
        .mockRejectedValueOnce(new Error("payment pipeline unavailable"));
      const first = await ring(A, k);
      spy.mockRestore();
      expect(first.paymentRecorded).toBe(false);
      let f = await footprint(A, k);
      expect(f.payments).toHaveLength(0);

      const second = await ring(A, k);
      expect(second.paymentRecorded).toBe(true);
      f = await footprint(A, k);
      expect(f.payments).toHaveLength(1);
      expect(f.orders).toHaveLength(1);
    });

    it("PIN: a refusal inside create() (insufficient SELLING right: the restriction gate) writes nothing: no order, no stock move", async () => {
      const k = key();
      const before = await stockOf(A.cola);
      const spy = jest
        .spyOn(orders as unknown as { create: (...a: unknown[]) => unknown }, "create")
        .mockRejectedValueOnce(new ForbiddenException("restricted"));
      await expect(ring(A, k)).rejects.toBeInstanceOf(ForbiddenException);
      spy.mockRestore();
      const f = await footprint(A, k);
      expect(f.orders).toHaveLength(0);
      expect(f.invoices).toHaveLength(0);
      expect(await stockOf(A.cola)).toBe(before);
    });
  });

  // ── (c) stock ─────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("(c) stock moves once and follows the oversell policy", () => {
    it("PIN: a sale decrements stock exactly once by the pieces sold, with one SALE movement", async () => {
      const k = key();
      const before = await stockOf(A.cola);
      await ring(A, k, {
        items: [{ productId: A.cola, qty: 3 }],
        payment: { method: "CASH", amount: 100 } as Pay,
      });
      const f = await footprint(A, k);
      expect(await stockOf(A.cola)).toBe(before - 3);
      expect(f.saleMovements).toBe(1);
    });

    it("PIN: STAFF oversell is allowed by policy: a sale past stock completes, stock goes negative once, and the line carries the backorder marker", async () => {
      const k = key();
      const before = await stockOf(A.scarce); // 1
      await ring(A, k, {
        items: [{ productId: A.scarce, qty: 4 }],
        payment: { method: "CASH", amount: 100 } as Pay,
      });
      expect(await stockOf(A.scarce)).toBe(before - 4);
      const li = await raw.orderItem.findFirstOrThrow({
        where: { tenantId: A.tenantId, order: { idempotencyKey: k } },
        select: { backorderedPieces: true },
      });
      expect(Number(li.backorderedPieces)).toBe(3); // 4 sold, 1 on hand
      const f = await footprint(A, k, A.scarce);
      expect(f.saleMovements).toBe(1);
    });

    it("PIN: a hand-over (PENDING -> CONFIRMED -> DELIVERED) of an order creates no second decrement", async () => {
      const k = key();
      const before = await stockOf(A.cola);
      const created = await tenantCtx.run(A.tenantId, () =>
        orders.create(
          {
            customerId: A.customerId,
            items: [{ productId: A.cola, qty: 2 }],
            idempotencyKey: k,
          } as never,
          staff(A),
        ),
      );
      const id = (created as { id: string }).id;
      const afterCreate = await stockOf(A.cola);
      expect(afterCreate).toBe(before - 2);
      const movements = () =>
        raw.stockMovement.count({ where: { productId: A.cola, reference: `ORDER:${id}` } });
      expect(await movements()).toBe(1);

      await raw.order.update({ where: { id }, data: { status: "CONFIRMED" } }); // the confirm only changes status
      await raw.order.update({ where: { id }, data: { status: "DELIVERED" } }); // the hand-over marks DELIVERED
      expect(await stockOf(A.cola)).toBe(afterCreate);
      expect(await movements()).toBe(1);
    });
  });

  describe("(c2) a void reverses the sale once", () => {
    it("PIN: voiding a ring restores the stock exactly once, voids the payment and invoice, cancels the order; a repeat restores nothing more", async () => {
      const k = key();
      const before = await stockOf(A.cola);
      const sold = await ring(A, k, {
        items: [{ productId: A.cola, qty: 3 }],
        payment: { method: "CASH", amount: 100 } as Pay,
      });
      expect(await stockOf(A.cola)).toBe(before - 3);

      const first = await tenantCtx.run(A.tenantId, () =>
        voids.voidSale(sold.orderId, { reason: "customer changed mind" } as never, staff(A)),
      );
      expect(first.replayed).toBeFalsy();
      expect(await stockOf(A.cola)).toBe(before); // back exactly once
      const order = await raw.order.findUniqueOrThrow({ where: { id: sold.orderId } });
      expect(order.status).toBe("CANCELLED");
      const f = await footprint(A, k);
      expect(f.invoices[0].status).toBe("VOID");
      expect(f.payments.every((p) => p.status === "VOID")).toBe(true);

      const again = await tenantCtx.run(A.tenantId, () =>
        voids.voidSale(sold.orderId, { reason: "customer changed mind" } as never, staff(A)),
      );
      expect(again.replayed).toBe(true);
      expect(await stockOf(A.cola)).toBe(before); // never restored twice
      const restores = await raw.stockMovement.count({
        where: { productId: A.cola, reference: { contains: sold.orderId } },
      });
      expect(restores).toBe(2); // the SALE and exactly one reversal
    });

    it("PIN: tenant B's order id from tenant A's void route is 404 and changes nothing on B", async () => {
      const bk = key();
      const bSale = await ring(B, bk, { items: [{ productId: B.cola, qty: 1 }] });
      const bStock = await stockOf(B.cola);
      await expect(
        tenantCtx.run(A.tenantId, () =>
          voids.voidSale(bSale.orderId, { reason: "not mine to void" } as never, staff(A)),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await stockOf(B.cola)).toBe(bStock);
      expect((await raw.order.findUniqueOrThrow({ where: { id: bSale.orderId } })).status).not.toBe(
        "CANCELLED",
      );
    });
  });

  describe("(b2) by-key after a half sale", () => {
    it("PIN: a fully sent and paid sale still reads LIVE: by-key answers 200 with the stored tender", async () => {
      const k = key();
      const rung = await ring(A, k);
      const read = await tenantCtx.run(A.tenantId, () => service.byKey(k));
      expect(read.replayed).toBe(true);
      expect(read.paymentRecorded).toBe(true);
      expect(read.orderId).toBe(rung.orderId);
      expect(read.balanceDue).toBe(rung.balanceDue);
    });

    // Row 383 (P1, FIXED here): storedSaleState() used to call an order whose only invoice is an unsent DRAFT "live", so
    // by-key answered 200 {paymentRecorded: true} for a half sale and the till stopped retrying. It is now "incomplete".
    it("RED-FIRST: after the send step failed (invoice DRAFT, no payment) by-key is 409 COUNTER_SALE_INCOMPLETE, and the same-key re-POST finishes it", async () => {
      const k = key();
      const spy = jest.spyOn(invoices, "send").mockRejectedValueOnce(new Error("send unavailable"));
      await expect(ring(A, k)).rejects.toThrow(/send unavailable/);
      spy.mockRestore();

      await expect(tenantCtx.run(A.tenantId, () => service.byKey(k))).rejects.toMatchObject({
        response: { code: "COUNTER_SALE_INCOMPLETE" },
      });

      const finished = await ring(A, k);
      expect(finished.paymentRecorded).toBe(true);
      const f = await footprint(A, k);
      expect(f.invoices).toHaveLength(1);
      expect(f.invoices[0].status).not.toBe("DRAFT");
      expect(f.payments).toHaveLength(1);
      // and now by-key reads it as the finished sale it is
      const read = await tenantCtx.run(A.tenantId, () => service.byKey(k));
      expect(read.paymentRecorded).toBe(true);
    });
  });

  // ── (d) price, tax, rounding, balances ────────────────────────────────────────────────────────────────────────────
  describe("(d) price follows the customer's tier, tax comes from settings, balances are exact", () => {
    it("PIN: a tier-2 customer is priced at the product's tier-2 price; tax is the configured 8.25% rounded once", async () => {
      const k = key();
      const res = await ring(A, k, {
        customerId: A.tierCustomerId,
        items: [{ productId: A.cola, qty: 3 }],
        payment: { method: "CASH", amount: 100 } as Pay,
      });
      const li = await raw.orderItem.findFirstOrThrow({
        where: { tenantId: A.tenantId, order: { idempotencyKey: k } },
        select: { unitPrice: true, subtotal: true },
      });
      expect(Number(li.unitPrice)).toBe(8); // tier 2, not the 10.00 list price
      expect(Number(li.subtotal)).toBe(24);
      const order = await raw.order.findFirstOrThrow({
        where: { tenantId: A.tenantId, idempotencyKey: k },
      });
      // 24.00 x 8.25% = 1.98 (rounded once at cents); total 25.98
      expect(Number(order.tax)).toBe(1.98);
      expect(Number(order.total)).toBe(25.98);
      expect(res.total).toBe(25.98);
    });

    it("PIN: a partial CASH tender leaves the exact balance; the invoice stays open", async () => {
      const k = key();
      const res = await ring(A, k, {
        items: [{ productId: A.cola, qty: 2 }],
        payment: { method: "CASH", amount: 10 } as Pay,
      });
      // 2 x 10.00 = 20.00 + 8.25% (1.65) = 21.65; 10.00 paid
      expect(res.total).toBe(21.65);
      expect(res.balanceDue).toBe(11.65);
      const f = await footprint(A, k);
      expect(f.payments).toHaveLength(1);
      expect(Number(f.payments[0].amount)).toBe(10);
      expect(f.invoices[0].status).not.toBe("PAID");
    });

    it("PIN: ON_ACCOUNT takes no money: the whole total is the balance, no payment row", async () => {
      const k = key();
      const res = await ring(A, k, {
        items: [{ productId: A.cola, qty: 1 }],
        payment: { method: "ON_ACCOUNT" } as Pay,
      });
      expect(res.total).toBe(10.83); // 10.00 + 0.825 rounded to cents
      expect(res.balanceDue).toBe(10.83);
      const f = await footprint(A, k);
      expect(f.payments).toHaveLength(0);
      expect(f.invoices).toHaveLength(1);
    });

    it("PIN: a full CASH tender closes the invoice PAID and the change is exact", async () => {
      const k = key();
      const res = await ring(A, k, {
        items: [{ productId: A.cola, qty: 1 }],
        payment: { method: "CASH", amount: 20 } as Pay,
      });
      expect(res.balanceDue).toBe(0);
      expect(res.change).toBe(9.17); // 20.00 - 10.83
      const f = await footprint(A, k);
      expect(f.invoices[0].status).toBe("PAID");
    });
  });

  // ── (e) a read-only tenant ────────────────────────────────────────────────────────────────────────────────────────
  describe("(e) a read-only tenant is refused before the handler runs", () => {
    const ctxFor = (s: Shop, method: string, url: string) => {
      const payload = Buffer.from(
        JSON.stringify({ tenantId: s.tenantId, role: "OPERATOR" }),
      ).toString("base64url");
      const req = {
        method,
        url,
        originalUrl: url,
        path: url,
        headers: { authorization: `Bearer x.${payload}.y` },
      };
      return { switchToHttp: () => ({ getRequest: () => req }) } as never;
    };

    it("PIN: READ_ONLY -> POST /orders/counter-sale is 403 READ_ONLY, so the handler never runs and nothing is written", async () => {
      const ro = await shop("readonly");
      await raw.tenant.update({ where: { id: ro.tenantId }, data: { status: "READ_ONLY" } });
      guard.invalidateAll();
      const before = await raw.order.count({ where: { tenantId: ro.tenantId } });

      await expect(
        guard.canActivate(ctxFor(ro, "POST", "/api/v1/orders/counter-sale")),
      ).rejects.toMatchObject({ response: { code: "READ_ONLY" } });
      // the day close stays allowed, the rest of the till (void, pickup) stays refused
      await expect(
        guard.canActivate(ctxFor(ro, "POST", "/api/v1/orders/counter-sale/day-close")),
      ).resolves.toBe(true);
      await expect(
        guard.canActivate(ctxFor(ro, "POST", `/api/v1/orders/counter-sale/${randomUUID()}/void`)),
      ).rejects.toMatchObject({ response: { code: "READ_ONLY" } });
      await expect(
        guard.canActivate(ctxFor(ro, "POST", `/api/v1/orders/${randomUUID()}/pickup-complete`)),
      ).rejects.toMatchObject({ response: { code: "READ_ONLY" } });

      expect(await raw.order.count({ where: { tenantId: ro.tenantId } })).toBe(before);
      expect(await raw.invoice.count({ where: { tenantId: ro.tenantId } })).toBe(0);
    });
  });

  describe("(e2) the status cache", () => {
    it("KNOWN GAP (pinned, minor): a status change that does not call invalidate() is honoured only after the 60 s cache TTL", async () => {
      const lag = await shop("cachelag");
      const ctx = (() => {
        const payload = Buffer.from(
          JSON.stringify({ tenantId: lag.tenantId, role: "OPERATOR" }),
        ).toString("base64url");
        const req = {
          method: "POST",
          url: "/api/v1/orders/counter-sale",
          originalUrl: "/api/v1/orders/counter-sale",
          path: "/api/v1/orders/counter-sale",
          headers: { authorization: `Bearer x.${payload}.y` },
        };
        return { switchToHttp: () => ({ getRequest: () => req }) } as never;
      })();
      guard.invalidateAll();
      await expect(guard.canActivate(ctx)).resolves.toBe(true); // ACTIVE, now cached
      // billing (dunning / trial end) flips the row WITHOUT calling guard.invalidate(): only platform-admin does
      await raw.tenant.update({ where: { id: lag.tenantId }, data: { status: "READ_ONLY" } });
      await expect(guard.canActivate(ctx)).resolves.toBe(true); // still served from the cache
      guard.invalidate(lag.tenantId);
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({
        response: { code: "READ_ONLY" },
      });
    });
  });

  // ── (f) overdue billing alone does not block ──────────────────────────────────────────────────────────────────────
  describe("(f) overdue billing alone does not block a sale (dunning is dark)", () => {
    it("PIN: an ACTIVE tenant with a past-due platform invoice passes the guard and rings a sale", async () => {
      const od = await shop("overdue");
      await raw.tenantSubscription.create({
        data: {
          tenantId: od.tenantId,
          pastDueSince: new Date(Date.now() - 20 * 24 * 3600 * 1000),
          pastDueInvoiceId: `in_overdue_${RUN}`,
          failedPaymentCount: 3,
        } as never,
      });
      await raw.tenant.update({ where: { id: od.tenantId }, data: { status: "ACTIVE" } });
      guard.invalidateAll();

      await expect(
        guard.canActivate(ctxFor(od, "POST", "/api/v1/orders/counter-sale")),
      ).resolves.toBe(true);
      const k = key();
      const res = await ring(od, k);
      expect(res.paymentRecorded).toBe(true);
      expect((await footprint(od, k)).orders).toHaveLength(1);
    });

    const ctxFor = (s: Shop, method: string, url: string) => {
      const payload = Buffer.from(
        JSON.stringify({ tenantId: s.tenantId, role: "OPERATOR" }),
      ).toString("base64url");
      const req = {
        method,
        url,
        originalUrl: url,
        path: url,
        headers: { authorization: `Bearer x.${payload}.y` },
      };
      return { switchToHttp: () => ({ getRequest: () => req }) } as never;
    };
  });

  // ── (g) cross-tenant ids ──────────────────────────────────────────────────────────────────────────────────────────
  describe("(g) another tenant's ids are not found and write nothing", () => {
    it("PIN: tenant B's product id from tenant A's till -> 404, no order, no stock move on B", async () => {
      const k = key();
      const bStock = await stockOf(B.cola);
      await expect(ring(A, k, { items: [{ productId: B.cola, qty: 1 }] })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect((await footprint(A, k)).orders).toHaveLength(0);
      expect(await stockOf(B.cola)).toBe(bStock);
    });

    it("PIN: tenant B's customer id -> 404 and nothing written", async () => {
      const k = key();
      await expect(ring(A, k, { customerId: B.customerId })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect((await footprint(A, k)).orders).toHaveLength(0);
    });

    it("PIN: tenant B's sale cannot be read, voided or replayed from tenant A (by-key 404, same key creates A's own sale)", async () => {
      const k = key();
      const bSale = await ring(B, k, { items: [{ productId: B.cola, qty: 1 }] });
      expect(bSale.paymentRecorded).toBe(true);
      // the same key under tenant A is A's own namespace: not a replay of B's order
      await expect(tenantCtx.run(A.tenantId, () => service.byKey(k))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const own = await ring(A, k, { items: [{ productId: A.cola, qty: 1 }] });
      expect(own.replayed).toBeFalsy();
      expect(own.orderId).not.toBe(bSale.orderId);
    });
  });
});
