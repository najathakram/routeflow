/**
 * B667 — RED repro (sweep, Lane R-ui). Editing one of an order's PARTIAL invoices must NOT
 * cancel the order lines that no invoice bills YET.
 *
 * The bug: `recomputeOrderFromInvoices` rebuilds an order's lines from the SUM of its non-void
 * invoices and sets every order line "billed by no invoice" to CANCELLED, qty 0, subtotal 0,
 * invoicedQty 0 (invoices.service.ts, the orphan loop just before the order total is rewritten),
 * then rewrites the order total to the billed sum. A partly-invoiced order legitimately has lines
 * with invoicedQty < qty that no invoice bills yet (`createPartialFromOrder`), so a discount /
 * shipping edit on the first DRAFT partial (`update()`) cancels the not-yet-invoiced line and
 * shrinks the order; it can then never be invoiced (remaining = qty - invoicedQty = 0, and it is
 * cancelled). Not flag-gated.
 *
 * Each test fails on the bug's own WRONG value: (a) line B CANCELLED at qty 0 / subtotal 0;
 * (b) the order subtotal collapsed to the billed 40 instead of 70. They are separate effects of
 * the same recompute, so a fix that only stops the line cancel leaves (b) red.
 *
 * WHY THE DB LANE: the orphan write, the partial-invoice bookkeeping (invoicedQty) and the order
 * total rewrite run through real Prisma + a real tenantTransaction. Collected only by
 * `jest.db.config.js`; run via `npm run local:test:db`. `requireLocalDatabaseUrl()` refuses any
 * non-local host. Every collaborator OTHER than Prisma is mocked at the module boundary exactly
 * as `invoice-delete-credit.db.spec.ts` does.
 *
 * SAFETY: throwaway `qa-b667-<run>-<n>-<label>` tenants, approved by `assertTestTenant`;
 * `afterAll` deletes exactly the tenants THIS run created, best-effort.
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
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
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
    `qa-b667-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "recompute-order-partial.db.spec.ts",
  );
}

describeDb("B667 order recompute vs a partly-invoiced order — real Postgres", () => {
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
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.invoiceItem.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { tenantId } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  /**
   * A DELIVERED order with two plain lines: A (4 x $10 = $40) and B (6 x $5 = $30), order
   * subtotal $70, no tax, no fee. DELIVERED so the DRAFT partial invoice is editable
   * (`assertOrderInvoiceUnlocked` refuses an order-linked DRAFT edit before delivery).
   */
  async function seedDeliveredOrder(label: string) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `B667 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const idBase = `${tenantId}-${label}`;
    const user = await prisma.user.create({
      data: { email: `${idBase}@example.invalid`, username: idBase, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `B667 customer ${label}`,
        contactName: `B667 contact ${label}`,
        tenantId,
      },
    });
    const productA = await prisma.product.create({
      data: { name: `B667 A ${label}`, unit: "each", pricePerUnit: 10, tenantId },
    });
    const productB = await prisma.product.create({
      data: { name: `B667 B ${label}`, unit: "each", pricePerUnit: 5, tenantId },
    });
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        status: "DELIVERED",
        orderNumber: `B667-${RUN_SUFFIX}-${label}`,
        subtotal: 70,
        tax: 0,
        total: 70,
        tenantId,
      },
    });
    const lineA = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: productA.id,
        qty: 4,
        unitPrice: 10,
        subtotal: 40,
        tenantId,
      },
    });
    const lineB = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: productB.id,
        qty: 6,
        unitPrice: 5,
        subtotal: 30,
        tenantId,
      },
    });
    return { tenantId, order, lineA, lineB };
  }

  /** Bill ONLY line A (a supported flow), then edit that DRAFT partial: the shipping change back-syncs the order. */
  async function editFirstPartial(label: string) {
    const s = await seedDeliveredOrder(label);
    const partial = await tenantCtx.run(s.tenantId, () =>
      invoicesService.createPartialFromOrder(s.order.id, {
        items: [{ orderItemId: s.lineA.id, qty: 4 }],
      } as never),
    );
    expect(partial).toMatchObject({ orderId: s.order.id, status: "DRAFT" });
    // Precondition: line B is untouched and still to be invoiced.
    const bBefore = await prisma.orderItem.findUnique({ where: { id: s.lineB.id } });
    expect({
      status: bBefore?.status,
      qty: Number(bBefore?.qty),
      inv: Number(bBefore?.invoicedQty),
    }).toEqual({ status: "PENDING", qty: 6, inv: 0 });
    await tenantCtx.run(s.tenantId, () =>
      invoicesService.update(partial.id, { shippingFee: 5 } as never),
    );
    const lineB = await prisma.orderItem.findUnique({ where: { id: s.lineB.id } });
    const order = await prisma.order.findUnique({ where: { id: s.order.id } });
    return { lineB, order };
  }

  // Wrong values on master: { status: "CANCELLED", qty: 0, subtotal: 0 } - the not-yet-invoiced
  // line is cancelled and zeroed, so it can never be invoiced (remaining = qty - invoicedQty = 0).
  it("REG-B667 (a): editing the first DRAFT partial leaves the not-yet-invoiced line PENDING at its full qty", async () => {
    const { lineB } = await editFirstPartial("line");
    expect({
      status: lineB?.status,
      qty: Number(lineB?.qty),
      subtotal: Number(lineB?.subtotal),
      invoicedQty: Number(lineB?.invoicedQty),
    }).toEqual({ status: "PENDING", qty: 6, subtotal: 30, invoicedQty: 0 });
  });

  // Wrong value on master: 40 - the same recompute rewrites the order to the BILLED sum, so the
  // whole order shrinks while $30 of goods are still to be invoiced. Separate effect of the same
  // recompute: a fix that only stops the line cancel leaves this one red.
  it("REG-B667 (b): editing the first DRAFT partial leaves the order subtotal at the full ordered 70", async () => {
    const { order } = await editFirstPartial("total");
    expect(Number(order?.subtotal)).toBe(70);
  });
});
