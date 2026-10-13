import { computeLineSubtotal } from "@routeflow/pricing";
import type { CounterPriceEdit } from "./CounterLinePriceEdit";
import {
  applyPriceEdit,
  discountsTotal,
  editedCount,
  editedLineFigures,
  lineNeedingReason,
  lineTierPrice,
  priceEditLineOf,
  resetPriceEdit,
} from "./counter-sale-price-edit";
import { toSaleItem } from "./counter-sale-line-edit";
import { stepLine, type SaleLine } from "./counter-sale-scan";

/**
 * POS-5: the cart operations behind the price dialog. Every figure goes through computeLineSubtotal (a boxed line is
 * priced by its BOX); an edit replaces, never stacks; a result at the tier price is a plain line; and the wire item
 * carries a price ONLY for an edited line.
 */
const plain: SaleLine = {
  tempId: "a",
  productId: "p-a",
  name: "Cola",
  unitPrice: 10,
  listPrice: 10,
  qty: 2,
  priceType: "STANDARD",
};
/** a 12-pack at 24.00 a box, 2 boxes + 3 pieces */
const boxed: SaleLine = {
  tempId: "b",
  productId: "p-b",
  name: "Water",
  unitPrice: 24,
  listPrice: 24,
  unitsPerBox: 12,
  boxes: 2,
  pieces: 3,
  qty: 27,
  priceType: "STANDARD",
};

const edit = (over: Partial<CounterPriceEdit>): CounterPriceEdit => ({
  mode: "percent",
  value: 10,
  unitPrice: 9,
  override: true,
  ...over,
});

describe("applyPriceEdit / resetPriceEdit", () => {
  it("an edit stores the NET in unitPrice, keeps the system price in tierPrice and marks the line", () => {
    const [l] = applyPriceEdit([plain], "a", edit({}));
    expect(l).toMatchObject({
      unitPrice: 9,
      tierPrice: 10,
      priceEdited: true,
      override: { mode: "percent", value: 10 },
    });
    expect(lineTierPrice(l)).toBe(10);
  });

  it("a second edit REPLACES the first and starts from the tier price again (never stacks)", () => {
    const first = applyPriceEdit([plain], "a", edit({}));
    const second = applyPriceEdit(first, "a", edit({ mode: "amount", value: 1, unitPrice: 9 }));
    expect(second[0]).toMatchObject({
      unitPrice: 9,
      tierPrice: 10,
      override: { mode: "amount", value: 1 },
    });
  });

  it("a result at the tier price (override:false) returns a plain line with no edited state at all", () => {
    const edited = applyPriceEdit([plain], "a", edit({}));
    const [l] = applyPriceEdit(edited, "a", edit({ unitPrice: 10, override: false }));
    expect(l).toEqual(plain);
    expect("override" in l).toBe(false);
    expect("tierPrice" in l).toBe(false);
    expect("priceEdited" in l).toBe(false);
  });

  it("Reset price restores the plain line; other lines are untouched", () => {
    const lines = applyPriceEdit([plain, boxed], "a", edit({}));
    const out = resetPriceEdit(lines, "a");
    expect(out[0]).toEqual(plain);
    expect(out[1]).toBe(boxed);
  });

  it("the reason is kept only when given", () => {
    expect(applyPriceEdit([plain], "a", edit({ reason: "Damaged box" }))[0].override).toEqual({
      mode: "percent",
      value: 10,
      reason: "Damaged box",
    });
    expect("reason" in applyPriceEdit([plain], "a", edit({}))[0].override!).toBe(false);
  });

  it("a stepper change keeps the per-unit override; the line total follows the new quantity", () => {
    const [l] = applyPriceEdit([plain], "a", edit({}));
    const more = stepLine(l, "piece", 1);
    expect(more).toMatchObject({ qty: 3, unitPrice: 9, override: { mode: "percent" } });
    expect(editedLineFigures(more)).toMatchObject({ net: 27, original: 30, discount: 3 });
  });
});

describe("editedLineFigures / discountsTotal", () => {
  it("a plain line has no figures and no discount", () => {
    expect(editedLineFigures(plain)).toBeNull();
    expect(discountsTotal([plain, boxed])).toBe(0);
  });

  it("a boxed 10% edit: net 21.60 a box, totals through computeLineSubtotal (never qty x price)", () => {
    const [l] = applyPriceEdit([boxed], "b", edit({ unitPrice: 21.6 }));
    const f = editedLineFigures(l)!;
    const at = (unitPrice: number) =>
      computeLineSubtotal({ unitPrice, qty: 27, boxes: 2, pieces: 3, unitsPerBox: 12 });
    expect(f.net).toBe(at(21.6));
    expect(f.net).toBe(48.6);
    expect(f.original).toBe(at(24));
    expect(f.discount).toBe(Math.round((at(24) - at(21.6)) * 100) / 100);
    expect(f.net).not.toBe(27 * 21.6); // the over-charge this guards against
    expect(f.chip).toBe("10% off");
    expect(priceEditLineOf(l, 1)).toMatchObject({ tierPrice: 24, unitsPerBox: 12, boxes: 2 });
  });

  it("a raised price is Price changed and adds nothing to Discounts", () => {
    const [l] = applyPriceEdit([plain], "a", edit({ mode: "set", value: 12, unitPrice: 12 }));
    expect(editedLineFigures(l)).toMatchObject({ discount: 0, chip: "Price changed" });
    expect(discountsTotal([l])).toBe(0);
  });

  it("Discounts is the rounded sum of the positive line discounts", () => {
    let lines = applyPriceEdit([plain, boxed], "a", edit({}));
    lines = applyPriceEdit(lines, "b", edit({ unitPrice: 21.6 }));
    // 2 x $1.00 on the plain line + (2 boxes + 3 pcs) x $2.40 a box on the boxed one (54.00 - 48.60)
    expect(editedLineFigures(lines[0])!.discount).toBe(2);
    expect(editedLineFigures(lines[1])!.discount).toBe(5.4);
    expect(discountsTotal(lines)).toBe(7.4);
    expect(editedCount(lines)).toBe(2);
  });
});

describe("lineNeedingReason (the shared decideStaffOverride rule)", () => {
  const edited = (reason?: string) =>
    applyPriceEdit([plain], "a", edit({ ...(reason ? { reason } : {}) }));

  it("a special tier + a real change + no reason is flagged; with a reason it is not", () => {
    expect(lineNeedingReason(edited(), () => 2)?.tempId).toBe("a");
    expect(lineNeedingReason(edited("Damaged box"), () => 2)).toBeNull();
    expect(lineNeedingReason(edited("   "), () => 2)?.tempId).toBe("a");
  });

  it("tier 1 never needs a reason; a plain line is never flagged", () => {
    expect(lineNeedingReason(edited(), () => 1)).toBeNull();
    expect(lineNeedingReason([plain], () => 2)).toBeNull();
  });
});

describe("toSaleItem: the wire carries a price ONLY for an edited line", () => {
  it("an unedited line is byte-identical to today's shape (no unitPrice, no priceReason)", () => {
    expect(toSaleItem(plain)).toEqual({ productId: "p-a", qty: 2 });
    expect(Object.keys(toSaleItem(plain)).sort()).toEqual(["productId", "qty"]);
  });

  it("an edited line sends the rounded net as unitPrice, and a reason only when one was typed", () => {
    const [noReason] = applyPriceEdit([plain], "a", edit({}));
    expect(toSaleItem(noReason)).toEqual({ productId: "p-a", qty: 2, unitPrice: 9 });
    expect("priceReason" in toSaleItem(noReason)).toBe(false);
    const [withReason] = applyPriceEdit([plain], "a", edit({ reason: "Damaged box" }));
    expect(toSaleItem(withReason)).toEqual({
      productId: "p-a",
      qty: 2,
      unitPrice: 9,
      priceReason: "Damaged box",
    });
  });

  it("an edited boxed line keeps its box split and sends the BOX net price", () => {
    const [l] = applyPriceEdit([boxed], "b", edit({ unitPrice: 21.6 }));
    expect(toSaleItem(l)).toEqual({
      productId: "p-b",
      boxes: 2,
      pieces: 3,
      qty: 27,
      unitPrice: 21.6,
    });
  });
});

describe("CQ-15: the chip says what was typed", () => {
  // a customer on a special tier: list 9.50, this customer's price 8.55 a box, 2 boxes
  const cola: SaleLine = {
    tempId: "c",
    productId: "p-c",
    name: "Cola",
    unitPrice: 8.55,
    listPrice: 9.5,
    qty: 2,
    priceType: "SPECIAL",
  };

  it("10% off the customer's 8.55 reads '10% off', not the 18.95% it is against the list", () => {
    const [l] = applyPriceEdit([cola], "c", edit({ value: 10, unitPrice: 7.7 }));
    const f = editedLineFigures(l)!;
    expect(f.chip).toBe("10% off");
    // the struck list and the Discounts row still measure from the list: they are the receipt's figures
    expect(f.original).toBe(19);
    expect(f.net).toBe(15.4);
    expect(f.discount).toBe(3.6);
  });

  it("an amount off reads the amount typed, per selling unit", () => {
    const [l] = applyPriceEdit([cola], "c", edit({ mode: "amount", value: 0.85, unitPrice: 7.7 }));
    expect(editedLineFigures(l)!.chip).toBe("$0.85 off each");
  });

  it("when the tier moved under a kept edit the chip is re-derived from the list, as before", () => {
    const moved: SaleLine = { ...cola, unitPrice: 5, listPrice: 10 };
    const [l] = applyPriceEdit([moved], "c", edit({ value: 50, unitPrice: 5 }));
    // typed 50% of the tier 8.55 would be 4.28, not the kept 5.00 -> 50% off the list
    expect(editedLineFigures({ ...l, tierPrice: 8 })!.chip).toBe("50% off");
  });
});
