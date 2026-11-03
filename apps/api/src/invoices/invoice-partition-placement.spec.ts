import { placeUnbilledLines } from "./invoice-partition";

/** SA-1098 A-3: where a live order line that no non-void invoice bills goes back, and when it is left off. */
describe("placeUnbilledLines", () => {
  const draft = (id: string, items: Array<[string, string | null]> = []) => ({
    id,
    items: items.map(([orderItemId, trackedCategoryId]) => ({ orderItemId, trackedCategoryId })),
  });
  const run = (
    drafts: ReturnType<typeof draft>[],
    lineIds: string[],
    groups: Array<{ trackedCategoryId: string | null; lineIds: string[] }>,
    extraInvoices: Array<{ items: Array<{ orderItemId: string }> }> = [],
  ) =>
    placeUnbilledLines({
      invoices: [...drafts, ...extraInvoices],
      drafts,
      lineIds,
      groupsOf: async () => groups,
    });
  const asObj = (m: Map<string, string[]>) => Object.fromEntries(m);

  it("nothing unbilled: nothing placed, the grouping function is not even asked", async () => {
    const groupsOf = jest.fn();
    const r = await placeUnbilledLines({
      invoices: [draft("d1", [["a", null]])],
      drafts: [draft("d1", [["a", null]])],
      lineIds: ["a"],
      groupsOf,
    });
    expect(asObj(r.placed)).toEqual({});
    expect(r.needsReview).toBe(false);
    expect(groupsOf).not.toHaveBeenCalled();
  });

  it("one draft: every unbilled line goes on it", async () => {
    const r = await run([draft("d1", [["a", null]])], ["a", "b", "c"], []);
    expect(asObj(r.placed)).toEqual({ d1: ["b", "c"] });
    expect(r.needsReview).toBe(false);
  });

  it("a line billed by a finalized invoice is not unbilled", async () => {
    const r = await run(
      [draft("d1", [["a", null]])],
      ["a", "b"],
      [],
      [{ items: [{ orderItemId: "b" }] }],
    );
    expect(asObj(r.placed)).toEqual({});
  });

  it("several drafts: the line goes on the draft holding its category, never the first", async () => {
    const groups = [
      { trackedCategoryId: null, lineIds: ["std", "std2"] },
      { trackedCategoryId: "R", lineIds: ["reg", "reg2"] },
    ];
    const r = await run(
      [draft("base", [["std", null]]), draft("r1", [["reg", "R"]])],
      ["std", "std2", "reg", "reg2"],
      groups,
    );
    expect(asObj(r.placed)).toEqual({ base: ["std2"], r1: ["reg2"] });
    expect(r.needsReview).toBe(false);
  });

  it("several drafts, one with no items left: by position, when the group count equals the draft count", async () => {
    const groups = [
      { trackedCategoryId: null, lineIds: ["std"] },
      { trackedCategoryId: "R", lineIds: ["reg"] },
    ];
    const r = await run([draft("base"), draft("r1")], ["std", "reg"], groups);
    expect(asObj(r.placed)).toEqual({ base: ["std"], r1: ["reg"] });
    expect(r.needsReview).toBe(false);
  });

  it("by position, a draft that still holds items must agree with its position, else review", async () => {
    const groups = [
      { trackedCategoryId: null, lineIds: ["std"] },
      { trackedCategoryId: "R", lineIds: ["reg", "reg2"] },
    ];
    // the second draft holds an item of another category than the group at its position
    const r = await run(
      [draft("base"), draft("r1", [["reg", "OTHER"]])],
      ["std", "reg", "reg2"],
      groups,
    );
    expect(asObj(r.placed)).toEqual({});
    expect(r.needsReview).toBe(true);
  });

  it("groups and drafts differ in number: nothing guessed, review", async () => {
    const groups = [
      { trackedCategoryId: null, lineIds: ["std"] },
      { trackedCategoryId: "R", lineIds: ["reg"] },
      { trackedCategoryId: "S", lineIds: ["s1"] },
    ];
    const r = await run(
      [draft("base", [["std", null]]), draft("r1", [["reg", "R"]])],
      ["std", "reg", "s1"],
      groups,
    );
    expect(asObj(r.placed)).toEqual({});
    expect(r.needsReview).toBe(true);
  });

  it("two separate categories on one draft: ambiguous, review", async () => {
    const groups = [
      { trackedCategoryId: "R", lineIds: ["r1"] },
      { trackedCategoryId: "S", lineIds: ["s1", "s2"] },
    ];
    const r = await run(
      [
        draft("d1", [
          ["r1", "R"],
          ["s1", "S"],
        ]),
        draft("d2", [["x", "S"]]),
      ],
      ["r1", "s1", "s2"],
      groups,
    );
    expect(r.needsReview).toBe(true);
    expect(asObj(r.placed)).toEqual({});
  });
});
