/**
 * F09 — credit notes and wallet integrity: the GREEN-PRE-FIX half of
 * `credit-notes.wallet-integrity.spec.ts`.
 *
 * Holds T3, T4, T8, T11 (from
 * `.claude/pipeline/2026-09-01-f09-credit-notes-wallet/test-plan.md`) plus
 * T12 — kept OUT of the red gate file for two different reasons, called out
 * per test below:
 *
 * - **T3 (R3, REG-B67)** — the design-correction anti-regression: PAID must
 *   stay IN the settle set so the shrink pass can still un-apply now-excess
 *   credit on it. Nothing on today's tree excludes PAID from anything (no
 *   exclusion logic exists at all yet), so this already passes — it exists to
 *   catch the WRONG fix (reusing `applyToInvoice`'s `notApplicableStatuses`,
 *   which excludes PAID) as a regression once the real fix lands. Mutation
 *   probe: adding PAID to `CREDIT_SETTLE_EXCLUDED` must turn this red.
 * - **T4 (R1, REG-B67)** — positive control: a SENT invoice with a balance
 *   still receives credit. Already passing (it's today's existing happy
 *   path); pins that T1/T2's new exclusion does not over-exclude live
 *   invoices.
 * - **T8 (R4, REG-B66)** — positive control + cap: `create()` against a live
 *   SENT invoice still creates normally, and the pre-existing over-credit cap
 *   (`existing + amount > total`) still throws. Already passing today (there
 *   is no status read yet to disturb it); pins that adding one doesn't.
 * - **T11 (R5, REG-B66)** — negative control: a credit note sourced from a
 *   DIFFERENT invoice is untouched by `voidInvoiceInTx`. Already passing
 *   today (nothing touches ANY sourced credit note yet) — vacuously so,
 *   exactly like F07's T7/T9 guards in `orders.lifecycle-conservation.pins.spec.ts`;
 *   it starts discriminating once R5's capping loop exists and must scope by
 *   invoiceId rather than touching everything the query happens to return.
 * - **T12 (R9, no REG token)** — `findAll`'s Prisma `include` must carry
 *   `invoice: { select: { id, invoiceNumber } }`. This one is a structural
 *   exception: it lives here NOT because it is green pre-fix (it is red —
 *   `findAll`'s include has no `invoice` key today) but per the test-plan's
 *   token-discipline note — only REG-B66/REG-B67 may appear in a jest title
 *   in the GATE file, and T12 proves R9/B19, a different bug whose UI half
 *   (R10) is proven by Playwright spec 28 under REG-B19. A REG-B19 token on
 *   ANY jest test would let campaign-check discharge that Playwright-only T2
 *   row without spec 28 ever running, so T12 carries no REG token anywhere
 *   and is kept out of the file whose command line campaign-check greps for
 *   B66/B67. It is still expected to go red when run — see the note on the
 *   test itself.
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
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";

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
      ],
    }).compile();
    service = mod.get(CreditNotesService);
    prisma.creditNote.findFirst.mockResolvedValue(null); // nextCnNumber → CN-…-0001
    prisma.creditNote.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "cn-live-1", ...args.data, customer: {} }),
    );
  });

  it("T8 (R4, REG-B66): creates exactly as before against a live SENT invoice", async () => {
    prisma.invoice.findFirst.mockResolvedValueOnce({
      total: 100,
      customerId: "c1",
      items: [],
      status: "SENT",
    });
    prisma.creditNote.aggregate.mockResolvedValueOnce({ _sum: { amount: 0 } });

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
// InvoicesService — voidInvoiceInTx leaves an unrelated credit note alone
// (R5, REG-B66)
// ─────────────────────────────────────────────────────────────────────────

describe("InvoicesService — voidInvoiceInTx negative control (F09 pins)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ledger: { reverseInvoiceEntries: jest.Mock };
  let commissionEngine: { syncInvoiceCommissionSafe: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    ledger = { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) };
    commissionEngine = { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        { provide: EmailService, useValue: {} },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: RegulatedLedgerService, useValue: ledger },
        { provide: AuthorizationGuardService, useValue: {} },
        { provide: CreditNotesService, useValue: {} },
        { provide: MessagingService, useValue: {} },
        { provide: StorageService, useValue: {} },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: CommissionEngineService, useValue: commissionEngine },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 }); // the void claim succeeds
  });

  it("T11 (R5, REG-B66): a credit note sourced from a DIFFERENT invoice is untouched by this void", async () => {
    // Defense-in-depth fixture: a note whose invoiceId does NOT match the
    // invoice being voided ends up in the fetched set anyway (as it would if
    // a future query were scoped too broadly) — the service itself, not just
    // the query, must never mutate a note it doesn't source.
    prisma.creditNote.findMany.mockResolvedValueOnce([
      {
        id: "cn-other-inv",
        invoiceId: "inv-completely-different",
        amount: 50,
        amountUsed: 0,
        status: "ISSUED",
      },
    ]);

    await service.voidInvoiceInTx(prisma as any, "inv-void-src-4", null);

    expect(prisma.creditNote.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cn-other-inv" } }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CreditNotesService — findAll invoice-number include (R9, B19 — no REG
// token; see file header)
// ─────────────────────────────────────────────────────────────────────────

describe("CreditNotesService — findAll invoice-number include (F09, R9)", () => {
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
      ],
    }).compile();
    service = mod.get(CreditNotesService);
  });

  // Titled descriptively, with NO REG token — see the file header's
  // token-discipline note. This is the T2 row's API-side half; the render
  // half (R10 — showing the number instead of the UUID) and the REG-B19
  // token both live only in Playwright spec 28.
  it("T12 (R9): findAll's creditNote.findMany call includes invoice: { select: { id, invoiceNumber } }, matching findOne's shape", async () => {
    await service.findAll();

    expect(prisma.creditNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          invoice: { select: { id: true, invoiceNumber: true } },
        }),
      }),
    );
  });
});
