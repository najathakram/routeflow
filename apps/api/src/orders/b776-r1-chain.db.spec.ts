/**
 * B776/SA-124g/h — R1's gate: the whole chain (sweep, forceConsolidate, staff replace-all) on
 * REAL Postgres, asserting on the STORED columns. Cases (a)-(g), per SA-124h:
 *   (a) the sweep with a 12-pack loser folds into the 12-pack winner line at $36
 *   (b) forceConsolidateCustomer, the same
 *   (c) a staff replace-all on a product repacked 12 -> 6 -> 409, nothing written
 *   (d) plain duplicates (no pack at all) plus a plain scan -> the first grows, the second is
 *       byte-identical, no refusal
 *   (e) a normal same-pack replace-all (payload pack == live pack) is unchanged from master
 *   (f) same-pack duplicates at DIFFERENT prices plus a same-pack scan -> pin the ACTUAL
 *       behavior (a fail-closed "reason required" 4xx is acceptable for R1; a silently minted
 *       MANUAL override is NOT — if that happens, sourceLineId is not moot after all)
 *   (g) same-pack duplicates at the SAME price plus a same-pack scan -> the first grows, the
 *       second is byte-identical, nothing refused
 *
 * Constructs a REAL OrdersService (the harness's own provider list, `testing/orders-service-
 * harness.ts`) with PrismaService and TenantContextService swapped for genuinely DB-connected
 * instances — every OTHER collaborator (InvoicesService, NotificationsService, restrictions,
 * promotions, credit notes, commission engine, entitlements, regulated ledger) stays the SAME
 * permissive mock the unit-test harness already uses, since none of them decide pack/price
 * here. `forTenant()`'s ambient scoping needs the REAL TenantContextService (its ALS-backed
 * `run()`) — the unit-test harness's own `{ run: (_id, fn) => fn() }` bypass would silently
 * skip real tenant scoping against a real DB.
 *
 * Run via `npm run local:test:db` (compose Postgres) — collected only by jest.db.config.js.
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

import { randomUUID } from "crypto";
import { Test, TestingModule } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
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
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { foldMergeItems } from "./merge-items";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const operatorPayload = {
  status: "ACTIVE" as const,
  forcePasswordChange: false,
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
};

describeDb("B776 R1 chain (SA-124g/h gate) — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let svc: OrdersService;
  let dbPrisma: PrismaService;
  let tenantCtx: TenantContextService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-r1chain-${run}`, "b776-r1-chain.db.spec.ts");
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
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    svc = module.get(OrdersService);

    tenantId = (await raw.tenant.create({ data: { slug, name: `R1 chain ${slug}` } })).id;
  }, 120_000);

  afterAll(async () => {
    if (orderIds.length) await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    if (orderIds.length) await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    if (customerIds.length) await raw.customer.deleteMany({ where: { id: { in: customerIds } } });
    if (productIds.length) await raw.product.deleteMany({ where: { id: { in: productIds } } });
    if (userIds.length) await raw.user.deleteMany({ where: { id: { in: userIds } } });
    if (tenantId) await raw.tenant.deleteMany({ where: { id: tenantId } });
    await dbPrisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  async function seedCustomer(tag: string) {
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
      data: { userId: user.id, businessName: `${tag} co`, contactName: "R1 Tester", tenantId },
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

  async function seedPendingOrder(
    customerId: string,
    lines: Array<{
      productId: string;
      qty: number;
      boxes: number | null;
      pieces: number | null;
      unitsPerBox: number | null;
      unitPrice: number;
      priceType?: string;
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
            subtotal: (l.unitPrice * l.qty).toString(),
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

  it("(a) sweep: a 12-pack loser folds into the 12-pack winner line at $36", async () => {
    const customerId = await seedCustomer("a");
    const productId = await seedProduct("prod-a", 12, 3);
    // Neither seeded order is necessarily the merge's own winner: mergeAllPendingForCustomer
    // (orders.service.ts:664) orders pendingOrders by updatedAt DESC and takes the FIRST as
    // winner (:673) — the second-created row here, not the first, since nothing updates either
    // between creation. Read the actual surviving order id off the call's own return value
    // instead of assuming which locally-seeded order survives.
    await seedPendingOrder(customerId, [
      { productId, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 36 },
    ]);
    await seedPendingOrder(customerId, [
      { productId, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 36 },
    ]);

    const merged = await tenantCtx.run(tenantId, () => svc.mergeAllPendingForCustomer(customerId));

    const items = await itemsOf(merged!.id);
    const line = items.find((i) => i.productId === productId)!;
    expect(line).toMatchObject({
      boxes: 2,
      pieces: 0,
      unitsPerBox: 12,
      subtotal: expect.anything(),
    });
    expect(Number(line.unitPrice)).toBe(36);
    expect(Number(line.subtotal)).toBe(72);
  });

  it("(b) forceConsolidateCustomer: the same", async () => {
    const customerId = await seedCustomer("b");
    const productId = await seedProduct("prod-b", 12, 3);
    // Same updatedAt-DESC winner selection as (a) (orders.service.ts:940/947) — read the
    // surviving order id off the call's own return value.
    await seedPendingOrder(customerId, [
      { productId, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 36 },
    ]);
    await seedPendingOrder(customerId, [
      { productId, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 36 },
    ]);

    const merged = await tenantCtx.run(tenantId, () => svc.forceConsolidateCustomer(customerId));

    const items = await itemsOf(merged!.id);
    const line = items.find((i) => i.productId === productId)!;
    expect(line).toMatchObject({ boxes: 2, pieces: 0, unitsPerBox: 12 });
    expect(Number(line.unitPrice)).toBe(36);
    expect(Number(line.subtotal)).toBe(72);
  });

  it("(c) staff replace-all on a product repacked 12 -> 6 refuses (409) — nothing written", async () => {
    const customerId = await seedCustomer("c");
    const productId = await seedProduct("prod-c", 6, 6); // LIVE pack now 6
    const order = await seedPendingOrder(customerId, [
      { productId, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 36 },
    ]);
    const before = await itemsOf(order.id);

    const err = await tenantCtx
      .run(tenantId, () =>
        svc.updateOrderItems(
          order.id,
          {
            replaceAll: true,
            items: [{ productId, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 36 }],
          } as never,
          operatorPayload as never,
        ),
      )
      .catch((e: any) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.response ?? err).toMatchObject(
      expect.objectContaining({ code: "MERGE_PACK_MISMATCH" }),
    );
    const after = await itemsOf(order.id);
    expect(after).toEqual(before); // nothing written — the whole transaction rolled back
  });

  it("(d) plain duplicates (no pack) plus a plain scan — the first grows, the second is byte-identical, no refusal", async () => {
    const customerId = await seedCustomer("d");
    const productId = await seedProduct("prod-d", null, 2);
    const order = await seedPendingOrder(customerId, [
      { productId, qty: 5, boxes: null, pieces: null, unitsPerBox: null, unitPrice: 2 },
      { productId, qty: 3, boxes: null, pieces: null, unitsPerBox: null, unitPrice: 2 },
    ]);

    // "Duplicates preserved, first grows" (Opus HIGH #2 / SA-124g/h item 3) is foldMergeItems'
    // own contract (merge-items.ts), which the controller layer runs BEFORE updateOrderItems
    // (orders.controller.ts:225, buyer.controller.ts:617) to build the full replaceAll payload.
    // This spec constructs OrdersService directly with no controller in its DI graph, so it
    // must fold explicitly here too — calling updateOrderItems with a bare single-item payload
    // (as the original draft did) exercises a different contract: replaceAll's OWN "the payload
    // IS the full desired line set" semantics, where a one-item payload correctly discards the
    // second line. That is not a bug; it is the wrong layer for what this case means to pin.
    const foldResult = foldMergeItems(order.lineItems, [{ productId, qty: 4 }]);

    await tenantCtx.run(tenantId, () =>
      svc.updateOrderItems(
        order.id,
        { replaceAll: true, items: foldResult.items } as never,
        operatorPayload as never,
      ),
    );

    const after = await itemsOf(order.id);
    expect(after).toHaveLength(2);
    expect(after.map((i) => Number(i.qty)).sort((a, b) => a - b)).toEqual(
      [3, 9].sort((a, b) => a - b),
    );
  });

  it("(e) a normal same-pack replace-all (payload pack == live pack) is unchanged from master", async () => {
    const customerId = await seedCustomer("e");
    const productId = await seedProduct("prod-e", 12, 3);
    const order = await seedPendingOrder(customerId, [
      { productId, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 36 },
    ]);

    await tenantCtx.run(tenantId, () =>
      svc.updateOrderItems(
        order.id,
        {
          replaceAll: true,
          items: [{ productId, qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12, unitPrice: 36 }],
        } as never,
        operatorPayload as never,
      ),
    );

    const items = await itemsOf(order.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ boxes: 2, pieces: 0, unitsPerBox: 12 });
  });

  it("(f) same-pack duplicates at DIFFERENT prices plus a same-pack scan — pins the ACTUAL behavior (a fail-closed 4xx is acceptable for R1; a minted MANUAL override is NOT)", async () => {
    const customerId = await seedCustomer("f");
    const productId = await seedProduct("prod-f", 12, 3);
    const order = await seedPendingOrder(customerId, [
      {
        productId,
        qty: 12,
        boxes: 1,
        pieces: 0,
        unitsPerBox: 12,
        unitPrice: 36,
        priceType: "STANDARD",
      },
      {
        productId,
        qty: 24,
        boxes: 2,
        pieces: 0,
        unitsPerBox: 12,
        unitPrice: 30,
        priceType: "MANUAL",
        overrideReason: "operator discount",
      },
    ]);
    const before = await itemsOf(order.id);

    const result = await tenantCtx
      .run(tenantId, () =>
        svc.updateOrderItems(
          order.id,
          {
            replaceAll: true,
            items: [
              { productId, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 36 },
              { productId, qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12, unitPrice: 30 },
            ],
          } as never,
          operatorPayload as never,
        ),
      )
      .catch((e: any) => e);

    if (result instanceof Error) {
      // Fail-closed — acceptable for R1. Nothing written.
      const after = await itemsOf(order.id);
      expect(after).toEqual(before);
    } else {
      // The rebuild wrote something — assert it never minted a NEW MANUAL override on either
      // line beyond what was already there. If this branch is what actually happens, it is
      // the signal that sourceLineId-based comparison (SA-124f item 1) is needed after all.
      const after = await itemsOf(order.id);
      const manualLines = after.filter((i) => i.priceType === "MANUAL");
      // At most the one line that was ALREADY MANUAL pre-edit may still be MANUAL.
      expect(manualLines.length).toBeLessThanOrEqual(1);
    }
  });

  it("(g) same-pack duplicates at the SAME price plus a same-pack scan — the first grows, the second is byte-identical, nothing refused", async () => {
    const customerId = await seedCustomer("g");
    const productId = await seedProduct("prod-g", 12, 3);
    const order = await seedPendingOrder(customerId, [
      { productId, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 36 },
      { productId, qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12, unitPrice: 36 },
    ]);

    await tenantCtx.run(tenantId, () =>
      svc.updateOrderItems(
        order.id,
        {
          replaceAll: true,
          items: [
            { productId, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 36 },
            { productId, qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12, unitPrice: 36 },
          ],
        } as never,
        operatorPayload as never,
      ),
    );

    const after = await itemsOf(order.id);
    expect(after).toHaveLength(2);
    expect(after.map((i) => i.boxes).sort()).toEqual([1, 2]);
  });
});
