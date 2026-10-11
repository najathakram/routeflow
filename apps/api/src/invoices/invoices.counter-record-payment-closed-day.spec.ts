/**
 * SA-750r3 (amended) — a payment recorded through the OFFICE door can no longer silently change a closed Z report.
 *
 * recordPayment on a COUNTER invoice takes the SHARED counter-close lock as its first statement and refuses 409
 * DAY_CLOSED_FOR_PAYMENT_DATE (with `closedThrough`) a till-CASH payment dated before the latest STANDING close's cutoff.
 * Every other method keeps its true paidAt; a non-counter invoice is unchanged. The counter tender and the pickup tender
 * already hold the shared lock on their pinned connection, so they pass `{ tillLockHeld: TILL_LOCK_HELD }`: no second lock
 * request (it would queue behind a waiting EXCLUSIVE close); the closed-date check still runs.
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { Test, TestingModule } from "@nestjs/testing";
import { InvoiceStatus } from "@prisma/client";
import { InvoicesService } from "./invoices.service";
import { TILL_LOCK_HELD } from "./counter-payment-guard";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { NumberingService } from "../import/numbering.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

const CUTOFF = new Date("2026-10-09T05:00:00Z"); // the latest standing close's windowEnd
const EARLIER_CUTOFF = new Date("2026-10-08T05:00:00Z");
const BEFORE = "2026-10-08T17:30:00Z"; // inside the closed day
const AFTER = "2026-10-09T09:00:00Z"; // after the cutoff

type Close = { registerKey: string; reopenedAt: Date | null; windowEnd: Date };

describe("InvoicesService.recordPayment — counter invoice and the day close (SA-750r3)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let closes: Close[];

  beforeEach(async () => {
    prisma = createMockPrisma();
    closes = [{ registerKey: "main", reopenedAt: null, windowEnd: CUTOFF }];
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        { provide: EmailService, useValue: {} },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: AuthorizationGuardService, useValue: {} },
        {
          provide: CreditNotesService,
          useValue: { autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0 }) },
        },
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        { provide: StorageService, useValue: {} },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(InvoicesService);
    prisma.tenantTransaction.mockImplementation((fn: any) => fn(prisma));
    prisma.paymentCounter.upsert.mockResolvedValue({ id: "test-tenant", next: 2 });
    prisma.invoicePayment.create.mockResolvedValue({ id: "pay-new" });
    prisma.invoice.findUnique.mockResolvedValue({
      id: "inv-1",
      status: InvoiceStatus.SENT,
      total: 100,
      dueDate: null,
      orderId: "ord-1",
      payments: [],
    });
    prisma.invoice.update.mockResolvedValue({
      id: "inv-1",
      invoiceNumber: "INV-1",
      customerId: "c1",
      total: 100,
      payments: [],
    });
    // The LATEST STANDING close of the register: reopened ones do not count.
    prisma.counterDayClose.findFirst.mockImplementation(async ({ where }: any) => {
      const standing = closes
        .filter((c) => c.registerKey === where.registerKey && c.reopenedAt == null)
        .sort((a, b) => b.windowEnd.getTime() - a.windowEnd.getTime());
      return standing[0] ? { windowEnd: standing[0].windowEnd } : null;
    });
    counterOrder();
  });

  function counterOrder(registerKey: string | null = null) {
    prisma.order.findFirst.mockResolvedValue({ counterSale: true, registerKey });
  }
  const pay = (over: Record<string, unknown> = {}) => ({
    amount: 30,
    method: "CASH",
    paidAt: BEFORE,
    ...over,
  });
  const sqlOf = (call: unknown[]) => (call[0] as unknown as string[]).join("?");
  const lockSql = () => prisma.$executeRaw.mock.calls.map(sqlOf);
  const written = () => (prisma.invoicePayment.create.mock.calls[0][0] as any).data;

  describe("a backdated CASH payment on a COUNTER invoice", () => {
    it("is refused 409 DAY_CLOSED_FOR_PAYMENT_DATE with closedThrough, and nothing is written", async () => {
      const err: any = await service.recordPayment("inv-1", pay() as any).catch((e: unknown) => e);
      expect(err.getStatus?.()).toBe(409);
      expect(err.getResponse()).toEqual({
        code: "DAY_CLOSED_FOR_PAYMENT_DATE",
        message: "That day is closed. Record it with today's date.",
        closedThrough: CUTOFF.toISOString(),
      });
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
      expect(prisma.paymentCounter.upsert).not.toHaveBeenCalled();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("takes the SHARED close lock for the order's register as the FIRST statement, before the Invoice FOR UPDATE", async () => {
      await service.recordPayment("inv-1", pay({ paidAt: AFTER }) as any);
      const sql = lockSql();
      expect(sql[0]).toContain("pg_advisory_xact_lock_shared(hashtext('counter-close')");
      expect(prisma.$executeRaw.mock.calls[0][1]).toBe("test-tenant:main");
      expect(sql[1]).toContain('"Invoice"');
      expect(sql[1]).toContain("FOR UPDATE");
    });

    it("dated AFTER the latest cutoff is accepted", async () => {
      await service.recordPayment("inv-1", pay({ paidAt: AFTER }) as any);
      expect(written().paidAt).toEqual(new Date(AFTER));
    });

    it("dated exactly AT the cutoff is accepted (the window is [start, end): the cutoff belongs to the next day)", async () => {
      await service.recordPayment("inv-1", pay({ paidAt: CUTOFF.toISOString() }) as any);
      expect(prisma.invoicePayment.create).toHaveBeenCalled();
    });

    it("with no paidAt, after a close: accepted (it is dated now)", async () => {
      await service.recordPayment("inv-1", pay({ paidAt: undefined }) as any);
      expect(written().paidAt).toBeInstanceOf(Date);
      expect(written().paidAt.getTime()).toBeGreaterThan(CUTOFF.getTime());
    });

    it("with no paidAt, the instant is the DATABASE clock under the lock (a skewed app clock cannot back-date into the close)", async () => {
      const dbNow = new Date(AFTER);
      prisma.$queryRaw.mockResolvedValue([{ now: dbNow }]);
      jest.useFakeTimers({
        now: new Date(BEFORE), // the app clock lags the cutoff
        doNotFake: [
          "nextTick",
          "setImmediate",
          "clearImmediate",
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
          "hrtime",
          "performance",
          "queueMicrotask",
        ],
      });
      try {
        await service.recordPayment("inv-1", pay({ paidAt: undefined }) as any);
      } finally {
        jest.useRealTimers();
      }
      expect(written().paidAt).toEqual(dbNow);
    });

    it("judges against the latest STANDING close only: a reopened later close is ignored", async () => {
      closes = [
        { registerKey: "main", reopenedAt: null, windowEnd: EARLIER_CUTOFF },
        { registerKey: "main", reopenedAt: new Date("2026-10-09T08:00:00Z"), windowEnd: CUTOFF },
      ];
      // after the earlier cutoff, inside the reopened (open again) window: accepted
      await service.recordPayment("inv-1", pay({ paidAt: "2026-10-08T12:00:00Z" }) as any);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
      // before the earlier (standing) cutoff: refused, closedThrough is THAT cutoff
      const err: any = await service
        .recordPayment("inv-1", pay({ paidAt: "2026-10-07T12:00:00Z" }) as any)
        .catch((e: unknown) => e);
      expect(err.getResponse()).toMatchObject({
        code: "DAY_CLOSED_FOR_PAYMENT_DATE",
        closedThrough: EARLIER_CUTOFF.toISOString(),
      });
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
    });

    it("with no close at all: accepted", async () => {
      closes = [];
      await service.recordPayment("inv-1", pay() as any);
      expect(written().paidAt).toEqual(new Date(BEFORE));
    });

    it("a closed window of ANOTHER register does not matter", async () => {
      counterOrder("b");
      await service.recordPayment("inv-1", pay() as any);
      expect(prisma.$executeRaw.mock.calls[0][1]).toBe("test-tenant:b");
      expect(prisma.invoicePayment.create).toHaveBeenCalled();
    });
  });

  describe("methods that move no close total keep their TRUE paidAt on a counter invoice", () => {
    it.each(["CHECK", "CREDIT_CARD", "ACH", "ZELLE"])("a backdated %s is accepted", async (m) => {
      await service.recordPayment("inv-1", pay({ method: m }) as any);
      expect(written().paidAt).toEqual(new Date(BEFORE));
      expect(written().method).toBe(m);
    });

    it("a backdated CASH that is a DRAFT (not PAID) is accepted", async () => {
      await service.recordPayment("inv-1", pay({ status: "DRAFT" }) as any);
      expect(written().paidAt).toEqual(new Date(BEFORE));
    });
  });

  describe("the payment's REAL group id decides whether it is till cash (isTillCashRow)", () => {
    it("a backdated CASH row recorded WITH a foreign payment group is not till cash: it keeps its true date", async () => {
      await service.recordPayment("inv-1", pay() as any, {
        paymentGroupId: "5b0f4a6e-2b0a-4c53-9a54-6f1c8d1f2a11",
      });
      expect(written().paidAt).toEqual(new Date(BEFORE));
      expect(written().paymentGroupId).toBe("5b0f4a6e-2b0a-4c53-9a54-6f1c8d1f2a11");
    });

    it("the same row UNGROUPED is till cash and is refused", async () => {
      await expect(service.recordPayment("inv-1", pay() as any, {})).rejects.toMatchObject({
        response: { code: "DAY_CLOSED_FOR_PAYMENT_DATE" },
      });
    });
  });

  describe("a NON-counter invoice is unchanged", () => {
    it("backdated CASH: no close-lock statement, no close read, written with its date", async () => {
      prisma.order.findFirst.mockResolvedValue({ counterSale: false, registerKey: null });
      await service.recordPayment("inv-1", pay() as any);
      expect(lockSql()).toHaveLength(1); // the Invoice FOR UPDATE alone
      expect(lockSql()[0]).toContain("FOR UPDATE");
      expect(prisma.counterDayClose.findFirst).not.toHaveBeenCalled();
      expect(written().paidAt).toEqual(new Date(BEFORE));
    });

    it("an invoice with no order behaves as today too", async () => {
      prisma.order.findFirst.mockResolvedValue(null);
      await service.recordPayment("inv-1", pay() as any);
      expect(lockSql()).toHaveLength(1);
      expect(prisma.counterDayClose.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("TILL_LOCK_HELD (the counter tender and the pickup tender)", () => {
    it("issues NO lock statement but still reads the scope and the close", async () => {
      await service.recordPayment("inv-1", pay({ paidAt: AFTER }) as any, {
        tillLockHeld: TILL_LOCK_HELD,
      });
      expect(lockSql()).toHaveLength(1); // the Invoice FOR UPDATE alone
      expect(lockSql()[0]).toContain("FOR UPDATE");
      expect(prisma.order.findFirst).toHaveBeenCalled();
      expect(prisma.counterDayClose.findFirst).toHaveBeenCalled();
    });

    it("still refuses 409 DAY_CLOSED_FOR_PAYMENT_DATE for a CASH payment dated before the latest standing close", async () => {
      const err: any = await service
        .recordPayment("inv-1", pay() as any, { tillLockHeld: TILL_LOCK_HELD })
        .catch((e: unknown) => e);
      expect(err.getStatus?.()).toBe(409);
      expect(err.getResponse()).toEqual({
        code: "DAY_CLOSED_FOR_PAYMENT_DATE",
        message: "That day is closed. Record it with today's date.",
        closedThrough: CUTOFF.toISOString(),
      });
      expect(lockSql().some((q) => q.includes("pg_advisory_xact_lock_shared"))).toBe(false);
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });

    it("the counter tender (paidAt = the DB clock stamped after the lock) still passes", async () => {
      await service.recordPayment("inv-1", pay({ paidAt: AFTER }) as any, {
        tillLockHeld: TILL_LOCK_HELD,
      });
      expect(written().paidAt).toEqual(new Date(AFTER));
    });

    it("without it (opts omitted), the shared lock is the first statement", async () => {
      await service.recordPayment("inv-1", pay({ paidAt: AFTER }) as any, {});
      expect(lockSql()[0]).toContain("pg_advisory_xact_lock_shared");
    });
  });
});
