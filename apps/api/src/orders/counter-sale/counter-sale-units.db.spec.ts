/**
 * SA-1040 B4a: the counter sells by a unit (a Case, a Pallet) on real Postgres, through the REAL chain
 * (CounterSaleService.ring -> OrdersService.createSale -> create() -> invoice -> tender), the harness of
 * counter-sale-units.db.spec.ts. Product: a pack of 10 at a box price of 2.50, a Case of 200 at its own price
 * of 45.00, a Pallet of 4,800 (derived price). Cases: N-c2 (a Case line), N-c3 (a Pallet line), G-c4 (boxes on a
 * unit line is refused), G-c5 (no flag.units_v1 is a 403), G-c6 (replay keys on product AND unit), G-c7 (a void
 * puts the pieces back), G-c8 (a typed price on a Case line).
 *
 * Runs only under `npm run local:test:db` (collected by jest.db.config.js). Throwaway `qa-cs-units-*` tenants.
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
import { BadRequestException, ForbiddenException, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { computeLineSubtotal } from "@routeflow/pricing";
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

describeDb("Counter Sale sells by unit, the real chain on Postgres (SA-1040 B4a)", () => {
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
      `qa-cs-units-${RUN}-${seq}-${label}`,
      "counter-sale-units.db.spec.ts",
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

  /** The ladder product of this spec: pack 10 at a box price of 2.50; Case 200 at its own 45.00; Pallet 4,800, derived. */
  let widget = "";
  async function unitProduct(s: Shop) {
    widget = (
      await raw.product.create({
        data: {
          name: `widget ${s.slug}`,
          unit: "Box",
          pricePerUnit: "2.50",
          unitsPerBox: 10,
          currentStock: "100000",
          tenantId: s.tenantId,
        } as never,
      })
    ).id;
    await raw.productUnit.createMany({
      data: [
        {
          tenantId: s.tenantId,
          productId: widget,
          label: "Case",
          factorToBase: 200,
          price: "45.00",
        },
        {
          tenantId: s.tenantId,
          productId: widget,
          label: "Pallet",
          factorToBase: 4800,
          sortOrder: 1,
        },
      ],
    });
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
    await unitProduct(A);
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
    await raw.productUnit.deleteMany(where).catch(swallow);
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
      items?: Array<{
        productId: string;
        qty?: number;
        boxes?: number;
        unitLabel?: string;
        unitPrice?: number;
        priceReason?: string;
      }>;
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
  const linesOf = (orderId: string) =>
    raw.orderItem.findMany({
      where: { orderId },
      select: {
        unitLabel: true,
        qty: true,
        boxes: true,
        subtotal: true,
        unitPrice: true,
        overriddenBy: true,
      },
      orderBy: { createdAt: "asc" },
    });
  const cash = { method: "CASH", amount: 100_000 } as Pay;
  // `orders` is built in beforeAll, so the cast is read lazily
  const asOrders = () => orders as unknown as { entitlements: unknown };

  describe("N-c2 / N-c3: a unit line rings, prices and stocks in base pieces", () => {
    it("NEW PATH: 2 Cases at the Case's own price: one line, subtotal 90.00, stock down 400 once", async () => {
      const k = key();
      const before = await stockOf(widget);
      const sold = await ring(A, k, {
        items: [{ productId: widget, unitLabel: "Case", qty: 2 }],
        payment: cash,
      });
      const [line, ...rest] = await linesOf(sold.orderId);
      expect(rest).toHaveLength(0);
      expect(line.unitLabel).toBe("Case");
      expect(Number(line.boxes)).toBe(2); // the stored unit count
      expect(Number(line.qty)).toBe(400); // base pieces
      expect(Number(line.subtotal)).toBe(computeLineSubtotal({ unitPrice: 45, qty: 2 }));
      expect(Number(line.subtotal)).toBe(90);
      expect(await stockOf(widget)).toBe(before - 400);
      expect((await footprint(A, k, widget)).saleMovements).toBe(1);
    });

    it("NEW PATH: 1 Pallet is priced by the ladder and stocks 4,800 pieces", async () => {
      const before = await stockOf(widget);
      const sold = await ring(A, key(), {
        items: [{ productId: widget, unitLabel: "Pallet", qty: 1 }],
        payment: cash,
      });
      const [line] = await linesOf(sold.orderId);
      expect(line.unitLabel).toBe("Pallet");
      expect(Number(line.qty)).toBe(4800);
      expect(Number(line.subtotal)).toBeGreaterThan(0); // the derived price is observed, not predicted
      expect(await stockOf(widget)).toBe(before - 4800);
    });

    it("a pack line of the same product is unchanged: 3 boxes of 10 at 2.50 = 7.50, stock down 30", async () => {
      const before = await stockOf(widget);
      const sold = await ring(A, key(), {
        items: [{ productId: widget, boxes: 3 }],
        payment: cash,
      });
      const [line] = await linesOf(sold.orderId);
      expect(line.unitLabel).toBeNull();
      expect(Number(line.subtotal)).toBe(7.5);
      expect(await stockOf(widget)).toBe(before - 30);
    });
  });

  describe("G-c4 / G-c5: the refusals are create()'s own, the counter adds none", () => {
    it("boxes on a unit line is a 400 and nothing is written", async () => {
      const k = key();
      const before = await stockOf(widget);
      // qty: 2 is what makes this pin something: a mapper that dropped boxes would sell 2 Cases (the N-c2 shape);
      // without a qty the line is a 400 under either mapper (buildLine refuses a NaN count).
      const err = await ring(A, k, {
        items: [{ productId: widget, unitLabel: "Case", qty: 2, boxes: 1 }],
        payment: cash,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toMatch(/takes a quantity of Case units only/);
      expect((await footprint(A, k, widget)).orders).toHaveLength(0);
      expect(await stockOf(widget)).toBe(before);
    });

    it("without flag.units_v1 a unit line is a 403 and nothing is written", async () => {
      const k = key();
      const real = asOrders().entitlements;
      asOrders().entitlements = { hasFlag: async () => false };
      try {
        await expect(
          ring(A, k, { items: [{ productId: widget, unitLabel: "Case", qty: 1 }], payment: cash }),
        ).rejects.toThrow(ForbiddenException);
      } finally {
        asOrders().entitlements = real;
      }
      expect((await footprint(A, k, widget)).orders).toHaveLength(0);
    });
  });

  describe("G-c6: the counter's replay check keys on the unit as well as the product", () => {
    it("the same key and cart (a Case line and a pack line of one product) returns the first sale", async () => {
      const k = key();
      const cart = () => [
        { productId: widget, unitLabel: "Case", qty: 1 },
        { productId: widget, boxes: 2 },
      ];
      const first = await ring(A, k, { items: cart(), payment: cash });
      const again = await ring(A, k, { items: cart(), payment: cash });
      expect(again.orderId).toBe(first.orderId);
      expect((await footprint(A, k, widget)).orders).toHaveLength(1);
    });

    it("the same key with the two lines' prices swapped is the coded 409 and writes nothing new", async () => {
      const k = key();
      const admin = staff(A, "TENANT_ADMIN"); // a typed price needs a price right
      const first = await ring(
        A,
        k,
        {
          items: [
            { productId: widget, unitLabel: "Case", qty: 1, unitPrice: 40, priceReason: "promo" },
            { productId: widget, boxes: 2 },
          ],
          payment: cash,
        },
        admin,
      );
      const err = await ring(
        A,
        k,
        {
          items: [
            { productId: widget, unitLabel: "Case", qty: 1 },
            { productId: widget, boxes: 2, unitPrice: 40, priceReason: "promo" },
          ],
          payment: cash,
        },
        admin,
      ).catch((e: unknown) => e);
      expect(JSON.stringify((err as { getResponse?: () => unknown }).getResponse?.())).toContain(
        "IDEMPOTENCY_KEY_CART_MISMATCH",
      );
      const f = await footprint(A, k, widget);
      expect(f.orders).toHaveLength(1);
      expect(f.orders[0].id).toBe(first.orderId);
    });
  });

  describe("G-c7: a void puts the unit line's pieces back", () => {
    it("voiding 2 Cases restores 400 pieces", async () => {
      const before = await stockOf(widget);
      const sold = await ring(A, key(), {
        items: [{ productId: widget, unitLabel: "Case", qty: 2 }],
        payment: cash,
      });
      expect(await stockOf(widget)).toBe(before - 400);
      await tenantCtx.run(A.tenantId, () =>
        voids.voidSale(sold.orderId, { reason: "changed mind" } as never, staff(A)),
      );
      expect(await stockOf(widget)).toBe(before);
    });
  });

  describe("G-c8: a typed price on a Case line", () => {
    it("by a TENANT_ADMIN: the line takes the price and is stamped with the cashier", async () => {
      const sold = await ring(
        A,
        key(),
        {
          items: [
            { productId: widget, unitLabel: "Case", qty: 1, unitPrice: 40, priceReason: "damaged" },
          ],
          payment: cash,
        },
        staff(A, "TENANT_ADMIN"),
      );
      const [line] = await linesOf(sold.orderId);
      expect(Number(line.unitPrice)).toBe(40);
      expect(line.overriddenBy).toBe(A.operatorId);
    });
  });
});
