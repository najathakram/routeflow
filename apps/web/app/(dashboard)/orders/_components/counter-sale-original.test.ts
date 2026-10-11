import { applyPriceEdit, discountsTotal, editedLineFigures } from "./counter-sale-price-edit";
import type { CounterPriceEdit } from "./CounterLinePriceEdit";
import type { SaleLine } from "./counter-sale-scan";

/**
 * Row 322d: the counter CART strikes the same "original" the receipt does: the LIST price (pricing's showOriginalPrice
 * rule, with the tenant's invoice.hideOriginalPrice), never the customer's tier price. A tier customer (tier 10, list 12)
 * whose cashier takes a line to 8 reads 24.00 struck / 16.00 net on the cart, exactly like the receipt.
 */
const tierLine: SaleLine = {
  tempId: "a",
  productId: "p-a",
  name: "Cola",
  unitPrice: 10, // the customer's TIER price
  listPrice: 12,
  qty: 2,
  priceType: "SPECIAL",
};
const edit = (over: Partial<CounterPriceEdit> = {}): CounterPriceEdit => ({
  mode: "set",
  value: 8,
  unitPrice: 8,
  override: true,
  ...over,
});
const edited = () => applyPriceEdit([tierLine], "a", edit());

describe("an edited line strikes the LIST total (as the receipt does), not the tier total", () => {
  it("tier 10, list 12, cashier price 8, qty 2: struck 24.00, net 16.00, discount 8.00", () => {
    expect(editedLineFigures(edited()[0])).toMatchObject({ original: 24, net: 16, discount: 8 });
    expect(discountsTotal(edited())).toBe(8);
  });

  it("a price above the tier but below the list still strikes the list (11: 24.00 struck, 2.00 off)", () => {
    const [l] = applyPriceEdit([tierLine], "a", edit({ value: 11, unitPrice: 11 }));
    expect(editedLineFigures(l)).toMatchObject({ original: 24, net: 22, discount: 2 });
  });

  it("the tenant's hideOriginalPrice: no struck figure and no discount", () => {
    expect(editedLineFigures(edited()[0], true)).toMatchObject({
      original: null,
      net: 16,
      discount: 0,
    });
    expect(discountsTotal(edited(), true)).toBe(0);
  });

  it("a net at or above the list strikes nothing", () => {
    const [l] = applyPriceEdit([tierLine], "a", edit({ value: 13, unitPrice: 13 }));
    expect(editedLineFigures(l)).toMatchObject({ original: null, discount: 0 });
  });
});
