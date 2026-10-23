import { buildUnitOptions } from "@/lib/unit-options";
import { orderedUnitOption } from "./use-order-suggestion-actions";

describe("Order again: a past line finds its unit option by unitNameKey (MUST-1, NIT3)", () => {
  const product = {
    unit: "Box",
    unitsPerBox: 12,
    pricePerUnit: "50.00",
    priceTier2: null,
    priceTier3: null,
    priceTier4: null,
    priceTier5: null,
  };
  const cafe = {
    id: "l-cafe",
    label: "Café",
    factorToBase: 6,
    price: "30.00",
    priceTier2: null,
    priceTier3: null,
    priceTier4: null,
    priceTier5: null,
    isDefaultSelling: false,
    sortOrder: 0,
  };
  const options = buildUnitOptions(product, [cafe], 1);

  it.each([
    ["NFD", "Café"],
    ["NFC", "Café"],
    ["padded upper-case", " CAFÉ "],
  ])("a %s past line resolves to the NFC level (never null)", (_k, label) => {
    expect(orderedUnitOption(options, label)?.value).toBe("Café");
  });

  it("a unit no longer offered is null; the pack is never matched by name (guard)", () => {
    expect(orderedUnitOption(options, "Crate")).toBeNull();
    expect(orderedUnitOption(options, "Box")).toBeNull();
  });
});
