/**
 * SA-750r3 / SA-762r F7 — the four payment-edit paths on a COUNTER sale join the end-of-day close:
 * voidPayment, deletePayment, updatePayment and setCheckStatus(BOUNCED) take the SHARED counter-close lock as the first
 * statement of their transaction (before the Invoice FOR UPDATE) and refuse 409 COUNTER_SALE_DAY_CLOSED when the payment's
 * paidAt (for an edit, the old AND the new date) falls inside a closed window of the order's register. A non-counter invoice
 * is unchanged: no lock statement, no window read.
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

const WINDOW = { start: new Date("2026-10-08T05:00:00Z"), end: new Date("2026-10-09T05:00:00Z") };
const INSIDE = new Date("2026-10-08T17:30:00Z");
const AFTER = new Date("2026-10-09T09:00:00Z");

type Close = { registerKey: string; reopenedAt: Date | null; windowStart: Date; windowEnd: Date };

describe("InvoicesService — payment edits on a counter sale and the day close (SA-750r3)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let closes: Close[];

  beforeEach(async () => {
    prisma = createMockPrisma();
    closes = [
      { registerKey: "main", reopenedAt: null, windowStart: WINDOW.start, windowEnd: WINDOW.end },
    ];
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
        { provide: StorageService, useValue: { delete: jest.fn() } },
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
    // The tx client is the prisma mock itself (as the sibling specs do).
    prisma.tenantTransaction.mockImplementation((fn: any) => fn(prisma));
    // The fake close table: the row `counterWindowClosed` asks for (in force, covering `at`, same register).
    prisma.counterDayClose.findFirst.mockImplementation(async ({ where }: any) => {
      if (!where.windowStart) {
        // assertDatedOk: the latest STANDING close of the register (its windowEnd is the cutoff)
        const standing = closes
          .filter((c) => c.registerKey === where.registerKey && c.reopenedAt == null)
          .sort((a, b) => b.windowEnd.getTime() - a.windowEnd.getTime());
        return standing[0] ? { windowEnd: standing[0].windowEnd } : null;
      }
      const at: Date = where.windowStart.lte;
      return (
        closes.find(
          (c) =>
            c.registerKey === where.registerKey &&
            (where.reopenedAt === null ? c.reopenedAt == null : true) &&
            c.windowStart <= at &&
            c.windowEnd > at,
        ) ?? null
      );
    });
  });

  const counterOrder = (registerKey: string | null = null) =>
    prisma.order.findFirst.mockResolvedValue({ counterSale: true, registerKey });
  const payRow = (over: any = {}) => ({
    id: "pay-1",
    amount: 30,
    status: "PAID",
    method: "CASH",
    imageKey: null,
    paidAt: INSIDE,
    ...over,
  });
  const invoiceRow = (payments: any[]) => ({
    id: "inv-1",
    invoiceNumber: "INV-1",
    customerId: "c1",
    status: InvoiceStatus.PARTIAL,
    total: 100,
    subtotal: 100,
    dueDate: null,
    paidAt: null,
    orderId: "ord-1",
    payments,
    order: { routeRunId: null, routeRunStopId: null },
  });

  /** One arranged call per path, with the payment dated `paidAt`. */
  const paths: Array<{
    name: string;
    arrange: (paidAt: Date) => void;
    act: (dto?: any) => Promise<unknown>;
    writes: () => jest.Mock[];
  }> = [
    {
      name: "voidPayment",
      arrange: (paidAt) => {
        prisma.invoicePayment.findFirst.mockResolvedValue(payRow({ paidAt }));
        prisma.invoicePayment.update.mockResolvedValue({});
        prisma.invoice.findUnique.mockResolvedValue(invoiceRow([payRow({ paidAt })]));
        prisma.invoice.update.mockResolvedValue({});
      },
      act: () => service.voidPayment("inv-1", "pay-1"),
      writes: () => [prisma.invoicePayment.update, prisma.invoice.update],
    },
    {
      name: "deletePayment",
      arrange: (paidAt) => {
        prisma.invoice.findUnique.mockResolvedValue(invoiceRow([payRow({ paidAt })]));
        prisma.invoicePayment.delete.mockResolvedValue({});
        prisma.invoice.update.mockResolvedValue(invoiceRow([]));
      },
      act: () => service.deletePayment("inv-1", "pay-1"),
      writes: () => [prisma.invoicePayment.delete, prisma.invoice.update],
    },
    {
      name: "updatePayment (amount)",
      arrange: (paidAt) => {
        prisma.invoice.findUnique.mockResolvedValue(invoiceRow([payRow({ paidAt })]));
        prisma.invoicePayment.update.mockResolvedValue({});
        prisma.invoice.update.mockResolvedValue(invoiceRow([]));
      },
      act: () => service.updatePayment("inv-1", "pay-1", { amount: 40, method: "CASH" } as any),
      writes: () => [prisma.invoicePayment.update, prisma.invoice.update],
    },
    {
      name: "setCheckStatus(BOUNCED)",
      arrange: (paidAt) => {
        prisma.invoicePayment.findFirst.mockResolvedValue(
          payRow({ paidAt, method: "CHECK", checkStatus: "DEPOSITED" }),
        );
        prisma.invoicePayment.updateMany.mockResolvedValue({ count: 1 });
        prisma.invoice.findUnique.mockResolvedValue(
          invoiceRow([payRow({ paidAt, method: "CHECK" })]),
        );
        prisma.invoiceItem.create.mockResolvedValue({});
        prisma.invoice.update.mockResolvedValue({});
      },
      act: () =>
        service.setCheckStatus("inv-1", "pay-1", { status: "BOUNCED", nsfFeeAmount: 25 } as any),
      writes: () => [
        prisma.invoicePayment.updateMany,
        prisma.invoiceItem.create,
        prisma.invoice.update,
      ],
    },
  ];

  const sqlOf = (call: unknown[]) => (call[0] as unknown as string[]).join("?");
  const lockSql = () => prisma.$executeRaw.mock.calls.map(sqlOf);

  describe.each(paths)("$name on a COUNTER sale", (p) => {
    it("dated inside a closed window: 409 COUNTER_SALE_DAY_CLOSED and the stored payment/totals are untouched", async () => {
      counterOrder();
      p.arrange(INSIDE);
      const err: any = await p.act().catch((e: unknown) => e);
      expect(err.getStatus?.()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: "COUNTER_SALE_DAY_CLOSED" });
      for (const w of p.writes()) expect(w).not.toHaveBeenCalled();
    });

    it("takes the SHARED close lock for the order's register BEFORE the Invoice FOR UPDATE", async () => {
      counterOrder();
      p.arrange(AFTER);
      await p.act();
      const sql = lockSql();
      expect(sql[0]).toContain("pg_advisory_xact_lock_shared(hashtext('counter-close')");
      expect(prisma.$executeRaw.mock.calls[0][1]).toBe("test-tenant:main");
      expect(sql[1]).toContain('"Invoice"');
      expect(sql[1]).toContain("FOR UPDATE");
    });

    it("dated after the window: allowed", async () => {
      counterOrder();
      p.arrange(AFTER);
      await p.act();
      for (const w of p.writes()) expect(w).toHaveBeenCalled();
    });

    it("inside a window whose close was REOPENED: allowed", async () => {
      counterOrder();
      closes[0].reopenedAt = new Date("2026-10-09T08:00:00Z");
      p.arrange(INSIDE);
      await p.act();
      for (const w of p.writes()) expect(w).toHaveBeenCalled();
    });

    it("a closed window of ANOTHER register does not matter", async () => {
      counterOrder("b");
      p.arrange(INSIDE);
      await p.act();
      expect(prisma.$executeRaw.mock.calls[0][1]).toBe("test-tenant:b");
      for (const w of p.writes()) expect(w).toHaveBeenCalled();
    });

    it("a NON-counter invoice behaves as today: no lock statement, no window read, even in a window", async () => {
      prisma.order.findFirst.mockResolvedValue({ counterSale: false, registerKey: null });
      p.arrange(INSIDE);
      await p.act();
      expect(lockSql()).toHaveLength(1); // the Invoice FOR UPDATE alone
      expect(lockSql()[0]).toContain("FOR UPDATE");
      expect(prisma.counterDayClose.findFirst).not.toHaveBeenCalled();
      for (const w of p.writes()) expect(w).toHaveBeenCalled();
    });

    it("an invoice with no order behaves as today too", async () => {
      prisma.order.findFirst.mockResolvedValue(null);
      p.arrange(INSIDE);
      await p.act();
      expect(lockSql()).toHaveLength(1);
      expect(prisma.counterDayClose.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("updatePayment changing paidAt checks BOTH the old and the new date", () => {
    const edit = (paidAt: string) =>
      service.updatePayment("inv-1", "pay-1", { amount: 30, method: "CASH", paidAt } as any);

    it("moving an OPEN-dated payment INTO a closed window is refused", async () => {
      counterOrder();
      paths[2].arrange(AFTER);
      await expect(edit(INSIDE.toISOString())).rejects.toMatchObject({
        response: { code: "COUNTER_SALE_DAY_CLOSED" },
      });
      expect(prisma.invoicePayment.update).not.toHaveBeenCalled();
    });

    it("moving a payment OUT of a closed window is refused (the closed day's totals would shrink)", async () => {
      counterOrder();
      paths[2].arrange(INSIDE);
      await expect(edit(AFTER.toISOString())).rejects.toMatchObject({
        response: { code: "COUNTER_SALE_DAY_CLOSED" },
      });
      expect(prisma.invoicePayment.update).not.toHaveBeenCalled();
    });

    it("moving between two open instants is allowed", async () => {
      counterOrder();
      paths[2].arrange(AFTER);
      await edit("2026-10-10T09:00:00Z");
      expect(prisma.invoicePayment.update).toHaveBeenCalled();
    });
  });

  describe("updatePayment turning a payment into a till-CASH row dated before the latest standing close", () => {
    const ANCIENT = new Date("2026-10-01T12:00:00Z"); // before the first closed window: assertOpen has nothing to say
    const editTo = (dto: Record<string, unknown>) =>
      service.updatePayment("inv-1", "pay-1", { amount: 30, method: "CASH", ...dto } as any);
    const stored = (over: Record<string, unknown>) => {
      paths[2].arrange(AFTER);
      prisma.invoice.findUnique.mockResolvedValue(
        invoiceRow([payRow({ paidAt: ANCIENT, ...over })]),
      );
    };
    const refusal = {
      response: {
        code: "DAY_CLOSED_FOR_PAYMENT_DATE",
        message: "That day is closed. Record it with today's date.",
        closedThrough: WINDOW.end.toISOString(),
      },
    };

    it("moving a CASH payment's paidAt earlier than the cutoff is refused 409 DAY_CLOSED_FOR_PAYMENT_DATE", async () => {
      counterOrder();
      paths[2].arrange(AFTER);
      await expect(editTo({ paidAt: ANCIENT.toISOString() })).rejects.toMatchObject(refusal);
      expect(prisma.invoicePayment.update).not.toHaveBeenCalled();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("changing a CHECK dated before the cutoff to CASH is refused", async () => {
      counterOrder();
      stored({ method: "CHECK" });
      await expect(editTo({})).rejects.toMatchObject(refusal);
      expect(prisma.invoicePayment.update).not.toHaveBeenCalled();
    });

    it("changing that CHECK to a card (moves no close total) is allowed", async () => {
      counterOrder();
      stored({ method: "CHECK" });
      await editTo({ method: "CREDIT_CARD" });
      expect(prisma.invoicePayment.update).toHaveBeenCalled();
    });

    it("an amount edit of a CASH row that already was till cash and keeps its date is not judged here", async () => {
      counterOrder();
      stored({});
      await editTo({ amount: 25 });
      expect(prisma.invoicePayment.update).toHaveBeenCalled();
    });

    it("moving a CASH payment to a date after the cutoff is allowed", async () => {
      counterOrder();
      paths[2].arrange(AFTER);
      await editTo({ paidAt: "2026-10-10T09:00:00Z" });
      expect(prisma.invoicePayment.update).toHaveBeenCalled();
    });

    it("with the latest close REOPENED there is no standing cutoff: allowed", async () => {
      counterOrder();
      closes[0].reopenedAt = new Date();
      paths[2].arrange(AFTER);
      await editTo({ paidAt: ANCIENT.toISOString() });
      expect(prisma.invoicePayment.update).toHaveBeenCalled();
    });

    it("a stored CASH row that carries a foreign payment group is not till cash: moving it earlier is allowed", async () => {
      counterOrder();
      stored({ paymentGroupId: "5b0f4a6e-2b0a-4c53-9a54-6f1c8d1f2a11" });
      await editTo({ paidAt: ANCIENT.toISOString() });
      expect(prisma.invoicePayment.update).toHaveBeenCalled();
    });

    it("the same stored CASH row UNGROUPED is till cash: moving it earlier is refused", async () => {
      counterOrder();
      stored({ paymentGroupId: null });
      await expect(editTo({ paidAt: ANCIENT.toISOString() })).rejects.toMatchObject(refusal);
    });

    it("a NON-counter invoice behaves as today: no close read", async () => {
      prisma.order.findFirst.mockResolvedValue(null);
      paths[2].arrange(AFTER);
      await editTo({ paidAt: ANCIENT.toISOString() });
      expect(prisma.invoicePayment.update).toHaveBeenCalled();
      expect(prisma.counterDayClose.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("setCheckStatus other than BOUNCED is unchanged", () => {
    it("DEPOSITED on a counter payment inside a closed window: no lock, no order read, allowed", async () => {
      counterOrder();
      prisma.invoicePayment.findFirst.mockResolvedValue(
        payRow({ method: "CHECK", checkStatus: "RECORDED" }),
      );
      prisma.invoicePayment.update.mockResolvedValue({});
      prisma.invoice.findFirst.mockResolvedValue(invoiceRow([]));
      await service.setCheckStatus("inv-1", "pay-1", { status: "DEPOSITED" } as any);
      expect(prisma.order.findFirst).not.toHaveBeenCalled();
      expect(lockSql()).toHaveLength(1);
      expect(prisma.invoicePayment.update).toHaveBeenCalled();
    });
  });
});
