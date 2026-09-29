/**
 * #2612 (the sibling of #2070 / SA-523), real Postgres: the full-order / split path
 * (`createInvoiceFromOrder` → `createSplitInvoices`) racing for the same order line.
 *
 * T2 (a raw pg connection) holds the OrderItem row FOR UPDATE. Two creations both read
 * `remaining = 96` before their transaction, create their invoice(s) inside it, and then block on the
 * invoicedQty bump: two waiters via `pg_blocking_pids` (stats snapshot cleared per poll). T2
 * commits; the bumps then run one after the other:
 *   - fixed code (a CAS on the read invoicedQty/qty/status): one creation succeeds, the other is a
 *     409; invoicedQty = 96; the order has ONE invoice;
 *   - pre-fix code (an unconditional increment): both succeed; invoicedQty = 192; two invoices.
 * Second case: a full-order creation racing a PARTIAL for the same 96 pieces (#2070's path):
 * exactly one of them bills the line.
 * No spy and no symbol from partial-invoice-cas.ts.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js collects `*.db.spec.ts`; RUN_DB_SPECS
 * set, DATABASE_URL pointed at the compose/dbspec Postgres). Tenants are throwaway
 * `qa-2612-<run>-<n>` slugs approved by `assertTestTenant`; `afterAll` deletes what they hold.
 */

// Prevent Jest from traversing ESM-only dependencies (same guard as invoices.service.spec.ts /
// invoice-numbering.db.spec.ts).
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
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
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { AfterCommit } from "../common/after-commit";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

import { Client } from "pg";
import { ConflictException } from "@nestjs/common";

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-2612-${RUN_SUFFIX}-${tenantSeq}`,
    "split-invoice-cas-2612.db.spec.ts",
  );
}

describeDb(
  "split/full invoices: concurrent creations never over-bill a line (#2612, SA-523)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let invoicesService: InvoicesService;
    const createdTenantIds: string[] = [];

    const mockGateway = {
      emitInvoiceUpdated: jest.fn(),
      emitOrderCreated: jest.fn(),
      emitOrderStatusChanged: jest.fn(),
      emitLowStock: jest.fn(),
      emitStopCompleted: jest.fn(),
      emitUrgentOrder: jest.fn(),
    };
    const mockEmailService = {
      sendInvoice: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }),
      isEmailConfigured: jest.fn().mockResolvedValue(true),
    };
    const mockSystemConfig = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const mockCreditNotes = {
      autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
      settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
      releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
    };
    const mockMessaging = {
      notify: jest.fn().mockResolvedValue([]),
      notifyEvent: jest.fn().mockResolvedValue(undefined),
    };
    const mockStorage = {
      upload: jest.fn().mockResolvedValue("stored"),
      presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    // flag.msrp OFF: applyMsrpSnapshots no-ops.
    const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
    const mockCommissionEngine = {
      syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
      syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
      removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
    };

    beforeAll(async () => {
      // Nothing env-dependent may run at collection time (db-lane rule): the real connection is
      // built here, inside a hook, never at module top level.
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
          { provide: RouteFlowGateway, useValue: mockGateway },
          { provide: EmailService, useValue: mockEmailService },
          { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
          { provide: SystemConfigService, useValue: mockSystemConfig },
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
          { provide: CreditNotesService, useValue: mockCreditNotes },
          { provide: MessagingService, useValue: mockMessaging },
          { provide: StorageService, useValue: mockStorage },
          { provide: EntitlementsService, useValue: mockEntitlements },
          { provide: CommissionEngineService, useValue: mockCommissionEngine },
        ],
      }).compile();

      invoicesService = module.get(InvoicesService);
    });

    afterAll(async () => {
      for (const tenantId of createdTenantIds) {
        const where = { tenantId };
        // eslint-disable-next-line no-await-in-loop
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

    /** A CONFIRMED order with one 96-piece line, nothing invoiced yet. */
    async function seedLine() {
      const slug = freshTenantSlug();
      const tenant = await prisma.tenant.create({ data: { slug, name: `2612 ${slug}` } });
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
          businessName: "2612",
          contactName: "2612",
          tenantId: tenant.id,
        } as any,
      });
      const product = await prisma.product.create({
        data: { name: `2612 ${slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id } as any,
      });
      const order = await prisma.order.create({
        data: {
          tenantId: tenant.id,
          customerId: customer.id,
          orderNumber: `ORD-2612-${slug}`,
          status: "CONFIRMED",
          subtotal: 960,
          total: 960,
        } as any,
      });
      const item = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          qty: 96,
          unitPrice: 10,
          subtotal: 960,
          status: "CONFIRMED",
          tenantId: tenant.id,
        } as any,
      });
      return { tenantId: tenant.id, orderId: order.id, orderItemId: item.id };
    }

    /** T2 holds the OrderItem row; `starts` run and must block (`waiters` of them); `during(t2)`; T2 commits. */
    async function holdLine(
      orderItemId: string,
      starts: Array<() => Promise<unknown>>,
      during: (t2: Client) => Promise<void> = async () => undefined,
    ) {
      const t2 = new Client({ connectionString: process.env.DATABASE_URL });
      await t2.connect();
      try {
        await t2.query("BEGIN");
        await t2.query(`SELECT id FROM "OrderItem" WHERE id = $1 FOR UPDATE`, [orderItemId]);
        const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const results = starts.map((s) =>
          s().then(
            (v) => ({ ok: true as const, v }),
            (e) => ({ ok: false as const, e }),
          ),
        );
        let waiting = 0;
        for (let i = 0; i < 400 && waiting < starts.length; i++) {
          const q = await t2.query(
            `SELECT pg_stat_clear_snapshot(), (SELECT count(*)::int FROM pg_stat_activity
             WHERE $1 = ANY(pg_blocking_pids(pid))) AS n`,
            [pid],
          );
          waiting = q.rows[0].n;
          if (waiting < starts.length) await new Promise((x) => setTimeout(x, 25));
        }
        await during(t2);
        await t2.query("COMMIT");
        return { waiting, results: await Promise.all(results) };
      } finally {
        await t2.end().catch(() => undefined);
      }
    }

    const partial = (s: { tenantId: string; orderId: string; orderItemId: string }) => () =>
      tenantCtx.run(s.tenantId, () =>
        invoicesService.createPartialFromOrder(s.orderId, {
          items: [{ orderItemId: s.orderItemId, qty: 96 }],
        } as any),
      );

    const full = (s: { tenantId: string; orderId: string }) => () =>
      tenantCtx.run(s.tenantId, () => invoicesService.createInvoiceFromOrder(s.orderId));

    const expectOneWinner = async (
      s: { orderId: string; orderItemId: string },
      waiting: number,
      results: Array<{ ok: boolean; e?: any }>,
    ) => {
      expect(waiting).toBe(2); // both really reached the bump before either committed
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const refused = results.filter((r) => !r.ok);
      expect(refused).toHaveLength(1);
      expect(refused[0].e).toBeInstanceOf(ConflictException);
      const line = await prisma.orderItem.findUniqueOrThrow({ where: { id: s.orderItemId } });
      expect(Number(line.invoicedQty)).toBe(96); // pre-fix: 192
      expect(await prisma.invoice.count({ where: { orderId: s.orderId } })).toBe(1); // pre-fix: 2
    };

    it("two full-order creations for the same 96 pieces: one succeeds, one 409; invoicedQty 96; one invoice", async () => {
      const s = await seedLine();
      const { waiting, results } = await holdLine(s.orderItemId, [full(s), full(s)]);
      await expectOneWinner(s, waiting, results as any);
    });

    it("a full-order creation racing a partial for the same 96 pieces: exactly one bills the line", async () => {
      const s = await seedLine();
      const { waiting, results } = await holdLine(s.orderItemId, [full(s), partial(s)]);
      await expectOneWinner(s, waiting, results as any);
    });
  },
);
