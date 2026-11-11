import { moveLine, orderByIds, movedTitle } from "./cart-line-order";

/** W-1187 PR-2b: a cart (the order builder, the counter) is a local list; its array order IS the order that is saved. */
type L = { id: string; n: number };
const abc: L[] = [
  { id: "A", n: 1 },
  { id: "B", n: 2 },
  { id: "C", n: 3 },
];
const ids = (l: L[]) => l.map((x) => x.id);

describe("orderByIds", () => {
  it("puts the lines in the given id order", () => {
    expect(ids(orderByIds(abc, ["C", "A", "B"], (l) => l.id))).toEqual(["C", "A", "B"]);
  });
  it("keeps a line the list does not name (added since) at the END, in its own order", () => {
    const more = [...abc, { id: "D", n: 4 }, { id: "E", n: 5 }];
    expect(ids(orderByIds(more, ["C", "A", "B"], (l) => l.id))).toEqual(["C", "A", "B", "D", "E"]);
  });
  it("skips an id the cart no longer holds (removed since)", () => {
    expect(ids(orderByIds(abc, ["C", "X", "A", "B"], (l) => l.id))).toEqual(["C", "A", "B"]);
  });
  it("returns the same objects and never mutates its input", () => {
    const copy = [...abc];
    const out = orderByIds(abc, ["B", "C", "A"], (l) => l.id);
    expect(abc).toEqual(copy);
    expect(out[0]).toBe(abc[1]);
  });
});

describe("moveLine", () => {
  it("moves a line to an index (0-based) and keeps the rest in order", () => {
    expect(ids(moveLine(abc, "C", 0, (l) => l.id))).toEqual(["C", "A", "B"]);
    expect(ids(moveLine(abc, "A", 2, (l) => l.id))).toEqual(["B", "C", "A"]);
  });
  it("is a no-op (same array) for the same index, an unknown id, or an index out of range", () => {
    expect(moveLine(abc, "B", 1, (l) => l.id)).toBe(abc);
    expect(moveLine(abc, "Z", 0, (l) => l.id)).toBe(abc);
    expect(moveLine(abc, "A", 3, (l) => l.id)).toBe(abc);
    expect(moveLine(abc, "A", -1, (l) => l.id)).toBe(abc);
  });
});

describe("movedTitle", () => {
  it("says which line went where, in 1-based words", () => {
    expect(movedTitle("Cola", 0)).toBe("Moved Cola to line 1");
  });
});
