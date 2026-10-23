/**
 * Row 683 (SA-789 F3, TO_VERIFY orders.service merge): `forceConsolidateCustomer` deletes each LOSER's open DRAFT mirror
 * (items, then the invoice) with no `settleRegulatedLedger`. A draft mirror that carries SALE rows leaves them live with
 * no invoice behind them, so the period's regulated sales overstate by the loser's units. R10 observes it, then requires
 * the loser draft's ledger to net 0 after the merge (the customer-purge shape: INVOICE_ZEROED before the delete).
 *
 * Runs only under `npm run local:test:db`. The tenant is a throwaway `qa-683m-<run>` slug.
 */

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { Test } from "@nestjs/testing";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SNAPSHOT_RATE = 0.05;

describeDb(
  "683 F3: an order merge settles the loser draft's regulated ledger (real Postgres)",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    /** #3682 NIT-1: the REAL InvoicesService (wired as legacy-rebuild-ledger.db.spec.ts does), for R10b's rebook. */
    let realInvoices: InvoicesService;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-683m-${run}`, "merge-loser-ledger.db.spec.ts");
    let tenantId = "";
    let operatorUserId = "";
    let driverUserId = "";
    let buyerUserId = "";
    let driverId = "";
    let customerId = "";
    let categoryId = "";
    let productId = "";
    const routeIds: string[] = [];
    const warn = jest.spyOn(Logger.prototype, "warn");

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
    const driver = (): JwtPayload =>
      ({
        sub: driverUserId,
        username: `dr-${run}`,
        role: "DRIVER",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;

    const inTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
    const edit = (orderId: string, dto: any) =>
      inTenant(() => orders.updateOrderItems(orderId, dto, operator()));
    /** A real staff create: the writer stamps the trio at the category's rate AT THAT MOMENT. */
    const createOrder = async (qty: number) => {
      const created: any = await inTenant(() =>
        orders.create({ customerId, items: [{ productId, qty }] }, operator(), {
          skipAutoMerge: true,
        }),
      );
      await raw.orderItem.updateMany({ where: { orderId: created.id }, data: { deliveredQty: 0 } });
      await raw.order.update({ where: { id: created.id }, data: { skipAutoMerge: false } });
      return created.id as string;
    };
    async function wipe() {
      await raw.changeRequest.deleteMany({ where: { tenantId } });
      await raw.deliveryMutation.deleteMany({ where: { tenantId } });
      await raw.orderIdempotencyKey.deleteMany({ where: { tenantId } });
      const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
        (o) => o.id,
      );
      await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: ids } } });
      await raw.stockMovement.deleteMany({ where: { product: { tenantId } } });
      await raw.regulatedSalesLedger.deleteMany({ where: { tenantId } });
      await raw.invoiceItem.deleteMany({ where: { invoice: { tenantId } } });
      await raw.invoice.deleteMany({ where: { tenantId } });
      await raw.orderItem.deleteMany({ where: { tenantId } });
      await raw.order.deleteMany({ where: { tenantId } });
      await raw.routeRunStop.deleteMany({ where: { routeRun: { route: { tenantId } } } });
      await raw.routeRun.deleteMany({ where: { route: { tenantId } } });
      await raw.routeStop.deleteMany({ where: { route: { tenantId } } });
      await raw.route.deleteMany({ where: { tenantId } });
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
        ledger: new RegulatedLedgerService(prisma),
        invoicesService: {
          // R10 needs the REAL lookup: the merge deletes the loser's open DRAFT mirror it finds here.
          findOpenOrderDraft: async (orderId: string, tx?: any) =>
            (tx ?? prisma.forTenant()).invoice.findFirst({
              where: { orderId, status: "DRAFT", deliveryBatchId: null },
              orderBy: { createdAt: "asc" },
            }),
          revertLinkedInvoicesForOrderEdit: async () => undefined,
          resyncOrderInvoicesForEdit: async () => [],
          ...INVOICE_EDIT_STUBS,
          reconcileOrderDraftInvoice: async () => undefined,
          releaseWalletPaymentsInTx: async () => undefined,
          voidInvoiceInTx: async () => undefined,
        },
        creditNotes: {
          settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
          previewOrderCreditRelease: async () => [],
          releaseOrderCreditsInTx: async () => undefined,
        },
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        oversellReader: { read: async () => false },
      });

      const invoicesMod = await Test.createTestingModule({
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
      realInvoices = invoicesMod.get(InvoicesService);

      tenantId = (await raw.tenant.create({ data: { slug, name: `683 ${slug}` } })).id;
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
        data: {
          email: `buyer-${run}@example.test`,
          username: `buyer-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      buyerUserId = buyer.id;
      customerId = (
        await raw.customer.create({
          data: { userId: buyer.id, businessName: "Acme Retail", contactName: "Tester", tenantId },
        })
      ).id;
      driverUserId = (
        await raw.user.create({
          data: {
            email: `dr-${run}@example.test`,
            username: `dr-${run}`,
            role: "DRIVER",
            tenantId,
          },
        })
      ).id;
      driverId = (await raw.driver.create({ data: { userId: driverUserId, tenantId } as any })).id;
      categoryId = (
        await raw.trackedCategory.create({
          data: {
            tenantId,
            name: `Excise ${run}`,
            taxType: "EXCISE_PER_UNIT",
            rate: SNAPSHOT_RATE,
            priceIncludesTax: false,
          },
        })
      ).id;
      productId = (
        await raw.product.create({
          data: {
            name: `Cigar ${run}`,
            unit: "each",
            pricePerUnit: "1.00",
            currentStock: 1000,
            trackedCategoryId: categoryId,
            tenantId,
          },
        })
      ).id;
    }, 120_000);

    beforeEach(async () => {
      warn.mockClear();
      await wipe();
      await raw.trackedCategory.update({
        where: { id: categoryId },
        data: { rate: SNAPSHOT_RATE },
      });
      await raw.product.update({ where: { id: productId }, data: { currentStock: 1000 } });
    });

    afterAll(async () => {
      try {
        await wipe();
        await raw.auditLog.deleteMany({ where: { tenantId } });
        await raw.driver.deleteMany({ where: { tenantId } });
        await raw.productUnit.deleteMany({ where: { tenantId } });
        await raw.product.deleteMany({ where: { tenantId } });
        await raw.trackedCategory.deleteMany({ where: { tenantId } });
        await raw.customer.deleteMany({ where: { tenantId } });
        await raw.user.deleteMany({ where: { tenantId } });
        await raw.tenant.deleteMany({ where: { id: tenantId } });
      } finally {
        warn.mockRestore();
        await _resetLockPoolForTests();
        await prisma?.$disconnect();
        await raw?.$disconnect();
        await pool?.end();
      }
    }, 120_000);

    /** A sole DRAFT mirror for `orderId` with one regulated line of `qty`, and the SALE row the ledger booked for it. */
    async function draftWithSale(orderId: string, qty: number) {
      const line = await raw.orderItem.findFirstOrThrow({ where: { orderId } });
      const inv = await raw.invoice.create({
        data: {
          tenantId,
          customerId,
          orderId,
          invoiceNumber: `INV-683m-${run}-${orderId.slice(0, 6)}`,
          status: "DRAFT",
          subtotal: qty,
          taxAmount: 0,
          total: qty,
        },
      });
      const item = await raw.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: inv.id,
          orderItemId: line.id,
          productId,
          description: "cigar",
          qty,
          unitPrice: 1,
          subtotal: qty,
          trackedCategoryId: categoryId,
        },
      });
      const soldAt = new Date();
      await raw.regulatedSalesLedger.create({
        data: {
          tenantId,
          trackedCategoryId: categoryId,
          entryType: "SALE",
          orderId,
          orderItemId: line.id,
          invoiceId: inv.id,
          invoiceItemId: item.id,
          qty,
          unitBasisQty: qty,
          netSales: qty,
          soldAt,
          periodBucket: `${soldAt.getUTCFullYear()}-${String(soldAt.getUTCMonth() + 1).padStart(2, "0")}`,
        },
      });
      return inv.id;
    }

    it("R10: the loser's draft mirror is deleted by the merge; its SALE rows net 0 (master: still live)", async () => {
      const a = await createOrder(10);
      const b = await createOrder(14);
      const drafts = [await draftWithSale(a, 10), await draftWithSale(b, 14)];
      await inTenant(() => orders.forceConsolidateCustomer(customerId));
      const survivors = await raw.order.findMany({ where: { tenantId } });
      expect(survivors).toHaveLength(1);
      const liveInvoices = new Set(
        (await raw.invoice.findMany({ where: { tenantId }, select: { id: true } })).map(
          (i) => i.id,
        ),
      );
      const deleted = drafts.filter((d) => !liveInvoices.has(d));
      expect(deleted).toHaveLength(1); // the loser's draft is gone
      const rows = await raw.regulatedSalesLedger.findMany({
        where: { tenantId, invoiceId: deleted[0] },
      });
      expect(rows.reduce((s, r) => s + Number(r.qty), 0)).toBe(0);
    }, 120_000);

    it("R10b (#3682 NIT-1): with the REAL invoice rebuild, the tenant's net regulated qty equals the merged qty (24)", async () => {
      const a = await createOrder(10);
      const b = await createOrder(14);
      const drafts = [await draftWithSale(a, 10), await draftWithSale(b, 14)];
      // The merge's own invoice calls go to the real service: the loser's draft lookup AND the winner's draft rebuild,
      // which must book the merged lines (if that rebook regressed, the filing would understate by the loser's 14).
      const stubbed = orders.invoicesService;
      orders.invoicesService = {
        ...stubbed,
        findOpenOrderDraft: (orderId: string, tx?: any) =>
          realInvoices.findOpenOrderDraft(orderId, tx),
        reconcileOrderDraftInvoice: (...args: any[]) =>
          (realInvoices.reconcileOrderDraftInvoice as any)(...args),
      };
      try {
        await inTenant(() => orders.forceConsolidateCustomer(customerId));
      } finally {
        orders.invoicesService = stubbed;
      }
      const survivors = await raw.order.findMany({ where: { tenantId }, select: { id: true } });
      expect(survivors).toHaveLength(1);
      const rows = await raw.regulatedSalesLedger.findMany({ where: { tenantId } });
      const net = rows.reduce((s, r) => s + Number(r.qty), 0);
      expect(net).toBe(24);
      // The loser's draft nets 0; every live row sits on the winner's surviving draft.
      const live = new Set(
        (await raw.invoice.findMany({ where: { tenantId }, select: { id: true } })).map(
          (i) => i.id,
        ),
      );
      const loser = drafts.find((d) => !live.has(d))!;
      expect(rows.filter((r) => r.invoiceId === loser).reduce((s, r) => s + Number(r.qty), 0)).toBe(
        0,
      );
    }, 120_000);
  },
);
