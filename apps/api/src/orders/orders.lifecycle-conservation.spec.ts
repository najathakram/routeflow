/**
 * F07 — order lifecycle, stock conservation and teardown (TP-API).
 *
 * Proves T1-T3, T6, T8, T10-T13, T15, T16, T19, T20 from
 * `.claude/pipeline/2026-09-01-f07-order-lifecycle/{spec,test-plan,build-plan}.md`:
 * REG-B56 (cancel voids invoices for delivered goods but never blocks the
 * cancel itself), REG-B64 (cancel never returns the creation-time stock
 * reservation, and reopen never re-takes it), REG-B65 (deleteOrder skips the
 * regulated-ledger reversal every sibling teardown path already performs),
 * REG-B105 (the DELIVERED auto-invoice is fire-and-forget — its failure is
 * silently swallowed and the caller is never told), REG-B108 (the
 * post-delivery credit settle is a single best-effort attempt wearing a
 * comment that claims a catch-up that doesn't exist yet), REG-B116 (create()'s
 * stock decrement is a per-line loop inside an unbounded transaction instead
 * of one aggregated, timeout-bounded statement). T5 (mobile),
 * T17/T18 (invoices.send-settle.spec.ts) and T21/T22 (existing suite /
 * post-deploy e2e) are proven elsewhere — not part of this file.
 *
 * RED BY DESIGN — THIS FILE IS THE RED GATE: none of B56/B64/B65/B105/B108/B116
 * are implemented on `orders.service.ts` yet, and EVERY `it()` below fails on an
 * ASSERTION against today's tree. `deliveredUnits` is read via `as any` because
 * the field doesn't exist on `cancelImpact`'s return type yet,
 * `RegulatedLedgerService` is registered as a provider `OrdersService` does not
 * yet consume, and `tenantTransaction`'s captured options/executeRaw calls
 * describe behavior `create()` does not yet exhibit.
 *
 * The four GUARD tests that are already green pre-fix (T4, T7, T9, T14 — they
 * prove the fix must NOT regress an adjacent behavior) live in the sibling
 * `orders.lifecycle-conservation.pins.spec.ts` so that this file's gate command
 * reads "0 passed". They are run by the normal `src/orders` suite, never by the
 * red gate.
 *
 * No test here spies on a private method: the cancel-path fixtures prime
 * `assertCancellableOrThrow`'s own reads (order.findFirst / invoice.findMany /
 * previewOrderCreditRelease) so the guard passes naturally, and renaming or
 * inlining it cannot silently disarm a proof.
 *
 * Harness copied from `orders.update-items-guards.spec.ts`: mocked
 * PrismaService via `createMockPrisma()` (its default `tenantTransaction`
 * spreads the SAME model mocks into `tx`, so `prisma.product.update` etc.
 * observe transaction-internal calls too), `InvoicesService`/
 * `NotificationsService` `jest.mock()`'d at the module boundary (ESM guard),
 * and every other collaborator as a `useValue` mock. `RegulatedLedgerService`
 * is added as a provider for T10 even though `OrdersService`'s constructor
 * does not request it yet — Nest instantiates unused providers without
 * complaint, so `module.get(RegulatedLedgerService)` hands back the mock and
 * its zero-calls state on today's tree IS the red signal.
 *
 * Call-order oracles (T6, T10) push into one shared `const calls: string[] =
 * []` per test from each relevant mock, then assert via `indexOf`.
 */

// Mock InvoicesService before it's imported — prevents Jest from traversing
// invoice-pdf.service.ts which imports @react-pdf/renderer (ESM-only module).
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    createInvoiceFromOrderWithTenant: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
    findOpenOrderDraft: jest.fn().mockResolvedValue(null),
    reconcileOrderDraftInvoice: jest.fn().mockResolvedValue({ id: "inv-1" }),
    releaseWalletPaymentsInTx: jest.fn().mockResolvedValue({ credits: [], advances: 0 }),
    voidInvoiceInTx: jest.fn().mockResolvedValue({ id: "inv-1", status: "VOID" }),
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
import { BadRequestException, ConflictException } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";

import { OrdersService } from "./orders.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
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

const MOCK_ORDER = {
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-123",
  status: "PENDING" as const,
  source: "APP" as const,
  urgent: false,
  subtotal: 0,
  tax: 0,
  total: 0,
  notes: null as string | null,
  driverNote: null,
  routeRunId: null as string | null,
  routeRunStopId: null as string | null,
  deliveredAt: null as Date | null,
  orderDate: null as Date | null,
  fulfillPath: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

describe("OrdersService — F07 lifecycle-conservation (TP-API)", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoicesService: {
    createInvoiceFromOrderWithTenant: jest.Mock;
    findOpenOrderDraft: jest.Mock;
    reconcileOrderDraftInvoice: jest.Mock;
    releaseWalletPaymentsInTx: jest.Mock;
    voidInvoiceInTx: jest.Mock;
  };
  let creditNotesService: {
    previewOrderCreditRelease: jest.Mock;
    releaseOrderCreditsInTx: jest.Mock;
    settleOrderCreditsInTx: jest.Mock;
  };
  let commissionEngineService: { removeInvoiceCommission: jest.Mock };
  let ledgerService: { reverseInvoiceEntries: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();

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
        {
          provide: InvoicesService,
          useValue: {
            createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
            createInvoiceFromOrder: jest
              .fn()
              .mockResolvedValue([{ id: "inv-1", invoiceNumber: "INV-1", total: 0 }]),
            createInvoiceFromOrderWithTenant: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
            send: jest.fn().mockResolvedValue({ id: "inv-1", status: "SENT" }),
            findOpenOrderDraft: jest.fn().mockResolvedValue(null),
            reconcileOrderDraftInvoice: jest.fn().mockResolvedValue({ id: "inv-1" }),
            resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
            revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue([]),
            voidInvoice: jest.fn().mockResolvedValue({ id: "inv-1", status: "VOID" }),
            voidInvoiceInTx: jest.fn().mockResolvedValue({ id: "inv-1", status: "VOID" }),
            releaseWalletPaymentsInTx: jest.fn().mockResolvedValue({ credits: [], advances: 0 }),
          },
        },
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
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
          useValue: { recordSale: jest.fn().mockResolvedValue({}) },
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
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(true) },
        },
        // B65: not yet wired into OrdersService's constructor — a registered-
        // but-unconsumed provider. Its zero-calls state on today's tree is T10's
        // red signal; the fix wires `private readonly ledger: RegulatedLedgerService`.
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
    invoicesService = module.get(InvoicesService);
    creditNotesService = module.get(CreditNotesService);
    commissionEngineService = module.get(CommissionEngineService);
    ledgerService = module.get(RegulatedLedgerService);
  });

  // ─── T1-T2 (REG-B56): cancelImpact surfaces delivered-goods as a blocker ───

  describe("cancelImpact — delivered goods block a cancel (T1-T2 / REG-B56)", () => {
    it("REG-B56 (T1): active lines with delivered units sum to deliveredUnits and canCancel is false", async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-1",
        status: "CONFIRMED",
        orderNumber: "ORD-1",
      });
      prisma.invoice.findMany.mockResolvedValue([]); // zero payments — no payment blocker
      prisma.orderItem.findMany.mockResolvedValue([
        { qty: 5, deliveredQty: 2 },
        { qty: 3, deliveredQty: 0 },
      ]);
      creditNotesService.previewOrderCreditRelease.mockResolvedValue([]);

      const impact = await service.cancelImpact("ord-1");

      // hand: the independent source of truth is the mocked line rows, summed
      // by hand: 2 + 0 = 2. `deliveredUnits` doesn't exist on today's return
      // shape at all (undefined), and canCancel ignores delivered goods
      // entirely (true whenever there are no payment blockers).
      expect((impact as any).deliveredUnits).toBe(2);
      expect(impact.canCancel).toBe(false);
    });

    it("REG-B56 (T2): zero delivered units across every active line keeps deliveredUnits at 0 and canCancel true — guards against an inverted gate", async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-1",
        status: "PENDING",
        orderNumber: "ORD-1",
      });
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.orderItem.findMany.mockResolvedValue([
        { qty: 5, deliveredQty: 0 },
        { qty: 3, deliveredQty: 0 },
      ]);
      creditNotesService.previewOrderCreditRelease.mockResolvedValue([]);

      const impact = await service.cancelImpact("ord-1");

      expect((impact as any).deliveredUnits).toBe(0);
      expect(impact.canCancel).toBe(true);
    });
  });

  // ─── T3-T4 (REG-B56): the changeStatus(CANCELLED) write gate ──────────────

  describe("changeStatus(CANCELLED) — the delivered-goods refusal precedes any write (T3-T4 / REG-B56)", () => {
    it("REG-B56 (T3): a PARTIALLY_DELIVERED order with a delivered line is refused before the status write", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PARTIALLY_DELIVERED",
      });
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-1",
        status: "PARTIALLY_DELIVERED",
        orderNumber: "ORD-1",
      });
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.orderItem.findMany.mockResolvedValue([{ qty: 2, deliveredQty: 2 }]);
      creditNotesService.previewOrderCreditRelease.mockResolvedValue([]);

      const attempt = service.changeStatus(
        "ord-1",
        { status: "CANCELLED" } as any,
        operatorPayload,
      );

      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      // spec: the message must point the operator at "record a return" / "edit
      // the order down" — a bare BadRequestException from some other guard
      // cannot satisfy R2.
      await expect(attempt).rejects.toThrow(/return/i);
      await expect(attempt).rejects.toThrow(/edit/i);
      // The refusal must precede the write — a rejected cancel leaves the
      // order exactly as it was, never cancelled-but-not-unwound.
      expect(prisma.order.update).not.toHaveBeenCalled();
    });
    // T4 (the payments-block message the delivered-goods branch must not
    // swallow) is green pre-fix — it lives in
    // `orders.lifecycle-conservation.pins.spec.ts`, outside this gate file.
  });

  // ─── T6-T7 (REG-B64): changeStatus(CANCELLED) returns the reservation ─────

  describe("changeStatus(CANCELLED) — the creation-time stock reservation is returned (T6-T7 / REG-B64)", () => {
    it("REG-B64 (T6): a CONFIRMED cancel credits back each line's undelivered quantity, AFTER voiding invoices and BEFORE flipping items CANCELLED", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "CONFIRMED" });
      // NO private-method spy: nothing is delivered on either line, so R2's
      // delivered-goods gate lets this cancel through on `cancelImpact`'s OWN
      // reads (order.findFirst / invoice.findMany / previewOrderCreditRelease,
      // all primed below). Renaming or inlining `assertCancellableOrThrow`
      // therefore cannot silently disarm this proof — and the fixture is a
      // scenario R2 actually permits, unlike a cancel with delivered units.
      // The `max(0, qty − deliveredQty)` CLAMP is proven where the gate leaves
      // it reachable: T8, on the reopen path.
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-1",
        status: "CONFIRMED",
        orderNumber: "ORD-1",
      });
      prisma.orderItem.findMany.mockResolvedValue([
        { id: "li-1", productId: "prod-1", qty: 5, deliveredQty: 0, status: "PENDING" },
        { id: "li-2", productId: "prod-2", qty: 3, deliveredQty: 0, status: "PENDING" },
      ]);
      // One live invoice, read by BOTH cancelImpact (empty `payments` → no
      // external-money blocker) and the cancel transaction (the row it voids).
      prisma.invoice.findMany.mockResolvedValue([
        { id: "inv-1", invoiceNumber: "INV-1", status: "SENT", total: 40, payments: [] },
      ]);
      creditNotesService.previewOrderCreditRelease.mockResolvedValue([]);

      const calls: string[] = [];
      invoicesService.voidInvoiceInTx.mockImplementation(async (_tx: any, invoiceId: string) => {
        calls.push("void");
        return { id: invoiceId, status: "VOID" };
      });
      prisma.orderItem.updateMany.mockImplementation((args: any) => {
        // Only the B64 CANCELLED-flip call names an explicit status:{not:CANCELLED}
        // filter alongside a CANCELLED write — distinguish it from any other
        // updateMany this flow might issue.
        if (args?.data?.status === "CANCELLED") calls.push("flip");
        return Promise.resolve({ count: 2 });
      });

      await service.changeStatus("ord-1", { status: "CANCELLED" } as any, operatorPayload);

      // hand: prod-1 held 5 undelivered units, prod-2 held 3 — a CONFIRMED
      // order decremented both at creation, so cancelling must put back exactly
      // what it took. Today nothing is credited back at all: the reservation is
      // silently destroyed with the order.
      expect(prisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "prod-1" },
          data: { currentStock: { increment: 5 } },
        }),
      );
      expect(prisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "prod-2" },
          data: { currentStock: { increment: 3 } },
        }),
      );
      // Both entries must EXIST before their order means anything: `indexOf`
      // returns -1 for an absent call, so a bare `flip > void` would also pass
      // on a tree where the invoice void never happened at all.
      expect(calls).toContain("void");
      expect(calls).toContain("flip");
      expect(calls.indexOf("flip")).toBeGreaterThan(calls.indexOf("void"));
    });
    // T7 (a DRAFT cancel credits nothing — it never held a reservation) is
    // green pre-fix and vacuous until R4 lands; it lives in
    // `orders.lifecycle-conservation.pins.spec.ts`, outside this gate file.
  });

  // ─── T8-T9 (REG-B64): reopenOrder re-takes only what an F07 cancel gave back

  describe("reopenOrder — re-takes stock only for lines an F07 cancel actually credited (T8-T9 / REG-B64)", () => {
    it("REG-B64 (T8): reopening re-decrements the undelivered remainder of each item-CANCELLED line", async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-1",
        status: "CANCELLED",
        notes: null,
        lineItems: [],
      });
      prisma.invoice.findFirst.mockResolvedValue(null); // no PAID invoice blocks the reopen
      prisma.orderItem.findMany.mockResolvedValue([
        { id: "li-1", productId: "prod-1", qty: 4, deliveredQty: 1 },
      ]);

      await service.reopenOrder("ord-1");

      // hand: qty 4 held, 1 already delivered — the F07 cancel credited back
      // qty − deliveredQty = 3, so reopening re-takes exactly that 3, not the
      // full original 4.
      expect(prisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "prod-1" },
          data: { currentStock: { decrement: 3 } },
        }),
      );
    });
    // T9 (a pre-F07 cancel with no item-CANCELLED lines gets no reopen credit)
    // is green pre-fix and vacuous until R6 lands; it lives in
    // `orders.lifecycle-conservation.pins.spec.ts`, outside this gate file.
  });

  // ─── T10 (REG-B65): deleteOrder reverses the regulated ledger per invoice ──

  describe("deleteOrder — the regulated ledger is reversed for every invoice, before it is deleted (T10 / REG-B65)", () => {
    it("REG-B65 (T10): each invoice's ledger entries are reversed exactly once, before that invoice row is deleted", async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-1",
        status: "CANCELLED",
        invoices: [{ id: "inv-1" }, { id: "inv-2" }],
        transaction: null,
      });
      prisma.return.count.mockResolvedValue(0);
      // cancelImpact's own reads (deleteOrder calls it directly for the
      // blocking-payments check — not through assertCancellableOrThrow).
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-1",
        status: "CANCELLED",
        orderNumber: "ORD-1",
      });
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.orderItem.findMany.mockResolvedValue([]);
      creditNotesService.previewOrderCreditRelease.mockResolvedValue([]);

      const calls: string[] = [];
      ledgerService.reverseInvoiceEntries.mockImplementation(async ({ invoiceId }: any) => {
        calls.push(`ledger:${invoiceId}`);
      });
      prisma.invoice.delete.mockImplementation(async ({ where }: any) => {
        calls.push(`delete:${where.id}`);
        return { id: where.id };
      });

      await service.deleteOrder("ord-1");

      // Called once per invoice — not zero, not once for the whole order.
      expect(ledgerService.reverseInvoiceEntries).toHaveBeenCalledTimes(2);
      expect(ledgerService.reverseInvoiceEntries).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: "inv-1" }),
      );
      expect(ledgerService.reverseInvoiceEntries).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: "inv-2" }),
      );
      // Each invoice's reversal precedes ITS OWN delete — never merely
      // "somewhere before the last delete".
      expect(calls.indexOf("ledger:inv-1")).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf("ledger:inv-1")).toBeLessThan(calls.indexOf("delete:inv-1"));
      expect(calls.indexOf("ledger:inv-2")).toBeLessThan(calls.indexOf("delete:inv-2"));
    });
  });

  // ─── T11-T14 (REG-B105): the DELIVERED auto-invoice is genuinely awaited ──

  describe("changeStatus(DELIVERED) — auto-invoice creation is awaited, not fired and forgotten (T11-T14 / REG-B105)", () => {
    function primeDelivered() {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "CONFIRMED" });
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "DELIVERED", total: 100 });
    }

    it("REG-B105 (T11): a transient ConflictException is retried until invoice creation succeeds, and changeStatus resolves", async () => {
      primeDelivered();
      invoicesService.findOpenOrderDraft.mockResolvedValue(null);
      invoicesService.createInvoiceFromOrderWithTenant
        .mockRejectedValueOnce(new ConflictException("order number race"))
        .mockResolvedValue([{ id: "inv-1" }]);

      await expect(
        service.changeStatus("ord-1", { status: "DELIVERED" } as any, operatorPayload),
      ).resolves.toBeDefined();

      // hand: one failed attempt + one retry that succeeds = 2 calls. Today's
      // fire-and-forget call fires the request exactly once and never
      // inspects the outcome, so no retry ever happens.
      expect(invoicesService.createInvoiceFromOrderWithTenant).toHaveBeenCalledTimes(2);
    });

    it("REG-B105 (T12): invoice creation failing on every attempt rejects changeStatus loudly — after the DELIVERED status is already persisted", async () => {
      primeDelivered();
      invoicesService.findOpenOrderDraft.mockResolvedValue(null);
      invoicesService.createInvoiceFromOrderWithTenant.mockRejectedValue(
        new ConflictException("no invoice numbers left"),
      );

      const attempt = service.changeStatus(
        "ord-1",
        { status: "DELIVERED" } as any,
        operatorPayload,
      );

      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      // The message must name the control that actually exists on the order
      // page — "Generate Invoice (full order)" (page.tsx:3425). An invented
      // label ("Create Invoice") sends the operator hunting for a button that
      // is not there, which is the same dead end R9 exists to close.
      await expect(attempt).rejects.toThrow(/Generate Invoice \(full order\)/);
      await expect(attempt).rejects.toThrow(/delivered/i);
      expect(invoicesService.createInvoiceFromOrderWithTenant).toHaveBeenCalledTimes(3);
      // The status write is NOT reverted just because billing failed — the
      // order stays DELIVERED and staff retries invoicing from the order page.
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "ord-1" },
          data: expect.objectContaining({ status: "DELIVERED" }),
        }),
      );
    });

    it("REG-B105 (T13): invoice creation is awaited before changeStatus returns — the fire-and-forget kill-shot", async () => {
      primeDelivered();
      invoicesService.findOpenOrderDraft.mockResolvedValue(null);
      let invoiceCreationSettled = false;
      invoicesService.createInvoiceFromOrderWithTenant.mockImplementation(
        () =>
          new Promise((resolve) => {
            // A macrotask (not a microtask): a genuinely-awaited call can only
            // resolve changeStatus's own promise AFTER this fires. Today's
            // `.catch()` never awaits it, so changeStatus returns while this
            // callback is still sitting on the macrotask queue.
            setTimeout(() => {
              invoiceCreationSettled = true;
              resolve([{ id: "inv-1" }]);
            }, 0);
          }),
      );

      await service.changeStatus("ord-1", { status: "DELIVERED" } as any, operatorPayload);

      expect(invoiceCreationSettled).toBe(true);
    });

    // T14 (an existing open draft still reconciles instead of creating a fresh
    // invoice) is green pre-fix — it lives in
    // `orders.lifecycle-conservation.pins.spec.ts`, outside this gate file.
  });

  // ─── T15-T16 (REG-B108): the post-delivery credit settle actually retries ──

  describe("changeStatus(DELIVERED) — the post-delivery credit settle retries transient contention (T15-T16 / REG-B108)", () => {
    function primeDelivered() {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "CONFIRMED" });
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "DELIVERED", total: 100 });
      invoicesService.findOpenOrderDraft.mockResolvedValue(null);
      invoicesService.createInvoiceFromOrderWithTenant.mockResolvedValue([{ id: "inv-1" }]);
    }

    it("REG-B108 (T15): two transient failures are retried and the third attempt's success is never logged as an error", async () => {
      primeDelivered();
      const errorSpy = jest
        .spyOn((service as any).logger, "error")
        .mockImplementation(() => undefined);

      // The counter lives on the SETTLE COLLABORATOR, not on `tenantTransaction`
      // — counting transactions would conflate this proof with any other tx the
      // DELIVERED path grows, and would read 3 even if something other than the
      // settle did the retrying. `tenantTransaction`'s default pass-through
      // propagates the rejection out of the tx exactly as Prisma would.
      let attempts = 0;
      creditNotesService.settleOrderCreditsInTx.mockImplementation(async () => {
        attempts++;
        if (attempts < 3) throw new Error("could not serialize access due to concurrent update");
        return { applied: 0, unapplied: 0 };
      });

      await service.changeStatus("ord-1", { status: "DELIVERED" } as any, operatorPayload);

      // hand: 2 failed attempts + 1 that succeeds = 3 settle invocations. Today
      // there is no retry loop at all — the FIRST contention error is swallowed
      // by the existing try/catch and never retried.
      expect(attempts).toBe(3);
      expect(creditNotesService.settleOrderCreditsInTx).toHaveBeenCalledTimes(3);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("REG-B108 (T16): a credit settle that never recovers still lets changeStatus resolve, but now logs an ERROR naming the order — not merely a warning", async () => {
      primeDelivered();
      const errorSpy = jest
        .spyOn((service as any).logger, "error")
        .mockImplementation(() => undefined);
      // Only the settle fails — every other transaction on this path still
      // commits, so an error logged by anything else cannot satisfy R11.
      creditNotesService.settleOrderCreditsInTx.mockRejectedValue(
        new Error("could not serialize access due to concurrent update"),
      );

      await expect(
        service.changeStatus("ord-1", { status: "DELIVERED" } as any, operatorPayload),
      ).resolves.toBeDefined();

      // R11: the give-up log is at `error` level, names the credit settle, and
      // carries the order id so an operator can find the order that needs a
      // manual credit application.
      const creditErrors = errorSpy.mock.calls.filter(
        ([msg]) => /credit/i.test(String(msg)) && String(msg).includes("ord-1"),
      );
      expect(creditErrors).toHaveLength(1);
    });
  });

  // ─── T19-T20 (REG-B116): create()'s stock decrement is bounded + aggregated

  describe("create() — the stock transaction is timeout-bounded and its decrement is one aggregated statement (T19-T20 / REG-B116)", () => {
    const PRODUCTS = [
      { id: "prod-1", name: "Widget A", pricePerUnit: 10, unitsPerBox: 0, currentStock: 1000 },
      { id: "prod-2", name: "Widget B", pricePerUnit: 10, unitsPerBox: 0, currentStock: 1000 },
    ];

    /**
     * A `Prisma.Sql` — what `Prisma.sql` / `Prisma.join` produce. Values
     * interpolated into a tagged template arrive as these, so a set-based
     * `UPDATE … FROM (VALUES …)` written the idiomatic way NESTS its bound
     * values one level down instead of passing them at the top level.
     */
    function isSql(v: any): boolean {
      return (
        !!v && typeof v === "object" && Array.isArray(v.strings) && Array.isArray((v as any).values)
      );
    }

    /** Every literal SQL fragment in a call, including fragments nested in a `Sql`. */
    function sqlText(node: any): string {
      if (node == null) return "";
      if (typeof node === "string") return node;
      if (isSql(node)) return sqlText(node.strings) + " " + sqlText(node.values);
      if (Array.isArray(node)) return node.map(sqlText).join(" ");
      return "";
    }

    /** Every BOUND value in a call, flattened out of any nested `Sql`. */
    function flatValues(v: any): any[] {
      if (v == null) return [];
      if (isSql(v)) return flatValues(v.values);
      if (Array.isArray(v)) return v.flatMap(flatValues);
      return [v];
    }

    /**
     * Bindings only. Tagged-template form (`` tx.$executeRaw`…` ``) puts the
     * literal pieces in `call[0]` and the bindings after it; function form
     * (`tx.$executeRaw(Prisma.sql`…`)`) puts both inside `call[0]`. Both shapes
     * are correct implementations of R15, so the oracle reads either.
     */
    function callValues(call: any[]): any[] {
      return isSql(call[0]) ? flatValues(call[0]) : flatValues(call.slice(1));
    }

    function primeCreate() {
      prisma.customer.findUnique.mockResolvedValue({
        id: "cust-1",
        user: { status: "ACTIVE" },
      });
      prisma.customer.findFirst.mockResolvedValue({ pricingTier: 1, fulfillPath: null });
      prisma.product.findMany.mockResolvedValue(PRODUCTS);
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.orderItem.findMany.mockResolvedValue([]);
      prisma.order.findFirst.mockResolvedValue(null); // order-number sequence seed
      prisma.order.create.mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: "ord-new",
          orderNumber: "ORD-00001",
          customerId: data.customerId,
          status: data.status,
          total: data.total,
          urgent: data.urgent ?? false,
          createdAt: new Date(),
          customer: { id: data.customerId, businessName: "Acme Wholesale" },
        }),
      );
    }

    /**
     * Captures EVERY `tenantTransaction` call's options and accumulates raw
     * statements across all of them in ONE mock — `create()` retries its
     * transaction up to 3× on a P2002 order-number race (orders.service.ts
     * ~:2039-2043), so reading "the last call" would silently inspect the wrong
     * transaction the moment the fix opens a second one.
     */
    function captureTenantTransaction() {
      const allOptions: any[] = [];
      const txExecuteRaw: jest.Mock = jest.fn().mockResolvedValue(0);
      prisma.tenantTransaction.mockImplementation((fn: any, opts?: any) => {
        allOptions.push(opts);
        const tx = {
          ...(prisma as unknown as Record<string, any>),
          $executeRaw: txExecuteRaw,
          $queryRaw: jest.fn().mockResolvedValue([]),
        };
        return fn(tx);
      });
      return {
        getAllOptions: () => allOptions,
        getExecuteRaw: () => txExecuteRaw,
      };
    }

    // Staff override BELOW list price takes the DISCOUNTED branch directly —
    // avoids exercising the buyer promo/tier pricing ladder, which is
    // orthogonal to B116's stock-decrement claim.
    const dto = {
      customerId: "cust-1",
      status: "PENDING",
      items: [
        { productId: "prod-1", qty: 2, unitPrice: 9 },
        { productId: "prod-1", qty: 3, unitPrice: 9 },
        { productId: "prod-2", qty: 4, unitPrice: 9 },
      ],
    };

    it("REG-B116 (T19): the stock transaction opens with a bounded timeout and maxWait", async () => {
      primeCreate();
      const { getAllOptions } = captureTenantTransaction();

      await service.create(dto as any, operatorPayload);

      // hand: spec's bound values, taken verbatim from R14 — today's call
      // passes no second argument at all (undefined), so the transaction has
      // no timeout ceiling. Asserting on EVERY transaction create() opened,
      // rather than on whichever ran last, keeps the oracle pinned to the right
      // call whatever the fix does to the retry loop.
      const allOptions = getAllOptions();
      expect(allOptions.length).toBeGreaterThan(0);
      for (const opts of allOptions) {
        expect(opts).toEqual(expect.objectContaining({ timeout: 20000, maxWait: 5000 }));
      }
    });

    it("REG-B116 (T20): three lines of two products decrement stock in exactly ONE aggregated statement, never via a per-line product.update", async () => {
      primeCreate();
      const { getExecuteRaw } = captureTenantTransaction();

      await service.create(dto as any, operatorPayload);

      // Today's per-line loop decrements via the ORM, once per line — the
      // aggregated fix moves this entirely into the raw statement below.
      expect(prisma.product.update).not.toHaveBeenCalled();

      const rawCalls = getExecuteRaw().mock.calls;
      // hand: exactly one call whose SQL text targets currentStock, distinct
      // from the pre-existing `SELECT ... FOR UPDATE` lock call.
      const decrementCalls = rawCalls.filter((call: any[]) => {
        const text = sqlText(call[0]) + " " + sqlText(call.slice(1));
        return text.includes("currentStock") && text.toUpperCase().includes("UPDATE");
      });
      expect(decrementCalls).toHaveLength(1);

      // hand: the statement must SUBTRACT the bound qty from currentStock. The
      // occurrence counts below prove the values were aggregated, but they say
      // nothing about direction — without this a sign flip (`+ v.qty`) or a
      // write to the wrong column keeps every other assertion in this test
      // green while doubling stock on every order.
      const decrementSql = sqlText(decrementCalls[0][0]).replace(/\s+/g, " ");
      expect(decrementSql).toMatch(/UPDATE\s+"Product"/i);
      expect(decrementSql).toMatch(/SET\s+"currentStock"\s*=\s*p\."currentStock"\s*-\s*v\.qty/i);

      // hand: prod-1's two lines aggregate to 2 + 3 = 5; prod-2's single line
      // is 4. Counting occurrences (rather than merely "5 appears somewhere")
      // is what makes this an AGGREGATION oracle: a statement that carried the
      // per-line 2 and 3 for prod-1 would name prod-1 twice and never bind 5.
      const boundValues = callValues(decrementCalls[0] ?? []);
      const qtys = boundValues.map(Number).filter((n) => Number.isFinite(n));
      expect(qtys.filter((n) => n === 5)).toHaveLength(1);
      expect(qtys.filter((n) => n === 4)).toHaveLength(1);
      expect(boundValues.filter((v: any) => String(v) === "prod-1")).toHaveLength(1);
      expect(boundValues.filter((v: any) => String(v) === "prod-2")).toHaveLength(1);
    });
  });
});
