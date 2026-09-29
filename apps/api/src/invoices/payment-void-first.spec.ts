/**
 * SA-404f / SA-404g (#2258 follow-up) — the void-FIRST half of the payment/void race, unit level.
 *   F1: recordStandalonePayment locks (Order →) Invoice UNCONDITIONALLY before it reads a status, and
 *       refuses VOID / WRITTEN_OFF on the locked row (400) before any payment or status write.
 *   N1: recordDeliveryPaymentInTx re-derives PAYABLE under each invoice's lock and SKIPS one voided
 *       meanwhile — the driver's cash moves to the next invoice or the advance (SA-404g), and money is
 *       conserved: Σ(new payment rows) + advance = collected.
 * Real two-connection proof (void commits between the writer's read and its lock): the DB lane.
 */
/**
 * B763 — unrounded advance writes. Both `excess` computations (recordStandalonePayment's
 * dto.totalAmount − allocatedTotal, recordDeliveryPaymentInTx's leftover `remaining`) could carry
 * raw floating-point residue into an AdvancePayment row instead of clean cents.
 *
 * Split out of invoices.service.spec.ts (not merged into it) per the repo's size ratchet
 * (`common/size-ratchet.spec.ts` — that file is already at its ceiling). Same bootstrap pattern
 * as the main spec file; duplicated deliberately rather than shared, so this file stays
 * self-contained and small.
 */

// Prevent Jest from traversing ESM-only dependencies
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));

jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
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
import { AfterCommit } from "../common/after-commit";

describe("SA-404f — payment writers lock before they read (void-first)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

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
  const mockMessaging = {
    notify: jest.fn().mockResolvedValue([]),
    notifyEvent: jest.fn().mockResolvedValue(undefined),
  };
  const mockCreditNotes = {
    autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
    settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
    releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
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
  const mockNumbering = { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") };

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
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
        entitlementAuthorityFromEntitlements, // #2241
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  /** A tx whose raw locks and invoice reads are logged in call order. */
  function loggedTx(log: string[]) {
    const models = prisma.forTenant() as any;
    const wrap = (name: string, fn: jest.Mock) =>
      jest.fn(async (...a: any[]) => {
        log.push(name);
        return fn(...a);
      });
    return {
      ...models,
      $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
        log.push(strings.join("?").includes('"Order"') ? "lock Order" : "lock Invoice");
      }),
      invoice: {
        ...models.invoice,
        findFirst: wrap("read invoice", models.invoice.findFirst),
        findMany: wrap("list invoices", models.invoice.findMany),
      },
    };
  }

  const standalone = (invoiceId = "inv-1") =>
    ({
      customerId: "cust-1",
      method: "CASH",
      totalAmount: 20,
      status: "PAID",
      allocations: [{ invoiceId, amount: 20 }],
    }) as any;

  beforeEach(() => {
    prisma.paymentCounter.upsert.mockResolvedValue({ id: "test-tenant", next: 1 } as any);
    prisma.invoicePayment.create.mockResolvedValue({ id: "pay-1" } as any);
    prisma.invoice.update.mockResolvedValue({} as any);
  });

  it("(F1) recordStandalonePayment takes the Invoice lock BEFORE it reads the invoice's status — on every path", async () => {
    const log: string[] = [];
    prisma.tenantTransaction.mockImplementation(async (fn: any) => fn(loggedTx(log)));
    prisma.invoice.findMany.mockResolvedValue([{ orderId: null }] as any);
    prisma.invoice.findFirst.mockResolvedValue({
      id: "inv-1",
      status: "SENT",
      total: 100,
      payments: [],
    } as any);
    await service.recordStandalonePayment(standalone()); // NO assertAllocationsWithinBalance
    expect(log.indexOf("lock Invoice")).toBeGreaterThan(-1);
    expect(log.indexOf("lock Invoice")).toBeLessThan(log.indexOf("read invoice"));
  });

  it("(F1) an invoice found VOID or WRITTEN_OFF under the lock is refused (400) with no payment row", async () => {
    for (const status of ["VOID", "WRITTEN_OFF"]) {
      prisma.invoicePayment.create.mockClear();
      prisma.tenantTransaction.mockImplementation(async (fn: any) => fn(loggedTx([])));
      prisma.invoice.findMany.mockResolvedValue([{ orderId: null }] as any);
      prisma.invoice.findFirst.mockResolvedValue({
        id: "inv-1",
        status,
        total: 100,
        payments: [],
      } as any);
      // The refusal's own message — a bare BadRequestException would also match the allocation
      // totals check and pass for the wrong reason.
      await expect(service.recordStandalonePayment(standalone())).rejects.toThrow(
        status === "VOID" ? /is voided/ : /is written-off/,
      );
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    }
  });

  describe("(N1) recordDeliveryPaymentInTx — SA-404g skip + conservation", () => {
    const inv = (id: string, total: number) => ({
      id,
      total,
      status: "SENT",
      dueDate: null,
      invoiceNumber: id.toUpperCase(),
      customerId: "cust-1",
    });
    beforeEach(() => {
      jest.spyOn(service, "findOpenOrderDraft").mockResolvedValue(null as any);
      jest.spyOn(service, "reconcileOrderDeliveredInvoices").mockResolvedValue(undefined as any);
      jest.spyOn(service, "createInvoiceFromOrder").mockResolvedValue([] as any);
      prisma.advancePayment.create.mockResolvedValue({ id: "adv-1" } as any);
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-a", customerId: "cust-1" } as any);
      prisma.invoicePayment.findMany.mockResolvedValue([]);
    });

    const booked = () => {
      const rows = prisma.invoicePayment.create.mock.calls.map((c: any[]) => c[0].data);
      const adv = prisma.advancePayment.create.mock.calls.map((c: any[]) =>
        Number(c[0].data.amount),
      );
      return {
        invoices: rows.map((r: any) => r.invoiceId),
        total:
          rows.reduce((s: number, r: any) => s + Number(r.amount), 0) +
          adv.reduce((s, a) => s + a, 0),
      };
    };

    it("an invoice VOIDED between the PAYABLE read and its lock is skipped — no payment on it, the cash moves on, nothing dropped", async () => {
      prisma.invoice.findMany.mockResolvedValue([inv("inv-a", 40), inv("inv-b", 30)] as any);
      // Under each invoice's lock: inv-a has been voided meanwhile; inv-b is still payable.
      prisma.invoice.findUnique.mockImplementation(
        async ({ where }: any) =>
          ({ id: where.id, status: where.id === "inv-a" ? "VOID" : "SENT" }) as any,
      );
      await service.recordDeliveryPaymentInTx(
        prisma as any,
        new AfterCommit(),
        ["ord-1"],
        100,
        "CASH",
      );
      const b = booked();
      expect(b.invoices).not.toContain("inv-a");
      expect(b.invoices).toContain("inv-b");
      expect(b.total).toBeCloseTo(100, 2); // Σ payments + advance = collected (SA-404g conservation)
    });

    it("control: nothing voided ⇒ spreads oldest-first as today, and conserves", async () => {
      prisma.invoice.findMany.mockResolvedValue([inv("inv-a", 40), inv("inv-b", 30)] as any);
      prisma.invoice.findUnique.mockImplementation(
        async ({ where }: any) => ({ id: where.id, status: "SENT" }) as any,
      );
      await service.recordDeliveryPaymentInTx(
        prisma as any,
        new AfterCommit(),
        ["ord-1"],
        100,
        "CASH",
      );
      const b = booked();
      expect(b.invoices).toEqual(["inv-a", "inv-b"]);
      expect(b.total).toBeCloseTo(100, 2);
    });
  });

  // #2472 — Opus follow-ups on #2469.
  describe("#2472 payment lock follow-ups", () => {
    const conflict = () => Object.assign(new Error("deadlock detected"), { code: "P2034" });

    it("(1) a 40P01/40001 on the standalone payment's first attempt is retried once — one payment", async () => {
      prisma.tenantTransaction
        .mockImplementationOnce(() => Promise.reject(conflict()))
        .mockImplementation(async (fn: any) => fn(loggedTx([])));
      prisma.invoice.findMany.mockResolvedValue([{ orderId: null }] as any);
      prisma.invoice.findFirst.mockResolvedValue({
        id: "inv-1",
        status: "SENT",
        total: 100,
        payments: [],
      } as any);
      await service.recordStandalonePayment(standalone());
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
    });

    it("(4) recordPayment refuses a WRITTEN_OFF invoice like the other payment writers — no payment", async () => {
      prisma.tenantTransaction.mockImplementation(async (fn: any) => fn(loggedTx([])));
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        status: "WRITTEN_OFF",
        total: 100,
        payments: [],
      } as any);
      await expect(
        service.recordPayment("inv-1", { amount: 20, method: "CASH" } as any),
      ).rejects.toThrow(/written-off/);
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });

    it("(4) control: recordPayment still refuses a VOID invoice with its existing message", async () => {
      prisma.tenantTransaction.mockImplementation(async (fn: any) => fn(loggedTx([])));
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        status: "VOID",
        total: 100,
        payments: [],
      } as any);
      await expect(
        service.recordPayment("inv-1", { amount: 20, method: "CASH" } as any),
      ).rejects.toThrow("Cannot record payment on voided invoice");
    });

    it("(3) nit: the invoice gone under the lock ⇒ 404, nothing written", async () => {
      prisma.tenantTransaction.mockImplementation(async (fn: any) => fn(loggedTx([])));
      prisma.invoice.findUnique
        .mockResolvedValueOnce({ id: "inv-1", status: "SENT", orderId: null } as any) // pre-read
        .mockResolvedValue(null); // under the lock
      await expect(service.writeOff("inv-1", { reason: "bad debt" } as any)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("(3) writeOff re-checks under the (Order →) Invoice lock: VOID since the pre-read ⇒ 400, nothing written", async () => {
      const log: string[] = [];
      prisma.tenantTransaction.mockImplementation(async (fn: any) => fn(loggedTx(log)));
      prisma.invoice.findUnique
        .mockResolvedValueOnce({ id: "inv-1", status: "SENT", orderId: "ord-1" } as any) // pre-read
        .mockResolvedValue({ id: "inv-1", status: "VOID", orderId: "ord-1", payments: [] } as any); // locked
      await expect(service.writeOff("inv-1", { reason: "bad debt" } as any)).rejects.toThrow(
        /Cannot write off an invoice with status VOID/,
      );
      expect(log.slice(0, 2)).toEqual(["lock Order", "lock Invoice"]);
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });
  });
});
