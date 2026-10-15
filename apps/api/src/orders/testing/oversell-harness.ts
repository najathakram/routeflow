/**
 * WS9 call-site harness: builds the REAL `OrdersService` with `PolicyOversellReader` supplied as a
 * fake (`reader.read` is a jest.fn returning the configured policy) and spies on the two seams the
 * contract names: `resolveOversellAllowed` (wraps the REAL one) and the order-stock functions.
 *
 * L-247: the module is built with `useMocker`, so EVERY dependency OrdersService declares (now or
 * after the call-site PR adds `PolicyOversellReader`) is satisfied. A dependency not listed in
 * `explicit` resolves to a permissive auto-mock. Nothing here lists a providers array by hand, so a
 * new constructor parameter cannot make the whole spec fail with a DI error.
 *
 * IMPORT THIS FILE BEFORE `OrdersService` in a spec: the `jest.mock` calls below must register first.
 */
jest.mock("../../invoices/invoices.service", () => ({
  InvoicesService: class InvoicesService {},
}));
jest.mock("../../notifications/notifications.service", () => ({
  NotificationsService: class NotificationsService {},
}));
jest.mock("../order-stock", () => {
  const actual = jest.requireActual("../order-stock");
  return { ...actual, decrementStockForSale: jest.fn(), settleStockForEdit: jest.fn() };
});
jest.mock("../oversell-policy", () => {
  const actual = jest.requireActual("../oversell-policy");
  return { ...actual, resolveOversellAllowed: jest.fn(actual.resolveOversellAllowed) };
});

import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";

import { OrdersService } from "../orders.service";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { EntitlementsService } from "../../billing/entitlements.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { SystemConfigService } from "../../system-config/system-config.service";
import { SellingRestrictionsService } from "../../selling-restrictions/selling-restrictions.service";
import { AuthorizationGuardService } from "../../authorizations/authorization-guard.service";
import { PromotionsService } from "../../promotions/promotions.service";
import { MessagingService } from "../../messaging/messaging.service";
import { CreditNotesService } from "../../credit-notes/credit-notes.service";
import { RegulatedLedgerService } from "../../regulated/regulated-ledger.service";
import { createMockPrisma } from "../../testing/prisma-mock";
import { PolicyOversellReader } from "../policy-oversell-reader";
import * as orderStock from "../order-stock";
import * as oversellPolicy from "../oversell-policy";

export { OrdersService, PolicyOversellReader };

export const TENANT = "test-tenant"; // what createMockPrisma().getTenantId() returns
const base = { status: "ACTIVE" as const, forcePasswordChange: false, tenantId: TENANT };
export const operator = { ...base, sub: "user-op", username: "op", role: "OPERATOR" as const };
export const tenantAdmin = {
  ...base,
  sub: "user-ta",
  username: "ta",
  role: "TENANT_ADMIN" as const,
};
export const buyer = { ...base, sub: "user-cust", username: "c1", role: "CUSTOMER" as const };
export const driver = { ...base, sub: "user-drv", username: "drv", role: "DRIVER" as const };

/** Any collaborator not listed: every method resolves undefined (a thenable would hang `await`). */
export const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

/** A stored policy value, or a function of the read args that returns one (`unknown` covers both). */
export type PolicyFor = unknown;

export async function buildOversellOrders(policy: PolicyFor = "off") {
  const prisma = createMockPrisma();
  const read = jest.fn(async (a: { tenantId: string; customerId?: string | null }) =>
    typeof policy === "function" ? (policy as (x: typeof a) => unknown)(a) : policy,
  );
  const reader = { read };
  const explicit = new Map<unknown, unknown>([
    [PrismaService, prisma],
    [PolicyOversellReader, reader],
    [ConfigService, { get: jest.fn().mockReturnValue(0.1) }],
    [EntitlementsService, { hasFlag: jest.fn().mockResolvedValue(true) }],
    [TenantContextService, { run: (_t: string | null, fn: () => unknown) => fn() }],
    [getQueueToken("invoices"), { add: jest.fn() }],
    [
      InvoicesService,
      {
        findOpenOrderDraft: jest.fn().mockResolvedValue(null),
        reconcileOrderDraftInvoice: jest.fn().mockResolvedValue({ id: "inv-1" }),
        resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([]),
        followPartialPrices: jest.fn().mockResolvedValue({ issuedPartialsUnchanged: [] }),
        projectEditedInvoiceTotals: jest.fn().mockResolvedValue([]),
        revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue([]),
        voidInvoiceInTx: jest.fn().mockResolvedValue({ id: "inv-1" }),
        releaseWalletPaymentsInTx: jest.fn().mockResolvedValue({ credits: [], advances: 0 }),
      },
    ],
    [SystemConfigService, { get: jest.fn().mockResolvedValue(null) }],
    [
      SellingRestrictionsService,
      {
        assertLinesSellable: jest.fn().mockResolvedValue(undefined),
        checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "OFF", reasons: [] }),
        getPolicy: jest.fn().mockResolvedValue({ enabled: false }),
      },
    ],
    [
      AuthorizationGuardService,
      {
        assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
        checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
      },
    ],
    [PromotionsService, { activeForCatalog: jest.fn().mockResolvedValue([]) }],
    [MessagingService, { notifyEvent: jest.fn().mockResolvedValue(undefined) }],
    [
      CreditNotesService,
      {
        previewOrderCreditRelease: jest.fn().mockResolvedValue([]),
        releaseOrderCreditsInTx: jest.fn().mockResolvedValue([]),
        settleOrderCreditsInTx: jest.fn().mockResolvedValue(undefined),
        validateSelectionsForCustomer: jest.fn().mockResolvedValue(undefined),
        syncOrderCreditSelections: jest.fn().mockResolvedValue(undefined),
      },
    ],
    [RegulatedLedgerService, { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) }],
  ]);
  const module = await Test.createTestingModule({ providers: [OrdersService] })
    .useMocker((token) => (explicit.has(token) ? explicit.get(token) : autoMock()))
    .compile();
  const service = module.get(OrdersService);

  const resolve = oversellPolicy.resolveOversellAllowed as unknown as jest.Mock;
  const decrement = orderStock.decrementStockForSale as unknown as jest.Mock;
  const settle = orderStock.settleStockForEdit as unknown as jest.Mock;
  resolve.mockClear();
  decrement.mockReset().mockResolvedValue(undefined);
  settle.mockReset().mockResolvedValue(undefined);

  const actualStock = jest.requireActual("../order-stock") as typeof orderStock;
  return {
    service,
    prisma,
    reader,
    read,
    resolve,
    decrement,
    settle,
    /** C2: run the REAL order-stock functions behind the spies. */
    useRealStock() {
      decrement.mockImplementation(actualStock.decrementStockForSale as never);
      settle.mockImplementation(actualStock.settleStockForEdit as never);
    },
  };
}

/** The global call counter jest keeps: lower = earlier. Infinity when never called. */
export const firstOrder = (...mocks: jest.Mock[]) =>
  Math.min(...mocks.map((m) => m.mock.invocationCallOrder[0] ?? Infinity));

const D = (n: number) => new Prisma.Decimal(n);

/**
 * A transaction client whose Product row behaves like the locked row: `currentStock` is the shared
 * `stock.v`, the aggregated UPDATE ... RETURNING moves it, and every SALE StockMovement is recorded.
 * `events` logs the order in which the transaction touched things (FOR UPDATE, policy tables, ...).
 */
export function stockTx(base: Record<string, unknown>, stock: { v: number }) {
  const events: string[] = [];
  const movements: any[] = [];
  const tx: any = {
    ...base,
    $executeRaw: jest.fn(async (s: TemplateStringsArray) => {
      const text = s.join("?");
      events.push(/FOR UPDATE/.test(text) ? "for-update" : "executeRaw");
      if (/PolicyValue/.test(text)) events.push("policy-sql");
      return 0;
    }),
    $queryRaw: jest.fn(async (s: TemplateStringsArray, ...values: any[]) => {
      const text = s.join("?");
      if (/PolicyValue/.test(text)) events.push("policy-sql");
      if (/UPDATE "Product"/.test(text)) {
        events.push("stock-update");
        const sql = values[0];
        stock.v -= Number(sql.values[1]);
        return [{ id: "prod-1", currentStock: D(stock.v) }];
      }
      return [{ max: null }];
    }),
    product: {
      ...(base as any).product,
      findMany: jest.fn(async () => [
        { id: "prod-1", name: "Widget", unit: "ea", currentStock: D(stock.v), unitsPerBox: null },
      ]),
      findFirst: jest.fn(async () => ({
        costingMethod: "AVCO",
        averageCost: D(1),
        standardCost: null,
      })),
    },
    stockLot: { findMany: jest.fn().mockResolvedValue([]) },
    stockMovement: {
      create: jest.fn(async (a: any) => {
        movements.push(a.data);
        return { id: "m" };
      }),
    },
  };
  Object.defineProperty(tx, "policyValue", {
    get() {
      events.push("policy-delegate");
      return {};
    },
  });
  return { tx, events, movements };
}
