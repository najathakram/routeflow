import { loadManualLineContext } from "./manual-invoice-context";

/**
 * S19b A-7 (SA-811a): an old client's derived Piece on a MANUAL invoice is rewritten into the pack line's pieces at the pack
 * price (`price: "pack"`). For a customer with the pack in the layer that price is the LAYER's $33, not the tier's $42, so the
 * edit's own price decision sees no change (no reason prompt, no stray DISCOUNTED). Flag off, or no layer: master's $42.
 */
const V2 = "flag.units_prices_v2";
const PRODUCT = {
  id: "p1",
  name: "Cola",
  kind: "STANDARD",
  unit: "Box",
  unitsPerBox: 24,
  pricePerUnit: 42,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  orderUnitRef: "pack",
  packAuto: 0,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
};

function run(opts: { typed?: boolean; flag?: boolean }) {
  const hasFlag = jest.fn(
    async (_t: string, k: string) => k === "flag.units_v1" || (k === V2 && (opts.flag ?? true)),
  );
  const db = {
    product: { findMany: jest.fn().mockResolvedValue([PRODUCT]) },
    productUnit: { findMany: jest.fn().mockResolvedValue([]) },
    customerPrice: { findMany: jest.fn().mockResolvedValue([]) },
    trackedCategory: { findMany: jest.fn().mockResolvedValue([]) },
    customerUnitPrice: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          opts.typed ? [{ productId: "p1", unitRef: "pack", price: "33.00" }] : [],
        ),
    },
    productTierUnit: { findMany: jest.fn().mockResolvedValue([]) },
  };
  // a derived Piece, typed at the derived per-piece price 42 / 24 = 1.75
  const items: any[] = [{ productId: "p1", unitLabel: "Piece", qty: 3, unitPrice: 1.75 }];
  return loadManualLineContext(items as never, {
    prisma: { getTenantId: () => "t1", forTenant: () => db },
    entitlements: { hasFlag, hasFlagStrict: hasFlag } as never,
    derivedBaseCustomer: { id: "c1", tier: 1 },
  }).then(() => ({ item: items[0], hasFlag }));
}

describe("loadManualLineContext: the derived Piece reads the pack's customer layer (S19b A-7)", () => {
  it("flag on + typed pack $33: the rewritten pack line is stamped $33, not the tier's $42", async () => {
    const { item } = await run({ typed: true });
    expect(item).toMatchObject({ unitLabel: null, boxes: 0, pieces: 3, unitPrice: 33 });
  });
  it("flag OFF with a typed row: master's $42 pack price, and the flag was asked", async () => {
    const { item, hasFlag } = await run({ typed: true, flag: false });
    expect(item).toMatchObject({ unitPrice: 42 });
    expect(hasFlag).toHaveBeenCalledWith("t1", V2);
  });
  it("no typed row: master's $42, the flag is never asked", async () => {
    const { item, hasFlag } = await run({});
    expect(item).toMatchObject({ unitPrice: 42 });
    expect(hasFlag).not.toHaveBeenCalledWith("t1", V2);
  });
});
