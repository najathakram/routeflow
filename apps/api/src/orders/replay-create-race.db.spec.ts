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

describeDb("BUG-A: two concurrent create() calls on one Idempotency-Key - real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let svc: OrdersService;
  let dbPrisma: PrismaService;
  let tenantCtx: TenantContextService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-bugA-race-${run}`, "replay-create-race.db.spec.ts");
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
  const create = (customerId: string, key: string, qty = 2, status?: "DRAFT" | "PENDING") =>
    tenantCtx.run(tenantId, () =>
      svc.create(
        {
          customerId,
          items: [{ productId: product.id, qty }],
          idempotencyKey: key,
          ...(status ? { status } : {}),
        } as never,
        staff(),
      ),
    );
  const errorOf = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e) => e,
    );

  it("A4: Promise.all of two create() calls on the SAME key writes exactly ONE order; both resolve to its id", async () => {
    const c = await customer();
    const key = `race-${run}-1`;
    const results = (await Promise.all([create(c.id, key), create(c.id, key)])) as any[];
    expect(results[0].id).toBe(results[1].id);
    expect(await raw.order.count({ where: { tenantId, customerId: c.id } })).toBe(1);
  });

  it("the same key TWICE in a row is a replay of the same order, never a second row", async () => {
    const c = await customer();
    const key = `race-${run}-2`;
    const first = (await create(c.id, key)) as any;
    const again = (await create(c.id, key)) as any;
    expect(again.id).toBe(first.id);
    expect(await raw.order.count({ where: { tenantId, customerId: c.id } })).toBe(1);
  });

  it("DIFFERENT keys write two orders (separate orders for one customer are legitimate)", async () => {
    const c = await customer();
    const [a, b] = (await Promise.all([
      create(c.id, `race-${run}-3a`),
      create(c.id, `race-${run}-3b`),
    ])) as any[];
    expect(a.id).not.toBe(b.id);
    expect(await raw.order.count({ where: { tenantId, customerId: c.id } })).toBe(2);
  });

  it("A5: the same key with a different cart is the coded 409 carrying the order id", async () => {
    const c = await customer();
    const key = `race-${run}-4`;
    const first = (await create(c.id, key, 2)) as any;
    const e: any = await errorOf(create(c.id, key, 5));
    expect(e?.getResponse?.()).toMatchObject({
      code: "IDEMPOTENCY_KEY_CART_MISMATCH",
      orderId: first.id,
    });
    expect(await raw.order.count({ where: { tenantId, customerId: c.id } })).toBe(1);
  });

  it("a Save-as-Draft then Create Order on the same key is the coded DRAFT_MISMATCH 409, one row", async () => {
    const c = await customer();
    const key = `race-${run}-5`;
    const draft = (await create(c.id, key, 2, "DRAFT")) as any;
    const e: any = await errorOf(create(c.id, key, 2, "PENDING"));
    expect(e?.getResponse?.()).toMatchObject({
      code: "IDEMPOTENCY_KEY_DRAFT_MISMATCH",
      orderId: draft.id,
    });
    expect(await raw.order.count({ where: { tenantId, customerId: c.id } })).toBe(1);
  });
});
