/**
 * Row 672 / SA-844 — real-Postgres twin of `no-state-remedy.sa844.spec.ts`, THROUGH OrdersService.create with the REAL
 * SellingRestrictionsService (rules, labels, addresses and the owner-only switch read from the database):
 *
 *   R1  DELIVERY, STAFF, switch ON, a customer with no address, legal CA ban -> 409 RESTRICTION_WARNING, the line
 *       INDETERMINATE with `remedy: ADD_CUSTOMER_STATE` + `customerId`; 0 orders written.
 *   R2  as R1, the default address's state "California" unnormalised (`stateNeedsReview`) -> same as R1.
 *   R3  as R1 with the switch OFF -> the order is written, no warning (owner ruling 09-25).
 *   R5  an order-less staff judgement (no customer) -> INDETERMINATE, no remedy.
 *   R6  the customer gets NV (not banned) -> the order is written; CA (banned) -> BLOCK, no remedy.
 *   +   a counter sale with no store state -> `remedy: ADD_STORE_STATE`, no customer id.
 *
 * Collected only by jest.db.config.js (`RUN_DB_SPECS=local npx jest -c jest.db.config.js --runInBand <this file>`).
 * NOT RUN in the authoring environment (no Postgres on the MacBook): the Windows DB lane runs it. One throwaway
 * `qa-r510-<run>` tenant (the shared row-510 fixture) approved by `assertTestTenant`, deleted in afterAll.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    reconcileOrderDraftInvoice: jest.fn().mockResolvedValue(null),
    resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([]),
    followPartialPrices: jest.fn().mockResolvedValue({ issuedPartialsUnchanged: [] }),
    projectEditedInvoiceTotals: jest.fn().mockResolvedValue([]),
    revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue([]),
    findOpenOrderDraft: jest.fn().mockResolvedValue(null),
    createInvoiceFromOrder: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
    voidInvoiceInTx: jest.fn().mockResolvedValue({ id: "inv-1", status: "VOID" }),
  })),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({
    sendToCustomer: jest.fn().mockResolvedValue(undefined),
    sendToDriver: jest.fn().mockResolvedValue(undefined),
    sendToUser: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { randomUUID } from "crypto";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { OrdersService } from "../orders/orders.service";
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { InventoryService } from "../inventory/inventory.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { SellingRestrictionsService } from "./selling-restrictions.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { PromotionsService } from "../promotions/promotions.service";
import { MessagingService } from "../messaging/messaging.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { assertSafeTextCell } from "../common/safe-text-cell";
import {
  purgeOverrideWorld,
  seedOverrideWorld,
  setStoreState,
  staffPayload,
  type OverrideWorld,
} from "../../test/restriction-override-fixture";

const RUN = randomUUID().slice(0, 8);

describeDb(
  "row 672 / SA-844: a sale whose state can't be resolved names its remedy — real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let svc: OrdersService;
    let restrictions: SellingRestrictionsService;
    let dbPrisma: PrismaService;
    let tenantCtx: TenantContextService;
    let w: OverrideWorld;
    const url = () => requireLocalDatabaseUrl();

    const as = <T>(fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);
    const errOf = async (p: Promise<unknown>): Promise<any> => {
      try {
        await p;
      } catch (e) {
        return e;
      }
      throw new Error("expected a rejection");
    };
    const bodyOf = (e: any) => e.getResponse() as any;
    const orderCount = (customerId: string) =>
      raw.order.count({ where: { tenantId: w.tenantId, customerId } });
    const create = (customerId: string, options: object = {}) =>
      as(() =>
        svc.create(
          { customerId, items: [{ productId: w.banned, qty: 1 }] } as never,
          staffPayload(w),
          options,
        ),
      );

    /** A customer of the test tenant with the given addresses (none = no address at all). */
    async function mkCustomer(
      key: string,
      addresses: Array<{ state: string; stateCode: string | null; stateNeedsReview?: boolean }>,
    ) {
      assertSafeTextCell({
        businessName: `R672 ${key} co`,
        contactName: "Tester",
        city: "Testville",
      });
      const userId = (
        await raw.user.create({
          data: {
            email: `r672-${key}-${RUN}@example.test`,
            username: `r672-${key}-${RUN}`,
            role: "CUSTOMER",
            tenantId: w.tenantId,
          },
        })
      ).id;
      const id = (
        await raw.customer.create({
          data: {
            userId,
            businessName: `R672 ${key} co`,
            contactName: "Tester",
            tenantId: w.tenantId,
          },
        })
      ).id;
      for (const a of addresses) await setDefaultAddress(id, a);
      return id;
    }
    async function setDefaultAddress(
      customerId: string,
      a: { state: string; stateCode: string | null; stateNeedsReview?: boolean },
    ) {
      await raw.customerAddress.deleteMany({ where: { tenantId: w.tenantId, customerId } });
      await raw.customerAddress.create({
        data: {
          tenantId: w.tenantId,
          customerId,
          line1: "1 Test St",
          city: "Testville",
          state: a.state,
          stateCode: a.stateCode,
          stateNeedsReview: a.stateNeedsReview ?? false,
          zip: "00000",
          isDefault: true,
          addressType: "BILLING",
        },
      });
    }
    const setSwitch = (on: boolean) =>
      raw.systemConfig.updateMany({
        where: { tenantId: w.tenantId, key: "selling_restrictions.enabled" },
        data: { value: on ? "true" : "false" },
      });

    beforeAll(async () => {
      pool = new Pool({ connectionString: url() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      dbPrisma = new PrismaService(tenantCtx);
      await dbPrisma.$connect();
      const module = await Test.createTestingModule({
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
        ],
      }).compile();
      svc = module.get(OrdersService);
      restrictions = module.get(SellingRestrictionsService);
      w = await seedOverrideWorld(raw, RUN, "no-state-remedy.sa844.db.spec.ts");
      await setStoreState(raw, w.tenantId, null);
    }, 120_000);

    afterAll(async () => {
      if (w?.tenantId) await purgeOverrideWorld(pool, w.tenantId);
      await dbPrisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    afterEach(() => jest.restoreAllMocks());

    it("R1: a staff delivery sale to a customer with no address warns INDETERMINATE with ADD_CUSTOMER_STATE and writes nothing", async () => {
      const c = await mkCustomer("noaddr", []);
      const e = await errOf(create(c));
      expect(e.getStatus()).toBe(409);
      expect(bodyOf(e)).toMatchObject({
        code: "RESTRICTION_WARNING",
        lines: [
          {
            productId: w.banned,
            outcome: "INDETERMINATE",
            remedy: "ADD_CUSTOMER_STATE",
            customerId: c,
          },
        ],
      });
      expect(await orderCount(c)).toBe(0);
    });

    it('R2: a default address whose state "California" awaits review is the same as R1', async () => {
      const c = await mkCustomer("review", [
        { state: "California", stateCode: null, stateNeedsReview: true },
      ]);
      const e = await errOf(create(c));
      expect(bodyOf(e).lines).toEqual([
        expect.objectContaining({
          outcome: "INDETERMINATE",
          remedy: "ADD_CUSTOMER_STATE",
          customerId: c,
        }),
      ]);
      expect(await orderCount(c)).toBe(0);
    });

    it("R3: with the owner-only switch OFF the staff sale is not judged: the order is written, no warning", async () => {
      const c = await mkCustomer("switchoff", []);
      await setSwitch(false);
      try {
        await create(c);
        expect(await orderCount(c)).toBe(1);
      } finally {
        await setSwitch(true);
      }
    });

    it("R5: an order-less staff judgement (no customer) is INDETERMINATE with no remedy", async () => {
      const e = await errOf(
        as(() =>
          restrictions.assertLinesSellable({
            tenantId: w.tenantId,
            customerId: null,
            lines: [{ productId: w.banned, lineKey: "n:0" }],
            channel: "STAFF",
            principal: staffPayload(w),
            document: "ORDER",
            fulfilmentKind: "DELIVERY",
          }),
        ),
      );
      const line = bodyOf(e).lines[0];
      expect(line.outcome).toBe("INDETERMINATE");
      expect(line).not.toHaveProperty("remedy");
      expect(line).not.toHaveProperty("customerId");
    });

    it("R6: after adding NV (not banned) the same sale is written; with CA (banned) it is a BLOCK with no remedy", async () => {
      const c = await mkCustomer("later", []);
      expect(bodyOf(await errOf(create(c))).lines[0].remedy).toBe("ADD_CUSTOMER_STATE");
      await setDefaultAddress(c, { state: "NV", stateCode: "NV" });
      await create(c); // re-judged live: no warning
      expect(await orderCount(c)).toBe(1);
      await setDefaultAddress(c, { state: "CA", stateCode: "CA" });
      const line = bodyOf(await errOf(create(c))).lines[0];
      expect(line.outcome).toBe("BLOCK");
      expect(line).not.toHaveProperty("remedy");
      expect(await orderCount(c)).toBe(1);
    });

    it("a counter sale with no store state names ADD_STORE_STATE and no customer", async () => {
      await setStoreState(raw, w.tenantId, null);
      const e = await errOf(create(w.txCustomerId, { counterSale: true }));
      const line = bodyOf(e).lines[0];
      expect(line).toMatchObject({ outcome: "INDETERMINATE", remedy: "ADD_STORE_STATE" });
      expect(line).not.toHaveProperty("customerId");
    });
  },
);
