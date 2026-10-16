import {
  customerLinePrice,
  layerRowForLabel,
  priceLayerStatus,
  type CustomerLayerUnit,
} from "./customer-line-price";
import { customerLayerPrice } from "./customer-unit-price";
import { getTierPrice } from "./tier-pricing";

// SA-811a fixtures: pack list $42, a Case of 288 at $480, a Piece (1) at $1.75; tier 3 column $39 (P-d).
const product = {
  unit: "Box",
  unitsPerBox: 24,
  pricePerUnit: "42.00",
  priceTier2: "40.00",
  priceTier3: "39.00",
  priceTier4: null,
  priceTier5: null,
};
const none = { priceTier2: null, priceTier3: null, priceTier4: null, priceTier5: null };
const units = [
  { id: "u-piece", label: "Piece", factorToBase: 1, price: "1.75", ...none },
  { id: "u-case", label: "Case", factorToBase: 288, price: "480.00", ...none },
];

/** The rows the endpoint serves, literally (what the server's layer() returned for each unit). */
const row = (over: Partial<CustomerLayerUnit>): CustomerLayerUnit => ({
  ref: "pack",
  label: null,
  price: 33,
  listPrice: 42,
  source: "customer",
  aboveList: false,
  ...over,
});
const caseShape = row({
  ref: "u-case",
  label: "Case",
  price: 377.14,
  listPrice: 480,
  source: "customer-shape",
});
const packShape = row({ price: 39.38, listPrice: 42, source: "customer-shape" });
const above = row({ price: 45, aboveList: true });

describe("customerLinePrice: the SA-811a rows (P-a..P-d)", () => {
  it("P-a: a typed pack $33 gives the Case $377.14 in the customer's shape: SPECIAL against the $480 list", () => {
    expect(
      customerLinePrice({ product, tier: 1, layer: [row({}), caseShape], unitLabel: "Case" }),
    ).toEqual({
      price: 377.14,
      listPrice: 480,
      isSpecial: true,
      priceType: "SPECIAL",
      layered: true,
    });
  });
  it("P-b: a typed Case $450 on the customer's order unit gives the pack $39.38", () => {
    expect(
      customerLinePrice({ product, tier: 1, layer: [packShape], unitLabel: null }),
    ).toMatchObject({
      price: 39.38,
      listPrice: 42,
      priceType: "SPECIAL",
      layered: true,
    });
  });
  it("P-c: a typed pack $45 above the $42 list is MANUAL (no promo, the sticky upsell's twin)", () => {
    expect(customerLinePrice({ product, tier: 1, layer: [above] })).toEqual({
      price: 45,
      listPrice: 42,
      isSpecial: true,
      priceType: "MANUAL",
      layered: true,
    });
  });
  it("P-d: no layer is master exactly: getTierPrice tier 3, SPECIAL, not layered", () => {
    expect(customerLinePrice({ product, tier: 3 })).toEqual({
      price: getTierPrice(product, 3),
      listPrice: 42,
      isSpecial: true,
      priceType: "SPECIAL",
      layered: false,
    });
    expect(customerLinePrice({ product, tier: 1, layer: null })).toMatchObject({
      price: 42,
      isSpecial: false,
      priceType: "STANDARD",
      layered: false,
    });
  });
  it("a layer with no row for THIS unit falls back to master (a typed Case leaves the pack at tier)", () => {
    expect(
      customerLinePrice({ product, tier: 3, layer: [caseShape], unitLabel: null }),
    ).toMatchObject({
      price: 39,
      layered: false,
    });
  });
  it("unit lines: the caller's unit-levels tierPrice is master's number when there is no row", () => {
    expect(
      customerLinePrice({ product, tier: 1, tierPrice: 480, unitLabel: "Case" }),
    ).toMatchObject({
      price: 480,
      listPrice: 42,
      layered: false,
    });
  });
  it("a layer price at list on Retail is STANDARD", () => {
    expect(customerLinePrice({ product, tier: 1, layer: [row({ price: 42 })] })).toMatchObject({
      isSpecial: false,
      priceType: "STANDARD",
      layered: true,
    });
  });
});

describe("A-1b (SA-813 M2): one label rule, the core's, never a raw string compare", () => {
  const layer = [
    row({}),
    caseShape,
    row({ ref: "base", label: "Piece", price: 1.4, listPrice: 1.75 }),
  ];
  it("a lowercase or padded label matches the Case row", () => {
    for (const label of ["case", " Case ", "CASE"]) {
      expect(customerLinePrice({ product, tier: 1, layer, unitLabel: label }).price).toBe(377.14);
    }
  });
  it("the pack's own name, its legacy unit text and blank all match the pack row", () => {
    for (const label of [null, "", "box", "Box"]) {
      expect(customerLinePrice({ product, tier: 1, layer, unitLabel: label }).price).toBe(33);
    }
    expect(
      customerLinePrice({
        product: { ...product, packLabel: "Carton" },
        tier: 1,
        layer,
        unitLabel: "carton",
      }).price,
    ).toBe(33);
  });
  it("the base label (the tenant's own, or Piece) matches the base row", () => {
    expect(customerLinePrice({ product, tier: 1, layer, unitLabel: "piece" }).price).toBe(1.4);
    expect(
      customerLinePrice({
        product: { ...product, baseUnitLabel: "Can" },
        tier: 1,
        layer,
        unitLabel: "can",
      }).price,
    ).toBe(1.4);
  });
  it("an unknown or renamed label has no row: master's number, not layered (the server's layer() is null for it too)", () => {
    const r = customerLinePrice({ product, tier: 1, layer, unitLabel: "Carton Case" });
    expect(r).toMatchObject({ price: 42, layered: false });
    expect(layerRowForLabel(product, layer, "Pallet")).toBeUndefined();
  });
  it("PARITY with the server: the client's row for a label is the unit the core's own resolver names", () => {
    const pack = { unit: "Box", unitsPerBox: 24, pricePerUnit: "42.00" };
    const server = (label: string | null) => {
      try {
        return customerLayerPrice({
          product: pack,
          units,
          customer: { tier: 1, unitPrices: { pack: 33 } },
          unit: label ?? "pack",
        });
      } catch {
        return null;
      }
    };
    // lowercase "case" resolves on the server to the Case row (customer-shape 377.14); an unknown label throws -> null
    expect(server("case")?.price).toBe(377.14);
    expect(server("Carton Case")).toBeNull();
    expect(
      customerLinePrice({ product: pack, tier: 1, layer: [row({}), caseShape], unitLabel: "case" })
        .price,
    ).toBe(server("case")!.price);
  });
  it("a one-piece pack: the base label names the pack row", () => {
    const one = { ...product, unitsPerBox: 1 };
    expect(layerRowForLabel(one, [row({})], "piece")?.ref).toBe("pack");
  });
});

describe("priceLayerStatus (SA-813 M1 / M3): pending, failed, complete and per-product readiness", () => {
  const data = (complete: boolean) => ({ complete, products: { p1: [row({})] } });
  const st = (over: Partial<Parameters<typeof priceLayerStatus>[0]>) =>
    priceLayerStatus({
      enabled: true,
      isPending: false,
      isError: false,
      data: data(true),
      ...over,
    });

  it("flag off: nothing to wait for (ready, no request): every product is ready", () => {
    const s = st({ enabled: false, isPending: true, data: undefined });
    expect(s).toMatchObject({ enabled: false, ready: true, pending: false, failed: false });
    expect(s.lineReady("anything")).toBe(true);
  });
  it("pending: unconfirmed, not ready, no product ready (disable Create/Save/Send)", () => {
    const s = st({ isPending: true, data: undefined });
    expect(s).toMatchObject({ ready: false, pending: true, failed: false });
    expect(s.lineReady("p1")).toBe(false);
  });
  it("failed: unconfirmed, not ready, even with stale data (Retry)", () => {
    const s = st({ isError: true });
    expect(s).toMatchObject({ ready: false, pending: false, failed: true });
    expect(s.lineReady("p1")).toBe(false);
  });
  it("success + complete: ready; a product with no layer is ready (master's chain)", () => {
    const s = st({});
    expect(s).toMatchObject({ ready: true, pending: false, failed: false, complete: true });
    expect(s.lineReady("p1")).toBe(true);
    expect(s.lineReady("p-none")).toBe(true);
  });
  it("A-8 (M1): an INCOMPLETE response: a product present is ready, one ABSENT is NOT ready", () => {
    const s = st({ data: data(false) });
    expect(s).toMatchObject({ ready: true, complete: false });
    expect(s.lineReady("p1")).toBe(true);
    expect(s.lineReady("p-none")).toBe(false);
    expect(s.lineReady(null)).toBe(false);
  });
});
