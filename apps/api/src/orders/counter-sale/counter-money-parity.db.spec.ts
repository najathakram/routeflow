/**
 * Counter money PARITY on real Postgres (CQ-01..CQ-03 class, G4): the order, the invoice and the sale answer carry ONE total.
 *
 * Real chain as in the integrity spec: CounterSaleService.ring -> OrdersService.createSale -> create() -> createInvoiceFromOrder ->
 * InvoicesService.send -> tender -> recordPayment. A RED test names the wrong value master produces today.
 *
 * Throwaway `qa-cs-parity-*` tenants. Runs only under `npm run local:test:db`.
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

describeDb("Counter money parity, the real chain on Postgres (CQ-01..CQ-03)", () => {
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
    exemptCustomerId: string; // isTaxExempt = true
    excise: string; // 10.00, EXCISE_PER_UNIT 0.50 / piece
    deposit: string; // 10.00, DEPOSIT_PER_CONTAINER 0.10 / piece
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
      `qa-cs-parity-${RUN}-${seq}-${label}`,
      "counter-money-parity.db.spec.ts",
    );
    const tenant = await raw.tenant.create({ data: { slug, name: `CS parity ${slug}` } });
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
    const exemptCustomerId = (
      await raw.customer.create({
        data: {
          userId: await mkUser("CUSTOMER", "exempt"),
          businessName: "Acme exempt",
          contactName: "T",
          tenantId,
          pricingTier: 1,
          isTaxExempt: true,
        },
      })
    ).id;
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
    const regulated = async (name: string, taxType: string, rate: string) => {
      const cat = await raw.trackedCategory.create({
        data: {
          tenantId,
          name: `${name} ${slug}`,
          taxType: taxType as never,
          rate,
          priceIncludesTax: false,
        },
      });
      return (
        await raw.product.create({
          data: {
            name: `${name} item ${slug}`,
            unit: "each",
            pricePerUnit: "10.00",
            currentStock: "50",
            trackedCategoryId: cat.id,
            tenantId,
          } as never,
        })
      ).id;
    };
    return {
      tenantId,
      slug,
      operatorId,
      customerId,
      tierCustomerId,
      exemptCustomerId,
      excise: await regulated("excise", "EXCISE_PER_UNIT", "0.5000"),
      deposit: await regulated("deposit", "DEPOSIT_PER_CONTAINER", "0.1000"),
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
      select: { id: true, status: true, total: true, tax: true, subtotal: true },
    });
    const orderIds = orderRows.map((o) => o.id);
    const invoiceRows = await raw.invoice.findMany({
      where: { tenantId: s.tenantId, orderId: { in: orderIds } },
      select: { id: true, status: true, total: true, taxAmount: true, subtotal: true },
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

  const cents = (n: unknown) => Math.round(Number(n) * 100) / 100;
  // a regulated category may bill on its own invoice: the sale's invoices sum to the order
  const invoiced = (f: { invoices: Array<{ total: unknown }> }) =>
    cents(f.invoices.reduce((s, i) => s + Number(i.total), 0));

  describe("a tax-exempt customer owes $0 tax on the order too, not only on the invoice", () => {
    it("CQ-02: an exempt customer's order is $20.00 with $0 tax, equal to its invoice (master wrote 21.65)", async () => {
      const k = key();
      const res = await ring(A, k, {
        customerId: A.exemptCustomerId,
        items: [{ productId: A.cola, qty: 2 }],
        payment: { method: "CASH", amount: 100 } as Pay,
      });
      const f = await footprint(A, k);
      expect(cents(f.invoices[0].total)).toBe(20); // the invoice honours RF-079
      expect(cents(f.orders[0].tax)).toBe(0);
      expect(cents(f.orders[0].total)).toBe(20);
      expect(cents(res.total)).toBe(20);
    });

    it("CQ-02: an exempt customer's excise and deposit are $0 on the order as well as the invoice (master wrote 89.00)", async () => {
      const k = key();
      await ring(A, k, {
        customerId: A.exemptCustomerId,
        items: [
          { productId: A.excise, qty: 4 },
          { productId: A.deposit, qty: 4 },
        ],
        payment: { method: "CASH", amount: 200 } as Pay,
      });
      const f = await footprint(A, k, A.excise);
      expect(invoiced(f)).toBe(80);
      expect(cents(f.orders[0].total)).toBe(80);
      const lines = await raw.orderItem.findMany({ where: { orderId: f.orders[0].id } });
      expect(lines.map((l) => cents(l.categoryTaxAmount))).toEqual([0, 0]);
    });
  });

  describe("PIN: a taxed customer still gets tax and levy on order, invoice and sale answer alike", () => {
    it("excise 4 x 0.50 + deposit 4 x 0.10 + 8.25% tax", async () => {
      const k = key();
      const res = await ring(A, k, {
        items: [
          { productId: A.excise, qty: 4 },
          { productId: A.deposit, qty: 4 },
        ],
        payment: { method: "CASH", amount: 200 } as Pay,
      });
      const f = await footprint(A, k, A.excise);
      // 80.00 + 6.60 tax + 2.00 + 0.40 levy
      expect(cents(f.orders[0].total)).toBe(89);
      expect(invoiced(f)).toBe(89);
      expect(cents(res.total)).toBe(89);
    });
  });
});
