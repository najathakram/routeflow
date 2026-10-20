/**
 * SA-827 (T2, F-API): the invoice display unit is snapshotted ONCE, at the DRAFT -> issued transition. It is RESOLVED outside
 * the money tx (resolveIssueDisplayUnits, a non-tx client) and WRITTEN inside it (writeIssueDisplayUnits, a savepoint).
 * Call sites: markSent, the inline flip in createInvoiceFromOrderWithTenant, recordDeliveryPaymentInTx (wasDraft); a revert
 * to draft clears. findOne reads the snapshot for an issued invoice (P4) but resolves live for a DRAFT.
 * Harness: invoices.send-settle.spec.ts.
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://files.example.test/invoice.pdf"),
  })),
}));
jest.mock("./invoice-display-unit", () => {
  const actual = jest.requireActual("./invoice-display-unit");
  return {
    ...actual,
    resolveLiveDisplayUnits: jest.fn(),
    resolveDraftIssueUnits: jest.fn(),
    itemsWithDisplayUnits: jest.fn(),
    resolveIssueDisplayUnits: jest.fn(),
    writeIssueDisplayUnits: jest.fn().mockResolvedValue(undefined),
    clearIssueDisplayUnits: jest.fn().mockResolvedValue(undefined),
  };
});

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
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

import {
  clearIssueDisplayUnits,
  itemsWithDisplayUnits,
  resolveDraftIssueUnits,
  resolveIssueDisplayUnits,
  writeIssueDisplayUnits,
} from "./invoice-display-unit";
import { AfterCommit } from "../common/after-commit";
import { fillSparseCasBasis } from "./testing/sparse-line-fixtures";

const INVOICE_ID = "inv-acme-1";
const CUSTOMER_ID = "cust-acme-1";
const TENANT_ID = "tenant-acme-1";
const UNITS = new Map([["it-1", { kind: "pieces" as const, label: "Piece" }]]);

const fixture = (status: InvoiceStatus) => ({
  id: INVOICE_ID,
  orderId: null as string | null,
  customerId: CUSTOMER_ID,
  tenantId: TENANT_ID,
  invoiceNumber: "INV-ACME-1",
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
    businessName: "Acme Wholesale",
    contactName: "Pat",
    email: "b@acme.test",
  },
  items: [
    {
      id: "it-1",
      productId: "p1",
      invoiceUnitLabel: "Piece",
      invoiceUnitFactor: 1 as number | null,
    },
  ],
  payments: [] as unknown[],
});

describe("InvoicesService display-unit wiring (SA-827)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    jest.clearAllMocks();
    (resolveIssueDisplayUnits as jest.Mock).mockResolvedValue(UNITS);
    (resolveDraftIssueUnits as jest.Mock).mockResolvedValue(UNITS);
    prisma = createMockPrisma();
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
        {
          provide: RegulatedLedgerService,
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            correctSaleForPriceChange: jest.fn(),
          },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
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
  });

  it("markSent on a DRAFT: resolves OUTSIDE the tx via resolveDraftIssueUnits, then writes INSIDE it for this invoice", async () => {
    const draft = fixture(InvoiceStatus.DRAFT);
    prisma.invoice.findUnique.mockResolvedValue(draft);
    prisma.invoice.update.mockResolvedValue({ ...draft, status: InvoiceStatus.SENT });
    await service.send(INVOICE_ID);
    expect(resolveDraftIssueUnits).toHaveBeenCalledTimes(1);
    const [readDb, invoiceId] = (resolveDraftIssueUnits as jest.Mock).mock.calls[0];
    expect(readDb).toBe(prisma.forTenant()); // a non-transaction client
    expect(invoiceId).toBe(INVOICE_ID);
    expect(writeIssueDisplayUnits).toHaveBeenCalledTimes(1);
    const [tx, id, units] = (writeIssueDisplayUnits as jest.Mock).mock.calls[0];
    expect(tx).not.toBe(prisma.forTenant());
    expect(typeof tx.$executeRaw).toBe("function"); // the tx client the mock tenantTransaction built
    expect(id).toBe(INVOICE_ID);
    expect(units).toBe(UNITS);
    // the resolve ran BEFORE the transaction opened
    expect((resolveDraftIssueUnits as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      prisma.tenantTransaction.mock.invocationCallOrder[0],
    );
  });

  it("markSent: a locked SENT row writes nothing even when units were resolved (a re-send never rewrites)", async () => {
    const sent = fixture(InvoiceStatus.SENT);
    prisma.invoice.findUnique.mockResolvedValue(sent);
    prisma.invoice.update.mockResolvedValue(sent);
    await service.send(INVOICE_ID);
    expect(resolveDraftIssueUnits).toHaveBeenCalledTimes(1);
    expect(writeIssueDisplayUnits).not.toHaveBeenCalled();
  });

  it("markSent: a DRAFT whose resolve returned null writes nothing", async () => {
    (resolveDraftIssueUnits as jest.Mock).mockResolvedValue(null);
    const draft = fixture(InvoiceStatus.DRAFT);
    prisma.invoice.findUnique.mockResolvedValue(draft);
    prisma.invoice.update.mockResolvedValue({ ...draft, status: InvoiceStatus.SENT });
    await service.send(INVOICE_ID);
    expect(writeIssueDisplayUnits).not.toHaveBeenCalled();
  });

  describe("recordDeliveryPaymentInTx (wasDraft)", () => {
    const payable = (status: InvoiceStatus) => [
      {
        id: INVOICE_ID,
        total: 100,
        status,
        dueDate: null,
        invoiceNumber: "INV-ACME-1",
        customerId: CUSTOMER_ID,
        tenantId: TENANT_ID,
      },
    ];
    const arm = (status: InvoiceStatus) => {
      prisma.invoice.findMany.mockResolvedValue(payable(status));
      prisma.invoice.findUnique.mockResolvedValue({ status });
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      prisma.paymentCounter.upsert.mockResolvedValue({ next: 2 });
      prisma.invoicePayment.create.mockResolvedValue({ id: "pay-x" });
      prisma.invoice.update.mockResolvedValue({});
    };
    const run = () =>
      (service as any).recordDeliveryPaymentInTx(prisma, new AfterCommit(), ["ord-1"], 100, "CASH");

    it("a finalized DRAFT resolves on a separate (non-tx) client and writes in the caller's tx", async () => {
      arm(InvoiceStatus.DRAFT);
      await run();
      expect(resolveIssueDisplayUnits).toHaveBeenCalledTimes(1);
      const [readDb, tenantId, invoiceId, , ownRowsDb] = (resolveIssueDisplayUnits as jest.Mock)
        .mock.calls[0];
      expect(readDb).toBe(prisma.forTenant());
      expect(tenantId).toBe(TENANT_ID);
      expect(invoiceId).toBe(INVOICE_ID);
      // the invoice's own rows are read through the caller's tx (it may have created them, uncommitted)
      expect(ownRowsDb).toBe(prisma);
      expect(writeIssueDisplayUnits).toHaveBeenCalledTimes(1);
      expect((writeIssueDisplayUnits as jest.Mock).mock.calls[0][0]).toBe(prisma); // the caller's tx
      expect((writeIssueDisplayUnits as jest.Mock).mock.calls[0][1]).toBe(INVOICE_ID);
      expect((writeIssueDisplayUnits as jest.Mock).mock.calls[0][2]).toBe(UNITS);
    });

    it("an already issued invoice makes zero resolve calls and no write", async () => {
      arm(InvoiceStatus.SENT);
      await run();
      expect(resolveIssueDisplayUnits).not.toHaveBeenCalled();
      expect(writeIssueDisplayUnits).not.toHaveBeenCalled();
    });
  });

  describe("revertInvoiceToDraft", () => {
    it("clears the snapshot inside the revert tx, so a re-issue snapshots afresh", async () => {
      const sent = fixture(InvoiceStatus.SENT);
      prisma.invoice.findUnique.mockResolvedValue(sent);
      prisma.invoicePayment.count.mockResolvedValue(0);
      prisma.invoice.update.mockResolvedValue({ ...sent, status: InvoiceStatus.DRAFT });
      await service.revertInvoiceToDraft(INVOICE_ID);
      expect(clearIssueDisplayUnits).toHaveBeenCalledTimes(1);
      const [tx, id] = (clearIssueDisplayUnits as jest.Mock).mock.calls[0];
      expect(typeof tx.$executeRaw).toBe("function");
      expect(id).toBe(INVOICE_ID);
    });
  });

  describe("createInvoiceFromOrderWithTenant inline DRAFT -> SENT flip", () => {
    it("resolves and writes with the same client (no tx), for the new invoice and the order's tenant", async () => {
      fillSparseCasBasis(); // #2645: the hand-built order line names only what this test needs
      prisma.orderItem.updateMany.mockResolvedValue({ count: 1 } as any); // #2070: the invoicedQty CAS matches
      jest
        .spyOn(service as any, "resolveTenantInvoiceDefaults")
        .mockResolvedValue({ notes: null, terms: null, timezone: null });
      jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-ISSUE");
      prisma.customer.findFirst.mockResolvedValue({
        isTaxExempt: false,
        defaultPaymentTerms: null,
        defaultDepositPercent: null,
      });
      prisma.tenantConfig.findUnique.mockResolvedValue(null);
      const cfg: Record<string, string> = {
        "invoice.depositDefaultPercent": "30",
        "invoice.depositCollectAtOrder": "true",
      };
      prisma.systemConfig.findFirst.mockImplementation((args: any) =>
        Promise.resolve(cfg[args?.where?.key] != null ? { value: cfg[args.where.key] } : null),
      );
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-issue",
        customerId: "cust-1",
        orderNumber: "ORD-ISSUE",
        subtotal: 100,
        tax: 0,
        status: "PENDING",
        lineItems: [
          {
            id: "li-1",
            productId: "p1",
            name: null,
            qty: 2,
            invoicedQty: 0,
            unitPrice: 50,
            originalPrice: null,
            priceType: "STANDARD",
            product: { name: "Widget", unitsPerBox: 0 },
          },
        ],
      });
      let row: any;
      prisma.invoice.create.mockImplementation((args: any) => {
        row = { id: "inv-issue-1", ...args.data, items: [], payments: [], customer: {} };
        return Promise.resolve(row);
      });
      prisma.invoice.update.mockImplementation((args: any) => {
        row = { ...row, ...args.data };
        return Promise.resolve(row);
      });

      const out = (await service.createInvoiceFromOrderWithTenant("ord-issue", TENANT_ID)) as any[];

      expect(out[0].status).toBe(InvoiceStatus.SENT);
      expect(resolveIssueDisplayUnits).toHaveBeenCalledTimes(1);
      const [readDb, tenantId, invoiceId] = (resolveIssueDisplayUnits as jest.Mock).mock.calls[0];
      expect(tenantId).toBe(TENANT_ID);
      expect(invoiceId).toBe("inv-issue-1");
      expect(writeIssueDisplayUnits).toHaveBeenCalledTimes(1);
      const [writeDb, id, units] = (writeIssueDisplayUnits as jest.Mock).mock.calls[0];
      expect(writeDb).toBe(readDb); // the same client: no tx, so no savepoint
      expect(id).toBe("inv-issue-1");
      expect(units).toBe(UNITS);
    });
  });

  const findOneOf = (status: InvoiceStatus) => {
    const inv = { ...fixture(status), dueDate: null, order: null };
    (prisma as any).invoice.findUnique.mockResolvedValue(inv);
    return service.findOne(INVOICE_ID) as unknown as Promise<{
      items: Array<{ displayUnit: { kind: string; label: string | null } }>;
    }>;
  };

  it("findOne hands the invoice's status/tenant/customer to itemsWithDisplayUnits and returns its items (P4 lives in the unit spec)", async () => {
    const resolved = [{ id: "it-1", displayUnit: { kind: "pieces", label: "Piece" } }];
    (itemsWithDisplayUnits as jest.Mock).mockResolvedValue(resolved);
    const out = await findOneOf(InvoiceStatus.SENT);
    expect(itemsWithDisplayUnits).toHaveBeenCalledTimes(1);
    const [readDb, inv] = (itemsWithDisplayUnits as jest.Mock).mock.calls[0];
    expect(readDb).toBe(prisma.forTenant());
    expect(inv).toMatchObject({
      status: InvoiceStatus.SENT,
      tenantId: TENANT_ID,
      customerId: CUSTOMER_ID,
    });
    expect(inv.items.map((i: { id: string }) => i.id)).toEqual(["it-1"]);
    expect(out.items).toBe(resolved);
  });

  it("findOne on a DRAFT passes the DRAFT status through (the live preference is resolved inside the helper)", async () => {
    (itemsWithDisplayUnits as jest.Mock).mockResolvedValue([]);
    await findOneOf(InvoiceStatus.DRAFT);
    expect((itemsWithDisplayUnits as jest.Mock).mock.calls[0][1].status).toBe(InvoiceStatus.DRAFT);
  });
});
