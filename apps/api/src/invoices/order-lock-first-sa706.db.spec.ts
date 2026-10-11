/**
 * SA-706 MUST 1 (B1052 review), real Postgres: an invoice creation takes the ORDER row lock before
 * its invoice INSERT, so two creations for one order serialize instead of deadlocking.
 *
 * The invoice's `orderId` FK takes KEY SHARE on the Order; the settle step's first statement then
 * upgrades it to FOR UPDATE. T2 (a raw pg connection) holds the OrderItem row FOR UPDATE, so the first creation blocks at the
 * invoicedQty bump with its invoice inserted. Pre-fix the second creation ALSO inserts its invoice (both
 * hold KEY SHARE on the Order) and blocks on T2; when T2 commits each settle waits on the other's KEY
 * SHARE: 40P01. Fixed, the second is blocked BY THE FIRST on the Order row before it inserts anything.
 * The spec waits for exactly that chain (pg_blocking_pids: "A blocked by T2, B blocked by A") and asserts
 * it; it never relies on a silent poll timeout (a bounded wait longer than the 5 s transaction timeout
 * would fail both creations for the wrong reason).
 *
 * Case 2 races createPartialFromOrder against createInvoiceFromOrder (createSplitInvoices — the
 * invoice leg of Mark Delivered's flow).
 *
 * Runs only under `npm run local:test:db` (Mac mini lane). Throwaway `qa-sa706-<run>-<n>` tenants.
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
import { lockOrderCreditSettle } from "../credit-notes/credit-note-locks";
import { ConflictException, HttpException, ServiceUnavailableException } from "@nestjs/common";

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-sa706-${RUN_SUFFIX}-${tenantSeq}`,
    "partial-invoice-cas-SA706.db.spec.ts",
  );
}

describeDb("invoice creation locks the Order row before its INSERT (SA-706)", () => {
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
  // settleOrderCreditsInTx's FIRST statements are lockOrderCreditSettle (Order FOR UPDATE, then the
  // order's invoices and notes); the double issues exactly that, so the KEY SHARE -> FOR UPDATE
  // upgrade of production is what races here.
  const mockCreditNotes = {
    autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
    settleOrderCreditsInTx: jest.fn(async (tx: any, orderId: string, tenantId?: string | null) => {
      await lockOrderCreditSettle(tx, tenantId ?? null, orderId);
      return { applied: 0, unapplied: 0 };
    }),
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
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            syncInvoiceEntries: jest.fn(),
          },
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
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA706 ${slug}` } });
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
        businessName: "SA706",
        contactName: "SA706",
        tenantId: tenant.id,
      } as any,
    });
    const product = await prisma.product.create({
      data: { name: `SA706 ${slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id } as any,
    });
    const order = await prisma.order.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        orderNumber: `ORD-SA706-${slug}`,
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

  /**
   * SA-706 Order-first serialization: like `holdLine`, but the two creations do NOT both reach the bump. The
   * first takes the Order row, creates its invoice and blocks on T2 (the OrderItem bump); the second is
   * blocked BY THE FIRST on the Order row. Waits for exactly that chain (bounded 3 s, inside the 5 s tx
   * timeout, never a silent poll timeout) and reports it: `chain` = pairs (A blocked by T2, B blocked by A),
   * `waiting` = backends blocked by T2 (1 when the lock-first order holds; 2 and chain 0 without it).
   */
  async function holdLineChain(orderItemId: string, starts: Array<() => Promise<unknown>>) {
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
      let chain = 0;
      for (let i = 0; i < 120 && chain < 1; i++) {
        const q = await t2.query(
          `SELECT pg_stat_clear_snapshot(), (SELECT count(*)::int FROM pg_stat_activity b
             JOIN pg_stat_activity a ON a.pid = ANY(pg_blocking_pids(b.pid))
             WHERE $1 = ANY(pg_blocking_pids(a.pid))) AS n`,
          [pid],
        );
        chain = q.rows[0].n;
        if (chain < 1) await new Promise((x) => setTimeout(x, 25));
      }
      const waiting = (
        await t2.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
          [pid],
        )
      ).rows[0].n;
      await t2.query("COMMIT");
      return { waiting, chain, results: await Promise.all(results) };
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
  const split = (s: { tenantId: string; orderId: string }) => () =>
    tenantCtx.run(s.tenantId, () => invoicesService.createInvoiceFromOrder(s.orderId));

  /** A deadlock victim (40P01) reaches the caller as a bare Postgres/Prisma error, never an HttpException. */
  const isDeadlock = (e: unknown) =>
    !(e instanceof HttpException) && /40P01|deadlock detected/i.test(String((e as Error)?.message));

  it("two partials for one line: no 40P01 — one 201, the loser gets the coded 409", async () => {
    const s = await seedLine();
    const { waiting, chain, results } = await holdLineChain(s.orderItemId, [
      partial(s),
      partial(s),
    ]);
    expect(chain).toBe(1); // A on T2, B behind A on the Order row (pre-fix: 0)
    expect(waiting).toBe(1);

    const failed = results.filter((r) => !r.ok) as Array<{ ok: false; e: unknown }>;
    expect(failed.filter((r) => isDeadlock(r.e))).toEqual([]); // pre-fix: one deadlock victim
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].e).toBeInstanceOf(ConflictException);
    expect(await prisma.invoice.count({ where: { orderId: s.orderId } })).toBe(1);
  });

  it("a partial racing the order's full create (Mark Delivered's invoice leg): no 40P01, the loser is coded", async () => {
    const s = await seedLine();
    const { waiting, chain, results } = await holdLineChain(s.orderItemId, [partial(s), split(s)]);
    expect(chain).toBe(1);
    expect(waiting).toBe(1);

    const failed = results.filter((r) => !r.ok) as Array<{ ok: false; e: unknown }>;
    expect(failed.filter((r) => isDeadlock(r.e))).toEqual([]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(failed).toHaveLength(1);
    // the existing refusals: a spent line is a 409 (partial) / a retryable 409-or-503 (split)
    expect(
      failed[0].e instanceof ConflictException ||
        failed[0].e instanceof ServiceUnavailableException,
    ).toBe(true);
    expect(await prisma.invoice.count({ where: { orderId: s.orderId } })).toBeGreaterThanOrEqual(1);
  });
});
