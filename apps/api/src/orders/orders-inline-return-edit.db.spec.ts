/**
 * #2094 PR-A2 (SA-194 / SA-221, Opus R2) — real-Postgres pins THROUGH OrdersService.updateOrderItems():
 * the edit path's own wiring, not just the in-tx core (inline-returns-in-order.db.spec.ts) or create
 * (orders-inline-return-create.db.spec.ts).
 *
 *   1. REFUSAL BEFORE THE REVERT (B215 class): an undelivered edit reverts a linked SENT invoice to
 *      DRAFT on its own connection BEFORE the edit tx. A return whose returnKey belongs to ANOTHER order
 *      is refused by the preflight, so the invoice is still SENT and the order is unchanged. (Before the
 *      fix the refusal was thrown later inside the tx: the edit rolled back but the invoice stayed
 *      DRAFT for good.)
 *   2. SUCCESS: order.update, the linked-invoice revert, the credit gate, capture + issue in the same
 *      tx (one Return, one credit note at the number reserved BEFORE the tx, the intent capped at the
 *      order balance), and the post-commit reconcile all run for one edit.
 *   3. REPLAY: the same edit again with the same returnKey issues nothing new.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI) with the real InlineReturnsService,
 * CreditNotesService, NumberingService; `invoicesService` is a fake whose `revertLinkedInvoicesForOrderEdit`
 * performs the REAL write (SENT -> DRAFT for the order's invoices) so the ordering is observable, and
 * whose resync/reconcile hooks record calls. NOT RUN on the MacBook that wrote it (no Postgres there):
 * F2's DB lane runs it and adjusts any fixture field the schema demands.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { ConflictException, Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { NumberingService } from "../import/numbering.service";
import { IdempotencyService } from "../common/idempotency.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { InlineReturnsQuoteService } from "../returns/inline-returns-quote.service";
import { InlineReturnsService } from "../returns/inline-returns.service";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "#2094 — a return inside an order EDIT through updateOrderItems(), real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    let reserved: string[] = [];
    const hooks = { resync: jest.fn(), reconcileDraft: jest.fn() };
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-2094-edit-${run}`, "orders-inline-return-edit.db.spec.ts");
    let tenantId = "";
    const customerIds: string[] = [];
    const productIds: string[] = [];
    const userIds: string[] = [];
    const orderIds: string[] = [];
    const invoiceIds: string[] = [];

    const staff = (): JwtPayload =>
      ({
        sub: userIds[0] ?? "op",
        username: "operator",
        role: "OPERATOR",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;

    /** A customer, a product, a PENDING order with one line, and a SENT invoice linked to it. */
    async function seed(tag: string) {
      const product = await raw.product.create({
        data: { name: `${tag} p ${run}`, unit: "each", pricePerUnit: "10.00", tenantId },
      });
      productIds.push(product.id);
      const u = await raw.user.create({
        data: {
          email: `${tag}-c-${run}@example.test`,
          username: `${tag}-c-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      userIds.push(u.id);
      const c = await raw.customer.create({
        data: { userId: u.id, businessName: `${tag} co`, contactName: "2094 Tester", tenantId },
      });
      customerIds.push(c.id);
      const order = await raw.order.create({
        data: {
          customerId: c.id,
          tenantId,
          status: "PENDING",
          subtotal: "10.00",
          total: "10.00",
          lineItems: {
            create: [
              { productId: product.id, qty: 1, unitPrice: "10.00", subtotal: "10.00", tenantId },
            ],
          },
        },
      });
      orderIds.push(order.id);
      const invoice = await raw.invoice.create({
        data: {
          invoiceNumber: `INV-2094E-${tag}-${run}`,
          customerId: c.id,
          orderId: order.id,
          tenantId,
          status: "SENT",
          subtotal: "10.00",
          total: "10.00",
        },
      });
      invoiceIds.push(invoice.id);
      return { productId: product.id, customerId: c.id, orderId: order.id, invoiceId: invoice.id };
    }

    const edit = (f: { orderId: string; productId: string }, ret: any) =>
      tenantCtx.run(tenantId, () =>
        orders.updateOrderItems(
          f.orderId,
          { items: [{ productId: f.productId, qty: 1 }], inlineReturn: ret },
          staff(),
        ),
      );
    const ret = (productId: string, qty: number, returnKey: string) => ({
      items: [{ productId, qty }],
      returnKey,
    });

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const idempotency = new IdempotencyService();
      const numbering = new NumberingService(prisma);
      const ledger = new RegulatedLedgerService(prisma);
      const systemConfig = new SystemConfigService(
        prisma,
        new EncryptionService({ get: () => undefined } as any),
      );
      const creditNotes = Object.assign(Object.create(CreditNotesService.prototype), {
        prisma,
        gateway: { emitCreditNoteCreated: jest.fn() },
        ledger,
        commissionEngine: {
          syncInvoiceCommissionSafe: async () => undefined,
          syncOrderInvoices: async () => undefined,
          removeInvoiceCommission: async () => undefined,
        },
        numbering,
        logger: new Logger(CreditNotesService.name),
      });
      const inlineSvc: any = Object.assign(Object.create(InlineReturnsService.prototype), {
        prisma,
        gateway: { emitCreditNoteCreated: jest.fn() },
        ledger,
        creditNotes,
        numbering,
        addonService: { hasAddon: async () => true },
        quoteService: new InlineReturnsQuoteService(prisma, systemConfig),
        idempotency,
      });
      const realReserve = inlineSvc.reserveCreditNoteNumber.bind(inlineSvc);
      inlineSvc.reserveCreditNoteNumber = async () => {
        const n = await realReserve();
        reserved.push(n);
        return n;
      };
      const invoicesService = {
        // The REAL write: an undelivered edit flips the order's SENT invoices to DRAFT before the edit tx.
        revertLinkedInvoicesForOrderEdit: async (orderId: string) => {
          await raw.invoice.updateMany({
            where: { orderId, status: "SENT" },
            data: { status: "DRAFT" },
          });
        },
        resyncOrderInvoicesForEdit: hooks.resync,
        ...INVOICE_EDIT_STUBS,
        reconcileOrderDraftInvoice: hooks.reconcileDraft,
      };
      orders = Object.assign(Object.create(OrdersService.prototype), {
        prisma,
        gateway: { emitOrderStatusChanged: jest.fn(), emitOrderCreated: jest.fn() },
        systemConfig,
        entitlements: { hasFlag: async () => true },
        sellingRestrictions: {
          assertLinesSellable: async () => undefined,
          // the edit path reads the policy first; OFF = no restriction planning (planOrderEditRestrictions)
          getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
        },
        authGuard: { assertAuthorizedOrThrow: async () => undefined },
        promotionsService: { activeForCatalog: async () => [] },
        creditNotes,
        ledger,
        tenantCtx,
        invoicesService,
        logger: new Logger(OrdersService.name),
        inlineReturns: inlineSvc,
      });
      tenantId = (await raw.tenant.create({ data: { slug, name: `2094 Edit ${slug}` } })).id;
      const op = await raw.user.create({
        data: {
          email: `op-${run}@example.test`,
          username: `op-${run}`,
          role: "OPERATOR",
          tenantId,
        },
      });
      userIds.unshift(op.id);
    }, 120_000);

    beforeEach(() => {
      reserved = [];
      hooks.resync.mockReset().mockResolvedValue([]);
      hooks.reconcileDraft.mockReset().mockResolvedValue(undefined);
    });

    afterAll(async () => {
      await raw.orderCreditNote.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.returnItem.deleteMany({ where: { return: { orderId: { in: orderIds } } } });
      await raw.return.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.creditNote.deleteMany({ where: { tenantId } });
      // applying an inline-return credit note to the linked invoice writes InvoicePayment rows
      await raw.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await raw.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
      await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.customer.deleteMany({ where: { id: { in: customerIds } } });
      await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
      await raw.product.deleteMany({ where: { id: { in: productIds } } });
      await raw.user.deleteMany({ where: { id: { in: userIds } } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    it("a return refused by the preflight (its returnKey belongs to ANOTHER order) leaves the linked invoice SENT and the order unchanged", async () => {
      const a = await seed("refuse-a");
      const b = await seed("refuse-b");
      const key = `k-refuse-${run}`;
      await edit(a, ret(a.productId, 3, key)); // the key now lives on order A
      // Put B's invoice back to SENT (A's edit reverted only A's), then edit B with A's key.
      const before = await raw.order.findUniqueOrThrow({ where: { id: b.orderId } });
      await expect(edit(b, ret(b.productId, 3, key))).rejects.toBeInstanceOf(ConflictException);
      const inv = await raw.invoice.findUniqueOrThrow({ where: { id: b.invoiceId } });
      expect(inv.status).toBe("SENT"); // the revert never ran: nothing to strand
      const after = await raw.order.findUniqueOrThrow({ where: { id: b.orderId } });
      expect(Number(after.total)).toBe(Number(before.total));
      expect(await raw.return.count({ where: { orderId: b.orderId } })).toBe(0);
    }, 60_000);

    it("success: one edit runs order.update, the revert, the credit gate, capture + issue in ONE tx (CN at the number reserved before the tx) and the reconcile", async () => {
      const f = await seed("ok");
      await edit(f, ret(f.productId, 3, `k-ok-${run}`)); // return $30
      expect(reserved).toHaveLength(1);
      const order = await raw.order.findUniqueOrThrow({ where: { id: f.orderId } });
      expect(Number(order.total)).toBeGreaterThan(10); // the edit landed (a second unit)
      expect((await raw.invoice.findUniqueOrThrow({ where: { id: f.invoiceId } })).status).toBe(
        "DRAFT",
      ); // the revert ran
      const rets = await raw.return.findMany({ where: { orderId: f.orderId } });
      expect(rets).toHaveLength(1);
      expect(rets[0].status).toBe("REFUNDED");
      const cns = await raw.creditNote.findMany({ where: { customerId: f.customerId } });
      expect(cns).toHaveLength(1);
      expect(cns[0].creditNoteNumber).toBe(reserved[0]);
      const intents = await raw.orderCreditNote.findMany({ where: { orderId: f.orderId } });
      expect(intents.reduce((s, i) => s + Number(i.amount), 0)).toBeLessThanOrEqual(
        Number(order.total) + 0.005,
      );
      expect(
        hooks.reconcileDraft.mock.calls.length + hooks.resync.mock.calls.length,
      ).toBeGreaterThan(0);
    }, 60_000);

    it("SA-340: a write conflict thrown INSIDE the edit tx after the return was applied (attempt 1 only) retries the WHOLE tx: no side effect runs twice", async () => {
      // A control edit with no fault fixes what "once" means for this fixture (stock moved, audit rows).
      const ctl = await seed("ctl");
      await edit(ctl, ret(ctl.productId, 3, `k-ctl-${run}`));
      const measure = async (f: { orderId: string; productId: string; customerId: string }) => {
        const returns = await raw.return.findMany({ where: { orderId: f.orderId } });
        const audits = await raw.auditLog.count({
          where: { entityId: { in: [f.orderId, ...returns.map((r: any) => r.id)] } },
        });
        return {
          returns: returns.length,
          cns: await raw.creditNote.count({ where: { customerId: f.customerId } }),
          stockMovements: await raw.stockMovement.count({ where: { productId: f.productId } }),
          stock: Number(
            (await raw.product.findUniqueOrThrow({ where: { id: f.productId } })).currentStock,
          ),
          audits,
        };
      };
      const control = await measure(ctl);
      expect(control.returns).toBe(1);

      const f = await seed("conflict");
      reserved = [];
      const svc = orders.inlineReturns;
      const realApply = svc.captureAndIssueInTx.bind(svc);
      let attempts = 0;
      svc.captureAndIssueInTx = async (...args: any[]) => {
        const out = await realApply(...args); // the return, its credit note and its restock ARE written...
        attempts += 1;
        if (attempts === 1) {
          // ...and THEN the tx aborts, the way Prisma 7 wraps a pg deadlock at READ COMMITTED.
          throw Object.assign(new Error("deadlock detected"), {
            code: "P2034",
            meta: {
              driverAdapterError: {
                name: "DriverAdapterError",
                cause: { kind: "TransactionWriteConflict", originalCode: "40P01" },
              },
            },
          });
        }
        return out;
      };
      try {
        await edit(f, ret(f.productId, 3, `k-conflict-${run}`));
      } finally {
        svc.captureAndIssueInTx = realApply;
      }
      expect(attempts).toBe(2); // attempt 1 rolled back, attempt 2 committed
      expect(reserved).toHaveLength(1); // the number was reserved ONCE, ahead of the tx
      const cns = await raw.creditNote.findMany({ where: { customerId: f.customerId } });
      expect(cns).toHaveLength(1);
      expect(cns[0].creditNoteNumber).toBe(reserved[0]);
      // exactly the side effects one clean edit has: one Return, one CN, stock moved once, same audit rows
      expect(await measure(f)).toEqual(control);
    }, 60_000);

    it("replay: the same edit with the same returnKey issues nothing new (one Return, one credit note)", async () => {
      const f = await seed("replay");
      const r = ret(f.productId, 3, `k-replay-${run}`);
      await edit(f, r);
      await edit(f, r);
      expect(await raw.return.count({ where: { orderId: f.orderId } })).toBe(1);
      expect(await raw.creditNote.count({ where: { customerId: f.customerId } })).toBe(1);
    }, 60_000);
  },
);
