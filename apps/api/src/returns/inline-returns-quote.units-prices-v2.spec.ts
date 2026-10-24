/**
 * Units S19 (flag.units_prices_v2, review item 2): an UNREFERENCED return is credited what the sale would have billed, so
 * with the pack in the customer's layer it is the layer price, never the (higher) tier price. Flag off: master's tier price.
 */
import { Test } from "@nestjs/testing";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const V2 = "flag.units_prices_v2";
const OPERATOR = {
  sub: "user-op-1",
  role: "OPERATOR",
  forcePasswordChange: false,
  tenantId: "t1",
  tenantSlug: "acme",
  username: "admin",
  status: "ACTIVE",
} as JwtPayload;

describe("InlineReturnsQuoteService: an unreferenced return reads the customer layer (S19)", () => {
  let service: InlineReturnsQuoteService;
  let db: any;
  let v2On = true;
  const hasFlag = jest.fn(async (_t: string, k: string) => k === V2 && v2On);

  beforeEach(async () => {
    const prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        InlineReturnsQuoteService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag, hasFlagStrict: hasFlag } },
      ],
    }).compile();
    service = mod.get(InlineReturnsQuoteService);
    db = prisma.forTenant();
    db.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1, isTaxExempt: false });
    db.customerPrice.findMany.mockResolvedValue([]);
    db.product.findMany.mockResolvedValue([
      {
        id: "prod-1",
        pricePerUnit: 24,
        priceTier2: 24,
        priceTier3: 24,
        priceTier4: 24,
        priceTier5: 24,
        unitsPerBox: 12,
      },
    ]);
    db.invoice.findMany.mockResolvedValue([]);
    db.return.findMany.mockResolvedValue([]);
    db.returnItem.findMany.mockResolvedValue([]);
    db.customerUnitPrice = {
      findMany: jest
        .fn()
        .mockResolvedValue([{ productId: "prod-1", unitRef: "pack", price: "18.00" }]),
    };
  });

  const quote = () =>
    service.quote(
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1, boxes: 0, pieces: 12 }] },
      OPERATOR,
    );

  it("flag on: one unreferenced box is credited at the customer's $18, not the $24 list/tier", async () => {
    v2On = true;
    expect((await quote()).total).toBe(18);
  });

  it("flag OFF with a typed row present: master's $24", async () => {
    v2On = false;
    expect((await quote()).total).toBe(24);
    expect(hasFlag).toHaveBeenCalledWith(expect.anything(), V2);
  });
});
