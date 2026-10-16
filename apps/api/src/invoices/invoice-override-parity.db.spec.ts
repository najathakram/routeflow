/**
 * H3b — DB lane: POST /invoices and POST /orders/sell store the SAME price decision for the same typed
 * input, read back from real Postgres columns: priceType, originalPrice, overrideReason, overriddenBy,
 * unitPrice and the line / document total. Both run through the REAL services (OrdersService.create — the
 * writer /orders/sell calls — and InvoicesService.create), Object.create harness like
 * orders/backorder-marker.db.spec.ts. A tier-3 customer, list $24 / tier $20, x3.
 *
 *  Pack line (green on this branch):
 *   K1 typed $24 with a reason: both MANUAL, original = list ($24), the trimmed reason, the acting user, $72
 *   K2 typed $20 (the tier price): both SPECIAL, original = list, no reason, no stamp, $60
 *   K3 typed $24, no reason: both refuse with the same 400 and neither writes a row
 *   K4 typed $15 with a reason: both DISCOUNTED, original = list
 *   K5 the invoice EDIT: a stored override re-sent at the same price keeps its stamp; a changed price re-decides
 *
 *  Unit line (Case x3, list $24 / tier $20 per Case) — [needs #3432]: master's order unit path still compares
 *  a typed price against the LIST price and takes no reason, so these go green only once the order unit
 *  path of #3432 (fix/h3-unit-line-tier-override) is on master:
 *   P1 typed $24 + reason: both MANUAL, reason + user, $72
 *   P2 typed $20: both SPECIAL, no stamp, $60
 *   P3 typed $24, no reason: both 400
 *
 * Run via `npm run local:test:db` (compose Postgres); collected only by jest.db.config.js. SAFETY: one
 * throwaway `qa-h3b-<run>` tenant approved by `assertTestTenant`; afterAll deletes exactly its rows.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: class InvoicePdfService {} }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { BadRequestException, Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { InvoicesService } from "./invoices.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "../orders/testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("H3b invoice vs order price decision parity, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  let invoices: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-h3b-${run}`, "invoice-override-parity.db.spec.ts");
  let tenantId = "";
  let operatorUserId = "";
  let customerId = "";
  let packId = "";
  let boxedId = "";
  let invoiceSeq = 0;

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
  const inTenant = (fn: () => Promise<any>): Promise<any> => tenantCtx.run(tenantId, fn);

  /** One line through POST /orders/sell's writer (OrdersService.create). */
  const sellOrder = (productId: string, over: Record<string, unknown>) =>
    inTenant(() =>
      orders.create({ customerId, items: [{ productId, qty: 3, ...over }] }, operator(), {
        skipAutoMerge: true,
      }),
    );
  /** The same line through POST /invoices (InvoicesService.create, the controller passes user.sub). */
  const makeInvoice = (productId: string, over: Record<string, unknown>) =>
    inTenant(() =>
      invoices.create(
        { customerId, items: [{ description: "Line", productId, qty: 3, ...over }] },
        operatorUserId,
      ),
    );

  const num = (v: unknown) => (v == null ? null : Number(v));
  const shape = (r: any) => ({
    priceType: r.priceType,
    originalPrice: num(r.originalPrice),
    overrideReason: r.overrideReason,
    overriddenBy: r.overriddenBy,
    unitPrice: num(r.unitPrice),
    subtotal: num(r.subtotal),
  });
  const orderLine = (orderId: string) =>
    raw.orderItem.findFirstOrThrow({ where: { orderId }, orderBy: { position: "asc" } });
  const invoiceLine = (invoiceId: string) =>
    raw.invoiceItem.findFirstOrThrow({ where: { invoiceId } });
  const counts = async () => ({
    orders: await raw.order.count({ where: { tenantId } }),
    invoices: await raw.invoice.count({ where: { tenantId } }),
  });

  /** Both paths for one input; resolves to their stored lines + document totals. */
  async function both(productId: string, over: Record<string, unknown>) {
    const order = await sellOrder(productId, over);
    const invoice = await makeInvoice(productId, over);
    const o = await orderLine(order.id);
    const i = await invoiceLine(invoice.id);
    const ot = await raw.order.findUniqueOrThrow({ where: { id: order.id } });
    const it = await raw.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    return {
      o: shape(o),
      i: shape(i),
      orderTotal: num(ot.total),
      invoiceTotal: num(it.total),
      invoice,
    };
  }
  async function bothRefuse(productId: string, over: Record<string, unknown>) {
    const before = await counts();
    const fromOrder = await sellOrder(productId, over).catch((e) => e);
    const fromInvoice = await makeInvoice(productId, over).catch((e) => e);
    expect(fromOrder).toBeInstanceOf(BadRequestException);
    expect(fromInvoice).toBeInstanceOf(BadRequestException);
    expect(fromInvoice.getResponse()).toEqual(fromOrder.getResponse());
    expect(await counts()).toEqual(before); // neither wrote a row
  }

  async function wipe() {
    const orderIds = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
      (o) => o.id,
    );
    await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
    await raw.stockMovement.deleteMany({ where: { tenantId } });
    await raw.invoiceItem.deleteMany({ where: { tenantId } });
    await raw.invoice.deleteMany({ where: { tenantId } });
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
    const anyMethod = new Proxy(
      {},
      { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
    );
    invoices = Object.assign(Object.create(InvoicesService.prototype), {
      prisma,
      systemConfig,
      entitlements: { hasFlag: async () => true },
      authority: { can: async () => false }, // flag.msrp off
      sellingRestrictions: { assertLinesSellable: async () => undefined },
      ledger: anyMethod,
      gateway: anyMethod,
      generateInvoiceNumber: async () => `INV-H3B-${run}-${++invoiceSeq}`,
      logger: new Logger("h3b-invoices"),
    });
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
      invoicesService: {
        findOpenOrderDraft: async () => null,
        revertLinkedInvoicesForOrderEdit: async () => undefined,
        resyncOrderInvoicesForEdit: async () => [],
        ...INVOICE_EDIT_STUBS,
        reconcileOrderDraftInvoice: async () => undefined,
      },
      creditNotes: {
        settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
        previewOrderCreditRelease: async () => [],
        releaseOrderCreditsInTx: async () => undefined,
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      oversellReader: { read: async () => "off" },
    });

    tenantId = (await raw.tenant.create({ data: { slug, name: `H3b ${slug}` } })).id;
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
      data: { email: `b-${run}@example.test`, username: `b-${run}`, role: "CUSTOMER", tenantId },
    });
    customerId = (
      await raw.customer.create({
        data: {
          userId: buyer.id,
          businessName: "Acme",
          contactName: "Tester",
          pricingTier: 3,
          isTaxExempt: true, // the document total is the line total
          tenantId,
        },
      })
    ).id;
    // a loose pack product: list $24, tier-3 $20
    packId = (
      await raw.product.create({
        data: {
          name: `Widget ${run}`,
          unit: "Each",
          pricePerUnit: "24.00",
          priceTier3: "20.00",
          currentStock: 100_000,
          tenantId,
        },
      })
    ).id;
    // a 24-piece box with a Case level: list $24 / tier-3 $20 per Case
    boxedId = (
      await raw.product.create({
        data: {
          name: `Soda ${run}`,
          unit: "Box",
          unitsPerBox: 24,
          pricePerUnit: "1.00",
          currentStock: 100_000,
          tenantId,
        },
      })
    ).id;
    await raw.productUnit.create({
      data: {
        tenantId,
        productId: boxedId,
        label: "Case",
        factorToBase: 288,
        price: "24.00",
        priceTier3: "20.00",
      },
    });
  }, 120_000);

  beforeEach(wipe);

  afterAll(async () => {
    try {
      await wipe();
      await raw.auditLog.deleteMany({ where: { tenantId } });
      await raw.productUnit.deleteMany({ where: { tenantId } });
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

  describe("pack line", () => {
    it("K1: typed $24 with a reason — both MANUAL, original = list, the trimmed reason, the user, $72", async () => {
      const r = await both(packId, { unitPrice: 24, overrideReason: "  agreed at list  " });
      expect(r.i).toEqual(r.o);
      expect(r.i).toEqual({
        priceType: "MANUAL",
        originalPrice: 24,
        overrideReason: "agreed at list",
        overriddenBy: operatorUserId,
        unitPrice: 24,
        subtotal: 72,
      });
      expect(r.invoiceTotal).toBe(72);
      expect(r.orderTotal).toBe(72);
    });

    it("K2: typed $20 (the tier price) — both SPECIAL, original = list, no reason, no stamp, $60", async () => {
      const r = await both(packId, { unitPrice: 20 });
      expect(r.i).toEqual(r.o);
      expect(r.i).toEqual({
        priceType: "SPECIAL",
        originalPrice: 24,
        overrideReason: null,
        overriddenBy: null,
        unitPrice: 20,
        subtotal: 60,
      });
      expect(r.invoiceTotal).toBe(60);
      expect(r.orderTotal).toBe(60);
    });

    it("K3: typed $24 with NO reason — both 400 with the same message and neither writes a row", async () => {
      await bothRefuse(packId, { unitPrice: 24 });
    });

    it("K4: typed $15 with a reason — both DISCOUNTED, original = list", async () => {
      const r = await both(packId, { unitPrice: 15, overrideReason: "damaged" });
      expect(r.i).toEqual(r.o);
      expect(r.i).toMatchObject({
        priceType: "DISCOUNTED",
        originalPrice: 24,
        overrideReason: "damaged",
        overriddenBy: operatorUserId,
        subtotal: 45,
      });
    });

    it("K5: the invoice EDIT keeps a re-sent stored override and re-decides a changed price", async () => {
      const invoice = await makeInvoice(packId, {
        unitPrice: 24,
        overrideReason: "agreed at list",
      });
      const stored = await invoiceLine(invoice.id);
      const edit = (item: Record<string, unknown>) =>
        inTenant(() =>
          invoices.update(
            invoice.id,
            { items: [{ id: stored.id, description: "Line", productId: packId, ...item }] },
            operatorUserId,
          ),
        );
      // qty changes, the price is re-sent with no reason: the stamp stays
      await edit({ qty: 5, unitPrice: 24 });
      expect(shape(await invoiceLine(invoice.id))).toMatchObject({
        priceType: "MANUAL",
        overrideReason: "agreed at list",
        overriddenBy: operatorUserId,
        subtotal: 120,
      });
      // a changed price off the special price needs a reason
      await expect(edit({ qty: 5, unitPrice: 22 })).rejects.toBeInstanceOf(BadRequestException);
      await edit({ qty: 5, unitPrice: 22, overrideReason: "new deal" });
      expect(shape(await invoiceLine(invoice.id))).toMatchObject({
        priceType: "DISCOUNTED",
        originalPrice: 24,
        overrideReason: "new deal",
        subtotal: 110,
      });
      // back on the tier price: SPECIAL, the stamp cleared
      await edit({ qty: 5, unitPrice: 20 });
      expect(shape(await invoiceLine(invoice.id))).toMatchObject({
        priceType: "SPECIAL",
        overrideReason: null,
        overriddenBy: null,
        subtotal: 100,
      });
    });
  });

  describe("unit line (Case x3) [needs #3432 for the ORDER side]", () => {
    it("P1: typed $24 with a reason — both MANUAL, the reason, the user, $72", async () => {
      const r = await both(boxedId, {
        unitLabel: "Case",
        unitPrice: 24,
        overrideReason: "agreed at list",
      });
      expect(r.i).toEqual(r.o);
      expect(r.i).toEqual({
        priceType: "MANUAL",
        originalPrice: 24,
        overrideReason: "agreed at list",
        overriddenBy: operatorUserId,
        unitPrice: 24,
        subtotal: 72,
      });
      expect(r.invoiceTotal).toBe(72);
      expect(r.orderTotal).toBe(72);
    });

    it("P2: typed $20 — both SPECIAL, no stamp, $60", async () => {
      const r = await both(boxedId, { unitLabel: "Case", unitPrice: 20 });
      expect(r.i).toEqual(r.o);
      expect(r.i).toMatchObject({
        priceType: "SPECIAL",
        overrideReason: null,
        overriddenBy: null,
        unitPrice: 20,
        subtotal: 60,
      });
    });

    it("P3: typed $24 with NO reason — both 400 and neither writes a row", async () => {
      await bothRefuse(boxedId, { unitLabel: "Case", unitPrice: 24 });
    });
  });
});
