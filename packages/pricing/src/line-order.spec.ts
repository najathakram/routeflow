import { NSF_FEE_DESCRIPTION_PREFIX } from "./nsf-line";
import { comparePrintedLines, sortPrintedLines, type PrintedLineFacts } from "./line-order";

/**
 * W-1187 (SA ruling 7): the ONE comparator behind "Sort A to Z", moved here from the API's invoice-line-order.ts (SA-1058
 * R1, R2, R6) so the API and every screen run the same copy. Presentation, not money: no money helper imports it.
 */
const line = (id: string, description: string, extra: Partial<PrintedLineFacts> = {}) => ({
  id,
  description,
  productId: `p-${id}`,
  ...extra,
});
const manual = (id: string, description: string): PrintedLineFacts => ({
  id,
  description,
  productId: null,
});
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
const shuffles = <T>(rows: T[]): T[][] => {
  const r = [...rows].reverse();
  return [r, [...r.slice(2), ...r.slice(0, 2)], [...rows.slice(1), rows[0]]];
};

describe("sortPrintedLines", () => {
  const nsf = { id: "a-nsf", description: "NSF fee", systemKind: "NSF_FEE", productId: null };
  const rows = [
    line("b", "Brand B Item"),
    line("a12", "brand a item 12oz"),
    manual("m", "Delivery charge"),
    nsf,
    line("a8", "BRAND A ITEM 8OZ"),
  ];

  it("printed name ignoring case with numbers by value, then manual, then system lines", () => {
    for (const input of [rows, ...shuffles(rows)]) {
      expect(ids(sortPrintedLines(input))).toEqual(["a8", "a12", "b", "m", "a-nsf"]);
    }
  });

  it("an NSF line known only by its old description is a system line too", () => {
    const legacy = manual("old", `${NSF_FEE_DESCRIPTION_PREFIX} 12`);
    expect(
      ids(sortPrintedLines([legacy, manual("m", "Zebra charge"), line("p", "Zebra Gum")])),
    ).toEqual(["p", "m", "old"]);
  });

  it("one name's case line and loose line sit together, case first; a tie falls to the id", () => {
    const sorted = sortPrintedLines([
      line("loose", "Cola 12oz", { boxes: 0, unitsPerBox: 24 }),
      line("other", "Cola 12oz Diet"),
      line("case", "Cola 12oz", { boxes: 3, unitsPerBox: 24 }),
      line("z2", "Same"),
      line("z1", "Same"),
    ]);
    expect(ids(sorted)).toEqual(["case", "loose", "other", "z1", "z2"]);
  });

  it("returns a NEW array and leaves the input untouched", () => {
    const input = [line("b", "B"), line("a", "A")];
    const out = sortPrintedLines(input);
    expect(out).not.toBe(input);
    expect(ids(input)).toEqual(["b", "a"]);
  });

  it("comparePrintedLines is the same order as the sort", () => {
    expect(comparePrintedLines(line("a", "Apple"), line("b", "Zebra"))).toBeLessThan(0);
    expect(comparePrintedLines(line("b", "Zebra"), line("a", "Apple"))).toBeGreaterThan(0);
  });
});
