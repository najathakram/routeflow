/**
 * B1043 / B1045 (SA-742r2 INV-A) - DB-lane proof of the header-only invoice PATCH (a discount or shippingFee
 * with no `items`) against a REAL Postgres, where a mocked client cannot show:
 *   1. a stored line whose tenant is NULL is refused (400), never silently dropped from the totals (B929);
 *   2. a discount PATCH racing a line edit is SERIALISED by the Order + Invoice row locks: the final
 *      total is consistent with the final lines (the old unlocked read wrote the total of the OLD lines
 *      over the new subtotal);
 *   3. the side effects: the linked order is recomputed once (its shipping follows) and the regulated
 *      sales ledger is left alone for unchanged lines.
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`. Every tenant is
 * a throwaway `qa-b1043-<run>-<n>-<label>` slug approved by `assertTestTenant`; `afterAll` deletes exactly
 * the tenants THIS run created, in FK order.
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
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b1043-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "invoice-header-only-b1043.db.spec.ts",
  );
}

describeDb("header-only invoice PATCH on the one builder - real Postgres (B1043/B1045)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoicesService: InvoicesService;
  const createdTenantIds: string[] = [];

  const mockCreditNotes = {
    autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
    settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
    releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
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
            sendInvoice: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }),
            isEmailConfigured: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
          },
        },
        RegulatedLedgerService,
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        { provide: CreditNotesService, useValue: mockCreditNotes },
        {
          provide: MessagingService,
          useValue: {
            notify: jest.fn().mockResolvedValue([]),
            notifyEvent: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn().mockResolvedValue("stored"),
            presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
            delete: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
        },
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

    invoicesService = module.get(InvoicesService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.regulatedSalesLedger.deleteMany({ where: { tenantId } });
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.invoiceItem.deleteMany({
      where: { OR: [{ tenantId }, { invoice: { tenantId } }] },
    });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { tenantId } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.trackedCategory.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seed(label: string, opts: { withOrder?: boolean } = {}) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `b1043 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const idBase = `${tenantId}-${label}`;
    const user = await prisma.user.create({
      data: { email: `${idBase}@example.invalid`, username: idBase, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `customer ${label}`, contactName: label, tenantId },
    });
    const product = await prisma.product.create({
      data: { tenantId, name: `widget ${label}`, unit: "each", pricePerUnit: 50 },
    });
    let orderId: string | null = null;
    let orderItemId: string | null = null;
    if (opts.withOrder) {
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderNumber: `ORD-B1043-${RUN_SUFFIX}-${label}`,
          status: "DELIVERED", // a pending mirror cannot be edited; a delivered order's invoice can
          subtotal: 100,
          total: 100,
        },
      });
      const oi = await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          qty: 2,
          unitPrice: 50,
          subtotal: 100,
          invoicedQty: 2,
        },
      });
      orderId = order.id;
      orderItemId = oi.id;
    }
    const inv = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderId,
        invoiceNumber: `INV-B1043-${RUN_SUFFIX}-${label}`,
        status: "DRAFT",
        subtotal: 100,
        taxAmount: 0,
        total: 100,
      },
    });
    const line = await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: inv.id,
        productId: product.id,
        orderItemId,
        description: "widget",
        qty: 2,
        unitPrice: 50,
        subtotal: 100,
      },
    });
    return { tenantId, customerId: customer.id, product, inv, line, orderId };
  }

  const run = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const reload = (id: string) => prisma.invoice.findUnique({ where: { id } });

  /** Two tenants' worth of rows: the invoice's own line (100) plus a $40 line stamped with another tenant (or NULL). */
  async function seedWithStrayLine(label: string, strayTenantId: string | null) {
    const s = await seed(label);
    await prisma.invoiceItem.create({
      data: {
        tenantId: strayTenantId,
        invoiceId: s.inv.id,
        description: "stray",
        qty: 1,
        unitPrice: 40,
        subtotal: 40,
      },
    });
    await prisma.invoice.update({ where: { id: s.inv.id }, data: { subtotal: 140, total: 140 } });
    return s;
  }
  const expectRefusedUntouched = async (s: { tenantId: string; inv: { id: string } }) => {
    await expect(
      run(s.tenantId, () => invoicesService.update(s.inv.id, { discount: 5 })),
    ).rejects.toMatchObject({ status: 400 });
    const after = await reload(s.inv.id);
    expect(Number(after!.discount)).toBe(0);
    expect(Number(after!.total)).toBe(140);
  };

  it("a stored line stamped with ANOTHER tenant is refused (400): never dropped from the totals; nothing is written", async () => {
    const other = await seed("other-tenant");
    await expectRefusedUntouched(await seedWithStrayLine("foreign-line", other.tenantId));
  });

  it("a stored line with a NULL tenant is refused (400) too (B929)", async () => {
    // T6 validated InvoiceItem_tenantId_nn on real data, so a NULL row can only exist where the
    // constraint is absent. Lift it in the THROWAWAY spec database only (never routeflow_dev), restore after.
    const [{ db }] = await prisma.$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`;
    // Never a silent pass: on any other database the case FAILS with the reason (a shared dev database must
    // not have its constraint lifted). `routeflow_test` is the CI service database, throwaway by construction.
    if (!/^(rf_dbspec_|routeflow_test$)/.test(db)) {
      throw new Error(
        `the NULL-tenant case needs a throwaway database (rf_dbspec_* or routeflow_test), not ${db}: run it via npm run local:test:db`,
      );
    }
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "InvoiceItem" DROP CONSTRAINT IF EXISTS "InvoiceItem_tenantId_nn"`,
    );
    try {
      await expectRefusedUntouched(await seedWithStrayLine("null-line", null));
    } finally {
      await prisma.invoiceItem.deleteMany({ where: { tenantId: null } });
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_tenantId_nn" CHECK ("tenantId" IS NOT NULL) NOT VALID`,
      );
    }
  });

  /** Polls pg_stat_activity until some other backend waits on a lock; throws after `timeoutMs`. */
  async function waitForLockWaiter(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
      if (n > 0) return;
      if (Date.now() > deadline) throw new Error("no backend ever waited on the invoice lock");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("B1045: a discount PATCH queued behind a line edit reads the NEW lines; the final total matches the final lines", async () => {
    const s = await seed("race");
    const patch = { discount: 5 };
    let patchDone: Promise<unknown> | null = null;
    // The "concurrent line edit": a tx that holds the invoice row lock, starts the PATCH while holding it,
    // adds a $50 line, brings the invoice header in step (subtotal 150, total 150) and commits.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${s.inv.id} FOR UPDATE`;
      patchDone = run(s.tenantId, () => invoicesService.update(s.inv.id, patch)).then(
        (v) => ({ ok: v }),
        (e) => ({ err: e }),
      );
      // Not a fixed sleep: wait until a backend is actually parked on a row lock (the PATCH's FOR UPDATE on
      // fixed code; its UPDATE, AFTER it read the old lines, on the unlocked code), bounded so a hang fails.
      await waitForLockWaiter();
      await tx.invoiceItem.create({
        data: {
          tenantId: s.tenantId,
          invoiceId: s.inv.id,
          description: "added",
          qty: 1,
          unitPrice: 50,
          subtotal: 50,
        },
      });
      await tx.invoice.update({ where: { id: s.inv.id }, data: { subtotal: 150, total: 150 } });
    });
    const outcome: any = await patchDone;
    expect(outcome.err).toBeUndefined();
    const after = await reload(s.inv.id);
    const lines = await prisma.invoiceItem.findMany({ where: { invoiceId: s.inv.id } });
    const sum = lines.reduce((t, l) => t + Number(l.subtotal), 0);
    expect(sum).toBe(150);
    expect(Number(after!.subtotal)).toBe(sum);
    expect(Number(after!.discount)).toBe(5);
    expect(Number(after!.total)).toBe(145);
  }, 30_000);

  it("a PATCH on an invoice whose header no longer matches its lines is 409 INVOICE_TAX_STATE_STALE and writes nothing", async () => {
    const s = await seed("stale");
    await prisma.invoice.update({ where: { id: s.inv.id }, data: { taxAmount: 4, total: 104 } });
    await expect(
      run(s.tenantId, () => invoicesService.update(s.inv.id, { discount: 1 })),
    ).rejects.toMatchObject({ status: 409, response: { code: "INVOICE_TAX_STATE_STALE" } });
    const after = await reload(s.inv.id);
    expect(Number(after!.discount)).toBe(0);
    expect(Number(after!.total)).toBe(104);
  });

  it("side effects: the linked order follows the new shipping once, and the regulated ledger is untouched", async () => {
    const s = await seed("side", { withOrder: true });
    const cat = await prisma.trackedCategory.create({
      data: { tenantId: s.tenantId, name: "cat side" },
    });
    const ledger = await prisma.regulatedSalesLedger.create({
      data: {
        tenantId: s.tenantId,
        trackedCategoryId: cat.id,
        invoiceId: s.inv.id,
        invoiceItemId: s.line.id,
        qty: 2,
        soldAt: new Date(),
        periodBucket: "2026-10",
      },
    });
    await run(s.tenantId, () => invoicesService.update(s.inv.id, { shippingFee: 7 }));
    const inv = await reload(s.inv.id);
    expect(Number(inv!.shippingFee)).toBe(7);
    expect(Number(inv!.total)).toBe(107);
    const order = await prisma.order.findUnique({ where: { id: s.orderId! } });
    expect(Number(order!.shippingFee)).toBe(7);
    const after = await prisma.regulatedSalesLedger.findMany({ where: { invoiceId: s.inv.id } });
    expect(after.map((r) => r.id)).toEqual([ledger.id]);
  });

  it("B296 pin (SA-814o, the class rule): a fresh draft with a >4-decimal rate refuses BOTH recomputes with 409 INVOICE_TAX_STATE_STALE and writes nothing", async () => {
    // create() taxes with the UNROUNDED rate (0.08875 -> 88.75 on $1,000) while InvoiceItem.taxRate is
    // Decimal(5,4) (0.0888 -> 88.80), so the stored lines cannot reproduce the stored tax. The one guard
    // (stored-tax-state.ts) refuses every recompute of such a row; the recovery is REG-B296 in R5-1, after
    // the sitting-4 widen. Asserts the code, the path and the stored values, never message text.
    const s = await seed("b296");
    const created: any = await run(s.tenantId, () =>
      invoicesService.create({
        customerId: s.customerId,
        items: [{ description: "Widget", qty: 10, unitPrice: 100, taxRate: 0.08875 }],
      } as any),
    );
    const stored = await reload(created.id);
    expect(Number(stored!.taxAmount)).toBe(88.75);
    const totalBefore = Number(stored!.total);
    const line = (await prisma.invoiceItem.findMany({ where: { invoiceId: created.id } }))[0];
    expect(Number(line.taxRate)).toBe(0.0888);
    const unchanged = async () => {
      const now = await reload(created.id);
      expect(Number(now!.taxAmount)).toBe(88.75);
      expect(Number(now!.discount)).toBe(0);
      expect(Number(now!.total)).toBe(totalBefore);
    };

    // A header-only PATCH: refused, nothing written.
    await expect(
      run(s.tenantId, () => invoicesService.update(created.id, { discount: 1 })),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "INVOICE_TAX_STATE_STALE", path: "DRAFT_MANUAL" },
    });
    await unchanged();

    // An items re-save with the rates unchanged (the stored rate back from the column): refused too.
    await expect(
      run(s.tenantId, () =>
        invoicesService.update(created.id, {
          items: [
            {
              id: line.id,
              description: "Widget",
              qty: 10,
              unitPrice: 100,
              taxRate: Number(line.taxRate),
            },
          ],
        } as any),
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "INVOICE_TAX_STATE_STALE", path: "DRAFT_MANUAL" },
    });
    await unchanged();
  });
});
