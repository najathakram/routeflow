import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Provider } from "@nestjs/common";
import { oversellReaderOffProvider } from "../src/orders/testing/policy-reader-provider";
import { OrdersService } from "../src/orders/orders.service";
import { InvoicesService } from "../src/invoices/invoices.service";
import { SystemConfigService } from "../src/system-config/system-config.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { TenantContextService } from "../src/tenant/tenant-context.service";
import { RouteFlowGateway } from "../src/gateways/routeflow.gateway";
import { NotificationsService } from "../src/notifications/notifications.service";
import { InventoryService } from "../src/inventory/inventory.service";
import { AuthorizationGuardService } from "../src/authorizations/authorization-guard.service";
import { SellingRestrictionsService } from "../src/selling-restrictions/selling-restrictions.service";
import { ProductLabelsService } from "../src/product-labels/product-labels.service";
import { PromotionsService } from "../src/promotions/promotions.service";
import { MessagingService } from "../src/messaging/messaging.service";
import { CreditNotesService } from "../src/credit-notes/credit-notes.service";
import { CommissionEngineService } from "../src/sales-agents/commission-engine.service";
import { EntitlementsService } from "../src/billing/entitlements.service";
import { EntitlementAuthority } from "../src/billing/entitlement-authority.service";
import { RegulatedLedgerService } from "../src/regulated/regulated-ledger.service";

/**
 * Row 510 DB-spec harness (test code only, beside `restriction-override-fixture.ts`): the REAL OrdersService and the REAL
 * SellingRestrictionsService over a real database, with every other collaborator a stub. The spec that calls this MUST
 * `jest.mock` `../invoices/invoices.service` and `../notifications/notifications.service` at its top (a hoisted mock
 * cannot live in a helper), exactly as `src/orders/restriction-override.db.spec.ts` does, so their import trees never load.
 */
export async function buildOverrideModule(
  tenantCtx: TenantContextService,
  dbPrisma: PrismaService,
  extra: Provider[] = [],
): Promise<TestingModule> {
  return Test.createTestingModule({
    providers: [
      oversellReaderOffProvider,
      OrdersService,
      SellingRestrictionsService,
      ProductLabelsService,
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
      {
        provide: EntitlementsService,
        useValue: { hasFlag: jest.fn().mockResolvedValue(true) },
      },
      {
        provide: RegulatedLedgerService,
        useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
      },
      ...extra,
    ],
  }).compile();
}
