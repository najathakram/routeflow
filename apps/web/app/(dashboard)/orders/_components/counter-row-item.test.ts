import { counterPriceType, counterRowItem } from "./CounterLineRow";
import type { SaleLine } from "./counter-sale-scan";

/** B1373: a till line read as the order row's item (display only; the till prices through cartTotals). */
const base: SaleLine = {
  tempId: "t1",
  productId: "p1",
  name: "Sample Cola",
  unitPrice: 2.5,
  listPrice: 2.5,
  qty: 3,
  unit: "each",
};

describe("counterPriceType", () => {
  it("an unedited catalogue line is STANDARD; a customer/tier price is SPECIAL", () => {
    expect(counterPriceType(base)).toBe("STANDARD");
    expect(counterPriceType({ ...base, priceType: "SPECIAL", unitPrice: 2 })).toBe("SPECIAL");
    expect(counterPriceType({ ...base, special: true })).toBe("SPECIAL");
  });

  it("an edited line is DISCOUNTED below its catalogue price and MANUAL (Upsell) above it", () => {
    const override = { mode: "set" as const, value: 2 };
    expect(counterPriceType({ ...base, unitPrice: 2, tierPrice: 2.5, override })).toBe(
      "DISCOUNTED",
    );
    expect(counterPriceType({ ...base, unitPrice: 3, tierPrice: 2.5, override })).toBe("MANUAL");
    expect(counterPriceType({ ...base, unitPrice: 2.5, override })).toBe("STANDARD");
    expect(counterPriceType({ ...base, listPrice: undefined, unitPrice: 2, override })).toBe(
      "STANDARD",
    );
  });
});

describe("counterRowItem", () => {
  it("a plain line carries no pack (the order row draws its plain stepper); a pack of 1 is plain too", () => {
    expect(counterRowItem(base).unitsPerBox).toBeUndefined();
    expect(
      counterRowItem({ ...base, unitsPerBox: 1, boxes: 3, pieces: 0 }).unitsPerBox,
    ).toBeUndefined();
  });

  it("a boxed line carries its pack, boxes and pieces, and the sell-by the row chose", () => {
    const boxed = { ...base, unitsPerBox: 12, boxes: 1, pieces: 2, qty: 14, unitPrice: 30 };
    const item = counterRowItem(boxed, { sellBy: "unit", noteOpen: true });
    expect(item).toMatchObject({
      unitsPerBox: 12,
      boxes: 1,
      pieces: 2,
      qty: 14,
      sellBy: "unit",
      noteOpen: true,
    });
  });

  it("keeps the line's own words, note and a list price for the strike (tier, then unit price, when unknown)", () => {
    const item = counterRowItem({ ...base, packLabel: "Case", baseLabel: "can", note: "cold" });
    expect(item).toMatchObject({
      productName: "Sample Cola",
      packLabel: "Case",
      baseLabel: "can",
      note: "cold",
    });
    expect(counterRowItem({ ...base, listPrice: undefined, tierPrice: 2.4 }).listPrice).toBe(2.4);
    expect(counterRowItem({ ...base, listPrice: undefined, unit: undefined }).listPrice).toBe(2.5);
    expect(counterRowItem({ ...base, unit: undefined }).unit).toBe("piece");
  });
});
