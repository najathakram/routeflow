import { lineStockViews, stockLeftLabel, type StockLine } from "./line-stock";

/** SA-1086 (LS-1..LS-4, LS-7, LS-8): judge the PRODUCT, in the line's own words; never block Save. */
const avail = (onHand: number, allowOversell = true, productId = "p1") => ({
  allowOversell,
  items: [{ productId, availablePieces: onHand }],
});
const plain = (key: string, qty: number, extra: Partial<StockLine> = {}): StockLine => ({
  key,
  productId: "p1",
  qty,
  ...extra,
});
const boxed = (
  key: string,
  boxes: number,
  pieces = 0,
  extra: Partial<StockLine> = {},
): StockLine => ({
  key,
  productId: "p1",
  qty: boxes * 12 + pieces,
  boxes,
  pieces,
  unitsPerBox: 12,
  ...extra,
});
const run = (lines: StockLine[], availability: ReturnType<typeof avail> | undefined, rest = {}) =>
  lineStockViews({ lines, availability, failed: false, fetching: false, ...rest });
const ready = (v: ReturnType<typeof run>, key: string) => {
  const view = v.get(key);
  if (!view || view.state !== "ready") throw new Error(`no ready view for ${key}`);
  return view;
};

describe("lineStockViews", () => {
  it("LS-1: two lines of one product, 6 and 6 with 10 on hand, both read as over", () => {
    const v = run([plain("a", 6), plain("b", 6)], avail(10));
    expect(ready(v, "a").level).toBe("low");
    expect(ready(v, "b").level).toBe("low");
    expect(ready(v, "a").requestedPieces).toBe(12);
    // the branch's per-line read would have passed each alone:
    expect(ready(run([plain("a", 6)], avail(10)), "a").level).toBe("ok");
  });

  it("LS-2: 2 boxes of a 12-pack with 20 pieces on hand is over (24), told in boxes and pieces", () => {
    const v = run([boxed("a", 2)], avail(20));
    const view = ready(v, "a");
    expect(view.level).toBe("low");
    expect(view.requestedPieces).toBe(24);
    expect(view.label).toBe("1 box and 8 pieces left");
    expect(view.message).toContain("Only 1 box and 8 pieces left");
  });

  it("LS-2: the line's own unit words (a tenant's pack and loose words) are used", () => {
    const line = boxed("a", 2, 0, { packLabel: "Case", baseLabel: "Bottle" });
    expect(stockLeftLabel(line, 20)).toBe("1 case and 8 bottles left");
    expect(stockLeftLabel(line, 24)).toBe("2 cases left");
    expect(stockLeftLabel(line, 5)).toBe("5 bottles left");
  });

  it("LS-3: edit counts only the increase: saved 6 raised to 8 with 1 on hand is over by the 2 added", () => {
    const saved = new Map([["p1", 6]]);
    const v = run([plain("a", 8)], avail(1), { savedPiecesByProduct: saved });
    expect(ready(v, "a").level).toBe("low");
    expect(ready(v, "a").requestedPieces).toBe(2);
    // an unchanged or lowered line asks for nothing more, however little is left
    expect(ready(run([plain("a", 6)], avail(1), { savedPiecesByProduct: saved }), "a").level).toBe(
      "ok",
    );
    expect(
      ready(run([plain("a", 4)], avail(0), { savedPiecesByProduct: saved }), "a").requestedPieces,
    ).toBe(0);
  });

  it("LS-4: over stock with oversell off still returns a note (no blocking flag exists), in refusal words", () => {
    const v = run([plain("a", 20)], avail(5, false));
    const view = ready(v, "a");
    expect(view.message).toMatch(/won't save/);
    expect(Object.keys(view)).not.toContain("blocksSubmit");
  });

  it("with oversell allowed the note says the extra goes on backorder", () => {
    const view = ready(run([plain("a", 20)], avail(5, true)), "a");
    expect(view.message).toMatch(/backorder/i);
  });

  it("an order within stock shows the count and no message", () => {
    const view = ready(run([plain("a", 3)], avail(5)), "a");
    expect(view).toMatchObject({ level: "ok", message: null, label: "5 pieces left" });
  });

  it("LS-8: stock at -3 reads as 0 left", () => {
    const view = ready(run([plain("a", 1)], avail(-3)), "a");
    expect(view.level).toBe("out");
    expect(view.label).toBe("0 pieces left");
    expect(view.message).toContain("None left");
  });

  it("LS-7: an unlisted line, a product the server did not return, and a failed read show nothing", () => {
    const unlisted: StockLine = { key: "u", productId: "", isUnlisted: true, qty: 2 };
    expect(run([unlisted], avail(0)).size).toBe(0);
    expect(run([plain("a", 1, { productId: "recipe" })], avail(9)).size).toBe(0);
    const failed = lineStockViews({
      lines: [plain("a", 1)],
      availability: undefined,
      failed: true,
      fetching: false,
    });
    expect(failed.size).toBe(0);
  });

  it("shows a loading note only while the first read is in flight", () => {
    const v = lineStockViews({
      lines: [plain("a", 1)],
      availability: undefined,
      failed: false,
      fetching: true,
    });
    expect(v.get("a")).toEqual({ state: "loading" });
  });

  // Read 2 hold 1: the screens hold a named-unit line's qty as a COUNT of that unit; the save stores count x factor.
  it("a named-unit line is its count x the unit's factor, like the save (3 Cases of 12 = 36 pieces)", () => {
    const line = plain("a", 3, { unitLabel: "Case", unitFactor: 12 });
    const view = ready(run([line], avail(20)), "a");
    expect(view.requestedPieces).toBe(36);
    expect(view.level).toBe("low");
    expect(view.message).toMatch(/backorder/i);
  });

  it("says what is left in the line's unit words: 20 pieces is 1 case and 8 pieces", () => {
    const line = plain("a", 3, { unitLabel: "Case", unitFactor: 12 });
    expect(ready(run([line], avail(20)), "a").label).toBe("1 case and 8 pieces left");
    expect(ready(run([line], avail(24)), "a").label).toBe("2 cases left");
    expect(ready(run([line], avail(8)), "a").label).toBe("8 pieces left");
    expect(ready(run([line], avail(36)), "a").message).toBeNull();
  });

  it("a factor-1 unit counts as it did, and reads in its own word", () => {
    const line = plain("a", 3, { unitLabel: "Each", unitFactor: 1 });
    const view = ready(run([line], avail(2)), "a");
    expect(view.requestedPieces).toBe(3);
    expect(view.label).toBe("2 each left");
  });

  it("a named-unit line with no known factor shows nothing, and so does its product's other line", () => {
    const named = plain("a", 3, { unitLabel: "Case" });
    expect(run([named], avail(20)).size).toBe(0);
    expect(run([named, plain("b", 1)], avail(20)).size).toBe(0);
  });

  it("two lines of one product add in pieces: 1 Case of 12 and 9 pieces against 20 is over", () => {
    const v = run([plain("a", 1, { unitLabel: "Case", unitFactor: 12 }), plain("b", 9)], avail(20));
    expect(ready(v, "a").requestedPieces).toBe(21);
    expect(ready(v, "a").level).toBe("low");
  });

  it("the boundary: asking for exactly what is on hand is fine (the save refuses only below)", () => {
    const view = ready(run([plain("a", 10)], avail(10)), "a");
    expect(view.level).toBe("ok");
    expect(view.message).toBeNull();
  });

  it("a box-unaware boxed line (no split) is boxes x the pack, like the save", () => {
    const line: StockLine = { key: "a", productId: "p1", qty: 2, unitsPerBox: 12 };
    expect(ready(run([line], avail(20)), "a").requestedPieces).toBe(24);
  });
});
