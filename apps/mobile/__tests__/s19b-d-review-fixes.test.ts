import { readFileSync } from "fs";
import { join } from "path";
import { isSpecialTier, priceLayerStatus, type CustomerLayerUnit } from "@routeflow/pricing";
import type { UnitOption as LadderOption } from "../lib/unit-options";
import {
  lineIsSpecial,
  lineLayerPrice,
  optionWithLayerPrice,
  packIsSpecial,
} from "../lib/cart-order-total";
import { applyUnitPick, type DraftItem } from "../lib/edit-items-draft";
import type { Product } from "../lib/cart-line-state";
import {
  LAYER_INCOMPLETE_MESSAGE,
  guardLayerSave,
  priceLayerGate,
  pricingReadyWithLayer,
  unitDetailOrUnconfirmed,
} from "../lib/price-layer-gate";

// S19b slice D, Opus review MUSTs 1-4 + nits (red-first). Fixtures are the SA-811a literals: pack list $42, Case $480.
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
const editItems = read("app/(operator)/(tabs)/orders/[id]/edit-items.tsx");
const invoiceNew = read("app/(operator)/(tabs)/invoices/new.tsx");
const newOrder = read("components/NewOrderScreen.tsx");
const cartModal = read("components/new-order/CartModal.tsx");
const cartRow = read("components/CartRow.tsx");
const draftCard = read("components/edit-items/DraftItemCard.tsx");
const unitPickerRow = read("components/UnitPickerRow.tsx");
const hook = read("lib/api/price-layer.ts");
const catalog = read("app/(operator)/customers/[id]/catalog.tsx");

const product: Product = {
  id: "p1",
  name: "Soda 24pk",
  pricePerUnit: "42.00",
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
const packA = row({});
const caseA = row({
  ref: "u-case",
  label: "Case",
  price: 377.14,
  listPrice: 480,
  source: "customer-shape",
});
const status = (o: Parameters<typeof priceLayerStatus>[0]) => priceLayerStatus(o);
const ready = (products: Record<string, CustomerLayerUnit[]>, complete = true) =>
  status({ enabled: true, isPending: false, isError: false, data: { complete, products } });

describe("MUST 1: Create/Confirm in the cart sheet and onSave honour the D-5 gate", () => {
  it("guardLayerSave: a non-draft save is refused with the gate's message; a draft is never gated", () => {
    const pending = priceLayerGate(status({ enabled: true, isPending: true, isError: false }), [
      "p1",
    ]);
    expect(guardLayerSave(pending, false)).toBe(pending.message);
    expect(guardLayerSave(pending, true)).toBeNull();
    expect(
      guardLayerSave(
        priceLayerGate(status({ enabled: false, isPending: false, isError: false }), ["p1"]),
        false,
      ),
    ).toBeNull();
  });
  it("CartModal takes layerGate and disables Create and Confirm on it; NewOrderScreen passes it and guards onSave", () => {
    expect(cartModal).toMatch(/layerGate\??:\s*PriceLayerGate/);
    expect(cartModal.match(/layerGate\?\.blocked/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(newOrder).toMatch(/layerGate=\{layerGate\}/);
    expect(newOrder).toMatch(/guardLayerSave\(layerGate, asDraft\)/);
  });
  it("invoices/new onSave names the layer block before any other check", () => {
    expect(invoiceNew).toMatch(/guardLayerSave\(layerGate, false\)/);
  });
});

describe("MUST 2: edit-items stays closed until the layer is ready", () => {
  it("pricingReadyWithLayer: flag off = the base; flag on needs a ready layer", () => {
    const off = status({ enabled: false, isPending: false, isError: false });
    expect(pricingReadyWithLayer(true, off)).toBe(true);
    expect(pricingReadyWithLayer(false, off)).toBe(false);
    expect(
      pricingReadyWithLayer(true, status({ enabled: true, isPending: true, isError: false })),
    ).toBe(false);
    expect(
      pricingReadyWithLayer(true, status({ enabled: true, isPending: false, isError: true })),
    ).toBe(false);
    expect(pricingReadyWithLayer(true, ready({ p1: [packA] }))).toBe(true);
  });
  it("pricingReady uses it, and a pick or substitute of a product the layer cannot vouch for is refused", () => {
    expect(editItems).toMatch(/pricingReadyWithLayer\(/);
    expect(editItems).toMatch(/!priceLayer\.lineReady\(p\.id\)/);
  });
});

describe("MUST 3: a unit picked on edit-items takes the layer price, not the tier's", () => {
  const caseOption = {
    value: "Case",
    label: "Case",
    price: 480,
    factorToBase: 288,
  } as unknown as LadderOption;
  it("optionWithLayerPrice: typed pack $33 gives Case $377.14; no row, no layer, the pack and a derived option are unchanged", () => {
    expect(optionWithLayerPrice(caseOption, product, 1, [packA, caseA]).price).toBe(377.14);
    expect(optionWithLayerPrice(caseOption, product, 1, undefined)).toBe(caseOption);
    expect(optionWithLayerPrice(caseOption, product, 1, [packA])).toBe(caseOption);
    const pack = { ...caseOption, value: "" } as LadderOption;
    expect(optionWithLayerPrice(pack, product, 1, [packA, caseA])).toBe(pack);
    const derived = { ...caseOption, derived: { n: 24 } } as unknown as LadderOption;
    expect(optionWithLayerPrice(derived, product, 1, [packA, caseA])).toBe(derived);
  });
  it("applyUnitPick with the layered option stores $377.14, not $480", () => {
    const cur = { productId: "p1", qty: 1, unitPrice: 33 } as unknown as DraftItem;
    const picked = applyUnitPick(
      cur,
      optionWithLayerPrice(caseOption, product, 1, [packA, caseA]),
      33,
    );
    expect(picked.unitBasePrice).toBe(377.14);
    expect(picked.unitPrice).toBe(377.14);
  });
  it("setUnitLabel prices through it", () => {
    expect(editItems).toMatch(/optionWithLayerPrice\(\s*option/);
  });
});

describe("MUST 4: strict types", () => {
  it("tierPriceFor is typed by getTierPrice's own parameter, not Record<string, unknown>, and no `as never` casts remain", () => {
    expect(editItems).not.toMatch(/Record<string, unknown>/);
    for (const src of [editItems, newOrder, invoiceNew, catalog])
      expect(src).not.toMatch(/as never/);
  });
});

describe("nit: per-unit SPECIAL gates use the line's own layer row", () => {
  it("a Can line at list is not SPECIAL though the pack is; a SPECIAL Can on a list-priced pack is", () => {
    const canAtList = row({ ref: "u-can", label: "Can", price: 1.75, listPrice: 1.75 });
    const canSpecial = row({ ref: "u-can", label: "Can", price: 1.5, listPrice: 1.75 });
    const listPack = row({ price: 42, listPrice: 42 });
    expect(lineIsSpecial({ unitLabel: "Can" }, product, 1, [packA, canAtList])).toBe(false);
    expect(lineIsSpecial({}, product, 1, [packA, canAtList])).toBe(true);
    expect(lineIsSpecial({ unitLabel: "Can" }, product, 1, [listPack, canSpecial])).toBe(true);
    expect(lineIsSpecial({ unitLabel: "Can" }, product, 3, undefined)).toBe(isSpecialTier(3));
  });
  it("the screens ask the line, not the pack", () => {
    expect(newOrder).toMatch(/lineIsSpecial\(/);
    expect(invoiceNew).toMatch(/lineIsSpecial\(/);
    expect(cartModal).toMatch(/lineIsSpecial\(/);
    expect(editItems).toMatch(/unitLineSpecial/);
  });
});

describe("nit: memo deps, addOne fallback, unconfirmed unit options", () => {
  it("memos track the layer data, not just `ready`", () => {
    expect(hook).toMatch(/data: q\.data/);
    expect(newOrder).toMatch(/priceLayer\.data/);
    expect(invoiceNew).toMatch(/priceLayer\.data/);
  });
  it("addOne uses layerAwareIsSpecial and, with no product, master's isSpecialTier(tier)", () => {
    expect(newOrder).toMatch(
      /layerAwareIsSpecial\(packPriceFor\(p\)\)\s*:\s*isSpecialTier\(effectiveTierFor\(id\)\)/,
    );
  });
  it("unit options show an ellipsis while the layer is unconfirmed", () => {
    expect(unitDetailOrUnconfirmed("$480.00 / Case", true)).toBe("…");
    expect(unitDetailOrUnconfirmed("$480.00 / Case", false)).toBe("$480.00 / Case");
    expect(unitPickerRow).toMatch(/pricesUnconfirmed/);
    expect(cartRow).toMatch(/pricesUnconfirmed/);
    expect(draftCard).toMatch(/pricesUnconfirmed/);
  });
});

describe("copy names the product the layer could not load", () => {
  it("an incomplete layer names the absent lines; with no names the plain copy is unchanged", () => {
    const s = ready({ p1: [packA] }, false);
    expect(priceLayerGate(s, ["p1", "p2"])).toMatchObject({ message: LAYER_INCOMPLETE_MESSAGE });
    const named = priceLayerGate(s, ["p1", "p2"], (id) => (id === "p2" ? "Grape Soda" : id));
    expect(named.blocked).toBe(true);
    expect(named.message).toBe(`${LAYER_INCOMPLETE_MESSAGE} Not loaded: Grape Soda.`);
  });
});

describe("wiring pins: the gate is in canSave on all three screens; the hook sends nothing flag-off", () => {
  it("canSave / Save include layerGate.blocked", () => {
    expect(newOrder).toMatch(/const canSave =[^;]*!layerGate\.blocked;/);
    expect(invoiceNew).toMatch(/const canSave = baseOk && !layerGate\.blocked;/);
    expect(editItems).toMatch(/disabled=\{updateMut\.isPending \|\| layerGate\.blocked\}/);
  });
  it("no /price-layer request with the flag off: enabled = flag && customer, and the flag read fails closed", () => {
    expect(hook).toMatch(/const enabled = pricesV2 && !!customerId;/);
    expect(hook).toMatch(/enabled,\n\s+staleTime: 0/);
    expect(hook).toMatch(/\?\? \[\]\) as readonly string\[\]\)\.includes\(PRICES_V2_FLAG\)/);
  });
});

describe("R2 (mobile): an above-list customer price is MANUAL and promo-exempt", () => {
  it("aboveList row: priceType MANUAL, layered, price above the $42 list", () => {
    const above = row({ price: 45, aboveList: true });
    expect(lineLayerPrice({}, product, 1, [above])).toEqual({
      price: 45,
      listPrice: 42,
      isSpecial: true,
      priceType: "MANUAL",
      layered: true,
    });
  });
});

describe("packIsSpecial equals isSpecialTier for every tier input when there is no layer", () => {
  it("tiers 0, 6, NaN and null (plus 1-5)", () => {
    for (const t of [0, 1, 2, 3, 4, 5, 6, NaN, null as unknown as number]) {
      expect(packIsSpecial(t, undefined)).toBe(isSpecialTier(t));
      expect(packIsSpecial(t, [])).toBe(isSpecialTier(t));
    }
  });
});
