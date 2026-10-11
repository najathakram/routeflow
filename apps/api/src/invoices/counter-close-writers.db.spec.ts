/**
 * SA-750r3 — real-Postgres proof that every writer of till money honours the end-of-day close.
 *
 * Real: PrismaService, InvoicesService (voidPayment, deletePayment, updatePayment, setCheckStatus, recordPayment) and
 * CounterSaleService's locked tender, a real `CounterDayClose` row, the real lock manager and the database clock. Stubbed:
 * the collaborators every invoices DB spec stubs (gateway, email, PDF, storage, commission engine ...).
 *
 *  - the four payment-edit paths on a COUNTER sale refuse 409 COUNTER_SALE_DAY_CLOSED for a payment dated inside a closed
 *    window and leave the payment and the invoice totals untouched; a REOPENED close (reopenedAt set) lets each through;
 *  - the same calls on a NON-counter invoice are unchanged (the window is irrelevant, no counter-close lock is taken);
 *  - the counter tender (`withAdvisoryLock` + `sharedAlso`, the exact call CounterSaleService.ring makes) refuses inside a
 *    closed window with nothing written, records after the window / in a reopened one, dating the payment from the database
 *    clock;
 *  - lock contract: the tender waits behind a close holding the EXCLUSIVE form, and a close cannot start while a tender is
 *    in flight (the shared form rides the tender's pinned connection).
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
import { _resetLockPoolForTests, withAdvisoryLock } from "../common/db-locks";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const MIN = 60_000;

describeDb("the end-of-day close and every writer of till money, real Postgres (SA-750r3)", () => {
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
    // The locked half of the counter tender, as `ring` calls it (the full ring needs the whole OrdersService).
    counterSale = Object.assign(Object.create(CounterSaleService.prototype), {
      prisma,
      invoices,
      logger: new Logger("counter-close-writers.db.spec"),
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
      "counter-close-writers.db.spec.ts",
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
        invoiceNumber: `INV-DC-${RUN}-${seq}`,
        status: "SENT",
        subtotal: 100,
        taxAmount: 0,
        total: 100,
      },
    });
    return { tenantId, orderId: order.id, invoiceId: invoice.id };
  }

  /** A close in force whose window covers the minutes between `from` and `to` ago. */
  const closeRow = (tenantId: string, fromMin: number, toMin: number, over: object = {}) =>
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
        ...over,
      },
    });

  /** A payment recorded through the REAL writer, dated `minAgo` minutes ago. */
  async function pay(
    tenantId: string,
    invoiceId: string,
    method: "CASH" | "CHECK",
    minAgo: number,
  ) {
    // History is seeded as it happened: the payment was taken BEFORE the close. The office door now refuses a backdated CASH
    // into a closed window (SA-750r3, DAY_CLOSED_FOR_PAYMENT_DATE), so lift any standing close of the tenant for this one
    // seeding call and put it back (that refusal has its own spec: counter-record-payment-closed-day.db.spec.ts).
    const standing = await prisma.counterDayClose.findMany({
      where: { tenantId, reopenedAt: null },
      select: { id: true },
    });
    const ids = standing.map((c) => c.id);
    await prisma.counterDayClose.updateMany({
      where: { id: { in: ids } },
      data: { reopenedAt: new Date() },
    });
    try {
      await tenantCtx.run(tenantId, () =>
        invoices.recordPayment(invoiceId, {
          amount: 30,
          method,
          paidAt: new Date(Date.now() - minAgo * MIN).toISOString(),
        } as any),
      );
    } finally {
      await prisma.counterDayClose.updateMany({
        where: { id: { in: ids } },
        data: { reopenedAt: null },
      });
    }
    return prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId, method } });
  }

  const paths = {
    void: (t: string, inv: string, p: string) => invoices.voidPayment(inv, p),
    delete: (t: string, inv: string, p: string) => invoices.deletePayment(inv, p),
    edit: (t: string, inv: string, p: string) =>
      invoices.updatePayment(inv, p, { amount: 40, method: "CASH" } as any),
    bounced: (t: string, inv: string, p: string) =>
      invoices.setCheckStatus(inv, p, { status: "BOUNCED", nsfFeeAmount: 25 } as any),
  } as const;
  const methodOf = (path: keyof typeof paths) => (path === "bounced" ? "CHECK" : "CASH");

  async function snapshot(invoiceId: string) {
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const payments = await prisma.invoicePayment.findMany({
      where: { invoiceId },
      orderBy: { createdAt: "asc" },
    });
    return {
      total: Number(inv.total),
      subtotal: Number(inv.subtotal),
      status: inv.status,
      payments: payments.map((p) => ({ id: p.id, amount: Number(p.amount), status: p.status })),
    };
  }

  describe.each(Object.keys(paths) as Array<keyof typeof paths>)("%s on a COUNTER sale", (path) => {
    it("a payment dated inside a closed window: 409 COUNTER_SALE_DAY_CLOSED, payment and totals unchanged", async () => {
      const s = await seed(`${path}-closed`, true);
      await closeRow(s.tenantId, 120, 10);
      const p = await pay(s.tenantId, s.invoiceId, methodOf(path), 30); // 30 min ago: inside [120, 10)
      const before = await snapshot(s.invoiceId);

      const err: any = await tenantCtx
        .run(s.tenantId, () => paths[path](s.tenantId, s.invoiceId, p.id))
        .catch((e: unknown) => e);

      expect(err.getStatus?.()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: "COUNTER_SALE_DAY_CLOSED" });
      expect(await snapshot(s.invoiceId)).toEqual(before);
    });

    it("the same payment once the close is REOPENED (reopenedAt set): allowed", async () => {
      const s = await seed(`${path}-reopened`, true);
      const close = await closeRow(s.tenantId, 120, 10);
      const p = await pay(s.tenantId, s.invoiceId, methodOf(path), 30);
      const before = await snapshot(s.invoiceId);
      await prisma.counterDayClose.update({
        where: { id: close.id },
        data: { reopenedAt: new Date() },
      });

      await tenantCtx.run(s.tenantId, () => paths[path](s.tenantId, s.invoiceId, p.id));

      expect(await snapshot(s.invoiceId)).not.toEqual(before);
    });

    it("a payment dated AFTER the window (the open day): allowed", async () => {
      const s = await seed(`${path}-open`, true);
      await closeRow(s.tenantId, 120, 10);
      const p = await pay(s.tenantId, s.invoiceId, methodOf(path), 2); // 2 min ago: after windowEnd
      const before = await snapshot(s.invoiceId);

      await tenantCtx.run(s.tenantId, () => paths[path](s.tenantId, s.invoiceId, p.id));

      expect(await snapshot(s.invoiceId)).not.toEqual(before);
    });
  });

  describe.each(Object.keys(paths) as Array<keyof typeof paths>)(
    "%s on a NON-counter invoice",
    (path) => {
      it("is unchanged: a payment inside a window of the register is still editable", async () => {
        const s = await seed(`${path}-office`, false);
        await closeRow(s.tenantId, 120, 10);
        const p = await pay(s.tenantId, s.invoiceId, methodOf(path), 30);
        const before = await snapshot(s.invoiceId);

        await tenantCtx.run(s.tenantId, () => paths[path](s.tenantId, s.invoiceId, p.id));

        expect(await snapshot(s.invoiceId)).not.toEqual(before);
      });
    },
  );

  describe("updatePayment changing paidAt checks the new date too", () => {
    it("moving an open-dated payment INTO a closed window is refused and nothing changes", async () => {
      const s = await seed("edit-into", true);
      await closeRow(s.tenantId, 120, 10);
      const p = await pay(s.tenantId, s.invoiceId, "CASH", 2);
      const before = await snapshot(s.invoiceId);

      const err: any = await tenantCtx
        .run(s.tenantId, () =>
          invoices.updatePayment(s.invoiceId, p.id, {
            amount: 30,
            method: "CASH",
            paidAt: new Date(Date.now() - 60 * MIN).toISOString(),
          } as any),
        )
        .catch((e: unknown) => e);

      expect(err.getResponse()).toMatchObject({ code: "COUNTER_SALE_DAY_CLOSED" });
      expect(await snapshot(s.invoiceId)).toEqual(before);
      const stored = await prisma.invoicePayment.findUniqueOrThrow({ where: { id: p.id } });
      expect(stored.paidAt.getTime()).toBe(p.paidAt.getTime());
    });
  });

  describe("the counter tender", () => {
    const till = { counterSale: true, registerKey: null };
    // the locked half of the tender takes the request's legs (one leg: the old `payment` alias)
    const cash = [{ method: "CASH", amount: 40 }];
    const tender = (s: { tenantId: string; orderId: string }) =>
      tenantCtx.run(s.tenantId, () =>
        withAdvisoryLock(
          {
            family: "counter-tender",
            key: s.orderId,
            mode: "wait",
            sharedAlso: counterCloseShared(s.tenantId, till),
          },
          () => counterSale.tender(cash, s.orderId, till),
        ),
      );
    const stored = (invoiceId: string) => prisma.invoicePayment.findMany({ where: { invoiceId } });

    it("inside a closed window (the clock instant is in force): 409 COUNTER_SALE_DAY_CLOSED and nothing is written", async () => {
      const s = await seed("tender-closed", true);
      await closeRow(s.tenantId, 60, -60); // windowEnd one hour in the future: the database clock falls inside it

      const err: any = await tender(s).catch((e: unknown) => e);

      expect(err.getResponse()).toMatchObject({ code: "COUNTER_SALE_DAY_CLOSED" });
      expect(await stored(s.invoiceId)).toHaveLength(0);
    });

    it("after the window (the close ended in the past): recorded, dated from the database clock", async () => {
      const s = await seed("tender-open", true);
      await closeRow(s.tenantId, 120, 10);
      const t0 = Date.now();

      const res: any = await tender(s);

      expect(res.acquired).toBe(true);
      const rows = await stored(s.invoiceId);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].amount)).toBe(40);
      expect(Math.abs(rows[0].paidAt.getTime() - t0)).toBeLessThan(30_000);
    });

    it("in a reopened window: recorded", async () => {
      const s = await seed("tender-reopened", true);
      await closeRow(s.tenantId, 60, -60, { reopenedAt: new Date() });

      await tender(s);

      expect(await stored(s.invoiceId)).toHaveLength(1);
    });

    it("a replay of a recorded tender returns the stored result, never 409, even when a close now covers the instant", async () => {
      const s = await seed("tender-replay", true);
      await tender(s);
      await closeRow(s.tenantId, 60, -60);

      const res: any = await tender(s);

      expect(res.acquired).toBe(true);
      expect(await stored(s.invoiceId)).toHaveLength(1);
    });

    it("waits behind a close holding the EXCLUSIVE lock and records only after it commits", async () => {
      const s = await seed("tender-waits", true);
      const holder = new Client({ connectionString: url });
      await holder.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          `SELECT pg_advisory_xact_lock(hashtext('counter-close'), hashtext($1))`,
          [counterCloseKeyOf(s.tenantId, "main")],
        );
        let done = false;
        const running = tender(s).then((r) => {
          done = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 800));
        expect(done).toBe(false);
        expect(await stored(s.invoiceId)).toHaveLength(0);

        await holder.query("COMMIT");
        await running;
        expect(await stored(s.invoiceId)).toHaveLength(1);
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        await holder.end().catch(() => undefined);
      }
    }, 60_000);

    it("a close cannot take its EXCLUSIVE lock while a tender holds the shared one, and can once it is released", async () => {
      const s = await seed("close-waits", true);
      const closer = new Client({ connectionString: url });
      await closer.connect();
      try {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let inside!: () => void;
        const entered = new Promise<void>((r) => (inside = r));
        const inFlight = withAdvisoryLock(
          {
            family: "counter-tender",
            key: s.orderId,
            mode: "wait",
            sharedAlso: counterCloseShared(s.tenantId, till),
          },
          async () => {
            inside();
            await gate;
          },
        );
        await entered;

        await closer.query("BEGIN");
        await closer.query("SET LOCAL lock_timeout = '400ms'");
        await expect(
          closer.query(`SELECT pg_advisory_xact_lock(hashtext('counter-close'), hashtext($1))`, [
            counterCloseKeyOf(s.tenantId, "main"),
          ]),
        ).rejects.toMatchObject({ code: "55P03" });
        await closer.query("ROLLBACK");

        release();
        await inFlight;
        await closer.query("BEGIN");
        await closer.query(
          `SELECT pg_advisory_xact_lock(hashtext('counter-close'), hashtext($1))`,
          [counterCloseKeyOf(s.tenantId, "main")],
        );
        await closer.query("COMMIT");
      } finally {
        await closer.query("ROLLBACK").catch(() => undefined);
        await closer.end().catch(() => undefined);
      }
    }, 60_000);
  });
});
