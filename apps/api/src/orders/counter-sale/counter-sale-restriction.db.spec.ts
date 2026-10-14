/**
 * Row 510 (brief 3) - real-Postgres proof of the COUNTER sale and the staff restriction protocol, through the REAL
 * OrdersService.create with exactly the options the counter hands it (`counterSale: true`, `fulfillPath: PICKUP`, the
 * body's Idempotency-Key as `dto.idempotencyKey`, an `onReplay` guard) and the REAL SellingRestrictionsService:
 *
 *   store state   a counter sale is judged by the STORE (tenantBusinessState), never the customer's address: a CA customer
 *                 at a TX store sells a CA-banned product (no warning); a TX customer at a CA store, and the system walk-in
 *                 at a CA store, warn; a store with no state fails closed (the walk-in has no address of its own).
 *   idempotency   the first press warns (409 RESTRICTION_WARNING, nothing written, the key unused); the resubmit carries the
 *                 SAME Idempotency-Key plus the ack and creates the sale (stamped by the clicker, one audit row); a third
 *                 submit with the same key, with or without the ack, is a REPLAY of the same order (the ack is never part
 *                 of the key's cart comparison): no key conflict, no second order, no second stamp or audit row.
 *
 * Collected only by jest.db.config.js. One throwaway `qa-r510-<run>` tenant (assertTestTenant), purged in afterAll.
 */
jest.mock("../../invoices/invoices.service", () => ({
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
jest.mock("../../notifications/notifications.service", () => ({
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
import { Client, Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { OrdersService } from "../orders.service";
import { oversellReaderOffProvider } from "../testing/policy-reader-provider";
import { InvoicesService } from "../../invoices/invoices.service";
import { SystemConfigService } from "../../system-config/system-config.service";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { RouteFlowGateway } from "../../gateways/routeflow.gateway";
import { NotificationsService } from "../../notifications/notifications.service";
import { InventoryService } from "../../inventory/inventory.service";
import { AuthorizationGuardService } from "../../authorizations/authorization-guard.service";
import { SellingRestrictionsService } from "../../selling-restrictions/selling-restrictions.service";
import { ProductLabelsService } from "../../product-labels/product-labels.service";
import { PromotionsService } from "../../promotions/promotions.service";
import { MessagingService } from "../../messaging/messaging.service";
import { CreditNotesService } from "../../credit-notes/credit-notes.service";
import { CommissionEngineService } from "../../sales-agents/commission-engine.service";
import { EntitlementsService } from "../../billing/entitlements.service";
import { EntitlementAuthority } from "../../billing/entitlement-authority.service";
import { RegulatedLedgerService } from "../../regulated/regulated-ledger.service";
import {
  purgeOverrideWorld,
  seedOverrideWorld,
  setStoreState,
  staffPayload,
  type OverrideWorld,
} from "../../../test/restriction-override-fixture";

const RUN = randomUUID().slice(0, 8);
const REASON = "Licensed buyer, paperwork on file";

describeDb(
  "row 510 (brief 3): a counter sale warns, is judged at the store, and resubmits on one key",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let svc: OrdersService;
    let dbPrisma: PrismaService;
    let tenantCtx: TenantContextService;
    let w: OverrideWorld;
    let walkInId = "";

    const as = <T>(fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);
    const operator = () => staffPayload(w, "OPERATOR");
    const errOf = async (p: Promise<unknown>): Promise<any> => {
      try {
        await p;
      } catch (e) {
        return e;
      }
      throw new Error("expected a rejection");
    };
    const bodyOf = (e: any) => e.getResponse() as any;
    const ackFrom = (e: any) => ({
      warningHash: bodyOf(e).warningHash as string,
      restrictionOverrides: (bodyOf(e).lines as Array<{ lineKey: string }>).map((l) => ({
        lineKey: l.lineKey,
        reason: REASON,
      })),
    });
    /** What CounterSaleService.ring hands OrdersService.createSale -> create(): the counter's options, the key in the dto. */
    const ring = (
      customerId: string,
      key: string,
      ack: object = {},
      onReplay?: (o: unknown) => void,
    ) =>
      as(() =>
        svc.create(
          {
            customerId,
            items: [{ productId: w.banned, qty: 1 }],
            idempotencyKey: key,
            ...ack,
          } as never,
          operator(),
          { counterSale: true, fulfillPath: "PICKUP", onReplay } as never,
        ),
      );
    const orderCount = () => raw.order.count({ where: { tenantId: w.tenantId } });
    const audits = (orderId: string) =>
      raw.auditLog.findMany({
        where: {
          tenantId: w.tenantId,
          action: "selling_restriction.overridden",
          meta: { path: ["documentId"], equals: orderId },
        },
      });

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
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
      w = await seedOverrideWorld(raw, RUN, "counter-sale-restriction.db.spec.ts");
      // the tenant's system walk-in: no address of its own, judged at the store on any path
      const walkInUser = await raw.user.create({
        data: {
          email: `walkin-${RUN}@example.test`,
          username: `walkin-${RUN}`,
          role: "CUSTOMER",
          tenantId: w.tenantId,
        },
      });
      walkInId = (
        await raw.customer.create({
          data: {
            userId: walkInUser.id,
            businessName: "Counter walk-in",
            contactName: "R510",
            tenantId: w.tenantId,
            isWalkIn: true,
          },
        })
      ).id;
      await setStoreState(raw, w.tenantId, null);
    }, 120_000);

    afterAll(async () => {
      if (w?.tenantId) await purgeOverrideWorld(pool, w.tenantId);
      await dbPrisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    describe("the STORE's state judges a counter sale", () => {
      it("a CA customer at a TX store: no warning, no stamp (the customer's own address is not consulted)", async () => {
        await setStoreState(raw, w.tenantId, "TX");
        const order: any = await ring(w.caCustomerId, `k-tx-${RUN}`);
        const lines = await raw.orderItem.findMany({ where: { orderId: order.id } });
        expect(lines[0].restrictionOverrideAt).toBeNull();
        expect(await audits(order.id)).toHaveLength(0);
      });

      it("a TX customer at a CA store warns (basis STORE), and the stamp's audit row says STORE", async () => {
        await setStoreState(raw, w.tenantId, "CA");
        const e = await errOf(ring(w.txCustomerId, `k-ca-${RUN}`));
        expect(bodyOf(e).code).toBe("RESTRICTION_WARNING");
        expect(bodyOf(e).lines[0].rules[0].reasonText).toBe("This product is banned in CA by law.");
        const order: any = await ring(w.txCustomerId, `k-ca-${RUN}`, ackFrom(e));
        expect((await audits(order.id))[0].meta).toMatchObject({ basis: "STORE" });
      });

      it("the system walk-in at a CA store warns; at a TX store it sells; with no store state it fails closed", async () => {
        await setStoreState(raw, w.tenantId, "CA");
        expect(bodyOf(await errOf(ring(walkInId, `k-w1-${RUN}`))).code).toBe("RESTRICTION_WARNING");
        await setStoreState(raw, w.tenantId, "TX");
        const ok: any = await ring(walkInId, `k-w2-${RUN}`);
        expect(ok.id).toBeDefined();
        await setStoreState(raw, w.tenantId, null);
        const closed = await errOf(ring(walkInId, `k-w3-${RUN}`));
        expect(bodyOf(closed).code).toBe("RESTRICTION_WARNING"); // INDETERMINATE is still an acknowledgeable breach
        expect(bodyOf(closed).lines[0].outcome).toBe("INDETERMINATE");
        expect(bodyOf(closed).lines[0].rules[0].reasonText).toContain("store's state");
      });
    });

    describe("one Idempotency-Key across the warning and the resubmit", () => {
      const KEY = `k-idem-${RUN}`;

      it("the first press warns and writes nothing; the key stays unused", async () => {
        await setStoreState(raw, w.tenantId, "CA");
        const before = await orderCount();
        const e = await errOf(ring(w.caCustomerId, KEY));
        expect(bodyOf(e).code).toBe("RESTRICTION_WARNING");
        expect(await orderCount()).toBe(before);
        expect(
          await raw.order.count({ where: { tenantId: w.tenantId, idempotencyKey: KEY } }),
        ).toBe(0);
      });

      it("the resubmit (same key + ack) creates the sale; a third submit with or without the ack is a REPLAY, never a conflict", async () => {
        await setStoreState(raw, w.tenantId, "CA");
        const warning = await errOf(ring(w.caCustomerId, KEY));
        const ack = ackFrom(warning);
        const before = await orderCount();
        const first: any = await ring(w.caCustomerId, KEY, ack);
        expect(await orderCount()).toBe(before + 1);
        const lines = await raw.orderItem.findMany({ where: { orderId: first.id } });
        expect(lines[0]).toMatchObject({
          restrictionOverrideReason: REASON,
          restrictionOverrideBy: w.operatorId,
        });
        expect(await audits(first.id)).toHaveLength(1);

        // the same key + the same ack again (a retried request), and the same key with NO ack: both replay the order
        let replays = 0;
        const again: any = await ring(w.caCustomerId, KEY, ack, () => replays++);
        const bare: any = await ring(w.caCustomerId, KEY, {}, () => replays++);
        expect(again.id).toBe(first.id);
        expect(bare.id).toBe(first.id);
        expect(replays).toBe(2);
        expect(await orderCount()).toBe(before + 1); // no second order
        expect(await audits(first.id)).toHaveLength(1); // no second audit row
        expect(await raw.orderItem.count({ where: { orderId: first.id } })).toBe(1);
      });
    });
  },
);
