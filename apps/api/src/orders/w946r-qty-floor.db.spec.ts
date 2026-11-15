/**
 * W-946r / SA-1149 (SA-992 D2): a delivered line never goes below what was delivered. Real Postgres, test tenant `qa-w946r-*`.
 * D2-1..D2-7 (D2-8 is the structure pin). Red first on rf-bugs' observed values: master billed 3 on a 5-of-5 delivered line.
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

describeDb("W-946r quantity floor (SA-1149 D2), real Postgres", () => {
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
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
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
    await raw.customer.deleteMany({ where: { id: customerId } });
    await raw.driver.deleteMany({ where: { tenantId } });
    await raw.user.deleteMany({
      where: { id: { in: [operatorUserId, buyerUserId, driverUserId] } },
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

  const delivered = (productId: string, qty = 5, deliveredQty = 5, status = "DELIVERED") =>
    order([plain(productId, qty, deliveredQty)], status);

  /** What the invoice would bill for the order: its created invoice's subtotal and line quantities. */
  async function invoiceFor(orderId: string) {
    await tenantCtx.run(tenantId, () => invoices.createInvoiceFromOrder(orderId));
    const found = await raw.invoice.findMany({ where: { orderId }, include: { items: true } });
    invoiceIds.push(...found.map((i) => i.id));
    return {
      subtotal: Number(found[0].subtotal),
      qtys: found[0].items.map((i: any) => Number(i.quantity ?? i.qty)),
    };
  }

  const LOWER = {
    status: 409,
    response: {
      code: "LINE_ALREADY_DELIVERED",
      message: expect.stringContaining("record a return"),
    },
  };

  it("D2-1: DELIVERED each-unit line 5 of 5, {id, qty:3}: 409, nothing written, the invoice bills 5", async () => {
    const p = await product("d21");
    const o = await delivered(p);
    const before = await snapshot(o.id);
    await expect(edit(o.id, { items: [{ id: o.lineItems[0].id, qty: 3 }] })).rejects.toMatchObject(
      LOWER,
    );
    expect(await snapshot(o.id)).toEqual(before);
    expect(await stock(p)).toBe(90);
    expect(await invoiceFor(o.id)).toEqual({ subtotal: 5, qtys: [5] });
  }, 120_000);

  it("D2-2: a pack-6 line with 6 delivered, pieces 3 (after normalizeBoxesPieces): 409, nothing written", async () => {
    const p = await product("d22", 6);
    const o = await delivered(p, 6, 6);
    const before = await snapshot(o.id);
    await expect(
      edit(o.id, { items: [{ id: o.lineItems[0].id, boxes: 0, pieces: 3 }] }),
    ).rejects.toMatchObject(LOWER);
    expect(await snapshot(o.id)).toEqual(before);
  }, 120_000);

  it("D2-3 (observe): PARTIALLY_DELIVERED 5 ordered / 3 delivered, cut to 2: refused, nothing written", async () => {
    const p = await product("d23");
    const o = await delivered(p, 5, 3, "PARTIALLY_DELIVERED");
    const before = await snapshot(o.id);
    let outcome: unknown = "resolved";
    await edit(o.id, { items: [{ id: o.lineItems[0].id, qty: 2 }] }).catch((e) => {
      outcome = { status: e?.status, code: e?.response?.code };
    });
    // eslint-disable-next-line no-console
    console.log("W946R-D2-3", JSON.stringify(outcome));
    expect(outcome).toMatchObject({ status: 409 });
    expect(await snapshot(o.id)).toEqual(before);
  }, 120_000);

  it("D2-4 guard: qty 5 (equal) and 7 (increase) are accepted on the delivered line", async () => {
    const p = await product("d24");
    const o = await delivered(p);
    await edit(o.id, { items: [{ id: o.lineItems[0].id, qty: 5 }] });
    expect(Number((await rows(o.id))[0].qty)).toBe(5);
    await edit(o.id, { items: [{ id: o.lineItems[0].id, qty: 7 }] });
    expect(Number((await rows(o.id))[0].qty)).toBe(7);
  }, 120_000);

  it("D2-5 guard: {id, qty:0} writes nothing and is not a 409 (the generic skip)", async () => {
    const p = await product("d25");
    const o = await delivered(p);
    const before = await snapshot(o.id);
    await expect(edit(o.id, { items: [{ id: o.lineItems[0].id, qty: 0 }] })).resolves.not.toThrow();
    expect(await snapshot(o.id)).toEqual(before);
  }, 120_000);

  it("D2-6 guard: boxes 0 pieces 3 on a plain line is ignored: nothing written, no 409", async () => {
    const p = await product("d26");
    const o = await delivered(p);
    const before = await snapshot(o.id);
    await edit(o.id, { items: [{ id: o.lineItems[0].id, boxes: 0, pieces: 3 }] }).catch((e) => {
      throw new Error(`unexpected refusal ${e?.status} ${e?.response?.code}`);
    });
    expect(await snapshot(o.id)).toEqual(before);
  }, 120_000);

  it("D2-7 guard: a line with deliveredQty 0 on a PENDING order is cut to 1 as today", async () => {
    const p = await product("d27");
    const o = await order([plain(p, 5, 0)], "PENDING");
    await edit(o.id, { items: [{ id: o.lineItems[0].id, qty: 1 }] });
    expect(Number((await rows(o.id))[0].qty)).toBe(1);
  }, 120_000);

  it("D2-9/D2-10/D2-11: an over-delivered {q2,d4} line: restated at 2 is 200, raised to 3 is 200, cut to 1 is 409", async () => {
    const p = await product("d29");
    const o = await delivered(p, 2, 4);
    const id = o.lineItems[0].id;
    await edit(o.id, { items: [{ id, qty: 2 }] });
    expect(Number((await rows(o.id))[0].qty)).toBe(2);
    await edit(o.id, { items: [{ id, qty: 3 }] });
    expect(Number((await rows(o.id))[0].qty)).toBe(3);
    const before = await snapshot(o.id);
    await expect(edit(o.id, { items: [{ id, qty: 1 }] })).rejects.toMatchObject(LOWER);
    expect(await snapshot(o.id)).toEqual(before);
  }, 120_000);

  it("D2-12: a fully delivered 10 of 10 cut to 6 is 409, nothing written, stock unmoved (the old b1050 repro-1 cut)", async () => {
    const p = await product("d212");
    const o = await delivered(p, 10, 10);
    const before = await snapshot(o.id);
    await expect(edit(o.id, { items: [{ id: o.lineItems[0].id, qty: 6 }] })).rejects.toMatchObject(
      LOWER,
    );
    expect(await snapshot(o.id)).toEqual(before);
    expect(await stock(p)).toBe(90);
  }, 120_000);
});
