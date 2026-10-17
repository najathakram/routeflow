import { customerLinePrice, priceLayerStatus, type CustomerLayerUnit } from "@routeflow/pricing";
import {
  computeOrderTotal,
  lineUnitFor,
  packIsSpecial,
  packLinePrice,
  priceEditorPrefill,
  withLayerBase,
} from "../lib/cart-order-total";
import type { LineState, Product } from "../lib/cart-line-state";
import {
  LAYER_FAILED_MESSAGE,
  LAYER_INCOMPLETE_MESSAGE,
  LAYER_PENDING_MESSAGE,
  confirmedPrice,
  layerAwareIsSpecial,
  priceLayerGate,
} from "../lib/price-layer-gate";

// S19b slice D (SA-813): the SAME literal SA-811a fixtures as packages/pricing customer-line-price.spec.ts
// (pack list $42, tier 3 column $39, Case $480 of 288 pieces). Mobile prices through the one customerLinePrice.
const product: Product = {
  id: "p1",
  name: "Soda 24pk",
  pricePerUnit: "42.00",
  priceTier2: "40.00",
  priceTier3: "39.00",
  unitsPerBox: 24,
};
const row = (over: Partial<CustomerLayerUnit>): CustomerLayerUnit => ({
  ref: "pack",
  label: null,
  price: 33,
  listPrice: 42,
  source: "customer",
  aboveList: false,
  ...over,
});
const packA = row({}); // P-a: typed pack $33
const caseA = row({
  ref: "u-case",
  label: "Case",
  price: 377.14,
  listPrice: 480,
  source: "customer-shape",
});
const packB = row({ price: 39.38, source: "customer-shape" }); // P-b: typed Case $450 on the order unit
const web = (
  layer: CustomerLayerUnit[] | undefined,
  unitLabel: string | null,
  tierPrice?: number,
) => customerLinePrice({ product: product as never, tier: 3, layer, unitLabel, tierPrice });
const catalog = new Map([["p1", product]]);

describe("D-1: the mobile order total equals the web customerLinePrice (P-a, P-b)", () => {
  it("P-a: pack line x2 totals 2 x $33 = web price; the Case line totals $377.14", () => {
    const items: Record<string, LineState> = { p1: { qty: 2 } };
    const layerOf = () => [packA, caseA];
    const { total } = computeOrderTotal(items, catalog, [], () => 3, layerOf);
    expect(total).toBe(web([packA, caseA], null).price * 2);
    expect(total).toBe(66);
    const caseLine: Record<string, LineState> = {
      p1: { qty: 1, unitLabel: "Case", unitBasePrice: 480 },
    };
    const caseTotal = computeOrderTotal(caseLine, catalog, [], () => 3, layerOf);
    expect(caseTotal.total).toBe(web([packA, caseA], "Case", 480).price);
    expect(caseTotal.total).toBe(377.14);
  });
  it("P-b: the pack line is $39.38 each (customer-shape from the typed Case)", () => {
    const { total } = computeOrderTotal(
      { p1: { qty: 3 } },
      catalog,
      [],
      () => 3,
      () => [packB],
    );
    expect(total).toBe(Math.round(web([packB], null).price * 3 * 100) / 100);
    expect(web([packB], null).price).toBe(39.38);
  });
  it("P-d / flag off: no layer is master's tier price exactly (tier 3 = $39)", () => {
    const items: Record<string, LineState> = { p1: { qty: 2 } };
    const off = computeOrderTotal(items, catalog, [], () => 3);
    expect(off.total).toBe(78);
    expect(
      computeOrderTotal(
        items,
        catalog,
        [],
        () => 3,
        () => undefined,
      ),
    ).toEqual(off);
    expect(lineUnitFor({ qty: 1 }, product, 3)).toBe(39);
    expect(
      lineUnitFor({ qty: 1, unitLabel: "Case", unitBasePrice: 480 }, product, 3, undefined),
    ).toBe(480);
  });
});

describe("D-2: NewOrderScreen / invoices-new / edit-items pre-fill $33", () => {
  it("the pack pre-fill and the price editor pre-fill are the layer's $33, not the tier's $39", () => {
    expect(packLinePrice(product, 3, [packA, caseA]).price).toBe(33);
    expect(priceEditorPrefill({ qty: 1 }, product, 3, [packA, caseA])).toBe(33);
    expect(packLinePrice(product, 3, undefined).price).toBe(39);
  });
  it("a layered price skips the last-given pre-fill (R3) and is SPECIAL when it differs from list", () => {
    expect(layerAwareIsSpecial(packLinePrice(product, 1, [packA]))).toBe(true);
    expect(layerAwareIsSpecial(packLinePrice(product, 1, undefined))).toBe(false);
    expect(packIsSpecial(1, [packA])).toBe(true);
    expect(packIsSpecial(1, undefined)).toBe(false);
    expect(packIsSpecial(3, undefined)).toBe(true);
  });
  it("a unit line whose unit is in the layer carries the layer price as its base; otherwise the same object", () => {
    const line = { qty: 1, unitLabel: "Case", unitBasePrice: 480 };
    expect(withLayerBase(line, product, 3, [packA, caseA]).unitBasePrice).toBe(377.14);
    expect(withLayerBase(line, product, 3, undefined)).toBe(line);
    expect(withLayerBase(line, product, 3, [packA])).toBe(line); // no Case row: master's base
    const pack = { qty: 1 };
    expect(withLayerBase(pack, product, 3, [packA])).toBe(pack);
  });
  it("a case-different label still finds the Case row (the core's label rule, M2)", () => {
    expect(
      lineUnitFor({ qty: 1, unitLabel: "case", unitBasePrice: 480 }, product, 3, [packA, caseA]),
    ).toBe(377.14);
  });
});

describe("D-3: the catalog row shows $33", () => {
  it("confirmedPrice is the layer price once ready", () => {
    const status = priceLayerStatus({
      enabled: true,
      isPending: false,
      isError: false,
      data: { complete: true, products: { p1: [packA] } },
    });
    expect(confirmedPrice(status, "p1", packLinePrice(product, 3, [packA]))).toBe(33);
  });
  it("is null (an ellipsis) while pending, never the tier price as final", () => {
    const status = priceLayerStatus({
      enabled: true,
      isPending: true,
      isError: false,
      data: undefined,
    });
    expect(confirmedPrice(status, "p1", packLinePrice(product, 3, undefined))).toBeNull();
  });
  it("flag off: always the master price", () => {
    const status = priceLayerStatus({ enabled: false, isPending: false, isError: false });
    expect(confirmedPrice(status, "p1", packLinePrice(product, 3, undefined))).toBe(39);
  });
});

describe("D-5: pending or failed means not final; Create/Save stay disabled until lineReady", () => {
  const st = (o: Parameters<typeof priceLayerStatus>[0]) => priceLayerStatus(o);
  it("flag off never blocks and shows no marker", () => {
    expect(
      priceLayerGate(st({ enabled: false, isPending: false, isError: false }), ["p1"]),
    ).toEqual({ blocked: false, message: null, canRetry: false });
  });
  it("pending: blocked with the unconfirmed marker", () => {
    expect(priceLayerGate(st({ enabled: true, isPending: true, isError: false }), ["p1"])).toEqual({
      blocked: true,
      message: LAYER_PENDING_MESSAGE,
      canRetry: false,
    });
    expect(LAYER_PENDING_MESSAGE).toBe("Checking this customer's prices…");
  });
  it("failed: blocked with Retry", () => {
    expect(priceLayerGate(st({ enabled: true, isPending: false, isError: true }), ["p1"])).toEqual({
      blocked: true,
      message: LAYER_FAILED_MESSAGE,
      canRetry: true,
    });
  });
  it("ready: not blocked", () => {
    const data = { complete: true, products: { p1: [packA] } };
    const s = st({ enabled: true, isPending: false, isError: false, data });
    expect(priceLayerGate(s, ["p1", "p2"]).blocked).toBe(false);
  });
  it("A-8: an incomplete layer blocks a product that is absent, not one that is present", () => {
    const data = { complete: false, products: { p1: [packA] } };
    const s = st({ enabled: true, isPending: false, isError: false, data });
    expect(priceLayerGate(s, ["p1"]).blocked).toBe(false);
    expect(priceLayerGate(s, ["p1", "p2"])).toEqual({
      blocked: true,
      message: LAYER_INCOMPLETE_MESSAGE,
      canRetry: false,
    });
  });
  it("no lines yet: nothing to block", () => {
    const data = { complete: true, products: {} };
    expect(
      priceLayerGate(st({ enabled: true, isPending: false, isError: false, data }), []).blocked,
    ).toBe(false);
  });
});
