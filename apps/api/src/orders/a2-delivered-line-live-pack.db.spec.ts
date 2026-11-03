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
        await prisma.orderItem.deleteMany(where).catch(swallow);
        await prisma.order.deleteMany(where).catch(swallow);
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
      boxes?: number;
      pieces?: number;
      qty?: number;
      subtotal?: number;
      /** the line's own unitsPerBox snapshot (default none) */
      snapshot?: number;
      status?: string;
      invoiced?: boolean;
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
          boxes: shape.boxes ?? 10,
          pieces: shape.pieces ?? 0,
          ...(shape.snapshot ? { unitsPerBox: shape.snapshot } : {}),
          deliveredQty: shape.invoiced === false ? 0 : soldQty,
          invoicedQty: shape.invoiced === false ? 0 : soldQty,
          unitPrice: 10,
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
            unitPrice: 10,
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
      const s = await seed("qty", null, 24);
      const before = await state(s);
      await edit(s, { qty: 9 });
      const after = await state(s);
      measure("A2-3 before", before);
      measure("A2-3 after", after);
      expect(after.line.subtotal).toBe(90);
      expect(after.invoices[0]!.total).toBe(90);
      expect(after.stock).toBe(before.stock); // a price/qty edit of a delivered line books no stock
      expect(after.ledger).toEqual(before.ledger);
    }, 120_000);

    it("A2-6: the 12-pack line, qty 120 -> 100, is 8 boxes + 4 pieces of a 12-pack at the stored price (83.33), not of the live 24", async () => {
      const s = await seed("qty12", 12, 24);
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
      const s = await seed("splitonly", 12, 24);
      const before = await state(s);
      await edit(s, { boxes: 8, pieces: 4 });
      const after = await state(s);
      measure("A2-18 after", after);
      expect(after.line).toMatchObject({ qty: 100, boxes: 8, pieces: 4, unitsPerBox: 12 });
      unmoved(before, after);
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

    it("A2-20 (guard): the no-pack line edited twice - qty 10 -> 9, then price 12 - gives the same shape both times, stock 90", async () => {
      const s = await seed("twice", null, 24);
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
      unmoved(before, one);
      unmoved(before, two);
    }, 120_000);

    it("A2-21: the no-pack line whose product has NO pack now, qty 10 -> 9: boxes 9, 90.00, stock unmoved", async () => {
      const s = await seed("nopack-nolive", null, null);
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
      unmoved(before, after);
    }, 120_000);

    it("A2-22 (guard): A2-21, then the product gains a 24-pack, then another edit: still boxes 9, 99.00, stock unmoved", async () => {
      const s = await seed("nopack-gains", null, null);
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
      unmoved(before, after);
    }, 120_000);

    it("A2-12 (guard): after the qty edit 10 -> 9, a STANDARD return of 3 restocks 3 (measured on master: 3) - anything but 3 or a park goes back to the SA", async () => {
      const s = await seed("ret", null, 24);
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
      expect(after.stock - mid.stock).toBe(3);
    }, 120_000);
  },
);
