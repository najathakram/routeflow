// SA-1153 (W-989 PR-2, round 3), rows 2 and 3, with the cutover SET (the harness; its CUTOVER is in the past of the real clock,
// which is what the old spec's 2026-12-01 was not: a swap to `newDocumentDiscountMode()` then still read LEGACY and stayed green):
//   row 2  estimates.service.ts:384  the quote detail's `discountTaxBase` reads the quote's OWN mode (R7)
//   row 3  estimates.service.ts:585  convert to invoice takes the ESTIMATE's mode (the quoted tax does not move)
// Row 1 (:291, create quote: NEW) is structural only (the pin).
import {
  AFTER,
  BEFORE,
  FIXTURE,
  expectFixtureDiscriminates,
  fixtureTotals,
  underCutover,
  withDiscountCutover,
} from "../common/testing/discount-cutover";
import { Test } from "@nestjs/testing";
import { EstimatesService } from "./estimates.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

describe("SA-1153 estimate rows 2 and 3 (cutover set)", () => {
  withDiscountCutover();
  let service: EstimatesService;
  let prisma: ReturnType<typeof createMockPrisma>;

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
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") },
        },
        {
          provide: RegulatedLedgerService,
          useValue: { writeSaleEntries: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    service = mod.get(EstimatesService);
    prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
    prisma.invoice.create.mockImplementation((args: any) =>
      Promise.resolve({
        id: "inv-1",
        ...args.data,
        issueDate: new Date(),
        items: (args.data.items.create as any[]).map((c, i) => ({ id: `ii-${i}`, ...c })),
        customer: {},
      }),
    );
  });

  /** A 100 @10% quote with 20 off; `createdAt` decides its mode. */
  const quote = (createdAt: Date) => ({
    id: "est-1",
    status: "ACCEPTED",
    customerId: "cust-1",
    customer: { isTaxExempt: false },
    createdAt,
    subtotal: FIXTURE.subtotal,
    taxAmount: 10, // the quoted tax (LEGACY: 10% of 100)
    discount: FIXTURE.discount,
    total: 90,
    notes: null,
    terms: null,
    items: [
      {
        description: "Widget",
        productId: null,
        qty: 1,
        unitPrice: 100,
        subtotal: 100,
        boxes: null,
        pieces: null,
        unitLabel: null,
        unitsPerBox: null,
      },
    ],
  });

  describe("row 3: convertToInvoice takes the ESTIMATE's mode", () => {
    const convert = async (createdAt: Date) => {
      prisma.invoice.create.mockClear();
      (prisma as any).systemConfig.findFirst.mockResolvedValue({ value: "10" });
      prisma.estimate.findUnique.mockResolvedValue(quote(createdAt));
      prisma.product.findMany.mockResolvedValue([]);
      prisma.trackedCategory.findMany.mockResolvedValue([]);
      await service.convertToInvoice("est-1");
      const d = prisma.invoice.create.mock.calls[0][0].data;
      return { tax: d.taxAmount, total: d.total };
    };

    it("a quote made BEFORE the cutover, converted NOW (the real clock is after it): the invoice's tax equals the cutover-null run", async () => {
      expectFixtureDiscriminates();
      const dark = await underCutover(null, () => convert(BEFORE)); // the quoted tax: nothing moves
      expect(await convert(AFTER)).not.toEqual(dark); // 1: a quote made AFTER converts on the PRE_TAX base
      expect(await convert(BEFORE)).toEqual(dark); // 2: the BEFORE quote keeps its quoted tax
      expect(await convert(AFTER)).toMatchObject({ tax: fixtureTotals("PRE_TAX").tax }); // and the new one is the PRE_TAX figure
    });
  });

  describe("row 2: the quote detail's discountTaxBase (R7)", () => {
    const detail = async (createdAt: Date) => {
      prisma.estimate.findUnique.mockResolvedValueOnce({ id: "e1", createdAt, items: [] });
      return (await service.findOne("e1")).discountTaxBase;
    };

    it("a quote created BEFORE the cutover reads LEGACY_POST_TAX, as the cutover-null run", async () => {
      const dark = await underCutover(null, () => detail(BEFORE));
      expect(await detail(AFTER)).toBe("PRE_TAX"); // 1: a PRE_TAX-dated quote reads PRE_TAX
      expect(await detail(BEFORE)).toBe(dark); // 2: the BEFORE quote equals the null run ...
      expect(dark).toBe("LEGACY_POST_TAX"); // ... which is LEGACY
    });
  });
});
