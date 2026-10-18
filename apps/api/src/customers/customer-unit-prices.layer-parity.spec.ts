import { CustomerUnitPricesService } from "./customer-unit-prices.service";

/**
 * S19b A-5 (SA-811a R1): K6's pack row follows billing: a price worked out from the customer's typed price on their order
 * unit (customer-shape) beats a remembered above-list pack price (the sticky upsell); the history only shows when the pack is
 * NOT in the customer layer. The view also carries the product's own anchor options, as billing's loader builds it.
 */
const noTiers = { priceTier2: null, priceTier3: null, priceTier4: null, priceTier5: null };
const PRODUCT = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Cola",
  unit: "Box",
  baseUnitLabel: null,
  packLabel: null,
  unitsPerBox: 24,
  pricePerUnit: "42.00",
  priceTier2: "0.00",
  priceTier3: "0.00",
  priceTier4: "0.00",
  priceTier5: "0.00",
  sku: "S",
  barcode: null,
  unitSku: null,
  priceRevision: 1,
  isActive: true,
  orderUnitRef: "pack",
  packAuto: 0,
};
const CASE_UNIT = {
  id: "u-case",
  productId: PRODUCT.id,
  label: "Case",
  factorToBase: 288,
  price: "480.00",
  isDefaultSelling: false,
  sortOrder: 0,
  parentUnitId: null,
  perParent: null,
  sku: null,
  ...noTiers,
};

function service(opts: {
  typed: Array<[string, number]>;
  remembered?: number;
  tierUnits?: unknown[];
}) {
  const db = {
    customer: {
      findFirst: jest.fn().mockResolvedValue({ id: "c1", businessName: "Acme", pricingTier: 1 }),
    },
    customerUnitPrice: {
      findMany: jest.fn().mockResolvedValue(
        opts.typed.map(([unitRef, price]) => ({
          productId: PRODUCT.id,
          unitRef,
          price: String(price),
        })),
      ),
    },
    customerPrice: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ productId: PRODUCT.id, pricingTier: null, orderUnitRef: "u-case" }]),
    },
    product: {
      findMany: jest.fn().mockResolvedValue([PRODUCT]),
      count: jest.fn().mockResolvedValue(1),
    },
    productUnit: { findMany: jest.fn().mockResolvedValue([CASE_UNIT]) },
    productTierUnit: { findMany: jest.fn().mockResolvedValue(opts.tierUnits ?? []) },
    orderItem: {
      findMany: jest.fn().mockResolvedValue(
        opts.remembered
          ? [
              {
                productId: PRODUCT.id,
                unitPrice: String(opts.remembered),
                originalPrice: "42.00",
              },
            ]
          : [],
      ),
    },
  };
  return {
    db,
    svc: new CustomerUnitPricesService({ forTenant: () => db, getTenantId: () => "t1" } as never),
  };
}
const packRow = async (s: ReturnType<typeof service>) =>
  (await s.svc.get("c1")).products[0].rows.find((r) => r.ref === "pack")!;

describe("K6 pack row = billing (S19b A-5)", () => {
  it("A-5: typed Case $450 on the order unit + a remembered above-list pack $45: the pack shows $39.38 customer-shape, not $45 history", async () => {
    const row = await packRow(service({ typed: [["u-case", 450]], remembered: 45 }));
    expect(row).toMatchObject({ price: 39.38, source: "customer-shape" });
  });

  it("no layer for the pack (a typed price on the Case, a different order unit): the sticky $45 still shows as history", async () => {
    const s = service({ typed: [["u-case", 450]], remembered: 45 });
    s.db.customerPrice.findMany.mockResolvedValue([]); // the Case is not the customer's order unit: the pack is not in the layer
    expect(await packRow(s)).toMatchObject({ price: 45, source: "history" });
  });

  it("a typed pack price is still theirs ($33 customer), never the remembered one", async () => {
    expect(await packRow(service({ typed: [["pack", 33]], remembered: 45 }))).toMatchObject({
      price: 33,
      source: "customer",
    });
  });

  it("the view carries the product's anchor options: the tier-unit rows are read for the listed products", async () => {
    const s = service({ typed: [["u-case", 450]] });
    await s.svc.get("c1");
    expect(s.db.productTierUnit.findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      productId: { in: [PRODUCT.id] },
    });
  });
});

describe("K6 view options change the price (S19b nit 7: the effect, not just the read)", () => {
  it("a product ordered by the Case with the pack's Retail Auto prices the pack off the Case: $40, not the stored $42", async () => {
    const withAnchor = service({ typed: [["u-case", 480]] });
    withAnchor.db.product.findMany.mockResolvedValue([
      { ...PRODUCT, orderUnitRef: "u-case", packAuto: 1 },
    ]);
    const anchored = (await withAnchor.svc.get("c1")).products[0].rows.find(
      (r) => r.ref === "pack",
    )!;
    const plain = service({ typed: [["u-case", 480]] });
    const unanchored = (await plain.svc.get("c1")).products[0].rows.find((r) => r.ref === "pack")!;
    expect(anchored.listPrice).toBe(40);
    expect(unanchored.listPrice).toBe(42);
    expect(anchored.listPrice).not.toBe(unanchored.listPrice);
  });
});
