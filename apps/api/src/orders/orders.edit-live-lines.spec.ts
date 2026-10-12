/**
 * updateOrderItems — the operator diff branch must price, gate and delete off the LOCKED in-tx
 * line, never the pre-lock `order.lineItems` snapshot (B135 sibling: approveChangeRequestAtStop
 * was fixed for exactly this shape; the operator edit path was not).
 *
 * Interleave under test: T1 (this PATCH) reads the order before the transaction opens; T2 (an
 * at-door approve, another operator, an invoice) commits a change to the same line while T1 waits
 * on the Order row lock. The mock plays both roles: `order.findUnique` returns T1's stale snapshot,
 * `orderItem.findMany` (the post-lock read) returns what T2 left behind.
 *
 * Red on master: a qty-only edit re-writes the snapshot's unitPrice over one T2 just committed
 * (money wrong, silent); a DELETE judged on the snapshot's invoicedQty hard-deletes a line an
 * invoice now bills. Green after: price from the locked row, cancel instead of delete. The third
 * case characterizes the B135-shaped fallback (snapshot only when the held read lacks the row).
 */

jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { oversellReaderOffProvider } from "./testing/policy-reader-provider";
import { Test, TestingModule } from "@nestjs/testing";
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { PromotionsService } from "../promotions/promotions.service";
import { MessagingService } from "../messaging/messaging.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { UserRole } from "@prisma/client";

const operator = {
  sub: "user-op",
  email: "op@example.com",
  role: UserRole.OPERATOR,
  tenantId: "test-tenant",
} as any;

/** The line as T1 saw it before the lock: 2 units, $5, nothing invoiced. */
const SNAPSHOT_LINE = {
  id: "li-1",
  orderId: "ord-1",
  productId: "prod-1",
  qty: 2,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitPrice: 5,
  subtotal: 10,
  status: "PENDING",
  priceType: "STANDARD",
  originalPrice: null,
  invoicedQty: 0,
  deliveredQty: 0,
  promoFreeUnits: null,
  unitLabel: null,
  notes: null,
  overrideReason: null,
  position: 0,
};

const snapshotOrder = () => ({
  id: "ord-1",
  tenantId: "test-tenant",
  customerId: "cust-1",
  status: "CONFIRMED",
  routeRun: null,
  shippingFee: 0,
  lineItems: [SNAPSHOT_LINE],
});

describe("updateOrderItems — operator diff branch reads the locked line, not the snapshot", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        oversellReaderOffProvider,
        OrdersService,
        {
          provide: TenantContextService,
          useValue: { run: (_tenantId: string | null, fn: () => unknown) => fn() },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken("invoices"), useValue: { add: jest.fn() } },
        {
          provide: RouteFlowGateway,
          useValue: { emitOrderStatusChanged: jest.fn(), emitOrderCreated: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(0.1) } },
        {
          provide: InvoicesService,
          useValue: {
            findOpenOrderDraft: jest.fn().mockResolvedValue(null),
            reconcileOrderDraftInvoice: jest.fn().mockResolvedValue({ id: "inv-1" }),
            resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([]),
            followPartialPrices: jest.fn().mockResolvedValue({ issuedPartialsUnchanged: [] }),
            projectEditedInvoiceTotals: jest.fn().mockResolvedValue([]),
            revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: NotificationsService, useValue: {} },
        { provide: InventoryService, useValue: {} },
        {
          provide: SellingRestrictionsService,
          useValue: {
            getPolicy: jest.fn().mockResolvedValue({ enabled: false }),
            assertLinesSellable: jest.fn().mockResolvedValue(undefined),
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "OFF", reasons: [] }),
          },
        },
        {
          provide: AuthorizationGuardService,
          useValue: { assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: PromotionsService,
          useValue: { activeForCatalog: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: MessagingService,
          useValue: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: CreditNotesService,
          useValue: {
            previewOrderCreditRelease: jest.fn().mockResolvedValue([]),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: CommissionEngineService, useValue: {} },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    service = module.get<OrdersService>(OrdersService);

    prisma.order.findUnique.mockResolvedValue(snapshotOrder());
    prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([
      {
        id: "prod-1",
        name: "Tomatoes",
        pricePerUnit: 5,
        unitsPerBox: null,
        trackedCategoryId: null,
      },
    ]);
    prisma.deliveryMutation.count.mockResolvedValue(0);
  });

  /** Post-lock reads return T2's committed state; the post-write active set is the same rows. */
  function lockedLines(rows: any[]) {
    prisma.orderItem.findMany.mockImplementation(async (args: any) =>
      args?.where?.status ? rows.filter((r) => r.status !== "CANCELLED") : rows,
    );
  }

  it("a qty-only edit (the web page's UPDATE shape) prices off the price T2 committed under the lock, not the snapshot's", async () => {
    // T2 (another operator) repriced the line 5 -> 7 while T1 waited on the row lock. T1's
    // payload carries no unitPrice, so the branch falls back to the line's stored price.
    lockedLines([{ ...SNAPSHOT_LINE, unitPrice: 7, subtotal: 14 }]);

    await service.updateOrderItems(
      "ord-1",
      { items: [{ id: "li-1", action: "UPDATE", qty: 3 }] } as any,
      operator,
    );

    expect(prisma.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "li-1" },
        data: expect.objectContaining({ qty: 3, unitPrice: 7, subtotal: 21 }),
      }),
    );
    // Red on master: the snapshot's $5 is written back over T2's $7 (subtotal 15, not 21).
    expect(prisma.orderItem.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unitPrice: 5 }) }),
    );
  });

  it("DELETE is judged on the locked line's invoicedQty: a line an invoice now bills is struck off, never hard-deleted", async () => {
    // T2 (createInvoiceFromOrder) billed the line while T1 waited.
    lockedLines([{ ...SNAPSHOT_LINE, invoicedQty: 2 }]);
    prisma.orderItem.updateMany.mockResolvedValue({ count: 1 });

    await service.updateOrderItems(
      "ord-1",
      { items: [{ id: "li-1", action: "DELETE" }] } as any,
      operator,
    );

    expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
    // #2563: the strike-off is scoped to THIS order.
    expect(prisma.orderItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "li-1", orderId: "ord-1" },
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    );
  });

  it("a line hard-deleted under the lock is a retryable 409 CONCURRENT_UPDATE and NOTHING is written (row 372)", async () => {
    // The held read lacks the row (another writer deleted it while this tx waited on the lock). It used to fall
    // back to the pre-tx snapshot and die on P2025 / write stale state (B135's `liveLine ?? li`); the snapshot
    // fallback is gone: a payload id the lock does not hold is 409 before the first write.
    lockedLines([]);

    await expect(
      service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 3 }] } as any,
        operator,
      ),
    ).rejects.toMatchObject({ response: { code: "CONCURRENT_UPDATE" } });
    expect(prisma.orderItem.update).not.toHaveBeenCalled();
    expect(prisma.orderItem.delete).not.toHaveBeenCalled();
    expect(prisma.orderItem.create).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });
});
