/**
 * CQ-02 class (G4): every ORDER writer honours a tax-exempt customer, on real Postgres.
 * create() is pinned in counter/counter-money-parity.db.spec.ts; this file pins the other writers that re-total an
 * order: the pending-merge sweep, forceConsolidateCustomer and the staff replace-all edit. An exempt customer's order
 * header carries $0 tax and $0 levy (and its line snapshots 0), exactly as its invoice does (RF-079 / RF-4); a taxed
 * customer's order is unchanged (the control case). Test tenant only (`qa-*`, enforced by assertTestTenant).
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
import { PrismaClient, PriceType } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { OrdersService } from "./orders.service";
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
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { foldMergeItems } from "./merge-items";
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

describeDb("Order totals honour tax exemption on every writer — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let svc: OrdersService;
  let dbPrisma: PrismaService;
  let tenantCtx: TenantContextService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-ordexempt-${run}`, "order-totals-exempt.db.spec.ts");
  let tenantId = "";
  const orderIds: string[] = [];
  const customerIds: string[] = [];
  const productIds: string[] = [];
  const userIds: string[] = [];

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
            get: jest
              .fn()
              .mockImplementation(async (k: string) => (k === "settings.taxRate" ? "8.25" : null)),
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
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    svc = module.get(OrdersService);

    tenantId = (await raw.tenant.create({ data: { slug, name: `exempt ${slug}` } })).id;
    // B562 PR-2: an order stock event books a SALE movement whose performedById is the acting
    // user (a StockMovement → User FK), so the operator must be a real user, as a real JWT sub is.
    const op = await raw.user.create({
      data: { email: `op-${run}@example.test`, username: `op-${run}`, role: "OPERATOR", tenantId },
    });
    userIds.push(op.id);
    operatorPayload.sub = op.id;
  }, 120_000);

  afterAll(async () => {
    if (orderIds.length) await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    if (orderIds.length) await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    if (customerIds.length) await raw.customer.deleteMany({ where: { id: { in: customerIds } } });
    if (productIds.length)
      await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
    if (productIds.length) await raw.product.deleteMany({ where: { id: { in: productIds } } });
    if (categoryIds.length)
      await raw.trackedCategory.deleteMany({ where: { id: { in: categoryIds } } });
    if (userIds.length) await raw.user.deleteMany({ where: { id: { in: userIds } } });
    if (tenantId) await raw.tenant.deleteMany({ where: { id: tenantId } });
    await dbPrisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  async function seedCustomer(tag: string, isTaxExempt = false) {
    const user = await raw.user.create({
      data: {
        email: `${tag}-${run}@example.test`,
        username: `${tag}-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    userIds.push(user.id);
    const customer = await raw.customer.create({
      data: {
        userId: user.id,
        businessName: `${tag} co`,
        contactName: "Exempt Tester",
        tenantId,
        isTaxExempt,
      },
    });
    customerIds.push(customer.id);
    return customer.id;
  }

  async function seedProduct(tag: string, unitsPerBox: number | null, pricePerUnit: number) {
    const product = await raw.product.create({
      data: {
        tenantId,
        name: `${tag}-${run}`,
        sku: `${tag}-${run}`,
        unit: "unit",
        pricePerUnit: pricePerUnit.toString(),
        unitsPerBox,
        currentStock: 1000,
      },
    });
    productIds.push(product.id);
    return product.id;
  }

  const categoryIds: string[] = [];
  /** A 10.00 product in an EXCISE_PER_UNIT 0.50 category. */
  async function seedExcise(tag: string) {
    const cat = await raw.trackedCategory.create({
      data: {
        tenantId,
        name: `${tag}-${run}`,
        taxType: "EXCISE_PER_UNIT",
        rate: "0.5000",
      } as never,
    });
    categoryIds.push(cat.id);
    const product = await raw.product.create({
      data: {
        tenantId,
        name: `${tag}-${run}`,
        sku: `${tag}-${run}`,
        unit: "each",
        pricePerUnit: "10.00",
        currentStock: 1000,
        trackedCategoryId: cat.id,
      } as never,
    });
    productIds.push(product.id);
    return product.id;
  }

  async function seedPendingOrder(
    customerId: string,
    lines: Array<{
      productId: string;
      qty: number;
      boxes: number | null;
      pieces: number | null;
      unitsPerBox: number | null;
      unitPrice: number;
      priceType?: PriceType;
      overrideReason?: string | null;
    }>,
  ) {
    const order = await raw.order.create({
      data: {
        tenantId,
        customerId,
        status: "PENDING",
        source: "APP",
        total: "0",
        lineItems: {
          create: lines.map((l, i) => ({
            tenantId,
            productId: l.productId,
            qty: l.qty.toString(),
            boxes: l.boxes,
            pieces: l.pieces,
            unitsPerBox: l.unitsPerBox,
            unitPrice: l.unitPrice.toString(),
            // Opus round-5 LOW: unitPrice*qty is the WRONG formula for a boxed line — unitPrice
            // is the BOX price, so a 1-box/qty-12 line at $36 would seed subtotal 432 instead of
            // 36. Use the shared money-math helper every other writer in this codebase uses.
            subtotal: computeLineSubtotal({
              unitPrice: l.unitPrice,
              qty: l.qty,
              boxes: l.boxes,
              pieces: l.pieces,
              unitsPerBox: l.unitsPerBox,
            }).toString(),
            status: "PENDING",
            priceType: l.priceType ?? "STANDARD",
            overrideReason: l.overrideReason ?? null,
            position: i,
          })),
        },
      },
      include: { lineItems: true },
    });
    orderIds.push(order.id);
    return order;
  }

  async function itemsOf(orderId: string) {
    return raw.orderItem.findMany({
      where: { orderId, status: { not: "CANCELLED" } },
      orderBy: { position: "asc" },
    });
  }

  async function header(orderId: string) {
    const o = await raw.order.findUniqueOrThrow({ where: { id: orderId } });
    return { subtotal: Number(o.subtotal), tax: Number(o.tax), total: Number(o.total) };
  }
  const plain = (productId: string, qty: number) => ({
    productId,
    qty,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitPrice: 10,
  });

  it("pending-merge sweep: an exempt customer's merged order is $0 tax; a taxed one keeps 8.25%", async () => {
    const productId = await seedProduct("m-prod", null, 10);
    const exempt = await seedCustomer("m-ex", true);
    const taxed = await seedCustomer("m-tx");
    for (const c of [exempt, taxed]) {
      await seedPendingOrder(c, [plain(productId, 2)]);
      await seedPendingOrder(c, [plain(productId, 2)]);
    }
    const ex = await tenantCtx.run(tenantId, () => svc.mergeAllPendingForCustomer(exempt));
    const tx = await tenantCtx.run(tenantId, () => svc.mergeAllPendingForCustomer(taxed));
    expect(await header(ex!.id)).toEqual({ subtotal: 40, tax: 0, total: 40 });
    expect(await header(tx!.id)).toEqual({ subtotal: 40, tax: 3.3, total: 43.3 });
  });

  it("forceConsolidateCustomer: an exempt customer's merged order is $0 tax", async () => {
    const productId = await seedProduct("f-prod", null, 10);
    const exempt = await seedCustomer("f-ex", true);
    await seedPendingOrder(exempt, [plain(productId, 2)]);
    await seedPendingOrder(exempt, [plain(productId, 2)]);
    const merged = await tenantCtx.run(tenantId, () => svc.forceConsolidateCustomer(exempt));
    expect(await header(merged!.id)).toEqual({ subtotal: 40, tax: 0, total: 40 });
  });

  it("staff edit (replace-all): an exempt customer's excise line carries no tax and no levy; a taxed one does", async () => {
    const productId = await seedExcise("e-excise");
    const exempt = await seedCustomer("e-ex", true);
    const taxed = await seedCustomer("e-tx");
    const edit = (orderId: string) =>
      tenantCtx.run(tenantId, () =>
        svc.updateOrderItems(
          orderId,
          { replaceAll: true, items: [{ productId, qty: 4 }] } as never,
          operatorPayload as never,
        ),
      );
    const exOrder = await seedPendingOrder(exempt, [plain(productId, 2)]);
    const txOrder = await seedPendingOrder(taxed, [plain(productId, 2)]);
    await edit(exOrder.id);
    await edit(txOrder.id);

    expect(await header(exOrder.id)).toEqual({ subtotal: 40, tax: 0, total: 40 });
    const exLines = await itemsOf(exOrder.id);
    expect(exLines.map((l) => Number(l.categoryTaxAmount))).toEqual([0]);
    // control: 40.00 + 3.30 tax + 4 x 0.50 levy
    expect(await header(txOrder.id)).toEqual({ subtotal: 40, tax: 3.3, total: 45.3 });
    expect((await itemsOf(txOrder.id)).map((l) => Number(l.categoryTaxAmount))).toEqual([2]);
  });
});
