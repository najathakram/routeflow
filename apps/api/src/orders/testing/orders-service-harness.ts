/**
 * Shared test harness for `OrdersService` (lane R: every restrictions / credit call-site spec builds
 * the same OrdersService module — copying it per spec is how the next signature change becomes N edits).
 * Copied from `orders.order-number.spec.ts`; every collaborator is a permissive mock, and the ones the
 * call-site specs assert on are returned by name.
 *
 * IMPORT THIS FILE BEFORE `OrdersService` in a spec: its `jest.mock` calls (the ESM-only
 * `@react-pdf/renderer` / `expo-server-sdk` traversal guards) must be registered first.
 */

// Mock InvoicesService before it's imported — prevents Jest from traversing
// invoice-pdf.service.ts which imports @react-pdf/renderer (ESM-only module).
jest.mock("../../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
  })),
}));

// Mock NotificationsService — it imports expo-server-sdk which is ESM-only
// and fails Jest's CommonJS parser.
jest.mock("../../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({
    sendToCustomer: jest.fn().mockResolvedValue(undefined),
    sendToDriver: jest.fn().mockResolvedValue(undefined),
    sendToUser: jest.fn().mockResolvedValue(1),
  })),
}));

import { oversellReaderOffProvider } from "./policy-reader-provider";
import { Test, TestingModule } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";

import { OrdersService } from "../orders.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { SystemConfigService } from "../../system-config/system-config.service";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { RouteFlowGateway } from "../../gateways/routeflow.gateway";
import { createMockPrisma } from "../../testing/prisma-mock";
import { NotificationsService } from "../../notifications/notifications.service";
import { InventoryService } from "../../inventory/inventory.service";
import { AuthorizationGuardService } from "../../authorizations/authorization-guard.service";
import { SellingRestrictionsService } from "../../selling-restrictions/selling-restrictions.service";
import { PromotionsService } from "../../promotions/promotions.service";
import { MessagingService } from "../../messaging/messaging.service";
import { CreditNotesService } from "../../credit-notes/credit-notes.service";
import { CommissionEngineService } from "../../sales-agents/commission-engine.service";
import { EntitlementsService } from "../../billing/entitlements.service";
import { RegulatedLedgerService } from "../../regulated/regulated-ledger.service";
import { Prisma } from "@prisma/client";

/** Real-shaped principals the call-site specs use (`JwtPayload` fields the service reads). */
const base = { status: "ACTIVE" as const, forcePasswordChange: false };
export const operatorPayload = {
  ...base,
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
};
export const customerPayload = {
  ...base,
  sub: "user-cust",
  username: "customer1",
  role: "CUSTOMER" as const,
  // B1211: the buyer order gate is tenant-scoped, so a buyer's token carries its tenant (the mock prisma's).
  tenantId: "test-tenant",
};
/** The buyer pseudo-user (`makePseudoUser`): role CUSTOMER, stamped `type: "BUYER"`. */
export const buyerPseudoUser = { ...customerPayload, type: "BUYER" as const };

export async function buildOrdersService() {
  const prisma = createMockPrisma();
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      oversellReaderOffProvider,
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
          sendToUser: jest.fn().mockResolvedValue(1),
        },
      },
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
      // B65: deleteOrder's per-invoice teardown reverses regulated-ledger entries.
      {
        provide: RegulatedLedgerService,
        useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
      },
    ],
  }).compile();
  const service = module.get<OrdersService>(OrdersService);
  return {
    service,
    prisma,
    module,
    /** the `SellingRestrictionsService` stub (`assertLinesSellable` / `checkLinesSellable` / `getPolicy`, OFF) */
    restrictions: module.get(SellingRestrictionsService) as unknown as {
      assertLinesSellable: jest.Mock;
      checkLinesSellable: jest.Mock;
      getPolicy: jest.Mock;
    },
    authGuard: module.get(AuthorizationGuardService) as unknown as {
      assertAuthorizedOrThrow: jest.Mock;
    },
    /** the side-effect stubs a refused or rolled-back status change must never reach */
    sideEffects: {
      gateway: module.get(RouteFlowGateway) as unknown as { emitOrderStatusChanged: jest.Mock },
      notifications: module.get(NotificationsService) as unknown as {
        sendToCustomer: jest.Mock;
        sendToUser: jest.Mock;
      },
      messaging: module.get(MessagingService) as unknown as { notifyEvent: jest.Mock },
    },
  };
}
