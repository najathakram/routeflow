/**
 * SA-750r3 (amended) — real-Postgres proof that a payment recorded through the OFFICE door cannot change a closed Z report.
 *
 * Real: PrismaService, InvoicesService.recordPayment, CounterSaleService's locked tender, a real `CounterDayClose` row, the
 * real lock manager and the real day-close fold (`readWindowFacts` + `foldDayClose`). Stubbed: the collaborators every invoices
 * DB spec stubs (gateway, email, PDF, storage, commission engine ...).
 *
 *  - a backdated CASH payment on a COUNTER invoice, dated inside a closed window, is refused 409 DAY_CLOSED_FOR_PAYMENT_DATE
 *    (`closedThrough` = the close's windowEnd) and the stored close row and a fresh fold over the closed window are
 *    BYTE-IDENTICAL before and after (the closed Z cannot change);
 *  - a backdated CHECK or CREDIT_CARD (counted in moneyIn) into a closed window is refused 409 COUNTER_SALE_DAY_CLOSED and the
 *    closed fold is byte-identical; a backdated ACH (no till total) keeps its true paidAt;
 *  - a CASH dated after the cutoff, a CASH on a NON-counter invoice, and a CASH into a REOPENED close all go through;
 *  - deadlock contract: the counter tender, while a close is queued for the EXCLUSIVE lock behind the tender's shared one,
 *    still records its payment (recordPayment takes no second shared request: `tillLockHeld`).
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
// The tender never touches OrdersService; its module pulls ESM-only dependencies Jest cannot load.
jest.mock("../orders/orders.service", () => ({ OrdersService: class OrdersService {} }));

import { Test } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
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
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { CounterSaleService } from "../orders/counter-sale/counter-sale.service";
import { counterCloseShared } from "../orders/counter-sale/counter-tender-window";
import { counterCloseKeyOf } from "../returns/counter-close-lock";
import { foldDayClose } from "../orders/counter-sale/day-close/day-close-fold";
import { readWindowFacts } from "../orders/counter-sale/day-close/day-close-facts";
import { _resetLockPoolForTests, withAdvisoryLock } from "../common/db-locks";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const MIN = 60_000;

describeDb(
  "a payment recorded through the office door and the closed Z report, real Postgres (SA-750r3)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let invoices: InvoicesService;
    let counterSale: any;
    let url: string;
    const tenantIds: string[] = [];
    let seq = 0;

    beforeAll(async () => {
      url = requireLocalDatabaseUrl();
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
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
          },
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
      // The locked half of the counter tender, as `ring` calls it (the full ring needs the whole OrdersService).
      counterSale = Object.assign(Object.create(CounterSaleService.prototype), {
        prisma,
        invoices,
        logger: new Logger("counter-record-payment-closed-day.db.spec"),
      });
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

    /** A throwaway approved tenant with a $100 SENT invoice on a counter (or ordinary) order. */
    async function seed(label: string, counter: boolean) {
      seq += 1;
      const slug = assertTestTenant(
        `qa-day-close-${RUN}-${seq}-${label}`,
        "counter-record-payment-closed-day.db.spec.ts",
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
          fulfillPath: counter ? "PICKUP" : "ROUTE",
          counterSale: counter,
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
          invoiceNumber: `INV-RP-${RUN}-${seq}`,
          status: "SENT",
          subtotal: 100,
          taxAmount: 0,
          total: 100,
        },
      });
      return { tenantId, orderId: order.id, invoiceId: invoice.id };
    }

    /** The closed window: [120, 10) minutes ago. */
    const window = () => ({
      start: new Date(Date.now() - 120 * MIN),
      end: new Date(Date.now() - 10 * MIN),
    });
    const closeRow = (tenantId: string, w: { start: Date; end: Date }, over: object = {}) =>
      prisma.counterDayClose.create({
        data: {
          tenantId,
          registerKey: "main",
          day: new Date(),
          zone: "UTC",
          windowStart: w.start,
          windowEnd: w.end,
          closedAt: w.end,
          expectedCash: 0,
          countedCash: 0,
          variance: 0,
          denominations: [],
          totals: {},
          ...over,
        },
      });

    /** The office door: the controller calls `recordPayment(id, dto)` with no options. */
    const record = (
      tenantId: string,
      invoiceId: string,
      method: string,
      minAgo: number,
      amount = 30,
    ) =>
      tenantCtx.run(tenantId, () =>
        invoices.recordPayment(invoiceId, {
          amount,
          method,
          paidAt: new Date(Date.now() - minAgo * MIN).toISOString(),
        } as any),
      );

    const closeJson = async (id: string) =>
      JSON.stringify(await prisma.counterDayClose.findUniqueOrThrow({ where: { id } }));
    /** A FRESH fold over the closed window, as the Z report reads it. */
    const fold = (tenantId: string, w: { start: Date; end: Date }) =>
      tenantCtx.run(tenantId, async () =>
        foldDayClose(await readWindowFacts(prisma.forTenant(), tenantId, "main", w)),
      );
    const cashFigures = (f: Awaited<ReturnType<typeof fold>>) => ({
      tillCash: f.tillCash,
      cashRefunds: f.cashRefunds,
      moneyInCash: f.totals.moneyIn.cash,
    });
    const stored = (invoiceId: string) =>
      prisma.invoicePayment.findMany({ where: { invoiceId }, orderBy: { createdAt: "asc" } });

    /** A COUNTER sale with $30 CASH taken 30 min ago, then the window [120, 10) closed over it. */
    async function closedDay(label: string) {
      const s = await seed(label, true);
      await record(s.tenantId, s.invoiceId, "CASH", 30); // taken BEFORE the close, as it happened
      const w = window();
      const close = await closeRow(s.tenantId, w);
      return { ...s, w, close };
    }

    describe("a COUNTER invoice, recorded through the office door", () => {
      it("a backdated CASH into the closed window: 409 DAY_CLOSED_FOR_PAYMENT_DATE and the closed Z is BYTE-IDENTICAL", async () => {
        const s = await closedDay("cash-closed");
        const closeBefore = await closeJson(s.close.id);
        const foldBefore = await fold(s.tenantId, s.w);
        expect(foldBefore.tillCash).toBe(30); // the test is meaningful: the window holds the cash
        const rowsBefore = (await stored(s.invoiceId)).length;

        const err: any = await record(s.tenantId, s.invoiceId, "CASH", 25, 20).catch(
          (e: unknown) => e,
        );

        expect(err.getStatus?.()).toBe(409);
        expect(err.getResponse()).toEqual({
          code: "DAY_CLOSED_FOR_PAYMENT_DATE",
          message: "That day is closed. Record it with today's date.",
          closedThrough: s.close.windowEnd.toISOString(),
        });
        expect(await stored(s.invoiceId)).toHaveLength(rowsBefore);
        expect(await closeJson(s.close.id)).toBe(closeBefore);
        expect(JSON.stringify(await fold(s.tenantId, s.w))).toBe(JSON.stringify(foldBefore));
      });

      it.each(["CHECK", "CREDIT_CARD"])(
        "a backdated %s into the closed window: refused COUNTER_SALE_DAY_CLOSED; the stored close and the whole closed fold are byte-identical",
        async (method) => {
          const s = await closedDay(`${method.toLowerCase()}-closed`);
          const closeBefore = await closeJson(s.close.id);
          const foldBefore = JSON.stringify(await fold(s.tenantId, s.w));
          const rowsBefore = (await stored(s.invoiceId)).length;

          await expect(
            tenantCtx.run(s.tenantId, () =>
              invoices.recordPayment(s.invoiceId, {
                amount: 20,
                method,
                paidAt: new Date(Date.now() - 25 * MIN).toISOString(),
              } as any),
            ),
          ).rejects.toMatchObject({ response: { code: "COUNTER_SALE_DAY_CLOSED" } });

          expect(await stored(s.invoiceId)).toHaveLength(rowsBefore);
          expect(await closeJson(s.close.id)).toBe(closeBefore);
          expect(JSON.stringify(await fold(s.tenantId, s.w))).toBe(foldBefore);
        },
      );

      it("a backdated ACH (moves no till total) keeps its TRUE paidAt", async () => {
        const s = await closedDay("ach-closed");
        const when = Date.now() - 25 * MIN;
        await tenantCtx.run(s.tenantId, () =>
          invoices.recordPayment(s.invoiceId, {
            amount: 20,
            method: "ACH",
            paidAt: new Date(when).toISOString(),
          } as any),
        );
        const ach = (await stored(s.invoiceId)).find((p) => p.method === "ACH")!;
        expect(ach.paidAt.getTime()).toBe(when);
      });

      it("a CASH dated after the cutoff (the open day): accepted, and the closed fold is unchanged", async () => {
        const s = await closedDay("cash-open");
        const foldBefore = await fold(s.tenantId, s.w);

        await record(s.tenantId, s.invoiceId, "CASH", 2, 20); // 2 min ago: after windowEnd

        expect(await stored(s.invoiceId)).toHaveLength(2);
        expect(JSON.stringify(await fold(s.tenantId, s.w))).toBe(JSON.stringify(foldBefore));
      });

      it("a backdated CASH once the close is REOPENED (reopenedAt set): accepted", async () => {
        const s = await closedDay("cash-reopened");
        await prisma.counterDayClose.update({
          where: { id: s.close.id },
          data: { reopenedAt: new Date() },
        });

        await record(s.tenantId, s.invoiceId, "CASH", 25, 20);

        expect(await stored(s.invoiceId)).toHaveLength(2);
      });
    });

    describe("a NON-counter invoice", () => {
      it("a backdated CASH is unchanged: accepted, no counter-close involvement", async () => {
        const s = await seed("cash-office", false);
        await closeRow(s.tenantId, window());

        await record(s.tenantId, s.invoiceId, "CASH", 25, 20);

        const rows = await stored(s.invoiceId);
        expect(rows).toHaveLength(1);
        expect(Math.abs(rows[0].paidAt.getTime() - (Date.now() - 25 * MIN))).toBeLessThan(30_000);
      });
    });

    describe("the counter tender with a close queued for the EXCLUSIVE lock", () => {
      it("still records (recordPayment asks for no second shared lock), then the close proceeds", async () => {
        const s = await seed("tender-deadlock", true);
        const till = { counterSale: true, registerKey: null };
        const closer = new Client({ connectionString: url });
        await closer.connect();
        const original = invoices.recordPayment.bind(invoices);
        let queuedClose: Promise<unknown> | undefined;
        const spy = jest
          .spyOn(invoices, "recordPayment")
          .mockImplementationOnce(async (...args: Parameters<typeof original>) => {
            // The tender's pinned connection holds the SHARED lock here. Queue the close's EXCLUSIVE request behind it.
            await closer.query("BEGIN");
            await closer.query("SET LOCAL lock_timeout = '20s'");
            queuedClose = closer.query(
              `SELECT pg_advisory_xact_lock(hashtext('counter-close'), hashtext($1))`,
              [counterCloseKeyOf(s.tenantId, "main")],
            );
            await new Promise((r) => setTimeout(r, 500)); // the exclusive request is now waiting
            return original(...args);
          });
        try {
          const res: any = await tenantCtx.run(s.tenantId, () =>
            withAdvisoryLock(
              {
                family: "counter-tender",
                key: s.orderId,
                mode: "wait",
                sharedAlso: counterCloseShared(s.tenantId, till),
              },
              () => counterSale.tender([{ method: "CASH", amount: 40 }], s.orderId, till),
            ),
          );

          expect(res.acquired).toBe(true);
          expect(await stored(s.invoiceId)).toHaveLength(1);
          await queuedClose; // granted once the tender released the shared lock
          await closer.query("COMMIT");
        } finally {
          spy.mockRestore();
          await closer.query("ROLLBACK").catch(() => undefined);
          await closer.end().catch(() => undefined);
        }
      }, 60_000);
    });
  },
);
