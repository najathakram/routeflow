import { unitWords } from "@routeflow/pricing";
import { cartTotals } from "@/lib/counter-sale";
import {
  lineSellCount,
  lineSellUnit,
  registerPriceLabel,
  registerQtyLabel,
  sellUnitWord,
  setLineQty,
  typedForSellUnit,
} from "./counter-sale-line-edit";
import { stepLine, type SaleLine } from "./counter-sale-scan";

/** Cola 12oz Can, case of 24, $18.00 a case. */
const cola = (over: Partial<SaleLine> = {}): SaleLine => ({
  tempId: "t1",
  productId: "p1",
  name: "Cola 12oz Can",
  unitPrice: 18,
  unitsPerBox: 24,
  boxes: 1,
  pieces: 0,
  qty: 24,
  ...over,
});
const money = (n: number) => `$${n.toFixed(2)}`;
const word = (u: string) => u.toLowerCase();

describe("BUILD-BRIEF 1.5: the line uses the PRODUCT's pack word", () => {
  const tenant = unitWords();

  it("a line with a pack label reads it: 'case of 24', '2 cases of 24', '$18.00 / case'", () => {
    const l = cola({ packLabel: "Case" });
    expect(registerQtyLabel(l, tenant)).toBe("1 case of 24");
    expect(registerQtyLabel(cola({ packLabel: "Case", boxes: 2, qty: 48 }), tenant)).toBe(
      "2 cases of 24",
    );
    expect(registerPriceLabel(l, tenant, money, word)).toBe("$18.00 / case · $0.75 each");
  });

  it("loose pieces name the product's pack too", () => {
    const l = cola({ packLabel: "Case", boxes: 1, pieces: 3, qty: 27 });
    expect(registerQtyLabel(l, tenant)).toBe("1 case + 3 pcs · case of 24");
  });

  it("no pack label (or a blank one) keeps the tenant's words, as before", () => {
    expect(registerQtyLabel(cola(), tenant)).toBe("1 box of 24");
    expect(registerQtyLabel(cola({ packLabel: "  " }), tenant)).toBe("1 box of 24");
    expect(registerPriceLabel(cola(), tenant, money, word)).toBe("$18.00 / box · $0.75 each");
    const carton = unitWords({ packLabel: "Carton" });
    expect(registerQtyLabel(cola(), carton)).toBe("1 carton of 24");
  });
});

describe("row 676: the line's selling unit (the row-531 rule, on a counter line)", () => {
  it("a whole-case line counts cases; one holding loose pieces counts each", () => {
    expect(lineSellUnit(cola())).toBe("CASE");
    expect(lineSellCount(cola(), "CASE")).toBe(1);
    const loose = cola({ boxes: 1, pieces: 3, qty: 27 });
    expect(lineSellUnit(loose)).toBe("EACH");
    expect(lineSellCount(loose, "EACH")).toBe(27);
  });

  it("a chosen Each on a whole-case line is honoured; a chosen Case with loose pieces is not", () => {
    expect(lineSellUnit(cola(), "EACH")).toBe("EACH");
    expect(lineSellCount(cola(), "EACH")).toBe(24);
    expect(lineSellUnit(cola({ boxes: 1, pieces: 3, qty: 27 }), "CASE")).toBe("EACH");
  });

  it("a plain line has one unit and counts its qty", () => {
    const plain: SaleLine = { tempId: "t2", productId: "p2", name: "Ice", unitPrice: 4, qty: 5 };
    expect(lineSellUnit(plain, "CASE")).toBe("EACH");
    expect(lineSellCount(plain, "EACH")).toBe(5);
  });

  it("the unit word always agrees with the count and the product's pack word", () => {
    const l = cola();
    expect(sellUnitWord(l, "CASE", 1, unitWords())).toBe("box");
    expect(sellUnitWord(l, "CASE", 2, unitWords())).toBe("boxes");
    expect(sellUnitWord(cola({ packLabel: "Case" }), "CASE", 2, unitWords())).toBe("cases");
    expect(sellUnitWord(l, "EACH", 27, unitWords())).toBe("each");
    const plain: SaleLine = { tempId: "t2", productId: "p2", name: "Ice", unitPrice: 4, qty: 5 };
    expect(sellUnitWord(plain, "EACH", 5, unitWords())).toBe("pieces");
    expect(sellUnitWord({ ...plain, unit: "each" }, "EACH", 5, unitWords())).toBe("each");
    expect(sellUnitWord({ ...plain, unit: "bottle" }, "EACH", 1, unitWords())).toBe("bottle");
    expect(sellUnitWord({ ...plain, unit: "bottle" }, "EACH", 5, unitWords())).toBe("bottles");
  });

  it("typed text becomes boxes+pieces in the chosen unit, and lands on the same stored line", () => {
    expect(typedForSellUnit(cola(), "CASE", "3")).toEqual({ boxes: "3", pieces: "0" });
    expect(typedForSellUnit(cola(), "EACH", "27")).toEqual({ boxes: "0", pieces: "27" });
    expect(typedForSellUnit({ ...cola(), unitsPerBox: undefined }, "EACH", "9")).toEqual({
      qty: "9",
    });
  });

  it("'1 case + 3 each' is the same stored line and subtotal however it was reached", () => {
    // master's path: a case, then three single steps on the piece buttons
    let viaSteps = cola();
    for (let i = 0; i < 3; i += 1) viaSteps = stepLine(viaSteps, "piece", 1);
    // the typed path in Each: 27 pieces
    const typed = setLineQty(cola(), typedForSellUnit(cola(), "EACH", "27"))!;
    // the typed path in Case then Each: 1 case, then 3 more each
    const typedBoxes = setLineQty(cola(), { boxes: "1", pieces: "3" })!;
    for (const l of [viaSteps, typed, typedBoxes]) {
      expect([l.qty, l.boxes, l.pieces]).toEqual([27, 1, 3]);
      // boxed proration: one case $18.00 + 3 x $0.75 = $20.25 (computeLineSubtotal, never qty x case price)
      expect(cartTotals([l], 0).subtotal).toBe(20.25);
    }
  });
});
