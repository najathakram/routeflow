// B1201 - DB lane (NEED-DB: written, not run on the builder box). Mock InvoicesService/NotificationsService before they're imported — same ESM-traversal guards
// the unit-test harness uses (`@react-pdf/renderer` / `expo-server-sdk`).
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    reconcileOrderDraftInvoice: jest.fn().mockResolvedValue(null),
    resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([]),
    revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue([]),
    // forceConsolidateCustomer's loser-cleanup loop calls this unconditionally
    // (orders.service.ts:1103) — the unit-test harness's own InvoicesService mock
    // (testing/orders-service-harness.ts:102) already carries it; this manual mock missed it,
    // which is why F2's first run of (b) threw "findOpenOrderDraft is not a function".
    findOpenOrderDraft: jest.fn().mockResolvedValue(null),
    // #2696(c) SA-558e: createSale's step 3 (the invoice itself is not what these cases pin).
    createInvoiceFromOrder: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
  })),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({
    sendToCustomer: jest.fn().mockResolvedValue(undefined),
    sendToDriver: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { oversellReaderOffProvider } from "./testing/policy-reader-provider";
import { randomUUID } from "crypto";
import { Test, TestingModule } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { OrdersService } from "./orders.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const operatorPayload = {
  status: "ACTIVE" as const,
  forcePasswordChange: false,
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
};

describeDb(
  "B1201: a create-tail credit failure is healed by the keyed resubmit - real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let svc: OrdersService;
    let credits: CreditNotesService;
    let dbPrisma: PrismaService;
    let tenantCtx: TenantContextService;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-b1201-${run}`, "replay-create-credits.db.spec.ts");
    let tenantId = "";
    let product: { id: string };
    let n = 0;

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      dbPrisma = new PrismaService(tenantCtx);
      await dbPrisma.$connect();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          oversellReaderOffProvider,
          OrdersService,
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
            // B1201: the REAL credit service (its sync writes the OrderCreditNote intent) over the real DB;
            // its collaborators are never reached when the order has no invoice yet.
            provide: CreditNotesService,
            useFactory: (p: PrismaService) =>
              new CreditNotesService(p, {} as never, {} as never, {} as never, {} as never),
            inject: [PrismaService],
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
          {
            provide: RegulatedLedgerService,
            useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
          },
        ],
      }).compile();
      svc = module.get(OrdersService);
      credits = module.get(CreditNotesService);

      tenantId = (await raw.tenant.create({ data: { slug, name: `b1201 ${slug}` } })).id;
      const op = await raw.user.create({
        data: {
          email: `op-${run}@example.test`,
          username: `op-${run}`,
          role: "OPERATOR",
          tenantId,
        },
      });
      operatorPayload.sub = op.id;
      // list $10, tier-3 (special) $8
      product = await raw.product.create({
        data: {
          tenantId,
          name: `Tiered Widget ${run}`,
          sku: `tw-${run}`,
          unit: "each",
          pricePerUnit: "10",
          currentStock: 1000,
        },
      });
    }, 120_000);

    afterAll(async () => {
      const orders = await raw.order.findMany({ where: { tenantId }, select: { id: true } });
      const ids = orders.map((o) => o.id);
      await raw.orderCreditNote.deleteMany({ where: { tenantId } });
      await raw.creditNote.deleteMany({ where: { tenantId } });
      if (ids.length) await raw.orderItem.deleteMany({ where: { orderId: { in: ids } } });
      if (ids.length) await raw.order.deleteMany({ where: { id: { in: ids } } });
      await raw.customer.deleteMany({ where: { tenantId } });
      await raw.stockMovement.deleteMany({ where: { tenantId } });
      await raw.product.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { tenantId } });
      if (tenantId) await raw.tenant.deleteMany({ where: { id: tenantId } });
      await dbPrisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    async function customer() {
      const tag = `c${++n}`;
      const user = await raw.user.create({
        data: {
          email: `${tag}-${run}@example.test`,
          username: `${tag}-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      return raw.customer.create({
        data: { userId: user.id, businessName: `${tag} co`, contactName: "T", tenantId },
      });
    }
    const staff = () => ({ ...operatorPayload, tenantId }) as never;
    const create = (customerId: string, key: string, creditNoteId: string) =>
      tenantCtx.run(tenantId, () =>
        svc.create(
          {
            customerId,
            items: [{ productId: product.id, qty: 2 }],
            idempotencyKey: key,
            appliedCreditNotes: [{ creditNoteId, amount: 20 }],
          } as never,
          staff(),
        ),
      );
    const errorOf = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e) => e,
      );
    const conflict = () => Object.assign(new Error("write conflict"), { code: "P2034" });

    it("the credit tx exhausts once: 503 ORDER_SAVED_CREDITS_PENDING; the same-key resubmit applies the credit exactly once", async () => {
      const c = await customer();
      const note = await raw.creditNote.create({
        data: {
          tenantId,
          customerId: c.id,
          creditNoteNumber: `CN-${run}-${n}`,
          amount: "50",
          status: "ISSUED",
        },
      });
      const key = `b1201-${run}-1`;
      // retryCreditTx makes 3 attempts: fail all 3 to exhaust it, then the real sync runs.
      const spy = jest.spyOn(credits, "syncOrderCreditSelections");
      spy
        .mockRejectedValueOnce(conflict())
        .mockRejectedValueOnce(conflict())
        .mockRejectedValueOnce(conflict());
      const e: any = await errorOf(create(c.id, key, note.id));
      spy.mockRestore();
      expect(e?.getStatus?.()).toBe(503);
      const saved = await raw.order.findFirstOrThrow({ where: { tenantId, customerId: c.id } });
      expect(e.getResponse()).toMatchObject({
        code: "ORDER_SAVED_CREDITS_PENDING",
        orderId: saved.id,
      });
      expect(await raw.orderCreditNote.count({ where: { orderId: saved.id } })).toBe(0);

      const again = (await create(c.id, key, note.id)) as any;
      expect(again.id).toBe(saved.id);
      const rows = await raw.orderCreditNote.findMany({ where: { orderId: saved.id } });
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].amount)).toBe(20);

      // a third press (idempotent): still exactly one intent; no invoice yet, so nothing is spent
      await create(c.id, key, note.id);
      expect(await raw.orderCreditNote.count({ where: { orderId: saved.id } })).toBe(1);
      expect(await raw.order.count({ where: { tenantId, customerId: c.id } })).toBe(1);
      const after = await raw.creditNote.findUniqueOrThrow({ where: { id: note.id } });
      expect(Number(after.amountUsed)).toBe(0);
    }, 60_000);
  },
);
