import { sanitizeSnapshot } from "@/lib/invoice-draft-storage";
import { checkDraftReferences } from "./invoice-draft-restore";

// S19b slice C, C-1 (draft restore half; SA-811a, SA-813): a restored catalog line is priced exactly as a fresh add would be, so
// with the flag on and a customer layer it lands on the LAYER price. Flag off: no price-layer request and master's numbers.
const snap = (lines: Array<Record<string, unknown>>) =>
  sanitizeSnapshot({
    basis: "standalone",
    customer: { id: "c-1", businessName: "Acme Co", pricingTier: 3 },
    lines,
  })!;
const stored = (extra: Record<string, unknown> = {}) => ({
  productId: "p1",
  description: "Soda",
  qty: 1,
  unitPrice: 36,
  discount: 0,
  taxable: false,
  ...extra,
});
// list $42, tier 3 $36
const PRODUCT = { id: "p1", name: "Soda", pricePerUnit: "42", priceTier3: "36", unit: "each" };
const packRow = {
  ref: "pack",
  label: null,
  price: 33,
  listPrice: 42,
  source: "customer",
  aboveList: false,
};
const aboveRow = { ...packRow, price: 45, aboveList: true };

function getter(layer: unknown, calls: string[] = []) {
  return (url: string) => {
    calls.push(url);
    if (url === "/customers/c-1")
      return Promise.resolve({ data: { id: "c-1", businessName: "Acme Co", pricingTier: 3 } });
    if (url === "/products/p1") return Promise.resolve({ data: PRODUCT });
    if (url === "/customers/c-1/prices") return Promise.resolve({ data: [] });
    if (url === "/customers/c-1/price-layer")
      return layer instanceof Error ? Promise.reject(layer) : Promise.resolve({ data: layer });
    return Promise.resolve({ data: {} });
  };
}
const layerOf = (products: Record<string, unknown[]>, complete = true) => ({
  customerId: "c-1",
  complete,
  products,
});

describe("S19b C-1: draft restore prices from the customer layer", () => {
  it("C-1: a stored tier-priced line restores at the typed pack $33 (SPECIAL), not the tier $36", async () => {
    const r = await checkDraftReferences(snap([stored()]), getter(layerOf({ p1: [packRow] })), {
      pricesV2: true,
    });
    expect(r.snapshot.lines[0]).toMatchObject({
      unitPrice: 33,
      listPrice: 42,
      priceType: "SPECIAL",
      regularPrice: 42,
    });
    expect(r.pricesUpdated).toBe(1);
  });

  it("R2: an above-list layer price restores as MANUAL at that price", async () => {
    const r = await checkDraftReferences(snap([stored()]), getter(layerOf({ p1: [aboveRow] })), {
      pricesV2: true,
    });
    expect(r.snapshot.lines[0]).toMatchObject({ unitPrice: 45, priceType: "MANUAL" });
  });

  it("R3: a unit line whose unit is in the layer restores at the layer's unit price", async () => {
    const caseRow = {
      ref: "u-case",
      label: "Case",
      price: 377.14,
      listPrice: 480,
      source: "customer-shape",
      aboveList: false,
    };
    const get = (url: string) =>
      url === "/products/p1/units"
        ? Promise.resolve({
            data: [
              {
                id: "u-case",
                label: "Case",
                factorToBase: 12,
                price: "480",
                priceTier2: null,
                priceTier3: null,
                priceTier4: null,
                priceTier5: null,
                isDefaultSelling: false,
                sortOrder: 1,
              },
            ],
          })
        : getter(layerOf({ p1: [packRow, caseRow] }))(url);
    const r = await checkDraftReferences(
      snap([stored({ unitLabel: "Case", unitPrice: 400 })]),
      get,
      {
        pricesV2: true,
      },
    );
    expect(r.snapshot.lines[0]).toMatchObject({
      unitLabel: "Case",
      unitPrice: 377.14,
      listPrice: 480,
    });
  });

  it("flag OFF: no price-layer request and master's tier price ($36)", async () => {
    const calls: string[] = [];
    const r = await checkDraftReferences(
      snap([stored({ unitPrice: 30 })]),
      getter(new Error("must not be read"), calls),
    );
    expect(calls).not.toContain("/customers/c-1/price-layer");
    expect(r.snapshot.lines[0]).toMatchObject({ unitPrice: 36, priceType: "SPECIAL" });
  });

  it("M3: a failed layer read keeps the line as stored and counts it unchecked (never re-priced at the tier)", async () => {
    const r = await checkDraftReferences(
      snap([stored({ unitPrice: 30 })]),
      getter(new Error("boom")),
      {
        pricesV2: true,
      },
    );
    expect(r.snapshot.lines[0].unitPrice).toBe(30);
    expect(r.pricesUnchecked).toBe(1);
    expect(r.pricesUpdated).toBe(0);
  });

  it("fails closed: a response with no `complete` flag is treated as incomplete", async () => {
    const r = await checkDraftReferences(
      snap([stored({ unitPrice: 30 })]),
      getter({ customerId: "c-1", products: {} }),
      { pricesV2: true },
    );
    expect(r.snapshot.lines[0].unitPrice).toBe(30);
    expect(r.pricesUnchecked).toBe(1);
  });

  it("A-8: an incomplete layer leaves a product it does not list unchecked", async () => {
    const r = await checkDraftReferences(
      snap([stored({ unitPrice: 30 })]),
      getter(layerOf({}, false)),
      {
        pricesV2: true,
      },
    );
    expect(r.snapshot.lines[0].unitPrice).toBe(30);
    expect(r.pricesUnchecked).toBe(1);
  });
});
