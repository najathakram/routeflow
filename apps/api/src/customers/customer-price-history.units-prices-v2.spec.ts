import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { CustomerPriceHistoryService } from "./customer-price-history.service";

/**
 * S19b A-3 (SA-811a): the history view's reference price (`references.tierPrice`) is what billing charges: with the pack in
 * the customer's layer it is the layer price ($33), else master's tier price. Harness: customer-price-history-v11.spec.ts.
 */
const V2 = "flag.units_prices_v2";
const PRODUCT = {
  id: "p1",
  name: "Widget",
  unit: "ea",
  unitsPerBox: null,
  averageCost: 3,
  pricePerUnit: 42,
  priceTier2: 40,
  priceTier3: 39,
  priceTier4: null,
  priceTier5: null,
  orderUnitRef: "pack",
  packAuto: 0,
};
const line = {
  id: "ii1",
  productId: "p1",
  product: { unit: "ea", unitsPerBox: null },
  qty: 1,
  unitPrice: 36,
  priceType: "STANDARD",
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
};

describe("CustomerPriceHistoryService references: the customer layer (S19b A-3)", () => {
  let service: CustomerPriceHistoryService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let v2On = true;
  const hasFlag = jest.fn(async (_t: string, k: string) => k === V2 && v2On);

  beforeEach(async () => {
    prisma = createMockPrisma();
    hasFlag.mockClear();
    prisma.customer.findFirst.mockResolvedValue({ id: "c1", businessName: "Acme", pricingTier: 3 });
    prisma.product.findFirst.mockResolvedValue(PRODUCT);
    prisma.customerPrice.findFirst.mockResolvedValue(null);
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: "a",
        invoiceNumber: "A",
        issueDate: new Date("2026-06-10T00:00:00Z"),
        orderId: "o-a",
        order: { orderNumber: "ORD-a" },
        items: [line],
      },
    ]);
    prisma.order.findMany.mockResolvedValue([]);
    prisma.stockMovement.findMany.mockResolvedValue([]);
    const mod = await Test.createTestingModule({
      providers: [
        CustomerPriceHistoryService,
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementsService, useValue: { hasFlag } },
      ],
    }).compile();
    service = mod.get(CustomerPriceHistoryService);
  });

  const typed = (price: number) => {
    (prisma.forTenant() as any).customerUnitPrice = {
      findMany: jest
        .fn()
        .mockResolvedValue([{ productId: "p1", unitRef: "pack", price: String(price) }]),
    };
  };
  const tierPrice = async () =>
    (await service.getHistory("c1", "p1", { role: UserRole.OPERATOR })).references.tierPrice;

  it("flag on: the reference is the customer's typed pack price $33, not the tier-3 $39", async () => {
    v2On = true;
    typed(33);
    expect(await tierPrice()).toBe(33);
  });

  it("flag OFF with a typed row present: master's tier-3 $39, and the flag was asked", async () => {
    v2On = false;
    typed(33);
    expect(await tierPrice()).toBe(39);
    expect(hasFlag).toHaveBeenCalledWith(expect.anything(), V2);
  });

  it("no typed row: master's $39 and the flag is never asked", async () => {
    v2On = true;
    expect(await tierPrice()).toBe(39);
    expect(hasFlag).not.toHaveBeenCalledWith(expect.anything(), V2);
  });
});

describe("S19b nit 4: after a pack-size change the old 'Box' label shows null as master does", () => {
  it("a sale of the old 12-pack while the product is a 24-pack now: tierPrice null (flag on and off), not the current pack's $33", async () => {
    const mk = async (on: boolean) => {
      const prisma = createMockPrisma();
      prisma.customer.findFirst.mockResolvedValue({
        id: "c1",
        businessName: "Acme",
        pricingTier: 3,
      });
      prisma.product.findFirst.mockResolvedValue({ ...PRODUCT, unit: "Box", unitsPerBox: 24 });
      prisma.customerPrice.findFirst.mockResolvedValue(null);
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "a",
          invoiceNumber: "A",
          issueDate: new Date("2026-06-10T00:00:00Z"),
          orderId: "o-a",
          order: { orderNumber: "ORD-a" },
          items: [{ ...line, unitsPerBox: 12, product: { unit: "Box", unitsPerBox: 24 } }],
        },
      ]);
      prisma.order.findMany.mockResolvedValue([]);
      prisma.stockMovement.findMany.mockResolvedValue([]);
      (prisma.forTenant() as any).customerUnitPrice = {
        findMany: jest
          .fn()
          .mockResolvedValue([{ productId: "p1", unitRef: "pack", price: "33.00" }]),
      };
      const mod = await Test.createTestingModule({
        providers: [
          CustomerPriceHistoryService,
          { provide: PrismaService, useValue: prisma },
          { provide: EntitlementsService, useValue: { hasFlag: jest.fn(async () => on) } },
        ],
      }).compile();
      return (
        await mod
          .get(CustomerPriceHistoryService)
          .getHistory("c1", "p1", { role: UserRole.OPERATOR })
      ).references.tierPrice;
    };
    expect(await mk(false)).toBeNull();
    expect(await mk(true)).toBeNull();
  });
});
