import { composeGridIds } from "./quick-keys-grid";

const ids = (...n: number[]) => n.map((i) => `p${i}`);
const live = (...n: number[]) => new Set(ids(...n));

describe("composeGridIds", () => {
  it("pinned first in pin order, then the ranking minus hidden minus pinned, up to the cap", () => {
    const grid = composeGridIds({
      pinned: ids(9, 3),
      hidden: ids(2),
      ranked: ids(1, 2, 3, 4, 5, 6),
      cap: 5,
      liveIds: live(1, 2, 3, 4, 5, 6, 9),
    });
    expect(grid).toEqual([
      { id: "p9", pinned: true },
      { id: "p3", pinned: true },
      { id: "p1", pinned: false },
      { id: "p4", pinned: false },
      { id: "p5", pinned: false },
    ]);
  });

  it("a pinned product that is no longer live is skipped and takes no slot", () => {
    const grid = composeGridIds({
      pinned: ids(7, 8),
      hidden: [],
      ranked: ids(1, 2),
      cap: 3,
      liveIds: live(8, 1, 2),
    });
    expect(grid.map((g) => g.id)).toEqual(["p8", "p1", "p2"]);
  });

  it("a ranked product that went inactive after the ranking was cached is dropped", () => {
    const grid = composeGridIds({
      pinned: [],
      hidden: [],
      ranked: ids(1, 2, 3),
      cap: 12,
      liveIds: live(1, 3),
    });
    expect(grid.map((g) => g.id)).toEqual(["p1", "p3"]);
  });

  it("a pin wins over a hide of the same product", () => {
    const grid = composeGridIds({
      pinned: ids(1),
      hidden: ids(1),
      ranked: ids(1, 2),
      cap: 12,
      liveIds: live(1, 2),
    });
    expect(grid).toEqual([
      { id: "p1", pinned: true },
      { id: "p2", pinned: false },
    ]);
  });

  it("pins beyond the cap are cut, and never repeat in the ranked part", () => {
    const grid = composeGridIds({
      pinned: ids(1, 2, 3, 4),
      hidden: [],
      ranked: ids(4, 5),
      cap: 3,
      liveIds: live(1, 2, 3, 4, 5),
    });
    expect(grid.map((g) => g.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("the cap is clamped to the hard maximum of 24 (and at least 1)", () => {
    const many = Array.from({ length: 40 }, (_, i) => `p${i}`);
    const all = new Set(many);
    expect(
      composeGridIds({ pinned: [], hidden: [], ranked: many, cap: 99, liveIds: all }),
    ).toHaveLength(24);
    expect(
      composeGridIds({ pinned: [], hidden: [], ranked: many, cap: 0, liveIds: all }),
    ).toHaveLength(1);
  });

  it("an empty ranking and no pins is an empty grid", () => {
    expect(
      composeGridIds({ pinned: [], hidden: [], ranked: [], cap: 12, liveIds: new Set() }),
    ).toEqual([]);
  });

  it("repeats in the inputs never repeat in the grid", () => {
    const grid = composeGridIds({
      pinned: ["p1", "p1"],
      hidden: [],
      ranked: ["p2", "p2", "p1"],
      cap: 12,
      liveIds: live(1, 2),
    });
    expect(grid.map((g) => g.id)).toEqual(["p1", "p2"]);
  });
});
