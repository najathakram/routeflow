/**
 * F09 — credit notes and wallet integrity (TP-API): the RED gate.
 *
 * Proves T1, T2, T5, T6, T7, T9, T10 from
 * `.claude/pipeline/2026-09-01-f09-credit-notes-wallet/test-plan.md`:
 * REG-B67 (wallet credit can reach forgiven WRITTEN_OFF debt because
 * `settleOrderCreditsInTx`'s invoice set excludes only VOID) and REG-B66 (a
 * credit note can be minted against a dead VOID/DRAFT source invoice, and
 * voiding an invoice never touches the unused headroom of notes it sourced).
 *
 * RED BY DESIGN — THIS FILE IS THE RED GATE: none of B66/B67 are implemented
 * yet, and EVERY `it()` below fails on an ASSERTION against today's tree —
 * `cd apps/api && npx jest src/credit-notes/credit-notes.wallet-integrity.spec.ts`
 * must report "0 passed". No not-yet-existing field is read (the fix is new
 * exclusion/guard LOGIC, not a new return shape), so no `as any` escape hatch
 * is needed here.
 *
 * The GUARD/positive-control tests that are already green pre-fix (T3, T4,
 * T8, T11 — proving the fix must NOT over-exclude PAID or touch an unrelated
 * credit note) live in the sibling `credit-notes.wallet-integrity.pins.spec.ts`
 * so this file's gate command reads "0 passed". T12 (R9/B19 — `findAll`'s
 * `invoice` include) ALSO lives in the pins file, per the test-plan's token-
 * discipline note: only REG-B66/REG-B67 may appear in a jest title here,
 * since a REG-B13/18/19 token on a jest test would let campaign-check
 * discharge a Playwright-only (spec 28) row without the web half ever
 * running. T12 is titled with no REG token at all, in either file.
 *
 * Anti-vacuity: every test below asserts through the `tx`-shaped Prisma mock
 * (`invoicePayment.create`, `creditNote.update`, `creditNote.create`) — never
 * a value read out of the service's internals. T1/T2/T5 use the SAME direct
 * array-injection harness as the existing `settleOrderCreditsInTx` describe
 * in `credit-notes.service.spec.ts` (mocking `tx.invoice.findMany`'s RETURN
 * value directly, bypassing the real `where` clause) — this is deliberate:
 * it proves the SERVICE refuses to apply credit to an excluded invoice
 * regardless of how it ended up in the fetched set, not merely that today's
 * query happens to filter it. Because of that, both T1 (WRITTEN_OFF — new)
 * AND T2 (VOID — already correct at the query layer, but unguarded once the
 * array is fetched) fail today: `settleOrderCreditsInTx`'s apply loop has NO
 * per-invoice status check at all, so either invoice, once inside the fetched
 * array, gets a CREDIT_NOTE payment created against it.
 *
 * Harness: real `CreditNotesService`/`InvoicesService` over a mocked
 * `PrismaService` (`createMockPrisma()`, per `credit-notes.service.spec.ts`
 * and `invoices.send-settle.spec.ts`), every other collaborator a `useValue`
 * stub. `InvoicePdfService` is `jest.mock()`-ed at the module boundary (not
 * just `useValue`) because `InvoicesService` pulls it in transitively and it
 * imports `invoice-pdf-template.tsx` → `@react-pdf/renderer` (ESM-only,
 * unparseable by Jest's CJS transform) — same reason
 * `invoices.service.spec.ts`/`invoices.send-settle.spec.ts` mock it.
 */

// Mock InvoicePdfService before it's imported — prevents Jest from
// traversing invoice-pdf-template.tsx, which imports @react-pdf/renderer
// (ESM-only, unparseable by Jest's CJS transform).
jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://files.example.test/invoice.pdf"),
  })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";

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
// CreditNotesService — settleOrderCreditsInTx exclusion (R1/R2, REG-B67)
// ─────────────────────────────────────────────────────────────────────────

describe("CreditNotesService — settleOrderCreditsInTx wallet-exclusion (F09 gate)", () => {
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

  it("T1 (R1, REG-B67): a WRITTEN_OFF invoice with an unmet credit intent receives NO CREDIT_NOTE payment", async () => {
    prisma.orderCreditNote.findMany.mockResolvedValueOnce([
      {
        id: "ocn-wo-1",
        orderId: "order-wo",
        creditNoteId: "cn-wo-1",
        amount: null,
        createdAt: new Date("2026-01-01"),
        creditNote: { id: "cn-wo-1", amount: 50, amountUsed: 0, status: "ISSUED", expiresAt: null },
      },
    ]);
    prisma.invoice.findMany.mockResolvedValueOnce([
      {
        id: "inv-wo-1",
        invoiceNumber: "INV-WO-1",
        total: 100,
        dueDate: null,
        status: "WRITTEN_OFF",
        payments: [],
      },
    ]);
    prisma.creditNote.findUnique.mockResolvedValueOnce({
      id: "cn-wo-1",
      amount: 50,
      amountUsed: 0,
      status: "ISSUED",
      appliedToInvoiceId: null,
      appliedAt: null,
      autoApplied: false,
    });
    prisma.invoice.findUnique.mockResolvedValueOnce({
      id: "inv-wo-1",
      total: 100,
      dueDate: null,
      status: "WRITTEN_OFF",
      payments: [],
    });

    const result = await service.settleOrderCreditsInTx(prisma as any, "order-wo");

    // Oracle: the tx mock's invoicePayment.create call list is empty for this
    // invoice — today's apply loop has no per-invoice status guard at all, so
    // it fires anyway and this fails.
    expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
  });

  it("T2 (R1, REG-B67): a VOID invoice with an unmet credit intent receives NO CREDIT_NOTE payment (pins the existing VOID exclusion through the rewrite)", async () => {
    prisma.orderCreditNote.findMany.mockResolvedValueOnce([
      {
        id: "ocn-void-1",
        orderId: "order-void",
        creditNoteId: "cn-void-1",
        amount: null,
        createdAt: new Date("2026-01-01"),
        creditNote: {
          id: "cn-void-1",
          amount: 50,
          amountUsed: 0,
          status: "ISSUED",
          expiresAt: null,
        },
      },
    ]);
    prisma.invoice.findMany.mockResolvedValueOnce([
      {
        id: "inv-void-2",
        invoiceNumber: "INV-VOID-1",
        total: 100,
        dueDate: null,
        status: "VOID",
        payments: [],
      },
    ]);
    prisma.creditNote.findUnique.mockResolvedValueOnce({
      id: "cn-void-1",
      amount: 50,
      amountUsed: 0,
      status: "ISSUED",
      appliedToInvoiceId: null,
      appliedAt: null,
      autoApplied: false,
    });
    prisma.invoice.findUnique.mockResolvedValueOnce({
      id: "inv-void-2",
      total: 100,
      dueDate: null,
      status: "VOID",
      payments: [],
    });

    const result = await service.settleOrderCreditsInTx(prisma as any, "order-void");

    expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
  });

  it("T5 (R2, REG-B67): the primitive still excludes a WRITTEN_OFF invoice when called with an explicit tenantId, the shape F07's send()/sendEmail() call sites use", async () => {
    prisma.orderCreditNote.findMany.mockResolvedValueOnce([
      {
        id: "ocn-send-1",
        orderId: "order-send-shaped",
        creditNoteId: "cn-send-1",
        amount: null,
        createdAt: new Date("2026-01-01"),
        creditNote: {
          id: "cn-send-1",
          amount: 75,
          amountUsed: 0,
          status: "ISSUED",
          expiresAt: null,
        },
      },
    ]);
    prisma.invoice.findMany.mockResolvedValueOnce([
      {
        id: "inv-send-1",
        invoiceNumber: "INV-SEND-1",
        total: 200,
        dueDate: null,
        status: "WRITTEN_OFF",
        payments: [],
      },
    ]);
    prisma.creditNote.findUnique.mockResolvedValueOnce({
      id: "cn-send-1",
      amount: 75,
      amountUsed: 0,
      status: "ISSUED",
      appliedToInvoiceId: null,
      appliedAt: null,
      autoApplied: false,
    });
    prisma.invoice.findUnique.mockResolvedValueOnce({
      id: "inv-send-1",
      total: 200,
      dueDate: null,
      status: "WRITTEN_OFF",
      payments: [],
    });

    // F07's two added call sites pass tenantId explicitly (settleOrderCreditsInTx(tx,
    // order.id, tenantId)) rather than relying on the default parameter — proving the
    // exclusion holds for THIS calling shape is what proves R2 without six call-site
    // tests, per the primitive-not-call-sites design.
    const result = await service.settleOrderCreditsInTx(
      prisma as any,
      "order-send-shaped",
      "tenant-explicit-1",
    );

    expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CreditNotesService — create() refuses a dead source invoice (R4, REG-B66)
// ─────────────────────────────────────────────────────────────────────────

describe("CreditNotesService — create() refuses VOID/DRAFT source invoices (F09 gate)", () => {
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
      Promise.resolve({ id: "cn-should-not-exist", ...args.data, customer: {} }),
    );
  });

  it("T6 (R4, REG-B66): create({ invoiceId }) against a VOID invoice rejects, naming the status, with no creditNote.create call", async () => {
    prisma.invoice.findFirst.mockResolvedValueOnce({
      total: 100,
      customerId: "c1",
      items: [],
      status: "VOID",
    });
    prisma.creditNote.aggregate.mockResolvedValueOnce({ _sum: { amount: 0 } });

    let caught: any;
    try {
      await service.create({ customerId: "c1", invoiceId: "inv-void-1", amount: 30 });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught?.message).toMatch(/VOID/);
    expect(prisma.creditNote.create).not.toHaveBeenCalled();
  });

  it("T7 (R4, REG-B66): create({ invoiceId }) against a DRAFT invoice rejects, naming the status, with no creditNote.create call", async () => {
    prisma.invoice.findFirst.mockResolvedValueOnce({
      total: 100,
      customerId: "c1",
      items: [],
      status: "DRAFT",
    });
    prisma.creditNote.aggregate.mockResolvedValueOnce({ _sum: { amount: 0 } });

    let caught: any;
    try {
      await service.create({ customerId: "c1", invoiceId: "inv-draft-1", amount: 30 });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught?.message).toMatch(/DRAFT/);
    expect(prisma.creditNote.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// InvoicesService — voidInvoiceInTx caps/voids sourced credit notes
// (R5, REG-B66)
// ─────────────────────────────────────────────────────────────────────────

describe("InvoicesService — voidInvoiceInTx caps/voids credit notes it sourced (F09 gate)", () => {
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
        // voidInvoiceInTx never touches this.creditNotes directly — the
        // sourced-note capping is new logic INSIDE voidInvoiceInTx itself.
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

  it("T9 (R5, REG-B66): a fully-unused sourced credit note (amountUsed=0) is set VOID inside the same tx, before the invoice row is finalised", async () => {
    prisma.creditNote.findMany.mockResolvedValueOnce([
      {
        id: "cn-src-unused",
        invoiceId: "inv-void-src-1",
        amount: 75,
        amountUsed: 0,
        status: "ISSUED",
      },
    ]);
    const calls: string[] = [];
    prisma.creditNote.update.mockImplementation(async (args: any) => {
      calls.push(`creditNote.update:${args.where.id}`);
      return { id: args.where.id, ...args.data };
    });
    prisma.invoice.findUnique.mockImplementation(async () => {
      calls.push("invoice.findUnique:final");
      return { id: "inv-void-src-1", status: "VOID" };
    });

    await service.voidInvoiceInTx(prisma as any, "inv-void-src-1", null);

    expect(prisma.creditNote.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cn-src-unused" },
        data: expect.objectContaining({ status: "VOID" }),
      }),
    );
    // Call-order oracle: the void must happen before the final invoice read
    // that hands back the "finalised" row.
    const capIdx = calls.indexOf("creditNote.update:cn-src-unused");
    const finalIdx = calls.indexOf("invoice.findUnique:final");
    expect(capIdx).toBeGreaterThanOrEqual(0);
    expect(finalIdx).toBeGreaterThan(-1);
    expect(capIdx).toBeLessThan(finalIdx);
  });

  it("T10 (R5+R6, REG-B66): a partly-used sourced note is capped to amountUsed, never voided, and already-spent dollars are never clawed back", async () => {
    prisma.creditNote.findMany.mockResolvedValueOnce([
      {
        id: "cn-src-partial",
        invoiceId: "inv-void-src-2",
        amount: 100,
        amountUsed: 40,
        status: "ISSUED",
      },
    ]);

    await service.voidInvoiceInTx(prisma as any, "inv-void-src-2", null);

    expect(prisma.creditNote.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cn-src-partial" },
        data: expect.objectContaining({ amount: 40 }),
      }),
    );
    expect(prisma.creditNote.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cn-src-partial" },
        data: expect.objectContaining({ status: "VOID" }),
      }),
    );
    // Already-spent money (the $40 amountUsed) is never touched: no payment
    // deletion and no amountUsed decrement anywhere in the tx.
    expect(prisma.invoicePayment.delete).not.toHaveBeenCalled();
    expect(prisma.creditNote.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amountUsed: expect.anything() }) }),
    );
  });
});
