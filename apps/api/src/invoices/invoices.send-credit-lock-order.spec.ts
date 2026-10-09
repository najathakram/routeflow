/**
 * B1052 review fold-in — markSent's credit lock order.
 *
 * markSent runs `settleOrderCreditsInTx` (which locks the notes ITS order touches) and then the
 * oldest-first sweep (which locks the customer's WHOLE live set). Two sends of one customer's
 * invoices that took those two passes in sequence could each hold the other's next note — a
 * deadlock. The fix takes the customer-wide note lock FIRST, in id order, before settle, so every
 * path locks in one consistent order. This pins the order of the lock statements against the
 * settle and sweep calls; it goes red if the up-front lock is dropped or moved after settle.
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://files.example.test/invoice.pdf"),
  })),
}));

import { Test } from "@nestjs/testing";
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
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { createOpLogTx } from "../testing/op-log-tx";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

const ORDER_ID = "ord-b1052-send";
const INVOICE_ID = "inv-b1052-send";
const CUSTOMER_ID = "cust-b1052-send";

const invoice = {
  id: INVOICE_ID,
  orderId: ORDER_ID,
  customerId: CUSTOMER_ID,
  invoiceNumber: "INV-B1052-1",
  status: InvoiceStatus.SENT,
  deliveryBatchId: null as string | null,
  total: 100,
  issueDate: new Date("2026-09-01T00:00:00.000Z"),
  dueDate: new Date("2026-09-15T00:00:00.000Z"),
  paymentTermsLabel: "Net 15",
  depositPercent: null as number | null,
  depositDueDate: null as Date | null,
  customer: { id: CUSTOMER_ID, businessName: "acme", contactName: "QA", email: "q@acme.test" },
  items: [] as unknown[],
  payments: [] as unknown[],
};

describe("InvoicesService.send — markSent takes the customer-wide note lock before settle (B1052)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let events: string[];

  beforeEach(async () => {
    events = [];
    prisma = createMockPrisma();
    prisma.invoice.findUnique.mockResolvedValue(invoice);
    prisma.invoice.update.mockResolvedValue(invoice);
    prisma.orderCreditNote.findMany.mockResolvedValue([]);
    // markSent's tx: raw lock statements are folded into the same event list as the settle / sweep
    // calls so the assertion is about their relative order.
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      const { tx } = createOpLogTx((op, args) => {
        if (op === "$executeRaw" || op === "$queryRaw") {
          const sql: string = args.sql;
          const table = /FROM "(\w+)"/.exec(sql)?.[1] ?? "?";
          events.push(`lock:${table}${/"customerId"/.test(sql) ? ":customer-wide" : ""}`);
          return undefined;
        }
        if (op === "invoice.findUnique" || op === "invoice.update") return invoice;
        return undefined;
      });
      return fn(tx);
    });
    const creditNotes = {
      settleOrderCreditsInTx: jest.fn().mockImplementation(async () => {
        events.push("settle");
        return { applied: 0, unapplied: 0 };
      }),
      autoApplyOldestCreditsInTx: jest.fn().mockImplementation(async () => {
        events.push("sweep");
        return { applied: 0, invoiceStatus: InvoiceStatus.SENT };
      }),
    };
    const module = await Test.createTestingModule({
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
          useValue: { isEmailConfigured: jest.fn().mockResolvedValue(true) },
        },
        { provide: InvoicePdfService, useValue: {} },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("false") } },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: AuthorizationGuardService, useValue: {} },
        { provide: CreditNotesService, useValue: creditNotes },
        { provide: MessagingService, useValue: { notifyEvent: jest.fn() } },
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
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = module.get(InvoicesService);
  });

  it("locks Order → Invoice, then the customer's notes (one pass), and only THEN runs settle and the sweep", async () => {
    await service.send(INVOICE_ID);

    // Exactly one note-lock pass in markSent itself (settle/sweep are mocked here), customer-wide.
    expect(events.filter((e) => e.startsWith("lock:CreditNote"))).toEqual([
      "lock:CreditNote:customer-wide",
    ]);
    expect(events.indexOf("lock:CreditNote:customer-wide")).toBeLessThan(events.indexOf("settle"));
    expect(events.indexOf("settle")).toBeLessThan(events.indexOf("sweep"));
    // SA-214: the Order and Invoice rows come before any note.
    expect(events.indexOf("lock:Order")).toBeLessThan(events.indexOf("lock:Invoice"));
    expect(events.lastIndexOf("lock:Invoice")).toBeLessThan(
      events.indexOf("lock:CreditNote:customer-wide"),
    );
  });
});
