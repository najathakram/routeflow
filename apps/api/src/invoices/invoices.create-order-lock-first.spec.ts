/**
 * SA-706 MUST 1 (B1052 review) — an invoice creation that owns its transaction takes the ORDER row
 * lock as its FIRST statement, before the invoice INSERT.
 *
 * The invoice's `orderId` foreign key takes KEY SHARE on the Order; `settleOrderCreditsInTx`'s first
 * statement then upgrades it to FOR UPDATE. Two such transactions (two partial creates, or one
 * against Mark Delivered's own settle) each hold KEY SHARE and wait on the other's upgrade: a 40P01
 * deadlock that surfaced as an uncoded 500. Pins the statement ORDER of createPartialFromOrder and
 * createSplitInvoices (via createInvoiceFromOrder); it goes red if the up-front lock is dropped or
 * moved after the insert. The real two-connection proof is invoices/order-lock-first-sa706.db.spec.ts.
 *
 * Bootstrap duplicated from invoices.service.b760.spec.ts (the repo's size-ratchet keeps the big
 * specs from growing).
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
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { fillSparseCasBasis } from "./testing/sparse-line-fixtures";
import { createOpLogTx } from "../testing/op-log-tx";

describe("InvoicesService — the Order row is locked before an invoice is inserted (SA-706)", () => {
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
    fillSparseCasBasis(); // #2645: sparse order fixtures vs the CAS basis pin
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
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
        entitlementAuthorityFromEntitlements, // #2241: EntitlementAuthority
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  const oi = {
    id: "oi-sa706",
    productId: "p-1",
    qty: 10,
    invoicedQty: 0,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitPrice: 10,
    subtotal: 100,
    product: { name: "Widget", unitsPerBox: null },
  };
  const order = {
    id: "ord-sa706",
    customerId: "cust-1",
    orderNumber: "ORD-SA706",
    subtotal: 100,
    tax: 0,
    shippingFee: 0,
    lineItems: [oi],
  };

  /** Every statement a self-owned creation tx issues, in order: `lock:Order`, `invoice.create`, … */
  let ops: string[];
  const ownTx = () =>
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      const { tx } = createOpLogTx((op, args) => {
        if (op === "$executeRaw" || op === "$queryRaw") {
          ops.push(`lock:${/FROM "(\w+)"/.exec(args.sql)?.[1] ?? "?"}`);
          return undefined;
        }
        ops.push(op);
        if (op === "invoice.create")
          return { ...args.data, id: "inv-new", items: [], payments: [], customer: {} };
        if (op === "orderItem.updateMany") return { count: 1 };
        return undefined;
      });
      return fn(tx);
    });

  beforeEach(() => {
    ops = [];
    ownTx();
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false } as any);
    prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.deliveryMutation.findMany.mockResolvedValue([]);
  });

  const firstWrite = () => ops.findIndex((o) => o === "invoice.create");

  it("createPartialFromOrder: the Order lock is the FIRST statement, ahead of the invoice insert", async () => {
    await service.createPartialFromOrder("ord-sa706", {
      items: [{ orderItemId: "oi-sa706", qty: 4 }],
    } as any);

    expect(firstWrite()).toBeGreaterThan(0);
    expect(ops[0]).toBe("lock:Order");
    expect(ops.filter((o) => o === "lock:Order")).toHaveLength(1);
  });

  it("createInvoiceFromOrder (createSplitInvoices, own tx): the Order lock is FIRST, ahead of the insert", async () => {
    await service.createInvoiceFromOrder("ord-sa706");

    expect(firstWrite()).toBeGreaterThan(0);
    expect(ops[0]).toBe("lock:Order");
    expect(ops.filter((o) => o === "lock:Order")).toHaveLength(1);
  });

  it("createInvoiceFromOrder inside a CALLER's tx (the delivery path) adds no lock of its own", async () => {
    const { tx, log } = createOpLogTx((op, args) => {
      if (op === "order.findUnique") return order;
      if (op === "customer.findFirst") return { isTaxExempt: false };
      if (op === "invoice.aggregate") return { _sum: { shippingFee: 0 } };
      if (op === "invoice.create")
        return { ...args.data, id: "inv-new", items: [], payments: [], customer: {} };
      if (op === "orderItem.updateMany") return { count: 1 };
      return undefined;
    });

    await service.createInvoiceFromOrder("ord-sa706", tx);

    expect(log.some((e) => e.op === "invoice.create")).toBe(true);
    expect(log.filter((e) => e.op === "$executeRaw" && /FROM "Order"/.test(e.sql ?? ""))).toEqual(
      [],
    );
  });
});
