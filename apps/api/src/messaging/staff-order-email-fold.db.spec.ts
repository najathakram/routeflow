/**
 * SA-1063 A-1 — when the NEW order wins the fold, on real Postgres. The merge sweep keeps the newest order and
 * deletes the older ones, so an order the office was told about can vanish into a new number. A mocked survivor
 * cannot show this (#4008's R6 spec proved it), so every row here runs the REAL merge, the REAL delivery rows
 * (`EmailDelivery`) and the REAL controllers' wiring (`pendingOrdersOf` before the sweep).
 *
 *   R6a  POST orders/ as CUSTOMER, second cart      -> one BUYER_ORDER_EDITED on the new order naming both numbers
 *   R6b  buyer reorder with a told order pending    -> as R6a
 *   R6c  template generate as CUSTOMER              -> as R6a
 *   R6d  buyer POST orders (findActiveOrder null)   -> as R6a
 *   R6e  third cart after R6a                       -> ORD-3 replaces ORD-2 (an edit row counts as told)
 *   R6f  replay of the same cart (one key)          -> nothing new
 *   R6g  buyer fold into the open order             -> one edit, number unchanged, no "replaces"
 *   R6h  forceNew second cart                       -> two new-order emails, both numbers stay
 *   R6i  folded order the office was never told of  -> a new-order email, no number named
 *   R6j  sweep deferred (the merge lock is held)    -> a new-order email, both orders exist
 *   R6k  pendingOrdersOf throws                     -> the order still lands (201), a new-order email
 *   R6l  env off; env dark                          -> no read and no rows; WOULD_SEND of the edit kind
 *
 * SAFETY: one throwaway `qa-sa1063-fold-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes exactly the
 * rows this run created, in FK order.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PrismaClient, UserRole } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests, withAdvisoryLock } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { OrdersController } from "../orders/orders.controller";
import { BuyerController } from "../buyer/buyer.controller";
import { RegulatedVisibilityService } from "../buyer/regulated-visibility.service";
import { OrderTemplatesService } from "../order-templates/order-templates.service";
import { OrderTemplatesController } from "../order-templates/order-templates.controller";
import { EmailDeliveryService } from "../email/email-delivery.service";
import { StaffOrderEmailService } from "./staff-order-email";
import { INVOICE_EDIT_STUBS } from "../orders/testing/invoice-edit-stubs";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const UNIT_PRICE = 10;

describeDb("SA-1063 A-1 — the new order wins the fold, real merge, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  let staff: StaffOrderEmailService;
  let ordersCtl: any;
  let buyerCtl: any;
  let tplCtl: any;
  let policyMode = "on";
  let sentMail: Array<{ subject: string; html: string; kind: string; entityId: string }> = [];
  const pending: Array<Promise<unknown>> = [];
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-sa1063-fold-${run}`, "staff-order-email-fold.db.spec.ts");
  let tenantId = "";
  let buyerUserId = "";
  let customerId = "";
  let productId = "";
  let templateId = "";
  let buyerJwt: JwtPayload;

  const bctx = () => ({
    customerId,
    tenantId,
    tenantSlug: slug,
    userId: buyerUserId,
    customer: { id: customerId, businessName: `Acme ${run}` },
  });
  const cart = (qty = 3) => ({ items: [{ productId, qty }] });
  const inTenant = (fn: () => Promise<any>): Promise<any> =>
    tenantCtx.run(tenantId, fn) as Promise<any>;
  /** Wait for the void-fired office emails of the call just made. */
  const settle = async () => {
    await Promise.all(pending.splice(0));
  };
  const postOrder = async (dto: Record<string, unknown>, key?: string) => {
    const out = await inTenant(() => ordersCtl.create(dto, buyerJwt, key));
    await settle();
    return out as { id: string; orderNumber: string };
  };
  const rows = async () =>
    (
      await raw.emailDelivery.findMany({
        where: { tenantId, entityType: "Order" },
        orderBy: { createdAt: "asc" },
        select: { kind: true, entityId: true, status: true },
      })
    ).map((r) => ({ kind: r.kind as string, entityId: r.entityId as string, status: r.status }));
  /** One office email = one row per recipient; the rows of a kind on one order, deduped to a count of sets. */
  const kindsOn = async (id: string) => [
    ...new Set((await rows()).filter((r) => r.entityId === id).map((r) => r.kind)),
  ];
  const orderCount = () => raw.order.count({ where: { tenantId } });
  const numberOf = async (id: string) =>
    (await raw.order.findUniqueOrThrow({ where: { id } })).orderNumber as string;

  async function wipe() {
    const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
      (o) => o.id,
    );
    await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: ids } } });
    await raw.emailDelivery.deleteMany({ where: { tenantId } });
    await raw.stockMovement.deleteMany({ where: { productId } });
    await raw.orderItem.deleteMany({ where: { tenantId } });
    await raw.order.deleteMany({ where: { tenantId } });
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
      tenantCtx,
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
      featureConfig: { getEffectiveMode: async () => "on" },
      entitlements: { hasFlag: async () => true },
      sellingRestrictions: {
        getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
        assertLinesSellable: async () => undefined,
        checkLinesSellable: async () => ({ outcome: "ALLOW", reasons: [] }),
      },
      authGuard: { assertAuthorizedOrThrow: async () => undefined },
      promotionsService: { activeForCatalog: async () => [] },
      invoicesService: {
        findOpenOrderDraft: async () => null,
        revertLinkedInvoicesForOrderEdit: async () => undefined,
        resyncOrderInvoicesForEdit: async () => [],
        ...INVOICE_EDIT_STUBS,
        reconcileOrderDraftInvoice: async () => undefined,
      },
      creditNotes: {
        validateSelectionsForCustomer: async () => undefined,
        settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      oversellReader: { read: async () => ({ allowOversell: true }) },
    });

    // The real service over the real delivery writer; only the mail transport is a stub that records like the real
    // EmailService does (a row per recipient), so "told" is read from real rows.
    const deliveries = new EmailDeliveryService(prisma);
    const email = {
      send: jest.fn(async (a: any) => {
        sentMail.push({
          subject: a.subject,
          html: a.html,
          kind: a.delivery.kind,
          entityId: a.delivery.entityId,
        });
        await deliveries.record({ ...a.delivery, toAddress: a.to, status: "SENT" });
        return { delivered: true, transport: "smtp" };
      }),
    };
    const policies = { resolve: jest.fn(async () => policyMode) };
    staff = new StaffOrderEmailService(prisma, email as any, deliveries, policies as any);
    const templates = new OrderTemplatesService(
      prisma,
      tenantCtx,
      orders,
      { checkAuthorized: async () => ({ blocked: [] }) } as any,
      { sendToCustomer: jest.fn().mockResolvedValue(undefined) } as any,
      { get: jest.fn().mockResolvedValue("0") } as any,
      {
        assertLinesSellable: jest.fn().mockResolvedValue(undefined),
        checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
      } as any,
      { read: async () => "off" } as any,
      new RegulatedVisibilityService(prisma),
    );
    ordersCtl = Object.assign(Object.create(OrdersController.prototype), {
      ordersService: orders,
      staffOrderEmail: staff,
      logger: new Logger("OrdersController"),
    });
    buyerCtl = Object.assign(Object.create(BuyerController.prototype), {
      prisma,
      ordersService: orders,
      templatesService: templates,
      oversellReader: { read: async () => "off" },
      staffOrderEmail: staff,
      logger: new Logger("BuyerController"),
    });
    tplCtl = Object.assign(Object.create(OrderTemplatesController.prototype), {
      service: templates,
      staffOrderEmail: staff,
    });

    tenantId = (await raw.tenant.create({ data: { slug, name: `SA1063 ${slug}` } })).id;
    await raw.user.create({
      data: {
        email: `admin-${run}@example.test`,
        username: `admin-${run}`,
        role: "TENANT_ADMIN",
        tenantId,
      },
    });
    buyerUserId = (
      await raw.user.create({
        data: {
          email: `b-${run}@example.test`,
          username: `b-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId: buyerUserId, businessName: `Acme ${run}`, contactName: "T", tenantId },
      })
    ).id;
    productId = (
      await raw.product.create({
        data: {
          name: `Bread ${run}`,
          unit: "Each",
          pricePerUnit: String(UNIT_PRICE),
          currentStock: "100000",
          tenantId,
        },
      })
    ).id;
    templateId = (
      await raw.orderTemplate.create({
        data: {
          tenantId,
          customerId,
          name: `Std ${run}`,
          daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
          createdByRole: UserRole.CUSTOMER,
          itemsEditedByRole: UserRole.CUSTOMER,
          items: { create: [{ tenantId, productId, qty: 2 }] },
        },
      })
    ).id;
    buyerJwt = {
      sub: buyerUserId,
      email: `b-${run}@example.test`,
      role: "CUSTOMER",
      tenantId,
    } as unknown as JwtPayload;
  }, 120_000);

  beforeEach(async () => {
    await wipe();
    sentMail = [];
    policyMode = "on";
    process.env.STAFF_ORDER_EMAIL = "on";
    // Re-armed per test (afterEach restores every spy): collect the void-fired sends so `settle()` can await them.
    const real = StaffOrderEmailService.prototype.notifyBuyerOrderPlaced;
    jest.spyOn(staff, "notifyBuyerOrderPlaced").mockImplementation((...a) => {
      const p = real.apply(staff, a);
      pending.push(p);
      return p;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.STAFF_ORDER_EMAIL;
  });

  afterAll(async () => {
    try {
      await wipe();
      await raw.orderTemplateItem.deleteMany({ where: { tenantId } });
      await raw.orderTemplate.deleteMany({ where: { tenantId } });
      await raw.auditLog.deleteMany({ where: { tenantId } });
      await raw.product.deleteMany({ where: { tenantId } });
      await raw.customer.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
    } finally {
      await _resetLockPoolForTests();
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }
  }, 120_000);

  it("R6a: POST orders/ as CUSTOMER, second cart -> one edit email naming both numbers, no second new-order", async () => {
    const first = await postOrder(cart());
    expect(await kindsOn(first.id)).toEqual(["STAFF_NEW_ORDER"]);
    const firstNo = await numberOf(first.id);

    const second = await postOrder(cart());

    expect(second.id).not.toBe(first.id);
    expect(await orderCount()).toBe(1); // the older order was folded away: the NEW one survives
    expect(await kindsOn(second.id)).toEqual(["BUYER_ORDER_EDITED"]);
    const edit = sentMail.filter((m) => m.entityId === second.id);
    expect(edit).toHaveLength(1);
    expect(edit[0].subject).toBe(
      `Order ${await numberOf(second.id)} replaces ${firstNo} - Acme ${run}`,
    );
    expect(edit[0].html).toContain("The customer's orders were combined.");
  }, 120_000);

  it("R6b: buyer reorder with a told order pending -> as R6a", async () => {
    const first = await postOrder(cart());
    const firstNo = await numberOf(first.id);

    const out = await inTenant(() => buyerCtl.reorderFromTemplate(templateId, bctx()));
    await settle();

    expect(await orderCount()).toBe(1);
    expect(await kindsOn(out.id)).toEqual(["BUYER_ORDER_EDITED"]);
    expect(sentMail.find((m) => m.entityId === out.id)!.subject).toContain(`replaces ${firstNo}`);
  }, 120_000);

  it("R6c: template generate as CUSTOMER with a told order pending -> as R6a", async () => {
    const first = await postOrder(cart());
    const firstNo = await numberOf(first.id);

    const out = await inTenant(() => tplCtl.generateOrder(templateId, buyerJwt));
    await settle();

    expect(await orderCount()).toBe(1);
    expect(await kindsOn(out.id)).toEqual(["BUYER_ORDER_EDITED"]);
    expect(sentMail.find((m) => m.entityId === out.id)!.subject).toContain(`replaces ${firstNo}`);
  }, 120_000);

  it("R6d: buyer POST orders on the post-create path (no open order found) -> as R6a", async () => {
    const first = await postOrder(cart());
    const firstNo = await numberOf(first.id);
    jest.spyOn(orders, "findActiveOrder").mockResolvedValue(null);

    const out = await inTenant(() => buyerCtl.createOrder(cart(), bctx(), `k-${run}-d`));
    await settle();

    expect(await orderCount()).toBe(1);
    expect(await kindsOn(out.id)).toEqual(["BUYER_ORDER_EDITED"]);
    expect(sentMail.find((m) => m.entityId === out.id)!.subject).toContain(`replaces ${firstNo}`);
  }, 120_000);

  it("R6e: a third cart -> the third replaces the second (an edit row counts as told)", async () => {
    await postOrder(cart());
    const second = await postOrder(cart());
    const secondNo = await numberOf(second.id);

    const third = await postOrder(cart());

    expect(await orderCount()).toBe(1);
    expect(await kindsOn(third.id)).toEqual(["BUYER_ORDER_EDITED"]);
    expect(sentMail.find((m) => m.entityId === third.id)!.subject).toBe(
      `Order ${await numberOf(third.id)} replaces ${secondNo} - Acme ${run}`,
    );
  }, 120_000);

  it("R6f: a replay of a cart (one Idempotency-Key) tells the office nothing new", async () => {
    const key = `k-${run}-f`;
    const first = await postOrder(cart(), key);
    const mailBefore = sentMail.length;
    const rowsBefore = (await rows()).length;

    const replay = await postOrder(cart(), key);

    expect(replay.id).toBe(first.id);
    expect(sentMail).toHaveLength(mailBefore);
    expect(await rows()).toHaveLength(rowsBefore);
  }, 120_000);

  it("R6f2: after a fold, a replay of the folded cart's key is refused and tells the office nothing", async () => {
    await postOrder(cart());
    const key = `k-${run}-f2`;
    await postOrder(cart(), key); // the new order wins: it now holds both carts' lines
    const mailBefore = sentMail.length;
    const rowsBefore = (await rows()).length;

    await expect(postOrder(cart(), key)).rejects.toThrow(/Idempotency-Key reused/);

    await settle();
    expect(sentMail).toHaveLength(mailBefore);
    expect(await rows()).toHaveLength(rowsBefore);
  }, 120_000);

  it("R6g: a buyer cart folding into the open order -> one edit, number unchanged, no 'replaces'", async () => {
    const first = await inTenant(() => buyerCtl.createOrder(cart(), bctx(), `k-${run}-g1`));
    await settle();
    expect(await kindsOn(first.id)).toEqual(["STAFF_NEW_ORDER"]);

    const second = await inTenant(() => buyerCtl.createOrder(cart(), bctx(), `k-${run}-g2`));
    await settle();

    expect(second.id).toBe(first.id);
    expect(await orderCount()).toBe(1);
    expect(await kindsOn(first.id).then((k) => k.sort())).toEqual([
      "BUYER_ORDER_EDITED",
      "STAFF_NEW_ORDER",
    ]);
    const edit = sentMail.find((m) => m.kind === "BUYER_ORDER_EDITED")!;
    expect(edit.subject).toBe(
      `Order ${await numberOf(first.id)} was edited by the customer - Acme ${run}`,
    );
    expect(edit.html).not.toContain("combined");
  }, 120_000);

  it("R6h: a forceNew second cart is a separate order -> two new-order emails, both numbers stay", async () => {
    const first = await postOrder(cart());
    const second = await inTenant(() =>
      buyerCtl.createOrder({ ...cart(), forceNew: true }, bctx(), `k-${run}-h`),
    );
    await settle();

    expect(await orderCount()).toBe(2);
    expect(await kindsOn(first.id)).toEqual(["STAFF_NEW_ORDER"]);
    expect(await kindsOn(second.id)).toEqual(["STAFF_NEW_ORDER"]);
  }, 120_000);

  it("R6i: a folded order the office was never told of -> a new-order email, no number named", async () => {
    await raw.order.create({
      data: {
        customerId,
        tenantId,
        status: "PENDING",
        subtotal: String(2 * UNIT_PRICE),
        total: String(2 * UNIT_PRICE),
        lineItems: {
          create: [
            {
              tenantId,
              productId,
              qty: 2,
              unitPrice: String(UNIT_PRICE),
              subtotal: String(2 * UNIT_PRICE),
            },
          ],
        },
      },
    });

    const out = await postOrder(cart());

    expect(await orderCount()).toBe(1);
    expect(await kindsOn(out.id)).toEqual(["STAFF_NEW_ORDER"]);
    expect(sentMail.find((m) => m.entityId === out.id)!.subject).not.toContain("replaces");
  }, 120_000);

  it("R6j: the sweep is deferred (the merge lock is held) -> a new-order email, both orders exist", async () => {
    const first = await postOrder(cart());

    const held = await withAdvisoryLock(
      { family: "order-merge", key: customerId, mode: "wait", waitMs: 10_000 },
      () => postOrder(cart()),
    );
    expect(held.acquired).toBe(true);
    const second = (held as { acquired: true; value: { id: string } }).value;

    expect(await orderCount()).toBe(2);
    expect(await kindsOn(first.id)).toEqual(["STAFF_NEW_ORDER"]);
    expect(await kindsOn(second.id)).toEqual(["STAFF_NEW_ORDER"]);
  }, 120_000);

  it("R6k: the pending read throws -> the order still lands, and the office gets the new-order email", async () => {
    await postOrder(cart());
    // The same service over a client whose `order.findMany` (the pending read and the fold read) always fails.
    const flakyPrisma = {
      getTenantId: () => prisma.getTenantId(),
      forTenant: () =>
        new Proxy(prisma.forTenant() as any, {
          get: (t, p) =>
            p === "order"
              ? {
                  findFirst: (a: unknown) => t.order.findFirst(a),
                  findMany: () => Promise.reject(new Error("db down")),
                }
              : t[p],
        }),
    };
    const deliveries = new EmailDeliveryService(prisma);
    const email = (staff as any).email;
    const flaky = new StaffOrderEmailService(
      flakyPrisma as any,
      email,
      deliveries,
      (staff as any).policies,
    );
    const realPlaced = flaky.notifyBuyerOrderPlaced.bind(flaky);
    jest.spyOn(flaky, "notifyBuyerOrderPlaced").mockImplementation((...a) => {
      const p = realPlaced(...a);
      pending.push(p);
      return p;
    });
    ordersCtl.staffOrderEmail = flaky;

    try {
      const second = await postOrder(cart());
      expect(second.id).toBeTruthy(); // the order landed
      expect(await kindsOn(second.id)).toEqual(["STAFF_NEW_ORDER"]); // over-told, never dropped
    } finally {
      ordersCtl.staffOrderEmail = staff;
    }
  }, 120_000);

  it("R6l: env off sends nothing and reads nothing; env dark records WOULD_SEND of the edit kind", async () => {
    await postOrder(cart());
    process.env.STAFF_ORDER_EMAIL = "off";
    const readSpy = jest.spyOn(prisma, "forTenant");
    const rowsOff = (await rows()).length;
    const offOut = await postOrder(cart());
    expect(offOut.id).toBeTruthy();
    expect(await rows()).toHaveLength(rowsOff); // no rows
    expect(sentMail.filter((m) => m.entityId === offOut.id)).toHaveLength(0);
    readSpy.mockRestore();

    process.env.STAFF_ORDER_EMAIL = "dark";
    policyMode = "dark";
    const first = await postOrder(cart()); // told: a WOULD_SEND new-order row
    expect((await rows()).filter((r) => r.entityId === first.id).map((r) => r.status)).toEqual([
      "WOULD_SEND",
    ]);
    const firstNo = await numberOf(first.id);
    const second = await postOrder(cart());
    const secondRows = (await rows()).filter((r) => r.entityId === second.id);
    expect(secondRows.map((r) => [r.kind, r.status])).toEqual([
      ["BUYER_ORDER_EDITED", "WOULD_SEND"],
    ]);
    expect(firstNo).toBeTruthy();
    expect(sentMail.filter((m) => m.entityId === second.id)).toHaveLength(0);
  }, 120_000);
});
