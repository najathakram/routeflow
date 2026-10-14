// Units P0b (SA-759r) - DB lane, real Postgres: an OLD client's derived Piece (a 3-pack at $20, 2 pcs typed at the rounded
// $6.67) is stored as the PACK line's pieces and bills $13.33 through create(), an Idempotency-Key retry (no cartMismatch 409) and
// updateOrderItems(). Mock InvoicesService/NotificationsService before they are imported - same ESM-traversal guards as the unit harness.
// the unit-test harness uses (`@react-pdf/renderer` / `expo-server-sdk`).
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    reconcileOrderDraftInvoice: jest.fn().mockResolvedValue(null),
    resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([]),
    followPartialPrices: jest.fn().mockResolvedValue({ issuedPartialsUnchanged: [] }),
    projectEditedInvoiceTotals: jest.fn().mockResolvedValue([]),
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
  "Units P0b: a derived Piece from an old client is the pack's pieces on create, replay and edit - real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let svc: OrdersService;
    let dbPrisma: PrismaService;
    let tenantCtx: TenantContextService;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-p0b-${run}`, "derived-piece-lines.db.spec.ts");
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
              new CreditNotesService(
                p,
                { emitCreditNoteVoided: jest.fn() } as never,
                { unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined) } as never,
                {} as never,
                {} as never,
              ),
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

      tenantId = (await raw.tenant.create({ data: { slug, name: `p0b ${slug}` } })).id;
      const op = await raw.user.create({
        data: {
          email: `op-${run}@example.test`,
          username: `op-${run}`,
          role: "OPERATOR",
          tenantId,
        },
      });
      operatorPayload.sub = op.id;
      // a 3-pack at $20 with a Case of 12 (no price of its own): the base Piece is DERIVED, $20 / 3 = $6.67
      product = await raw.product.create({
        data: {
          tenantId,
          name: `Pack ${run}`,
          sku: `pk-${run}`,
          unit: "Pack",
          unitsPerBox: 3,
          pricePerUnit: "20.00",
          currentStock: 1000,
        },
      });
      await raw.productUnit.create({
        data: { tenantId, productId: product.id, label: "Case", factorToBase: 12 },
      });
    }, 120_000);

    afterAll(async () => {
      const orders = await raw.order.findMany({ where: { tenantId }, select: { id: true } });
      const ids = orders.map((o) => o.id);
      if (ids.length) await raw.orderItem.deleteMany({ where: { orderId: { in: ids } } });
      if (ids.length) await raw.order.deleteMany({ where: { id: { in: ids } } });
      await raw.customer.deleteMany({ where: { tenantId } });
      await raw.stockMovement.deleteMany({ where: { tenantId } });
      await raw.productUnit.deleteMany({ where: { tenantId } });
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
    const create = (customerId: string, items: unknown[], key?: string) =>
      tenantCtx.run(tenantId, () =>
        svc.create(
          { customerId, items, ...(key ? { idempotencyKey: key } : {}) } as never,
          staff(),
        ),
      );
    const lines = (orderId: string) =>
      raw.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
    // what an OLD client sends for 2 pieces: the derived Piece named by label, priced at the rounded per-piece price
    const oldClient = () => [
      { productId: product.id, qty: 2, unitLabel: "Piece", unitPrice: 6.67 },
    ];

    const expectPackPieces = (line: Awaited<ReturnType<typeof lines>>[number]) => {
      expect(line.unitLabel).toBeNull();
      expect({
        boxes: line.boxes,
        pieces: line.pieces,
        qty: Number(line.qty),
        upb: Number(line.unitsPerBox),
        unitPrice: Number(line.unitPrice),
        subtotal: Number(line.subtotal),
      }).toEqual({ boxes: 0, pieces: 2, qty: 2, upb: 3, unitPrice: 20, subtotal: 13.33 });
    };

    it("create: 2 pcs typed at $6.67 bill $20/3 x 2 = $13.33 as the pack's pieces, not 2 x $6.67", async () => {
      const c = await customer();
      const order = (await create(c.id, oldClient())) as { id: string };
      const [line] = await lines(order.id);
      expectPackPieces(line);
      expect(
        Number((await raw.order.findUniqueOrThrow({ where: { id: order.id } })).subtotal),
      ).toBe(13.33);
    });

    it("replay: the old client's retry of the same keyed create hands back the first order (no cartMismatch 409)", async () => {
      const c = await customer();
      const first = (await create(c.id, oldClient(), `k-${run}`)) as { id: string };
      const second = (await create(c.id, oldClient(), `k-${run}`)) as { id: string };
      expect(second.id).toBe(first.id);
      expect(await raw.order.count({ where: { customerId: c.id } })).toBe(1);
      // a different count under the same key is still a different cart
      await expect(
        create(
          c.id,
          [{ productId: product.id, qty: 3, unitLabel: "Piece", unitPrice: 6.67 }],
          `k-${run}`,
        ),
      ).rejects.toMatchObject({ response: { code: "IDEMPOTENCY_KEY_CART_MISMATCH" } });
    });

    it("edit: a pack line edited to 2 Piece at $6.67 (pre-lock AND in-tx rewrite) bills $13.33", async () => {
      const c = await customer();
      const order = (await create(c.id, [{ productId: product.id, qty: 3 }])) as { id: string };
      const [held] = await lines(order.id);
      await tenantCtx.run(tenantId, () =>
        svc.updateOrderItems(
          order.id,
          {
            replaceAll: false,
            items: [{ id: held.id, qty: 2, unitLabel: "Piece", unitPrice: 6.67 }],
          } as never,
          staff(),
        ),
      );
      const after = await lines(order.id);
      expect(after).toHaveLength(1);
      expectPackPieces(after[0]);
    });
  },
);
