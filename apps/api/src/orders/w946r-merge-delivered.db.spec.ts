/**
 * SA-1149 (round 2): an order holding a live delivered line is never a merge target or a merge loser (M1-*, SW-*), and the
 * per-line floor reads the booked floor (F1-*). Real Postgres, test tenant `qa-w946m-*`. The buyer controller is not
 * instantiated: the M1 rows drive the exact `findActiveOrder` call it makes and the service writers behind it.
 */
jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({ getOrGenerate: jest.fn() })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { BuyerController } from "../buyer/buyer.controller";
import { OrdersController } from "./orders.controller";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { Test } from "@nestjs/testing";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
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
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("W-946r merge and floor (SA-1149 round 2), real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  let invoices: InvoicesService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-w946r-${run}`, "w946r-qty-floor.db.spec.ts");
  let tenantId = "";
  let operatorUserId = "";
  let buyerUserId = "";
  let driverUserId = "";
  let driverId = "";
  const routeIds: string[] = [];
  const runIds: string[] = [];
  let customerId = "";
  const productIds: string[] = [];
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];
  /** What the (mocked) active promotions endpoint returns; the BOGO case sets it for one edit. */
  let activePromos: any[] = [];

  const principal = (role: "OPERATOR" | "DRIVER", sub: string): JwtPayload =>
    ({
      sub,
      username: `${role.toLowerCase()}-${run}`,
      role,
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  /** A plain "ea" product (no box, no unit ladder) holding 90 pieces: the order's own 10 are already out. */
  async function product(tag: string, upb: number | null = null) {
    const p = await raw.product.create({
      data: {
        // Product names are unique per tenant (Product_tenant_root_name_active_key): one per call.
        name: `${tag} cola ${run} #${productIds.length + 1}`,
        unit: "ea",
        ...(upb ? { unitsPerBox: upb } : {}),
        pricePerUnit: "1.00",
        currentStock: "90",
        tenantId,
      },
    });
    productIds.push(p.id);
    return p.id;
  }

  const operator = () => principal("OPERATOR", operatorUserId);

  async function order(lines: any | any[], status = "PENDING") {
    const list = Array.isArray(lines) ? lines : [lines];
    const o = await raw.order.create({
      data: {
        customerId,
        tenantId,
        status: status as any,
        subtotal: String(list.reduce((a, l) => a + Number(l.subtotal), 0)),
        total: String(list.reduce((a, l) => a + Number(l.subtotal), 0)),
        lineItems: { create: list.map((l) => ({ tenantId, ...l })) },
      },
      include: { lineItems: true },
    });
    orderIds.push(o.id);
    return o;
  }

  const edit = (orderId: string, dto: any, who: JwtPayload = operator()) =>
    tenantCtx.run(tenantId, () => orders.updateOrderItems(orderId, dto, who));
  /** The whole order as stored: its header money, every line (ids included) and its linked invoices. */
  const snapshot = async (orderId: string) => ({
    header: await raw.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { subtotal: true, total: true, status: true },
    }),
    lines: (await rows(orderId)).map(({ updatedAt: _u, ...l }) => l),
    invoices: await raw.invoice.findMany({
      where: { orderId },
      orderBy: { id: "asc" },
      select: { id: true, status: true, subtotal: true, taxAmount: true, total: true },
    }),
  });
  const rows = (orderId: string) =>
    raw.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
  const stock = async (id: string) =>
    Number((await raw.product.findUniqueOrThrow({ where: { id } })).currentStock);

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const m0d = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        EstimatesService,
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        { provide: OrdersService, useValue: {} },
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
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            getAll: jest.fn().mockResolvedValue({}),
            set: jest.fn(),
          },
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
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
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
    invoices = m0d.get(InvoicesService);
    const systemConfig = new SystemConfigService(
      prisma,
      new EncryptionService({ get: () => undefined } as any),
    );
    orders = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      gateway: { emitOrderStatusChanged: jest.fn(), emitOrderCreated: jest.fn() },
      systemConfig,
      entitlements: { hasFlag: async () => true },
      sellingRestrictions: {
        getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
        assertLinesSellable: async () => undefined,
      },
      authGuard: { assertAuthorizedOrThrow: async () => undefined },
      promotionsService: { activeForCatalog: async () => activePromos },
      tenantCtx,
      invoicesService: {
        revertLinkedInvoicesForOrderEdit: async () => undefined,
        resyncOrderInvoicesForEdit: async () => [],
        ...INVOICE_EDIT_STUBS,
        reconcileOrderDraftInvoice: async () => undefined,
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
      notifications: {
        sendToCustomer: jest.fn().mockResolvedValue(undefined),
        sendToUser: jest.fn().mockResolvedValue(1),
      },
      messaging: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
    });
    tenantId = (await raw.tenant.create({ data: { slug, name: `w946 ${slug}` } })).id;
    operatorUserId = (
      await raw.user.create({
        data: {
          email: `o-${run}@example.test`,
          username: `o-${run}`,
          role: "OPERATOR",
          tenantId,
        },
      })
    ).id;
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
        data: { userId: buyerUserId, businessName: "w946 co", contactName: "Tester", tenantId },
      })
    ).id;
    driverUserId = (
      await raw.user.create({
        data: { email: `d-${run}@example.test`, username: `d-${run}`, role: "DRIVER", tenantId },
      })
    ).id;
    driverId = (await raw.driver.create({ data: { userId: driverUserId, tenantId } as any })).id;
  }, 120_000);

  afterAll(async () => {
    // orders made through the real controllers (checkout, staff create) are not in orderIds: sweep the whole test tenant
    orderIds.push(
      ...(await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map((o) => o.id),
    );
    await raw.invoice.deleteMany({
      where: { OR: [{ id: { in: invoiceIds } }, { orderId: { in: orderIds } }] },
    });
    await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
    await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.routeRunStop.deleteMany({ where: { routeRunId: { in: runIds } } });
    await raw.routeRun.deleteMany({ where: { id: { in: runIds } } });
    await raw.routeStop.deleteMany({ where: { routeId: { in: routeIds } } });
    await raw.route.deleteMany({ where: { id: { in: routeIds } } });
    await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
    await raw.productUnit.deleteMany({ where: { productId: { in: productIds } } });
    await raw.product.deleteMany({ where: { id: { in: productIds } } });
    await raw.customer.deleteMany({ where: { id: { in: [customerId, ...extraCustomerIds] } } });
    await raw.driver.deleteMany({ where: { tenantId } });
    await raw.user.deleteMany({
      where: { id: { in: [operatorUserId, buyerUserId, driverUserId, ...extraUserIds] } },
    });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  const plain = (productId: string, qty: number, deliveredQty = 0) => ({
    productId,
    qty,
    deliveredQty,
    unitPrice: "1.00",
    subtotal: String(qty),
  });
  /** Observed at 0e86ebb299 / the fix (filled after the first runs). */
  const OBSERVED_M10_PATH = "writers";
  /** M1-1: y's stock 90 less its 2 sold; M1-2b: a stale merge choice with no target creates a new order; M1-k: the KNOWN 409. */
  const OBSERVED_M11_STOCK_Y = [90, 88];
  const OBSERVED_M12B = { created: true };
  const OBSERVED_MK = { status: 409, code: "ORDER_EDIT_DELIVERED_LINES" };
  const F1_G1_RULED = { q: 13, d: 13 };
  const F1_G2_RULED = { q: 12, d: 12 };
  const F1_G3_RULED = { q: 10, d: 0 };

  const extraCustomerIds: string[] = [];
  const extraUserIds: string[] = [];
  async function newCustomer() {
    const u = await raw.user.create({
      data: {
        email: `m1-${run}-${extraCustomerIds.length}@example.test`,
        username: `m1-${run}-${extraCustomerIds.length}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    extraUserIds.push(u.id);
    const c = await raw.customer.create({
      data: {
        userId: u.id,
        businessName: `m1 co ${extraCustomerIds.length}`,
        contactName: "Tester",
        tenantId,
      },
    });
    extraCustomerIds.push(c.id);
    return c.id;
  }
  const orderFor = async (cust: string, lines: any[], status = "PENDING", extra: any = {}) => {
    const o = await raw.order.create({
      data: {
        customerId: cust,
        tenantId,
        status: status as any,
        subtotal: String(lines.reduce((a, l) => a + Number(l.subtotal), 0)),
        total: String(lines.reduce((a, l) => a + Number(l.subtotal), 0)),
        ...extra,
        lineItems: { create: lines.map((l) => ({ tenantId, ...l })) },
      },
      include: { lineItems: true },
    });
    orderIds.push(o.id);
    return o;
  };
  const buyer = () => principal("OPERATOR", operatorUserId);
  const BUYER_MERGE = { audience: "buyer", role: "CUSTOMER", deniedGroups: [] };
  const mergeSearch = (cust: string, mergeAs?: any) =>
    tenantCtx.run(tenantId, () =>
      orders.findActiveOrder(cust, { forMerge: true, ...(mergeAs ? { mergeAs } : {}) }),
    );
  const ids = async (orderId: string) => (await rows(orderId)).map((l) => l.id);

  /**
   * M1-0 entry: a DELIVERED non-route order, line x {q12, d12} -> changeStatus CONFIRMED -> a staff per-line {id, qty:13}.
   * Reports which step refuses; then seeds the state directly.
   */
  async function reopened(cust: string) {
    const x = await product("m10");
    const o = await orderFor(cust, [plain(x, 12, 12)], "DELIVERED");
    let path = "writers";
    try {
      await tenantCtx.run(tenantId, () =>
        orders.changeStatus(o.id, { status: "CONFIRMED", reason: "reopen" }, operator()),
      );
      await edit(o.id, { items: [{ id: o.lineItems[0].id, qty: 13 }] });
    } catch (e: any) {
      path = `seeded (${e?.status ?? ""} ${e?.response?.code ?? e?.message})`;
      await raw.order.update({ where: { id: o.id }, data: { status: "PENDING" } });
      await raw.orderItem.update({
        where: { id: o.lineItems[0].id },
        data: { qty: 13, subtotal: "13", deliveredQty: 12 },
      });
    }
    return { o, x, path, line: o.lineItems[0] };
  }

  it("M1-0 (entry, observed): the writers reach PENDING with x {q13, d12} and no evidence row", async () => {
    const r = await reopened(await newCustomer());
    expect(r.path).toBe(OBSERVED_M10_PATH);
    const [l] = await rows(r.o.id);
    expect({
      status: (await snapshot(r.o.id)).header.status,
      q: Number(l.qty),
      d: Number(l.deliveredQty),
    }).toEqual({
      status: "PENDING",
      q: 13,
      d: 12,
    });
    expect(await raw.deliveryMutation.count({ where: { orderId: r.o.id } })).toBe(0);
  }, 60_000);

  /** The real controllers, as the tests of the staff create and the discount lane build them (positional stubs). */
  const buyerController = () => {
    const stubs: any[] = Array.from({ length: 19 }, () => ({}));
    stubs[7] = orders; // ordersService
    stubs[16] = prisma; // prisma
    return new (BuyerController as any)(...stubs) as BuyerController;
  };
  const staffController = () =>
    new OrdersController(orders, {} as any, {} as any, {} as any, {} as any);
  const userOf = async (cust: string) =>
    (await raw.customer.findUniqueOrThrow({ where: { id: cust } })).userId as string;
  const checkout = async (cust: string, items: any[]) => {
    const userId = await userOf(cust);
    return tenantCtx.run(tenantId, () =>
      buyerController().createOrder(
        { items } as any,
        { tenantId, tenantSlug: slug, customerId: cust, userId, role: "CUSTOMER" } as any,
      ),
    );
  };
  const sameLines = async (orderId: string) =>
    (await rows(orderId)).map((l) => [l.id, Number(l.qty), Number(l.deliveredQty)]);

  it("M1-1 (red-first): the buyer's cart [y x2] beside the M1-0 order: checkout makes a NEW order, the M1-0 order is untouched", async () => {
    const cust = await newCustomer();
    const r = await reopened(cust);
    const y = await product("m11");
    const before = await snapshot(r.o.id);
    const lines0 = await sameLines(r.o.id);
    const stockX = await stock(r.x);
    const stockY = await stock(y);
    const created: any = await checkout(cust, [{ productId: y, qty: 2 }]);
    expect(created.id).toBeDefined();
    expect(created.id).not.toBe(r.o.id);
    expect(await raw.order.count({ where: { customerId: cust } })).toBe(2);
    const made = await raw.orderItem.findMany({ where: { orderId: created.id } });
    expect(made.map((l) => [l.productId, Number(l.qty)])).toEqual([[y, 2]]);
    expect(await snapshot(r.o.id)).toEqual(before);
    expect(await sameLines(r.o.id)).toEqual(lines0); // line ids, x {q13, d12}
    expect(lines0.map((l) => [l[1], l[2]])).toEqual([[13, 12]]);
    expect(await stock(r.x)).toBe(stockX);
    expect([stockY, await stock(y)]).toEqual(OBSERVED_M11_STOCK_Y); // y moves, x does not
  }, 120_000);

  it("M1-2a (red-first): staff create [y x2] with no merge choice: 201 a new order, no merge prompt", async () => {
    const cust = await newCustomer();
    const r = await reopened(cust);
    const y = await product("m12a");
    const before = await snapshot(r.o.id);
    const created: any = await tenantCtx.run(tenantId, () =>
      staffController().create(
        { customerId: cust, items: [{ productId: y, qty: 2 }] } as any,
        operator(),
      ),
    );
    expect(created.id).not.toBe(r.o.id);
    expect(await raw.order.count({ where: { customerId: cust } })).toBe(2);
    expect(await snapshot(r.o.id)).toEqual(before);
  }, 120_000);

  it("M1-2b (red-first): staff create [y x2] with the merge choice (a stale client): a new order, the M1-0 order untouched", async () => {
    const cust = await newCustomer();
    const r = await reopened(cust);
    const y = await product("m12b");
    const before = await snapshot(r.o.id);
    const lines0 = await sameLines(r.o.id);
    const outcome = await tenantCtx
      .run(tenantId, () =>
        staffController().create(
          { customerId: cust, items: [{ productId: y, qty: 2 }], mergeChoice: "merge" } as any,
          operator(),
        ),
      )
      .then((o: any) => ({ created: o.id !== r.o.id }))
      .catch((e: any) => ({ status: e?.status, code: e?.response?.code }));
    expect(outcome).toEqual(OBSERVED_M12B);
    expect(await snapshot(r.o.id)).toEqual(before);
    expect(await sameLines(r.o.id)).toEqual(lines0);
  }, 120_000);

  it("M1-k (KNOWN, the LOW row): a buyer save whose only delivered line is unlisted, the product lines d 0", async () => {
    const cust = await newCustomer();
    const z = await product("mkz");
    // the ONLY delivered line is UNLISTED (no product, a description) {q12, d12}; product z is {q2, d0}
    const unlisted = {
      productId: null,
      name: "unlisted delivered item",
      qty: 12,
      deliveredQty: 12,
      unitPrice: "1.00",
      subtotal: "12",
    };
    const o = await orderFor(cust, [unlisted, plain(z, 2, 0)], "PENDING");
    const before = await snapshot(o.id);
    const buyerUser = {
      ...principal("OPERATOR", await userOf(cust)),
      role: "CUSTOMER",
      type: "BUYER",
    } as JwtPayload;
    const outcome = await tenantCtx
      .run(tenantId, () =>
        orders.updateOrderItems(o.id, { items: [{ productId: z, qty: 3 }] }, buyerUser, {
          buyerLineIds: true,
        }),
      )
      .then(() => "resolved")
      .catch((e: any) => ({ status: e?.status, code: e?.response?.code }));
    expect(outcome).toEqual(OBSERVED_MK); // KNOWN (the LOW row): the unlisted delivered line is refused, not preserved
    expect(await snapshot(o.id)).toEqual(before);
  }, 120_000);

  it("M1-3: a display read (no forMerge) still shows the order; the merge searches agree with checkout", async () => {
    const cust = await newCustomer();
    const r = await reopened(cust);
    const shown = await tenantCtx.run(tenantId, () => orders.findActiveOrder(cust));
    expect(shown?.id).toBe(r.o.id);
    expect(await mergeSearch(cust, BUYER_MERGE)).toBeNull();
  }, 60_000);

  it("M1-4: the merge tool (auto and force) leaves the order alone: not merged, not deleted", async () => {
    const cust = await newCustomer();
    const r = await reopened(cust);
    const y = await product("m14");
    const b = await orderFor(cust, [plain(y, 2)]);
    const before = await snapshot(r.o.id);
    const lineIds = await ids(r.o.id);
    await tenantCtx.run(tenantId, () => orders.mergeAllPendingForCustomer(cust));
    const forced = await tenantCtx
      .run(tenantId, () => orders.forceConsolidateCustomer(cust))
      .then(
        (v) => ({ ok: v as unknown }),
        (e: any) => ({ refused: (e?.response?.code ?? e?.message) as string }),
      );
    // observed: the force pass resolves (no refusal) with the lone eligible order b; the delivered order is not its target
    expect(forced).toHaveProperty("ok");
    expect((forced as { ok: { id: string } }).ok.id).toBe(b.id);
    expect(await snapshot(r.o.id)).toEqual(before);
    expect(await ids(r.o.id)).toEqual(lineIds);
    expect(await raw.order.count({ where: { id: b.id } })).toBe(1);
    expect(await ids(b.id)).toHaveLength(1);
  }, 60_000);

  it("M1-5 (server half): a buyer full list on that order: 409 ORDER_EDIT_DELIVERED_LINES, nothing written", async () => {
    const r = await reopened(customerId);
    const before = await snapshot(r.o.id);
    const buyerUser = {
      ...principal("OPERATOR", buyerUserId),
      role: "CUSTOMER",
      type: "BUYER",
    } as JwtPayload;
    await expect(
      tenantCtx.run(tenantId, () =>
        orders.updateOrderItems(
          r.o.id,
          { items: [{ productId: r.x, qty: 14, orderItemId: r.line.id }], namesLines: true },
          buyerUser,
          { buyerLineIds: true },
        ),
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "ORDER_EDIT_DELIVERED_LINES" } });
    expect(await snapshot(r.o.id)).toEqual(before);
  }, 60_000);

  it("M1-g1 (guard): x CANCELLED and the only delivered line: the order is a merge target", async () => {
    const cust = await newCustomer();
    const x = await product("g1");
    const o = await orderFor(cust, [
      { ...plain(x, 12, 12), status: "CANCELLED" },
      plain(await product("g1b"), 2),
    ]);
    expect((await mergeSearch(cust, BUYER_MERGE))?.id).toBe(o.id);
  }, 60_000);

  it("M1-g2 (guard): PENDING with every line d 0 is a merge target", async () => {
    const cust = await newCustomer();
    const o = await orderFor(cust, [plain(await product("g2"), 3)]);
    expect((await mergeSearch(cust, BUYER_MERGE))?.id).toBe(o.id);
  }, 60_000);

  it("M1-g3 (guard): a staff replaceAll on that order: 409 ORDER_EDIT_DELIVERED_LINES", async () => {
    const r = await reopened(await newCustomer());
    const y = await product("g3");
    await expect(
      edit(r.o.id, { items: [{ productId: y, qty: 2, unitPrice: 1 }], replaceAll: true }),
    ).rejects.toMatchObject({ status: 409, response: { code: "ORDER_EDIT_DELIVERED_LINES" } });
  }, 60_000);

  it("M1-g4 (guard): a PENDING order with a live unit-aware line is still not a merge target (the AND keeps both)", async () => {
    const cust = await newCustomer();
    const o = await orderFor(cust, [{ ...plain(await product("g4"), 2), unitLabel: "Case" }]);
    expect(await mergeSearch(cust, BUYER_MERGE)).toBeNull();
    expect(o.id).toBeTruthy();
  }, 60_000);

  it("SW-1: the hourly sweep merges nothing of the order and deletes none of its lines", async () => {
    const cust = await newCustomer();
    const r = await reopened(cust);
    const y = await product("sw1");
    const b = await orderFor(cust, [plain(y, 2)]);
    const beforeA = await snapshot(r.o.id);
    const beforeB = await snapshot(b.id);
    const stock0 = await stock(r.x);
    // the sweep is global (it re-enters each tenant itself); the spec DB is a throwaway with only this tenant, so merged is exactly this tenant's
    const swept = await tenantCtx.run(tenantId, () => orders.sweepAllPendingOrders());
    expect(swept.merged).toBe(0);
    expect(await snapshot(r.o.id)).toEqual(beforeA);
    expect(await snapshot(b.id)).toEqual(beforeB);
    expect(await stock(r.x)).toBe(stock0);
  }, 120_000);

  it("SW-2: the post-create sweep (focusOrderId) leaves the order alone", async () => {
    const cust = await newCustomer();
    const r = await reopened(cust);
    const b = await orderFor(cust, [plain(await product("sw2"), 2)]);
    const beforeA = await snapshot(r.o.id);
    await tenantCtx.run(tenantId, () =>
      orders.mergeAllPendingForCustomer(cust, { focusOrderId: b.id }),
    );
    expect(await snapshot(r.o.id)).toEqual(beforeA);
    expect(await raw.order.count({ where: { id: b.id } })).toBe(1);
  }, 60_000);

  it("SW-g (guard): with x CANCELLED the sweep merges two PENDING orders as today", async () => {
    const cust = await newCustomer();
    const x = await product("swg");
    await orderFor(cust, [
      { ...plain(x, 10, 10), status: "CANCELLED" },
      plain(await product("swg2"), 1),
    ]);
    await orderFor(cust, [plain(await product("swg3"), 2)]);
    await tenantCtx.run(tenantId, () => orders.mergeAllPendingForCustomer(cust));
    expect(await raw.order.count({ where: { customerId: cust } })).toBe(1);
  }, 60_000);

  /** F1: DELIVERED, non-route, no evidence, a legacy line {q12, d0}. */
  async function legacy(route = false) {
    const x = await product("f1");
    const cust = await newCustomer();
    const o = await orderFor(cust, [plain(x, 12, 0)], "DELIVERED", route ? await routeStop() : {});
    return { o, x, line: o.lineItems[0] };
  }
  async function routeStop() {
    const route = await raw.route.create({
      data: { name: `f1-${run}-${routeIds.length}`, tenantId } as any,
    });
    routeIds.push(route.id);
    const rs = await raw.routeStop.create({
      data: { tenantId, routeId: route.id, stopNumber: 1, customerId } as any,
    });
    const rr = await raw.routeRun.create({
      data: {
        tenantId,
        routeId: route.id,
        scheduledDate: new Date("2026-10-12T00:00:00.000Z"),
        status: "COMPLETED" as any,
        driverId,
      },
    });
    runIds.push(rr.id);
    const stop = await raw.routeRunStop.create({
      data: {
        tenantId,
        routeRunId: rr.id,
        routeStopId: rs.id,
        stopNumber: 1,
        status: "COMPLETED" as any,
      } as any,
    });
    return { routeRunId: rr.id, routeRunStopId: stop.id };
  }

  it("F1: a legacy {q12, d0} on a DELIVERED non-route order cut to 10 is 409 LINE_ALREADY_DELIVERED, nothing written, stock unchanged", async () => {
    const f = await legacy();
    const before = await snapshot(f.o.id);
    await expect(edit(f.o.id, { items: [{ id: f.line.id, qty: 10 }] })).rejects.toMatchObject({
      status: 409,
      response: { code: "LINE_ALREADY_DELIVERED" },
    });
    expect(await snapshot(f.o.id)).toEqual(before);
    expect(await stock(f.x)).toBe(90);
  }, 60_000);

  it("F1-g1 (guard): the same order raised to 13: 200, d 13", async () => {
    const f = await legacy();
    await edit(f.o.id, { items: [{ id: f.line.id, qty: 13 }] });
    const [l] = await rows(f.o.id);
    expect({ q: Number(l.qty), d: Number(l.deliveredQty) }).toEqual(F1_G1_RULED);
  }, 60_000);

  it("F1-g2 (guard): restated at 12: 200, d 12 (the first-edit normalisation)", async () => {
    const f = await legacy();
    await edit(f.o.id, { items: [{ id: f.line.id, qty: 12 }] });
    const [l] = await rows(f.o.id);
    expect({ q: Number(l.qty), d: Number(l.deliveredQty) }).toEqual(F1_G2_RULED);
  }, 60_000);

  it("F1-g3 (guard): a DELIVERED route order {q12, d0} cut to 10 is accepted as today (route columns stay)", async () => {
    const f = await legacy(true);
    await edit(f.o.id, { items: [{ id: f.line.id, qty: 10 }] });
    const [l] = await rows(f.o.id);
    expect({ q: Number(l.qty), d: Number(l.deliveredQty) }).toEqual(F1_G3_RULED);
  }, 60_000);

  /** F1-u: the same legacy shape on a unit-aware line (unitLabel set), cut through the unit-line edit path. */
  async function legacyUnit(route = false) {
    const x = await product("f1u");
    await raw.productUnit.create({
      data: { tenantId, productId: x, label: "Pack", factorToBase: 1, price: "1.00" },
    });
    const cust = await newCustomer();
    const o = await orderFor(
      cust,
      [{ ...plain(x, 12, 0), unitLabel: "Pack", unitsPerBox: 1, boxes: 12, pieces: 0 }],
      "DELIVERED",
      route ? await routeStop() : {},
    );
    return { o, x, line: o.lineItems[0] };
  }
  const unitEdit = (f: { o: { id: string }; line: { id: string } }, qty: number) =>
    edit(f.o.id, { replaceAll: false, items: [{ id: f.line.id, unitLabel: "Pack", qty }] });
  const ledgerOf = async (productId: string) =>
    (await raw.stockMovement.findMany({ where: { productId }, orderBy: { createdAt: "asc" } })).map(
      (m) => ({ type: m.type, qty: Number(m.quantity) }),
    );
  const OBSERVED_F1U = { status: 409, code: "LINE_ALREADY_DELIVERED" };
  const OBSERVED_F1U_G1 = { q: 13, d: 13, stock: 89, ledger: [{ type: "SALE", qty: -1 }] };
  const OBSERVED_F1U_G2 = { q: 12, d: 12, stock: 90, ledger: [] as unknown[] };
  const OBSERVED_F1U_G3 = { q: 10, d: 0, stock: 92, ledger: [{ type: "SALE", qty: 2 }] };

  it("F1-u: a unit-aware legacy {q12, d0} on a DELIVERED non-route order cut to 10 is 409 LINE_ALREADY_DELIVERED, nothing written, stock and ledger unchanged", async () => {
    const f = await legacyUnit();
    const before = await snapshot(f.o.id);
    const ledger0 = await ledgerOf(f.x);
    const got = await unitEdit(f, 10).then(
      () => ({ status: 200, code: undefined as string | undefined }),
      (e: any) => ({ status: e.status as number, code: e.response?.code as string | undefined }),
    );
    expect(got).toEqual(OBSERVED_F1U);
    expect(await snapshot(f.o.id)).toEqual(before);
    expect(await stock(f.x)).toBe(90);
    expect(await ledgerOf(f.x)).toEqual(ledger0);
  }, 60_000);

  it("F1-u-g1 (guard): the unit-aware order raised to 13: 200, d 13, one booked SALE row of -1", async () => {
    const f = await legacyUnit();
    await unitEdit(f, 13);
    const [l] = await rows(f.o.id);
    expect({
      q: Number(l.qty),
      d: Number(l.deliveredQty),
      stock: await stock(f.x),
      ledger: await ledgerOf(f.x),
    }).toEqual(OBSERVED_F1U_G1);
  }, 60_000);

  it("F1-u-g2 (guard): restated at 12: 200, d 12, no stock row", async () => {
    const f = await legacyUnit();
    await unitEdit(f, 12);
    const [l] = await rows(f.o.id);
    expect({
      q: Number(l.qty),
      d: Number(l.deliveredQty),
      stock: await stock(f.x),
      ledger: await ledgerOf(f.x),
    }).toEqual(OBSERVED_F1U_G2);
  }, 60_000);

  it("F1-u-g3 (guard): a DELIVERED route order, unit-aware {q12, d0}, cut to 10: 200 as today, one SALE row of +2", async () => {
    const f = await legacyUnit(true);
    await unitEdit(f, 10);
    const [l] = await rows(f.o.id);
    expect({
      q: Number(l.qty),
      d: Number(l.deliveredQty),
      stock: await stock(f.x),
      ledger: await ledgerOf(f.x),
    }).toEqual(OBSERVED_F1U_G3);
  }, 60_000);
});
