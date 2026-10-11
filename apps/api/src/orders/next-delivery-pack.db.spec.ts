/**
 * D-20 (#1808, SA-304 / SA-330) — the copier C8 gap, EXECUTED on real Postgres: `approveNextDelivery` re-creates a
 * rolled-over CHANGE_QTY delta as a next-delivery draft line through `OrdersService.create`. After the product's pack
 * changes (12 -> live 6) the copy must keep the SOURCE line's pack (12): the stored line carries that
 * `unitsPerBox` snapshot, and its money equals `computeLineSubtotal` at THAT pack — not a re-split, re-priced line at
 * the live pack. RED CONTROL: on master (no `packSnapshots`) this same spec stores unitsPerBox 6 and a different
 * subtotal (see the PR body for the master run).
 *
 * Constructs a REAL OrdersService + ChangeRequestsService against real Postgres, every other collaborator the same
 * permissive mock `b776-r1-chain.db.spec.ts` uses. Test tenant only (`qa-*`). Collected only by jest.db.config.js.
 */
// Mock InvoicesService/NotificationsService before they're imported — same ESM-traversal guards
// the unit-test harness uses (`@react-pdf/renderer` / `expo-server-sdk`).
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    reconcileOrderDraftInvoice: jest.fn().mockResolvedValue(null),
    resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([]),
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
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { OrdersService } from "./orders.service";
import { ChangeRequestsService } from "./change-requests.service";
import { ChangeRequestResolveAction } from "./dto/resolve-change-request.dto";
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

describeDb("D-20 next-delivery pack (C8) — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let svc: OrdersService;
  let crSvc: ChangeRequestsService;
  let dbPrisma: PrismaService;
  let tenantCtx: TenantContextService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-nextdlv-${run}`, "next-delivery-pack.db.spec.ts");
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
        ChangeRequestsService,
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
    crSvc = module.get(ChangeRequestsService);

    tenantId = (await raw.tenant.create({ data: { slug, name: `nextdlv ${slug}` } })).id;
    // B562 PR-2: an at-stop approve writes a SALE row whose performedById is a User FK, so the
    // approver must be a real user (in this run's own qa-* tenant), not a bare JWT sub.
    const op = await raw.user.create({
      data: { email: `op-${run}@example.test`, username: `op-${run}`, role: "OPERATOR", tenantId },
    });
    operatorPayload.sub = op.id;
  }, 120_000);

  afterAll(async () => {
    const orders = await raw.order.findMany({ where: { tenantId }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    if (ids.length) await raw.changeRequest.deleteMany({ where: { orderId: { in: ids } } });
    if (ids.length) await raw.deliveryMutation.deleteMany({ where: { orderId: { in: ids } } });
    if (ids.length) await raw.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    if (ids.length) await raw.order.deleteMany({ where: { id: { in: ids } } });
    await raw.routeRun.deleteMany({ where: { tenantId } });
    await raw.route.deleteMany({ where: { tenantId } });
    await raw.customer.deleteMany({ where: { tenantId } });
    await raw.stockMovement.deleteMany({ where: { tenantId } });
    await raw.product.deleteMany({ where: { tenantId } });
    await raw.user.deleteMany({ where: { tenantId } });
    if (tenantId) await raw.tenant.deleteMany({ where: { id: tenantId } });
    await dbPrisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  const OVERRIDER = "staff-overrider-1";

  /** A CONFIRMED order with ONE boxed line sold at pack 12 / $36 per box, and a CHANGE_QTY 24 -> 42 request. */
  async function scenario(tag: string, opts: { onRun: boolean }) {
    const user = await raw.user.create({
      data: {
        email: `${tag}-${run}@example.test`,
        username: `${tag}-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await raw.customer.create({
      data: { userId: user.id, businessName: `${tag} co`, contactName: "T", tenantId },
    });
    const product = await raw.product.create({
      data: {
        tenantId,
        name: `${tag}-${run}`,
        sku: `${tag}-${run}`,
        unit: "unit",
        pricePerUnit: "36", // per BOX
        unitsPerBox: 12,
        currentStock: 1000,
      },
    });
    let runId: string | undefined;
    if (opts.onRun) {
      const route = await raw.route.create({ data: { tenantId, name: `route-${tag}-${run}` } });
      runId = (
        await raw.routeRun.create({
          data: { tenantId, routeId: route.id, status: "IN_PROGRESS", scheduledDate: new Date() },
        })
      ).id;
    }
    const order = await raw.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        status: "CONFIRMED",
        source: "APP",
        total: "72",
        subtotal: "72",
        routeRunId: runId,
        lineItems: {
          create: [
            {
              tenantId,
              productId: product.id,
              qty: "24",
              boxes: 2,
              pieces: 0,
              unitsPerBox: 12,
              unitPrice: "36",
              subtotal: "72",
              status: "PENDING",
              // an agreed DISCOUNTED price ($40 list, sold at $36) with its audit trail: live re-pricing would give
              // STANDARD, no originalPrice and no override reason, so each assertion below can go red
              priceType: "DISCOUNTED",
              originalPrice: "40",
              overrideReason: "Loyalty deal",
              overriddenBy: OVERRIDER, // a DISTINCT id (plain String, no FK): create() must not stamp the approver
              position: 0,
            },
          ],
        },
      },
      include: { lineItems: true },
    });
    const line = order.lineItems[0];
    const cr = await raw.changeRequest.create({
      data: {
        tenantId,
        orderId: order.id,
        orderItemId: line.id,
        productId: product.id,
        type: "CHANGE_QTY",
        payload: { orderItemId: line.id, newQty: 42 }, // 18 more pieces
      },
    });
    return { order, line, product, cr };
  }

  const resolve = (orderId: string, crId: string, action: ChangeRequestResolveAction) =>
    tenantCtx.run(tenantId, () =>
      crSvc.resolve(orderId, crId, { action }, operatorPayload as never),
    );

  it("NEXT DELIVERY after a repack 12 -> 6 AND a price change $36 -> $18: the copy keeps the source pack AND price; money is computeLineSubtotal at the source pack and price", async () => {
    const { order, product, cr } = await scenario("nd", { onRun: false });
    // AFTER the sale the product is repacked AND repriced: live pack 12 -> 6, live price $36 -> $18 per box
    await raw.product.update({
      where: { id: product.id },
      data: { unitsPerBox: 6, pricePerUnit: "18" },
    });

    await resolve(order.id, cr.id, ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY);

    const resolved = await raw.changeRequest.findUnique({ where: { id: cr.id } });
    const copy = (await raw.orderItem.findMany({ where: { orderId: resolved!.nextOrderId! } }))[0];
    // 18 pieces at the SOURCE pack 12 = 1 box + 6 pieces, at the SOURCE's $36 per box
    expect(copy.unitsPerBox).toBe(12); // NOT the live 6
    expect(Number(copy.unitPrice)).toBe(36); // NOT the live $18
    expect(copy.priceType).toBe("DISCOUNTED"); // the source's type, never relabelled STANDARD
    expect(Number(copy.originalPrice)).toBe(40); // and its original price, not null
    expect(copy.overrideReason).toBe("Loyalty deal"); // the audit trail rides with the carried price
    expect(copy.overriddenBy).toBe(OVERRIDER);
    expect(Number(copy.qty)).toBe(18);
    expect(copy.boxes).toBe(1);
    expect(copy.pieces).toBe(6);
    expect(copy.promoFreeUnits).toBeNull(); // a rollover earns no promo units
    const expected = computeLineSubtotal({
      unitPrice: 36,
      qty: 18,
      boxes: 1,
      pieces: 6,
      unitsPerBox: 12,
    });
    expect(expected).toBe(54);
    expect(Number(copy.subtotal)).toBe(expected);
  });

  it("PARITY: the same CR resolved AT_STOP and NEXT_DELIVERY adds the same money ($54)", async () => {
    const a = await scenario("par-next", { onRun: false });
    const b = await scenario("par-stop", { onRun: true });
    for (const s of [a, b]) {
      await raw.product.update({
        where: { id: s.product.id },
        data: { unitsPerBox: 6, pricePerUnit: "18" },
      });
    }
    await resolve(a.order.id, a.cr.id, ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY);
    const nextId = (await raw.changeRequest.findUnique({ where: { id: a.cr.id } }))!.nextOrderId!;
    const nextMoney = Number(
      (await raw.orderItem.findMany({ where: { orderId: nextId } }))[0].subtotal,
    );

    await resolve(b.order.id, b.cr.id, ChangeRequestResolveAction.APPROVE_AT_STOP);
    const after = await raw.order.findUnique({ where: { id: b.order.id } });
    const atStopMoney = Number(after!.subtotal) - 72; // what the at-stop approval ADDED to the order

    expect(nextMoney).toBe(54);
    expect(atStopMoney).toBe(nextMoney);
  });
});
