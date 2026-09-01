/**
 * F07 — invoices `send()`/`sendEmail()` settle-before-sweep (TP-INV).
 *
 * Proves T17 and T18 from
 * `.claude/pipeline/2026-09-01-f07-order-lifecycle/test-plan.md`: REG-B108 —
 * the DELIVERED-branch best-effort credit settle (`settleOrderCreditsInTx`)
 * is a real call in `changeStatus`, but `send()`/`sendEmail()`'s documented
 * "send() catches up" fallback never actually reaches it: today both flip an
 * order-linked invoice SENT and run straight into `autoApplyOldestCreditsInTx`
 * (the oldest-first sweep), so an explicit-amount credit intent recorded at
 * order time is never settled before the invoice is marked sent.
 *
 * RED BY DESIGN: `InvoicesService.send`/`sendEmail` (invoices.service.ts,
 * search "P5-13: SENT flip") never call `this.creditNotes.settleOrderCreditsInTx`
 * at all today — grep confirms its only two call sites are elsewhere in the
 * file (the DELIVERED branch's best-effort settle, ~L1258/L2730), neither of
 * which is `send()`/`sendEmail()`. Both tests below fail on the call-order
 * assertion (`callLog` never gains a `"settleOrderCreditsInTx"` entry), never
 * on a compile error — no not-yet-existing field/option is touched, so no
 * `as any` escape hatch is needed here.
 *
 * Harness: real `InvoicesService` over a mocked `PrismaService`
 * (`createMockPrisma()` — `forTenant()`/`tenantTransaction` pass-through, per
 * `orders.update-items-guards.spec.ts`'s precedent) with every other
 * constructor collaborator stubbed via `useValue`. `InvoicePdfService` is
 * `jest.mock()`-ed at the module boundary (not just provided via `useValue`)
 * because it imports `invoice-pdf-template.tsx`, which imports
 * `@react-pdf/renderer` — an ESM-only package Jest's CommonJS transform can't
 * parse; the same reason `orders.update-items-guards.spec.ts` mocks
 * `InvoicesService`/`NotificationsService` wholesale.
 */

// Mock InvoicePdfService before it's imported — prevents Jest from
// traversing invoice-pdf-template.tsx, which imports @react-pdf/renderer
// (ESM-only, unparseable by Jest's CJS transform).
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://files.example.test/invoice.pdf"),
  })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { InvoiceStatus } from "@prisma/client";

import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
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
import { createMockPrisma } from "../testing/prisma-mock";

const ORDER_ID = "ord-f07-settle-1";
const INVOICE_ID = "inv-f07-settle-1";
const CUSTOMER_ID = "cust-f07-settle-1";
// e2e-routeflow-shaped test fixture id — never a live client identifier.
const EXPLICIT_CREDIT_NOTE_ID = "cn-e2e-routeflow-explicit-1";

/**
 * An order-linked invoice, already SENT (a re-send). Status !== DRAFT short-
 * circuits `assertOrderInvoiceUnlocked`'s order lookup AND the DRAFT-only
 * INVOICE_SENT notify branch, so the fixture only needs what `send()`/
 * `sendEmail()` actually read on this path — the orderId is what makes the
 * new settle branch reachable per the test-plan's harness note.
 */
function buildInvoiceFixture() {
  return {
    id: INVOICE_ID,
    orderId: ORDER_ID,
    customerId: CUSTOMER_ID,
    invoiceNumber: "INV-F07-SETTLE-1",
    status: InvoiceStatus.SENT,
    deliveryBatchId: null as string | null,
    total: 100,
    issueDate: new Date("2026-09-01T00:00:00.000Z"),
    dueDate: new Date("2026-09-15T00:00:00.000Z"),
    paymentTermsLabel: "Net 15",
    depositPercent: null as number | null,
    depositDueDate: null as Date | null,
    customer: {
      id: CUSTOMER_ID,
      businessName: "e2e-routeflow Wholesale",
      contactName: "QA Buyer",
      email: "buyer@e2e-routeflow.test",
    },
    items: [] as unknown[],
    payments: [] as unknown[],
  };
}

describe("InvoicesService — send()/sendEmail() settle-before-sweep (TP-INV)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let creditNotes: {
    settleOrderCreditsInTx: jest.Mock;
    autoApplyOldestCreditsInTx: jest.Mock;
  };
  // Shared call-order log (per package brief): each mock pushes its own name
  // so the oracle is "which happened first", not a jest.mock.invocationCallOrder
  // comparison the reader has to cross-reference by hand.
  let callLog: string[];

  beforeEach(async () => {
    callLog = [];
    prisma = createMockPrisma();

    creditNotes = {
      settleOrderCreditsInTx: jest.fn().mockImplementation(async () => {
        callLog.push("settleOrderCreditsInTx");
        return { applied: 0, unapplied: 0 };
      }),
      autoApplyOldestCreditsInTx: jest.fn().mockImplementation(async () => {
        callLog.push("autoApplyOldestCreditsInTx");
        // Truthy invoiceStatus skips send()/sendEmail()'s zero-balance
        // recompute branch — irrelevant to T17/T18's ordering claim.
        return { applied: 0, invoiceStatus: InvoiceStatus.SENT };
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        {
          provide: EmailService,
          useValue: {
            isEmailConfigured: jest.fn().mockResolvedValue(true),
            sendInvoice: jest.fn().mockResolvedValue({ delivered: true }),
          },
        },
        {
          provide: InvoicePdfService,
          useValue: {
            getOrGenerate: jest.fn().mockResolvedValue("https://files.example.test/invoice.pdf"),
          },
        },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("false") } },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: AuthorizationGuardService, useValue: {} },
        { provide: CreditNotesService, useValue: creditNotes },
        {
          provide: MessagingService,
          useValue: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: StorageService, useValue: {} },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  // ─── T17 (REG-B108): send() ──────────────────────────────────────────────

  it("REG-B108 (T17): send() settles order credits before the oldest-first sweep, and the sweep still excludes the explicit-amount credit note", async () => {
    const fixture = buildInvoiceFixture();
    prisma.invoice.findUnique.mockResolvedValue(fixture);
    prisma.invoice.update.mockResolvedValue(fixture);
    // An operator's EXPLICIT-amount order-time credit selection — the sweep
    // must still exclude it after the settle-first fix, per R12's "the
    // explicit-id exclusion for the oldest-first sweep is KEPT".
    prisma.orderCreditNote.findMany.mockResolvedValue([{ creditNoteId: EXPLICIT_CREDIT_NOTE_ID }]);

    await service.send(INVOICE_ID);

    // Call-order oracle: today `settleOrderCreditsInTx` is never called by
    // send() at all, so callLog is ["autoApplyOldestCreditsInTx"] — this
    // fails on the array comparison, not a missing property.
    expect(callLog).toEqual(["settleOrderCreditsInTx", "autoApplyOldestCreditsInTx"]);
    expect(creditNotes.settleOrderCreditsInTx).toHaveBeenCalledWith(expect.anything(), ORDER_ID);
    expect(creditNotes.autoApplyOldestCreditsInTx).toHaveBeenCalledWith(
      expect.anything(),
      INVOICE_ID,
      CUSTOMER_ID,
      expect.objectContaining({ excludeCreditNoteIds: [EXPLICIT_CREDIT_NOTE_ID] }),
    );
  });

  // ─── T18 (REG-B108): sendEmail() ─────────────────────────────────────────

  it("REG-B108 (T18): sendEmail() settles order credits before the oldest-first sweep, and the sweep still excludes the explicit-amount credit note", async () => {
    const fixture = buildInvoiceFixture();
    prisma.invoice.findUnique.mockResolvedValue(fixture);
    prisma.invoice.update.mockResolvedValue(fixture);
    prisma.orderCreditNote.findMany.mockResolvedValue([{ creditNoteId: EXPLICIT_CREDIT_NOTE_ID }]);

    await service.sendEmail(INVOICE_ID);

    // Same call-order oracle as T17 — sendEmail() mirrors send()'s tx block
    // verbatim, so it carries the identical omission today.
    expect(callLog).toEqual(["settleOrderCreditsInTx", "autoApplyOldestCreditsInTx"]);
    expect(creditNotes.settleOrderCreditsInTx).toHaveBeenCalledWith(expect.anything(), ORDER_ID);
    expect(creditNotes.autoApplyOldestCreditsInTx).toHaveBeenCalledWith(
      expect.anything(),
      INVOICE_ID,
      CUSTOMER_ID,
      expect.objectContaining({ excludeCreditNoteIds: [EXPLICIT_CREDIT_NOTE_ID] }),
    );
  });
});
