/**
 * B776/SA-124g/h/i — R1's gate: the whole chain (sweep, forceConsolidate, staff replace-all) on
 * REAL Postgres, asserting on the STORED columns. Cases (a)-(h), per SA-124h/i and Opus's
 * round-5 required changes (#938):
 *   (a) the sweep folds contributing lines at their OWN snapshot pack, never the live pack —
 *       a repacked (12 -> live 6) and a made-fully-unboxed (12 -> live null) product
 *   (b) forceConsolidateCustomer, the same
 *   (c) a staff replace-all on a product repacked 12 -> 6 -> 409, nothing written
 *   (d) plain duplicates (no pack at all) plus a plain scan, folded through foldMergeItems ->
 *       the first grows, the second is byte-identical, no refusal
 *   (e) a normal same-pack replace-all (payload pack == live pack) is unchanged from master
 *   (f) same-pack duplicates at DIFFERENT prices plus a same-pack scan, folded through
 *       foldMergeItems -> both lines keep their own price and priceType, manualLines unchanged
 *       (SA-124i option i: sourceLineId disambiguates the two same-product lines)
 *   (g) same-pack duplicates at the SAME price plus a same-pack scan, folded through
 *       foldMergeItems -> the first grows, the second is byte-identical, nothing refused
 *   (h) a MANUAL 2x12 line whose product has since been made fully UNBOXED — a staff
 *       create-merge scan REFUSES (409), never bills the stale box price per piece (Opus
 *       REQUIRED HIGH #1)
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
          useValue: {
            reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined),
            syncInvoiceEntries: jest.fn(),
          },
        },
      ],
    }).compile();
    svc = module.get(OrdersService);

    tenantId = (await raw.tenant.create({ data: { slug, name: `R1 chain ${slug}` } })).id;
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

  it("(a) sweep: contributing lines fold at their OWN snapshot pack, never the live pack — a repacked (12->live 6) product and one made fully unboxed (12->live null)", async () => {
    // Opus MED #4 (#938, round 5): the original (a) seeded the LIVE pack equal to the lines'
    // own snapshot (12 == 12), so master's pre-B776 code — which re-split at the LIVE pack —
    // would have passed this too. Seeding a DIFFERENT live pack (and a fully-unboxed live
    // pack) is what actually proves buildMergeLineWrites groups by the SNAPSHOT pack the
    // lines were priced at, never the live product row (SA-101(1)).
    const customerId = await seedCustomer("a");
    const productRepack = await seedProduct("prod-a-repack", 6, 6); // LIVE pack now 6 (was 12)
    const productUnboxed = await seedProduct("prod-a-unboxed", null, 8); // LIVE now fully unboxed
    // Neither seeded order is necessarily the merge's own winner: mergeAllPendingForCustomer
    // (orders.service.ts:664) orders pendingOrders by updatedAt DESC and takes the FIRST as
    // winner (:673) — the second-created row here, not the first, since nothing updates either
    // between creation. Read the actual surviving order id off the call's own return value
    // instead of assuming which locally-seeded order survives.
    await seedPendingOrder(customerId, [
      { productId: productRepack, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 36 },
      { productId: productUnboxed, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 48 },
    ]);
    await seedPendingOrder(customerId, [
      { productId: productRepack, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 36 },
      { productId: productUnboxed, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 48 },
    ]);

    const merged = await tenantCtx.run(tenantId, () => svc.mergeAllPendingForCustomer(customerId));

    const items = await itemsOf(merged!.id);
    const repackLine = items.find((i) => i.productId === productRepack)!;
    expect(repackLine).toMatchObject({
      boxes: 2,
      pieces: 0,
      unitsPerBox: 12, // the SNAPSHOT pack, never re-split at the live 6
      subtotal: expect.anything(),
    });
    expect(Number(repackLine.unitPrice)).toBe(36);
    expect(Number(repackLine.subtotal)).toBe(72);

    const unboxedLine = items.find((i) => i.productId === productUnboxed)!;
    expect(unboxedLine).toMatchObject({ boxes: 2, pieces: 0, unitsPerBox: 12 });
    expect(Number(unboxedLine.unitPrice)).toBe(48);
    expect(Number(unboxedLine.subtotal)).toBe(96);
  });

  it("(b) forceConsolidateCustomer: the same", async () => {
    const customerId = await seedCustomer("b");
    const productRepack = await seedProduct("prod-b-repack", 6, 6);
    const productUnboxed = await seedProduct("prod-b-unboxed", null, 8);
    // Same updatedAt-DESC winner selection as (a) (orders.service.ts:940/947) — read the
    // surviving order id off the call's own return value.
    await seedPendingOrder(customerId, [
      { productId: productRepack, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 36 },
      { productId: productUnboxed, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 48 },
    ]);
    await seedPendingOrder(customerId, [
      { productId: productRepack, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 36 },
      { productId: productUnboxed, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 48 },
    ]);

    const merged = await tenantCtx.run(tenantId, () => svc.forceConsolidateCustomer(customerId));

    const items = await itemsOf(merged!.id);
    const repackLine = items.find((i) => i.productId === productRepack)!;
    expect(repackLine).toMatchObject({ boxes: 2, pieces: 0, unitsPerBox: 12 });
    expect(Number(repackLine.unitPrice)).toBe(36);
    expect(Number(repackLine.subtotal)).toBe(72);

    const unboxedLine = items.find((i) => i.productId === productUnboxed)!;
    expect(unboxedLine).toMatchObject({ boxes: 2, pieces: 0, unitsPerBox: 12 });
    expect(Number(unboxedLine.unitPrice)).toBe(48);
    expect(Number(unboxedLine.subtotal)).toBe(96);
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
    const foldResult = foldMergeItems(await itemsOf(order.id), [{ productId, qty: 4 }]);

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
    const productId = await seedProduct("prod-e", 12, 36);
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

  it("(f) same-pack duplicates at DIFFERENT prices plus a same-pack scan — both lines keep their own price and priceType, manualLines unchanged (SA-124i option i / Opus MED #3)", async () => {
    const customerId = await seedCustomer("f");
    // SA-124k: pricePerUnit is the price of ONE SELLING UNIT — a box, at 12 here, never a
    // per-piece amount needing multiplication by unitsPerBox (create(), the web create modal
    // and SA-124g all share this convention). 36 matches the lines' own $36/box; seeding 3
    // (a per-piece price) was this fixture's own bug — the rebuild correctly re-derived $3/box
    // from it, which F2 read as a 12x undercharge in the fixture, not the code.
    const productId = await seedProduct("prod-f", 12, 36);
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

    // Opus HIGH #2 / MED #3: a genuine scan, folded through foldMergeItems (the real
    // controller's own step, orders.controller.ts:225) — never a hand-built payload that
    // echoes both lines' prices verbatim (foldMergeItems never produces that shape: a
    // derived/STANDARD line's price never survives the fold, REG-B465-MERGE-2). The scan
    // matches the order's own 12-pack, so it folds into the FIRST bucket (the STANDARD line).
    const foldResult = foldMergeItems(await itemsOf(order.id), [
      { productId, qty: 12, boxes: 1, pieces: 0 },
    ]);

    await tenantCtx.run(tenantId, () =>
      svc.updateOrderItems(
        order.id,
        { replaceAll: true, items: foldResult.items } as never,
        operatorPayload as never,
      ),
    );

    const after = await itemsOf(order.id);
    expect(after).toHaveLength(2);
    // The MANUAL line is untouched by the scan (not the bucket it folded into) — its price,
    // priceType and reason all survive exactly, via foldMergeItems' MANUAL-survival rule
    // (REG-B465-MERGE-1) and now also disambiguated by sourceLineId (SA-124i), never confused
    // with the OTHER same-product line's price the way productId-only lookup would.
    const manualLines = after.filter((i) => i.priceType === "MANUAL");
    expect(manualLines).toHaveLength(1);
    expect(Number(manualLines[0].unitPrice)).toBe(30);
    expect(manualLines[0].overrideReason).toBe("operator discount");
    expect(manualLines[0].boxes).toBe(2);
    // The STANDARD line grew (1 box + the 1 scanned box) and RE-DERIVES its price from the
    // catalog at the merged quantity (R0's own rule) — which lands back at the same $36 list
    // price here, never minted MANUAL just because the fold ran.
    const standardLines = after.filter((i) => i.priceType === "STANDARD");
    expect(standardLines).toHaveLength(1);
    expect(Number(standardLines[0].unitPrice)).toBe(36);
    expect(standardLines[0].boxes).toBe(2);
  });

  it("(g) same-pack duplicates at the SAME price plus a same-pack scan — the first grows, the second is byte-identical, nothing refused", async () => {
    const customerId = await seedCustomer("g");
    const productId = await seedProduct("prod-g", 12, 36);
    const order = await seedPendingOrder(customerId, [
      { productId, qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitPrice: 36 },
      { productId, qty: 36, boxes: 3, pieces: 0, unitsPerBox: 12, unitPrice: 36 },
    ]);

    const foldResult = foldMergeItems(await itemsOf(order.id), [
      { productId, qty: 12, boxes: 1, pieces: 0 },
    ]);

    await tenantCtx.run(tenantId, () =>
      svc.updateOrderItems(
        order.id,
        { replaceAll: true, items: foldResult.items } as never,
        operatorPayload as never,
      ),
    );

    const after = await itemsOf(order.id);
    expect(after).toHaveLength(2);
    // The first line grew (1 box + the 1 scanned box = 2); the second (3 boxes) is untouched —
    // distinguishable numbers so a fold-into-the-wrong-bucket bug can't hide behind a
    // coincidental match.
    expect(after.map((i) => i.boxes).sort()).toEqual([2, 3]);
  });

  it("(h) a MANUAL 2x12 line, product since made fully UNBOXED — a staff create-merge scan REFUSES (409), never bills the stale box price per piece", async () => {
    // Opus REQUIRED HIGH #1 (#938, round 5): assertReplaceAllPackMatchesLive's original
    // `!(livePack > 1)` early-return let a snapshot pack survive unchecked once the product
    // was made unboxed. foldMergeItems itself has no live-pack info at fold time (the
    // controller calls it with only 2 args, orders.controller.ts:225) — it carries the
    // MANUAL line's $36 BOX price and its 12-pack snapshot straight through. Without this
    // guard, a 3-piece scan would normalize to 2 boxes + 3 loose pieces = qty 27, and
    // updateOrderItems would bill 27 x $36 = $972 against a product that is no longer boxed
    // at all — the correct bill (a per-unit re-price at $3/unit) would be $81. This pin
    // proves it refuses instead.
    const customerId = await seedCustomer("h");
    const productId = await seedProduct("prod-h", null, 3); // LIVE: fully unboxed now
    const order = await seedPendingOrder(customerId, [
      {
        productId,
        qty: 24,
        boxes: 2,
        pieces: 0,
        unitsPerBox: 12, // the STALE snapshot from before the product was unboxed
        unitPrice: 36,
        priceType: "MANUAL",
        overrideReason: "operator discount",
      },
    ]);
    const before = await itemsOf(order.id);

    // A staff create-merge: fold a bare 3-piece scan (no box data of its own — the incoming
    // side never claims a pack; only the EXISTING line's stale snapshot does).
    const foldResult = foldMergeItems(await itemsOf(order.id), [{ productId, qty: 3 }]);

    const err = await tenantCtx
      .run(tenantId, () =>
        svc.updateOrderItems(
          order.id,
          { replaceAll: true, items: foldResult.items } as never,
          operatorPayload as never,
          { isCreateMerge: true },
        ),
      )
      .catch((e: any) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.response ?? err).toMatchObject(
      expect.objectContaining({
        code: "MERGE_PACK_MISMATCH",
        existingPacks: [12],
        incomingPack: 0,
      }),
    );
    const after = await itemsOf(order.id);
    expect(after).toEqual(before); // nothing written — the whole transaction rolled back
  });
});
