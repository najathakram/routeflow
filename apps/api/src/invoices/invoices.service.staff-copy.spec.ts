/**
 * W-1443 (SA-1516) T12-T14: the sender's private copy around the customer send in InvoicesService.sendEmail.
 * Same harness as invoices.send-settle.spec.ts: real service over a mocked Prisma, EmailService mocked at the
 * module boundary (nothing is delivered). Fixtures use acme addresses.
 * T15/M4: the pickup completion email gets no copy. R-239 M1 (explicit copyActorId), M2 (one INVOICE_EMAILED row), M5 (copy last).
 */
const COMPLETION_ATTACHMENTS = [
  { filename: "INV-2.pdf", content: Buffer.from("two"), contentType: "application/pdf" },
];
jest.mock("./invoice-completion-email", () => ({
  completionEmailParts: jest.fn().mockResolvedValue({
    completion: { orderNumber: "ORD-1" },
    extraAttachments: [
      { filename: "INV-2.pdf", content: Buffer.from("two"), contentType: "application/pdf" },
    ],
    alsoInvoiceIds: ["inv-w1443-2"],
  }),
}));
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://files.example.test/invoice.pdf"),
  })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { InvoiceStatus } from "@prisma/client";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";

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
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

const PRESSED = { copyActorId: "u-ops" }; // what the send-email route passes (R-239 M1)
const INVOICE_ID = "inv-w1443-1";
const ORDER_ID = "ord-w1443-1";
const CUSTOMER_ID = "cust-w1443-1";

function buildInvoiceFixture() {
  return {
    id: INVOICE_ID,
    orderId: ORDER_ID,
    customerId: CUSTOMER_ID,
    invoiceNumber: "INV-F07-SETTLE-1",
    status: InvoiceStatus.DRAFT, // SA-857: only the DRAFT -> SENT issue settles and sweeps credits
    deliveryBatchId: null as string | null,
    total: 100,
    issueDate: new Date("2026-09-01T00:00:00.000Z"),
    dueDate: new Date("2026-09-15T00:00:00.000Z"),
    paymentTermsLabel: "Net 15",
    depositPercent: null as number | null,
    depositDueDate: null as Date | null,
    customer: {
      id: CUSTOMER_ID,
      businessName: "Acme Wholesale",
      contactName: "QA Buyer",
      email: "buyer@acme.test",
    },
    items: [] as unknown[],
    payments: [] as unknown[],
  };
}

describe("InvoicesService.sendEmail - staff copy (W-1443)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let sendInvoice: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    sendInvoice = jest.fn().mockResolvedValue({ delivered: true });
    const creditNotes = {
      settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
      autoApplyOldestCreditsInTx: jest
        .fn()
        .mockResolvedValue({ applied: 0, invoiceStatus: InvoiceStatus.SENT }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        {
          provide: EmailService,
          useValue: {
            isEmailConfigured: jest.fn().mockResolvedValue(true),
            sendInvoice,
          },
        },
        {
          provide: InvoicePdfService,
          useValue: {
            getOrGenerate: jest.fn().mockResolvedValue("https://files.example.test/invoice.pdf"),
          },
        },
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue("false"),
            getAll: jest.fn().mockResolvedValue({}),
          },
        },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: AuthorizationGuardService, useValue: {} },
        { provide: CreditNotesService, useValue: creditNotes },
        {
          provide: MessagingService,
          useValue: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: StorageService, useValue: {} },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") },
        },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
    const fixture = buildInvoiceFixture();
    prisma.invoice.findUnique.mockResolvedValue(fixture);
    prisma.invoice.update.mockResolvedValue(fixture);
    prisma.orderCreditNote.findMany.mockResolvedValue([]);
    // an opted-in, active operator who pressed Send
    prisma.user.findFirst.mockResolvedValue({ email: "ops@acme.test" });
    prisma.userPreference.findUnique.mockResolvedValue({ value: "true" });
  });

  const copyCalls = () => sendInvoice.mock.calls.filter((c) => c[0].staffCopy);

  it("T14: customer delivered, copy delivered -> response carries copiedTo", async () => {
    const res = await service.sendEmail(INVOICE_ID, undefined, "final", "u-ops", PRESSED);
    expect(res).toMatchObject({
      success: true,
      sentTo: "buyer@acme.test",
      copiedTo: "ops@acme.test",
    });
    expect(sendInvoice).toHaveBeenCalledTimes(2);
    expect(copyCalls()[0][0].to).toBe("ops@acme.test");
  });

  it("T12: customer send not delivered -> EMAIL_SEND_FAILED thrown and no copy attempted", async () => {
    sendInvoice.mockResolvedValueOnce({ delivered: false, error: "rejected" });
    await expect(
      service.sendEmail(INVOICE_ID, undefined, "final", "u-ops", PRESSED),
    ).rejects.toThrow();
    expect(sendInvoice).toHaveBeenCalledTimes(1);
    expect(copyCalls()).toHaveLength(0);
  });

  it("T13: customer delivered, copy fails -> success, no copiedTo, invoice still marked SENT", async () => {
    sendInvoice.mockResolvedValueOnce({ delivered: true }).mockRejectedValueOnce(new Error("smtp"));
    const res = await service.sendEmail(INVOICE_ID, undefined, "final", "u-ops", PRESSED);
    expect(res.success).toBe(true);
    expect(res).not.toHaveProperty("copiedTo");
    expect(prisma.invoice.update).toHaveBeenCalled(); // markSent ran
  });

  it("no actor (recurring auto-send) -> one send only, no copiedTo", async () => {
    const res = await service.sendEmail(INVOICE_ID, undefined, "final", null);
    expect(sendInvoice).toHaveBeenCalledTimes(1);
    expect(res).not.toHaveProperty("copiedTo");
  });

  it("M1: an audit actor without the route copyActorId (or null in a support session) gets no copy", async () => {
    await service.sendEmail(INVOICE_ID, undefined, "final", "u-ops"); // no opts
    await service.sendEmail(INVOICE_ID, undefined, "final", "u-ops", { copyActorId: null });
    expect(sendInvoice).toHaveBeenCalledTimes(2);
    expect(copyCalls()).toHaveLength(0);
  });

  it("T15/M4: the pickup completion email (sendCompletionEmail, an actor, pref on) gets NO copy", async () => {
    const res = await service.sendCompletionEmail(ORDER_ID, [INVOICE_ID, "inv-w1443-2"], "u-ops");
    expect(res).toEqual({ delivered: true });
    expect(sendInvoice).toHaveBeenCalledTimes(1);
    expect(copyCalls()).toHaveLength(0);
    expect(sendInvoice.mock.calls[0][0].extraAttachments).toEqual(COMPLETION_ATTACHMENTS);
  });

  it("M2: a copied send leaves exactly one INVOICE_EMAILED row, the customer's", async () => {
    await service.sendEmail(INVOICE_ID, undefined, "final", "u-ops", PRESSED);
    const rows = prisma.auditLog.create.mock.calls
      .map((c: any[]) => c[0].data)
      .filter((d: any) => d.action === AUDIT_ACTIONS.INVOICE_EMAILED);
    expect(rows).toHaveLength(1);
    expect(rows[0].meta.to).toBe("buyer@acme.test");
  });

  it("M5: the copy goes out LAST, after the invoice is marked SENT", async () => {
    const order: string[] = [];
    prisma.invoice.update.mockImplementation(async () => {
      order.push("markSent");
      return buildInvoiceFixture();
    });
    sendInvoice.mockImplementation(async (p: any) => {
      order.push(p.staffCopy ? "copy" : "customer");
      return { delivered: true };
    });
    await service.sendEmail(INVOICE_ID, undefined, "final", "u-ops", PRESSED);
    expect(order[0]).toBe("customer");
    expect(order[order.length - 1]).toBe("copy");
    expect(order.indexOf("markSent")).toBeLessThan(order.indexOf("copy"));
  });
});
