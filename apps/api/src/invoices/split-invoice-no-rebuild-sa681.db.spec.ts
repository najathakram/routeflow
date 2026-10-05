/**
 * SA-681 (P0), real Postgres: an order split into partial invoices must not be double-billed at
 * Mark Delivered. Fixtures come from the real writers (createPartialFromOrder) over real rows; the
 * assertions read the persisted invoices and OrderItem.invoicedQty back.
 *
 *   - a 10-box boxed order split 6 / 4 → Mark Delivered: both partials keep their qty and money, no
 *     third invoice, Σ(total) == the order total, invoicedQty == the order qty. Pre-fix: the oldest
 *     partial was rebuilt to the whole order (10 boxes) while the 4-box partial still billed.
 *   - split 6 only → Mark Delivered: the 6-box partial is untouched and ONE remainder invoice bills
 *     the other 4 boxes.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js collects `*.db.spec.ts`; RUN_DB_SPECS set,
 * DATABASE_URL pointed at the compose/dbspec Postgres). Tenants are throwaway `qa-681-<run>-<n>` slugs
 * approved by `assertTestTenant`; `afterAll` deletes what they hold. Scaffold: split-invoice-cas-2612.db.spec.ts.
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
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
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { settleOrderInvoice } from "../orders/order-status-invoicing";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-681-${RUN_SUFFIX}-${tenantSeq}`,
    "split-invoice-no-rebuild-sa681.db.spec.ts",
  );
}

describeDb(
  "split invoices: Mark Delivered never rebuilds a partial to the full order (SA-681)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let invoicesService: InvoicesService;
    const createdTenantIds: string[] = [];

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          InvoicesService,
          {
            provide: SellingRestrictionsService,
            useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
          },
          EstimatesService,
          NumberingService,
          { provide: PrismaService, useValue: prisma },
          { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
          { provide: EmailService, useValue: { sendInvoice: jest.fn() } },
          { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
          {
            provide: SystemConfigService,
            useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
          },
          {
            provide: RegulatedLedgerService,
            useValue: { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() },
          },
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
              autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0 }),
              settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
              releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
            },
          },
          {
            provide: MessagingService,
            useValue: { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() },
          },
          { provide: StorageService, useValue: { upload: jest.fn() } },
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
          },
          entitlementAuthorityFromEntitlements,
          {
            provide: CommissionEngineService,
            useValue: {
              syncInvoiceCommissionSafe: jest.fn(),
              syncOrderInvoices: jest.fn(),
              removeInvoiceCommission: jest.fn(),
            },
          },
        ],
      }).compile();
      invoicesService = module.get(InvoicesService);
    });

    afterAll(async () => {
      for (const tenantId of createdTenantIds) {
        const where = { tenantId };
        await (async () => {
          await prisma.invoiceItem.deleteMany({ where });
          await prisma.invoice.deleteMany({ where });
          await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
          await prisma.order.deleteMany({ where });
          await prisma.product.deleteMany({ where });
          await prisma.customer.deleteMany({ where });
          await prisma.user.deleteMany({ where });
          await prisma.tenant.deleteMany({ where: { id: tenantId } });
        })().catch(() => undefined);
      }
      await prisma?.$disconnect();
    });

    /** A CONFIRMED order of ONE boxed line: 10 boxes x 12 pieces @ 2.35 = 282.00, tax 23.27, total 305.27. */
    async function seedBoxedOrder() {
      const slug = freshTenantSlug();
      const tenant = await prisma.tenant.create({ data: { slug, name: `681 ${slug}` } });
      createdTenantIds.push(tenant.id);
      const user = await prisma.user.create({
        data: {
          email: `${slug}@example.invalid`,
          username: slug,
          role: "CUSTOMER",
          tenantId: tenant.id,
        },
      });
      const customer = await prisma.customer.create({
        data: {
          userId: user.id,
          businessName: "681",
          contactName: "681",
          tenantId: tenant.id,
        } as any,
      });
      const product = await prisma.product.create({
        data: {
          name: `681 ${slug}`,
          unit: "ea",
          pricePerUnit: 2.35,
          unitsPerBox: 12,
          tenantId: tenant.id,
        } as any,
      });
      const order = await prisma.order.create({
        data: {
          tenantId: tenant.id,
          customerId: customer.id,
          orderNumber: `ORD-681-${slug}`,
          status: "CONFIRMED",
          subtotal: 282,
          tax: 23.27,
          total: 305.27,
        } as any,
      });
      const item = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          qty: 120,
          boxes: 10,
          pieces: 0,
          unitsPerBox: 12,
          unitPrice: 2.35,
          subtotal: 282,
          status: "CONFIRMED",
          tenantId: tenant.id,
        } as any,
      });
      return { tenantId: tenant.id, orderId: order.id, orderItemId: item.id };
    }

    const split = (s: { tenantId: string; orderId: string; orderItemId: string }, qty: number) =>
      tenantCtx.run(s.tenantId, () =>
        invoicesService.createPartialFromOrder(s.orderId, {
          items: [{ orderItemId: s.orderItemId, qty }],
        } as any),
      );

    const markDelivered = (s: { tenantId: string; orderId: string }) =>
      tenantCtx.run(s.tenantId, () =>
        settleOrderInvoice(
          { invoicesService, prisma } as any,
          s.orderId,
          { error: jest.fn() } as unknown as Logger,
          "delivered",
        ),
      );

    const invoicesOf = (orderId: string) =>
      prisma.invoice.findMany({
        where: { orderId, status: { not: "VOID" } },
        orderBy: { createdAt: "asc" },
        include: { items: true },
      });
    const total = (rows: Array<{ total: unknown }>) =>
      Math.round(rows.reduce((a, r) => a + Number(r.total), 0) * 100) / 100;

    it("a 10-box order split 6 / 4: Mark Delivered leaves both partials, no third invoice, Σ == order total", async () => {
      const s = await seedBoxedOrder();
      await split(s, 72);
      await split(s, 48);
      const before = (await invoicesOf(s.orderId)).map((i) => [
        i.id,
        Number(i.total),
        i.items.length,
      ]);
      expect(total(await invoicesOf(s.orderId))).toBe(305.27);

      expect(await markDelivered(s)).toBeUndefined();

      const after = await invoicesOf(s.orderId);
      expect(after).toHaveLength(2); // pre-fix: still 2, but the first rebuilt to 10 boxes (total 305.27)
      expect(after.map((i) => [i.id, Number(i.total), i.items.length])).toEqual(before);
      expect(after.map((i) => i.items.map((it) => Number(it.qty)))).toEqual([[72], [48]]);
      expect(total(after)).toBe(305.27); // pre-fix: 427.38
      const line = await prisma.orderItem.findUniqueOrThrow({ where: { id: s.orderItemId } });
      expect(Number(line.invoicedQty)).toBe(120);
    });

    it("split 6 only: Mark Delivered keeps the partial and bills ONE remainder invoice for the other 4 boxes", async () => {
      const s = await seedBoxedOrder();
      await split(s, 72);
      const [p1] = await invoicesOf(s.orderId);

      expect(await markDelivered(s)).toBeUndefined();

      const after = await invoicesOf(s.orderId);
      expect(after).toHaveLength(2); // pre-fix: 1 (the 6-box partial rebuilt to all 10)
      expect(after[0].id).toBe(p1.id);
      expect(Number(after[0].total)).toBe(Number(p1.total));
      expect(after[1].items.map((it) => Number(it.qty))).toEqual([48]);
      expect(total(after)).toBe(305.27);
      const line = await prisma.orderItem.findUniqueOrThrow({ where: { id: s.orderItemId } });
      expect(Number(line.invoicedQty)).toBe(120);
    });

    it("SA-687 M1: 6/4, then a replace-all (delete + recreate the lines), then Mark Delivered: no third invoice, review conflict", async () => {
      const s = await seedBoxedOrder();
      await split(s, 72);
      await split(s, 48);
      // updateOrderItems' replaceAll: `orderItem.deleteMany` + a recreated line (invoicedQty default 0).
      // InvoiceItem.orderItemId is onDelete SetNull, so the partials' lines are orphaned.
      const old = await prisma.orderItem.findUniqueOrThrow({ where: { id: s.orderItemId } });
      await prisma.orderItem.deleteMany({ where: { orderId: s.orderId } });
      await prisma.orderItem.create({
        data: {
          orderId: s.orderId,
          productId: old.productId,
          qty: old.qty,
          boxes: old.boxes,
          pieces: old.pieces,
          unitsPerBox: old.unitsPerBox,
          unitPrice: old.unitPrice,
          subtotal: old.subtotal,
          status: "CONFIRMED",
          tenantId: s.tenantId,
        } as any,
      });
      const orphaned = await prisma.invoiceItem.count({
        where: { invoice: { orderId: s.orderId }, orderItemId: null },
      });
      expect(orphaned).toBe(2);

      const out = await markDelivered(s);

      expect(out).toBeInstanceOf(ConflictException);
      const after = await invoicesOf(s.orderId);
      expect(after).toHaveLength(2); // unguarded: 3
      expect(total(after)).toBe(305.27); // unguarded: 610.54
    });
  },
);
