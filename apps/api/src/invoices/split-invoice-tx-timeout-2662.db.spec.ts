/**
 * #2662, real Postgres: the office path (`createInvoiceFromOrder` → `createSplitInvoices`) runs in an
 * interactive transaction with Prisma's default 5 s timeout. T2 (a raw pg connection) holds the order
 * line FOR UPDATE, so the creation — having created its invoice inside its tx — blocks on the
 * invoicedQty bump. ENTRY (asserted structurally, never timed): the creation's session is blocked on T2
 * and holds the tuple lock on an "OrderItem" row (pg_locks, as #2666). T2 then holds the line past the
 * timeout ON PURPOSE (the condition under test) and commits.
 *   - fixed: the creation is a ServiceUnavailableException (503, "nothing was saved … retry");
 *   - pre-fix (MASTER itself, pre-existing — not introduced by #2624): the timed-out in-tx create comes
 *     back null and the loop throws `TypeError: Cannot read properties of null (reading 'items')`, a
 *     raw 500 (F2's pre-push run, #2554 5865725759). #2624's `restrictedLines` line would hit the same
 *     null one line earlier; the guard sits above both;
 *   - either way Prisma rolled the transaction back: the order has NO invoice, invoicedQty stays 0.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Throwaway `qa-2662-<run>-<n>` tenants
 * approved by `assertTestTenant`; `afterAll` deletes what they hold. DB lane (F2).
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
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { AfterCommit } from "../common/after-commit";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

import { Client } from "pg";
import { ServiceUnavailableException } from "@nestjs/common";

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-2662-${RUN_SUFFIX}-${tenantSeq}`,
    "split-invoice-tx-timeout-2662.db.spec.ts",
  );
}

describeDb("split-invoice creation that outlives the tx timeout is a clean 503 (#2662)", () => {
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
        entitlementAuthorityFromEntitlements, // #2241: EntitlementAuthority
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
    const tenant = await prisma.tenant.create({ data: { slug, name: `2662 ${slug}` } });
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
        businessName: "2662",
        contactName: "2662",
        tenantId: tenant.id,
      } as any,
    });
    const product = await prisma.product.create({
      data: { name: `2662 ${slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id } as any,
    });
    const order = await prisma.order.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        orderNumber: `ORD-2662-${slug}`,
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

  /** The creation's blocked session(s) on T2, read structurally (pg_locks), from a separate
   *  autocommit connection (a fresh stats snapshot per statement). */
  async function waiters(probe: Client, t2pid: number) {
    const q = await probe.query(
      `SELECT a.pid, a.query,
           EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted) AS waiting,
           EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND l.locktype = 'tuple'
                     AND l.relation = '"OrderItem"'::regclass) AS "onOrderItem",
           (SELECT json_agg(json_build_object('locktype', l.locktype,
                     'relation', l.relation::regclass::text, 'mode', l.mode, 'granted', l.granted))
              FROM pg_locks l WHERE l.pid = a.pid) AS locks
         FROM pg_stat_activity a WHERE $1 = ANY(pg_blocking_pids(a.pid))`,
      [t2pid],
    );
    return q.rows as Array<{
      waiting: boolean;
      onOrderItem: boolean;
      query: string;
      locks: unknown;
    }>;
  }

  it("a creation held past Prisma's 5 s tx timeout is a 503 (nothing saved), never a raw 500", async () => {
    const s = await seedLine();
    const t2 = new Client({ connectionString: process.env.DATABASE_URL });
    const probe = new Client({ connectionString: process.env.DATABASE_URL });
    await t2.connect();
    await probe.connect();
    let outcome: { ok: true } | { ok: false; e: unknown } | undefined;
    try {
      await t2.query("BEGIN");
      await t2.query(`SELECT id FROM "OrderItem" WHERE id = $1 FOR UPDATE`, [s.orderItemId]);
      const t2pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      let settled = false;
      const creation = tenantCtx
        .run(s.tenantId, () => invoicesService.createInvoiceFromOrder(s.orderId))
        .then(
          () => ({ ok: true as const }),
          (e: unknown) => ({ ok: false as const, e }),
        )
        .finally(() => (settled = true));

      // ENTRY: blocked on T2's order line (condition-based; a miss throws the dump).
      let seen: Awaited<ReturnType<typeof waiters>> = [];
      const deadline = Date.now() + 20_000;
      while (!seen.some((w) => w.waiting && w.onOrderItem) && !settled && Date.now() < deadline) {
        seen = await waiters(probe, t2pid);
        if (!seen.some((w) => w.waiting && w.onOrderItem))
          await new Promise((x) => setTimeout(x, 25));
      }
      if (!seen.some((w) => w.waiting && w.onOrderItem) || settled) {
        throw new Error(
          `#2662 entry not reached (settledFirst=${settled}): ${JSON.stringify(seen, null, 2)}`,
        );
      }

      // The condition under test: hold the line past the interactive-tx timeout (5 s default).
      await new Promise((x) => setTimeout(x, 6_500));
      await t2.query("COMMIT");
      outcome = await creation;
    } finally {
      await t2.end().catch(() => undefined);
      await probe.end().catch(() => undefined);
    }

    expect(outcome && !outcome.ok ? (outcome as { e: unknown }).e : outcome).toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(await prisma.invoice.count({ where: { orderId: s.orderId } })).toBe(0);
    const line = await prisma.orderItem.findUniqueOrThrow({ where: { id: s.orderItemId } });
    expect(Number(line.invoicedQty)).toBe(0);
  }, 30_000);
});
