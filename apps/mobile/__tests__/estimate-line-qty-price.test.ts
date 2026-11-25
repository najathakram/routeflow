import { readFileSync } from "fs";
import { join } from "path";
import { estimateLineAmount, estimateLineQtyPriceText } from "../lib/estimates-logic";

// B1387 (SA-1286): the qty beside a BOX price on a mobile estimate line must count boxes, not
// pieces. The screen printed `{it.qty} × {price}` = "36 × $18.00" for 3 boxes of 12 at $18.00 a
// box, which reads aloud as $648 (the total, $54.00, was always right).
describe("estimateLineQtyPriceText (B1387)", () => {
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  const box3 = { qty: 36, boxes: 3, pieces: 0, unitsPerBox: 12, unitPrice: 18 };

  it('3 boxes of 12 at $18.00 reads "3 boxes × $18.00", never "36 × $18.00"', () => {
    expect(estimateLineQtyPriceText(box3, fmt)).toBe("3 boxes × $18.00");
  });

  it("a split with loose pieces keeps both parts", () => {
    expect(estimateLineQtyPriceText({ ...box3, qty: 38, pieces: 2 }, fmt)).toBe(
      "3 boxes + 2 pcs × $18.00",
    );
  });

  it("a line with no split reads the plain qty (keep-green)", () => {
    expect(estimateLineQtyPriceText({ qty: 3, unitPrice: 2.5 }, fmt)).toBe("3 × $2.50");
  });

  it("a units_v1 line reads its own unit", () => {
    expect(estimateLineQtyPriceText({ ...box3, unitLabel: "Case" }, fmt)).toBe("3 Cases × $18.00");
  });

  it("the money is untouched: the amount of the same line is $54.00, not 36 x 18", () => {
    expect(estimateLineAmount(box3)).toBe(54);
  });
});

describe("mobile estimate screen routes the qty through the helper (B1387)", () => {
  const src = readFileSync(join(__dirname, "..", "app/(operator)/estimates/[id].tsx"), "utf8");
  it("no longer prints the raw piece qty beside the price", () => {
    expect(src).not.toMatch(/\{it\.qty\}\s*×/);
    expect(src).toMatch(/estimateLineQtyPriceText\(/);
  });
});
