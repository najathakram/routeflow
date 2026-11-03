/**
 * SA-1093 A-2 (repro, master 6e9dae10eb): a delivered box-split line with NO unitsPerBox snapshot, whose product gained a
 * pack after the sale, is edited through the REAL OrdersService.updateOrderItems. The edit's box-size fallback reads the LIVE
 * product (orders.service.ts, "unitsPerBox = product?.unitsPerBox"), so a price-only edit re-derives the line's boxes/pieces
 * from the new pack and re-prices the line. Real: OrdersService (Object.create harness), InvoicesService, ReturnsService,
 * RegulatedLedgerService, PrismaService. Rows A2-1, A2-1b, A2-2 and A2-3 are RED on master (A2-0 and A2-4 are guards). Every case prints a MEASURE line (line, header, invoice, stock ledger) so the values
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
    async function seed(label: string, soldUpb: number | null, livePack: number) {
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
      const soldQty = soldUpb ? 10 * soldUpb : 10; // a box-split line stores total pieces in qty
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          status: "DELIVERED",
          orderNumber: `ORD-A2-${RUN}-${seq}`,
          subtotal: 100,
          tax: 0,
          total: 100,
        } as any,
      });
      const line = await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          qty: soldQty,
          boxes: 10,
          pieces: 0,
          deliveredQty: soldQty,
          invoicedQty: soldQty,
          unitPrice: 10,
          subtotal: 100,
        } as any,
      });
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-A2-${RUN}-${seq}`,
          status: "SENT",
          subtotal: 100,
          taxAmount: 0,
          total: 100,
        },
      });
      await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          orderItemId: line.id,
          productId: product.id,
          description: `Acme cola ${label}`,
          qty: soldQty,
          unitPrice: 10,
          subtotal: 100,
        } as any,
      });
      // the pack is gained AFTER the sale, by hand (no Boxes answer, no stock conversion): the SA's "any route"
      await prisma.product.update({ where: { id: product.id }, data: { unitsPerBox: livePack } });
      return {
        tenantId,
        orderId: order.id,
        lineId: line.id,
        invoiceId: invoice.id,
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
    }, 120_000);

    it("A2-4 (guard at master): after the qty edit keeps its id and date and stamps snapshot 24, a STANDARD return of 3 restocks 3 (the 72 needs #4130's A-1 factor and a recorded Boxes answer)", async () => {
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
      measure("A2-4 line after the qty edit", mid.line);
      measure("A2-4 stock before return", mid.stock);
      measure("A2-4 stock after return", after.stock);
      measure("A2-4 ledger after return", after.ledger);
      expect(after.stock - mid.stock).toBe(3);
    }, 120_000);
  },
);
