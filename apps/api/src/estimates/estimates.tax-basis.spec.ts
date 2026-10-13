import { Test } from "@nestjs/testing";
import { EstimatesService } from "./estimates.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * H5 (owner ruling 2026-10-13, SA): an estimate carries tax the way an invoice does - the tenant rate
 * (`settings.taxRate`, a percent) and the customer's exempt flag - instead of always being untaxed; converting it
 * RE-TAKES the current basis (today's rate and exempt flag) and reports the tax delta against the quote; a typed
 * override unit price goes through roundMoney.
 */
describe("EstimatesService - H5 estimates carry tax", () => {
  let service: EstimatesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const echoInvoice = (id: string, args: any) => ({
    id,
    ...args.data,
    items: (args.data.items?.create ?? []).map((c: any, i: number) => ({
      id: `${id}-ii-${i}`,
      ...c,
    })),
    customer: {},
  });

  const setTenantRate = (percent: string | null) =>
    (prisma as any).systemConfig.findFirst.mockResolvedValue(
      percent == null ? null : { value: percent },
    );

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        EstimatesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") },
        },
        { provide: RegulatedLedgerService, useValue: { writeSaleEntries: jest.fn() } },
      ],
    }).compile();
    service = mod.get(EstimatesService);
    prisma.estimate.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "est-h5", ...args.data }),
    );
  });

  describe("create()", () => {
    const lines = [
      { description: "A", unitPrice: 10, qty: 3 }, // 30.00
      { description: "B", unitPrice: 20.55, qty: 1 }, // 20.55
    ];

    it("taxes the quote at the tenant rate: taxAmount = round(subtotal x rate), total includes it", async () => {
      setTenantRate("8.25");
      prisma.customer.findUnique.mockResolvedValue({
        id: "c1",
        pricingTier: 1,
        isTaxExempt: false,
      });

      await service.create({ customerId: "c1", items: lines } as any);

      const data = prisma.estimate.create.mock.calls[0][0].data;
      expect(data.subtotal).toBe(50.55);
      expect(data.taxAmount).toBe(4.17); // 50.55 x 0.0825 = 4.170375
      expect(data.total).toBe(54.72);
    });

    it("an exempt customer's estimate is untaxed", async () => {
      setTenantRate("8.25");
      prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 1, isTaxExempt: true });

      await service.create({ customerId: "c1", items: lines } as any);

      const data = prisma.estimate.create.mock.calls[0][0].data;
      expect(data.taxAmount).toBe(0);
      expect(data.total).toBe(50.55);
    });

    it("a tenant with no rate configured stays untaxed (nothing to apply)", async () => {
      setTenantRate(null);
      prisma.customer.findUnique.mockResolvedValue({
        id: "c1",
        pricingTier: 1,
        isTaxExempt: false,
      });

      await service.create({ customerId: "c1", items: lines } as any);

      const data = prisma.estimate.create.mock.calls[0][0].data;
      expect(data.taxAmount).toBe(0);
      expect(data.total).toBe(50.55);
    });

    it("the tax is summed unrounded across lines and rounded once (the invoice rule), not per line", async () => {
      setTenantRate("10");
      prisma.customer.findUnique.mockResolvedValue({
        id: "c1",
        pricingTier: 1,
        isTaxExempt: false,
      });

      await service.create({
        customerId: "c1",
        items: [
          { description: "x", unitPrice: 0.05, qty: 1 },
          { description: "y", unitPrice: 0.05, qty: 1 },
        ],
      } as any);

      const data = prisma.estimate.create.mock.calls[0][0].data;
      expect(data.taxAmount).toBe(0.01); // round(0.10 x 0.10) once = 0.01; per line it would be 0.01 + 0.01 = 0.02
    });

    it("a typed override unit price goes through roundMoney (a catalog product and a freeform line)", async () => {
      setTenantRate("0");
      prisma.customer.findUnique.mockResolvedValue({
        id: "c1",
        pricingTier: 1,
        isTaxExempt: false,
      });
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", name: "P", unitsPerBox: null, pricePerUnit: 10, tier1: 10 },
      ]);

      await service.create({
        customerId: "c1",
        items: [
          { productId: "p1", qty: 1, unitPrice: 9.994 },
          { description: "free", qty: 2, unitPrice: 4.005 },
        ],
      } as any);

      const items = prisma.estimate.create.mock.calls[0][0].data.items.create;
      expect(items[0].unitPrice).toBe(9.99);
      expect(items[1].unitPrice).toBe(4.01);
      expect(items[1].subtotal).toBe(8.02);
    });
  });

  describe("convertToInvoice() re-takes the current basis", () => {
    const estimateRow = (over: Record<string, unknown> = {}) => ({
      id: "est-h5",
      status: "ACCEPTED",
      customerId: "c1",
      customer: { isTaxExempt: false },
      subtotal: 100,
      taxAmount: 5, // quoted at 5%
      discount: 0,
      total: 105,
      notes: null,
      terms: null,
      items: [{ description: "Widget", productId: null, qty: 2, unitPrice: 50, subtotal: 100 }],
      ...over,
    });

    beforeEach(() => {
      prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve(echoInvoice("inv-h5", args)),
      );
    });

    it("a rate that rose since the quote: the invoice is taxed at TODAY's rate and the delta is reported", async () => {
      setTenantRate("8");
      prisma.estimate.findUnique.mockResolvedValue(estimateRow());

      const inv: any = await service.convertToInvoice("est-h5");

      const data = prisma.invoice.create.mock.calls[0][0].data;
      expect(data.items.create[0].taxRate).toBeCloseTo(0.08, 4);
      expect(data.taxAmount).toBe(8);
      expect(data.total).toBe(108);
      expect(inv.taxBasis).toEqual({
        quotedTax: 5,
        currentTax: 8,
        delta: 3,
        changed: true,
        quotedRate: 0.05,
        currentRate: 0.08,
      });
    });

    it("an unchanged rate reports no change", async () => {
      setTenantRate("5");
      prisma.estimate.findUnique.mockResolvedValue(estimateRow());

      const inv: any = await service.convertToInvoice("est-h5");

      expect(prisma.invoice.create.mock.calls[0][0].data.taxAmount).toBe(5);
      expect(inv.taxBasis).toMatchObject({ delta: 0, changed: false, quotedTax: 5, currentTax: 5 });
    });

    it("a customer who became exempt since the quote converts untaxed and shows the negative delta", async () => {
      setTenantRate("5");
      prisma.estimate.findUnique.mockResolvedValue(
        estimateRow({ customer: { isTaxExempt: true } }),
      );

      const inv: any = await service.convertToInvoice("est-h5");

      const data = prisma.invoice.create.mock.calls[0][0].data;
      expect(data.items.create[0].taxRate).toBe(0);
      expect(data.taxAmount).toBe(0);
      expect(inv.taxBasis).toMatchObject({ quotedTax: 5, currentTax: 0, delta: -5, changed: true });
    });

    it("a legacy untaxed estimate (taxAmount 0) converts at today's rate and says so", async () => {
      setTenantRate("5");
      prisma.estimate.findUnique.mockResolvedValue(estimateRow({ taxAmount: 0, total: 100 }));

      const inv: any = await service.convertToInvoice("est-h5");

      expect(prisma.invoice.create.mock.calls[0][0].data.taxAmount).toBe(5);
      expect(inv.taxBasis).toMatchObject({ quotedTax: 0, currentTax: 5, delta: 5, changed: true });
    });
  });
});
