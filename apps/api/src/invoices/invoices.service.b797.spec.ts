/**
 * B797 — findOne's orderHasUnitAwareLine flag.
 *
 * Split out of invoices.service.spec.ts (not merged into it) per the repo's size ratchet
 * (`common/size-ratchet.spec.ts` — that file is one of the 15 tracked giants and may not grow;
 * origin/master's copy is already at its exact baseline+headroom ceiling). Same bootstrap
 * pattern as the main spec file and invoices.service.b653.spec.ts; duplicated deliberately
 * rather than shared, so this file stays self-contained and small.
 *
 * recomputeOrderFromInvoices back-syncs an edit onto the linked order's unit-aware line even
 * when the invoice's own items carry no unitLabel, so findOne must surface an existence-only
 * flag both clients can check.
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
import { InvoiceStatus } from "@prisma/client";

describe("InvoicesService — B797 (orderHasUnitAwareLine)", () => {
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
    prisma.invoicePayment.findMany.mockResolvedValue([]);
    prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
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
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  const baseInv = (over: Record<string, unknown>) => ({
    status: InvoiceStatus.DRAFT,
    total: 100,
    dueDate: null,
    payments: [],
    items: [],
    ...over,
  });

  // Consolidated from 4 tests to 3 (redundant fixture setups merged); every original
  // case is still asserted. Case coverage by test:
  //  - "order-only"  (order has one, invoice's own items don't) -> true,      1st test
  //  - "existing"    (invoice's own items ALSO have one)        -> true,      2nd test
  //  - "none"        (neither invoice's own items nor the order)-> false,     3rd test (part 1)
  //  - "unlisted"    (manual invoice, no linked order at all)   -> false,     3rd test (part 2)
  //  - never leaks the order's raw lineItems onto the response  -> asserted,  1st test
  //  - the where clause matches unit-aware-guard.ts's own def   -> asserted,  1st test

  it("order-only: true when the order has a live unit-aware line (own items don't) — never leaks the raw lines", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInv({
        id: "inv-1",
        items: [{ id: "item-1", unitLabel: null }],
        order: { status: "PENDING", orderNumber: "ORD-1", lineItems: [{ id: "oi-unit-1" }] },
      }),
    );
    const res = await service.findOne("inv-1");
    expect((res as any).orderHasUnitAwareLine).toBe(true);
    expect((res as any).order).toEqual({ status: "PENDING", orderNumber: "ORD-1" });
    expect((res as any).order.lineItems).toBeUndefined();
    // Matches unit-aware-guard.ts's own definition: a live (not CANCELLED) line.
    const includeArg = (prisma.invoice.findUnique as jest.Mock).mock.calls[0][0].include;
    expect(includeArg.order.select.lineItems.where).toEqual({
      unitLabel: { not: null },
      status: { not: "CANCELLED" },
    });
  });

  it("existing: still true when the invoice's own items ALSO have a unit-aware line", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInv({
        id: "inv-existing",
        items: [{ id: "item-1", unitLabel: "Case" }],
        order: { status: "PENDING", orderNumber: "ORD-E", lineItems: [{ id: "oi-unit-e" }] },
      }),
    );
    expect(((await service.findOne("inv-existing")) as any).orderHasUnitAwareLine).toBe(true);
  });

  it("none / unlisted: false with no live unit-aware line on the order, or no linked order at all", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      baseInv({ id: "inv-2", order: { status: "PENDING", orderNumber: "ORD-2", lineItems: [] } }),
    );
    expect(((await service.findOne("inv-2")) as any).orderHasUnitAwareLine).toBe(false);

    prisma.invoice.findUnique.mockResolvedValue(baseInv({ id: "inv-3", order: null }));
    expect(((await service.findOne("inv-3")) as any).orderHasUnitAwareLine).toBe(false);
  });
});
