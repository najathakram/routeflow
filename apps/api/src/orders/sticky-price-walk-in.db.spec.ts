/**
 * SA-1068 (W-1052) — real Postgres. A counter price edit above list is remembered per customer and a later line with no
 * price books at it. Every walk-in sale shares ONE customer, so one clerk's one-off reached strangers. The remembered
 * price must not exist for a walk-in (S1-S3, S6) and must stay for a named customer, `isWalkIn` null OR false (S4, S5:
 * the column is `Boolean?` and most customers hold null, so a plain `isWalkIn: false` filter would wipe their memory).
 * Test tenant only (`qa-sticky-<run>`). Run via `npm run local:test:db`.
 */
/**
 * #2696(c) F2 — the one staff override rule (SA-558 / 558b / 558d) on REAL Postgres, asserting the
 * STORED columns:
 *   - create(): a special-tier customer's off-tier price WITH a reason persists DISCOUNTED / MANUAL,
 *     originalPrice = list, the rounded price, the trimmed reason and overriddenBy; without one it
 *     is a 400 and nothing is written; the tier price itself stays SPECIAL with no reason;
 *   - add-during-edit: a typed tier price with no reason is a 200 (SA-558b(2)), classification
 *     unchanged (MANUAL, originalPrice = catalog);
 *   - parity (SA-558d): the same staff payload to a fresh order and folded into a pending one
 *     (the create auto-merge, isCreateMerge) stores the same priceType / originalPrice /
 *     overrideReason / overriddenBy / unitPrice.
 * Harness copied from next-delivery-pack.db.spec.ts. Run via `npm run local:test:db`.
 * Test tenant only (`qa-*`, enforced by assertTestTenant).
 */

// Mock InvoicesService/NotificationsService before they're imported — same ESM-traversal guards
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
import { CustomerUnitPricesService } from "../customers/customer-unit-prices.service";
import { assertWalkInTenderCoversTotal } from "./counter-sale/counter-sale-payment";

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
  "SA-1068 a remembered price above list: not for a walk-in, kept for a named customer",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let svc: OrdersService;
    let dbPrisma: PrismaService;
    let tenantCtx: TenantContextService;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-sticky-${run}`, "sticky-price-walk-in.db.spec.ts");
    let tenantId = "";
    let product: { id: string };
    let premium: { id: string };
    let promotions: { activeForCatalog: jest.Mock };
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
          {
            provide: RegulatedLedgerService,
            useValue: {
              reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined),
              settleRegulatedLedger: jest
                .fn()
                .mockResolvedValue({ written: 0, amendedPeriod: null }),
            },
          },
        ],
      }).compile();
      svc = module.get(OrdersService);
      promotions = module.get(PromotionsService) as never;

      tenantId = (await raw.tenant.create({ data: { slug, name: `ovr2696 ${slug}` } })).id;
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
          priceTier3: "8",
          currentStock: 1000,
        },
      });
      // SA-1072: list $10, tier-3 $12, a tier above Retail
      premium = await raw.product.create({
        data: {
          tenantId,
          name: `Premium Widget ${run}`,
          sku: `pw-${run}`,
          unit: "each",
          pricePerUnit: "10",
          priceTier3: "12",
          currentStock: 1000,
        },
      });
    }, 120_000);

    afterAll(async () => {
      const orders = await raw.order.findMany({ where: { tenantId }, select: { id: true } });
      const ids = orders.map((o) => o.id);
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

    /** A customer of this run's tenant: tier 1 (list) unless told, `isWalkIn` unset (null) unless told. */
    async function customer(opts: { walkIn?: boolean | null; tier?: number } = {}) {
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
        data: {
          userId: user.id,
          businessName: `${tag} co`,
          contactName: "T",
          tenantId,
          pricingTier: opts.tier ?? 1,
          ...(opts.walkIn === undefined ? {} : { isWalkIn: opts.walkIn }),
        },
      });
    }

    const staff = () => ({ ...operatorPayload, tenantId }) as never;
    const create = (customerId: string, item: Record<string, unknown>) =>
      tenantCtx.run(tenantId, () =>
        svc.create(
          { customerId, items: [{ productId: product.id, qty: 2, ...item }] } as never,
          staff(),
        ),
      );
    const lineOf = async (orderId: string) =>
      raw.orderItem.findFirstOrThrow({ where: { orderId, productId: product.id } });
    const cols = (l: Record<string, any>) => ({
      unitPrice: Number(l.unitPrice),
      priceType: l.priceType,
      originalPrice: l.originalPrice == null ? null : Number(l.originalPrice),
      overrideReason: l.overrideReason ?? null,
      overriddenBy: l.overriddenBy ?? null,
    });
    const counterOpts = (hook?: (t: { total: number }) => void) => ({
      skipAutoMerge: true,
      counterSale: true,
      ...(hook ? { beforeWrite: hook } : {}),
    });
    /** The clerk's one-off: a typed price above list (list is $10), saved with its original price. */
    const clerkUpsell = async (customerId: string, price = 15) => {
      const o = (await tenantCtx.run(tenantId, () =>
        svc.create(
          { customerId, items: [{ productId: product.id, qty: 1, unitPrice: price }] } as never,
          staff(),
          counterOpts() as never,
        ),
      )) as any;
      const line = await lineOf(o.id);
      expect(cols(line)).toMatchObject({
        unitPrice: price,
        priceType: "MANUAL",
        originalPrice: 10,
      });
      return o;
    };
    /** The next sale: no price on the line, as the till sends it. */
    const nextSale = (customerId: string, hook?: (t: { total: number }) => void, qty = 2) =>
      tenantCtx.run(tenantId, () =>
        svc.create(
          { customerId, items: [{ productId: product.id, qty }] } as never,
          staff(),
          counterOpts(hook) as never,
        ),
      ) as Promise<any>;

    it("S1: a walk-in sale with no price books at the shelf price, not at another walk-in's one-off", async () => {
      const w = await customer({ walkIn: true });
      await clerkUpsell(w.id);
      const next = await nextSale(w.id);
      expect(cols(await lineOf(next.id))).toMatchObject({ unitPrice: 10, priceType: "STANDARD" });
      expect(Number(next.total)).toBe(20);
    });

    it("S2: the total a CARD sale with no amount books is the shelf total", async () => {
      const w = await customer({ walkIn: true });
      await clerkUpsell(w.id);
      let seen = -1;
      const next = await nextSale(w.id, ({ total }) => (seen = total));
      expect(seen).toBe(20);
      expect(Number(next.total)).toBe(20);
    });

    it("S3: a CASH sale tendered at the shelf total is accepted", async () => {
      const w = await customer({ walkIn: true });
      await clerkUpsell(w.id);
      await expect(
        nextSale(w.id, ({ total }) =>
          assertWalkInTenderCoversTotal({ method: "CASH", amount: 20 }, total),
        ),
      ).resolves.toMatchObject({ status: expect.any(String) });
    });

    it.each([
      ["isWalkIn null", null],
      ["isWalkIn false", false],
    ])("S4: a named customer (%s) keeps a remembered price above list", async (_label, flag) => {
      const c = await customer({ walkIn: flag as boolean | null });
      await clerkUpsell(c.id);
      const next = await nextSale(c.id);
      expect(cols(await lineOf(next.id))).toMatchObject({ unitPrice: 15, priceType: "MANUAL" });
      expect(Number(next.total)).toBe(30);
    });

    it("T30 (SA-1068 A-5): a builder line with no price books the memory, and one sent at list books list for that order", async () => {
      const c = await customer({ walkIn: false });
      const order = (unitPrice?: number) =>
        tenantCtx.run(tenantId, () =>
          svc.create(
            {
              customerId: c.id,
              items: [
                { productId: product.id, qty: 2, ...(unitPrice == null ? {} : { unitPrice }) },
              ],
            } as never,
            staff(),
            { skipAutoMerge: true } as never,
          ),
        ) as Promise<any>;
      await clerkUpsell(c.id);
      const atMemory = await order();
      expect(cols(await lineOf(atMemory.id))).toMatchObject({ unitPrice: 15, priceType: "MANUAL" });
      const atList = await order(10);
      expect(cols(await lineOf(atList.id))).toMatchObject({ unitPrice: 10, priceType: "STANDARD" });
      expect(Number(atList.total)).toBe(20);
      // A list line carries no originalPrice, so it isn't a memory row: the upsell is still the newest one.
      const after = await order();
      expect(cols(await lineOf(after.id))).toMatchObject({ unitPrice: 15, priceType: "MANUAL" });
    });

    it("T36 (SA-1068 A-6): a Piece line with no price books the memory, prorated", async () => {
      const c = await customer({ walkIn: false });
      const box = await raw.product.create({
        data: {
          tenantId,
          name: `Boxed Widget ${run}`,
          sku: `bw-${run}`,
          unit: "box",
          unitsPerBox: 6,
          pricePerUnit: "12",
          currentStock: 1000,
        },
      });
      const order = (item: Record<string, unknown>) =>
        tenantCtx.run(tenantId, () =>
          svc.create(
            { customerId: c.id, items: [{ productId: box.id, ...item }] } as never,
            staff(),
            { skipAutoMerge: true } as never,
          ),
        ) as Promise<any>;
      await order({ qty: 6, boxes: 1, pieces: 0, unitPrice: 15 });
      const piece = await order({ qty: 1, boxes: 0, pieces: 1 });
      const line = await raw.orderItem.findFirstOrThrow({ where: { orderId: piece.id } });
      expect(cols(line)).toMatchObject({ unitPrice: 15, priceType: "MANUAL" });
      expect(Number(line.subtotal)).toBe(2.5);
    });

    it("S5: the server's price history and a buyer's own order for a named customer still read the memory", async () => {
      const c = await customer();
      await clerkUpsell(c.id);
      const history = await tenantCtx.run(tenantId, () => svc.getCustomerPriceHistory(c.id));
      expect(history[product.id]).toMatchObject({ lastPrice: 15, listPriceAtTime: 10 });
      const user = await raw.customer.findUniqueOrThrow({
        where: { id: c.id },
        select: { userId: true },
      });
      const buyer = { ...operatorPayload, role: "CUSTOMER", sub: user.userId, tenantId } as never;
      const order = (await tenantCtx.run(tenantId, () =>
        svc.create(
          { customerId: c.id, items: [{ productId: product.id, qty: 1 }] } as never,
          buyer,
          { skipAutoMerge: true } as never,
        ),
      )) as any;
      expect(cols(await lineOf(order.id))).toMatchObject({ unitPrice: 15, priceType: "MANUAL" });
    });

    it("S6: the units v2 Customer view shows no remembered price for a walk-in, and still shows it for a named customer", async () => {
      const view = new CustomerUnitPricesService(dbPrisma);
      const sources = async (customerId: string) =>
        (
          await tenantCtx.run(tenantId, () => view.get(customerId, { productId: product.id }))
        ).products
          .flatMap((p) => p.rows)
          .map((r) => r.source);
      const walkIn = await customer({ walkIn: true });
      await clerkUpsell(walkIn.id);
      const named = await customer();
      await clerkUpsell(named.id);
      expect(await sources(walkIn.id)).not.toContain("history");
      expect(await sources(named.id)).toContain("history");
    });

    describe("SA-1072 B316: a tier price above Retail stays a tier price", () => {
      /** A sale of the $10 list, $12 tier-3 product. No price on the line unless told. */
      const sale = (customerId: string, item: Record<string, unknown> = {}, user = staff()) =>
        tenantCtx.run(tenantId, () =>
          svc.create(
            { customerId, items: [{ productId: premium.id, qty: 1, ...item }] } as never,
            user,
            { skipAutoMerge: true } as never,
          ),
        ) as Promise<any>;
      const line = async (order: { id: string }) =>
        cols(
          await raw.orderItem.findFirstOrThrow({
            where: { orderId: order.id, productId: premium.id },
          }),
        );

      it("B2: a second line for a tier customer stays SPECIAL", async () => {
        const c = await customer({ tier: 3 });
        expect(await line(await sale(c.id))).toMatchObject({
          unitPrice: 12,
          priceType: "SPECIAL",
          originalPrice: 10,
        });
        expect(await line(await sale(c.id))).toMatchObject({ unitPrice: 12, priceType: "SPECIAL" });
      });

      it("B19 guard: staff still read the tier line as SPECIAL over list", async () => {
        const c = await customer({ tier: 3 });
        const order = await sale(c.id);
        const read = (await tenantCtx.run(tenantId, () => svc.findOne(order.id, staff()))) as any;
        const seen = read.lineItems.find((l: any) => l.productId === premium.id);
        expect(seen.priceType).toBe("SPECIAL");
        expect(Number(seen.originalPrice)).toBe(10);
      });

      it("B3: a customer moved to Retail gets Retail on the next line", async () => {
        const c = await customer({ tier: 3 });
        await sale(c.id);
        await raw.customer.update({ where: { id: c.id }, data: { pricingTier: 1 } });
        expect(await line(await sale(c.id))).toMatchObject({
          unitPrice: 10,
          priceType: "STANDARD",
        });
      });

      it("B4: a live promotion reaches a tier customer's own order", async () => {
        const c = await customer({ tier: 3 });
        await sale(c.id);
        const user = await raw.customer.findUniqueOrThrow({
          where: { id: c.id },
          select: { userId: true },
        });
        const buyer = { ...operatorPayload, role: "CUSTOMER", sub: user.userId, tenantId } as never;
        promotions.activeForCatalog.mockResolvedValue([
          {
            id: "b4-promo",
            type: "PERCENT",
            value: 10,
            minQty: null,
            scope: "ALL",
            category: null,
            productIds: [],
          },
        ]);
        try {
          expect(await line(await sale(c.id, {}, buyer))).toMatchObject({
            unitPrice: 10.8,
            priceType: "PROMO",
          });
        } finally {
          promotions.activeForCatalog.mockResolvedValue([]);
        }
      });

      it("B5 guard: a price staff typed above list keeps sticking", async () => {
        const c = await customer();
        await sale(c.id, { unitPrice: 15 });
        expect(await line(await sale(c.id))).toMatchObject({ unitPrice: 15, priceType: "MANUAL" });
      });

      it("B6 guard: a newer SPECIAL line ends an upsell, and an older MANUAL line never comes back", async () => {
        const c = await customer();
        await sale(c.id, { unitPrice: 15 });
        const newer = await sale(c.id);
        await raw.orderItem.updateMany({
          where: { orderId: newer.id, productId: premium.id },
          data: { unitPrice: "8", priceType: "SPECIAL", originalPrice: "10" },
        });
        expect(await line(await sale(c.id))).toMatchObject({
          unitPrice: 10,
          priceType: "STANDARD",
        });
      });

      it("B7 guard: a price staff typed for a tier customer sticks", async () => {
        const c = await customer({ tier: 3 });
        // A tier customer's price change needs a reason, by the staff-override rule.
        await sale(c.id, { unitPrice: 11, overrideReason: "Agreed for this account" });
        expect(await line(await sale(c.id))).toMatchObject({ unitPrice: 11, priceType: "MANUAL" });
      });
    });
  },
);
