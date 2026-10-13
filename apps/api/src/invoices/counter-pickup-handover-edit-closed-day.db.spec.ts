/**
 * End-of-day close, per-row rule — real-Postgres proof that an OFFICE void / update / delete of a POS PICKUP hand-over payment
 * after the close is refused, while the rest of the order stays editable.
 *
 * Real: PrismaService, InvoicesService (voidPayment, deletePayment, updatePayment), a real `CounterDayClose` row, the real
 * order (fulfillPath PICKUP, counterSale false), real payment rows, the real lock manager and the real window fold
 * (`readWindowFacts` + `foldDayClose`). Stubbed: the collaborators every invoices DB spec stubs (gateway, email, PDF, storage,
 * commission engine ...).
 *
 *  - a hand-over row (`paymentGroupId = pickupTenderGroupId(orderId)`) dated inside a CLOSED window: void / update / delete are
 *    refused 409 COUNTER_SALE_DAY_CLOSED; the payment rows, the invoice, the stored close row and a fresh fold over the window
 *    are all unchanged;
 *  - an OFFICE row on the same pickup order (a random payment group) dated inside the same window stays editable;
 *  - a hand-over row dated after the window, or inside a window whose close was REOPENED, stays editable;
 *  - a DELIVERY (ROUTE) invoice is unchanged: a hand-over-group row inside a window is still editable (no close lock).
 *
 * Runs only under `npm run local:test:db`. Written WITHOUT being run in the authoring environment (no Postgres there).
 * Every tenant is a throwaway `qa-day-close-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order in afterAll.
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
// The edits never touch OrdersService; its module pulls ESM-only dependencies Jest cannot load.
jest.mock("../orders/orders.service", () => ({ OrdersService: class OrdersService {} }));

import { Test } from "@nestjs/testing";
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { pickupTenderGroupId } from "../orders/counter-sale/pickup-tender-group";
import { readWindowFacts } from "../orders/counter-sale/day-close/day-close-facts";
import { foldDayClose } from "../orders/counter-sale/day-close/day-close-fold";
import { _resetLockPoolForTests } from "../common/db-locks";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const MIN = 60_000;
const OFFICE_GROUP = randomUUID();

describeDb("an office edit of a pickup hand-over payment after the close, real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoices: InvoicesService;
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
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
  });

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.counterDayClose.deleteMany(where).catch(swallow);
      await prisma.regulatedSalesLedger.deleteMany(where).catch(swallow);
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

  /** A throwaway approved tenant with a $100 SENT invoice on a POS PICKUP order (or a ROUTE delivery order). */
  async function seed(label: string, fulfillPath: "PICKUP" | "ROUTE") {
    seq += 1;
    const slug = assertTestTenant(
      `qa-day-close-${RUN}-${seq}-${label}`,
      "counter-pickup-handover-edit-closed-day.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `day close ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        status: "DELIVERED",
        fulfillPath,
        counterSale: false,
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
        invoiceNumber: `INV-HO-${RUN}-${seq}`,
        status: "PARTIAL",
        subtotal: 100,
        taxAmount: 0,
        total: 100,
      },
    });
    return { tenantId, orderId: order.id, invoiceId: invoice.id };
  }

  /** A close in force whose window covers the minutes between `from` and `to` ago. */
  const closeRow = (tenantId: string, fromMin: number, toMin: number) =>
    prisma.counterDayClose.create({
      data: {
        tenantId,
        registerKey: "main",
        day: new Date(),
        zone: "UTC",
        windowStart: new Date(Date.now() - fromMin * MIN),
        windowEnd: new Date(Date.now() - toMin * MIN),
        closedAt: new Date(Date.now() - toMin * MIN),
        expectedCash: 0,
        countedCash: 0,
        variance: 0,
        denominations: [],
        totals: {},
      },
    });

  /** A stored CASH row, as the history it is: a hand-over (the order's own group id) or an office payment (another group). */
  let paySeq = 0;
  const payRow = (
    s: { tenantId: string; orderId: string; invoiceId: string },
    kind: "handover" | "office",
    minAgo: number,
  ) => {
    paySeq += 1;
    return prisma.invoicePayment.create({
      data: {
        tenantId: s.tenantId,
        invoiceId: s.invoiceId,
        amount: 30,
        method: "CASH",
        status: "PAID",
        paidAt: new Date(Date.now() - minAgo * MIN),
        paymentNumber: `PAY-HO-${RUN}-${paySeq}`,
        paymentGroupId: kind === "handover" ? pickupTenderGroupId(s.orderId) : OFFICE_GROUP,
      },
    });
  };

  const ops = {
    void: (inv: string, p: string) => invoices.voidPayment(inv, p),
    delete: (inv: string, p: string) => invoices.deletePayment(inv, p),
    edit: (inv: string, p: string) =>
      invoices.updatePayment(inv, p, { amount: 40, method: "CASH" } as any),
  } as const;
  type Op = keyof typeof ops;
  const opNames = Object.keys(ops) as Op[];

  /** Everything a refused edit must leave alone: the payment rows, the invoice, the stored close row and a fresh window fold. */
  async function snapshot(s: { tenantId: string; invoiceId: string }, closeId: string | null) {
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } });
    const payments = await prisma.invoicePayment.findMany({
      where: { invoiceId: s.invoiceId },
      orderBy: { paymentNumber: "asc" },
    });
    const close = closeId
      ? await prisma.counterDayClose.findUniqueOrThrow({ where: { id: closeId } })
      : null;
    const fold = close
      ? await tenantCtx.run(s.tenantId, () =>
          readWindowFacts(prisma.forTenant(), s.tenantId, "main", {
            start: close.windowStart,
            end: close.windowEnd,
          }).then(foldDayClose),
        )
      : null;
    return JSON.parse(JSON.stringify({ invoice, payments, close, fold }));
  }

  describe.each(opNames)("%s of a hand-over row on a PICKUP order", (op) => {
    it("dated inside a closed window: 409 COUNTER_SALE_DAY_CLOSED; payments, invoice, stored close and a fresh fold unchanged", async () => {
      const s = await seed(`${op}-closed`, "PICKUP");
      const close = await closeRow(s.tenantId, 120, 10);
      const p = await payRow(s, "handover", 30); // inside [120, 10)
      const before = await snapshot(s, close.id);

      const err: any = await tenantCtx
        .run(s.tenantId, () => ops[op](s.invoiceId, p.id))
        .catch((e: unknown) => e);

      expect(err.getStatus?.()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: "COUNTER_SALE_DAY_CLOSED" });
      expect(await snapshot(s, close.id)).toEqual(before);
    });

    it("an OFFICE row on the same order (another payment group) inside the same window: allowed", async () => {
      const s = await seed(`${op}-office`, "PICKUP");
      const close = await closeRow(s.tenantId, 120, 10);
      const hand = await payRow(s, "handover", 40);
      const office = await payRow(s, "office", 30);
      const before = await snapshot(s, close.id);

      await tenantCtx.run(s.tenantId, () => ops[op](s.invoiceId, office.id));

      const after = await snapshot(s, close.id);
      expect(after.payments).not.toEqual(before.payments);
      // the hand-over row and the closed day are exactly as they were
      expect(after.payments.find((x: any) => x.id === hand.id)).toEqual(
        before.payments.find((x: any) => x.id === hand.id),
      );
      expect(after.close).toEqual(before.close);
    });

    it("dated AFTER the window: allowed", async () => {
      const s = await seed(`${op}-open`, "PICKUP");
      const close = await closeRow(s.tenantId, 120, 10);
      const p = await payRow(s, "handover", 2);
      const before = await snapshot(s, close.id);

      await tenantCtx.run(s.tenantId, () => ops[op](s.invoiceId, p.id));

      expect((await snapshot(s, close.id)).payments).not.toEqual(before.payments);
    });

    it("inside a window whose close was REOPENED: allowed", async () => {
      const s = await seed(`${op}-reopened`, "PICKUP");
      const close = await closeRow(s.tenantId, 120, 10);
      const p = await payRow(s, "handover", 30);
      const before = await snapshot(s, close.id);
      await prisma.counterDayClose.update({
        where: { id: close.id },
        data: { reopenedAt: new Date() },
      });

      await tenantCtx.run(s.tenantId, () => ops[op](s.invoiceId, p.id));

      expect((await snapshot(s, close.id)).payments).not.toEqual(before.payments);
    });
  });

  describe.each(opNames)("%s on a DELIVERY (ROUTE) invoice", (op) => {
    it("is unchanged: a hand-over-group row inside a window of the register is still editable", async () => {
      const s = await seed(`${op}-route`, "ROUTE");
      const close = await closeRow(s.tenantId, 120, 10);
      const p = await payRow(s, "handover", 30);
      const before = await snapshot(s, close.id);

      await tenantCtx.run(s.tenantId, () => ops[op](s.invoiceId, p.id));

      expect((await snapshot(s, close.id)).payments).not.toEqual(before.payments);
    });
  });
});
