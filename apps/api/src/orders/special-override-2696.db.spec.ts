/**
 * #2696(c) F2 — the one staff override rule (SA-558 / 558b / 558d) on REAL Postgres, asserting the
 * STORED columns:
 *   - create(): a special-tier customer's off-tier price WITH a reason persists DISCOUNTED / MANUAL,
 *     originalPrice = list, the rounded price, the trimmed reason and overriddenBy; without one it
 *     is a 400 and nothing is written; the tier price itself stays SPECIAL with no reason;
 *   - add-during-edit: a typed tier price with no reason is a 200 (SA-558b(2)), classification
 *     unchanged (MANUAL, originalPrice = catalog);
 *   - parity (SA-558d): the same staff payload to a fresh order and folded into a pending one
 *     (the create auto-merge, isCreateMerge) stores the same priceType / originalPrice /
 *     overrideReason / overriddenBy / unitPrice.
 * Harness copied from next-delivery-pack.db.spec.ts. Run via `npm run local:test:db`.
 * Test tenant only (`qa-*`, enforced by assertTestTenant).
 */

// Mock InvoicesService/NotificationsService before they're imported — same ESM-traversal guards
// the unit-test harness uses (`@react-pdf/renderer` / `expo-server-sdk`).
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    reconcileOrderDraftInvoice: jest.fn().mockResolvedValue(null),
    resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([]),
    followPartialPrices: jest.fn().mockResolvedValue({ issuedPartialsUnchanged: [] }),
    projectEditedInvoiceTotals: jest.fn().mockResolvedValue([]),
    revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue([]),
    // forceConsolidateCustomer's loser-cleanup loop calls this unconditionally
    // (orders.service.ts:1103) — the unit-test harness's own InvoicesService mock
    // (testing/orders-service-harness.ts:102) already carries it; this manual mock missed it,
    // which is why F2's first run of (b) threw "findOpenOrderDraft is not a function".
    findOpenOrderDraft: jest.fn().mockResolvedValue(null),
    // #2696(c) SA-558e: createSale's step 3 (the invoice itself is not what these cases pin).
    createInvoiceFromOrder: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
  })),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({
    sendToCustomer: jest.fn().mockResolvedValue(undefined),
    sendToDriver: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { oversellReaderOffProvider } from "./testing/policy-reader-provider";
import { randomUUID } from "crypto";
import { Test, TestingModule } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { OrdersService } from "./orders.service";
import { foldMergeItems } from "./merge-items";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { InventoryService } from "../inventory/inventory.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { PromotionsService } from "../promotions/promotions.service";
import { MessagingService } from "../messaging/messaging.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { computeLineSubtotal } from "@routeflow/pricing";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const operatorPayload = {
  status: "ACTIVE" as const,
  forcePasswordChange: false,
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
};

describeDb("#2696(c) staff price override — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let svc: OrdersService;
  let dbPrisma: PrismaService;
  let tenantCtx: TenantContextService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-ovr2696-${run}`, "special-override-2696.db.spec.ts");
  let tenantId = "";
  let product: { id: string };
  let n = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    dbPrisma = new PrismaService(tenantCtx);
    await dbPrisma.$connect();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        oversellReaderOffProvider,
        OrdersService,
        { provide: TenantContextService, useValue: tenantCtx },
        { provide: PrismaService, useValue: dbPrisma },
        { provide: getQueueToken("invoices"), useValue: { add: jest.fn() } },
        {
          provide: RouteFlowGateway,
          useValue: {
            emitStopCompleted: jest.fn(),
            emitOrderCreated: jest.fn(),
            emitUrgentOrder: jest.fn(),
            emitOrderStatusChanged: jest.fn(),
            emitLowStock: jest.fn(),
          },
        },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(0.1) } },
        { provide: InvoicesService, useValue: new (InvoicesService as any)() },
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
            getAll: jest.fn().mockResolvedValue({}),
          },
        },
        { provide: NotificationsService, useValue: new (NotificationsService as any)() },
        {
          provide: InventoryService,
          useValue: { recordSale: jest.fn().mockResolvedValue({ unitCost: 0, stockAfter: 0 }) },
        },
        {
          provide: SellingRestrictionsService,
          useValue: {
            assertLinesSellable: jest.fn().mockResolvedValue(undefined),
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "OFF", reasons: [] }),
            getPolicy: jest.fn().mockResolvedValue({ enabled: false }),
          },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        {
          provide: PromotionsService,
          useValue: { activeForCatalog: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: MessagingService,
          useValue: {
            notify: jest.fn().mockResolvedValue([]),
            notifyEvent: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: CreditNotesService,
          useValue: {
            validateSelectionsForCustomer: jest.fn().mockResolvedValue(undefined),
            syncOrderCreditSelections: jest.fn().mockResolvedValue(undefined),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            releaseOrderCreditsInTx: jest.fn().mockResolvedValue([]),
            previewOrderCreditRelease: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
        {
          provide: RegulatedLedgerService,
          useValue: {
            reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined),
            syncInvoiceEntries: jest.fn(),
          },
        },
      ],
    }).compile();
    svc = module.get(OrdersService);

    tenantId = (await raw.tenant.create({ data: { slug, name: `ovr2696 ${slug}` } })).id;
    const op = await raw.user.create({
      data: { email: `op-${run}@example.test`, username: `op-${run}`, role: "OPERATOR", tenantId },
    });
    operatorPayload.sub = op.id;
    // list $10, tier-3 (special) $8
    product = await raw.product.create({
      data: {
        tenantId,
        name: `Tiered Widget ${run}`,
        sku: `tw-${run}`,
        unit: "each",
        pricePerUnit: "10",
        priceTier3: "8",
        currentStock: 1000,
      },
    });
  }, 120_000);

  afterAll(async () => {
    const orders = await raw.order.findMany({ where: { tenantId }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    if (ids.length) await raw.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    if (ids.length) await raw.order.deleteMany({ where: { id: { in: ids } } });
    await raw.customer.deleteMany({ where: { tenantId } });
    await raw.stockMovement.deleteMany({ where: { tenantId } });
    await raw.product.deleteMany({ where: { tenantId } });
    await raw.user.deleteMany({ where: { tenantId } });
    if (tenantId) await raw.tenant.deleteMany({ where: { id: tenantId } });
    await dbPrisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  /** A tier-3 (special) customer of this run's tenant. */
  async function customer() {
    const tag = `c${++n}`;
    const user = await raw.user.create({
      data: {
        email: `${tag}-${run}@example.test`,
        username: `${tag}-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    return raw.customer.create({
      data: {
        userId: user.id,
        businessName: `${tag} co`,
        contactName: "T",
        tenantId,
        pricingTier: 3,
      },
    });
  }

  const staff = () => ({ ...operatorPayload, tenantId }) as never;
  const create = (customerId: string, item: Record<string, unknown>) =>
    tenantCtx.run(tenantId, () =>
      svc.create(
        { customerId, items: [{ productId: product.id, qty: 2, ...item }] } as never,
        staff(),
      ),
    );
  const lineOf = async (orderId: string) =>
    raw.orderItem.findFirstOrThrow({ where: { orderId, productId: product.id } });
  const cols = (l: Record<string, any>) => ({
    unitPrice: Number(l.unitPrice),
    priceType: l.priceType,
    originalPrice: l.originalPrice == null ? null : Number(l.originalPrice),
    overrideReason: l.overrideReason ?? null,
    overriddenBy: l.overriddenBy ?? null,
  });
  const pendingOrder = (customerId: string) =>
    raw.order.create({
      data: { tenantId, customerId, status: "PENDING", source: "APP", total: "0", subtotal: "0" },
      include: { lineItems: true },
    });

  it("create: below list WITH a reason persists DISCOUNTED, list original, trimmed reason, overriddenBy, rounded", async () => {
    const c = await customer();
    const order = (await create(c.id, { unitPrice: 6.456, overrideReason: "  bent box  " })) as any;
    const line = await lineOf(order.id);
    expect(cols(line)).toEqual({
      unitPrice: 6.46,
      priceType: "DISCOUNTED",
      originalPrice: 10,
      overrideReason: "bent box",
      overriddenBy: operatorPayload.sub,
    });
    expect(Number(line.subtotal)).toBe(computeLineSubtotal({ unitPrice: 6.46, qty: 2 }));
  });

  it("create: at list WITH a reason persists MANUAL (originalPrice = list)", async () => {
    const c = await customer();
    const order = (await create(c.id, { unitPrice: 10, overrideReason: "list today" })) as any;
    expect(cols(await lineOf(order.id))).toMatchObject({
      unitPrice: 10,
      priceType: "MANUAL",
      originalPrice: 10,
      overrideReason: "list today",
    });
  });

  it("create: an off-tier price with NO reason is a 400 naming the product; no order written", async () => {
    const c = await customer();
    await expect(create(c.id, { unitPrice: 6 })).rejects.toThrow(
      /reason is required to change Tiered Widget/,
    );
    expect(await raw.order.count({ where: { tenantId, customerId: c.id } })).toBe(0);
  });

  it("create: the tier price itself needs no reason and stays SPECIAL", async () => {
    const c = await customer();
    const order = (await create(c.id, { unitPrice: 8 })) as any;
    expect(cols(await lineOf(order.id))).toEqual({
      unitPrice: 8,
      priceType: "SPECIAL",
      originalPrice: 10,
      overrideReason: null,
      overriddenBy: null,
    });
  });

  it("add during edit: a typed tier price with NO reason is a 200 (SA-558b(2)); stores SPECIAL per SA-558c", async () => {
    const c = await customer();
    const order = await pendingOrder(c.id);
    await tenantCtx.run(tenantId, () =>
      svc.updateOrderItems(
        order.id,
        { items: [{ productId: product.id, qty: 2, unitPrice: 8 }], replaceAll: false } as never,
        staff(),
      ),
    );
    // SA-558c (#2716): a typed tier price on an added line is class C -> rule A, so it stores
    // SPECIAL (it was MANUAL before the one staff override rule); deliberate rule change.
    expect(cols(await lineOf(order.id))).toMatchObject({
      unitPrice: 8,
      priceType: "SPECIAL",
      originalPrice: 10,
      overrideReason: null,
    });
  });

  it.each([
    ["below list + reason", { unitPrice: 6, overrideReason: " bent box " }],
    ["above list + reason", { unitPrice: 12.456, overrideReason: "rush" }],
    ["the tier price", { unitPrice: 8 }],
  ])(
    "PARITY (SA-558d), %s: a fresh order and one folded into a pending order store the same line",
    async (_n, item) => {
      const fresh = await customer();
      const freshOrder = (await create(fresh.id, item)) as any;

      const folded = await customer();
      const pending = await pendingOrder(folded.id);
      const fold = foldMergeItems(
        pending.lineItems as never,
        [{ productId: product.id, qty: 2, ...item }] as never,
      );
      await tenantCtx.run(tenantId, () =>
        svc.updateOrderItems(
          pending.id,
          { items: fold.items, replaceAll: true } as never,
          staff(),
          {
            isCreateMerge: true,
          },
        ),
      );
      expect(cols(await lineOf(pending.id))).toEqual(cols(await lineOf(freshOrder.id)));
    },
  );

  // SA-558e: New sale (POST /orders/sell → createSale → create()) takes the same rule A.
  const sell = (customerId: string, item: Record<string, unknown>) =>
    tenantCtx.run(tenantId, () =>
      svc.createSale(
        {
          customerId,
          items: [{ productId: product.id, qty: 2, ...item }],
          deliveredNow: false,
        } as never,
        staff(),
      ),
    );

  it("SALE (SA-558e): off the special price WITH a reason persists the override on the sale's order", async () => {
    const c = await customer();
    await sell(c.id, { unitPrice: 6, overrideReason: "dented" });
    const order = await raw.order.findFirstOrThrow({ where: { tenantId, customerId: c.id } });
    expect(cols(await lineOf(order.id))).toEqual({
      unitPrice: 6,
      priceType: "DISCOUNTED",
      originalPrice: 10,
      overrideReason: "dented",
      overriddenBy: operatorPayload.sub,
    });
  });

  it("SALE (SA-558e): off the special price with NO reason is a 400; no order written", async () => {
    const c = await customer();
    await expect(sell(c.id, { unitPrice: 6 })).rejects.toThrow(/reason is required/);
    expect(await raw.order.count({ where: { tenantId, customerId: c.id } })).toBe(0);
  });
});
