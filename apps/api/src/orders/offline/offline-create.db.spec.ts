/**
 * SA-1124 PR-1a - the `offline` create mode through the REAL OrdersService.create / changeStatus, real Postgres
 * (the row-510 world: real SellingRestrictionsService, rules, customers and products read from the database).
 *
 * Rows B1-B4, B8, B9, B10 and the promotion half of item 6 live here; the controller rows (B5-B7) are in
 * orders.controller.offline.spec.ts and the resolve / read rows (B11) at the bottom of this file.
 *
 * Each row first runs the SAME cart WITHOUT `offline` and pins what master does with it (the "master observed"
 * assertions), then runs it with `offline` and pins the new mode. The master assertions are green before and after
 * the code; the offline ones were recorded red before it (see the facts file).
 *
 * Collected only by jest.db.config.js. One throwaway `qa-r510-<run>` tenant approved by `assertTestTenant`.
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
import { ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { OrdersService } from "../orders.service";
import { resolveReviewFlag } from "./review-flags";
import { offlineCreateOptions, resolveOfflineRequest } from "./offline-create";
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
  staffPayload,
  type OverrideWorld,
} from "../../../test/restriction-override-fixture";

const RUN = randomUUID().slice(0, 8);
const ACK_REASON = "Licensed buyer, paperwork on file";

type QuoteLine = {
  index: number;
  unitPrice: number;
  unitsPerBox: number | null;
  unitLabel: string | null;
};
type Quote = { total: number; lines: QuoteLine[] };

describeDb("SA-1124 PR-1a: offline create mode - real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let svc: OrdersService;
  let dbPrisma: PrismaService;
  let tenantCtx: TenantContextService;
  let authGuard: { assertAuthorizedOrThrow: jest.Mock };
  let w: OverrideWorld;
  let pricey: string; // a $12.00 product
  let licensed: string; // a $10.00 product in a tracked category
  let trackedCategoryId: string;
  const url = () => requireLocalDatabaseUrl();

  const as = <T>(fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);
  const staff = () => staffPayload(w, "OPERATOR");
  const errOf = async (p: Promise<unknown>): Promise<any> => {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error("expected a rejection");
  };
  const bodyOf = (e: any) => e.getResponse() as any;
  const quoteOf = (total: number, lines: QuoteLine[]): Quote => ({ total, lines });
  const line = (index: number, unitPrice: number): QuoteLine => ({
    index,
    unitPrice,
    unitsPerBox: null,
    unitLabel: null,
  });
  /** The internal option the controller hands create() after its role and quote checks. */
  const offline = (
    quote: Quote,
    createdAt: Date | null = null,
    openOrderId: string | null = null,
  ) => ({
    skipAutoMerge: true,
    offline: { quote, createdAt, openOrderId },
  });
  const create = (d: object, options: object = {}) =>
    as(() => svc.create(d as never, staff(), options));
  const flagsOf = (orderId: string) =>
    raw.orderReviewFlag.findMany({
      where: { orderId },
      orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
    });
  const stockOf = async (productId: string) =>
    Number((await raw.product.findUniqueOrThrow({ where: { id: productId } })).currentStock);
  const statusOf = async (id: string) =>
    (await raw.order.findUniqueOrThrow({ where: { id } })).status;
  const promote = (orderId: string, body: object = {}) =>
    as(() => svc.changeStatus(orderId, { status: "PENDING", ...body } as never, staff()));
  const positioned = (orderId: string) =>
    raw.orderItem.findMany({ where: { orderId }, orderBy: { position: "asc" } });

  async function customer(tag: string, creditLimit?: number, state = "TX") {
    const user = await raw.user.create({
      data: {
        email: `${tag}-${RUN}@example.test`,
        username: `${tag}-${RUN}`,
        role: "CUSTOMER",
        tenantId: w.tenantId,
      },
    });
    const c = await raw.customer.create({
      data: {
        userId: user.id,
        businessName: `Offline ${tag} co`,
        contactName: "Tester",
        tenantId: w.tenantId,
        ...(creditLimit != null ? { creditLimit: creditLimit.toFixed(2) } : {}),
      },
    });
    await raw.customerAddress.create({
      data: {
        tenantId: w.tenantId,
        customerId: c.id,
        line1: "1 Test St",
        city: "Testville",
        state,
        stateCode: state,
        zip: "00000",
        isDefault: true,
        addressType: "BILLING",
      },
    });
    return c.id;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    dbPrisma = new PrismaService(tenantCtx);
    await dbPrisma.$connect();
    authGuard = { assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined) };
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
        { provide: AuthorizationGuardService, useValue: authGuard },
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
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    svc = module.get(OrdersService);
    w = await seedOverrideWorld(raw, RUN, "offline-create.db.spec.ts");
    // The credit gate is OFF by default: switch it on for THIS spec's tenant only (owner-only key in prod).
    await raw.systemConfig.create({
      data: { tenantId: w.tenantId, key: "credit_limit.enforce_new_orders", value: "true" },
    });
    pricey = (
      await raw.product.create({
        data: {
          tenantId: w.tenantId,
          name: `Pricey ${RUN}`,
          unit: "each",
          pricePerUnit: "12.00",
          currentStock: 1000,
        },
      })
    ).id;
    trackedCategoryId = (
      await raw.trackedCategory.create({
        data: { tenantId: w.tenantId, name: `Licensed ${RUN}`, requiresLicense: true },
      })
    ).id;
    licensed = (
      await raw.product.create({
        data: {
          tenantId: w.tenantId,
          name: `Licensed good ${RUN}`,
          unit: "each",
          pricePerUnit: "10.00",
          currentStock: 1000,
          trackedCategoryId,
        },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    if (w?.tenantId) await purgeOverrideWorld(pool, w.tenantId);
    await dbPrisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  afterEach(() => {
    jest.restoreAllMocks();
    authGuard.assertAuthorizedOrThrow.mockReset().mockResolvedValue(undefined);
  });

  describe("B1: a clean replay is one PENDING order, flags written once", () => {
    it("master: the cart makes a PENDING order; offline: the same, stamped with the device time and no flags", async () => {
      const cust = await customer("b1");
      const cart = { customerId: cust, items: [{ productId: w.clean, qty: 2 }] };
      const master: any = await create(cart);
      expect(master.status).toBe("PENDING"); // master observed
      const quote = quoteOf(Number(master.total), [line(0, 10)]);
      const deviceTime = new Date("2026-11-07T15:00:00.000Z");
      const first: any = await create(
        { ...cart, idempotencyKey: `b1-${RUN}` },
        offline(quote, deviceTime),
      );
      expect(first.status).toBe("PENDING");
      const row = await raw.order.findUniqueOrThrow({ where: { id: first.id } });
      expect(row.offlineCreatedAt).toEqual(deviceTime);
      expect(await flagsOf(first.id)).toHaveLength(0);
      // The lost-response resend: the same key and cart returns the same order and writes nothing more.
      const stockBefore = await stockOf(w.clean);
      const again: any = await create(
        { ...cart, idempotencyKey: `b1-${RUN}` },
        offline(quote, deviceTime),
      );
      expect(again.id).toBe(first.id);
      expect(await stockOf(w.clean)).toBe(stockBefore);
      expect(await flagsOf(first.id)).toHaveLength(0);
    }, 60_000);
  });

  describe("B2: the price moved offline", () => {
    it("master: no flag exists; offline: quote $10 vs server $12 flags that line only, a typed override line is not flagged, a replay writes no second set", async () => {
      const cust = await customer("b2");
      const cart = {
        customerId: cust,
        items: [
          { productId: pricey, qty: 1 },
          { productId: pricey, qty: 1, unitPrice: 9 }, // a staff-typed price: judged as online
        ],
      };
      const master: any = await create(cart);
      expect(master.status).toBe("PENDING"); // master observed: no flag, no refusal
      expect(Number(master.lineItems.find((l: any) => l.position === 0).unitPrice)).toBe(12);
      const quote = quoteOf(Number(master.total), [line(0, 10), line(1, 10)]);
      const o: any = await create({ ...cart, idempotencyKey: `b2-${RUN}` }, offline(quote));
      expect(o.status).toBe("PENDING");
      const flags = await flagsOf(o.id);
      const price = flags.filter((f) => f.kind === "PRICE_CHANGED_OFFLINE");
      expect(price).toHaveLength(1);
      expect(price[0].detail).toMatchObject({ lineIndex: 0, shown: 10, now: 12 });
      expect(price[0].tenantId).toBe(w.tenantId);
      const lines = await positioned(o.id);
      expect(price[0].orderItemId).toBe(lines[0].id);
      expect(flags.some((f) => f.orderItemId === lines[1].id)).toBe(false); // the typed line
      await create({ ...cart, idempotencyKey: `b2-${RUN}` }, offline(quote));
      expect(await flagsOf(o.id)).toHaveLength(flags.length); // flags written once
    }, 60_000);

    it("a unit or pack that differs from the server's snapshot raises the same kind with unitChanged", async () => {
      const cust = await customer("b2u");
      const cart = { customerId: cust, items: [{ productId: pricey, qty: 1 }] };
      const master: any = await create(cart);
      const quote = quoteOf(Number(master.total), [
        { index: 0, unitPrice: 12, unitsPerBox: 24, unitLabel: "Case" },
      ]);
      const o: any = await create(cart, offline(quote));
      const flags = (await flagsOf(o.id)).filter((f) => f.kind === "PRICE_CHANGED_OFFLINE");
      expect(flags).toHaveLength(1);
      expect(flags[0].detail).toMatchObject({ lineIndex: 0, unitChanged: true });
    }, 60_000);

    it("no line moved but the total did (tax or a promotion): one order-level flag", async () => {
      const cust = await customer("b2t");
      const cart = { customerId: cust, items: [{ productId: pricey, qty: 1 }] };
      const master: any = await create(cart);
      const quote = quoteOf(Number(master.total) + 0.5, [line(0, 12)]);
      const o: any = await create(cart, offline(quote));
      const flags = (await flagsOf(o.id)).filter((f) => f.kind === "PRICE_CHANGED_OFFLINE");
      expect(flags).toHaveLength(1);
      expect(flags[0].orderItemId).toBeNull();
      expect(flags[0].detail).toMatchObject({
        shownTotal: Number(master.total) + 0.5,
        nowTotal: Number(master.total),
      });
    }, 60_000);
  });

  describe("B3: a line restricted at replay is saved as a DRAFT", () => {
    it("master: the staff 409 RESTRICTION_WARNING; offline: a DRAFT, a RESTRICTED flag on the line, zero stock change", async () => {
      const cust = await customer("b3", undefined, "CA");
      const cart = {
        customerId: cust,
        items: [
          { productId: w.banned, qty: 2 },
          { productId: w.clean, qty: 1 },
        ],
      };
      const e = await errOf(create(cart));
      expect(e.getStatus()).toBe(409);
      expect(bodyOf(e).code).toBe("RESTRICTION_WARNING"); // master observed
      const stockBannedBefore = await stockOf(w.banned);
      const stockCleanBefore = await stockOf(w.clean);
      const o: any = await create(cart, offline(quoteOf(30, [line(0, 10), line(1, 10)])));
      expect(o.status).toBe("DRAFT");
      expect(await stockOf(w.banned)).toBe(stockBannedBefore);
      expect(await stockOf(w.clean)).toBe(stockCleanBefore);
      const lines = await positioned(o.id);
      const restricted = (await flagsOf(o.id)).filter((f) => f.kind === "RESTRICTED");
      expect(restricted).toHaveLength(1);
      expect(restricted[0].orderItemId).toBe(lines[0].id);
      expect(restricted[0].detail).toMatchObject({ lineIndex: 0, productId: w.banned });
    }, 60_000);

    it("a restrictionOverrides acknowledgement the client sent is honoured as online: PENDING, no RESTRICTED flag", async () => {
      const cust = await customer("b3ack", undefined, "CA");
      const cart = { customerId: cust, items: [{ productId: w.banned, qty: 1 }] };
      const e = await errOf(create(cart));
      const ack = {
        warningHash: bodyOf(e).warningHash as string,
        restrictionOverrides: (bodyOf(e).lines as Array<{ lineKey: string }>).map((l) => ({
          lineKey: l.lineKey,
          reason: ACK_REASON,
        })),
      };
      const o: any = await create({ ...cart, ...ack }, offline(quoteOf(10, [line(0, 10)])));
      expect(o.status).toBe("PENDING");
      expect((await flagsOf(o.id)).filter((f) => f.kind === "RESTRICTED")).toHaveLength(0);
      const rows = await raw.orderItem.findMany({ where: { orderId: o.id } });
      expect(rows[0].restrictionOverrideReason).toBe(ACK_REASON);
    }, 60_000);
  });

  describe("B4: license-blocked and over the credit limit become a DRAFT plus a flag", () => {
    const licenceError = () =>
      new ConflictException({
        code: "REGULATED_AUTH_REQUIRED",
        blockedCategories: [{ trackedCategoryId, categoryName: "Licensed", reason: "NO_AUTH" }],
      });

    it("license: master 409 REGULATED_AUTH_REQUIRED; offline: a DRAFT with LICENSE_REQUIRED on the licensed line", async () => {
      const cust = await customer("b4l");
      const cart = {
        customerId: cust,
        items: [
          { productId: w.clean, qty: 1 },
          { productId: licensed, qty: 1 },
        ],
      };
      authGuard.assertAuthorizedOrThrow.mockRejectedValueOnce(licenceError());
      const e = await errOf(create(cart));
      expect(bodyOf(e).code).toBe("REGULATED_AUTH_REQUIRED"); // master observed
      authGuard.assertAuthorizedOrThrow.mockRejectedValueOnce(licenceError());
      const o: any = await create(cart, offline(quoteOf(20, [line(0, 10), line(1, 10)])));
      expect(o.status).toBe("DRAFT");
      const lines = await positioned(o.id);
      const flags = (await flagsOf(o.id)).filter((f) => f.kind === "LICENSE_REQUIRED");
      expect(flags).toHaveLength(1);
      expect(flags[0].orderItemId).toBe(lines[1].id);
      expect(flags[0].detail).toMatchObject({ lineIndex: 1, trackedCategoryId });
    }, 60_000);

    it("credit: master 409 CREDIT_LIMIT_EXCEEDED; offline: a DRAFT with one order-level CREDIT_BLOCKED {limit, exposure}", async () => {
      const cust = await customer("b4c", 5);
      const cart = { customerId: cust, items: [{ productId: w.clean, qty: 2 }] };
      const e = await errOf(create(cart));
      expect(bodyOf(e).code).toBe("CREDIT_LIMIT_EXCEEDED"); // master observed
      const stockBefore = await stockOf(w.clean);
      const o: any = await create(
        cart,
        offline(quoteOf(Number(bodyOf(e).exposure), [line(0, 10)])),
      );
      expect(o.status).toBe("DRAFT");
      expect(await stockOf(w.clean)).toBe(stockBefore);
      const flags = (await flagsOf(o.id)).filter((f) => f.kind === "CREDIT_BLOCKED");
      expect(flags).toHaveLength(1);
      expect(flags[0].orderItemId).toBeNull();
      expect(flags[0].detail).toMatchObject({ limit: 5, exposure: Number(bodyOf(e).exposure) });
    }, 60_000);

    it("M1: offline + immediateDelivery + a routeRunId on an over-credit cart is refused 400 and stores no order (it was stored CONFIRMED, no gate passed)", async () => {
      const cust = await customer("b4m", 5);
      const route = await raw.route.create({
        data: { name: `sa1124-m1-${RUN}`, tenantId: w.tenantId } as any,
      });
      const run = await raw.routeRun.create({
        data: {
          tenantId: w.tenantId,
          routeId: route.id,
          scheduledDate: new Date("2026-11-09T00:00:00.000Z"),
          status: "SCHEDULED" as any,
        },
      });
      try {
        const dto = {
          customerId: cust,
          items: [{ productId: w.clean, qty: 2 }],
          routeRunId: run.id,
          immediateDelivery: true,
          offline: true,
          offlineQuote: quoteOf(22, [line(0, 10)]),
        };
        let stored = "refused";
        let refusal: any = null;
        try {
          const req = resolveOfflineRequest(dto as never, staff());
          const options = await as(() => offlineCreateOptions(svc, dto as never, staff(), req!));
          const o: any = await as(() => svc.create(dto as never, staff(), options));
          stored = o.status; // red today: the DRAFT the credit gate produced is overwritten with CONFIRMED
        } catch (e) {
          refusal = e;
        }
        expect(stored).toBe("refused");
        expect(refusal.getStatus()).toBe(400);
        expect(bodyOf(refusal).code).toBe("OFFLINE_IMMEDIATE_DELIVERY_ONLINE_ONLY");
        expect(await raw.order.count({ where: { customerId: cust } })).toBe(0);
      } finally {
        await raw.order.updateMany({ where: { routeRunId: run.id }, data: { routeRunId: null } });
        await raw.routeRun.delete({ where: { id: run.id } });
        await raw.route.delete({ where: { id: route.id } });
      }
    }, 60_000);

    it("a lost-response resend of an order the server saved as a DRAFT replays it (no 409 draft mismatch, no second set of flags)", async () => {
      const cust = await customer("b4r", 5);
      const cart = { customerId: cust, items: [{ productId: w.clean, qty: 2 }] };
      const quote = quoteOf(20, [line(0, 10)]);
      const first: any = await create({ ...cart, idempotencyKey: `b4r-${RUN}` }, offline(quote));
      expect(first.status).toBe("DRAFT");
      const before = await flagsOf(first.id);
      expect(before.length).toBeGreaterThan(0);
      const again: any = await create({ ...cart, idempotencyKey: `b4r-${RUN}` }, offline(quote));
      expect(again.id).toBe(first.id);
      expect(await flagsOf(first.id)).toHaveLength(before.length);
    }, 60_000);

    it("a gate error outside the four codes propagates unchanged", async () => {
      const cust = await customer("b4x");
      authGuard.assertAuthorizedOrThrow.mockRejectedValueOnce(new ConflictException("boom"));
      const e = await errOf(
        create(
          { customerId: cust, items: [{ productId: w.clean, qty: 1 }] },
          offline(quoteOf(10, [line(0, 10)])),
        ),
      );
      expect(e.message).toBe("boom");
    }, 60_000);
  });

  describe("B8: a deleted product is refused as online", () => {
    it("the same 400 with and without offline, and no order", async () => {
      const cust = await customer("b8");
      const cart = { customerId: cust, items: [{ productId: randomUUID(), qty: 1 }] };
      const m = await errOf(create(cart));
      const o = await errOf(create(cart, offline(quoteOf(10, [line(0, 10)]))));
      expect(m.getStatus()).toBe(400); // master observed
      expect(o.getStatus()).toBe(400);
      expect(o.message).toBe(m.message);
      expect(await raw.order.count({ where: { customerId: cust } })).toBe(0);
    }, 60_000);

    it("BACKORDERED_OFFLINE: a line created with backordered pieces gets the flag on that line; the order stays PENDING", async () => {
      const low = (
        await raw.product.create({
          data: {
            tenantId: w.tenantId,
            name: `Low stock ${RUN}`,
            unit: "each",
            pricePerUnit: "10.00",
            currentStock: 1,
          },
        })
      ).id;
      const cust = await customer("b8b");
      const o: any = await create(
        { customerId: cust, items: [{ productId: low, qty: 4 }] },
        offline(quoteOf(44, [line(0, 10)])),
      );
      const row = await raw.orderItem.findFirstOrThrow({ where: { orderId: o.id } });
      const backordered = Number(row.backorderedPieces);
      expect(backordered).toBeGreaterThan(0); // the column the flag reads
      expect(o.status).toBe("PENDING");
      const flags = (await flagsOf(o.id)).filter((f) => f.kind === "BACKORDERED_OFFLINE");
      expect(flags).toHaveLength(1);
      expect(flags[0].orderItemId).toBe(row.id);
      expect(flags[0].detail).toMatchObject({ lineIndex: 0, backorderedPieces: backordered });
    }, 60_000);
  });

  describe("B9: the device time changes no price or rule", () => {
    it("offlineCreatedAt two days ago: the same prices as the same cart without it, kept for display", async () => {
      const cust = await customer("b9");
      const cart = { customerId: cust, items: [{ productId: pricey, qty: 3 }] };
      const master: any = await create(cart);
      const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
      const o: any = await create(
        cart,
        offline(quoteOf(Number(master.total), [line(0, 12)]), twoDaysAgo),
      );
      expect(Number(o.total)).toBe(Number(master.total));
      expect(Number(o.lineItems[0].unitPrice)).toBe(Number(master.lineItems[0].unitPrice));
      const row = await raw.order.findUniqueOrThrow({ where: { id: o.id } });
      expect(row.offlineCreatedAt).toEqual(twoDaysAgo);
      expect(row.createdAt.getTime()).toBeGreaterThan(twoDaysAgo.getTime() + 86_000_000);
      expect(await flagsOf(o.id)).toHaveLength(0);
    }, 60_000);
  });

  describe("B10 (discriminating): promoting a draft", () => {
    it("a plain staff DRAFT over the limit still promotes (master); an offline DRAFT carrying CREDIT_BLOCKED is refused while still over, then promotes and resolves its gate flags", async () => {
      const plain = await customer("b10p", 5);
      const plainDraft: any = await create({
        customerId: plain,
        status: "DRAFT",
        items: [{ productId: w.clean, qty: 2 }],
      });
      await promote(plainDraft.id);
      expect(await statusOf(plainDraft.id)).toBe("PENDING"); // master observed: promotion has no credit gate

      const tight = await customer("b10o", 5);
      const cart = { customerId: tight, items: [{ productId: w.clean, qty: 2 }] };
      const draft: any = await create(cart, offline(quoteOf(22, [line(0, 10)])));
      expect(draft.status).toBe("DRAFT");
      const stockBefore = await stockOf(w.clean);
      const refused = await errOf(promote(draft.id));
      expect(bodyOf(refused).code).toBe("CREDIT_LIMIT_EXCEEDED");
      expect(await statusOf(draft.id)).toBe("DRAFT");
      expect(await stockOf(w.clean)).toBe(stockBefore);
      expect((await flagsOf(draft.id)).every((f) => f.resolvedAt === null)).toBe(true);

      await raw.customer.update({ where: { id: tight }, data: { creditLimit: "1000.00" } });
      await promote(draft.id);
      expect(await statusOf(draft.id)).toBe("PENDING");
      const flags = (await flagsOf(draft.id)).filter((f) => f.kind === "CREDIT_BLOCKED");
      expect(flags).toHaveLength(1);
      expect(flags[0].resolution).toBe("passed at promotion");
      expect(flags[0].resolvedById).toBe(w.operatorId);
      expect(flags[0].resolvedAt).toBeInstanceOf(Date);
    }, 90_000);

    it("a draft saved for a restriction promotes only through the warning; its RESTRICTED flag resolves when it passes", async () => {
      const cust = await customer("b10r", undefined, "CA");
      const cart = { customerId: cust, items: [{ productId: w.banned, qty: 1 }] };
      const draft: any = await create(cart, offline(quoteOf(11, [line(0, 10)])));
      expect(draft.status).toBe("DRAFT");
      const warned = await errOf(promote(draft.id));
      expect(bodyOf(warned).code).toBe("RESTRICTION_WARNING");
      expect((await flagsOf(draft.id)).filter((f) => f.resolvedAt === null).length).toBeGreaterThan(
        0,
      );
      await promote(draft.id, {
        warningHash: bodyOf(warned).warningHash,
        restrictionOverrides: bodyOf(warned).lines.map((l: any) => ({
          lineKey: l.lineKey,
          reason: ACK_REASON,
        })),
      });
      expect(await statusOf(draft.id)).toBe("PENDING");
      const restricted = (await flagsOf(draft.id)).filter((f) => f.kind === "RESTRICTED");
      expect(restricted).toHaveLength(1);
      expect(restricted[0].resolution).toBe("passed at promotion");
    }, 90_000);

    it("the manual kinds (price, open order) stay open through a promotion", async () => {
      const cust = await customer("b10m", 5);
      const open = await create({
        customerId: await customer("b10m-other"),
        items: [{ productId: w.clean, qty: 1 }],
      });
      const draft: any = await create(
        { customerId: cust, items: [{ productId: pricey, qty: 1 }] },
        offline(quoteOf(10, [line(0, 10)]), null, (open as any).id),
      );
      expect(draft.status).toBe("DRAFT"); // $12 plus tax against a $5 limit
      const kinds = (await flagsOf(draft.id)).map((f) => f.kind).sort();
      expect(kinds).toEqual(["CREDIT_BLOCKED", "OPEN_ORDER_EXISTS", "PRICE_CHANGED_OFFLINE"]);
      const exists = (await flagsOf(draft.id)).find((f) => f.kind === "OPEN_ORDER_EXISTS");
      expect(exists!.detail).toMatchObject({ existingOrderId: (open as any).id });
      await raw.customer.update({ where: { id: cust }, data: { creditLimit: "1000.00" } });
      await promote(draft.id);
      const after = await flagsOf(draft.id);
      expect(after.find((f) => f.kind === "CREDIT_BLOCKED")!.resolvedAt).toBeInstanceOf(Date);
      expect(after.find((f) => f.kind === "PRICE_CHANGED_OFFLINE")!.resolvedAt).toBeNull();
      expect(after.find((f) => f.kind === "OPEN_ORDER_EXISTS")!.resolvedAt).toBeNull();
    }, 90_000);
  });

  describe("B11: resolve a review flag, and read the flags", () => {
    const resolve = (
      orderId: string,
      flagId: string,
      resolution = "Checked the new price with the customer",
      user = staff(),
    ) => as(() => resolveReviewFlag(dbPrisma, { orderId, flagId, resolution, user }));

    it("PRICE_CHANGED_OFFLINE resolves with the actor and is idempotent; RESTRICTED is not manual; another tenant's flag is a 404", async () => {
      const cust = await customer("b11", undefined, "CA");
      const o: any = await create(
        {
          customerId: cust,
          items: [
            { productId: pricey, qty: 1 },
            { productId: w.banned, qty: 1 },
          ],
        },
        offline(quoteOf(22, [line(0, 10), line(1, 10)])),
      );
      const flags = await flagsOf(o.id);
      const price = flags.find((f) => f.kind === "PRICE_CHANGED_OFFLINE")!;
      const restricted = flags.find((f) => f.kind === "RESTRICTED")!;
      const done: any = await resolve(o.id, price.id);
      expect(done).toMatchObject({
        id: price.id,
        kind: "PRICE_CHANGED_OFFLINE",
        resolution: "Checked the new price with the customer",
        resolvedBy: { id: w.operatorId },
      });
      expect(done.resolvedAt).toBeTruthy();
      const second: any = await resolve(
        o.id,
        price.id,
        "A different note entirely",
        staffPayload(w, "TENANT_ADMIN"),
      );
      expect(second.resolution).toBe("Checked the new price with the customer"); // idempotent
      expect(second.resolvedBy.id).toBe(w.operatorId);
      const refused = await errOf(resolve(o.id, restricted.id));
      expect(refused.getStatus()).toBe(409);
      expect(bodyOf(refused).code).toBe("ORDER_REVIEW_FLAG_NOT_MANUAL");
      const still = await raw.orderReviewFlag.findUniqueOrThrow({ where: { id: restricted.id } });
      expect(still.resolvedAt).toBeNull();

      const other = await raw.tenant.create({
        data: { slug: `qa-r510-${RUN}-other`, name: "other" },
      });
      try {
        const ou = await raw.user.create({
          data: {
            email: `ou-${RUN}@example.test`,
            username: `ou-${RUN}`,
            role: "CUSTOMER",
            tenantId: other.id,
          },
        });
        const oc = await raw.customer.create({
          data: { userId: ou.id, businessName: "Other co", contactName: "X", tenantId: other.id },
        });
        const oo = await raw.order.create({
          data: { tenantId: other.id, customerId: oc.id, total: "1.00" },
        });
        const of = await raw.orderReviewFlag.create({
          data: { tenantId: other.id, orderId: oo.id, kind: "PRICE_CHANGED_OFFLINE", detail: {} },
        });
        expect((await errOf(resolve(oo.id, of.id))).getStatus()).toBe(404);
        const untouched = await raw.orderReviewFlag.findUniqueOrThrow({ where: { id: of.id } });
        expect(untouched.resolvedAt).toBeNull();
        // a flag id under another order of the right tenant is a 404 too
        expect((await errOf(resolve(o.id, of.id))).getStatus()).toBe(404);
      } finally {
        await purgeOverrideWorld(pool, other.id);
      }
    }, 90_000);

    it("GET /orders/:id carries the flags for staff and the list filters needsReview", async () => {
      const cust = await customer("b11r");
      const o: any = await create(
        { customerId: cust, items: [{ productId: pricey, qty: 1 }] },
        offline(quoteOf(10, [line(0, 10)])),
      );
      const detail: any = await as(() => svc.findOne(o.id, staff()));
      expect(detail.reviewFlags).toHaveLength(1);
      expect(detail.reviewFlags[0]).toMatchObject({
        kind: "PRICE_CHANGED_OFFLINE",
        resolvedAt: null,
        resolvedBy: null,
        resolution: null,
      });
      const listed: any = await as(() =>
        svc.findAll({ needsReview: true, limit: 100 } as never, staff()),
      );
      expect(listed.data.map((r: any) => r.id)).toContain(o.id);
      const plain: any = await create({
        customerId: cust,
        items: [{ productId: w.clean, qty: 1 }],
      });
      expect(listed.data.map((r: any) => r.id)).not.toContain(plain.id);
    }, 60_000);
  });
});
