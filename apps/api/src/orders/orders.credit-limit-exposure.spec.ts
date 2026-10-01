/**
 * D6 / B462 (option B) — the hard credit-limit block (`OrdersService.updateOrderItems` and the
 * change-request twin `assertCreditForProjectedOrder`) reads exposure through the ONE shared
 * derivation (`invoices/credit-exposure.ts`). Split out of `orders.service.spec.ts` so that file
 * stays under the size ratchet (`common/size-ratchet.spec.ts`); the harness is the same
 * mocked-Prisma + stub-provider setup as that file's "updateOrderItems — credit-limit guard
 * (P5-08b)" describe (fixtures copied verbatim). The derivation's own unit specs live in
 * `invoices/credit-exposure.spec.ts`.
 */

// Mock InvoicesService before it's imported — prevents Jest from traversing
// invoice-pdf.service.ts which imports @react-pdf/renderer (ESM-only module).
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
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

import { oversellReaderOffProvider } from "./testing/policy-reader-provider";
import { Test, TestingModule } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { OrdersService } from "./orders.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { TenantContextService } from "../tenant/tenant-context.service";
import { createMockPrisma } from "../testing/prisma-mock";
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
import { Prisma } from "@prisma/client";

const MOCK_ORDER = {
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-123",
  status: "PENDING" as const,
  source: "APP" as const,
  urgent: false,
  subtotal: 14.97,
  tax: 1.5,
  total: 16.47,
  notes: null,
  driverNote: null,
  routeRunId: null,
  routeRunStopId: null,
  deliveredAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  customer: { businessName: "Test Business" },
};

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

describe("OrdersService — credit-limit exposure (D6 / B462, option B)", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        oversellReaderOffProvider,
        OrdersService,
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
            reconcileOrderDraftInvoice: jest.fn().mockResolvedValue({ id: "inv-1" }),
            resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
            revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue(null) },
        },
        { provide: NotificationsService, useValue: {} },
        {
          provide: InventoryService,
          useValue: {
            recordSale: jest.fn().mockResolvedValue({
              unitCost: new Prisma.Decimal(0),
              stockAfter: new Prisma.Decimal(0),
            }),
          },
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
        { provide: PromotionsService, useValue: {} },
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
          },
        },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
        { provide: RegulatedLedgerService, useValue: {} },
        {
          provide: TenantContextService,
          useValue: { run: (_t: unknown, fn: () => unknown) => fn() },
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  // PENDING order (the guard skips DRAFT), no run (edit window open), one line qty 2 @ $5. The
  // edit below moves it to qty 3 → the recompute stub says subtotal 15; tax is 0 in tests →
  // projected total = 15.
  const editableOrder = () => ({
    ...MOCK_ORDER,
    status: "PENDING" as const,
    routeRun: null,
    lineItems: [
      {
        id: "li-1",
        orderId: "ord-1",
        productId: "prod-1",
        qty: 2,
        unitPrice: 5,
        subtotal: 10,
        status: "PENDING",
        boxes: null,
        pieces: null,
      },
    ],
  });
  const editDto = { items: [{ id: "li-1", action: "UPDATE" as const, qty: 3, unitPrice: 5 }] };
  const postEditItems = [
    { id: "li-1", productId: "prod-1", qty: 3, unitPrice: 5, subtotal: 15, status: "PENDING" },
  ];

  beforeEach(() => {
    prisma.order.findUnique.mockResolvedValue(editableOrder());
    prisma.orderItem.findMany.mockResolvedValue(postEditItems);
    prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
  });

  // ─── D6 / B462 (option B): only UNBACKED drafts stay outside the hard block ────
  // Owner ruling: a standalone unissued draft is not a receivable, but DELIVERED goods must
  // never become unguarded. A DRAFT whose order is OPEN or DELIVERED counts; a partially
  // invoiced order counts max(order total, issued + draft) ONCE; only a draft with no
  // open/delivered order behind it (standalone, cancelled/draft-status order) is free — the
  // statement shows it as "pending exposure". The exposure comes from the ONE shared reader
  // (invoices/credit-exposure.ts), which reads each invoice's order to judge backing.
  describe("D6 / B462 (option B) — a draft with no open/delivered order behind it is the only one outside the limit", () => {
    const orderOf = (id: string, status: string, total: number) => ({ id, status, total });
    const overLimit = (exposure: number, limit = 100) => ({
      response: { code: "CREDIT_LIMIT_EXCEEDED", limit, exposure },
    });

    beforeEach(() => {
      prisma.customer.findFirst.mockResolvedValue({ creditLimit: 100 });
    });

    it("a standalone DRAFT invoice (no order) does NOT push exposure over the limit", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        { total: 200, status: "DRAFT", orderId: null, order: null, payments: [] },
      ]);
      prisma.order.findMany.mockResolvedValue([]);

      await service.updateOrderItems("ord-1", editDto, operatorPayload); // 0 + 15 ≤ 100

      expect(prisma.order.update).toHaveBeenCalled();
    });

    it.each(["CANCELLED", "DRAFT"])(
      "a DRAFT invoice whose order is %s (unbacked) does NOT count",
      async (status) => {
        prisma.invoice.findMany.mockResolvedValue([
          {
            total: 200,
            status: "DRAFT",
            orderId: "ord-2",
            order: orderOf("ord-2", status, 200),
            payments: [],
          },
        ]);
        prisma.order.findMany.mockResolvedValue([]); // neither is an OPEN order

        await service.updateOrderItems("ord-1", editDto, operatorPayload); // 0 + 15 ≤ 100

        expect(prisma.order.update).toHaveBeenCalled();
      },
    );

    it("the SAME invoice once issued (SENT) DOES block — only the DRAFT status changes the outcome", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        { total: 200, status: "SENT", orderId: null, order: null, payments: [] },
      ]);
      prisma.order.findMany.mockResolvedValue([]);

      await expect(
        service.updateOrderItems("ord-1", editDto, operatorPayload),
      ).rejects.toMatchObject(overLimit(215));
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it.each(["SENT", "VIEWED", "PARTIAL", "OVERDUE"])(
      "an issued %s invoice still counts against the limit",
      async (status) => {
        prisma.invoice.findMany.mockResolvedValue([
          {
            total: 200,
            status,
            orderId: null,
            order: null,
            payments: [{ amount: 80, status: "PAID" }],
          }, // 120
        ]);
        prisma.order.findMany.mockResolvedValue([]);

        await expect(
          service.updateOrderItems("ord-1", editDto, operatorPayload),
        ).rejects.toMatchObject(overLimit(135));
      },
    );

    // E1 (ruling): delivered goods must never become unguarded.
    it("E1: a DRAFT invoice (90) on a DELIVERED order (90) DOES block — exposure 105 > limit 100, same 409 body shape", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        {
          total: 90,
          status: "DRAFT",
          orderId: "ord-2",
          order: orderOf("ord-2", "DELIVERED", 90),
          payments: [],
        },
      ]);
      prisma.order.findMany.mockResolvedValue([]); // a DELIVERED order is not an OPEN order

      await expect(
        service.updateOrderItems("ord-1", editDto, operatorPayload),
      ).rejects.toMatchObject({
        response: {
          code: "CREDIT_LIMIT_EXCEEDED",
          message:
            "This edit would take the customer's exposure to 105.00, over their credit limit of 100.00.",
          limit: 100,
          exposure: 105,
        },
      });
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it("E1: a DRAFT on a PARTIALLY_DELIVERED order also blocks", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        {
          total: 90,
          status: "DRAFT",
          orderId: "ord-2",
          order: orderOf("ord-2", "PARTIALLY_DELIVERED", 90),
          payments: [],
        },
      ]);
      prisma.order.findMany.mockResolvedValue([]);

      await expect(
        service.updateOrderItems("ord-1", editDto, operatorPayload),
      ).rejects.toMatchObject(overLimit(105));
    });

    it("E1: the delivered-order draft counts by its BALANCE — a real payment on it nets off", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        {
          total: 90,
          status: "DRAFT",
          orderId: "ord-2",
          order: orderOf("ord-2", "DELIVERED", 90),
          payments: [{ amount: 30, status: "PAID" }], // balance 60; remainder 0
        },
      ]);
      prisma.order.findMany.mockResolvedValue([]);

      await service.updateOrderItems("ord-1", editDto, operatorPayload); // 60 + 15 = 75 ≤ 100

      expect(prisma.order.update).toHaveBeenCalled();
    });

    it("an open order whose only invoice is a DRAFT mirror STILL counts (no under-count): 90 + 15 = 105 → block", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        {
          total: 90,
          status: "DRAFT",
          orderId: "ord-2",
          order: orderOf("ord-2", "CONFIRMED", 90),
          payments: [],
        },
      ]);
      prisma.order.findMany.mockResolvedValue([{ id: "ord-2", total: 90 }]);

      await expect(
        service.updateOrderItems("ord-1", editDto, operatorPayload),
      ).rejects.toMatchObject(overLimit(105));
    });

    it("a mirror-draft order is counted ONCE, never draft + order", async () => {
      // 40 + 15 = 55 ≤ 60. A double count (draft 40 + order 40 + 15 = 95) would wrongly block.
      prisma.customer.findFirst.mockResolvedValue({ creditLimit: 60 });
      prisma.invoice.findMany.mockResolvedValue([
        {
          total: 40,
          status: "DRAFT",
          orderId: "ord-2",
          order: orderOf("ord-2", "CONFIRMED", 40),
          payments: [],
        },
      ]);
      prisma.order.findMany.mockResolvedValue([{ id: "ord-2", total: 40 }]);

      await service.updateOrderItems("ord-1", editDto, operatorPayload);

      expect(prisma.order.update).toHaveBeenCalled();
    });

    // E2 (ruling): a partially invoiced order counts max(order total, issued + draft) ONCE.
    describe("E2: a partially invoiced order (open, 100) with ISSUED 60 + DRAFT 40 counts 100 exactly once", () => {
      const partialRows = () => [
        {
          total: 60,
          status: "SENT",
          orderId: "ord-2",
          order: orderOf("ord-2", "CONFIRMED", 100),
          payments: [],
        },
        {
          total: 40,
          status: "DRAFT",
          orderId: "ord-2",
          order: orderOf("ord-2", "CONFIRMED", 100),
          payments: [],
        },
      ];

      it("passes at a limit of exactly 100 + 15 = 115 (not 200 + 15, and not blocked)", async () => {
        prisma.customer.findFirst.mockResolvedValue({ creditLimit: 115 });
        prisma.invoice.findMany.mockResolvedValue(partialRows());
        prisma.order.findMany.mockResolvedValue([{ id: "ord-2", total: 100 }]);

        await service.updateOrderItems("ord-1", editDto, operatorPayload);

        expect(prisma.order.update).toHaveBeenCalled();
      });

      it("blocks at a limit of 110 with exposure exactly 115 (not 215, not 75 = issued only)", async () => {
        prisma.customer.findFirst.mockResolvedValue({ creditLimit: 110 });
        prisma.invoice.findMany.mockResolvedValue(partialRows());
        prisma.order.findMany.mockResolvedValue([{ id: "ord-2", total: 100 }]);

        await expect(
          service.updateOrderItems("ord-1", editDto, operatorPayload),
        ).rejects.toMatchObject(overLimit(115, 110));
      });

      it("a 30 payment on the issued invoice nets off: 70 + 15 = 85 (passes at 85, blocks at 84.99)", async () => {
        const rows = partialRows();
        rows[0].payments = [{ amount: 30, status: "PAID" }] as any;
        prisma.invoice.findMany.mockResolvedValue(rows);
        prisma.order.findMany.mockResolvedValue([{ id: "ord-2", total: 100 }]);

        prisma.customer.findFirst.mockResolvedValue({ creditLimit: 85 });
        await service.updateOrderItems("ord-1", editDto, operatorPayload);
        expect(prisma.order.update).toHaveBeenCalled();

        jest.clearAllMocks();
        prisma.order.findUnique.mockResolvedValue(editableOrder());
        prisma.orderItem.findMany.mockResolvedValue(postEditItems);
        prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
        prisma.customer.findFirst.mockResolvedValue({ creditLimit: 84.99 });
        prisma.invoice.findMany.mockResolvedValue(rows);
        prisma.order.findMany.mockResolvedValue([{ id: "ord-2", total: 100 }]);
        await expect(
          service.updateOrderItems("ord-1", editDto, operatorPayload),
        ).rejects.toMatchObject(overLimit(85, 84.99));
      });
    });

    it("a partially invoiced open order (issued 90 of 100) counts its 10 remainder too: 90 + 10 + 15 = 115", async () => {
      prisma.customer.findFirst.mockResolvedValue({ creditLimit: 110 });
      prisma.invoice.findMany.mockResolvedValue([
        {
          total: 90,
          status: "SENT",
          orderId: "ord-2",
          order: orderOf("ord-2", "CONFIRMED", 100),
          payments: [],
        },
      ]);
      prisma.order.findMany.mockResolvedValue([{ id: "ord-2", total: 100 }]);

      await expect(
        service.updateOrderItems("ord-1", editDto, operatorPayload),
      ).rejects.toMatchObject(overLimit(115, 110));
    });

    it("B577: another OPEN order fully prepaid by a PAID invoice is not counted again — 0 + 15 passes a limit of 100 (was 100 + 15, a false 409)", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        {
          total: 100,
          status: "PAID",
          orderId: "ord-2",
          order: orderOf("ord-2", "CONFIRMED", 100),
          payments: [{ amount: 100, status: "PAID" }],
        },
      ]);
      prisma.order.findMany.mockResolvedValue([{ id: "ord-2", total: 100 }]);

      await service.updateOrderItems("ord-1", editDto, operatorPayload);

      expect(prisma.order.update).toHaveBeenCalled();
    });

    it("B577: a partially prepaid open order counts only its unbilled remainder: PAID 60 of 100 → 40 + 15 = 55 blocks a limit of 50", async () => {
      prisma.customer.findFirst.mockResolvedValue({ creditLimit: 50 });
      prisma.invoice.findMany.mockResolvedValue([
        {
          total: 60,
          status: "PAID",
          orderId: "ord-2",
          order: orderOf("ord-2", "CONFIRMED", 100),
          payments: [{ amount: 60, status: "PAID" }],
        },
      ]);
      prisma.order.findMany.mockResolvedValue([{ id: "ord-2", total: 100 }]);

      await expect(
        service.updateOrderItems("ord-1", editDto, operatorPayload),
      ).rejects.toMatchObject(overLimit(55, 50));
    });

    // an invoice of the edited order (ord-1); `paid` = its confirmed payment
    const ownInvoice = (o: {
      total: number;
      status: string;
      paid?: number;
      method?: string;
      orderStatus?: string;
    }) => ({
      total: o.total,
      status: o.status,
      orderId: "ord-1",
      order: orderOf("ord-1", o.orderStatus ?? "OUT_FOR_DELIVERY", o.total),
      payments: o.paid ? [{ amount: o.paid, status: "PAID", method: o.method }] : [],
    });

    it("B577 follow-up (COORD): a CREDIT NOTE that flips the invoice to PAID does NOT cover the edit (100 + 15 blocks a limit of 100)", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        ownInvoice({ total: 15, status: "PAID", paid: 15, method: "CREDIT_NOTE" }),
      ]);
      prisma.order.findMany.mockResolvedValue([{ id: "ord-2", total: 100 }]);

      await expect(
        service.updateOrderItems("ord-1", editDto, operatorPayload),
      ).rejects.toMatchObject(overLimit(115, 100));
    });

    it("B577 follow-up: editing a FULLY PREPAID order counts only its unpaid part — other order 100 + (15 − 15 paid) = 100 passes a limit of 100 (was 115, a false 409)", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        ownInvoice({ total: 15, status: "PAID", paid: 15 }),
      ]);
      prisma.order.findMany.mockResolvedValue([{ id: "ord-2", total: 100 }]);

      await service.updateOrderItems("ord-1", editDto, operatorPayload);

      expect(prisma.order.update).toHaveBeenCalled();
    });

    it("B577 follow-up: a PARTIALLY paid edited order counts its unpaid remainder — 100 + (15 − 5) = 110 blocks a limit of 100", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        ownInvoice({ total: 15, status: "PARTIAL", paid: 5 }),
      ]);
      prisma.order.findMany.mockResolvedValue([{ id: "ord-2", total: 100 }]);

      await expect(
        service.updateOrderItems("ord-1", editDto, operatorPayload),
      ).rejects.toMatchObject(overLimit(110, 100));
    });

    it("B577 follow-up: the netting is FLOORED at 0 — a big prepayment on the edited order never subtracts from OTHER orders' exposure (900 + 0 = 900 blocks a limit of 100)", async () => {
      // the edited order was prepaid 900, and is edited down to 15
      prisma.invoice.findMany.mockResolvedValue([
        ownInvoice({ total: 900, status: "PAID", paid: 900 }),
      ]);
      prisma.order.findMany.mockResolvedValue([{ id: "ord-2", total: 900 }]); // an unrelated open order

      await expect(
        service.updateOrderItems("ord-1", editDto, operatorPayload),
      ).rejects.toMatchObject(overLimit(900, 100));
    });

    it.each([
      ["PARTIAL, owes 150", { total: 200, status: "PARTIAL", paid: 50 }],
      ["a lone SENT deposit-mirror shape, owes 1000", { total: 1000, status: "SENT" }],
    ])(
      "B577 follow-up (review): PRE-delivery an issued invoice (%s) is never trusted to survive — the reconcile rewrites a deposit mirror — so a cut to 15 counts 15, as before the netting (never stricter than master)",
      async (_label, invoice) => {
        prisma.invoice.findMany.mockResolvedValue([
          ownInvoice({ ...invoice, orderStatus: "CONFIRMED" }),
        ]);
        prisma.order.findMany.mockResolvedValue([]);

        await service.updateOrderItems("ord-1", editDto, operatorPayload); // 15 ≤ 100

        expect(prisma.order.update).toHaveBeenCalled();
      },
    );

    it.each([
      ["fully invoiced (the post-delivery re-sync rewrites the invoice)", 2, "passes"],
      ["partially invoiced (neither the revert nor the re-sync runs)", 1, "blocks"],
    ])(
      "B577 follow-up (review): a DELIVERED order, %s — its PARTIAL invoice (owes 150) cut to 15 %s a limit of 100",
      async (_label, invoicedQty, verdict) => {
        const order = editableOrder();
        prisma.order.findUnique.mockResolvedValue({
          ...order,
          status: "DELIVERED" as const,
          lineItems: [{ ...order.lineItems[0], invoicedQty }],
        });
        prisma.invoice.findMany.mockResolvedValue([
          ownInvoice({ total: 200, status: "PARTIAL", paid: 50, orderStatus: "DELIVERED" }),
        ]);
        prisma.order.findMany.mockResolvedValue([]);

        const edit = service.updateOrderItems("ord-1", editDto, operatorPayload);
        if (verdict === "blocks") await expect(edit).rejects.toMatchObject(overLimit(150, 100));
        else await edit;
      },
    );

    it("E4: an open order (90) whose sole DRAFT mirror is 110 (shipping fee) counts the draft's 110: 110 + 15 = 125 blocks a limit of 120", async () => {
      prisma.customer.findFirst.mockResolvedValue({ creditLimit: 120 });
      prisma.invoice.findMany.mockResolvedValue([
        {
          total: 110,
          status: "DRAFT",
          orderId: "ord-2",
          order: orderOf("ord-2", "CONFIRMED", 90),
          payments: [],
        },
      ]);
      prisma.order.findMany.mockResolvedValue([{ id: "ord-2", total: 90 }]);

      await expect(
        service.updateOrderItems("ord-1", editDto, operatorPayload),
      ).rejects.toMatchObject(overLimit(125, 120)); // pre-fix arithmetic would say 105 and pass
    });

    it("the edited order's own DRAFT mirror is excluded (represented by the projected total)", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        {
          total: 500,
          status: "DRAFT",
          orderId: "ord-1",
          order: orderOf("ord-1", "CONFIRMED", 500),
          payments: [],
        },
      ]);
      prisma.order.findMany.mockResolvedValue([{ id: "ord-1", total: 500 }]);

      await service.updateOrderItems("ord-1", editDto, operatorPayload); // 15 ≤ 100

      expect(prisma.order.update).toHaveBeenCalled();
    });

    it("409 body and message are unchanged", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        {
          total: 200,
          status: "SENT",
          orderId: null,
          order: null,
          payments: [{ amount: 80, status: "PAID" }],
        },
      ]);
      prisma.order.findMany.mockResolvedValue([]);

      await expect(
        service.updateOrderItems("ord-1", editDto, operatorPayload),
      ).rejects.toMatchObject({
        response: {
          code: "CREDIT_LIMIT_EXCEEDED",
          message:
            "This edit would take the customer's exposure to 135.00, over their credit limit of 100.00.",
          limit: 100,
          exposure: 135,
        },
      });
    });

    it("reads through the shared reader: non-settled invoices INCLUDING drafts, with `status` and the order selected", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.order.findMany.mockResolvedValue([]);

      await service.updateOrderItems("ord-1", editDto, operatorPayload);

      const args = prisma.invoice.findMany.mock.calls[0][0];
      // Settled only — DRAFT must come back so the derivation can judge each draft's backing —
      // plus (B577) the PAID invoices of OPEN orders, which cover their order.
      const [issued, cover] = args.where.OR;
      expect(new Set(issued.status.notIn)).toEqual(new Set(["PAID", "VOID", "WRITTEN_OFF"]));
      expect(cover.status.in).toEqual(["PAID"]);
      // Without `status` every DRAFT would silently count again...
      expect(args.select.status).toBe(true);
      // ...and without the order relation every DRAFT would look unbacked and leave the block.
      expect(args.select.order).toEqual({ select: { id: true, status: true, total: true } });
    });

    it("change-request path (assertCreditForProjectedOrder) uses the same basis: unbacked DRAFT free; SENT and delivered-order DRAFT count", async () => {
      prisma.order.findMany.mockResolvedValue([]);

      prisma.invoice.findMany.mockResolvedValue([
        { total: 500, status: "DRAFT", orderId: null, order: null, payments: [] },
      ]);
      await expect(
        service.assertCreditForProjectedOrder("cust-1", "ord-1", 15),
      ).resolves.toBeUndefined();

      prisma.invoice.findMany.mockResolvedValue([
        { total: 500, status: "SENT", orderId: null, order: null, payments: [] },
      ]);
      await expect(
        service.assertCreditForProjectedOrder("cust-1", "ord-1", 15),
      ).rejects.toMatchObject(overLimit(515));

      prisma.invoice.findMany.mockResolvedValue([
        {
          total: 500,
          status: "DRAFT",
          orderId: "ord-2",
          order: orderOf("ord-2", "DELIVERED", 500),
          payments: [],
        },
      ]);
      await expect(
        service.assertCreditForProjectedOrder("cust-1", "ord-1", 15),
      ).rejects.toMatchObject(overLimit(515));
    });
  });
});
