/**
 * B215 — a same-key retry of a staff order merge folds the same items twice.
 *
 * Proves REG-B215 T1-T10 (unit) plus pins P1-P4 from
 * `.claude/pipeline/2026-09-10-train4-run-b/bug-test-plan.md`. Package TP1 of
 * `build-plan.md`. RED BY DESIGN: none of `OrdersService` /
 * `OrdersController` yet has an `OrderIdempotencyKey` table, a
 * `recordMergeIdempotencyKey`, or a 4th `updateOrderItems` argument — every
 * REG test below fails against the current tree on its own stated value.
 *
 * Harness copied verbatim from `orders.scan-hardening.spec.ts` per the build
 * plan: the three `jest.mock` blocks, `buildOrdersService`, `mockGateway`,
 * `operatorPayload`, `activeOrderFixture`, and `buildController`.
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

// See orders.scan-hardening.spec.ts for the full rationale: an in-memory FIFO
// per-key serializer standing in for the real Postgres advisory lock, so the
// controller's merge branch (which imports `withAdvisoryLock` from this
// module) runs its critical section exactly as in production, without
// touching Postgres.
jest.mock("../common/db-locks", () => {
  class LockTimeoutError extends Error {
    constructor(
      public readonly family: string,
      public readonly key: string,
      public readonly waitMs: number,
    ) {
      super(`advisory lock timeout: ${family}:${key} after ${waitMs}ms`);
      this.name = "LockTimeoutError";
    }
  }
  class LockUnavailableError extends Error {
    constructor(public readonly cause?: unknown) {
      super("advisory lock unavailable");
      this.name = "LockUnavailableError";
    }
  }
  const chains = new Map<string, Promise<unknown>>();
  const events: string[] = [];
  const withAdvisoryLock = jest.fn(
    async (
      opts: { family: string; key: string; mode: "wait" | "try"; waitMs?: number },
      fn: () => Promise<unknown>,
    ) => {
      const chainKey = `${opts.family}:${opts.key}`;
      const prior = chains.get(chainKey) ?? Promise.resolve();
      const turn = prior
        .catch(() => undefined)
        .then(async () => {
          events.push(`enter:${chainKey}`);
          try {
            return await fn();
          } finally {
            events.push(`exit:${chainKey}`);
          }
        });
      chains.set(
        chainKey,
        turn.then(
          () => undefined,
          () => undefined,
        ),
      );
      const value = await turn;
      return { acquired: true, value };
    },
  );
  return { withAdvisoryLock, LockTimeoutError, LockUnavailableError, __lockEvents: events };
});

import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, ForbiddenException, Logger } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { OrdersService } from "./orders.service";
import { OrdersController } from "./orders.controller";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";
import {
  IDEMPOTENCY_KEY_CONFLICT,
  IDEMPOTENCY_REPLAY_NEEDS_RECONCILE,
  mergeRequestHash,
} from "./merge-idempotency";
import { NotificationsService } from "../notifications/notifications.service";
import { InventoryService } from "../inventory/inventory.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { PromotionsService } from "../promotions/promotions.service";
import { MessagingService } from "../messaging/messaging.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

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
 * PrismaService fake, mirroring orders.scan-hardening.spec.ts's provider list
 * so the actual create()/updateOrderItems()/mergeAllPendingForCustomer()/
 * forceConsolidateCustomer() code under test runs unmodified.
 */
async function buildOrdersService(
  prisma: ReturnType<typeof createMockPrisma>,
  gateway: ReturnType<typeof mockGateway>,
): Promise<OrdersService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      OrdersService,
      {
        provide: TenantContextService,
        // B323: sweepAllPendingOrders() now takes TenantContextService; this spec never
        // exercises the sweep, so a bare run-through mock is enough to satisfy DI.
        useValue: { run: (_tenantId: string | null, fn: () => unknown) => fn() },
      },
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
          // T6/T7: forceConsolidateCustomer's loser loop reads this before
          // deleting each loser's order.
          findOpenOrderDraft: jest.fn().mockResolvedValue(null),
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
      {
        provide: RegulatedLedgerService,
        useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
      },
    ],
  }).compile();

  return module.get<OrdersService>(OrdersService);
}

const buildController = (svc: any) => new OrdersController(svc, {} as any);

const activeOrderFixture = {
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
      priceType: "MANUAL",
      notes: null,
    },
  ],
};

const mergeDto = (qty = 5) =>
  ({ customerId: "cust-1", mergeChoice: "merge", items: [{ productId: "prod-1", qty }] }) as any;

/**
 * Mirrors the REAL semantics of each method: today's column lookup and
 * first-key-wins stamp, plus the table store the fix adds. The same fake
 * therefore reproduces today's double fold and proves the fixed controller's
 * replay (T1-T3, P1, P2).
 */
function statefulOrdersService(opts: { orderKey: string | null; throwAfterFirstFold?: boolean }) {
  const order = {
    id: "ord-active",
    customerId: "cust-1",
    idempotencyKey: opts.orderKey,
    total: 96,
  };
  const keyRows: Array<{ key: string; orderId: string; responseHash: string }> = [];
  let folds = 0;
  const svc: any = {
    findActiveOrder: jest.fn(async () => ({ ...activeOrderFixture })),
    // Table first (the fix's store), then the single Order column (today's store).
    findOrderIdByIdempotencyKey: jest.fn(
      async (key: string, customerId: string, requestHash?: string) => {
        const row = keyRows.find((r) => r.key === key);
        if (row) {
          if (requestHash !== undefined && row.responseHash !== requestHash) {
            // Mirrors the REAL machine-readable body (B215/D4) so T3 can assert on it.
            throw new ConflictException({
              code: IDEMPOTENCY_KEY_CONFLICT,
              reason: "CART_MISMATCH",
              orderId: row.orderId,
              message: "Idempotency-Key reused with a different cart",
            });
          }
          // B215/R1 (round 2): a table hit with a MATCHED fingerprint is VERIFIED.
          return { orderId: row.orderId, verified: requestHash !== undefined };
        }
        // Column hits carry no fingerprint — never verified.
        return order.idempotencyKey === key && order.customerId === customerId
          ? { orderId: order.id, verified: false }
          : null;
      },
    ),
    // B215: the controller re-runs the convergent post-fold tail on every replay.
    replayMergeReconcile: jest.fn().mockResolvedValue(undefined),
    // Fold stand-in; records the key only when the caller hands it in (the fixed controller does).
    updateOrderItems: jest.fn(
      async (
        _id: string,
        _dto: unknown,
        _user: unknown,
        o?: { idempotency?: { key: string; responseHash: string } },
      ) => {
        folds += 1;
        order.total += 12;
        if (o?.idempotency) {
          keyRows.push({
            key: o.idempotency.key,
            orderId: order.id,
            responseHash: o.idempotency.responseHash,
          });
        }
        if (opts.throwAfterFirstFold && folds === 1) {
          throw new Error("reconcileOrderDraftInvoice failed after commit");
        }
      },
    ),
    // Today's real semantics: first key wins on the Order column.
    recordIdempotencyKey: jest.fn(async (_id: string, key: string) => {
      if (order.idempotencyKey == null) order.idempotencyKey = key;
    }),
    mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
    findOne: jest.fn(async () => ({ id: order.id, total: order.total })),
  };
  return { svc, order, keyRows };
}

/**
 * The DRAFT-order updateOrderItems fixture shared by T4/T5/T10/P4 — an exact
 * copy of the R10 setup (orders.scan-hardening.spec.ts ~596-637): one
 * existing PENDING line, product "prod-B" resolvable on both read shapes.
 * Returns the DTO the fold call should pass.
 */
function seedDraftOrderForFold(prisma: ReturnType<typeof createMockPrisma>) {
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
  return { items: [{ productId: "prod-B", qty: 1 }], replaceAll: true } as any;
}

// ─── T1-T3 — controller merge branch (fake OrdersService) ──────────────────

describe("OrdersController.create — staff merge same-key retry (REG-B215 T1-T3)", () => {
  it("REG-B215 T1: a same-key retry onto an order that already carries a key folds once, not twice", async () => {
    const { svc } = statefulOrdersService({ orderKey: "K0-created" });
    const controller = buildController(svc);
    await controller.create(mergeDto(), operatorPayload as any, "idem-K1");
    await controller.create(mergeDto(), operatorPayload as any, "idem-K1");
    expect(svc.updateOrderItems).toHaveBeenCalledTimes(1);
  });

  it("REG-B215 T2: a retry after the fold committed but a later step threw folds once", async () => {
    const { svc, order } = statefulOrdersService({ orderKey: null, throwAfterFirstFold: true });
    const controller = buildController(svc);
    await controller.create(mergeDto(), operatorPayload as any, "idem-K2").catch(() => undefined);
    const replayed = await controller.create(mergeDto(), operatorPayload as any, "idem-K2");
    expect(svc.updateOrderItems).toHaveBeenCalledTimes(1);
    // T2b (D1): the fold ran once, so the replay must re-run the CONVERGENT tail it may have
    // skipped — exactly once, on the same order, still inside the lock. Without this the
    // order's linked invoice and applied credits stay out of sync forever.
    expect(replayed).toEqual(expect.objectContaining({ id: order.id }));
    expect(svc.replayMergeReconcile).toHaveBeenCalledTimes(1);
    expect(svc.replayMergeReconcile).toHaveBeenCalledWith(order.id, "cust-1", undefined);
  });

  it("REG-B215 T3: the same key with a different cart is refused, never folded", async () => {
    const { svc, order } = statefulOrdersService({ orderKey: "K0-created" });
    const controller = buildController(svc);
    await controller.create(mergeDto(5), operatorPayload as any, "idem-K3");
    const err = await controller
      .create(mergeDto(7), operatorPayload as any, "idem-K3")
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    // D4: the body is machine-readable — the mobile client cannot mint a new key without
    // abandoning the cart, so it branches on `code` and navigates to `orderId`.
    expect((err as ConflictException).getResponse()).toEqual(
      expect.objectContaining({
        code: IDEMPOTENCY_KEY_CONFLICT,
        reason: "CART_MISMATCH",
        orderId: order.id,
      }),
    );
  });
});

// ─── T11 — mergeRequestHash: order-insensitive, cart-sensitive (unit) ──────

describe("mergeRequestHash (REG-B215 T11)", () => {
  it("REG-B215 T11: mergeRequestHash is item-order-insensitive and cart-sensitive", () => {
    const a = mergeRequestHash({
      customerId: "cust-1",
      items: [
        { productId: "p1", qty: 5 },
        { productId: "p2", qty: 1 },
      ],
    });
    const reversed = mergeRequestHash({
      customerId: "cust-1",
      items: [
        { productId: "p2", qty: 1 },
        { productId: "p1", qty: 5 },
      ],
    });
    expect(a).toBe(reversed);

    const changedQty = mergeRequestHash({
      customerId: "cust-1",
      items: [
        { productId: "p1", qty: 7 },
        { productId: "p2", qty: 1 },
      ],
    });
    expect(changedQty).not.toBe(a);

    const undefinedCredits = mergeRequestHash({
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 5 }],
      appliedCreditNotes: undefined,
    });
    const nullCredits = mergeRequestHash({
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 5 }],
      appliedCreditNotes: null,
    });
    expect(undefinedCredits).toBe(nullCredits);
  });

  it("REG-B215 T11b: mergeRequestHash is credit-note-ORDER-insensitive and credit-set-sensitive", () => {
    // D5: `appliedCreditNotes` is a SET on the wire — the client sends whatever order its
    // selection UI holds — so an order-sensitive fingerprint refused an honest retry of the
    // identical cart with a cart-mismatch 409.
    const base = { customerId: "cust-1", items: [{ productId: "p1", qty: 5 }] };
    const ab = mergeRequestHash({
      ...base,
      appliedCreditNotes: [{ creditNoteId: "cn-a" }, { creditNoteId: "cn-b" }],
    });
    const ba = mergeRequestHash({
      ...base,
      appliedCreditNotes: [{ creditNoteId: "cn-b" }, { creditNoteId: "cn-a" }],
    });
    expect(ab).toBe(ba);

    const differentSet = mergeRequestHash({
      ...base,
      appliedCreditNotes: [{ creditNoteId: "cn-a" }, { creditNoteId: "cn-c" }],
    });
    expect(differentSet).not.toBe(ab);

    const subset = mergeRequestHash({ ...base, appliedCreditNotes: [{ creditNoteId: "cn-a" }] });
    expect(subset).not.toBe(ab);
  });
});

// ─── T2b — the replay re-runs the convergent tail (real OrdersService) ─────

describe("OrdersService.replayMergeReconcile — the convergent post-fold tail (REG-B215 T2b)", () => {
  it("REG-B215 T2b: a replay re-runs the invoice reconcile + credit sync/settle, and appends NO revision", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    const invoices = (service as any).invoicesService;
    const credits = (service as any).creditNotes;
    // A PENDING order (the branch every staff merge takes) owned by this customer.
    prisma.order.findFirst.mockResolvedValue({ status: "PENDING" });

    await service.replayMergeReconcile("ord-1", "cust-1", [{ creditNoteId: "cn-1" } as any]);

    expect(invoices.reconcileOrderDraftInvoice).toHaveBeenCalledTimes(1);
    expect(invoices.reconcileOrderDraftInvoice).toHaveBeenCalledWith("ord-1", { basis: "order" });
    // An UNDELIVERED order takes the draft-reconcile branch, so the post-delivery in-place
    // resync never runs here (T2d/T2e cover the post-delivery routing).
    expect(invoices.resyncOrderInvoicesForEdit).not.toHaveBeenCalled();
    expect(credits.syncOrderCreditSelections).toHaveBeenCalledTimes(1);
    expect(credits.settleOrderCreditsInTx).toHaveBeenCalledTimes(1);
    // The revision snapshot is append-only, not convergent — it must stay fold-only.
    expect((prisma as any).orderRevision.create).not.toHaveBeenCalled();
  });

  it("REG-B215 T2b (pin): a tenant-less session cannot replay-reconcile", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    (prisma.getTenantId as unknown as jest.Mock).mockReturnValue(null);

    await expect(service.replayMergeReconcile("ord-1", "cust-1", undefined)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.order.findFirst).not.toHaveBeenCalled();
  });
});

// ─── Pins P1-P2 — controller merge branch, colour today/after: GREEN/GREEN ─

describe("OrdersController.create — B215 pins P1-P2", () => {
  it("B215 pin P1: a merge with no Idempotency-Key calls updateOrderItems with exactly three arguments", async () => {
    const { svc } = statefulOrdersService({ orderKey: null });
    const controller = buildController(svc);
    await controller.create(mergeDto(), operatorPayload as any);
    expect(svc.updateOrderItems.mock.calls[0]).toHaveLength(3);
  });

  it("B215 pin P2: a key that sits only on the Order column (create()'s key) still replays a merge", async () => {
    const { svc } = statefulOrdersService({ orderKey: "K0-created" });
    const controller = buildController(svc);
    await controller.create(mergeDto(), operatorPayload as any, "K0-created");
    expect(svc.updateOrderItems).toHaveBeenCalledTimes(0);
  });
});

// ─── T4-T5, T10, P4 — updateOrderItems' in-tx key write (real OrdersService) ─

describe("OrdersService.updateOrderItems — merge idempotency key write (REG-B215 T4/T5/T10, pin P4)", () => {
  it("REG-B215 T4: updateOrderItems with an idempotency option writes exactly one key row", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    const dto = seedDraftOrderForFold(prisma);

    await (service as any).updateOrderItems("ord-1", dto, operatorPayload, {
      idempotency: { key: "K1", responseHash: "h1" },
    });

    expect(
      (prisma as any).orderIdempotencyKey.create.mock.calls.map((c: any) => c[0].data),
    ).toEqual([{ tenantId: "test-tenant", key: "K1", orderId: "ord-1", responseHash: "h1" }]);
  });

  it("REG-B215 T5: the key row is written inside the fold's own transaction", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    const dto = seedDraftOrderForFold(prisma);

    const txCreate = jest.fn().mockResolvedValue({});
    (prisma as any).tenantTransaction.mockImplementation(async (fn: any) => {
      return await fn({
        ...prisma,
        orderIdempotencyKey: { ...(prisma as any).orderIdempotencyKey, create: txCreate },
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest.fn().mockResolvedValue([]),
      });
    });

    await (service as any).updateOrderItems("ord-1", dto, operatorPayload, {
      idempotency: { key: "K1", responseHash: "h1" },
    });

    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(txCreate.mock.calls[0][0].data).toMatchObject({
      key: "K1",
      orderId: "ord-1",
      responseHash: "h1",
    });
    expect((prisma as any).orderIdempotencyKey.create).not.toHaveBeenCalled();
  });

  it("REG-B215 T10: a key that is already taken aborts the fold with 409", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    const dto = seedDraftOrderForFold(prisma);
    (prisma as any).orderIdempotencyKey.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      await expect(
        (service as any).updateOrderItems("ord-1", dto, operatorPayload, {
          idempotency: { key: "K1", responseHash: "h1" },
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("K1"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("REG-B215 T14: a tenant-less session cannot record a merge key", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    const dto = seedDraftOrderForFold(prisma);
    (prisma as any).getTenantId.mockReturnValue(null);

    await expect(
      (service as any).updateOrderItems("ord-1", dto, operatorPayload, {
        idempotency: { key: "K1", responseHash: "h1" },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((prisma as any).orderIdempotencyKey.create).not.toHaveBeenCalled();
  });

  it("REG-B215 T15: a non-P2002 failure on the key insert propagates unchanged", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    const dto = seedDraftOrderForFold(prisma);
    (prisma as any).orderIdempotencyKey.create.mockRejectedValue(new Error("connection reset"));

    const error = await (service as any)
      .updateOrderItems("ord-1", dto, operatorPayload, {
        idempotency: { key: "K1", responseHash: "h1" },
      })
      .catch((e: any) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("connection reset");
    expect(error).not.toBeInstanceOf(ConflictException);
  });

  it("B215 pin P4: updateOrderItems without the option writes no key row", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    const dto = seedDraftOrderForFold(prisma);

    await service.updateOrderItems("ord-1", dto, operatorPayload);

    expect((prisma as any).orderIdempotencyKey.create).not.toHaveBeenCalled();
  });
});

// ─── T6-T7 — consolidation sweeps re-point a loser's key onto the winner ───

describe("OrdersService consolidation — a loser's merge key follows it onto the winner (REG-B215 T6/T7)", () => {
  function seedMergeMocks(prisma: ReturnType<typeof createMockPrisma>) {
    prisma.order.findMany.mockResolvedValue([
      { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [] },
      { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [] },
    ] as any);
  }

  function seedKeyStoreWithFkCascade(prisma: ReturnType<typeof createMockPrisma>) {
    const rows = [{ key: "K1", orderId: "l1" }];
    prisma.order.delete.mockImplementation(async ({ where }: any) => {
      // ON DELETE CASCADE on OrderIdempotencyKey.orderId (the migration's FK).
      for (let i = rows.length - 1; i >= 0; i--)
        if (rows[i].orderId === where.id) rows.splice(i, 1);
      return {} as any;
    });
    (prisma as any).orderIdempotencyKey.updateMany.mockImplementation(
      async ({ where, data }: any) => {
        let count = 0;
        for (const r of rows) {
          if (r.orderId === where.orderId) {
            r.orderId = data.orderId;
            count++;
          }
        }
        return { count };
      },
    );
    return rows;
  }

  it("REG-B215 T6: a consolidation sweep moves a loser's merge key onto the winner", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    seedMergeMocks(prisma);
    const rows = seedKeyStoreWithFkCascade(prisma);

    await service.mergeAllPendingForCustomer("cust-1");

    expect(rows.find((r) => r.key === "K1")?.orderId).toBe("w1");
  });

  it("REG-B215 T7: forceConsolidateCustomer moves a loser's merge key onto the winner", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    seedMergeMocks(prisma);
    const rows = seedKeyStoreWithFkCascade(prisma);

    await service.forceConsolidateCustomer("cust-1");

    expect(rows.find((r) => r.key === "K1")?.orderId).toBe("w1");
  });
});

// ─── T16 — create()'s own replay consults the key table (real OrdersService) ─

describe("OrdersService.create — key-table replay (REG-B215 T16)", () => {
  it("REG-B215 T16: a key present only in the key table makes create() return the existing order", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      user: { status: "ACTIVE" },
    } as any);
    // D6: the fold writes a merge wave's key ONLY to the table, and such a request can still
    // fall through to create() (its merge target vanished before the advisory lock). A
    // column-only lookup missed the replay and minted a duplicate order.
    (prisma as any).orderIdempotencyKey.findFirst.mockResolvedValue({ orderId: "ord-keyed" });
    prisma.order.findFirst.mockResolvedValue({
      id: "ord-keyed",
      customerId: "cust-1",
      lineItems: [{ productId: "p1", qty: 5, status: "PENDING" }],
    } as any);

    const result = await service.create(
      {
        customerId: "cust-1",
        items: [{ productId: "p1", qty: 5 }],
        idempotencyKey: "K-table-only",
      } as any,
      operatorPayload as any,
    );

    expect((result as any).id).toBe("ord-keyed");
    // The lookup was BY ID (the table's orderId), not by the Order column.
    expect(prisma.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ord-keyed" } }),
    );
    expect(prisma.order.create).not.toHaveBeenCalled();
  });
});

// ─── T8-T9, P3 — the merge replay lookup (real OrdersService) ─────────────

describe("OrdersService.findOrderIdByIdempotencyKey — table-first replay (REG-B215 T8/T9, pin P3)", () => {
  it("REG-B215 T8: the merge replay lookup reads the per-request key table", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    (prisma as any).orderIdempotencyKey.findFirst.mockResolvedValue({
      orderId: "ord-1",
      responseHash: "h1",
    });
    prisma.order.findFirst.mockResolvedValue(null);

    const result = await (service as any).findOrderIdByIdempotencyKey("K1", "cust-1", "h1");

    // B215/R1 (round 2): a matched table hit is VERIFIED — the retry's body is provably the cart
    // the fold applied, so the controller may re-apply its credit selection.
    expect(result).toEqual({ orderId: "ord-1", verified: true });
  });

  it("REG-B215 T9: a key-table hit with a different request fingerprint is refused", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    (prisma as any).orderIdempotencyKey.findFirst.mockResolvedValue({
      orderId: "ord-1",
      responseHash: "h1",
    });
    prisma.order.findFirst.mockResolvedValue(null);

    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const err = await (service as any)
        .findOrderIdByIdempotencyKey("K1", "cust-1", "h-other")
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      // D4: machine-readable body carrying the order that HOLDS the key, so the client can
      // offer "Open order" instead of wedging on a bare message.
      expect((err as ConflictException).getResponse()).toEqual(
        expect.objectContaining({
          code: IDEMPOTENCY_KEY_CONFLICT,
          reason: "CART_MISMATCH",
          orderId: "ord-1",
        }),
      );
      // The advice no longer tells the operator to mint a new key — no client can.
      expect(String((err as any).getResponse().message)).not.toContain("new key");
      // The 409 is intentionally below the Sentry filter's 500 threshold, so the warn line is
      // the only server-side trace of which key/customer/order the guard refused.
      expect(warn.mock.calls.some((c) => String(c[0]).includes("K1"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("REG-B215 T12: a tenant-less session is refused before any replay lookup", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    // forTenant() hands back the UNSCOPED client for such a caller, so neither lookup may run.
    (prisma.getTenantId as unknown as jest.Mock).mockReturnValue(null);

    await expect(
      (service as any).findOrderIdByIdempotencyKey("K1", "cust-1", "h1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((prisma as any).orderIdempotencyKey.findFirst).not.toHaveBeenCalled();
    expect(prisma.order.findFirst).not.toHaveBeenCalled();
  });

  it("REG-B215 T13: a key held by another customer is refused before any invoice revert or fold", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    // Customer-scoped lookup (where.order present) misses; the bare tenant-scoped one hits.
    (prisma as any).orderIdempotencyKey.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(where.order ? null : { orderId: "ord-other" }),
    );
    // D3: the customer-scoped Order column is now consulted BEFORE the tenant-wide table, and
    // misses here — this key is on nobody's column.
    prisma.order.findFirst.mockResolvedValue(null);

    const err = await (service as any)
      .findOrderIdByIdempotencyKey("K1", "cust-1", "h1")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toEqual(
      expect.objectContaining({
        code: IDEMPOTENCY_KEY_CONFLICT,
        reason: "HELD_BY_OTHER_ORDER",
        orderId: "ord-other",
      }),
    );
    // The refusal still lands before the controller can enter updateOrderItems, whose
    // revertLinkedInvoicesForOrderEdit commits outside the fold transaction — the only reads
    // that ran were the two replay lookups, neither of which writes.
    expect((prisma as any).order.update).not.toHaveBeenCalled();
    expect((prisma as any).order.updateMany).not.toHaveBeenCalled();
  });

  it("REG-B215 T17: this customer's own column key replays even while another customer holds a key-table row", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    // No key-table row for THIS customer; a row for someone else's order exists tenant-wide.
    (prisma as any).orderIdempotencyKey.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(where.order ? null : { orderId: "ord-other" }),
    );
    // The key DOES sit on this customer's own Order column (create()'s stamp).
    prisma.order.findFirst.mockResolvedValue({ id: "ord-mine" });

    // D3: before the reorder, the tenant-wide `heldByAnotherOrder` check ran first and turned
    // this legitimate replay into a permanent 409.
    const result = await (service as any).findOrderIdByIdempotencyKey("K1", "cust-1", "h1");

    // Column hit → UNVERIFIED (the column stores no fingerprint).
    expect(result).toEqual({ orderId: "ord-mine", verified: false });
  });

  it("B215 pin P5: a column-only key hit replays even when the request hash differs", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    (prisma as any).orderIdempotencyKey.findFirst.mockResolvedValue(null);
    prisma.order.findFirst.mockResolvedValue({ id: "ord-col" });

    // The Order column stores no fingerprint and its main producer is the create -> retry
    // path, so a column-only hit stays replay-eligible; only the key TABLE refuses on a
    // mismatch. Guarding this behaviour against a future "compare the hash here too" change.
    const result = await (service as any).findOrderIdByIdempotencyKey("K0", "cust-1", "h-other");

    expect(result).toEqual({ orderId: "ord-col", verified: false });
  });

  it("B215 pin P3: with no key-table row the lookup falls back to the Order column", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    prisma.order.findFirst.mockResolvedValue({ id: "ord-1" });

    const result = await service.findOrderIdByIdempotencyKey("K0", "cust-1");

    expect(result).toEqual({ orderId: "ord-1", verified: false });
  });
});

// --- Round 2 (Opus refute-first review of cfb3c331) — R1/R2/R4 pins --------

describe("OrdersController.create — a replay applies the retry's credits only when VERIFIED (REG-B215 T2c)", () => {
  it("REG-B215 T2c: a COLUMN-path replay never forwards the retry body's appliedCreditNotes", async () => {
    const { svc, order } = statefulOrdersService({ orderKey: "K0-created" });
    const controller = buildController(svc);
    // The key sits on the Order column only (create()'s stamp), which stores NO fingerprint —
    // so this body is not provably the cart the fold applied. Its credit selection must not be
    // pushed onto that order: `undefined` means "settle only, leave the stored selection alone".
    const dto = { ...mergeDto(), appliedCreditNotes: [{ creditNoteId: "cn-retry" }] } as any;

    await controller.create(dto, operatorPayload as any, "K0-created");

    expect(svc.updateOrderItems).not.toHaveBeenCalled();
    expect(svc.replayMergeReconcile).toHaveBeenCalledTimes(1);
    expect(svc.replayMergeReconcile).toHaveBeenCalledWith(order.id, "cust-1", undefined);
  });

  it("REG-B215 T2c (positive control): a VERIFIED table hit forwards the body's selection", async () => {
    const { svc, order } = statefulOrdersService({ orderKey: null });
    const controller = buildController(svc);
    const dto = { ...mergeDto(), appliedCreditNotes: [{ creditNoteId: "cn-1" }] } as any;
    // First call folds and records the key row WITH this body's fingerprint; the identical retry
    // is a verified table hit, so the same selection is safe to re-apply.
    await controller.create(dto, operatorPayload as any, "K-verified");
    await controller.create(dto, operatorPayload as any, "K-verified");

    expect(svc.updateOrderItems).toHaveBeenCalledTimes(1);
    expect(svc.replayMergeReconcile).toHaveBeenCalledTimes(1);
    expect(svc.replayMergeReconcile).toHaveBeenCalledWith(order.id, "cust-1", [
      { creditNoteId: "cn-1" },
    ]);
  });

  it("REG-B215 T2c (service half): appliedCreditNotes=undefined settles WITHOUT syncing the selection", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    const invoices = (service as any).invoicesService;
    const credits = (service as any).creditNotes;
    prisma.order.findFirst.mockResolvedValue({ status: "PENDING", lineItems: [] } as any);

    await service.replayMergeReconcile("ord-1", "cust-1", undefined);

    expect(credits.syncOrderCreditSelections).not.toHaveBeenCalled();
    expect(credits.settleOrderCreditsInTx).toHaveBeenCalledTimes(1);
    expect(invoices.reconcileOrderDraftInvoice).toHaveBeenCalledTimes(1);
  });
});

describe("OrdersService.replayMergeReconcile — post-delivery replay reconciles or refuses (REG-B215 T2d/T2e)", () => {
  it("REG-B215 T2d: a post-delivery replay whose current lines allow the resync RE-SYNCS in place", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    const invoices = (service as any).invoicesService;
    // OUT_FOR_DELIVERY, every billable line fully invoiced — the fold's own guard says "resync".
    prisma.order.findFirst.mockResolvedValue({
      status: "OUT_FOR_DELIVERY",
      lineItems: [
        { qty: 5, invoicedQty: 5 },
        { qty: 2, invoicedQty: 2 },
      ],
    } as any);

    await service.replayMergeReconcile("ord-1", "cust-1", undefined);

    // Round 1 skipped this unconditionally, leaving the dispatched order's finalized invoice
    // permanently out of step with the merged lines.
    expect(invoices.resyncOrderInvoicesForEdit).toHaveBeenCalledTimes(1);
    expect(invoices.resyncOrderInvoicesForEdit).toHaveBeenCalledWith("ord-1");
    expect(invoices.reconcileOrderDraftInvoice).not.toHaveBeenCalled();
  });

  it("REG-B215 T2d (partial): a post-delivery replay whose lines are PARTIALLY invoiced skips the resync and still settles", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    const invoices = (service as any).invoicesService;
    const credits = (service as any).creditNotes;
    prisma.order.findFirst.mockResolvedValue({
      status: "DELIVERED",
      lineItems: [
        { qty: 5, invoicedQty: 2 },
        { qty: 2, invoicedQty: 0 },
      ],
    } as any);

    await service.replayMergeReconcile("ord-1", "cust-1", undefined);

    // Same routing the fold would have taken: an in-place resync would expand an already-issued
    // invoice to units it never billed.
    expect(invoices.resyncOrderInvoicesForEdit).not.toHaveBeenCalled();
    expect(credits.settleOrderCreditsInTx).toHaveBeenCalledTimes(1);
  });

  it("REG-B215 T2e: a post-delivery replay whose guard cannot be reproduced refuses with 409 and writes nothing", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    const invoices = (service as any).invoicesService;
    const credits = (service as any).creditNotes;
    // The replace-all fold reset invoicedQty to 0 on every recreated row, yet a non-VOID invoice
    // still exists — partial vs wholly invoiced is now unknowable, and BOTH branches are unsafe.
    prisma.order.findFirst.mockResolvedValue({
      status: "OUT_FOR_DELIVERY",
      lineItems: [
        { qty: 5, invoicedQty: 0 },
        { qty: 2, invoicedQty: 0 },
      ],
    } as any);
    (prisma as any).invoice.count.mockResolvedValue(1);

    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const err = await service
        .replayMergeReconcile("ord-1", "cust-1", [{ creditNoteId: "cn-1" } as any])
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toEqual(
        expect.objectContaining({
          code: IDEMPOTENCY_REPLAY_NEEDS_RECONCILE,
          orderId: "ord-1",
        }),
      );
      // Refuses LOUDLY: the warn line is the only server-side trace of a 409 below Sentry's
      // 500 threshold.
      expect(warn.mock.calls.some((c) => String(c[0]).includes("ord-1"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
    // No invoice call, no revision, no credit write.
    expect(invoices.resyncOrderInvoicesForEdit).not.toHaveBeenCalled();
    expect(invoices.reconcileOrderDraftInvoice).not.toHaveBeenCalled();
    expect(credits.syncOrderCreditSelections).not.toHaveBeenCalled();
    expect(credits.settleOrderCreditsInTx).not.toHaveBeenCalled();
    expect((prisma as any).orderRevision.create).not.toHaveBeenCalled();
  });

  it("REG-B215 T2e (control): nothing invoiced and NO invoice on the order routes the resync as a proven no-op", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    const invoices = (service as any).invoicesService;
    prisma.order.findFirst.mockResolvedValue({
      status: "DELIVERED",
      lineItems: [{ qty: 5, invoicedQty: 0 }],
    } as any);
    (prisma as any).invoice.count.mockResolvedValue(0);

    await service.replayMergeReconcile("ord-1", "cust-1", undefined);

    // `resyncOrderInvoicesForEdit` returns null when the order has no non-VOID invoice, and the
    // fold's guard would also have been false — so routing it is faithful, not a refusal case.
    expect(invoices.resyncOrderInvoicesForEdit).toHaveBeenCalledTimes(1);
  });
});

describe("OrdersService.create — the caller's OWN row wins the replay lookup (REG-B215 T18)", () => {
  it("REG-B215 T18: a key-table row for another customer never beats this customer's column-stamped order", async () => {
    const prisma = createMockPrisma();
    const gateway = mockGateway();
    const service = await buildOrdersService(prisma, gateway);
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      user: { status: "ACTIVE" },
    } as any);
    // Tenant-wide the key is held by SOMEONE ELSE's order; this customer has no key-table row.
    (prisma as any).orderIdempotencyKey.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(where.order ? null : { orderId: "ord-other" }),
    );
    // But the key IS stamped on this customer's own order column.
    const mine = {
      id: "ord-mine",
      customerId: "cust-1",
      lineItems: [{ productId: "p1", qty: 5, status: "PENDING" }],
    };
    prisma.order.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where?.idempotencyKey || where?.id === "ord-mine" ? ({ ...mine } as any) : null,
      ),
    );

    const result = await service.create(
      {
        customerId: "cust-1",
        items: [{ productId: "p1", qty: 5 }],
        idempotencyKey: "K-mine",
      } as any,
      operatorPayload as any,
    );

    // Before R4 the tenant-wide table row was fetched first and the ownership gate turned this
    // legitimate replay into a permanent 409.
    expect((result as any).id).toBe("ord-mine");
    expect(prisma.order.create).not.toHaveBeenCalled();
  });
});
