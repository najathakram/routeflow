/**
 * SA-1093 A-2 (repro, master 6e9dae10eb): a delivered box-split line with NO unitsPerBox snapshot, whose product gained a
 * pack after the sale, is edited through the REAL OrdersService.updateOrderItems. The edit's box-size fallback reads the LIVE
 * product (orders.service.ts, "unitsPerBox = product?.unitsPerBox"), so a price-only edit re-derives the line's boxes/pieces
 * from the new pack and re-prices the line. Real: OrdersService (Object.create harness), InvoicesService, ReturnsService,
 * RegulatedLedgerService, PrismaService. Rows A2-1, A2-1b, A2-2, A2-3, A2-5, A2-5b, A2-6, A2-7, A2-9, A2-13, A2-16, A2-17, A2-19 and A2-21 are RED on master (A2-0, A2-8, A2-10, A2-11a/b, A2-12, A2-18, A2-20 and A2-22 are guards). Every case prints a MEASURE line (line, header, invoice, stock ledger) so the values
 * can be quoted; the asserts pin the CORRECT value, so each row is RED on master where the bug is real.
 *
 * SAFETY: throwaway `qa-a2pack-<run>-<n>` tenants approved by assertTestTenant, deleted in afterAll.
 */
jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { AuditService } from "../audit/audit.service";
import { ReturnsService } from "../returns/returns.service";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const measure = (label: string, value: unknown) =>
  process.stdout.write(`\nMEASURE ${label} ${JSON.stringify(value)}\n`);

describeDb(
  "SA-1093 A-2 — an edit on a delivered line must not adopt the live pack, real Postgres",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let invoices: InvoicesService;
    let returns: ReturnsService;
    let orders: any;
    const tenantIds: string[] = [];
    let seq = 0;

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const anyMethod = new Proxy(
        {},
        {
          get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()),
        },
      );
      const systemConfig = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
      const mod = await Test.createTestingModule({
        providers: [
          InvoicesService,
          ReturnsService,
          AuditService,
          {
            provide: SellingRestrictionsService,
            useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
          },
          EstimatesService,
          {
            provide: NumberingService,
            useValue: {
              reserveNext: jest.fn().mockImplementation(async () => `NUM-A2-${RUN}-${++seq}`),
            },
          },
          { provide: PrismaService, useValue: prisma },
          { provide: RouteFlowGateway, useValue: anyMethod },
          {
            provide: EmailService,
            useValue: {
              sendInvoice: jest.fn(),
              isEmailConfigured: jest.fn().mockResolvedValue(true),
            },
          },
          { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
          { provide: SystemConfigService, useValue: systemConfig },
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
      invoices = mod.get(InvoicesService);
      returns = mod.get(ReturnsService);
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
        promotionsService: { activeForCatalog: async () => [] },
        tenantCtx,
        invoicesService: invoices,
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
      });
    }, 120_000);

    afterAll(async () => {
      const swallow = () => undefined;
      for (const tenantId of tenantIds) {
        const where = { where: { tenantId } };
        await prisma.auditLog.deleteMany(where).catch(swallow);
        await prisma.returnItem.deleteMany(where).catch(swallow);
        await prisma.return.deleteMany(where).catch(swallow);
        await prisma.regulatedSalesLedger.deleteMany(where).catch(swallow);
        await prisma.invoicePayment.deleteMany(where).catch(swallow);
        await prisma.invoiceItem.deleteMany(where).catch(swallow);
        await prisma.invoice.deleteMany(where).catch(swallow);
        await prisma.stockMovement.deleteMany({ where: { product: { tenantId } } }).catch(swallow);
        await (prisma as any).orderRevision?.deleteMany(where).catch(swallow);
        await prisma.deliveryMutation.deleteMany(where).catch(swallow);
        await prisma.orderItem.deleteMany(where).catch(swallow);
        await prisma.order.deleteMany(where).catch(swallow);
        await prisma.routeRunStop.deleteMany(where).catch(swallow);
        await prisma.routeRun.deleteMany(where).catch(swallow);
        await prisma.routeStop.deleteMany(where).catch(swallow);
        await prisma.route.deleteMany(where).catch(swallow);
        await prisma.driver.deleteMany(where).catch(swallow);
        await prisma.product.deleteMany(where).catch(swallow);
        await prisma.customer.deleteMany(where).catch(swallow);
        await prisma.user.deleteMany(where).catch(swallow);
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      }
      await prisma?.$disconnect();
    }, 120_000);

    /**
     * One DELIVERED order of one line, wholly invoiced by one SENT invoice. `soldUpb` is the product's pack AT SALE
     * (null = it had none); the line is box-split (boxes=10, pieces=0) with NO unitsPerBox snapshot, 10 boxes at $10.00
     * (subtotal 100.00). Stock is 90 (the sale's 10 are already out). The product THEN gains `livePack`.
     */
    interface SeedShape {
      /** the stored split (default boxes 10, pieces 0, qty 10 x the pack at sale) */
      boxes?: number | null;
      pieces?: number;
      /** the stored line price (default 10) */
      unitPrice?: number;
      qty?: number;
      subtotal?: number;
      /** the line's own unitsPerBox snapshot (default none) */
      snapshot?: number;
      status?: string;
      invoiced?: boolean;
      /** OrderItem.promoFreeUnits (a promo's free units, priced out of the line) */
      freeUnits?: number;
    }
    async function seed(
      label: string,
      soldUpb: number | null,
      livePack: number | null,
      shape: SeedShape = {},
    ) {
      seq += 1;
      const slug = assertTestTenant(
        `qa-a2pack-${RUN}-${seq}-${label}`,
        "a2-delivered-line-live-pack.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({ data: { slug, name: `a2 ${slug}` } });
      tenantIds.push(tenant.id);
      const tenantId = tenant.id;
      const operator = await prisma.user.create({
        data: {
          email: `o-${slug}@example.invalid`,
          username: `o-${slug}`,
          role: "OPERATOR",
          tenantId,
        },
      });
      const buyer = await prisma.user.create({
        data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
      });
      const customer = await prisma.customer.create({
        data: { userId: buyer.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
      });
      const product = await prisma.product.create({
        data: {
          tenantId,
          name: `Acme cola ${label}`,
          unit: "case",
          pricePerUnit: 10,
          currentStock: 90,
          ...(soldUpb ? { unitsPerBox: soldUpb } : {}),
        } as any,
      });
      const soldQty = shape.qty ?? (soldUpb ? 10 * soldUpb : 10); // a box-split line stores total pieces in qty
      const lineSubtotal = shape.subtotal ?? 100;
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          status: shape.status ?? "DELIVERED",
          orderNumber: `ORD-A2-${RUN}-${seq}`,
          subtotal: lineSubtotal,
          tax: 0,
          total: lineSubtotal,
        } as any,
      });
      const line = await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          qty: soldQty,
          boxes: shape.boxes === undefined ? 10 : shape.boxes,
          pieces: shape.pieces ?? 0,
          ...(shape.snapshot ? { unitsPerBox: shape.snapshot } : {}),
          ...(shape.freeUnits ? { promoFreeUnits: shape.freeUnits } : {}),
          deliveredQty: shape.invoiced === false ? 0 : soldQty,
          invoicedQty: shape.invoiced === false ? 0 : soldQty,
          unitPrice: shape.unitPrice ?? 10,
          subtotal: lineSubtotal,
        } as any,
      });
      const invoice =
        shape.invoiced === false
          ? null
          : await prisma.invoice.create({
              data: {
                tenantId,
                customerId: customer.id,
                orderId: order.id,
                invoiceNumber: `INV-A2-${RUN}-${seq}`,
                status: "SENT",
                subtotal: lineSubtotal,
                taxAmount: 0,
                total: lineSubtotal,
              },
            });
      if (invoice) {
        await prisma.invoiceItem.create({
          data: {
            tenantId,
            invoiceId: invoice.id,
            orderItemId: line.id,
            productId: product.id,
            description: `Acme cola ${label}`,
            qty: soldQty,
            unitPrice: shape.unitPrice ?? 10,
            subtotal: lineSubtotal,
          } as any,
        });
      }
      // the pack is gained AFTER the sale, by hand (no Boxes answer, no stock conversion): the SA's "any route"
      await prisma.product.update({ where: { id: product.id }, data: { unitsPerBox: livePack } }); // null: the pack was cleared
      return {
        tenantId,
        orderId: order.id,
        lineId: line.id,
        invoiceId: invoice?.id ?? null,
        productId: product.id,
        operatorId: operator.id,
        slug,
      };
    }
    type Seeded = Awaited<ReturnType<typeof seed>>;

    /**
     * SA-1149 (20:55Z block): the one producible shape of a delivered line that can be cut down to what was delivered,
     * a route SHORT DROP. The order rides a COMPLETED run stop, the line's deliveredQty is d, and one PARTIAL
     * DeliveryMutation (quantityDelivered = d, the stop's id, the driver) is the evidence a route delivery writes.
     * A DELIVERED order with d below qty and no evidence is a shape no writer produces (round 1's seed was one).
     */
    async function shortRouteDrop(s: Seeded, delivered: number) {
      const driverUser = await prisma.user.create({
        data: {
          email: `d-${s.slug}@example.invalid`,
          username: `d-${s.slug}`,
          role: "DRIVER",
          tenantId: s.tenantId,
        },
      });
      const driver = await prisma.driver.create({
        data: { userId: driverUser.id, tenantId: s.tenantId } as any,
      });
      const order = await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } });
      const route = await prisma.route.create({
        data: { name: `a2 ${s.slug}`, tenantId: s.tenantId } as any,
      });
      const routeStop = await prisma.routeStop.create({
        data: {
          tenantId: s.tenantId,
          routeId: route.id,
          stopNumber: 1,
          customerId: order.customerId,
        } as any,
      });
      const run = await prisma.routeRun.create({
        data: {
          tenantId: s.tenantId,
          routeId: route.id,
          scheduledDate: new Date("2026-11-15T00:00:00.000Z"),
          status: "COMPLETED" as any,
          driverId: driver.id,
        },
      });
      const stop = await prisma.routeRunStop.create({
        data: {
          tenantId: s.tenantId,
          routeRunId: run.id,
          routeStopId: routeStop.id,
          stopNumber: 1,
          status: "COMPLETED" as any,
        } as any,
      });
      await prisma.order.update({
        where: { id: s.orderId },
        data: { routeRunId: run.id, routeRunStopId: stop.id },
      });
      await prisma.orderItem.update({ where: { id: s.lineId }, data: { deliveredQty: delivered } });
      await prisma.deliveryMutation.create({
        data: {
          tenantId: s.tenantId,
          orderId: s.orderId,
          orderItemId: s.lineId,
          productId: s.productId,
          routeRunStopId: stop.id,
          driverId: driver.id,
          type: "PARTIAL",
          qty: String(delivered),
          quantityDelivered: String(delivered),
        } as any,
      });
      return s;
    }

    const operatorOf = (s: Seeded): JwtPayload =>
      ({
        sub: s.operatorId,
        username: `o-${s.slug}`,
        role: "OPERATOR",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId: s.tenantId,
        tenantSlug: s.slug,
      }) as JwtPayload;

    const edit = (s: Seeded, item: Record<string, unknown>) =>
      tenantCtx.run(s.tenantId, () =>
        orders.updateOrderItems(
          s.orderId,
          { replaceAll: false, items: [{ id: s.lineId, ...item }] },
          operatorOf(s),
        ),
      );

    /** Everything the Lead asked for, as stored: the line, the order header, the invoice and its lines, the stock ledger. */
    async function state(s: Seeded) {
      const line = await prisma.orderItem.findUniqueOrThrow({ where: { id: s.lineId } });
      const order = await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } });
      const inv = await prisma.invoice.findMany({
        where: { orderId: s.orderId },
        include: { items: true },
        orderBy: { createdAt: "asc" },
      });
      const moves = await prisma.stockMovement.findMany({
        where: { productId: s.productId },
        orderBy: { createdAt: "asc" },
      });
      const product = await prisma.product.findUniqueOrThrow({ where: { id: s.productId } });
      return {
        line: {
          qty: Number(line.qty),
          boxes: line.boxes == null ? null : Number(line.boxes),
          pieces: line.pieces == null ? null : Number(line.pieces),
          unitsPerBox: (line as any).unitsPerBox ?? null,
          unitPrice: Number(line.unitPrice),
          subtotal: Number(line.subtotal),
          overrideReason: (line as any).overrideReason ?? null,
        },
        order: {
          subtotal: Number(order.subtotal),
          total: Number(order.total),
          status: order.status,
        },
        invoices: inv.map((i) => ({
          status: i.status,
          subtotal: Number(i.subtotal),
          total: Number(i.total),
          items: i.items.map((it) => ({
            qty: Number(it.qty),
            unitPrice: Number(it.unitPrice),
            subtotal: Number(it.subtotal),
          })),
        })),
        stock: Number(product.currentStock),
        ledger: moves.map((m) => ({ type: m.type, qty: Number(m.quantity) })),
      };
    }

    it("A2-0: a payload with ONLY unitPrice never reaches the line rewrite (nothing changes): the web client always echoes qty", async () => {
      const s = await seed("onlyprice", null, 24);
      const before = await state(s);
      await edit(s, { unitPrice: 12 });
      const after = await state(s);
      measure("A2-0 only-unitPrice payload: line", after.line);
      expect(after.line).toEqual(before.line);
    }, 120_000);

    it("A2-1: a PRICE-ONLY edit (10.00 -> 12.00, qty echoed unchanged) re-prices the delivered line at 120.00 (10 boxes), not on the live pack", async () => {
      const s = await seed("price", null, 24);
      const before = await state(s);
      await edit(s, { qty: 10, unitPrice: 12 });
      const after = await state(s);
      measure("A2-1 before", before);
      measure("A2-1 after", after);
      expect(after.line.subtotal).toBe(120);
      expect(after.order.total).toBe(120);
      expect(after.invoices[0]!.total).toBe(120);
      expect(after.stock).toBe(before.stock); // a price/qty edit of a delivered line books no stock
      expect(after.ledger).toEqual(before.ledger);
      expect(after.line.unitsPerBox).toBeNull(); // no pack at sale: priced as qty x price, shape kept (see order-stock needsLivePack)
    }, 120_000);

    it("A2-1b: an ECHO of the stored values (qty 10, unitPrice 10) changes nothing: the line stays 100.00", async () => {
      const s = await seed("echo", null, 24);
      const before = await state(s);
      await edit(s, { qty: 10, unitPrice: 10 });
      const after = await state(s);
      measure("A2-1b before", before);
      measure("A2-1b after", after);
      expect(after.line.subtotal).toBe(100);
      expect(after.invoices[0]!.total).toBe(100);
      expect(after.stock).toBe(before.stock); // a price/qty edit of a delivered line books no stock
      expect(after.ledger).toEqual(before.ledger);
    }, 120_000);

    it("A2-2: a price-only edit on a line sold under a 12-pack that is now a 24-pack keeps 10 boxes (120.00)", async () => {
      const s = await seed("price12", 12, 24);
      const before = await state(s);
      await edit(s, { qty: 120, unitPrice: 12 });
      const after = await state(s);
      measure("A2-2 before", before);
      measure("A2-2 after", after);
      expect(after.line.subtotal).toBe(120);
      expect(after.line.qty).toBe(120);
      expect(after.invoices[0]!.total).toBe(120);
      expect(after.line.unitsPerBox).toBe(12); // the pack it was sold in is stamped, so it can't drift again
    }, 120_000);

    it("A2-5: the 12-pack line with boxes 10 / pieces 0 echoed in the payload stays qty 120, 120.00, stock unmoved", async () => {
      const s = await seed("boxesecho", 12, 24);
      const before = await state(s);
      await edit(s, { qty: 120, boxes: 10, pieces: 0, unitPrice: 12 });
      const after = await state(s);
      measure("A2-5 before", before);
      measure("A2-5 after", after);
      expect(after.line.qty).toBe(120);
      expect(after.line.subtotal).toBe(120);
      expect(after.invoices[0]!.total).toBe(120);
      expect(after.stock).toBe(before.stock);
      expect(after.ledger).toEqual(before.ledger);
    }, 120_000);

    it("A2-3: a QTY edit 10 -> 9 on the delivered line is 90.00, not 9 pieces of a 24-pack (3.75)", async () => {
      const s = await shortRouteDrop(await seed("qty", null, 24), 9);
      const before = await state(s);
      await edit(s, { qty: 9 });
      const after = await state(s);
      measure("A2-3 before", before);
      measure("A2-3 after", after);
      expect(after.line.subtotal).toBe(90);
      expect(after.invoices[0]!.total).toBe(90);
      // SA-1149 20:55Z: stock = 90 + max(10,9) - max(9,9) = 91; the 1 undelivered unit goes back on the shelf
      expect(before.stock).toBe(90);
      expect(after.stock).toBe(91);
      measure("A2-3 ledger", after.ledger);
    }, 120_000);

    it("A2-6: the 12-pack line, qty 120 -> 100, is 8 boxes + 4 pieces of a 12-pack at the stored price (83.33), not of the live 24", async () => {
      const s = await shortRouteDrop(await seed("qty12", 12, 24), 100);
      const before = await state(s);
      await edit(s, { qty: 100 });
      const after = await state(s);
      measure("A2-6 before", before);
      measure("A2-6 after", after);
      expect(after.line).toMatchObject({
        qty: 100,
        boxes: 8,
        pieces: 4,
        unitsPerBox: 12,
        unitPrice: 10,
        subtotal: 83.33,
      });
      expect(after.invoices[0]!.total).toBe(83.33);
      // SA-1149 20:55Z: 90 + 120 - 100 = 110, the 20 undelivered pieces go back, in pieces
      expect(after.stock).toBe(110);
    }, 120_000);

    it("A2-7: A2-2 on an OPEN order (no invoice yet) reads the same pack: 12, 10 boxes, 120.00", async () => {
      const s = await seed("open12", 12, 24, { status: "CONFIRMED", invoiced: false });
      const before = await state(s);
      await edit(s, { qty: 120, unitPrice: 12 });
      const after = await state(s);
      measure("A2-7 before", before);
      measure("A2-7 after", after);
      expect(after.line).toMatchObject({ qty: 120, boxes: 10, unitsPerBox: 12, subtotal: 120 });
      expect(after.order.total).toBe(120);
    }, 120_000);

    it("A2-8 (guard): 0 boxes + 6 pieces with no snapshot, subtotal 2.50 fits only the live 24-pack - the live pack is used and an echo changes no money", async () => {
      const s = await seed("zero-live", null, 24, {
        boxes: 0,
        pieces: 6,
        qty: 6,
        subtotal: 2.5,
      });
      const before = await state(s);
      await edit(s, { qty: 6, unitPrice: 10 });
      const after = await state(s);
      measure("A2-8 before", before);
      measure("A2-8 after", after);
      expect(after.line.subtotal).toBe(2.5);
      expect(after.line.qty).toBe(6);
      expect(after.invoices[0]!.total).toBe(2.5);
    }, 120_000);

    it("A2-9: 0 boxes + 6 pieces with no snapshot, subtotal 7.00 fits neither pack - the edit is refused with the code and nothing is written", async () => {
      const s = await seed("zero-neither", null, 24, {
        boxes: 0,
        pieces: 6,
        qty: 6,
        subtotal: 7,
      });
      const before = await state(s);
      let thrown: any = null;
      try {
        await edit(s, { qty: 6, unitPrice: 10 });
      } catch (e) {
        thrown = e;
      }
      const after = await state(s);
      measure("A2-9 before", before);
      measure("A2-9 after", after);
      measure("A2-9 thrown", thrown ? (thrown.getResponse?.() ?? String(thrown)) : null);
      expect(thrown?.getResponse?.()).toMatchObject({ code: "STORED_LINE_PACK_UNREADABLE" });
      expect(after).toEqual(before);
    }, 120_000);

    it("A2-10 (guard): a reason-only edit on A2-9's line still writes the reason and nothing else", async () => {
      const s = await seed("zero-reason", null, 24, {
        boxes: 0,
        pieces: 6,
        qty: 6,
        subtotal: 7,
      });
      const before = await state(s);
      await edit(s, { overrideReason: "customer asked" });
      const after = await state(s);
      measure("A2-10 after", after.line);
      expect(after.line).toEqual({ ...before.line, overrideReason: "customer asked" });
      expect(after.invoices).toEqual(before.invoices);
    }, 120_000);

    it("A2-11a (guard): a line WITH its snapshot (12) reads it, not the live 24 - unchanged from master", async () => {
      const s = await seed("snap12", 12, 24, { snapshot: 12 });
      const before = await state(s);
      await edit(s, { qty: 120, unitPrice: 12 });
      const after = await state(s);
      measure("A2-11a before", before);
      measure("A2-11a after", after);
      expect(after.line).toMatchObject({ qty: 120, boxes: 10, unitsPerBox: 12, subtotal: 120 });
      expect(after.invoices[0]!.total).toBe(120);
    }, 120_000);

    it("A2-11b (guard): a line whose own pack equals the live pack (24) re-prices exactly as before", async () => {
      const s = await seed("same24", 24, 24);
      const before = await state(s);
      await edit(s, { qty: 240, unitPrice: 12 });
      const after = await state(s);
      measure("A2-11b before", before);
      measure("A2-11b after", after);
      expect(after.line).toMatchObject({ qty: 240, boxes: 10, unitsPerBox: 24, subtotal: 120 });
      expect(after.invoices[0]!.total).toBe(120);
    }, 120_000);

    const unmoved = (before: any, after: any) => {
      expect(after.stock).toBe(before.stock);
      expect(after.ledger).toEqual(before.ledger);
    };
    const refusal = async (s: Seeded, item: Record<string, unknown>) => {
      try {
        await edit(s, item);
      } catch (e: any) {
        return e?.getResponse?.() ?? String(e);
      }
      return null;
    };

    it("A2-5b: the A2-5 payload with the price UNCHANGED (qty 120, boxes 10) keeps qty 120, 100.00 and stock 90", async () => {
      const s = await seed("boxesecho2", 12, 24);
      const before = await state(s);
      await edit(s, { qty: 120, boxes: 10, pieces: 0 });
      const after = await state(s);
      measure("A2-5b before", before);
      measure("A2-5b after", after);
      expect(after.line).toMatchObject({ qty: 120, boxes: 10, unitsPerBox: 12, subtotal: 100 });
      expect(after.invoices[0]!.total).toBe(100);
      unmoved(before, after);
    }, 120_000);

    it("A2-13: sold at a 12-pack, the product's pack since CLEARED, values echoed: 100.00, qty 120, snapshot 12", async () => {
      const s = await seed("cleared", 12, null);
      const before = await state(s);
      await edit(s, { qty: 120, unitPrice: 10 });
      const after = await state(s);
      measure("A2-13 before", before);
      measure("A2-13 after", after);
      expect(after.line).toMatchObject({ qty: 120, boxes: 10, unitsPerBox: 12, subtotal: 100 });
      expect(after.invoices[0]!.total).toBe(100);
      unmoved(before, after);
    }, 120_000);

    it("A2-16: the web's real (pre-fix) payload on the 12-pack line - qty 120, boxes 5, price 12 - disagrees at the line's own pack: refused, nothing written", async () => {
      const s = await seed("webpayload", 12, 24);
      const before = await state(s);
      const thrown = await refusal(s, { qty: 120, boxes: 5, pieces: 0, unitPrice: 12 });
      const after = await state(s);
      measure("A2-16 after", after);
      measure("A2-16 thrown", thrown);
      expect(thrown).toMatchObject({ code: "QTY_SPLIT_MISMATCH" });
      expect(after).toEqual(before);
    }, 120_000);

    it("A2-17: the old web's payload on the no-pack line - qty 10, boxes 0, pieces 10, price 12 - is 120.00, boxes = qty, stock unmoved", async () => {
      const s = await seed("oldweb", null, 24);
      const before = await state(s);
      await edit(s, { qty: 10, boxes: 0, pieces: 10, unitPrice: 12 });
      const after = await state(s);
      measure("A2-17 before", before);
      measure("A2-17 after", after);
      expect(after.line).toMatchObject({
        qty: 10,
        boxes: 10,
        pieces: 0,
        unitsPerBox: null,
        subtotal: 120,
      });
      expect(after.invoices[0]!.total).toBe(120);
      unmoved(before, after);
    }, 120_000);

    it("A2-18 (guard): a split with NO qty on the 12-pack line - boxes 8, pieces 4 - is qty 100 at the line's own pack", async () => {
      const s = await shortRouteDrop(await seed("splitonly", 12, 24), 100);
      const before = await state(s);
      await edit(s, { boxes: 8, pieces: 4 });
      const after = await state(s);
      measure("A2-18 after", after);
      expect(after.line).toMatchObject({ qty: 100, boxes: 8, pieces: 4, unitsPerBox: 12 });
      // SA-1149 20:55Z: 90 + 120 - 100 = 110 (the 20 undelivered pieces; not a defect, see A6-F2)
      expect(after.stock).toBe(110);
    }, 120_000);

    it("A2-19: a fractional qty on the no-pack line is refused, nothing written", async () => {
      const s = await seed("fraction", null, 24);
      const before = await state(s);
      const thrown = await refusal(s, { qty: 9.5 });
      const after = await state(s);
      measure("A2-19 after", after);
      measure("A2-19 thrown", thrown);
      expect(thrown).toMatchObject({ code: "INVALID_LINE_SPLIT" });
      expect(after).toEqual(before);
    }, 120_000);

    it("A2-20 (guard): the no-pack line edited twice - qty 10 -> 9, then price 12 - gives the same shape both times, stock 91", async () => {
      const s = await shortRouteDrop(await seed("twice", null, 24), 9);
      const before = await state(s);
      await edit(s, { qty: 9 });
      const one = await state(s);
      await edit(s, { qty: 9, unitPrice: 12 });
      const two = await state(s);
      measure("A2-20 one", one.line);
      measure("A2-20 two", two.line);
      expect(one.line).toMatchObject({
        qty: 9,
        boxes: 9,
        pieces: 0,
        unitsPerBox: null,
        subtotal: 90,
      });
      expect(two.line).toMatchObject({
        qty: 9,
        boxes: 9,
        pieces: 0,
        unitsPerBox: null,
        subtotal: 108,
      });
      // SA-1149 20:55Z: 91 after the first edit and 91 after the second (no qty change)
      expect(one.stock).toBe(91);
      expect(two.stock).toBe(91);
    }, 120_000);

    it("A2-21: the no-pack line whose product has NO pack now, qty 10 -> 9: boxes 9, 90.00, stock 91", async () => {
      const s = await shortRouteDrop(await seed("nopack-nolive", null, null), 9);
      const before = await state(s);
      await edit(s, { qty: 9 });
      const after = await state(s);
      measure("A2-21 before", before);
      measure("A2-21 after", after);
      expect(after.line).toMatchObject({
        qty: 9,
        boxes: 9,
        pieces: 0,
        unitsPerBox: null,
        subtotal: 90,
      });
      expect(after.invoices[0]!.total).toBe(90);
      expect(after.stock).toBe(91); // SA-1149 20:55Z: 90 + 10 - 9
    }, 120_000);

    it("A2-22 (guard): A2-21, then the product gains a 24-pack, then another edit: still boxes 9, 99.00, stock 91", async () => {
      const s = await shortRouteDrop(await seed("nopack-gains", null, null), 9);
      const before = await state(s);
      await edit(s, { qty: 9 });
      await prisma.product.update({ where: { id: s.productId }, data: { unitsPerBox: 24 } });
      await edit(s, { qty: 9, unitPrice: 11 });
      const after = await state(s);
      measure("A2-22 after", after);
      expect(after.line).toMatchObject({
        qty: 9,
        boxes: 9,
        pieces: 0,
        unitsPerBox: null,
        subtotal: 99,
      });
      expect(after.stock).toBe(91); // SA-1149 20:55Z: after both edits
      expect(before.stock).toBe(90);
    }, 120_000);

    it("A2-12 (guard): after the qty edit 10 -> 9, a STANDARD return of 3 restocks 3 (measured on master: 3) - anything but 3 or a park goes back to the SA", async () => {
      const s = await shortRouteDrop(await seed("ret", null, 24), 9);
      await edit(s, { qty: 9 });
      const mid = await state(s);
      const ret = await prisma.return.create({
        data: {
          tenantId: s.tenantId,
          orderId: s.orderId,
          customerId: (await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } }))
            .customerId,
          kind: "STANDARD",
          reason: "DAMAGED",
          status: "IN_TRANSIT",
          returnNumber: `RET-A2-${RUN}-${seq}`,
          items: {
            create: [{ tenantId: s.tenantId, productId: s.productId, qty: 3 }],
          },
        } as any,
      });
      await tenantCtx.run(s.tenantId, () => returns.receive(ret.id, s.operatorId));
      const after = await state(s);
      measure("A2-12 line after the qty edit", mid.line);
      measure("A2-12 stock before return", mid.stock);
      measure("A2-12 stock after return", after.stock);
      measure("A2-12 ledger after return", after.ledger);
      expect(mid.stock).toBe(91); // SA-1149 20:55Z: the cut puts the 1 undelivered unit back
      expect(after.stock - mid.stock).toBe(3);
      expect(after.stock).toBe(94);
    }, 120_000);
    // ── SA-1097 A-6 rows A6-1..A6-9: a stored line with pieces and NO boxes ({boxes null, pieces 6}) ─────────────────
    const OPEN = { status: "PENDING", invoiced: false } as const;
    const refusedWith = async (s: Seeded, item: Record<string, unknown>) => {
      try {
        await edit(s, item);
      } catch (e: any) {
        return e?.getResponse?.() ?? String(e);
      }
      return null;
    };

    it("A6-1 (red): {boxes null, pieces 6}, pack never changed (24), 2.50, an echo of qty 6 at price 10 stays 2.50 and stock does not move", async () => {
      const s = await seed("a6-1", null, 24, {
        boxes: null,
        pieces: 6,
        qty: 6,
        subtotal: 2.5,
        ...OPEN,
      });
      const before = await state(s);
      await edit(s, { qty: 6, unitPrice: 10 });
      const after = await state(s);
      measure("A6-1 after", after);
      expect(after.line.subtotal).toBe(2.5);
      expect(after.stock).toBe(before.stock);
      expect(after.ledger).toEqual(before.ledger);
    }, 120_000);

    it("A6-2 (red): the same shape sold at 12 and now 24 (5.00): the echo is refused and nothing is written", async () => {
      const s = await seed("a6-2", 12, 24, {
        boxes: null,
        pieces: 6,
        qty: 6,
        subtotal: 5,
        ...OPEN,
      });
      const before = await state(s);
      const thrown = await refusedWith(s, { qty: 6, unitPrice: 10 });
      measure("A6-2 thrown", thrown);
      expect(thrown).toMatchObject({ code: "STORED_LINE_PACK_UNREADABLE" });
      expect(await state(s)).toEqual(before);
    }, 120_000);

    it("A6-3a (red): A6-2's line and the web's payload {qty 6, boxes 0, pieces 6, price 10} is refused, nothing written", async () => {
      const s = await seed("a6-3a", 12, 24, {
        boxes: null,
        pieces: 6,
        qty: 6,
        subtotal: 5,
        ...OPEN,
      });
      const before = await state(s);
      const thrown = await refusedWith(s, { qty: 6, boxes: 0, pieces: 6, unitPrice: 10 });
      measure("A6-3a thrown", thrown);
      expect(thrown).toMatchObject({ code: "STORED_LINE_PACK_UNREADABLE" });
      expect(await state(s)).toEqual(before);
    }, 120_000);

    it("A6-3b (red): the same line delivered and invoiced, the web's payload with price 12, is refused: the line and the invoice keep 5.00", async () => {
      const s = await seed("a6-3b", 12, 24, { boxes: null, pieces: 6, qty: 6, subtotal: 5 });
      const before = await state(s);
      const thrown = await refusedWith(s, { qty: 6, boxes: 0, pieces: 6, unitPrice: 12 });
      measure("A6-3b thrown", thrown);
      expect(thrown).toMatchObject({ code: "STORED_LINE_PACK_UNREADABLE" });
      expect(await state(s)).toEqual(before);
    }, 120_000);

    it("A6-4 (red): {boxes null, pieces 6}, no pack at sale, 60.00: an echo at price 12 is 72.00 and stock does not move", async () => {
      const s = await seed("a6-4", null, 24, {
        boxes: null,
        pieces: 6,
        qty: 6,
        subtotal: 60,
        ...OPEN,
      });
      const before = await state(s);
      await edit(s, { qty: 6, unitPrice: 12 });
      const after = await state(s);
      measure("A6-4 after", after);
      expect(after.line.subtotal).toBe(72);
      expect(after.stock).toBe(before.stock);
    }, 120_000);

    it("A6-5 (red): an add of {productId, pieces 6} on a pack product stamps the product's pack on the new line", async () => {
      const s = await seed("a6-5", 24, 24, { snapshot: 24, qty: 240, ...OPEN });
      await tenantCtx.run(s.tenantId, () =>
        orders.updateOrderItems(
          s.orderId,
          { replaceAll: false, items: [{ productId: s.productId, pieces: 6 }] },
          operatorOf(s),
        ),
      );
      const added = await prisma.orderItem.findFirstOrThrow({
        where: { orderId: s.orderId, id: { not: s.lineId } },
      });
      measure("A6-5 added line", {
        qty: Number(added.qty),
        boxes: added.boxes,
        pieces: added.pieces,
        unitsPerBox: (added as any).unitsPerBox,
        subtotal: Number(added.subtotal),
      });
      expect(Number((added as any).unitsPerBox)).toBe(24);
    }, 120_000);

    // ── Row F's line, edited afterwards (review-a 6598291649, review-b 6598355250): the add stamps {boxes null, pieces 6, 24} ──
    async function addPiecesLine(s: Seeded, pieces: number) {
      await tenantCtx.run(s.tenantId, () =>
        orders.updateOrderItems(
          s.orderId,
          { replaceAll: false, items: [{ productId: s.productId, pieces }] },
          operatorOf(s),
        ),
      );
      return prisma.orderItem.findFirstOrThrow({
        where: { orderId: s.orderId, id: { not: s.lineId } },
      });
    }
    const editAdded = (s: Seeded, lineId: string, item: Record<string, unknown>) =>
      tenantCtx.run(s.tenantId, () =>
        orders.updateOrderItems(
          s.orderId,
          { replaceAll: false, items: [{ id: lineId, ...item }] },
          operatorOf(s),
        ),
      );
    async function addedState(s: Seeded, lineId: string) {
      const l = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineId } });
      const p = await prisma.product.findUniqueOrThrow({ where: { id: s.productId } });
      return {
        qty: Number(l.qty),
        boxes: l.boxes == null ? null : Number(l.boxes),
        pieces: l.pieces == null ? null : Number(l.pieces),
        unitsPerBox: (l as any).unitsPerBox ?? null,
        subtotal: Number(l.subtotal),
        stock: Number(p.currentStock),
      };
    }

    it("A6-F1 (red): add {productId, pieces 6} on a 24-pack, then an echo {qty 6, price 10} stays 2.50 with its split and snapshot, stock unmoved", async () => {
      const s = await seed("a6-f1", 24, 24, { snapshot: 24, qty: 240, ...OPEN });
      const added = await addPiecesLine(s, 6);
      const before = await addedState(s, added.id);
      expect(before.subtotal).toBe(2.5);
      await editAdded(s, added.id, { qty: 6, unitPrice: 10 });
      const after = await addedState(s, added.id);
      measure("A6-F1 after the echo", after);
      expect(after.subtotal).toBe(2.5);
      expect(after.pieces).toBe(6);
      expect(after.unitsPerBox).toBe(24);
      expect(after.stock).toBe(before.stock);
    }, 120_000);

    it("A6-F2 (red): the same added line, a quantity-only edit {qty 8} is 3.33 and moves stock by the 2 pieces only", async () => {
      const s = await seed("a6-f2", 24, 24, { snapshot: 24, qty: 240, ...OPEN });
      const added = await addPiecesLine(s, 6);
      const before = await addedState(s, added.id);
      await editAdded(s, added.id, { qty: 8 });
      const after = await addedState(s, added.id);
      measure("A6-F2 after qty 8", after);
      expect(after.subtotal).toBe(3.33);
      expect(after.pieces).toBe(8);
      expect(after.stock).toBe(before.stock - 2);
    }, 120_000);

    it("A6-F3 (red): a stored {boxes null, pieces 6, snapshot 24} at 2.50: the echo stays 2.50 and stock does not move", async () => {
      const s = await seed("a6-f3", 24, 24, {
        boxes: null,
        pieces: 6,
        qty: 6,
        subtotal: 2.5,
        snapshot: 24,
        ...OPEN,
      });
      const before = await state(s);
      await edit(s, { qty: 6, unitPrice: 10 });
      const after = await state(s);
      measure("A6-F3 after", after);
      expect(after.line.subtotal).toBe(2.5);
      expect(after.line.unitsPerBox).toBe(24);
      expect(after.stock).toBe(before.stock);
    }, 120_000);

    it("A6-6 (guard): a zero line on a 12-pack typed up to 2 boxes is 24 units, 20.00, stock 66", async () => {
      const s = await seed("a6-6", 12, 12, { boxes: 0, pieces: 0, qty: 0, subtotal: 0, ...OPEN });
      await edit(s, { boxes: 2, pieces: 0, unitPrice: 10 });
      const after = await state(s);
      measure("A6-6 after", after);
      expect(after.line).toMatchObject({ qty: 24, subtotal: 20 });
      expect(after.stock).toBe(66);
    }, 120_000);

    it("A6-7 (guard): a no-charge line of 6 pieces on a 12-pack, priced to 5.00, is 2.50", async () => {
      const s = await seed("a6-7", 12, 12, {
        boxes: 0,
        pieces: 6,
        qty: 6,
        subtotal: 0,
        unitPrice: 0,
        ...OPEN,
      });
      await edit(s, { qty: 6, unitPrice: 5 });
      const after = await state(s);
      measure("A6-7 after", after);
      expect(after.line.subtotal).toBe(2.5);
    }, 120_000);

    it("A6-8 (guard): a zero line echoed beside another line's edit does not stop the other line saving", async () => {
      const s = await seed("a6-8", 12, 12, { boxes: 0, pieces: 0, qty: 0, subtotal: 0, ...OPEN });
      const other = await prisma.product.create({
        data: {
          tenantId: s.tenantId,
          name: "Acme tea a6-8",
          unit: "each",
          pricePerUnit: 10,
        } as any,
      });
      const otherLine = await prisma.orderItem.create({
        data: {
          tenantId: s.tenantId,
          orderId: s.orderId,
          productId: other.id,
          qty: 5,
          unitPrice: 10,
          subtotal: 50,
        } as any,
      });
      await tenantCtx.run(s.tenantId, () =>
        orders.updateOrderItems(
          s.orderId,
          {
            replaceAll: false,
            items: [
              { id: s.lineId, qty: 0, unitPrice: 10 },
              { id: otherLine.id, qty: 4, unitPrice: 10 },
            ],
          },
          operatorOf(s),
        ),
      );
      const saved = await prisma.orderItem.findUniqueOrThrow({ where: { id: otherLine.id } });
      measure("A6-8 other line", { qty: Number(saved.qty), subtotal: Number(saved.subtotal) });
      expect(Number(saved.qty)).toBe(4);
    }, 120_000);

    it("A6-9 (guard): 6 pieces at price 12 with a stored subtotal of 0 fits neither pack: refused", async () => {
      const s = await seed("a6-9", 12, 12, {
        boxes: 0,
        pieces: 6,
        qty: 6,
        subtotal: 0,
        unitPrice: 12,
        ...OPEN,
      });
      const before = await state(s);
      const thrown = await refusedWith(s, { qty: 6, unitPrice: 12 });
      expect(thrown).toMatchObject({ code: "STORED_LINE_PACK_UNREADABLE" });
      expect(await state(s)).toEqual(before);
    }, 120_000);

    // ── SA-1097 A-6 item 6: rows for the mutants the reviews found no lane for ───────────────────────────────────────
    it("A6-M1 (mutant: native echo / no-pack agreement at the live axis): native's payload on the no-pack line - qty 10, boxes 10, pieces 0, price 12 - is 120.00 and stock does not move", async () => {
      const s = await seed("a6-m1", null, 24);
      const before = await state(s);
      await edit(s, { qty: 10, boxes: 10, pieces: 0, unitPrice: 12 });
      const after = await state(s);
      measure("A6-M1 after", after);
      expect(after.line).toMatchObject({
        qty: 10,
        boxes: 10,
        pieces: 0,
        unitsPerBox: null,
        subtotal: 120,
      });
      expect(after.invoices[0]!.total).toBe(120);
      expect(after.stock).toBe(before.stock);
      expect(after.ledger).toEqual(before.ledger);
    }, 120_000);

    it("A6-M2 (mutant: the server read ignores free units): a no-pack line of 10 boxes with 2 free (80.00) echoed at the same price stays 80.00", async () => {
      const s = await seed("a6-m2", null, 24, { subtotal: 80, freeUnits: 2, ...OPEN });
      const before = await state(s);
      await edit(s, { qty: 10, unitPrice: 10 });
      const after = await state(s);
      measure("A6-M2 after", after);
      expect(after.line.subtotal).toBe(80);
      expect(after.stock).toBe(before.stock);
      expect(after.ledger).toEqual(before.ledger);
    }, 120_000);

    it("A6-M3 (mutant: a snapshot of 1 is a pack / skips the helper): a line stamped 1 (no pack) with a 24-pack product now, qty 10 -> 9, is 9 boxes, 90.00", async () => {
      const s = await seed("a6-m3", null, 24, { snapshot: 1, ...OPEN });
      const before = await state(s);
      await edit(s, { qty: 9, unitPrice: 10 });
      const after = await state(s);
      measure("A6-M3 after", after);
      expect(after.line).toMatchObject({ qty: 9, boxes: 9, pieces: 0, subtotal: 90 });
      expect(after.line.unitsPerBox === null || after.line.unitsPerBox === 1).toBe(true);
      expect(after.stock - before.stock).toBe(1); // an open order: the 1 box released goes back on the shelf, at the line's own pack (1)
    }, 120_000);
  },
);
