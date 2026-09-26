/**
 * #2255 — Serializable transactions retried on a write conflict (SA-269 `retryOnTxConflict`),
 * and, because a retry takes a FRESH snapshot, every guard those bodies apply is re-read INSIDE
 * the transaction: a pre-tx read would let attempt 2 re-SEND a just-voided invoice or void one
 * that just took a cash payment (the 40001 used to stop both). Real-PG 40001 proof: DB lane (F2).
 * Harness: invoices.send-settle.spec.ts's (real InvoicesService over createMockPrisma).
 */
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
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

import { BadRequestException } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";

const INVOICE_ID = "inv-2255-1";
const CUSTOMER_ID = "cust-2255-1";

/** A Prisma 7 serialization conflict, as `txConflictState` recognises it. */
const conflict = () => Object.assign(new Error("could not serialize access"), { code: "P2034" });

function invoice(status: InvoiceStatus, payments: unknown[] = []) {
  return {
    id: INVOICE_ID,
    orderId: null as string | null,
    customerId: CUSTOMER_ID,
    invoiceNumber: "INV-2255-1",
    status,
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
    payments,
  };
}

describe("#2255 Serializable invoice transactions retry on conflict, guards re-read in-tx", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let creditNotes: { settleOrderCreditsInTx: jest.Mock; autoApplyOldestCreditsInTx: jest.Mock };
  let email: { isEmailConfigured: jest.Mock; sendInvoice: jest.Mock };
  let ledger: { reverseInvoiceEntries: jest.Mock };
  let callLog: string[];

  beforeEach(async () => {
    callLog = [];
    prisma = createMockPrisma();
    email = {
      isEmailConfigured: jest.fn().mockResolvedValue(true),
      sendInvoice: jest.fn().mockResolvedValue({ delivered: true }),
    };
    ledger = { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) };

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
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        { provide: EmailService, useValue: email },
        {
          provide: InvoicePdfService,
          useValue: {
            getOrGenerate: jest.fn().mockResolvedValue("https://files.example.test/invoice.pdf"),
          },
        },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("false") } },
        { provide: RegulatedLedgerService, useValue: ledger },
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
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") },
        },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  /** The first tenantTransaction attempt aborts with a conflict; later ones run for real. */
  const conflictOnce = () => {
    const real = prisma.tenantTransaction.getMockImplementation()!;
    prisma.tenantTransaction.mockImplementationOnce(() => Promise.reject(conflict()));
    return real;
  };

  it("send(): a 40001 on the SENT-flip tx is retried and the send succeeds", async () => {
    prisma.invoice.findUnique.mockResolvedValue(invoice(InvoiceStatus.SENT));
    prisma.invoice.update.mockResolvedValue(invoice(InvoiceStatus.SENT));
    conflictOnce();
    await expect(service.send(INVOICE_ID)).resolves.toBeDefined();
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
  });

  it("sendEmail(): a 40001 after delivery is retried — the invoice is marked SENT, the email is NOT re-sent", async () => {
    prisma.invoice.findUnique.mockResolvedValue(invoice(InvoiceStatus.SENT));
    prisma.invoice.update.mockResolvedValue(invoice(InvoiceStatus.SENT));
    conflictOnce();
    await expect(service.sendEmail(INVOICE_ID)).resolves.toMatchObject({ success: true });
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
    expect(email.sendInvoice).toHaveBeenCalledTimes(1);
  });

  it("voidInvoice(): a 40001 is retried and the void succeeds", async () => {
    prisma.invoice.findUnique.mockResolvedValue(invoice(InvoiceStatus.SENT));
    const release = jest
      .spyOn(service, "releaseWalletPaymentsInTx")
      .mockResolvedValue(undefined as any);
    const voidTx = jest
      .spyOn(service, "voidInvoiceInTx")
      .mockResolvedValue(invoice(InvoiceStatus.VOID) as any);
    conflictOnce();
    await expect(service.voidInvoice(INVOICE_ID)).resolves.toMatchObject({
      status: InvoiceStatus.VOID,
    });
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2); // re-run from a clean, rolled-back tx
    expect(voidTx).toHaveBeenCalledTimes(2);
  });

  it("a non-conflict error is NOT retried (propagates on attempt 1)", async () => {
    prisma.invoice.findUnique.mockResolvedValue(invoice(InvoiceStatus.SENT));
    prisma.tenantTransaction.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    await expect(service.send(INVOICE_ID)).rejects.toThrow("boom");
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
  });

  it("send(): the in-tx re-read refuses an invoice voided since the pre-read — never SENT over VOID", async () => {
    prisma.invoice.findUnique
      .mockResolvedValueOnce(invoice(InvoiceStatus.DRAFT)) // pre-tx read
      .mockResolvedValue(invoice(InvoiceStatus.VOID)); // under the tx (the retry's fresh snapshot)
    await expect(service.send(INVOICE_ID)).rejects.toThrow(BadRequestException);
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it("sendEmail(): the in-tx re-read refuses an invoice voided since the pre-read", async () => {
    prisma.invoice.findUnique
      .mockResolvedValueOnce(invoice(InvoiceStatus.SENT))
      .mockResolvedValue(invoice(InvoiceStatus.VOID));
    await expect(service.sendEmail(INVOICE_ID)).rejects.toThrow(BadRequestException);
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it("voidInvoice(): the in-tx re-read refuses an invoice that took a cash payment since the pre-read", async () => {
    const cash = { method: "CASH", amount: 40, status: "PAID" };
    prisma.invoice.findUnique
      .mockResolvedValueOnce(invoice(InvoiceStatus.SENT, [])) // pre-tx: no external money
      .mockResolvedValue(invoice(InvoiceStatus.SENT, [cash])); // under the tx
    jest.spyOn(service, "releaseWalletPaymentsInTx").mockResolvedValue(undefined as any);
    const voidTx = jest
      .spyOn(service, "voidInvoiceInTx")
      .mockResolvedValue(invoice(InvoiceStatus.VOID) as any);
    await expect(service.voidInvoice(INVOICE_ID)).rejects.toThrow(BadRequestException);
    expect(voidTx).not.toHaveBeenCalled();
  });

  it("placement: every Serializable site named in #2255 runs inside retryOnTxConflict", () => {
    const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    const inv = read("invoices/invoices.service.ts");
    for (const label of ["invoice mark-sent", "invoice void"]) {
      expect(inv).toMatch(new RegExp(`retryOnTxConflict\\(\\s*\\\`${label}`));
    }
    // send() and sendEmail() share the one retried mark-sent transaction.
    expect(inv.match(/this\.markSent\(/g)).toHaveLength(2);
    const ord = read("orders/orders.service.ts");
    expect(ord).toMatch(/retryOnTxConflict\(\s*`order cancel void/);
  });
});
