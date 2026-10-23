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
  },
);
