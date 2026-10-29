/**
 * W-762 / SA-918 (real Postgres): an order's discount survives every re-total, and no customer-level merge runs while any
 * participant carries one.
 * - Edits (SA-918 §1, FIX): the item edit and the change-request apply re-total WITH the stored `discountAmount`, as
 *   create() and invoice generation already do: total = lines + tax − discount (head: lines + tax, over by the discount),
 *   and the order equals its draft invoice after the rebuild. An edit that shrinks the order below its discount is
 *   refused (B451) and writes nothing.
 * - SA-923 Fold 1: the CR apply equals Σ its draft invoices; a CR shrink below the discount is refused; the staff create
 *   beside a discounted open order is a separate order that stays mergeable later (Fold 2: no persisted skipAutoMerge).
 * - Merges (SA-918 §2, GUARD): force-consolidate with a discounted loser OR winner is 409 ORDER_MERGE_DISCOUNTED and
 *   moves nothing; the automatic merge (mergeAllPendingForCustomer: the post-commit fold, the buyer fold's sweep, the
 *   template cron and the hourly sweep all call it) skips and leaves the orders separate.
 *
 * Runs only under `npm run local:test:db`. The tenant is a throwaway `qa-w762-<run>` slug.
 */

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import { OrdersController } from "./orders.controller";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { Test } from "@nestjs/testing";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SNAPSHOT_RATE = 0.05;

describeDb(
  "W-762 / SA-918: the order discount survives re-totals; discounted merges are refused or skipped (real Postgres)",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    /** #3682 NIT-1: the REAL InvoicesService (wired as legacy-rebuild-ledger.db.spec.ts does), for R10b's rebook. */
    let realInvoices: InvoicesService;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-w762-${run}`, "order-discount-w762.db.spec.ts");
    let tenantId = "";
    let operatorUserId = "";
    let driverUserId = "";
    let buyerUserId = "";
    let driverId = "";
    let customerId = "";
    let categoryId = "";
    let productId = "";
    const routeIds: string[] = [];
    const warn = jest.spyOn(Logger.prototype, "warn");

    const operator = (): JwtPayload =>
      ({
        sub: operatorUserId,
        username: `op-${run}`,
        role: "OPERATOR",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;
    const driver = (): JwtPayload =>
      ({
        sub: driverUserId,
        username: `dr-${run}`,
        role: "DRIVER",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;

    const inTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
    const edit = (orderId: string, dto: any) =>
      inTenant(() => orders.updateOrderItems(orderId, dto, operator()));
    /** A real staff create: the writer stamps the trio at the category's rate AT THAT MOMENT. */
    const createOrder = async (qty: number, discountAmount = 0) => {
      const created: any = await inTenant(() =>
        orders.create({ customerId, items: [{ productId, qty }], discountAmount }, operator(), {
          skipAutoMerge: true,
        }),
      );
      await raw.orderItem.updateMany({ where: { orderId: created.id }, data: { deliveredQty: 0 } });
      await raw.order.update({ where: { id: created.id }, data: { skipAutoMerge: false } });
      return created.id as string;
    };
    async function wipe() {
      await raw.changeRequest.deleteMany({ where: { tenantId } });
      await raw.deliveryMutation.deleteMany({ where: { tenantId } });
      await raw.orderIdempotencyKey.deleteMany({ where: { tenantId } });
      const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
        (o) => o.id,
      );
      await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: ids } } });
      await raw.stockMovement.deleteMany({ where: { product: { tenantId } } });
      await raw.regulatedSalesLedger.deleteMany({ where: { tenantId } });
      await raw.invoiceItem.deleteMany({ where: { invoice: { tenantId } } });
      await raw.invoice.deleteMany({ where: { tenantId } });
      await raw.orderItem.deleteMany({ where: { tenantId } });
      await raw.order.deleteMany({ where: { tenantId } });
      await raw.routeRunStop.deleteMany({ where: { routeRun: { route: { tenantId } } } });
      await raw.routeRun.deleteMany({ where: { route: { tenantId } } });
      await raw.routeStop.deleteMany({ where: { route: { tenantId } } });
      await raw.route.deleteMany({ where: { tenantId } });
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const systemConfig = new SystemConfigService(
        prisma,
        new EncryptionService({ get: () => undefined } as any),
      );
      orders = Object.assign(Object.create(OrdersService.prototype), {
        prisma,
        gateway: {
          emitOrderCreated: jest.fn(),
          emitUrgentOrder: jest.fn(),
          emitOrderStatusChanged: jest.fn(),
          emitLowStock: jest.fn(),
        },
        notifications: {
          sendToCustomer: jest.fn().mockResolvedValue(undefined),
          sendToUser: jest.fn().mockResolvedValue(1),
        },
        messaging: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
        systemConfig,
        entitlements: { hasFlag: async () => true },
        sellingRestrictions: {
          getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
          assertLinesSellable: async () => undefined,
        },
        authGuard: { assertAuthorizedOrThrow: async () => undefined },
        promotionsService: { activeForCatalog: async () => [] },
        tenantCtx,
        ledger: new RegulatedLedgerService(prisma),
        invoicesService: {
          // R10 needs the REAL lookup: the merge deletes the loser's open DRAFT mirror it finds here.
          findOpenOrderDraft: async (orderId: string, tx?: any) =>
            (tx ?? prisma.forTenant()).invoice.findFirst({
              where: { orderId, status: "DRAFT", deliveryBatchId: null },
              orderBy: { createdAt: "asc" },
            }),
          revertLinkedInvoicesForOrderEdit: async () => undefined,
          resyncOrderInvoicesForEdit: async () => [],
          ...INVOICE_EDIT_STUBS,
          reconcileOrderDraftInvoice: async () => undefined,
          releaseWalletPaymentsInTx: async () => undefined,
          voidInvoiceInTx: async () => undefined,
        },
        creditNotes: {
          settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
          previewOrderCreditRelease: async () => [],
          releaseOrderCreditsInTx: async () => undefined,
        },
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        oversellReader: { read: async () => false },
      });

      const invoicesMod = await Test.createTestingModule({
        providers: [
          InvoicesService,
          {
            provide: SellingRestrictionsService,
            useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
          },
          EstimatesService,
          NumberingService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: RouteFlowGateway,
            useValue: {
              emitInvoiceUpdated: jest.fn(),
              emitOrderCreated: jest.fn(),
              emitOrderStatusChanged: jest.fn(),
              emitLowStock: jest.fn(),
              emitStopCompleted: jest.fn(),
              emitUrgentOrder: jest.fn(),
            },
          },
          {
            provide: EmailService,
            useValue: {
              sendInvoice: jest.fn(),
              isEmailConfigured: jest.fn().mockResolvedValue(true),
            },
          },
          { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
          {
            provide: SystemConfigService,
            useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
          },
          RegulatedLedgerService,
          {
            provide: AuthorizationGuardService,
            useValue: {
              assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
              checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
            },
          },
          {
            provide: CreditNotesService,
            useValue: {
              autoApplyOldestCreditsInTx: jest
                .fn()
                .mockResolvedValue({ applied: 0, invoiceStatus: null }),
              settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
              releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
            },
          },
          {
            provide: MessagingService,
            useValue: { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() },
          },
          {
            provide: StorageService,
            useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
          },
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
          },
          entitlementAuthorityFromEntitlements,
          {
            provide: CommissionEngineService,
            useValue: {
              syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
              syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
              removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
            },
          },
        ],
      }).compile();
      realInvoices = invoicesMod.get(InvoicesService);

      tenantId = (await raw.tenant.create({ data: { slug, name: `683 ${slug}` } })).id;
      operatorUserId = (
        await raw.user.create({
          data: {
            email: `op-${run}@example.test`,
            username: `op-${run}`,
            role: "OPERATOR",
            tenantId,
          },
        })
      ).id;
      const buyer = await raw.user.create({
        data: {
          email: `buyer-${run}@example.test`,
          username: `buyer-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      buyerUserId = buyer.id;
      customerId = (
        await raw.customer.create({
          data: { userId: buyer.id, businessName: "Acme Retail", contactName: "Tester", tenantId },
        })
      ).id;
      driverUserId = (
        await raw.user.create({
          data: {
            email: `dr-${run}@example.test`,
            username: `dr-${run}`,
            role: "DRIVER",
            tenantId,
          },
        })
      ).id;
      driverId = (await raw.driver.create({ data: { userId: driverUserId, tenantId } as any })).id;
      categoryId = (
        await raw.trackedCategory.create({
          data: {
            tenantId,
            name: `Excise ${run}`,
            taxType: "EXCISE_PER_UNIT",
            rate: SNAPSHOT_RATE,
            priceIncludesTax: false,
          },
        })
      ).id;
      productId = (
        await raw.product.create({
          data: {
            name: `Cigar ${run}`,
            unit: "each",
            pricePerUnit: "1.00",
            currentStock: 1000,
            tenantId, // not regulated: the totals here are lines − discount
          },
        })
      ).id;
    }, 120_000);

    beforeEach(async () => {
      warn.mockClear();
      await wipe();
      await raw.trackedCategory.update({
        where: { id: categoryId },
        data: { rate: SNAPSHOT_RATE },
      });
      await raw.product.update({ where: { id: productId }, data: { currentStock: 1000 } });
    });

    afterAll(async () => {
      try {
        await wipe();
        await raw.auditLog.deleteMany({ where: { tenantId } });
        await raw.driver.deleteMany({ where: { tenantId } });
        await raw.productUnit.deleteMany({ where: { tenantId } });
        await raw.product.deleteMany({ where: { tenantId } });
        await raw.trackedCategory.deleteMany({ where: { tenantId } });
        await raw.customer.deleteMany({ where: { tenantId } });
        await raw.user.deleteMany({ where: { tenantId } });
        await raw.tenant.deleteMany({ where: { id: tenantId } });
      } finally {
        warn.mockRestore();
        await _resetLockPoolForTests();
        await prisma?.$disconnect();
        await raw?.$disconnect();
        await pool?.end();
      }
    }, 120_000);

    const orderRow = (id: string) => raw.order.findUniqueOrThrow({ where: { id } });
    const n = (v: unknown) => Number(v);
    /** Run `fn` with the REAL invoice service behind the orders service (create the draft, rebuild it on the edit). */
    async function withRealInvoices<T>(fn: () => Promise<T>): Promise<T> {
      const stubbed = orders.invoicesService;
      orders.invoicesService = realInvoices;
      try {
        return await fn();
      } finally {
        orders.invoicesService = stubbed;
      }
    }

    it("E1: an item edit on an order discounted 10 re-totals as lines − 10, and the order equals its draft invoice", async () => {
      const id = await createOrder(20, 10);
      expect(n((await orderRow(id)).total)).toBe(10); // create() already carries it
      await withRealInvoices(async () => {
        await inTenant(() => realInvoices.createInvoiceFromOrder(id));
        const [line] = await raw.orderItem.findMany({ where: { orderId: id } });
        await edit(id, { replaceAll: false, items: [{ id: line.id, qty: 30 }] });
      });
      const after = await orderRow(id);
      expect(n(after.subtotal)).toBe(30);
      expect(n(after.total)).toBe(20); // head: 30 (the discount dropped)
      const live = await raw.invoice.findMany({
        where: { orderId: id, status: { notIn: ["VOID", "WRITTEN_OFF"] } },
      });
      expect(live.reduce((s, i) => s + n(i.total), 0)).toBe(20);
    }, 120_000);

    it("E3: an edit that shrinks the order below its discount is refused (B451) and writes nothing", async () => {
      const id = await createOrder(20, 10);
      const [line] = await raw.orderItem.findMany({ where: { orderId: id } });
      const err: any = await edit(id, {
        replaceAll: false,
        items: [{ id: line.id, qty: 5 }],
      }).catch((e: unknown) => e);
      expect(err?.getStatus?.()).toBe(400);
      expect(err.getResponse()).toMatchObject({ code: "MONEY_INVARIANT" });
      expect(n((await raw.orderItem.findUniqueOrThrow({ where: { id: line.id } })).qty)).toBe(20);
      expect(n((await orderRow(id)).total)).toBe(10);
    }, 120_000);

    /** Put the order on an IN_PROGRESS run's stop, so a driver's change request can be approved at it. */
    async function atStop(id: string) {
      const route = await raw.route.create({ data: { name: `r-${run}-${id}`, tenantId } as any });
      routeIds.push(route.id);
      const routeStop = await raw.routeStop.create({
        data: { tenantId, routeId: route.id, stopNumber: 1, customerId } as any,
      });
      const rr = await raw.routeRun.create({
        data: {
          tenantId,
          routeId: route.id,
          scheduledDate: new Date("2026-10-23T00:00:00.000Z"),
          status: "IN_PROGRESS" as any,
          driverId,
        },
      });
      const stop = await raw.routeRunStop.create({
        data: {
          tenantId,
          routeRunId: rr.id,
          routeStopId: routeStop.id,
          stopNumber: 1,
          status: "PENDING" as any,
        } as any,
      });
      await raw.order.update({
        where: { id },
        data: { routeRunId: rr.id, routeRunStopId: stop.id },
      });
      return stop.id;
    }
    const changeRequest = (
      id: string,
      stopId: string,
      type: string,
      payload: object,
      orderItemId?: string,
    ) =>
      raw.changeRequest.create({
        data: {
          tenantId,
          orderId: id,
          productId,
          routeRunStopId: stopId,
          type: type as any,
          payload,
          orderItemId,
        },
      });
    const liveInvoiceTotal = async (id: string) =>
      (
        await raw.invoice.findMany({
          where: { orderId: id, status: { notIn: ["VOID", "WRITTEN_OFF"] } },
        })
      ).reduce((s, i) => s + n(i.total), 0);

    it("E2: a change-request apply on a discounted order re-totals as lines − discount, and the order equals Σ its draft invoices (SA-923)", async () => {
      const id = await createOrder(20, 10);
      const stopId = await atStop(id);
      const cr = await changeRequest(id, stopId, "ADD_ITEM", { productId, qty: 5 });
      await withRealInvoices(async () => {
        await inTenant(() => realInvoices.createInvoiceFromOrder(id));
        await inTenant(() => orders.approveChangeRequestAtStop(cr.id, driver()));
      });
      const after = await orderRow(id);
      expect(n(after.subtotal)).toBe(25);
      expect(n(after.total)).toBe(15); // head: 25
      expect(await liveInvoiceTotal(id)).toBe(15);
    }, 120_000);

    it("E4 (SA-923): a change request that shrinks the order below its discount is refused (B451) and writes nothing", async () => {
      const id = await createOrder(20, 10);
      const stopId = await atStop(id);
      const [line] = await raw.orderItem.findMany({ where: { orderId: id } });
      const cr = await changeRequest(id, stopId, "CHANGE_QTY", { newQty: 5 }, line.id);
      const err: any = await inTenant(() =>
        orders.approveChangeRequestAtStop(cr.id, driver()),
      ).catch((e: unknown) => e);
      expect(err?.getStatus?.()).toBe(400);
      expect(err.getResponse()).toMatchObject({ code: "MONEY_INVARIANT" });
      expect(n((await raw.orderItem.findUniqueOrThrow({ where: { id: line.id } })).qty)).toBe(20);
      expect(n((await orderRow(id)).total)).toBe(10);
      expect((await raw.changeRequest.findUniqueOrThrow({ where: { id: cr.id } })).status).toBe(
        "PENDING",
      );
    }, 120_000);

    it("S (SA-923): a staff create beside a discounted open order is created separately, and NOT opted out of future merges", async () => {
      const open = await createOrder(4, 3);
      const before = await orderRow(open);
      const controller = new OrdersController(orders, {} as any, {} as any, {} as any);
      const created: any = await inTenant(() =>
        controller.create(
          { customerId, items: [{ productId, qty: 2 }], mergeChoice: "merge" } as any,
          operator(),
        ),
      );
      expect(created.id).not.toBe(open);
      expect(await raw.order.count({ where: { tenantId } })).toBe(2);
      expect((await orderRow(created.id)).skipAutoMerge).toBe(false); // head: true (opted out of every future merge)
      const after = await orderRow(open);
      expect([n(after.total), n(after.discountAmount)]).toEqual([n(before.total), 3]);
    }, 120_000);

    const twoOrders = async (winnerDiscount: number, loserDiscount: number) => {
      // The newest order is the winner (readMergeGroup orders by updatedAt desc).
      const loser = await createOrder(4, loserDiscount);
      const winner = await createOrder(6, winnerDiscount);
      await raw.order.update({ where: { id: winner }, data: { updatedAt: new Date() } });
      return { winner, loser };
    };
    const snapshot = async () =>
      (
        await raw.order.findMany({
          where: { tenantId },
          include: { lineItems: true },
          orderBy: { id: "asc" },
        })
      ).map((o) => [
        o.id,
        n(o.total),
        n(o.discountAmount),
        o.lineItems.map((l) => [l.id, n(l.qty)]),
      ]);

    it.each([
      ["a discounted LOSER", 0, 3],
      ["a discounted WINNER", 4, 0],
    ])(
      "M: force-consolidate with %s is 409 ORDER_MERGE_DISCOUNTED and moves nothing",
      async (_n, w, l) => {
        await twoOrders(w, l);
        const before = await snapshot();
        const err: any = await inTenant(() => orders.forceConsolidateCustomer(customerId)).catch(
          (e: unknown) => e,
        );
        expect(err?.getStatus?.()).toBe(409);
        expect(err.getResponse()).toMatchObject({ code: "ORDER_MERGE_DISCOUNTED" });
        expect(await snapshot()).toEqual(before);
      },
      120_000,
    );

    it("A: the automatic merge (mergeAllPendingForCustomer) skips a discounted group: no fold, both orders stay", async () => {
      await twoOrders(0, 3);
      const before = await snapshot();
      const merged = await inTenant(() => orders.mergeAllPendingForCustomer(customerId));
      expect(merged).toBeNull();
      expect(await snapshot()).toEqual(before);
    }, 120_000);

    it("guard: with no discount anywhere the automatic merge still folds (one order left)", async () => {
      await twoOrders(0, 0);
      const merged: any = await inTenant(() => orders.mergeAllPendingForCustomer(customerId));
      expect(merged).not.toBeNull();
      expect(await raw.order.count({ where: { tenantId } })).toBe(1);
    }, 120_000);
  },
);
