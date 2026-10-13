/**
 * SA-763r P-3 (M5, red row 9), real Postgres: a payment recorded concurrently with an order edit serializes
 * on the INVOICE lock. A raw pg connection (T2) plays `recordPayment`: it holds the invoice row FOR UPDATE and
 * has inserted a 100.00 cash payment, uncommitted. The edit's overpay judge (a cut from 100 to 70) is started
 * meanwhile; it takes the Order row, then asks for the order's invoices FOR UPDATE and must WAIT on T2
 * (pg_blocking_pids names it). Once T2 commits, the judge reads the payment under the lock and refuses with
 * 409 ORDER_EDIT_WOULD_OVERPAY; it never judges on a snapshot that predates the payment (pre-fix there was no
 * invoice lock: the judge, or the old unjudged edit, ran past the uncommitted payment and the edit committed
 * an overpaid invoice).
 *
 * Runs only under `npm run local:test:db`. Throwaway `qa-sa763-<run>-<n>` tenants.
 */

jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { Client } from "pg";
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
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { assertEditCannotOverpay } from "./edit-overpay-judge";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-sa763-${RUN_SUFFIX}-${tenantSeq}`,
    "edit-overpay-race-sa763.db.spec.ts",
  );
}

describeDb(
  "the overpay judge serializes with a concurrent payment on the invoice lock (SA-763r P-3)",
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
          { provide: EmailService, useValue: {} },
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
            useValue: { assertAuthorizedOrThrow: jest.fn(), checkAuthorized: jest.fn() },
          },
          { provide: CreditNotesService, useValue: {} },
          { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
          { provide: StorageService, useValue: {} },
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
          },
          entitlementAuthorityFromEntitlements,
          {
            provide: CommissionEngineService,
            useValue: { syncInvoiceCommissionSafe: jest.fn() },
          },
        ],
      }).compile();
      invoicesService = module.get(InvoicesService);
    });

    afterAll(async () => {
      for (const tenantId of createdTenantIds) {
        const where = { tenantId };
        // eslint-disable-next-line no-await-in-loop
        await (async () => {
          await prisma.invoicePayment.deleteMany({ where });
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

    /** A DELIVERED order, one 100-piece line at 1.00, and its SENT invoice (total 100), nothing paid. */
    async function seed() {
      const slug = freshTenantSlug();
      const tenant = await prisma.tenant.create({ data: { slug, name: `SA763 ${slug}` } });
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
          businessName: "SA763",
          contactName: "SA763",
          tenantId: tenant.id,
        } as any,
      });
      const product = await prisma.product.create({
        data: { name: `SA763 ${slug}`, unit: "ea", pricePerUnit: 1, tenantId: tenant.id } as any,
      });
      const order = await prisma.order.create({
        data: {
          tenantId: tenant.id,
          customerId: customer.id,
          orderNumber: `ORD-SA763-${slug}`,
          status: "DELIVERED",
          subtotal: 100,
          total: 100,
        } as any,
      });
      const item = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          qty: 100,
          invoicedQty: 100,
          unitPrice: 1,
          subtotal: 100,
          status: "CONFIRMED",
          tenantId: tenant.id,
        } as any,
      });
      const invoice = await prisma.invoice.create({
        data: {
          tenantId: tenant.id,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-SA763-${slug}`,
          status: "SENT",
          subtotal: 100,
          total: 100,
          items: {
            create: [
              {
                tenantId: tenant.id,
                orderItemId: item.id,
                productId: product.id,
                description: "line",
                qty: 100,
                unitPrice: 1,
                subtotal: 100,
              },
            ],
          },
        } as any,
      });
      return {
        tenantId: tenant.id,
        orderId: order.id,
        orderItemId: item.id,
        invoiceId: invoice.id,
      };
    }

    /** The edit tx: Order row, the cut written, then the judge (what updateOrderItems does at its tail). */
    const cutTo70 = (s: Awaited<ReturnType<typeof seed>>) => () =>
      tenantCtx.run(s.tenantId, () =>
        prisma.tenantTransaction(async (tx: any) => {
          await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${s.orderId} FOR UPDATE`;
          await tx.orderItem.update({
            where: { id: s.orderItemId },
            data: { qty: 70, subtotal: 70 },
          });
          await tx.order.update({ where: { id: s.orderId }, data: { subtotal: 70, total: 70 } });
          await assertEditCannotOverpay(
            { invoices: invoicesService, tenantId: s.tenantId },
            tx,
            s.orderId,
            { resync: true, partials: false },
          );
        }),
      );

    it("a payment inserted under the invoice lock is seen by the judge: the edit waits, then 409s and rolls back", async () => {
      const s = await seed();
      const t2 = new Client({ connectionString: process.env.DATABASE_URL });
      await t2.connect();
      try {
        await t2.query("BEGIN");
        // recordPayment: the invoice row FOR UPDATE, then the payment insert (uncommitted)
        await t2.query(`SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE`, [s.invoiceId]);
        await t2.query(
          `INSERT INTO "InvoicePayment" (id, "invoiceId", amount, method, status, "paidAt", "tenantId")
         VALUES ($1, $2, 100, 'CASH', 'PAID', now(), $3)`,
          [randomUUID(), s.invoiceId, s.tenantId],
        );
        const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;

        const edit = cutTo70(s)().then(
          () => ({ ok: true as const }),
          (e) => ({ ok: false as const, e }),
        );
        let waiting = 0;
        for (let i = 0; i < 80 && waiting < 1; i++) {
          const q = await t2.query(
            `SELECT pg_stat_clear_snapshot(),
                  (SELECT count(*)::int FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS n`,
            [pid],
          );
          waiting = q.rows[0].n;
          if (waiting < 1) await new Promise((x) => setTimeout(x, 25));
        }
        expect(waiting).toBe(1); // the judge is queued behind the payment, not past it
        await t2.query("COMMIT");

        const outcome = await edit;
        expect(outcome.ok).toBe(false);
        expect((outcome as any).e?.response).toMatchObject({
          code: "ORDER_EDIT_WOULD_OVERPAY",
          invoiceId: s.invoiceId,
          paid: 100,
          projectedTotal: 70,
          excess: 30,
        });
        // the whole edit rolled back: the line and the order are as they were
        const line = await prisma.orderItem.findUnique({ where: { id: s.orderItemId } });
        expect(Number(line!.qty)).toBe(100);
        const order = await prisma.order.findUnique({ where: { id: s.orderId } });
        expect(Number(order!.total)).toBe(100);
      } finally {
        await t2.query("ROLLBACK").catch(() => undefined);
        await t2.end().catch(() => undefined);
      }
    });

    it("with no payment the same cut passes (an unpaid invoice just owes less)", async () => {
      const s = await seed();
      await expect(cutTo70(s)()).resolves.toBeUndefined();
      const order = await prisma.order.findUnique({ where: { id: s.orderId } });
      expect(Number(order!.total)).toBe(70);
    });
  },
);
