// SA-1141 / W-989 PR-2: the document's own discount tax base, threaded through the api (cases 8-13). The cutover constant is
// set here (a past instant), exactly as the flip will set it; production stays `null` (dark). Own file: the invoice specs sit on the size ratchet.
let mockFrom: Date | null = null;
jest.mock("@routeflow/pricing", () => ({
  ...jest.requireActual("@routeflow/pricing"),
  get DISCOUNT_PRE_TAX_FROM() {
    return mockFrom;
  },
}));
jest.mock("../auth/permissions/price-edit", () => ({
  priceEditAllowedFor: jest.fn().mockResolvedValue(true),
}));
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

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
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { planHeaderOnlyTotals } from "./locked-invoice-edit";
import { finalizeOrderRecompute } from "./finalize-order-recompute";
import { refundableLineShare } from "@routeflow/pricing";

const CUTOVER = new Date("2026-12-01T00:00:00Z");
const BEFORE = new Date("2026-11-20T12:00:00Z");
const AFTER = new Date("2026-12-05T12:00:00Z");

beforeEach(() => {
  mockFrom = CUTOVER;
});
afterAll(() => {
  mockFrom = null;
});

// A stored 100 @10% invoice with discount 20 (shipping 0), tax as the named mode stored it.
const lockedInvoice = (
  tax: number,
  rows: { createdAt: Date; order?: { createdAt: Date } | null; orderId?: string | null },
) => ({
  invoice: {
    id: "inv-1",
    status: "DRAFT",
    subtotal: 100,
    taxAmount: tax,
    discount: 20,
    shippingFee: 0,
    total: 100 - 20 + tax,
    orderId: rows.orderId ?? null,
    createdAt: rows.createdAt,
    order: rows.order ?? null,
    estimate: null,
  },
  storedRows: [{ id: "li-1", subtotal: 100, taxRate: 0.1, categoryTaxAmount: 0 }],
  isTaxExempt: false,
  payments: [],
  orderInvoiceCount: null,
});

describe("case 8: a new invoice's tax comes off the discounted base", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({ items: [] });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        {
          provide: EmailService,
          useValue: { sendInvoice: jest.fn(), isEmailConfigured: jest.fn() },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn(), getAll: jest.fn().mockResolvedValue({}), set: jest.fn() },
        },
        {
          provide: RegulatedLedgerService,
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
          },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        {
          provide: CreditNotesService,
          useValue: {
            autoApplyOldestCreditsInTx: jest
              .fn()
              .mockResolvedValue({ applied: 0, invoiceStatus: null }),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") },
        },
      ],
    }).compile();
    service = module.get(InvoicesService);
  });

  const create = async () => {
    const customer = { id: "cust-1", businessName: "Acme", pricingTier: 1, isTaxExempt: false };
    prisma.customer.findUnique.mockResolvedValue(customer);
    prisma.product.findMany.mockResolvedValue([]);
    jest
      .spyOn(service as any, "resolveTenantInvoiceDefaults")
      .mockResolvedValue({ notes: null, terms: null });
    prisma.invoice.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "inv-1", ...args.data, customer, items: [], payments: [] }),
    );
    await service.create({
      customerId: "cust-1",
      discount: 20,
      items: [{ description: "A", unitPrice: 100, qty: 1, taxRate: 0.1 }],
    } as any);
    return prisma.invoice.create.mock.calls[0][0].data;
  };

  it("PRE_TAX (the cutover is in the past): tax 8, total 88", async () => {
    mockFrom = new Date("2020-01-01T00:00:00Z");
    const data = await create();
    expect({ tax: Number(data.taxAmount), total: Number(data.total) }).toEqual({
      tax: 8,
      total: 88,
    });
  });

  it("dark (the cutover is null): master's 10 / 90", async () => {
    mockFrom = null;
    const data = await create();
    expect({ tax: Number(data.taxAmount), total: Number(data.total) }).toEqual({
      tax: 10,
      total: 90,
    });
  });
});

describe("cases 9, 10, 13: the stored-row guard reads the row's own mode (R6, R4)", () => {
  const patch = (l: ReturnType<typeof lockedInvoice>) =>
    planHeaderOnlyTotals(l as any, { shippingFee: 5 });

  it("9: a LEGACY invoice (tax 10, created before the cutover) is not stale; same totals as master", () => {
    expect(patch(lockedInvoice(10, { createdAt: BEFORE }))).toMatchObject({ total: 95 });
  });

  it("10: a PRE_TAX invoice (tax 8, created after the cutover) is not stale; tax stays 8", () => {
    expect(patch(lockedInvoice(8, { createdAt: AFTER }))).toMatchObject({ total: 93 });
  });

  it("13: an invoice cut after the cutover from an order made before it keeps the ORDER's LEGACY mode", () => {
    const l = lockedInvoice(10, { createdAt: AFTER, orderId: "o1", order: { createdAt: BEFORE } });
    expect(patch(l)).toMatchObject({ total: 95 });
  });

  it("a PRE_TAX header edit that moves the discount (20 to 30) re-derives the tax with it: 7, total 77", () => {
    const out = planHeaderOnlyTotals(lockedInvoice(8, { createdAt: AFTER }) as any, {
      discount: 30,
    });
    expect(out).toMatchObject({ discount: 30, taxAmount: 7, total: 77 });
  });

  it("a LEGACY header edit writes no tax (master's shape): discount, fee and total only", () => {
    const out = planHeaderOnlyTotals(lockedInvoice(10, { createdAt: BEFORE }) as any, {
      discount: 30,
    });
    expect(out).toEqual({ discount: 30, shippingFee: 0, total: 80, subtotal: 100 });
  });

  it("an order-linked invoice loaded without its order is refused, never given a silent mode", () => {
    const l = lockedInvoice(8, { createdAt: AFTER, orderId: "o1" });
    delete (l.invoice as any).order;
    expect(() => patch(l)).toThrow(/without its order/);
  });
});

describe("cases 11, 13: the order recompute infers its rate off the mode's base", () => {
  const run = async (order: any) => {
    const written: any[] = [];
    const db: any = {
      orderItem: { update: async () => ({}) },
      order: { update: async (a: any) => written.push(a.data) },
    };
    const base = { db, orderId: "o1", unbilled: new Map(), subtotal: 100, categoryTaxSum: 0 };
    const deliveredBasis = { hasMutations: false, byLineId: new Map() };
    const invoices = [{ discount: 20, shippingFee: 0 }];
    const first = await finalizeOrderRecompute({ ...base, order, deliveredBasis, invoices });
    const second = await finalizeOrderRecompute({
      ...base,
      order: { ...order, tax: first.tax },
      deliveredBasis,
      invoices,
    });
    return [first.tax, second.tax];
  };

  it("11: a PRE_TAX order (100 @10%, discount 20, tax 8) stays at 8 after each run", async () => {
    expect(await run({ subtotal: 100, tax: 8, discountAmount: 20, createdAt: AFTER })).toEqual([
      8, 8,
    ]);
  });

  it("13: a LEGACY order (tax 10) keeps its tax even though its invoice came after the cutover", async () => {
    expect(await run({ subtotal: 100, tax: 10, discountAmount: 20, createdAt: BEFORE })).toEqual([
      10, 10,
    ]);
  });
});

describe("case 12: the refund split of a PRE_TAX invoice equals what it charged (fixture C)", () => {
  it("both lines refunded in full sum to the invoice total 187.43", () => {
    const invoice = {
      taxAmount: 7.43,
      discount: 20,
      lines: [
        { id: "a", subtotal: 100, qty: 1, taxRate: 0.0825, categoryTaxAmount: 0, isNsf: false },
        { id: "b", subtotal: 100, qty: 1, taxRate: 0, categoryTaxAmount: 0, isNsf: false },
      ],
    };
    const prior = { qty: 0, net: 0, tax: 0, categoryTax: 0 };
    const a = refundableLineShare({ invoice, lineId: "a", returnedQty: 1, prior });
    const b = refundableLineShare({ invoice, lineId: "b", returnedQty: 1, prior });
    expect([a.total, b.total]).toEqual([97.43, 90]);
    expect(Math.round((a.total + b.total) * 100) / 100).toBe(187.43);
  });
});
