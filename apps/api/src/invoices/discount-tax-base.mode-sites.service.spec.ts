// SA-1153 (W-989 PR-2, round 3), the service-driven rows, through the public methods with the cutover SET (the harness):
//   row 10 invoice detail (R7), row 11 the DRAFT items edit's re-total (R6; (a) order source, (b) estimate source), rows 12 + 13
//   duplicate (the SOURCE's inference and the copy's own base). Same two assertions per row as discount-tax-base.mode-sites.spec.ts:
//   the fixture discriminates, and the written figure for a LEGACY source equals the same call with the cutover NULL.
import {
  AFTER,
  BEFORE,
  FIXTURE,
  expectFixtureDiscriminates,
  fixtureTotals,
  settled,
  underCutover,
  withDiscountCutover,
} from "../common/testing/discount-cutover";
import { MoneyInvariantError } from "@routeflow/pricing";

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../common/db-locks", () => require("../common/testing/pass-through-locks").locks());
jest.mock("../auth/permissions/price-edit", () => ({
  priceEditAllowedFor: jest.fn().mockResolvedValue(true),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { InvoiceStatus } from "@prisma/client";
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
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

describe("SA-1153 service rows 10, 11, 12+13 (cutover set)", () => {
  withDiscountCutover();
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let rows: Array<Record<string, any>>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({ items: [] }); // units_v1 guard reads the parent invoice
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
          useValue: { sendInvoice: jest.fn(), isEmailConfigured: jest.fn() },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn(), set: jest.fn() } },
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
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: NumberingService,
          useValue: {
            reserveNext: jest.fn().mockResolvedValue("INV-2026-0001"),
            reserveNextTx: jest.fn().mockResolvedValue("INV-2026-0001"),
          },
        },
      ],
    }).compile();
    service = module.get(InvoicesService);
  });

  /** A stored 100 @10% invoice with discount 20 (LEGACY tax 10), the relations a loader selects carried on it. */
  const arm = (header: Record<string, any>, lines: Array<Record<string, any>>) => {
    rows = lines.map((l) => ({ ...l }));
    const invoice = {
      id: "inv-1",
      tenantId: "t-1",
      invoiceNumber: "INV-1",
      customerId: "cust-1",
      status: InvoiceStatus.DRAFT,
      createdAt: AFTER,
      subtotal: 100,
      taxAmount: 10,
      discount: FIXTURE.discount,
      shippingFee: 0,
      total: 90,
      dueDate: null,
      payments: [],
      customer: { id: "cust-1", businessName: "Acme" },
      orderId: null,
      order: null,
      estimate: null,
      ...header,
      items: rows.map((r) => ({ ...r })),
    };
    prisma.invoice.findUnique.mockResolvedValue(invoice);
    prisma.invoice.update.mockResolvedValue({ id: "inv-1", items: [] });
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.order.findFirst.mockResolvedValue({ lineItems: [] }); // the units guard reads the linked order
    prisma.invoiceItem.update.mockImplementation(async ({ where, data }: any) =>
      Object.assign(rows.find((r) => r.id === where.id) ?? {}, data),
    );
    prisma.invoiceItem.findMany.mockImplementation(async () => rows.map((r) => ({ ...r })));
    return invoice;
  };
  const line = (id: string, subtotal: number, taxRate: number) => ({
    id,
    productId: null,
    description: "Widget",
    qty: 1,
    unitPrice: subtotal,
    subtotal,
    discount: 0,
    taxRate,
    categoryTaxAmount: 0,
  });
  const written = () => {
    const d = prisma.invoice.update.mock.calls[0][0].data;
    return { subtotal: d.subtotal, taxAmount: d.taxAmount, total: d.total };
  };

  describe("row 11: invoices.service.ts:3153, the DRAFT items edit's re-total reads the invoice's OWN mode", () => {
    const edit = async (header: Record<string, any>) => {
      prisma.invoice.update.mockClear();
      arm({ status: InvoiceStatus.DRAFT, ...header }, [line("li-1", 100, FIXTURE.rate)]);
      // the price of the one line goes 100 -> 110, so the tax moves with the base the mode names
      await service.update("inv-1", {
        items: [
          { id: "li-1", description: "Widget", qty: 1, unitPrice: 110, taxRate: FIXTURE.rate },
        ],
      });
      return written();
    };
    const expectKeepsLegacy = async (run: (at: Date) => Promise<unknown>) => {
      expectFixtureDiscriminates();
      const dark = await underCutover(null, () => run(BEFORE)); // the cutover-null run
      expect(await settled(() => run(AFTER))).not.toEqual(dark); // 1: a PRE_TAX-dated source writes a different re-total (or is refused as stale)
      expect(await run(BEFORE)).toEqual(dark); // 2: a LEGACY-dated source keeps master's re-total
    };

    it("(a) an invoice cut NOW from an order created BEFORE the cutover re-totals as the cutover-null run", async () => {
      await expectKeepsLegacy(
        (at) =>
          edit({
            orderId: "o-1",
            deliveryBatchId: "b-1",
            order: { createdAt: at, status: "CONFIRMED" },
          }), // a shipment invoice: not an order mirror
      );
    });

    it("(b) an invoice converted NOW from an estimate created BEFORE the cutover re-totals the same (EST resolution on a re-total)", async () => {
      await expectKeepsLegacy((at) => edit({ estimate: { createdAt: at } }));
    });

    it("(b) with the estimate relation left out the invoice is refused, never given the new-document mode (guard G)", async () => {
      prisma.invoice.update.mockClear();
      arm({ status: InvoiceStatus.DRAFT }, [line("li-1", 100, FIXTURE.rate)]);
      const inv = await prisma.invoice.findUnique({ where: { id: "inv-1" } });
      delete (inv as any).estimate; // a loader that did not select the back-relation
      prisma.invoice.findUnique.mockResolvedValue(inv);
      await expect(
        service.update("inv-1", {
          items: [
            { id: "li-1", description: "Widget", qty: 1, unitPrice: 110, taxRate: FIXTURE.rate },
          ],
        }),
      ).rejects.toBeInstanceOf(MoneyInvariantError);
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });
  });

  describe("row 10: invoices.service.ts:2990, the invoice detail carries the OWN mode (R7)", () => {
    const detail = async (at: Date) => {
      arm({ orderId: "o-1", order: { createdAt: at, status: "CONFIRMED" } }, []);
      const out = (await service.findOne("inv-1")) as { discountTaxBase: string };
      return out.discountTaxBase;
    };

    it("an invoice whose order was created BEFORE the cutover reads LEGACY_POST_TAX, as the cutover-null run", async () => {
      expectFixtureDiscriminates();
      const dark = await underCutover(null, () => detail(BEFORE));
      expect(await detail(AFTER)).toBe("PRE_TAX"); // 1: the discriminator: a PRE_TAX-dated order reads PRE_TAX
      expect(await detail(BEFORE)).toBe(dark); // 2: the BEFORE order equals the null run ...
      expect(dark).toBe("LEGACY_POST_TAX"); // ... which is LEGACY
    });
  });

  describe("rows 12 + 13: invoices.service.ts:4079 (the SOURCE's inference) and :4097 (the duplicate's own base)", () => {
    // RF-011: an order-linked invoice cannot be duplicated (the order is the billing source), so the source here is an
    // ESTIMATE-converted invoice whose quote was made BEFORE the cutover (OWN resolves to the quote). Legacy shape (B294): every line
    // at rate 0 with a real tax 10 on 100 less discount 20: the rate is INFERRED on the source's base (LEGACY 10/100 = 0.10, PRE_TAX
    // 10/80 = 0.125), then the copy, a NEW document, is totalled on the new-document base.
    const copyOf = async (at: Date) => {
      prisma.invoice.create.mockClear();
      arm({ status: InvoiceStatus.SENT, estimate: { createdAt: at } }, [line("li-1", 100, 0)]);
      prisma.invoice.create.mockImplementation(async (a: any) => ({
        id: "copy-1",
        ...a.data,
        items: [],
      }));
      await service.duplicate("inv-1");
      const d = prisma.invoice.create.mock.calls[0][0].data;
      return {
        rates: (d.items.create as any[]).map((i) => Number(i.taxRate)),
        taxAmount: d.taxAmount,
        total: d.total,
      };
    };

    it("the rate is inferred on the source's LEGACY base and the copy's tax is the PRE_TAX figure at that rate", async () => {
      expectFixtureDiscriminates();
      const dark = await underCutover(null, () => copyOf(BEFORE)); // everything LEGACY: rate 0.10, tax = master's
      const preTaxSource = await copyOf(AFTER); // a PRE_TAX-dated source infers a DIFFERENT rate
      expect(preTaxSource.rates).not.toEqual(dark.rates); // row 12 discriminates
      const live = await copyOf(BEFORE);
      expect(live.rates).toEqual(dark.rates); // 12: the source's inference stayed on its LEGACY base
      expect(live.taxAmount).toBe(fixtureTotals("PRE_TAX").tax); // 13: the copy is a NEW document: PRE_TAX at that rate
      expect(live.total).toBe(fixtureTotals("PRE_TAX").total);
      expect(live.taxAmount).not.toBe(dark.taxAmount); // 13 discriminates: the dark copy is LEGACY
    });
  });
});
