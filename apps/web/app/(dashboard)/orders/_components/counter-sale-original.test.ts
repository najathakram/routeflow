import {
  applyPriceEdit,
  cartStrikesList,
  discountsTotal,
  editedLineFigures,
} from "./counter-sale-price-edit";
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

/**
 * Struck -> net -> chip -> Discounts must agree arithmetically: every figure the cart prints about a lowered line is measured
 * from the SAME reference (the list, whenever the list is struck), never a tier price for one and the list for another.
 */
// The struck total, net and Discounts row are ONE list-measured arithmetic (the receipt's). The chip is the clerk's own
// typed figure while it is still true against the tier price (CQ-15); it is re-derived from the list only when the
// tier moved under a kept edit.
describe("the cart's struck total, net and Discounts row are one arithmetic", () => {
  it("percent: tier 8, list 10, typed 37.5 (price 5): struck 10.00 and Discounts 5.00 from the list, the chip says the typed 37.5% (CQ-15)", () => {
    const line: SaleLine = { ...tierLine, unitPrice: 8, listPrice: 10, qty: 1 };
    const [l] = applyPriceEdit([line], "a", edit({ mode: "percent", value: 37.5, unitPrice: 5 }));
    expect(editedLineFigures(l)).toMatchObject({
      original: 10,
      net: 5,
      discount: 5,
      chip: "37.5% off",
    });
  });

  it("amount: tier 10, list 12, typed $2 off (price 8), qty 2: 24.00 struck, 16.00 net, Discounts 8.00, the chip the typed $2.00 off each (CQ-15)", () => {
    const [l] = applyPriceEdit([tierLine], "a", edit({ mode: "amount", value: 2, unitPrice: 8 }));
    expect(editedLineFigures(l)).toMatchObject({
      original: 24,
      net: 16,
      discount: 8,
      chip: "$2.00 off each",
    });
    expect(discountsTotal([l])).toBe(8);
  });

  it("with the tenant's hideOriginalPrice the list is not struck, so the chip keeps its TIER reference", () => {
    const [l] = applyPriceEdit([tierLine], "a", edit({ mode: "amount", value: 2, unitPrice: 8 }));
    expect(editedLineFigures(l, true)).toMatchObject({
      original: null,
      discount: 0,
      chip: "$2.00 off each",
    });
  });

  it("a line with no known list price strikes nothing, on the unit row and on the edited total alike", () => {
    const held: SaleLine = { ...tierLine };
    delete held.listPrice;
    expect(cartStrikesList(held)).toBe(false);
    const [l] = applyPriceEdit([held], "a", edit({ unitPrice: 8 }));
    expect(editedLineFigures(l)).toMatchObject({ original: null, discount: 0 });
    expect(discountsTotal([l])).toBe(0);
  });

  it("a plain line priced from tier 10 against a list of 12 (no edit) counts its 2 x 2.00 in Discounts, like the receipt", () => {
    expect(editedLineFigures(tierLine)).toBeNull();
    expect(cartStrikesList(tierLine)).toBe(true);
    expect(discountsTotal([tierLine])).toBe(4);
    expect(discountsTotal([tierLine], true)).toBe(0);
  });

  it("Discounts sums EVERY struck line: a plain tier line and an edited one", () => {
    const edited = applyPriceEdit([{ ...tierLine, tempId: "b" }], "b", edit())[0];
    expect(discountsTotal([tierLine, edited])).toBe(4 + 8);
  });

  const tuples: Array<[tier: number, list: number, price: number, qty: number]> = [
    [8, 10, 5, 1],
    [10, 12, 8, 2],
    [10, 12, 11, 3],
    [9.5, 9.5, 7.6, 4],
    [4, 5, 2.5, 6],
    [20, 24, 18, 5],
  ];
  it.each(tuples)(
    "tier %d list %d price %d qty %d: struck - net = Discounts, and the chip x qty = Discounts",
    (tier, list, price, qty) => {
      const base: SaleLine = {
        tempId: "p",
        productId: "p-p",
        name: "Item",
        unitPrice: tier,
        listPrice: list,
        qty,
        priceType: "SPECIAL",
      };
      for (const mode of ["set", "percent", "amount"] as const) {
        const [l] = applyPriceEdit(
          [base],
          "p",
          edit({ mode, value: mode === "set" ? price : 0, unitPrice: price }),
        );
        const f = editedLineFigures(l)!;
        expect(f.original).not.toBeNull();
        expect(Math.round((f.original! - f.net) * 100) / 100).toBe(f.discount);
        expect(discountsTotal([l])).toBe(f.discount);
        const percent = /^([\d.]+)% off$/.exec(f.chip);
        const amount = /^\$([\d.]+) off each$/.exec(f.chip);
        if (mode === "percent") {
          expect(percent).not.toBeNull();
          expect(Math.abs((Number(percent![1]) / 100) * f.original! - f.discount)).toBeLessThan(
            0.01,
          );
        } else if (mode === "amount") {
          expect(amount).not.toBeNull();
          expect(Math.round(Number(amount![1]) * qty * 100) / 100).toBe(f.discount);
        } else {
          expect(f.chip).toBe("Price changed");
        }
      }
    },
  );
});
