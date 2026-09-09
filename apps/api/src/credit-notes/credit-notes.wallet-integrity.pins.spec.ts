/**
 * F09 — credit notes and wallet integrity: the GREEN-PRE-FIX half of
 * `credit-notes.wallet-integrity.spec.ts`.
 *
 * Holds T3, T3b, T4, T7b, T8 (from
 * `.claude/pipeline/2026-09-01-f09-credit-notes-wallet/bug-test-plan.md`) —
 * EVERY test here is green today AND green after the fix, by design: they are
 * anti-regression pins against the WRONG fix, not requirement proofs. Nothing
 * red lives in this file, so no red test in the change sits outside the gate
 * command. Called out per test below:
 *
 * - **T3 (R3, REG-B67)** — the design-correction anti-regression: PAID must
 *   stay IN the settle set so the shrink pass can still un-apply now-excess
 *   credit on it. Nothing on today's tree excludes PAID from anything (no
 *   exclusion logic exists at all yet), so this already passes — it exists to
 *   catch the WRONG fix (reusing `applyToInvoice`'s `notApplicableStatuses`,
 *   which excludes PAID) as a regression once the real fix lands. Mutation
 *   probe: adding PAID to `CREDIT_SETTLE_EXCLUDED` must turn this red.
 * - **T3b (R3, REG-B67)** — same anti-regression for WRITTEN_OFF: the settle
 *   `where` deliberately keeps WRITTEN_OFF in scope (only the apply-side
 *   write is excluded) so the shrink pass still restores excess credit on a
 *   forgiven invoice. Already passing today for the same reason as T3.
 * - **T4 (R1, REG-B67)** — positive control: a SENT invoice with a balance
 *   still receives credit. Already passing (it's today's existing happy
 *   path); pins that T1/T2's new exclusion does not over-exclude live
 *   invoices.
 * - **T7b (R4, REG-B66)** — positive control: `create()` against a DRAFT
 *   source invoice still creates. DRAFT is deliberately OUTSIDE
 *   `CREDIT_SOURCE_EXCLUDED` (only VOID/WRITTEN_OFF are excluded) — this
 *   protects `returns.processRefund` and the UI's invoice picker, both of
 *   which mint credit notes against DRAFT invoices today. Already passing
 *   (there is no status read yet to disturb it).
 * - **T8 (R4, REG-B66)** — positive control + cap: `create()` against a live
 *   SENT invoice still creates normally, and the pre-existing over-credit cap
 *   (`existing + amount > total`) still throws. Already passing today (there
 *   is no status read yet to disturb it); pins that adding one doesn't.
 *
 * T11 and T12 USED to live here and no longer do — both are red today, so
 * both belong in the gate file. T12's home there is what the test-plan table
 * already says (File = `gate`); T11 moved with a discriminating positive half
 * added, because its lone negative assertion passed VACUOUSLY against a
 * `voidInvoiceInTx` that calls no `creditNote.*` method at all.
 *
 * This file is run by the ordinary `src/credit-notes` suite (before AND
 * after the fix, same as F07's precedent) — never by the red gate command
 * (`npx jest credit-notes.wallet-integrity.spec.ts`, which names only the
 * sibling file).
 *
 * Harness copied verbatim from the gate file.
 */

jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://files.example.test/invoice.pdf"),
  })),
}));

import { Test, TestingModule } from "@nestjs/testing";

import { CreditNotesService } from "./credit-notes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { NumberingService } from "../import/numbering.service";

// ─────────────────────────────────────────────────────────────────────────
// CreditNotesService — settleOrderCreditsInTx positive controls (R1/R3,
// REG-B67)
// ─────────────────────────────────────────────────────────────────────────

describe("CreditNotesService — settleOrderCreditsInTx positive controls (F09 pins)", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: {
            reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
            unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        // Harness: CreditNotesService injects NumberingService (B267/B269);
        // these suites never exercise a mint, so the mock only satisfies DI.
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("CN-2026-0001") },
        },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
  });

  it("T3 (R3, REG-B67): a PAID invoice whose total shrank below its payments still runs the shrink pass and restores the excess to its credit note", async () => {
    prisma.orderCreditNote.findMany.mockResolvedValueOnce([]); // no apply-phase intents needed
    prisma.invoice.findMany.mockResolvedValueOnce([
      {
        id: "inv-paid-shrink",
        invoiceNumber: "INV-PAID-1",
        total: 60, // shrunk from 100
        dueDate: null,
        status: "PAID", // the design-correction case: PAID must still shrink
        payments: [
          {
            id: "pay-cash-p",
            amount: 40,
            status: "PAID",
            method: "CASH",
            creditNoteId: null,
            createdAt: new Date("2026-01-01"),
          },
          {
            id: "pay-credit-p",
            amount: 60,
            status: "PAID",
            method: "CREDIT_NOTE",
            creditNoteId: "cn-paid-shrink",
            createdAt: new Date("2026-01-02"),
          },
        ],
      },
    ]);
    prisma.creditNote.findUnique.mockResolvedValueOnce({
      id: "cn-paid-shrink",
      amount: 100,
      amountUsed: 60,
      status: "ISSUED",
      appliedToInvoiceId: null,
    });
    prisma.invoice.findUnique.mockResolvedValueOnce({
      id: "inv-paid-shrink",
      total: 60,
      dueDate: null,
      status: "PAID",
      payments: [
        { amount: 40, status: "PAID" },
        { amount: 20, status: "PAID" },
      ],
    });

    const result = await service.settleOrderCreditsInTx(prisma as any, "order-paid-shrink");

    expect(result.unapplied).toBe(40);
    expect(prisma.invoicePayment.update).toHaveBeenCalledWith({
      where: { id: "pay-credit-p" },
      data: { amount: 20 },
    });
    expect(prisma.invoicePayment.delete).not.toHaveBeenCalled();
    const cnUpdate = prisma.creditNote.update.mock.calls[0][0];
    expect(cnUpdate.data.amountUsed).toBe(20);
  });

  it("T3b (R3, REG-B67): a WRITTEN_OFF invoice carrying excess applied credit still runs the shrink pass and restores the excess to its credit note", async () => {
    prisma.orderCreditNote.findMany.mockResolvedValueOnce([]); // no apply-phase intents needed
    prisma.invoice.findMany.mockResolvedValueOnce([
      {
        id: "inv-wo-shrink",
        invoiceNumber: "INV-WO-SHRINK-1",
        total: 60, // shrunk from 100
        dueDate: null,
        status: "WRITTEN_OFF", // proves the guard didn't remove WRITTEN_OFF from the shrink set
        payments: [
          {
            id: "pay-cash-wo",
            amount: 40,
            status: "PAID",
            method: "CASH",
            creditNoteId: null,
            createdAt: new Date("2026-01-01"),
          },
          {
            id: "pay-credit-wo",
            amount: 60,
            status: "PAID",
            method: "CREDIT_NOTE",
            creditNoteId: "cn-wo-shrink",
            createdAt: new Date("2026-01-02"),
          },
        ],
      },
    ]);
    prisma.creditNote.findUnique.mockResolvedValueOnce({
      id: "cn-wo-shrink",
      amount: 100,
      amountUsed: 60,
      status: "ISSUED",
      appliedToInvoiceId: null,
    });
    prisma.invoice.findUnique.mockResolvedValueOnce({
      id: "inv-wo-shrink",
      total: 60,
      dueDate: null,
      status: "WRITTEN_OFF",
      payments: [
        { amount: 40, status: "PAID" },
        { amount: 20, status: "PAID" },
      ],
    });

    const result = await service.settleOrderCreditsInTx(prisma as any, "order-wo-shrink");

    expect(result.unapplied).toBe(40);
    expect(prisma.invoicePayment.update).toHaveBeenCalledWith({
      where: { id: "pay-credit-wo" },
      data: { amount: 20 },
    });
    expect(prisma.invoicePayment.delete).not.toHaveBeenCalled();
    const cnUpdate = prisma.creditNote.update.mock.calls[0][0];
    expect(cnUpdate.data.amountUsed).toBe(20);
  });

  it("T4 (R1, REG-B67): a SENT invoice with a balance still receives credit — the new exclusion must not over-exclude live invoices", async () => {
    prisma.orderCreditNote.findMany.mockResolvedValueOnce([
      {
        id: "ocn-sent-1",
        orderId: "order-sent-pc",
        creditNoteId: "cn-sent-pc",
        amount: null,
        createdAt: new Date("2026-01-01"),
        creditNote: {
          id: "cn-sent-pc",
          amount: 40,
          amountUsed: 0,
          status: "ISSUED",
          expiresAt: null,
        },
      },
    ]);
    prisma.invoice.findMany.mockResolvedValueOnce([
      {
        id: "inv-sent-pc",
        invoiceNumber: "INV-SENT-PC",
        total: 100,
        dueDate: null,
        status: "SENT",
        payments: [],
      },
    ]);
    prisma.creditNote.findUnique.mockResolvedValueOnce({
      id: "cn-sent-pc",
      amount: 40,
      amountUsed: 0,
      status: "ISSUED",
      appliedToInvoiceId: null,
      appliedAt: null,
      autoApplied: false,
    });
    prisma.invoice.findUnique.mockResolvedValueOnce({
      id: "inv-sent-pc",
      total: 100,
      dueDate: null,
      status: "SENT",
      payments: [],
    });

    const result = await service.settleOrderCreditsInTx(prisma as any, "order-sent-pc");

    expect(result.applied).toBe(40);
    expect(prisma.invoicePayment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          invoiceId: "inv-sent-pc",
          amount: 40,
          creditNoteId: "cn-sent-pc",
        }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CreditNotesService — create() unaffected for a live source invoice
// (R4, REG-B66)
// ─────────────────────────────────────────────────────────────────────────

describe("CreditNotesService — create() unaffected for a live SENT source invoice (F09 pins)", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: {
            reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
            unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        // Harness: CreditNotesService injects NumberingService (B267/B269);
        // these suites never exercise a mint, so the mock only satisfies DI.
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("CN-2026-0001") },
        },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
    prisma.creditNote.findFirst.mockResolvedValue(null); // nextCnNumber → CN-…-0001
    // REG-B267-E: create() now reads the customer through the tenant-scoped
    // `forTenant().customer.findFirst` BEFORE reserving a number, so every
    // create-path test needs an in-tenant customer to get past that gate.
    prisma.customer.findFirst.mockResolvedValue({ id: "c1", businessName: "Acme Retail" });
    prisma.creditNote.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "cn-live-1", ...args.data, customer: {} }),
    );
  });

  it("T8 (R4, REG-B66): creates exactly as before against a live SENT invoice", async () => {
    // B267: create() validates TWICE — once standalone before the number is
    // reserved, once again on the tx client — so this stub must answer both reads.
    prisma.invoice.findFirst.mockResolvedValue({
      total: 100,
      customerId: "c1",
      items: [],
      status: "SENT",
    });
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });

    await service.create({ customerId: "c1", invoiceId: "inv-sent-live", amount: 30 });

    expect(prisma.creditNote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerId: "c1",
          invoiceId: "inv-sent-live",
          amount: 30,
          status: "ISSUED",
        }),
      }),
    );
  });

  it("T8 (R4, REG-B66): the existing over-credit cap still throws on a SENT invoice — pins that the new status read doesn't disturb it", async () => {
    prisma.invoice.findFirst.mockResolvedValueOnce({
      total: 100,
      customerId: "c1",
      items: [],
      status: "SENT",
    });
    prisma.creditNote.aggregate.mockResolvedValueOnce({ _sum: { amount: 80 } }); // 80 already credited

    await expect(
      service.create({ customerId: "c1", invoiceId: "inv-sent-cap", amount: 30 }),
    ).rejects.toThrow(/exceed invoice total/);
    expect(prisma.creditNote.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CreditNotesService — create() unaffected for a DRAFT source invoice
// (R4, REG-B66) — DRAFT is deliberately OUTSIDE CREDIT_SOURCE_EXCLUDED
// (protects returns.processRefund and the UI picker)
// ─────────────────────────────────────────────────────────────────────────

describe("CreditNotesService — create() unaffected for a DRAFT source invoice (F09 pins)", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: {
            reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
            unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        // Harness: CreditNotesService injects NumberingService (B267/B269);
        // these suites never exercise a mint, so the mock only satisfies DI.
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("CN-2026-0001") },
        },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
    prisma.creditNote.findFirst.mockResolvedValue(null); // nextCnNumber → CN-…-0001
    // REG-B267-E: create() now reads the customer through the tenant-scoped
    // `forTenant().customer.findFirst` BEFORE reserving a number, so every
    // create-path test needs an in-tenant customer to get past that gate.
    prisma.customer.findFirst.mockResolvedValue({ id: "c1", businessName: "Acme Retail" });
    prisma.creditNote.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "cn-draft-1", ...args.data, customer: {} }),
    );
  });

  it("T7b (R4, REG-B66): create({ invoiceId }) against a DRAFT invoice still creates — DRAFT stays out of CREDIT_SOURCE_EXCLUDED", async () => {
    // B267: create() validates TWICE — once standalone before the number is
    // reserved, once again on the tx client — so this stub must answer both reads.
    prisma.invoice.findFirst.mockResolvedValue({
      total: 100,
      customerId: "c1",
      items: [],
      status: "DRAFT",
    });
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });

    await service.create({ customerId: "c1", invoiceId: "inv-draft-live", amount: 30 });

    expect(prisma.creditNote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerId: "c1",
          invoiceId: "inv-draft-live",
          amount: 30,
          status: "ISSUED",
        }),
      }),
    );
  });
});
