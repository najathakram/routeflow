/**
 * Units S19 (flag.units_prices_v2): an estimate line is quoted at the customer's customer-layer pack price (SPECIAL; MANUAL
 * above the unit's list), flag off or no typed row = master's tier / list price. Harness: estimates.service.spec.ts.
 */
import { Test } from "@nestjs/testing";
import { EstimatesService } from "./estimates.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { createMockPrisma } from "../testing/prisma-mock";

const V2 = "flag.units_prices_v2";

describe("EstimatesService.create: the customer layer (S19)", () => {
  let service: EstimatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let v2On = true;
  const hasFlag = jest.fn(async (_t: string, k: string) => k === V2 && v2On);

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        EstimatesService,
        { provide: SellingRestrictionsService, useValue: { assertLinesSellable: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        { provide: EntitlementsService, useValue: { hasFlag, hasFlagStrict: hasFlag } },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("EST-1") },
        },
        { provide: RegulatedLedgerService, useValue: {} },
      ],
    }).compile();
    service = mod.get(EstimatesService);
    prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.estimate.create.mockResolvedValue({ id: "est-1" });
    prisma.product.findMany.mockResolvedValue([
      { id: "p1", name: "Widget", pricePerUnit: 42, unitsPerBox: null, kind: "STANDARD" },
    ]);
  });

  const typed = (price: number) => {
    (prisma.forTenant() as any).customerUnitPrice = {
      findMany: jest
        .fn()
        .mockResolvedValue([{ productId: "p1", unitRef: "pack", price: String(price) }]),
    };
  };
  const quote = async () => {
    await service.create({ customerId: "cust-1", items: [{ productId: "p1", qty: 2 }] } as never);
    return prisma.estimate.create.mock.calls[0][0].data.items.create[0];
  };

  it("flag on: the typed pack price is the quoted price (SPECIAL against list)", async () => {
    v2On = true;
    typed(33);
    expect(await quote()).toMatchObject({ unitPrice: 33, priceType: "SPECIAL", originalPrice: 42 });
  });

  it("flag on: above the list ($45 over $42) the quote is the MANUAL upsell twin", async () => {
    v2On = true;
    typed(45);
    expect(await quote()).toMatchObject({ unitPrice: 45, priceType: "MANUAL", originalPrice: 42 });
  });

  it("flag OFF with typed rows present: master's list price", async () => {
    v2On = false;
    typed(33);
    expect(await quote()).toMatchObject({ unitPrice: 42, priceType: "STANDARD" });
    expect(hasFlag).toHaveBeenCalledWith(expect.anything(), V2);
  });
});
