/**
 * Row 342 (3) on real Postgres: a DRIVER's cash is not till cash, and it never counts as a hand-over.
 *
 * The driver-cash leg is recorded through the REAL path (`InvoicesService.recordDeliveryPaymentInTx`, the at-door collection
 * a stop completion runs), on a ROUTE order, next to a counter sale's till cash and a POS pickup hand-over on the same
 * register. The window is then read by the one reader the preview, the close and the re-close share (`readWindowFacts`) and
 * folded by the real fold, so the assertion is on the DayCloseTotals bucket the figures land in:
 *   - the driver cash is in NO till bucket: tillCash, moneyIn.cash and notAtTill carry only the counter sale and the hand-over;
 *   - totals.handOver counts the non-counter PICKUP row only (count 1, cash 20), never the route order's cash;
 *   - the stored driver payment is a live PAID CASH row that `isCounterTenderRow` itself calls foreign for a route order, so
 *     the test is not vacuous (the money exists, it is just the run settlement's, not the drawer's).
 *
 * Runs only under `npm run local:test:db` (test tenants only, `qa-day-close-driver-*`, approved by assertTestTenant).
 */
jest.mock("../../../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../../../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../../orders.service", () => ({ OrdersService: class OrdersService {} }));

import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { AfterCommit } from "../../../common/after-commit";
import { InvoicesService } from "../../../invoices/invoices.service";
import { InvoicePdfService } from "../../../invoices/invoice-pdf.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { TenantContextService } from "../../../tenant/tenant-context.service";
import { RouteFlowGateway } from "../../../gateways/routeflow.gateway";
import { EmailService } from "../../../email/email.service";
import { SystemConfigService } from "../../../system-config/system-config.service";
import { RegulatedLedgerService } from "../../../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../../../authorizations/authorization-guard.service";
import { CreditNotesService } from "../../../credit-notes/credit-notes.service";
import { MessagingService } from "../../../messaging/messaging.service";
import { StorageService } from "../../../storage/storage.service";
import { EntitlementsService } from "../../../billing/entitlements.service";
import { CommissionEngineService } from "../../../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../../../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../../../estimates/estimates.service";
import { NumberingService } from "../../../import/numbering.service";
import { _resetLockPoolForTests } from "../../../common/db-locks";
import { describeDb, requireLocalDatabaseUrl } from "../../../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../../../testing/entitlement-authority-provider";
import { isCounterTenderRow } from "../counter-tender-row";
import { pickupTenderGroupId } from "../pickup-tender-group";
import { foldDayClose } from "./day-close-fold";
import { readWindowFacts } from "./day-close-facts";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const MIN = 60_000;

describeDb("driver cash vs the day close totals, real Postgres (row 342)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoices: InvoicesService;
  let tenantId = "";

  beforeAll(async () => {
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    requireLocalDatabaseUrl();
    const mod = await Test.createTestingModule({
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
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
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
    invoices = mod.get(InvoicesService);
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    if (tenantId) {
      const where = { where: { tenantId } };
      await prisma.regulatedSalesLedger.deleteMany(where).catch(swallow);
      await prisma.advancePayment.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.paymentCounter.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await _resetLockPoolForTests();
    await prisma?.$disconnect();
  });

  it("a route order's driver cash is in no till bucket and never in totals.handOver", async () => {
    const slug = assertTestTenant(`qa-day-close-driver-${RUN}`, "day-close-driver-cash.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `driver cash ${slug}` } });
    tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: "Acme Test", contactName: "Tester", tenantId },
    });
    let seq = 0;
    const mkOrder = async (o: { counterSale: boolean; fulfillPath: "PICKUP" | "ROUTE" }) => {
      seq += 1;
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          status: "DELIVERED",
          fulfillPath: o.fulfillPath,
          counterSale: o.counterSale,
          subtotal: 100,
          tax: 0,
          total: 100,
        },
      });
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-DRV-${RUN}-${seq}`,
          status: "SENT",
          subtotal: 100,
          taxAmount: 0,
          total: 100,
        },
      });
      return { orderId: order.id, invoiceId: invoice.id };
    };
    const paidAt = (minAgo: number) => new Date(Date.now() - minAgo * MIN);

    // the counter sale's till cash ($30), the way the counter tender records it (ungrouped)
    const counter = await mkOrder({ counterSale: true, fulfillPath: "PICKUP" });
    await tenantCtx.run(tenantId, () =>
      invoices.recordPayment(counter.invoiceId, {
        amount: 30,
        method: "CASH",
        paidAt: paidAt(30).toISOString(),
      } as never),
    );
    // a POS pickup hand-over's own cash ($20): the order's deterministic pickup group id, on a non-counter order
    const pickup = await mkOrder({ counterSale: false, fulfillPath: "PICKUP" });
    await prisma.invoicePayment.create({
      data: {
        invoiceId: pickup.invoiceId,
        tenantId,
        amount: 20,
        method: "CASH",
        status: "PAID",
        paidAt: paidAt(20),
        paymentGroupId: pickupTenderGroupId(pickup.orderId),
      },
    });
    // the driver's cash ($60) at the door of a ROUTE order, through the real at-door collection
    const route = await mkOrder({ counterSale: false, fulfillPath: "ROUTE" });
    const taken = await tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction((tx: any) =>
        invoices.recordDeliveryPaymentInTx(tx, new AfterCommit(), [route.orderId], 60, "CASH"),
      ),
    );
    expect(taken.applied).toBe(60);

    // the money exists and is a live PAID CASH row, and the one predicate calls it foreign on a route order
    const driverRows = await prisma.invoicePayment.findMany({
      where: { invoiceId: route.invoiceId },
    });
    expect(driverRows).toHaveLength(1);
    expect(driverRows[0]).toMatchObject({ method: "CASH", status: "PAID" });
    expect(Number(driverRows[0].amount)).toBe(60);
    expect(isCounterTenderRow(route.orderId, driverRows[0], { counterSale: false })).toBe(false);

    const w = { start: paidAt(120), end: new Date(Date.now() + 5 * MIN) };
    const fold = await tenantCtx.run(tenantId, async () =>
      foldDayClose(await readWindowFacts(prisma.forTenant(), tenantId, "main", w)),
    );
    expect(fold.tillCash).toBe(50); // the counter sale's 30 and the hand-over's 20; not the driver's 60
    expect(fold.totals.moneyIn.cash).toBe(50);
    expect(fold.totals.notAtTill).toBe(0);
    expect(fold.totals.handOver).toEqual({ count: 1, cash: 20 }); // the non-counter PICKUP row only
    expect(fold.totals.salesCount).toBe(1); // the counter sale; neither the hand-over nor the route order
  }, 120_000);
});
