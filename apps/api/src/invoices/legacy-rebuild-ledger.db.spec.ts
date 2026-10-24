/**
 * Row 683 (SA-789 F2, row 558 class) against real Postgres. `reconcileOrderDraftInvoiceLocked` (the legacy single-draft
 * rebuild) deletes and re-creates every item of an order's sole draft mirror and left the regulated ledger untouched:
 *  - content unchanged → only the pointer goes stale (F1 resolves it through the order line): no ledger write (R5);
 *  - content changed (75 → 50) → the ledger kept SALE 75 and the filing overstated by 25 (R4, the serious variant).
 * After F2 a change resyncs (REVERSAL + SALE through `resyncInvoiceLedger`); no change writes nothing. A split or a sibling
 * non-void invoice never reaches this path (R6, the SA-681 fence).
 *
 * Runs only under `npm run local:test:db`. Every tenant is a throwaway `qa-683-<run>-<n>` slug (`assertTestTenant`).
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InvoiceItemSystemKind } from "@prisma/client";
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
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb(
  "the legacy single-draft rebuild keeps the regulated ledger equal to the lines (683, SA-789 F2)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let invoices: InvoicesService;
    const tenantIds: string[] = [];
    let seq = 0;

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const mod = await Test.createTestingModule({
        providers: [
          InvoicesService,
          {
            provide: SellingRestrictionsService,
            useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
          },
          EstimatesService,
          NumberingService,
          { provide: PrismaService, useValue: prisma },
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
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
          },
          entitlementAuthorityFromEntitlements, // #2241
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
    });

    afterAll(async () => {
      const swallow = () => undefined; // a failed cleanup must never mask a test's result
      for (const tenantId of tenantIds) {
        const where = { where: { tenantId } };
        await prisma.regulatedSalesLedger.deleteMany(where).catch(swallow);
        await prisma.invoicePayment.deleteMany(where).catch(swallow);
        await prisma.paymentCounter.deleteMany(where).catch(swallow);
        await prisma.invoiceItem.deleteMany(where).catch(swallow);
        await prisma.invoice.deleteMany(where).catch(swallow);
        await prisma.deliveryMutation.deleteMany(where).catch(swallow);
        await prisma.orderItem.deleteMany(where).catch(swallow);
        await prisma.order.deleteMany(where).catch(swallow);
        await prisma.product.deleteMany(where).catch(swallow);
        await prisma.trackedCategory.deleteMany(where).catch(swallow);
        await prisma.customer.deleteMany(where).catch(swallow);
        await prisma.user.deleteMany(where).catch(swallow);
        await prisma.auditLog.deleteMany(where).catch(swallow);
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      }
      await prisma?.$disconnect();
    });

    /**
     * A PENDING order with ONE regulated line (75 units), mirrored by its sole DRAFT invoice carrying that line, and the
     * SALE row the ledger booked for it (the row 558 shape before the rebuild).
     */
    async function seed(label: string, opts: { sibling?: boolean } = {}) {
      seq += 1;
      const slug = assertTestTenant(
        `qa-683-${RUN}-${seq}-${label}`,
        "legacy-rebuild-ledger.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({ data: { slug, name: `683 ${slug}` } });
      tenantIds.push(tenant.id);
      const tenantId = tenant.id;
      const user = await prisma.user.create({
        data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
      });
      const customer = await prisma.customer.create({
        data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
      });
      const cat = await prisma.trackedCategory.create({
        data: { tenantId, name: `Tobacco ${label}`, taxType: "NONE", unitBasis: "pack" },
      });
      const product = await prisma.product.create({
        data: {
          tenantId,
          name: `cig ${label}`,
          unit: "each",
          pricePerUnit: 1,
          trackedCategoryId: cat.id,
        },
      });
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          status: "PENDING",
          subtotal: 75,
          tax: 0,
          total: 75,
        },
      });
      const li = await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          qty: 75,
          unitPrice: 1,
          subtotal: 75,
          // B297: the order line's own category snapshot is what the rebuild copies onto the invoice line
          trackedCategoryId: cat.id,
        },
      });
      const draft = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-683-${RUN}-${seq}`,
          status: "DRAFT",
          subtotal: 75,
          taxAmount: 0,
          total: 75,
        },
      });
      const item = await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: draft.id,
          orderItemId: li.id,
          productId: product.id,
          description: `cig ${label}`,
          qty: 75,
          unitPrice: 1,
          subtotal: 75,
          trackedCategoryId: cat.id,
        },
      });
      const soldAt = new Date();
      const period = `${soldAt.getUTCFullYear()}-${String(soldAt.getUTCMonth() + 1).padStart(2, "0")}`;
      await prisma.regulatedSalesLedger.create({
        data: {
          tenantId,
          trackedCategoryId: cat.id,
          entryType: "SALE",
          orderId: order.id,
          orderItemId: li.id,
          invoiceId: draft.id,
          invoiceItemId: item.id,
          qty: 75,
          unitBasisQty: 75,
          netSales: 75,
          soldAt,
          periodBucket: period,
        },
      });
      if (opts.sibling) {
        await prisma.invoice.create({
          data: {
            tenantId,
            customerId: customer.id,
            orderId: order.id,
            invoiceNumber: `INV-683-${RUN}-${seq}-R1`,
            status: "SENT",
            subtotal: 0,
            taxAmount: 0,
            total: 0,
          },
        });
      }
      return {
        tenantId,
        orderId: order.id,
        lineId: li.id,
        draftId: draft.id,
        itemId: item.id,
        catId: cat.id,
      };
    }

    const ledgerOf = (s: { tenantId: string; draftId: string }) =>
      prisma.regulatedSalesLedger.findMany({
        where: { tenantId: s.tenantId, invoiceId: s.draftId },
        orderBy: { createdAt: "asc" },
      });
    /** The net the filing sums: SALE rows positive, REVERSAL rows as stored (the ledger's own sign). */
    const netQty = (rows: Array<{ qty: unknown }>) => rows.reduce((a, r) => a + Number(r.qty), 0);
    const rebuild = (s: { tenantId: string; orderId: string }) =>
      tenantCtx.run(s.tenantId, () =>
        invoices.reconcileOrderDraftInvoice(s.orderId, { basis: "order" }),
      );

    it("R4: the order line goes 75 → 50 and the legacy rebuild runs: the ledger nets 50 (master: 75)", async () => {
      const s = await seed("r4");
      await prisma.orderItem.update({ where: { id: s.lineId }, data: { qty: 50, subtotal: 50 } });
      const result: any = await rebuild(s);
      expect(result?.id).toBe(s.draftId); // the legacy path ran
      const items = await prisma.invoiceItem.findMany({ where: { invoiceId: s.draftId } });
      expect(items.map((i) => Number(i.qty))).toEqual([50]);
      expect(items[0].id).not.toBe(s.itemId); // rotated
      const rows = await ledgerOf(s);
      expect(netQty(rows)).toBe(50);
      // #3682 NIT-4: the shape, not just the net: the seeded SALE 75, its REVERSAL −75, then SALE 50 on the new item.
      expect(rows.map((r) => [r.entryType, Number(r.qty)])).toEqual([
        ["SALE", 75],
        ["REVERSAL", -75],
        ["SALE", 50],
      ]);
      expect(rows[2].invoiceItemId).toBe(items[0].id);
    }, 60_000);

    it("R4b: a category change alone (same qty) also resyncs", async () => {
      const s = await seed("r4b");
      const other = await prisma.trackedCategory.create({
        data: { tenantId: s.tenantId, name: "Vape r4b", taxType: "NONE", unitBasis: "pack" },
      });
      // the order line's category snapshot moves (an edit re-filing the line); the rebuild copies the snapshot
      await prisma.orderItem.update({
        where: { id: s.lineId },
        data: { trackedCategoryId: other.id },
      });
      await rebuild(s);
      const rows = await ledgerOf(s);
      const byCat = (c: string) => netQty(rows.filter((r) => r.trackedCategoryId === c));
      expect(byCat(s.catId)).toBe(0);
      expect(byCat(other.id)).toBe(75);
    }, 60_000);

    it("R5 (guard): a rebuild with no regulated content change writes no ledger row", async () => {
      const s = await seed("r5");
      await rebuild(s);
      const rows = await ledgerOf(s);
      expect(rows).toHaveLength(1); // the original SALE only
      expect(netQty(rows)).toBe(75);
    }, 60_000);

    it("R6 (guard): a sibling non-void invoice keeps the legacy rebuild away (SA-681 fence); the ledger is untouched", async () => {
      const s = await seed("r6", { sibling: true });
      await prisma.orderItem.update({ where: { id: s.lineId }, data: { qty: 50, subtotal: 50 } });
      await rebuild(s);
      const items = await prisma.invoiceItem.findMany({ where: { invoiceId: s.draftId } });
      expect(items.map((i) => i.id)).toEqual([s.itemId]); // not rebuilt
      expect(await ledgerOf(s)).toHaveLength(1);
    }, 60_000);

    /**
     * R7 (SA-789 F4): a FREEFORM DRAFT (no order) carrying a regulated line and its SALE row. `update()` resyncs the ledger
     * only when `syncLines` (built from the ORDER) is non-empty, so a freeform edit that drops the line and re-adds it at
     * a new qty may leave the ledger as it was. Observe first; after 683, ledger = lines.
     */
    it("R7: a freeform DRAFT drops and re-adds its regulated line at 50: the ledger nets 50", async () => {
      seq += 1;
      const slug = assertTestTenant(`qa-683-${RUN}-${seq}-r7`, "legacy-rebuild-ledger.db.spec.ts");
      const tenant = await prisma.tenant.create({ data: { slug, name: `683 ${slug}` } });
      tenantIds.push(tenant.id);
      const tenantId = tenant.id;
      const user = await prisma.user.create({
        data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
      });
      const customer = await prisma.customer.create({
        data: { userId: user.id, businessName: "c r7", contactName: "c r7", tenantId },
      });
      const cat = await prisma.trackedCategory.create({
        data: { tenantId, name: "Tobacco r7", taxType: "NONE", unitBasis: "pack" },
      });
      const product = await prisma.product.create({
        data: {
          tenantId,
          name: "cig r7",
          unit: "each",
          pricePerUnit: 1,
          trackedCategoryId: cat.id,
        },
      });
      const inv = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          invoiceNumber: `INV-683-${RUN}-${seq}`,
          status: "DRAFT",
          subtotal: 75,
          taxAmount: 0,
          total: 75,
        },
      });
      const item = await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: inv.id,
          productId: product.id,
          description: "cig r7",
          qty: 75,
          unitPrice: 1,
          subtotal: 75,
          trackedCategoryId: cat.id,
        },
      });
      const soldAt = new Date();
      await prisma.regulatedSalesLedger.create({
        data: {
          tenantId,
          trackedCategoryId: cat.id,
          entryType: "SALE",
          invoiceId: inv.id,
          invoiceItemId: item.id,
          qty: 75,
          unitBasisQty: 75,
          netSales: 75,
          soldAt,
          periodBucket: `${soldAt.getUTCFullYear()}-${String(soldAt.getUTCMonth() + 1).padStart(2, "0")}`,
        },
      });
      // drop the line (its id is not sent) and add it again at 50
      await tenantCtx.run(tenantId, () =>
        invoices.update(inv.id, {
          items: [{ productId: product.id, description: "cig r7", qty: 50, unitPrice: 1 }],
        } as any),
      );
      const items = await prisma.invoiceItem.findMany({ where: { invoiceId: inv.id } });
      expect(items.map((i) => Number(i.qty))).toEqual([50]);
      const rows = await prisma.regulatedSalesLedger.findMany({
        where: { tenantId, invoiceId: inv.id },
      });
      expect(netQty(rows)).toBe(50);
    }, 60_000);
  },
);
