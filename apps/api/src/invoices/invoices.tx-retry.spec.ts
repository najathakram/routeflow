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
import { stockTxRetryState, txConflictState } from "../common/tx-retry";
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
import { VOIDED_DURING_EMAIL } from "./invoice-send-guard";
import * as fs from "node:fs";
import * as path from "node:path";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

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
        entitlementAuthorityFromEntitlements, // #2241
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

  // SA-404a: pre-check tx (lock + guard) → email → markSent (authoritative re-check).
  it("sendEmail(): a 40001 on markSent AFTER delivery is retried — marked SENT, the email NOT re-sent", async () => {
    prisma.invoice.findUnique.mockResolvedValue(invoice(InvoiceStatus.SENT));
    prisma.invoice.update.mockResolvedValue(invoice(InvoiceStatus.SENT));
    const real = prisma.tenantTransaction.getMockImplementation()!;
    prisma.tenantTransaction
      .mockImplementationOnce(real) // the pre-check tx passes
      .mockImplementationOnce(() => Promise.reject(conflict())); // markSent attempt 1 conflicts
    await expect(service.sendEmail(INVOICE_ID)).resolves.toMatchObject({ success: true });
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(3);
    expect(email.sendInvoice).toHaveBeenCalledTimes(1);
  });

  it("sendEmail(): a 40001 in the pre-check tx is retried — one email", async () => {
    prisma.invoice.findUnique.mockResolvedValue(invoice(InvoiceStatus.SENT));
    prisma.invoice.update.mockResolvedValue(invoice(InvoiceStatus.SENT));
    conflictOnce(); // the FIRST tx is the pre-check
    await expect(service.sendEmail(INVOICE_ID)).resolves.toMatchObject({ success: true });
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(3);
    expect(email.sendInvoice).toHaveBeenCalledTimes(1);
  });

  it("sendEmail(): VOID committed before the pre-check ⇒ 400, NO email, nothing written", async () => {
    prisma.invoice.findUnique
      .mockResolvedValueOnce(invoice(InvoiceStatus.SENT)) // pre-tx read
      .mockResolvedValue(invoice(InvoiceStatus.VOID)); // the pre-check's locked re-read
    await expect(service.sendEmail(INVOICE_ID)).rejects.toThrow("Cannot send a voided invoice");
    expect(email.sendInvoice).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it("sendEmail(): VOID committed between the pre-check and markSent ⇒ email once, 400 that SAYS so, status unchanged", async () => {
    prisma.invoice.findUnique
      .mockResolvedValueOnce(invoice(InvoiceStatus.SENT)) // pre-tx read
      .mockResolvedValueOnce(invoice(InvoiceStatus.SENT)) // pre-check: still sendable
      .mockResolvedValue(invoice(InvoiceStatus.VOID)); // markSent's locked re-read
    await expect(service.sendEmail(INVOICE_ID)).rejects.toThrow(VOIDED_DURING_EMAIL);
    expect(email.sendInvoice).toHaveBeenCalledTimes(1);
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it("sendEmail(): control — nothing interleaves ⇒ one email, one SENT write", async () => {
    prisma.invoice.findUnique.mockResolvedValue(invoice(InvoiceStatus.SENT));
    prisma.invoice.update.mockResolvedValue(invoice(InvoiceStatus.SENT));
    await expect(service.sendEmail(INVOICE_ID)).resolves.toMatchObject({ success: true });
    expect(email.sendInvoice).toHaveBeenCalledTimes(1);
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2); // pre-check + markSent
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
    // Attempt 1 aborted before its body ran; the retry ran it once, on a fresh tx — one void.
    expect(release).toHaveBeenCalledTimes(1);
    expect(voidTx).toHaveBeenCalledTimes(1);
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
    for (const label of ["invoice mark-sent", "invoice send pre-check", "invoice void"]) {
      expect(inv).toMatch(new RegExp(`retry(?:OnTxConflict|CreditTx)\\(\\s*\\\`${label}`));
    }
    // send() and sendEmail() share the one retried mark-sent transaction.
    expect(inv.match(/this\.markSent\(/g)).toHaveLength(2);
    const ord = read("orders/orders.service.ts");
    // SA-767 L-2.3: the cancel tx moved from a bare retryOnTxConflict(`order cancel void`) to the service's
    // stockTx("orders.cancel", ...), which wraps retryStockTx - whose conflict set (40001 / 40P01 / P2034 and
    // the lock timeouts) is a superset of retryOnTxConflict's. The intent is unchanged: the Serializable
    // cancel/void tx runs inside a conflict-retry wrapper.
    // (1) the Serializable cancel tx is wrapped by this.stockTx(`order cancel void order=${id}`, ...) - the retry-warn
    // label the send/void race DB spec counts
    expect(ord).toMatch(/this\.stockTx\(\s*`order cancel void order=\$\{id\}`/);
    // (2) stockTx itself delegates to stockTxBounded (retryStockTx + the lock bound first) and passes the tx options through
    expect(ord).toMatch(
      /private stockTx<T>\(label: string, fn: \(tx: any\) => Promise<T>, opts\?: any\): Promise<T> \{\s*return stockTxBounded\(this\.prisma, label, fn, opts\);/,
    );
    // (3) retryStockTx retries through retryOnTxConflict with a predicate built on stockTxRetryState
    const retrySrc = read("common/tx-retry.ts");
    expect(retrySrc).toMatch(
      /export async function retryStockTx[\s\S]{0,900}retryOnTxConflict\(label, run, retryable\)/,
    );
    expect(retrySrc).toMatch(/: stockTxRetryState\(err\)/);
    // (4) FUNCTIONAL: that retry predicate retries at least everything retryOnTxConflict retried
    // (40001, 40P01, P2034 and the driver-adapter shapes), plus the stock lock timeouts.
    const shapes = [
      { code: "P2034" },
      { code: "40001" },
      { code: "40P01" },
      { meta: { driverAdapterError: { cause: { originalCode: "40001" } } } },
      { meta: { driverAdapterError: { cause: { originalCode: "40P01" } } } },
      { name: "DriverAdapterError", cause: { kind: "TransactionWriteConflict" } },
    ];
    for (const shape of shapes) {
      const err = Object.assign(new Error("conflict"), shape);
      expect(txConflictState(err)).toBeTruthy();
      expect(stockTxRetryState(err)).toBe(txConflictState(err));
    }
    expect(stockTxRetryState(Object.assign(new Error("lock"), { code: "55P03" }))).toBe("55P03");
    expect(stockTxRetryState(new Error("not a conflict"))).toBeNull();
    // SA-404: the order-cancel body already decides from IN-TX reads (its items and its
    // invoices), so a retry's fresh snapshot is what it acts on — pin that it stays so.
    const cancel = ord.slice(ord.search(/this\.stockTx\(\s*`order cancel void order=\$\{id\}`/));
    // SA-762r F1: the body moved verbatim to order-cancel-tx.ts; changeStatus runs it inside this retried tx.
    expect(cancel.slice(0, cancel.indexOf('isolationLevel: "Serializable"'))).toMatch(
      /this\.cancelOrderInTx\(tx, order,/,
    );
    const body = read("orders/order-cancel-tx.ts");
    expect(body).toMatch(/tx\.orderItem\.findMany\(/);
    expect(body).toMatch(/tx\.invoice\.findMany\(/);
    // SA-404d R1: the FIRST statement locks Order → Invoices and re-checks; the CANCELLED status
    // write sits inside this locked tx, after it (a refusal leaves the order as it was).
    const lock = body.indexOf("await lockOrderForCancel(tx, id)");
    const statusWrite = body.indexOf("tx.order.updateMany(");
    expect(lock).toBeGreaterThan(-1);
    expect(statusWrite).toBeGreaterThan(lock);
    // SA-404f F2: the status write is a compare-and-set on the cancellable set — a retry after a
    // concurrent DELIVERED must 409, never cancel a delivered order.
    const cas = body.slice(statusWrite, statusWrite + 400);
    expect(cas).toMatch(/status:\s*\{\s*in:\s*fromStatuses/);
    expect(body).toMatch(/claimed\.count === 0[\s\S]{0,120}ORDER_CHANGED_DURING_EDIT/);
    expect(body).not.toMatch(
      /tx\.order\.update\(\{\s*where:\s*\{\s*id\s*\},\s*data:\s*statusUpdateData/,
    );
    expect(body).not.toMatch(/this\.prisma\.(forTenant\(\)\.)?(invoice|orderItem)\./);
  });
});
