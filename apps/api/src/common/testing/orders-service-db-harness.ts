import { Logger } from "@nestjs/common";
import { EncryptionService } from "../encryption.service";
import type { PrismaService } from "../../prisma/prisma.service";
import { SystemConfigService } from "../../system-config/system-config.service";
import type { TenantContextService } from "../../tenant/tenant-context.service";
import { OrdersService } from "../../orders/orders.service";
import { INVOICE_EDIT_STUBS } from "../../orders/testing/invoice-edit-stubs";

/**
 * A REAL `OrdersService` on a real Postgres connection for DB-lane specs (`*.db.spec.ts`): its own methods run for real
 * (changeStatus, the transition table, updateFulfillPath, the stock rules), and only the collaborators it touches AFTER a
 * write, or that need the network, are stand-ins. The customer-message collaborators (`notifications.sendToCustomer`,
 * `messaging.notifyEvent`) are the caller's spies, so a spec can count the messages a transition sends.
 *
 * The caller jest.mock()s InvoicesService and NotificationsService (ESM-only chains) before importing this file, as
 * orders.delivered-stamp-paths.db.spec.ts does. ONE place for the harness (I-120): new DB specs use this, not a copy.
 */
export function buildDbOrdersService(
  prisma: PrismaService,
  tenantCtx: TenantContextService,
  over: {
    pushes?: (...a: unknown[]) => Promise<unknown>;
    events?: (...a: unknown[]) => Promise<unknown>;
    /** Throw from it to model a selling restriction (L8) at the store's state. */
    assertLinesSellable?: () => Promise<void>;
    /** Extra / replacement InvoicesService methods (send, recordPayment, sendCompletionEmail, ...). */
    invoices?: Record<string, unknown>;
  } = {},
): any {
  const anyMethod = new Proxy(
    {},
    { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
  );
  const orders = Object.assign(Object.create(OrdersService.prototype), {
    prisma,
    gateway: { emitOrderStatusChanged: jest.fn(), emitOrderCreated: jest.fn() },
    systemConfig: new SystemConfigService(
      prisma,
      new EncryptionService({ get: () => undefined } as never),
    ),
    entitlements: { hasFlag: async () => true },
    sellingRestrictions: {
      getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
      assertLinesSellable: over.assertLinesSellable ?? (async () => undefined),
    },
    authGuard: { assertAuthorizedOrThrow: async () => undefined },
    promotionsService: { activeForCatalog: async () => [] },
    notifications: { sendToCustomer: over.pushes ?? (async () => undefined) },
    messaging: { notifyEvent: over.events ?? (async () => undefined), notify: async () => [] },
    ledger: anyMethod,
    featureConfig: { getEffectiveMode: async () => "unset" },
    tenantCtx,
    invoicesService: {
      revertLinkedInvoicesForOrderEdit: async () => undefined,
      resyncOrderInvoicesForEdit: async () => [],
      ...INVOICE_EDIT_STUBS,
      reconcileOrderDraftInvoice: async () => undefined,
      findOpenOrderDraft: async () => null,
      createInvoiceFromOrderWithTenant: async () => [{ id: "stub" }],
      createInvoiceFromOrder: async () => [{ id: "stub", status: "DRAFT" }],
      send: async () => ({ status: "SENT" }),
      releaseWalletPaymentsInTx: async () => ({ credits: [], advances: 0 }),
      voidInvoiceInTx: async () => ({}),
      ...(over.invoices ?? {}),
    },
    logger: new Logger(OrdersService.name),
    inlineReturns: {},
    creditNotes: {
      settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
      releaseOrderCreditsInTx: async () => [],
    },
  });
  return orders;
}
