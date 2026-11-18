/**
 * SA-1161: a CUSTOMER's order edit carries only the buyer screens' shape. Real Postgres, test tenant `qa-bei-*`. The real
 * buyer and staff controllers are driven; each refusal leaves every row as it was.
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

describeDb("buyer edit allowlist (SA-1161), real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  let invoices: InvoicesService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-bei-${run}`, "buyer-edit-input.db.spec.ts");
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
    tenantId = (await raw.tenant.create({ data: { slug, name: `bei ${slug}` } })).id;
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
        data: { userId: buyerUserId, businessName: "bei co", contactName: "Tester", tenantId },
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

  const extraCustomerIds: string[] = [];
  const extraUserIds: string[] = [];
  const plain = (productId: string, qty: number, deliveredQty = 0, extra: any = {}) => ({
    productId,
    qty,
    deliveredQty,
    unitPrice: "1.00",
    subtotal: String(qty),
    ...extra,
  });

  const stubs = () => {
    const s: any[] = new Array(20).fill({});
    s[7] = orders;
    s[16] = prisma;
    s[19] = { notifyBuyerOrderEdited: async () => undefined }; // the office email after an accepted edit
    return s;
  };
  const buyerCtl = () => new (BuyerController as any)(...stubs()) as BuyerController;
  const staffCtl = () => new (OrdersController as any)(orders, {}, {}, {}, {}) as OrdersController;
  const ctx = () =>
    ({
      tenantId,
      tenantSlug: slug,
      customerId,
      userId: buyerUserId,
      role: "CUSTOMER",
    }) as any;
  const customerPrincipal = () =>
    ({
      sub: buyerUserId,
      username: `b-${run}`,
      role: "CUSTOMER",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;
  type Route = "buyer" | "staff";
  const send = (route: Route, orderId: string, dto: any) =>
    tenantCtx
      .run(tenantId, () =>
        route === "buyer"
          ? buyerCtl().updateOrderItems(orderId, dto, ctx())
          : staffCtl().updateOrderItems(orderId, dto, customerPrincipal()),
      )
      .then(
        () => ({ status: 200 as number, code: undefined as string | undefined, message: "" }),
        (e: any) => ({
          status: (e?.status ?? e?.getStatus?.()) as number,
          code: e?.response?.code as string | undefined,
          message: String(e?.response?.message ?? e?.message),
        }),
      );
  const REFUSED = { status: 400, code: "BUYER_EDIT_INPUT_NOT_ALLOWED" };
  const answer = (r: { status: number; code?: string }) => ({ status: r.status, code: r.code });

  const orderFor = async (cust: string, lines: any[], status = "PENDING") => {
    const total = String(lines.reduce((a, l) => a + Number(l.subtotal), 0));
    const o = await raw.order.create({
      data: {
        customerId: cust,
        tenantId,
        status: status as any,
        subtotal: total,
        total,
        lineItems: { create: lines.map((l) => ({ tenantId, ...l })) },
      },
      include: { lineItems: true },
    });
    orderIds.push(o.id);
    return o;
  };
  /** A PENDING order with one delivered line {q13, d12} and one line with no delivery. */
  async function reopened() {
    const x = await product("bei");
    const y = await product("bei");
    const o = await orderFor(customerId, [plain(x, 13, 12), plain(y, 2, 0)]);
    return {
      o,
      x,
      y,
      delivered: o.lineItems.find((l) => l.productId === x)!,
      other: o.lineItems.find((l) => l.productId === y)!,
    };
  }
  /** A PENDING order with no delivered line: the screens' replace body is accepted on it. */
  async function untouched() {
    const x = await product("bei");
    const y = await product("bei");
    const o = await orderFor(customerId, [plain(x, 2), plain(y, 2)]);
    return {
      o,
      first: o.lineItems.find((l) => l.productId === x)!,
      other: o.lineItems.find((l) => l.productId === y)!,
    };
  }
  /** Everything a refusal must leave alone. */
  const everything = async (orderId: string, products: string[]) => ({
    snap: await snapshot(orderId),
    notes: (await raw.order.findUniqueOrThrow({ where: { id: orderId } })).notes,
    revisions: await raw.orderRevision.count({ where: { orderId } }),
    audits: await raw.auditLog.count({ where: { tenantId, entityId: orderId } }),
    stock: await Promise.all(products.map(stock)),
    orders: await raw.order.count({ where: { tenantId } }),
  });

  describe.each(["buyer", "staff"] as Route[])("%s route", (route) => {
    it("B1/A1a: a field outside the buyer list on an entry naming a delivered line (below its delivered qty, no replaceAll): refused, nothing written", async () => {
      const { o, x, y, delivered } = await reopened();
      const before = await everything(o.id, [x, y]);
      const got = await send(route, o.id, { items: [{ id: delivered.id, qty: 5 }] });
      expect(answer(got)).toEqual(REFUSED);
      expect(await everything(o.id, [x, y])).toEqual(before);
    }, 60_000);

    it("B1/A1b: the same with replaceAll false and a unit line's own unitLabel: refused, nothing written", async () => {
      const x = await product("bei-u", 6);
      await raw.productUnit.create({
        data: { tenantId, productId: x, label: "Case", factorToBase: 6, sortOrder: 0 },
      });
      const o = await orderFor(customerId, [
        plain(x, 3, 2, {
          unitLabel: "Case",
          unitsPerBox: 6,
          boxes: 1,
          pieces: 0,
          unitPrice: "6.00",
          subtotal: "18",
        }),
      ]);
      const before = await everything(o.id, [x]);
      const got = await send(route, o.id, {
        replaceAll: false,
        items: [{ id: o.lineItems[0].id, qty: 1, unitLabel: "Case" }],
      });
      expect(answer(got)).toEqual(REFUSED);
      expect(await everything(o.id, [x])).toEqual(before);
    }, 60_000);

    it.each([
      ["shippingFee", { shippingFee: 9 }],
      ["orderNotes", { orderNotes: "note" }],
      ["appliedCreditNotes", { appliedCreditNotes: [{ creditNoteId: randomUUID(), amount: 1 }] }],
      ["replaceAll", { replaceAll: true }],
      ["restrictionOverrides", { restrictionOverrides: [{ lineKey: "k", reason: "r" }] }],
      ["warningHash", { warningHash: "h" }],
      ["inlineReturn", { inlineReturn: {} }],
    ])(
      "B3: body field %s: refused, nothing written",
      async (_f, extra) => {
        const { o, x, y, delivered } = await reopened();
        const before = await everything(o.id, [x, y]);
        const got = await send(route, o.id, {
          items: [{ orderItemId: delivered.id, qty: 13 }],
          ...extra,
        });
        expect(answer(got)).toEqual(REFUSED);
        expect(await everything(o.id, [x, y])).toEqual(before);
      },
      60_000,
    );

    it.each([
      "action",
      "substituteProductId",
      "name",
      "unitPrice",
      "notes",
      "itemNote",
      "substitution",
      "overrideReason",
    ])(
      "B2: entry field %s: refused, nothing written",
      async (f) => {
        const { o, x, y, other } = await reopened();
        const before = await everything(o.id, [x, y]);
        const got = await send(route, o.id, {
          items: [
            {
              orderItemId: other.id,
              qty: 2,
              // the pre-owner shape checks name a line by `id`; give it one so the allowlist answers
              ...(f === "substituteProductId" ? { id: other.id } : {}),
              [f]: f === "action" ? "UPDATE" : "v",
            },
          ],
        });
        expect(answer(got)).toEqual(REFUSED);
        expect(await everything(o.id, [x, y])).toEqual(before);
      },
      60_000,
    );

    it("B5: the web body {items:[{orderItemId, qty}], expectedRevisionNumber} on a line with no delivery is accepted", async () => {
      const { o, first, other } = await untouched();
      const got = await send(route, o.id, {
        items: [
          { productId: first.productId, orderItemId: first.id, qty: 2 },
          { productId: other.productId, orderItemId: other.id, qty: 3 },
        ],
        expectedRevisionNumber: 0,
      });
      expect(got.status).toBe(200);
      // a replace re-creates the lines, so find it by product, not by the old id
      const after = await raw.orderItem.findFirstOrThrow({
        where: { orderId: o.id, productId: other.productId },
      });
      expect(Number(after.qty)).toBe(3);
    }, 60_000);

    it("B9: the delivered-line replace stays 409 ORDER_EDIT_DELIVERED_LINES with the listed shape", async () => {
      const { o, y } = await reopened();
      const got = await send(route, o.id, { items: [{ productId: y, qty: 1 }] });
      expect({ status: got.status, code: got.code }).toEqual({
        status: 409,
        code: "ORDER_EDIT_DELIVERED_LINES",
      });
    }, 60_000);

    it("B10: a stale expectedRevisionNumber stays 409 ORDER_REVISION_STALE", async () => {
      const { o, other } = await reopened();
      const got = await send(route, o.id, {
        items: [{ orderItemId: other.id, qty: 3 }],
        expectedRevisionNumber: 99,
      });
      expect({ status: got.status, code: got.code }).toEqual({
        status: 409,
        code: "ORDER_REVISION_STALE",
      });
    }, 60_000);

    it("B11: an order out for delivery stays 403 for the listed shape", async () => {
      const x = await product("bei-o");
      const o = await orderFor(customerId, [plain(x, 2)], "OUT_FOR_DELIVERY");
      const got = await send(route, o.id, { items: [{ orderItemId: o.lineItems[0].id, qty: 1 }] });
      expect(got.status).toBe(403);
    }, 60_000);
  });

  it("B6: the mobile body {items, namesLines:true} is accepted", async () => {
    const { o, first, other } = await untouched();
    const got = await send("buyer", o.id, {
      items: [
        { productId: first.productId, orderItemId: first.id, qty: 2 },
        { productId: other.productId, orderItemId: other.id, qty: 3 },
      ],
      namesLines: true,
    });
    expect(got.status).toBe(200);
  }, 60_000);

  it("B7: a customer that does not own the order gets the bare 403, whatever the body carries", async () => {
    const { o, other } = await reopened();
    const u = await raw.user.create({
      data: { email: `x-${run}@example.test`, username: `x-${run}`, role: "CUSTOMER", tenantId },
    });
    extraUserIds.push(u.id);
    const c = await raw.customer.create({
      data: { userId: u.id, businessName: "bei other", contactName: "T", tenantId },
    });
    extraCustomerIds.push(c.id);
    const got = await tenantCtx
      .run(tenantId, () =>
        staffCtl().updateOrderItems(
          o.id,
          { items: [{ orderItemId: other.id, qty: 3, unitPrice: 9 }] } as any,
          { ...customerPrincipal(), sub: u.id } as JwtPayload,
        ),
      )
      .then(
        () => ({ status: 200 as number, code: undefined as string | undefined }),
        (e: any) => ({
          status: (e?.status ?? e?.getStatus?.()) as number,
          code: e?.response?.code as string | undefined,
        }),
      );
    expect(got.status).toBe(403);
    expect(got.code).toBeUndefined();
  }, 60_000);

  it("B8: an OPERATOR keeps the full shape (price on an entry)", async () => {
    const { o, other } = await reopened();
    await edit(o.id, { items: [{ id: other.id, qty: 3, unitPrice: 2 }] });
    const line = await raw.orderItem.findUniqueOrThrow({ where: { id: other.id } });
    expect(Number(line.unitPrice)).toBe(2);
    expect(Number(line.qty)).toBe(3);
  }, 60_000);
});
