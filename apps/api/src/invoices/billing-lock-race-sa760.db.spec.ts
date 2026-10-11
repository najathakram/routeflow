/**
 * SA-760 R-1 (B1096, Gap B, GH#2684), real Postgres: the order<->invoice billing-state writers take the
 * Order row (then the order's invoices) BEFORE they read what they decide on.
 *
 * Deterministic: a raw pg connection (T2) plays the concurrent writer and holds the Order row FOR UPDATE
 * the way createPartialFromOrder / a second Mark Delivered does. The writer under test is started while T2
 * holds it and must WAIT (pg_blocking_pids names T2); only after T2 commits does it re-read and decide.
 *   - B1096: two reconciles of one sole mirror draft never double the lines (single lines, one total).
 *   - Gap B: T2 commits a second (partial) draft while the reconcile waits -> the reconcile sees it on the
 *     re-read and returns the partials result: the mirror is NOT rebuilt to the full order.
 * Pre-fix the reconcile ran on the unlocked client: it did not wait on T2 at all (waiting = 0), and in the
 * Gap B row it rewrote the draft to the full order over the partial that committed meanwhile.
 *
 * Runs only under `npm run local:test:db`. Throwaway `qa-sa760-<run>-<n>` tenants.
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
import { Client } from "pg";
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-sa760-${RUN_SUFFIX}-${tenantSeq}`,
    "billing-lock-race-sa760.db.spec.ts",
  );
}

describeDb("billing-state writers lock the Order row first (SA-760 R-1)", () => {
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
  const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
  const mockCommissionEngine = {
    syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
    syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
    removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
  };

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
        entitlementAuthorityFromEntitlements,
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

  /** A CONFIRMED order with one 96-piece line and its pending-mirror DRAFT (the sole billing invoice). */
  async function seedMirror() {
    const slug = freshTenantSlug();
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA760 ${slug}` } });
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
        businessName: "SA760",
        contactName: "SA760",
        tenantId: tenant.id,
      } as any,
    });
    const product = await prisma.product.create({
      data: { name: `SA760 ${slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id } as any,
    });
    const order = await prisma.order.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        orderNumber: `ORD-SA760-${slug}`,
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
    const draft = await prisma.invoice.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        orderId: order.id,
        invoiceNumber: `INV-SA760-${slug}`,
        status: "DRAFT",
        subtotal: 960,
        total: 960,
        items: {
          create: [
            {
              tenantId: tenant.id,
              orderItemId: item.id,
              productId: product.id,
              description: "line",
              qty: 96,
              unitPrice: 10,
              subtotal: 960,
            },
          ],
        },
      } as any,
    });
    await prisma.orderItem.update({ where: { id: item.id }, data: { invoicedQty: 96 } });
    return {
      tenantId: tenant.id,
      customerId: customer.id,
      orderId: order.id,
      orderItemId: item.id,
      productId: product.id,
      draftId: draft.id,
    };
  }

  type Seed = Awaited<ReturnType<typeof seedMirror>>;

  /** Run `writer` while T2 holds the Order row; report how many backends T2 blocked, then commit `t2Work`. */
  async function whileOrderHeld<T>(
    s: Seed,
    writer: () => Promise<T>,
    t2Work?: (t2: Client) => Promise<void>,
  ) {
    const t2 = new Client({ connectionString: process.env.DATABASE_URL });
    await t2.connect();
    try {
      await t2.query("BEGIN");
      await t2.query(`SELECT id FROM "Order" WHERE id = $1 FOR UPDATE`, [s.orderId]);
      const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const result = writer().then(
        (v) => ({ ok: true as const, v }),
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
      if (t2Work) await t2Work(t2);
      await t2.query("COMMIT");
      return { waiting, outcome: await result };
    } finally {
      await t2.end().catch(() => undefined);
    }
  }

  const reconcile = (s: Seed) => () =>
    tenantCtx.run(s.tenantId, () =>
      invoicesService.reconcileOrderDraftInvoice(s.orderId, { basis: "order" }),
    );

  it("B1096: a reconcile started while another writer holds the Order waits, then writes single lines", async () => {
    const s = await seedMirror();
    const { waiting, outcome } = await whileOrderHeld(s, reconcile(s));
    expect(waiting).toBe(1); // pre-fix: 0 (the unlocked client never waited)
    expect(outcome.ok).toBe(true);
    const items = await prisma.invoiceItem.findMany({ where: { invoiceId: s.draftId } });
    expect(items).toHaveLength(1); // single lines, never doubled
    expect(Number(items[0].qty)).toBe(96);
  });

  it("B1096: two concurrent reconciles of one sole mirror draft leave single lines and one total", async () => {
    const s = await seedMirror();
    const { waiting, outcome } = await whileOrderHeld(s, () =>
      Promise.all([reconcile(s)(), reconcile(s)()]),
    );
    expect(waiting).toBeGreaterThanOrEqual(1);
    expect(outcome.ok).toBe(true);
    const items = await prisma.invoiceItem.findMany({ where: { invoiceId: s.draftId } });
    expect(items).toHaveLength(1);
    const inv = await prisma.invoice.findUnique({ where: { id: s.draftId } });
    expect(Number(inv!.total)).toBe(960);
  });

  it("Gap B: a partial committed while the reconcile waited is seen on the re-read; the mirror is not overwritten", async () => {
    const s = await seedMirror();
    const idsBefore = (await prisma.invoiceItem.findMany({ where: { invoiceId: s.draftId } })).map(
      (i) => i.id,
    );
    const { waiting, outcome } = await whileOrderHeld(s, reconcile(s), async (t2) => {
      // what createPartialFromOrder does under the Order row it holds: a second order-linked draft.
      const partialId = randomUUID();
      await t2.query(
        `INSERT INTO "Invoice" (id, "tenantId", "customerId", "orderId", "invoiceNumber", status, subtotal, total, "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 'DRAFT', 100, 100, now())`,
        [partialId, s.tenantId, s.customerId, s.orderId, `INV-SA760P-${partialId.slice(0, 8)}`],
      );
      await t2.query(
        `INSERT INTO "InvoiceItem" (id, "tenantId", "invoiceId", "orderItemId", "productId", description, qty, "unitPrice", subtotal, "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 'partial', 10, 10, 100, now())`,
        [randomUUID(), s.tenantId, partialId, s.orderItemId, s.productId],
      );
    });
    // the harm first (pre-fix: the unlocked rebuild ran past the check and rewrote the mirror to the full
    // order although a partial now bills part of it = a double bill), then the wait that prevents it
    expect(outcome.ok && outcome.v).toBe("partials"); // RECONCILE_PARTIALS: nothing rebuilt
    const mirrorItems = await prisma.invoiceItem.findMany({ where: { invoiceId: s.draftId } });
    expect(mirrorItems.map((i) => i.id).sort()).toEqual([...idsBefore].sort()); // the very same rows: untouched
    expect(waiting).toBe(1);
  });
});
