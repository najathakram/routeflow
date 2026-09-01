/**
 * F30 — server-half hardening specs (test plan TP4).
 *
 * Proves T-B196c / T-B197 / T-B198 / T-B199 / T-B200 (spec R8/R9/R10/R11/R12)
 * from `.claude/pipeline/2026-08-31-f30-scan-loss/{spec,test-plan}.md` and the
 * F30 fix card (`.claude/pipeline/fix-cards/F30-mobile-scan-loss.md`). The
 * card's verified mechanism chains are the oracle — nothing here is re-derived.
 *
 * RED BY DESIGN: none of orders.service.ts / orders.controller.ts implements
 * Idempotency-Key replay, an all-or-nothing diff-add, an explicit-only
 * replaceAll, a serialized denomination-aware merge, and no buyer-scoped
 * barcode lookup exists at all. Every `it()` below fails against the current
 * tree. The last block follows R12 to its home on
 * `BuyerController.scanProduct` — see its own header.
 *
 * Fake stores are hand-rolled (not createMockPrisma()'s blind per-call
 * pass-through) specifically so tenant scoping is actually PROVEN — the
 * batch's hard rule: "the prisma-mock tenantTransaction pass-through cannot
 * prove tenancy — partitioned fake stores for the api half." Because
 * createMockPrisma()'s forTenant()/tenantTransaction() hand back the SAME
 * model-proxy object regardless of tenant, a locally-tracked `currentTenantId`
 * closure variable stands in for the AsyncLocalStorage-bound tenant context
 * that the real forTenant() injects in production. Where a test's subject IS
 * the scoping, the partition is bound to `forTenant()` and the ROOT client is
 * left deliberately unscoped, so a lookup that skips `forTenant()` reads
 * across tenants here exactly as it would in production — a filter the test
 * applies on the service's behalf would prove only itself.
 */

// Mock InvoicesService before it's imported — prevents Jest from traversing
// invoice-pdf.service.ts which imports @react-pdf/renderer (ESM-only module).
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    createInvoiceFromOrder: jest
      .fn()
      .mockResolvedValue([{ id: "inv-1", invoiceNumber: "INV-1", total: 0 }]),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue(undefined),
    resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
  })),
}));

// Mock NotificationsService — it imports expo-server-sdk which is ESM-only
// and fails Jest's CommonJS parser.
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({
    sendToCustomer: jest.fn().mockResolvedValue(undefined),
    sendToDriver: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  NotFoundException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { OrdersService } from "./orders.service";
import { OrdersController } from "./orders.controller";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";
import { NotificationsService } from "../notifications/notifications.service";
import { InventoryService } from "../inventory/inventory.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { PromotionsService } from "../promotions/promotions.service";
import { MessagingService } from "../messaging/messaging.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { normalizeBoxesPieces } from "../common/pricing";
import { normalizeScanCode } from "../common/barcode-normalize";
import { RolesGuard } from "../auth/guards/roles.guard";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { ProductsController } from "../products/products.controller";
import { BuyerController } from "../buyer/buyer.controller";
import { BuyerService } from "../buyer/buyer.service";
import { BuyerCatalogService } from "../buyer/buyer-catalog.service";
import { BuyerDashboardService } from "../buyer/buyer-dashboard.service";
import { ReplenishmentService } from "../buyer/replenishment.service";
import { ShelfService } from "../buyer/shelf.service";
import { StatementService } from "../buyer/statement.service";
import { StatementPdfService } from "../buyer/statement-pdf.service";
import { BuyerJwtAuthGuard } from "../buyer/guards/buyer-jwt-auth.guard";
import { BuyerSellerContextGuard } from "../buyer/guards/buyer-seller-context.guard";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { ChangeRequestsService } from "./change-requests.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { CustomersService } from "../customers/customers.service";
import { OrderTemplatesService } from "../order-templates/order-templates.service";
import { AuthorizationsService } from "../authorizations/authorizations.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

const customerPayload = {
  sub: "user-cust",
  username: "customer1",
  role: "CUSTOMER" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

const MOCK_PRODUCT = { id: "prod-1", name: "Tomatoes", pricePerUnit: 4.99, unit: "punnet" };

function mockGateway() {
  return {
    emitStopCompleted: jest.fn(),
    emitOrderCreated: jest.fn(),
    emitUrgentOrder: jest.fn(),
    emitOrderStatusChanged: jest.fn(),
    emitLowStock: jest.fn(),
  };
}

/**
 * Builds a REAL OrdersService (not a mock) wired to a caller-supplied
 * PrismaService fake, mirroring orders.service.spec.ts's provider list so the
 * actual create()/updateOrderItems() code under test runs unmodified.
 */
async function buildOrdersService(
  prisma: ReturnType<typeof createMockPrisma>,
  gateway: ReturnType<typeof mockGateway>,
): Promise<OrdersService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      OrdersService,
      { provide: PrismaService, useValue: prisma },
      { provide: getQueueToken("invoices"), useValue: { add: jest.fn() } },
      { provide: RouteFlowGateway, useValue: gateway },
      { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(0.1) } },
      {
        provide: InvoicesService,
        useValue: {
          createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
          createInvoiceFromOrder: jest
            .fn()
            .mockResolvedValue([{ id: "inv-1", invoiceNumber: "INV-1", total: 0 }]),
          revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue(undefined),
          resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
          reconcileOrderDraftInvoice: jest.fn().mockResolvedValue(undefined),
        },
      },
      {
        provide: SystemConfigService,
        useValue: {
          // A flat 0% tax keeps totals arithmetic trivial — none of these
          // tests are about tax math.
          get: jest.fn().mockResolvedValue("0"),
          set: jest.fn().mockResolvedValue(undefined),
          getAll: jest.fn().mockResolvedValue({}),
        },
      },
      {
        provide: NotificationsService,
        useValue: {
          sendToCustomer: jest.fn().mockResolvedValue(undefined),
          sendToDriver: jest.fn().mockResolvedValue(undefined),
        },
      },
      {
        provide: InventoryService,
        useValue: { recordSale: jest.fn().mockResolvedValue({ unitCost: 0, stockAfter: 0 }) },
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
      // B65: deleteOrder's per-invoice teardown reverses regulated-ledger entries.
      {
        provide: RegulatedLedgerService,
        useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
      },
    ],
  }).compile();

  return module.get<OrdersService>(OrdersService);
}

// ─── T-B196c (REG-B196 / R8) — Idempotency-Key replay ──────────────────────

describe("OrdersService.create — Idempotency-Key replay (T-B196c / R8 / REG-B196)", () => {
  it("same tenant + same key: one order row, second call returns the first, no duplicate side effects", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    let currentTenantId = "tenant-a";
    prisma.getTenantId.mockImplementation(() => currentTenantId);

    // Partitioned fake store: order.create/findFirst are hand-rolled against a
    // real in-memory array keyed by (tenantId, idempotencyKey) — the
    // createMockPrisma() defaults are blind single-value stubs and cannot
    // prove this.
    const fakeOrders: any[] = [];
    let seq = 0;
    prisma.order.findFirst.mockImplementation(async (args: any) => {
      // RF-014's orderNumber-generator probe — always "no prior order" so
      // create() proceeds; unrelated to the idempotency store under test.
      if (args?.select?.orderNumber !== undefined) return null;
      const key = args?.where?.idempotencyKey;
      if (key === undefined) return null;
      return (
        fakeOrders.find((o) => o.tenantId === currentTenantId && o.idempotencyKey === key) ?? null
      );
    });
    prisma.order.create.mockImplementation(async ({ data }: any) => {
      const row = {
        id: `ord-${++seq}`,
        tenantId: currentTenantId,
        idempotencyKey: data.idempotencyKey ?? null,
        customerId: data.customerId,
        orderNumber: data.orderNumber,
        status: data.status,
        total: data.total,
        urgent: data.urgent,
        createdAt: new Date(),
        customer: { id: data.customerId, businessName: "Test Business" },
        // A real created order CARRIES its lines — the R4 replay content-check
        // compares them against the retry's payload, so an empty [] here would
        // make every replay read as "different cart" (the exact false-409 an
        // earlier fixture caused). Mirror the nested create.
        lineItems: (data.lineItems?.create ?? []).map((li: any) => ({
          productId: li.productId ?? null,
          name: li.name ?? null,
          qty: li.qty,
          status: li.status ?? "PENDING",
        })),
      };
      fakeOrders.push(row);
      return row;
    });
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);

    const service = await buildOrdersService(prisma, gateway);
    const dto = {
      items: [{ productId: "prod-1", qty: 1 }],
      idempotencyKey: "cart-session-key-1",
    } as any;

    const first = await service.create(dto, customerPayload);
    const second = await service.create(dto, customerPayload);

    // R8: a replay must not write a second row, and must hand back the original order.
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
    expect(second.id).toBe(first.id);
    // "no side effects re-run" — the realtime order-created event fires once, not per replay.
    expect(gateway.emitOrderCreated).toHaveBeenCalledTimes(1);

    // R4 (close-out): the SAME key with a DIFFERENT cart is a client bug, not a
    // replay — the edited cart must never be silently acknowledged as the
    // stale stored order. 409, and still no second row.
    const edited = {
      items: [{ productId: "prod-1", qty: 3 }],
      idempotencyKey: "cart-session-key-1",
    } as any;
    await expect(service.create(edited, customerPayload)).rejects.toThrow(
      /reused with a different cart/,
    );
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
  });

  it("persists the key and scopes it per tenant — a DIFFERENT tenant with the same key is a separate order", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    let currentTenantId = "tenant-a";
    prisma.getTenantId.mockImplementation(() => currentTenantId);

    const fakeOrders: any[] = [];
    let seq = 0;

    // RF-014's orderNumber-generator probe — always "no prior order" so
    // create() proceeds; unrelated to the idempotency store under test.
    const isOrderNumberProbe = (args: any) => args?.select?.orderNumber !== undefined;

    // The tenant partition is bound to forTenant(), NOT to a filter this test
    // applies on the service's behalf. The ROOT client below is deliberately
    // UNSCOPED — it searches every tenant's rows, exactly like a bare
    // `prisma.order.findFirst` does in production — so dropping `.forTenant()`
    // from either idempotency lookup in create() makes tenant-b's call find
    // tenant-a's order and this test goes red. That is the leak it exists to
    // catch: a cross-tenant key collision would otherwise hand the caller
    // another tenant's customer name and line items.
    const scopedFindFirst = jest.fn(async (args: any) => {
      if (isOrderNumberProbe(args)) return null;
      const key = args?.where?.idempotencyKey;
      if (key === undefined) return null;
      return (
        fakeOrders.find((o) => o.tenantId === currentTenantId && o.idempotencyKey === key) ?? null
      );
    });
    prisma.order.findFirst.mockImplementation(async (args: any) => {
      if (isOrderNumberProbe(args)) return null;
      const key = args?.where?.idempotencyKey;
      if (key === undefined) return null;
      return fakeOrders.find((o) => o.idempotencyKey === key) ?? null;
    });
    prisma.forTenant.mockImplementation(
      () =>
        ({
          ...prisma,
          order: { ...prisma.order, findFirst: scopedFindFirst },
        }) as any,
    );
    prisma.order.create.mockImplementation(async ({ data }: any) => {
      const row = {
        id: `ord-${++seq}`,
        tenantId: currentTenantId,
        idempotencyKey: data.idempotencyKey ?? null,
        customerId: data.customerId,
        orderNumber: data.orderNumber,
        total: data.total,
        urgent: data.urgent,
        createdAt: new Date(),
        customer: { id: data.customerId, businessName: "Test Business" },
        lineItems: [],
      };
      fakeOrders.push(row);
      return row;
    });
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);

    const service = await buildOrdersService(prisma, gateway);
    const dto = { items: [{ productId: "prod-1", qty: 1 }], idempotencyKey: "shared-uuid" } as any;

    const fromTenantA = await service.create(dto, customerPayload);

    // The key must actually be PERSISTED on the row — today it's never even
    // threaded into the write, so this fails regardless of tenancy.
    expect(prisma.order.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ idempotencyKey: "shared-uuid" }),
    );

    currentTenantId = "tenant-b";
    const fromTenantB = await service.create(dto, customerPayload);

    // The compound (tenantId, idempotencyKey) key means a different tenant
    // reusing the same client-generated uuid is NOT a replay.
    expect(fromTenantB.id).not.toBe(fromTenantA.id);
    expect(prisma.order.create).toHaveBeenCalledTimes(2);

    // …and it is the tenant-bound SURFACE that served the replay lookup, not a
    // predicate this test supplied: the unscoped root client must never see an
    // idempotency-key query.
    expect(scopedFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { idempotencyKey: "shared-uuid" } }),
    );
    expect(prisma.order.findFirst).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { idempotencyKey: "shared-uuid" } }),
    );
  });

  it("same tenant + same key but a DIFFERENT buyer: refuses, never replays the other buyer's order", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    prisma.getTenantId.mockReturnValue("tenant-a");

    // The key is entirely client-chosen, so two buyers on ONE tenant can send
    // the same string — tenant scoping alone does not separate them. Matching
    // on the bare key would hand buyer B the order buyer A created (business
    // name, every line, every unit price) while B's own order is silently
    // never written. The replay must be scoped to the CALLER's customer.
    const fakeOrders: any[] = [];
    let seq = 0;
    prisma.order.findFirst.mockImplementation(async (args: any) => {
      // RF-014's orderNumber-generator probe — always "no prior order".
      if (args?.select?.orderNumber !== undefined) return null;
      const key = args?.where?.idempotencyKey;
      if (key === undefined) return null;
      return fakeOrders.find((o) => o.idempotencyKey === key) ?? null;
    });
    prisma.order.create.mockImplementation(async ({ data }: any) => {
      const row = {
        id: `ord-${++seq}`,
        tenantId: "tenant-a",
        idempotencyKey: data.idempotencyKey ?? null,
        customerId: data.customerId,
        orderNumber: data.orderNumber,
        status: data.status,
        total: data.total,
        urgent: data.urgent,
        createdAt: new Date(),
        customer: { id: data.customerId, businessName: "Buyer A Ltd" },
        lineItems: [],
      };
      fakeOrders.push(row);
      return row;
    });
    // Which buyer the JWT resolves to — flipped between the two calls.
    let currentCustomerId = "cust-a";
    prisma.customer.findFirst.mockImplementation(async () => ({ id: currentCustomerId }));
    prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);

    const service = await buildOrdersService(prisma, gateway);
    const dto = { items: [{ productId: "prod-1", qty: 1 }], idempotencyKey: "collide" } as any;

    const buyerA = await service.create(dto, customerPayload);
    expect(buyerA.customerId).toBe("cust-a");

    currentCustomerId = "cust-b";
    await expect(service.create(dto, { ...customerPayload, sub: "user-cust-b" })).rejects.toThrow(
      ConflictException,
    );

    // Buyer A's order is neither handed to B nor duplicated for B.
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
    expect(gateway.emitOrderCreated).toHaveBeenCalledTimes(1);
  });
});

// ─── T-B197 (REG-B197 / R9) — diff-add all-or-nothing ──────────────────────

describe("OrdersService.updateOrderItems — diff-add is all-or-nothing (T-B197 / R9 / REG-B197)", () => {
  it("an unresolvable productId among two good adds aborts with a 400 naming it, and writes NOTHING", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);

    const order = {
      id: "ord-1",
      customerId: "cust-1",
      status: "DRAFT",
      routeRun: null,
      lineItems: [] as any[],
    };
    prisma.order.findUnique.mockResolvedValue(order);
    const catalogRow = (id: string) => ({
      id,
      pricePerUnit: 5,
      unitsPerBox: null,
      trackedCategoryId: null,
      trackedSubcategoryId: null,
    });
    // Mocked on BOTH read shapes so the ONLY thing distinguishing pass/fail is
    // whether the bad id aborts the whole add — not which query the pre-scan
    // happens to issue. "prod-missing" resolves on neither.
    prisma.product.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === "prod-missing" ? null : catalogRow(where.id),
    );
    prisma.product.findMany.mockImplementation(async ({ where }: any) =>
      (where?.id?.in ?? []).filter((id: string) => id !== "prod-missing").map(catalogRow),
    );
    prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 5, status: "PENDING" }]);

    const dto = {
      items: [
        { productId: "prod-good-1", qty: 1 },
        { productId: "prod-missing", qty: 1 },
        { productId: "prod-good-2", qty: 1 },
      ],
      replaceAll: false,
    } as any;

    const pending = service.updateOrderItems("ord-1", dto, operatorPayload);

    // R9: never a 200 with a dropped line — the whole add must fail loudly,
    // naming the id that couldn't resolve.
    await expect(pending).rejects.toThrow(BadRequestException);
    await expect(pending).rejects.toThrow(/prod-missing/);

    // "NO partial write" — the two good lines must not have been persisted
    // either; today's `continue` lets them through before the bad one skips.
    expect(prisma.orderItem.create).not.toHaveBeenCalled();
  });
});

// ─── T-B198 (REG-B198 / R10) — replaceAll is explicit-only ─────────────────

describe("OrdersService.updateOrderItems — replaceAll is explicit-only (T-B198 / R10 / REG-B198)", () => {
  it("an id-less add-only payload with replaceAll OMITTED is an ADD (existing lines survive); replaceAll:true still replaces", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);

    const existingLine = {
      id: "li-A",
      orderId: "ord-1",
      productId: "prod-A",
      qty: 2,
      unitPrice: 5,
      subtotal: 10,
      status: "PENDING",
      boxes: null,
      pieces: null,
    };
    const order = {
      id: "ord-1",
      customerId: "cust-1",
      status: "DRAFT",
      routeRun: null,
      lineItems: [existingLine],
    };
    prisma.order.findUnique.mockResolvedValue(order);
    // Mocked on BOTH read shapes — today's bug takes the replace-all branch,
    // the fix takes the diff-add branch — so "prod-B" resolves either way and
    // the ONLY thing distinguishing pass/fail is whether the existing line
    // survives.
    const PROD_B = {
      id: "prod-B",
      pricePerUnit: 7,
      unitsPerBox: null,
      trackedCategoryId: null,
      trackedSubcategoryId: null,
    };
    prisma.product.findUnique.mockResolvedValue(PROD_B);
    prisma.product.findMany.mockResolvedValue([PROD_B]);
    prisma.orderItem.findMany.mockResolvedValue([
      { subtotal: 10, status: "PENDING" },
      { subtotal: 7, status: "PENDING" },
    ]);

    // A real mobile "just add this scanned item" PATCH: no id on the item,
    // `replaceAll` not sent at all.
    await service.updateOrderItems(
      "ord-1",
      { items: [{ productId: "prod-B", qty: 1 }] } as any,
      operatorPayload,
    );

    // B198: today `allNewItems` infers replaceAll=true from the id-less shape
    // and wipes li-A. The fix must default to ADD — deleteMany must not fire.
    expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.orderItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ productId: "prod-B" }) }),
    );

    // Counterpart contract, reached once the default-false fix lands: an
    // EXPLICIT replaceAll:true still wipes and recreates.
    prisma.orderItem.deleteMany.mockClear();
    prisma.product.findMany.mockResolvedValue([
      { id: "prod-C", pricePerUnit: 9, unitsPerBox: null },
    ]);
    prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 9, status: "PENDING" }]);
    await service.updateOrderItems(
      "ord-1",
      { items: [{ productId: "prod-C", qty: 1 }], replaceAll: true } as any,
      operatorPayload,
    );
    expect(prisma.orderItem.deleteMany).toHaveBeenCalledWith({ where: { orderId: "ord-1" } });
  });
});

// ─── T-B199 (REG-B199 / R11) — denomination-aware atomic merge ─────────────

describe("OrdersController.create — staff merge is denomination-aware (T-B199 / R11 / REG-B199)", () => {
  const buildController = (ordersService: any) => new OrdersController(ordersService, {} as any);

  it("folds boxes+pieces via normalizeBoxesPieces and preserves unitPrice/notes — never a flat qty sum", async () => {
    const ordersService: any = {
      findActiveOrder: jest.fn().mockResolvedValue({
        id: "ord-active",
        orderNumber: "ORD-1",
        status: "PENDING",
        createdAt: new Date(),
        total: 96,
        lineItems: [
          {
            id: "li-1",
            productId: "prod-1",
            qty: 48, // 2 boxes @ upb 24
            boxes: 2,
            pieces: 0,
            unitPrice: 20,
            unitsPerBox: 24,
            // R0 (close-out): only a MANUAL override survives the fold — derived
            // prices re-derive at the merged quantity. This case pins the
            // preservation branch; the PROMO case below pins the re-derive one.
            priceType: "MANUAL",
            notes: "fragile",
          },
        ],
      }),
      updateOrderItems: jest.fn().mockResolvedValue(undefined),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue({ id: "ord-active" }),
    };
    const controller = buildController(ordersService);

    const dto = {
      customerId: "cust-1",
      mergeChoice: "merge",
      items: [{ productId: "prod-1", qty: 5 }], // incoming: 5 loose pieces
    } as any;

    await controller.create(dto, operatorPayload as any);

    // Oracle taken from the plan's own worked example: existing 2 boxes folded
    // with incoming 5 pieces, via the SAME normalizeBoxesPieces the rest of
    // the money-math discipline uses — not re-derived, not hardcoded.
    const expectedFold = normalizeBoxesPieces({ boxes: 2, pieces: 5, unitsPerBox: 24 });
    expect(expectedFold).toEqual({ boxes: 2, pieces: 5, qty: 53 });

    expect(ordersService.updateOrderItems).toHaveBeenCalledWith(
      "ord-active",
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            productId: "prod-1",
            boxes: expectedFold.boxes,
            pieces: expectedFold.pieces,
            unitPrice: 20,
            notes: "fragile",
          }),
        ]),
      }),
      expect.anything(),
    );
  });

  it("a DERIVED price (non-MANUAL priceType) does not survive the fold — unitPrice is omitted so re-pricing runs at the merged qty", async () => {
    // R0's other branch: a PROMO/SPECIAL/DISCOUNTED price was computed FOR the
    // old quantity (tier thresholds, buy-N-get-M). Carrying it to the merged
    // qty would freeze a stale derivation — omit it and let updateOrderItems
    // re-derive. Only an operator's MANUAL override is a statement of intent
    // that outlives the quantity.
    const ordersService: any = {
      findActiveOrder: jest.fn().mockResolvedValue({
        id: "ord-active",
        orderNumber: "ORD-1",
        status: "PENDING",
        createdAt: new Date(),
        total: 96,
        lineItems: [
          {
            id: "li-1",
            productId: "prod-1",
            qty: 48,
            boxes: 2,
            pieces: 0,
            unitPrice: 20,
            unitsPerBox: 24,
            priceType: "PROMO",
            notes: "fragile",
          },
        ],
      }),
      updateOrderItems: jest.fn().mockResolvedValue(undefined),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue({ id: "ord-active" }),
    };
    const controller = buildController(ordersService);

    await controller.create(
      {
        customerId: "cust-1",
        mergeChoice: "merge",
        items: [{ productId: "prod-1", qty: 5 }],
      } as any,
      operatorPayload as any,
    );

    const [, dtoArg] = ordersService.updateOrderItems.mock.calls[0];
    const merged = dtoArg.items.find((i: any) => i.productId === "prod-1");
    expect(merged).toBeDefined();
    // The fold still lands (denominations preserved) …
    expect(merged).toEqual(expect.objectContaining({ boxes: 2, pieces: 5, notes: "fragile" }));
    // … but the stale derived price is NOT pinned onto the merged line.
    expect("unitPrice" in merged).toBe(false);
  });

  it("two concurrent merges on one instance serialize — the second folds onto the first's write, not a stale snapshot", async () => {
    // The fake IS the store: findActiveOrder snapshots `storeQty` at the moment
    // it is CALLED, and updateOrderItems writes the merged absolute qty back.
    // So the outcome turns purely on when each read lands relative to the other
    // write — which is exactly the property under test.
    //
    // No rendezvous. An earlier draft gated both reads until BOTH had arrived,
    // which deadlocks any implementation that correctly serializes the merges:
    // the second read never happens, the gate never opens, and the test hangs
    // to a jest timeout — i.e. it punished the prescribed fix. Natural
    // interleaving is enough and is deterministic here: a read-modify-write
    // with no claim has both reads complete before either write, while a
    // serialized merge has the second read see the first write.
    let storeQty = 10; // plain (non-boxed) line — Part A above already proves the fold.

    const store: Record<string, any> = {
      findActiveOrder: jest.fn(async () => ({
        id: "ord-active",
        orderNumber: "ORD-1",
        status: "PENDING",
        createdAt: new Date(),
        total: storeQty * 5,
        lineItems: [{ id: "li-1", productId: "prod-1", qty: storeQty, unitPrice: 5 }],
      })),
      updateOrderItems: jest.fn(async (_orderId: string, dto: any) => {
        const line = dto.items.find((i: any) => i.productId === "prod-1");
        if (line) storeQty = Number(line.qty);
        return undefined;
      }),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue({ id: "ord-active" }),
    };

    // Permissive: R11 may move the merge onto a NEW OrdersService method
    // (a transactional claim). An unknown property must not crash the
    // controller — the failure then reads as "expected 15, received 10",
    // which is the signal that this spec has to follow the merge to its new
    // home rather than a TypeError that says nothing.
    const ordersService: any = new Proxy(store, {
      get(target, prop) {
        if (typeof prop === "symbol" || prop in target) return target[prop as string];
        target[prop as string] = jest.fn(async () => undefined);
        return target[prop as string];
      },
    });
    const controller = buildController(ordersService);

    await Promise.all([
      controller.create(
        {
          customerId: "cust-1",
          mergeChoice: "merge",
          items: [{ productId: "prod-1", qty: 3 }],
        } as any,
        operatorPayload as any,
      ),
      controller.create(
        {
          customerId: "cust-1",
          mergeChoice: "merge",
          items: [{ productId: "prod-1", qty: 2 }],
        } as any,
        operatorPayload as any,
      ),
    ]);

    // Serialized, BOTH deltas land: 10 + 3 + 2 = 15. Unserialized, both reads
    // complete before either write, whichever write lands last wins, and the
    // other's contribution is silently clobbered (12 or 13) — the lost update
    // B199 reports.
    expect(storeQty).toBe(15);

    // ⚠️ SCOPE — what this proves, and what it deliberately does not. The
    // mechanism under test is OrdersController's per-order merge lock, and that
    // Map lives on the controller INSTANCE: it serializes every merge this api
    // process handles — the whole population on a single-replica deployment (no
    // replica count is configured in apps/api/railway.toml) — and nothing
    // across processes. updateOrderItems' `SELECT … FOR UPDATE` serializes the
    // WRITE, not the controller-side read the absolute totals were folded from,
    // so two replicas (or a queue replay landing on a different instance than
    // the live request) could still clobber one another. Closing that means
    // folding inside updateOrderItems' own transaction, which is a reshape of
    // that method, not a tightening of this test — see withOrderMergeLock's own
    // SCOPE note; tracked as an F30 follow-up. Do NOT widen this test's name
    // back to "atomic claim" until that lands.
  });

  it("the folded payload run through the REAL updateOrderItems leaves ONE line per product — no duplicate, no dropped case", async () => {
    // Part A/B above mock updateOrderItems and can only assert the payload
    // HANDED to it. That blinds them to the half of the merge that lives on the
    // other side of the call: R10 made `replaceAll` explicit-only, so an
    // absolute folded list sent without it lands in the incremental-ADD branch
    // and is APPENDED on top of the untouched originals. This test closes that
    // seam by feeding the controller's real captured payload into a real
    // OrdersService.
    let capturedOrderId: string | undefined;
    let capturedDto: any;
    const ordersService: any = {
      findActiveOrder: jest.fn().mockResolvedValue({
        id: "ord-active",
        orderNumber: "ORD-1",
        status: "DRAFT",
        createdAt: new Date(),
        total: 50,
        lineItems: [
          // A PLAIN (box-unaware) line: boxes/pieces/unitsPerBox all null — the
          // shape a piece-scan or a catalog-row qty edit persists.
          {
            id: "li-1",
            productId: "prod-1",
            qty: 10,
            boxes: null,
            pieces: null,
            unitsPerBox: null,
            unitPrice: 5,
            notes: null,
          },
        ],
      }),
      updateOrderItems: jest.fn(async (orderId: string, dto: any) => {
        capturedOrderId = orderId;
        capturedDto = dto;
      }),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue({ id: "ord-active" }),
    };
    const controller = new OrdersController(ordersService, {} as any);

    await controller.create(
      {
        customerId: "cust-1",
        mergeChoice: "merge",
        items: [
          // 3 more loose pieces of the product already on the order …
          { productId: "prod-1", qty: 3 },
          // … plus TWO CASES of a product that isn't on it yet. The scan sends
          // qty as total pieces alongside the split, so the box size (24) is
          // recoverable without a catalog lookup.
          { productId: "prod-2", qty: 48, boxes: 2, pieces: 0, unitPrice: 60 },
        ],
      } as any,
      operatorPayload as any,
    );

    // The fold is a FULL line set, so it must say replaceAll out loud.
    expect(capturedOrderId).toBe("ord-active");
    expect(capturedDto.replaceAll).toBe(true);

    // Now run that exact payload through the real service.
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    prisma.order.findUnique.mockResolvedValue({
      id: "ord-active",
      customerId: "cust-1",
      status: "DRAFT",
      routeRun: null,
      lineItems: [{ id: "li-1", orderId: "ord-active", productId: "prod-1", qty: 10 }],
    });
    prisma.product.findMany.mockResolvedValue([
      {
        id: "prod-1",
        pricePerUnit: 5,
        unitsPerBox: null,
        trackedCategoryId: null,
        trackedSubcategoryId: null,
      },
      {
        id: "prod-2",
        pricePerUnit: 60,
        unitsPerBox: 24,
        trackedCategoryId: null,
        trackedSubcategoryId: null,
      },
    ]);
    prisma.orderItem.findMany.mockResolvedValue([
      { subtotal: 65, status: "PENDING" },
      { subtotal: 120, status: "PENDING" },
    ]);

    await service.updateOrderItems("ord-active", capturedDto, operatorPayload);

    // Replace, not append: the originals are cleared and the folded set written.
    expect(prisma.orderItem.deleteMany).toHaveBeenCalledWith({ where: { orderId: "ord-active" } });
    expect(prisma.orderItem.create).toHaveBeenCalledTimes(2);
    const written = prisma.orderItem.create.mock.calls.map((c: any[]) => c[0].data);
    // 10 + 3 = 13 on ONE line — not the untouched 10 plus a second line of 13.
    expect(written.filter((d: any) => d.productId === "prod-1")).toEqual([
      expect.objectContaining({ qty: 13, unitPrice: 5 }),
    ]);
    // Both cases survive: 2 × 24 pieces, still denominated as boxes.
    expect(written.filter((d: any) => d.productId === "prod-2")).toEqual([
      expect.objectContaining({ qty: 48, boxes: 2, pieces: 0, unitsPerBox: 24 }),
    ]);
  });
});

// ─── T-B200 (REG-B200 / R12) — buyer scan lookup reachable + catalog-scoped ──

/**
 * REG-B200 is "a customer is refused by BOTH resolve rungs" — the scan ladder's
 * `/products/barcode/:code` and its `/products` search fallback are each
 * `@Roles(OPERATOR, DRIVER)` (products.controller.ts:44,52), so a customer-side
 * scan gets 403 from the first rung and 403 from the fallback, and no
 * buyer-side rung existed at all (the card: "no buyer scan endpoint exists —
 * buyer-catalog.service.ts only returns barcode as a field").
 *
 * ⚠️ HOME — this block MOVED, per its own earlier note ("if R12 relocates the
 * endpoint, this block must move with it — it must NOT be deleted to go
 * green"). R12 asks for a *catalog-visibility-scoped* lookup, and opening
 * products.controller's staff rungs to CUSTOMER is the opposite of scoped: it
 * hands a customer the operator's whole product table. R12 therefore landed as
 * `GET /buyer/products/scan/:code` (BuyerController.scanProduct), on the buyer
 * portal's own auth realm and behind the same visibility gate every other
 * buyer-catalog surface uses. The assertions below follow it there and state
 * the test plan's oracle at that seam: 200 for a catalog-visible product, 404
 * for one hidden from this buyer, scoped to the buyer's seller.
 *
 * (An even earlier draft asserted on a pure helper over a catalog array the
 * test itself supplied: it could go green on six lines nothing calls, while
 * the 403 stood. Deleted then, and not reintroduced here — every assertion
 * below runs the shipped handler or reads the shipped metadata.)
 */
describe("buyer barcode scan — reachable and catalog-scoped (T-B200 / R12 / REG-B200)", () => {
  const rolesGuard = new RolesGuard(new Reflector());

  /** Minimal ExecutionContext: only what RolesGuard actually reads. */
  const contextFor = (handler: (...args: any[]) => any, cls: any, user: any) =>
    ({
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  const BUYER_CTX = {
    customerId: "cust-abc",
    tenantId: "tenant-xyz",
    tenantSlug: "acme",
    userId: null,
  };
  /** An iOS EAN-13 decode of a 12-digit UPC-A label — B200's own example. */
  const SCANNED = "0012345678905";
  const CATALOG_ROW = { id: "prod-visible", barcode: "012345678905", sku: null, unitSku: null };

  let controller: BuyerController;
  let prisma: ReturnType<typeof createMockPrisma>;
  let scopedProductFindMany: jest.Mock;
  let catalogService: { getProductDetail: jest.Mock };
  let stockAlertService: { isSubscribed: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    scopedProductFindMany = jest.fn().mockResolvedValue([]);
    // Same partition discipline as the idempotency block: the seller scoping is
    // bound to forTenant(), and the ROOT client is left unscoped — here it
    // throws outright, so a scan lookup that queried the raw client (i.e. every
    // tenant's catalog) fails loudly instead of quietly passing.
    prisma.forTenant.mockImplementation(
      () =>
        ({
          ...prisma,
          product: { ...prisma.product, findMany: scopedProductFindMany },
        }) as any,
    );
    prisma.product.findMany.mockImplementation(() => {
      throw new Error("unscoped catalog read — the buyer scan rung must go through forTenant()");
    });

    catalogService = { getProductDetail: jest.fn() };
    stockAlertService = { isSubscribed: jest.fn().mockResolvedValue(false) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BuyerController],
      providers: [
        { provide: BuyerService, useValue: {} },
        { provide: BuyerCatalogService, useValue: catalogService },
        { provide: BuyerDashboardService, useValue: {} },
        { provide: ReplenishmentService, useValue: {} },
        { provide: ShelfService, useValue: {} },
        { provide: StockAlertService, useValue: stockAlertService },
        { provide: PromotionsService, useValue: {} },
        { provide: OrdersService, useValue: {} },
        { provide: ChangeRequestsService, useValue: {} },
        { provide: InvoicesService, useValue: {} },
        { provide: InvoicePdfService, useValue: {} },
        { provide: StatementService, useValue: {} },
        { provide: StatementPdfService, useValue: {} },
        { provide: CustomersService, useValue: {} },
        { provide: OrderTemplatesService, useValue: {} },
        { provide: AuthorizationsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: {} },
        // BuyerTenantInterceptor's own dependency — the route carries it, so
        // Nest instantiates it even though these tests call the handler
        // directly.
        {
          provide: TenantContextService,
          useValue: { run: jest.fn((_id: string, fn: any) => fn()), getOrNull: () => null },
        },
      ],
    }).compile();

    controller = module.get<BuyerController>(BuyerController);
  });

  it("REG-B200: a customer-reachable scan rung exists — buyer-JWT + seller-context guarded, no staff @Roles gate", () => {
    const handler = (BuyerController.prototype as any).scanProduct;
    expect(typeof handler).toBe("function");
    expect(Reflect.getMetadata("path", handler)).toBe("products/scan/:code");

    // The realm that makes it reachable at all: the buyer JWT on the class, the
    // seller-context guard on the route (so it is reachable but never
    // UNSCOPED), and no `@Roles(...)` anywhere — that metadata is precisely
    // what makes RolesGuard 403 a customer on the two product rungs.
    expect(Reflect.getMetadata("__guards__", BuyerController) ?? []).toContain(BuyerJwtAuthGuard);
    expect(Reflect.getMetadata("__guards__", handler) ?? []).toContain(BuyerSellerContextGuard);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, BuyerController)).toBeUndefined();

    // …and the staff rungs stay staff-only. R12 is a visibility-SCOPED buyer
    // rung, not blanket customer access to the operator catalog: if these ever
    // start admitting CUSTOMER, everything asserted below is bypassable.
    expect(
      rolesGuard.canActivate(
        contextFor(ProductsController.prototype.findByBarcode, ProductsController, customerPayload),
      ),
    ).toBe(false);
    expect(
      rolesGuard.canActivate(
        contextFor(ProductsController.prototype.findAll, ProductsController, customerPayload),
      ),
    ).toBe(false);
    expect(
      rolesGuard.canActivate(
        contextFor(ProductsController.prototype.findByBarcode, ProductsController, operatorPayload),
      ),
    ).toBe(true);
  });

  it("REG-B200: a catalog-visible product resolves 200 — on the seller's scoped catalog, through this buyer's gate", async () => {
    scopedProductFindMany.mockResolvedValue([CATALOG_ROW]);
    const detail = { id: CATALOG_ROW.id, name: "Tomatoes", buyerPrice: 4.99 };
    catalogService.getProductDetail.mockResolvedValue(detail);

    const result = await controller.scanProduct(SCANNED, BUYER_CTX as any);
    expect(result).toEqual({ ...detail, alertSubscribed: false });

    // Decoder-independence, taken from the REAL normalizer rather than a
    // hardcoded list: the 13-digit iOS decode must still match the 12-digit
    // string the catalog stores, which is the whole reason the rung reuses
    // normalizeScanCode instead of matching the raw string.
    const candidates = normalizeScanCode(SCANNED);
    expect(candidates).toContain("012345678905");
    expect(scopedProductFindMany.mock.calls[0][0].where.OR).toEqual(
      expect.arrayContaining([
        { barcode: { in: candidates } },
        { sku: { in: candidates } },
        { unitSku: { in: candidates } },
      ]),
    );

    // Scoped to the buyer's seller (the unscoped root client throws, above) and
    // gated on THIS buyer — a lookup that never receives the caller cannot
    // scope anything.
    expect(prisma.forTenant).toHaveBeenCalled();
    expect(catalogService.getProductDetail).toHaveBeenCalledWith(
      CATALOG_ROW.id,
      BUYER_CTX.customerId,
    );
  });

  it("REG-B200: a product hidden from this buyer 404s — the matched row never leaks past the gate", async () => {
    scopedProductFindMany.mockResolvedValue([CATALOG_ROW]);
    // What BuyerCatalogService.getProductDetail actually does for an inactive
    // product, or one in a regulated category this buyer isn't authorized for
    // (buyer-catalog.service.ts:349,357).
    catalogService.getProductDetail.mockRejectedValue(new NotFoundException("Product not found"));

    await expect(controller.scanProduct(SCANNED, BUYER_CTX as any)).rejects.toThrow(
      NotFoundException,
    );
    // The gate decides, and nothing downstream of it ran — so no row shape can
    // slip out around it.
    expect(stockAlertService.isSubscribed).not.toHaveBeenCalled();

    // A code that matches nothing in this seller's catalog is a plain 404 that
    // never reaches the gate at all.
    scopedProductFindMany.mockResolvedValue([]);
    catalogService.getProductDetail.mockClear();
    await expect(controller.scanProduct("999999999999", BUYER_CTX as any)).rejects.toThrow(
      NotFoundException,
    );
    expect(catalogService.getProductDetail).not.toHaveBeenCalled();
  });
});

// ─── R1 — first idempotency key wins on an existing order ───────────────────

describe("OrdersService.recordIdempotencyKey — first key wins (R1)", () => {
  it("a later wave's key never clobbers the key already on the order", async () => {
    // The stateful fake IS the store: updateMany applies its own WHERE, so the
    // guard (`idempotencyKey: null`) is proven by behavior, not by call shape.
    const row: { id: string; idempotencyKey: string | null } = {
      id: "ord-1",
      idempotencyKey: null,
    };
    const prisma = createMockPrisma();
    prisma.order.updateMany.mockImplementation(async ({ where, data }: any) => {
      const matches =
        where.id === row.id &&
        (!("idempotencyKey" in where) || where.idempotencyKey === row.idempotencyKey);
      if (matches) row.idempotencyKey = data.idempotencyKey;
      return { count: matches ? 1 : 0 };
    });
    const service = await buildOrdersService(prisma, mockGateway());

    await service.recordIdempotencyKey("ord-1", "wave-1-key");
    expect(row.idempotencyKey).toBe("wave-1-key");

    // Second auto-merge wave arrives with ITS key — the stuck client that will
    // retry holds wave-1's key, so wave-2 must not steal the slot.
    await service.recordIdempotencyKey("ord-1", "wave-2-key");
    expect(row.idempotencyKey).toBe("wave-1-key");
  });
});
