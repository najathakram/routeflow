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

  it("one draft, one group: every unbilled line goes on it", async () => {
    const groups = [{ trackedCategoryId: null, lineIds: ["a", "b", "c"] }];
    const r = await run([draft("d1", [["a", null]])], ["a", "b", "c"], groups);
    expect(asObj(r.placed)).toEqual({ d1: ["b", "c"] });
    expect(r.needsReview).toBe(false);
  });

  describe("A-4: one draft left, several groups", () => {
    const groups = [
      { trackedCategoryId: null, lineIds: ["std", "std2"] },
      { trackedCategoryId: "R", lineIds: ["reg", "reg2"] },
    ];
    const all = ["std", "std2", "reg", "reg2"];

    it("the base draft takes the standard lines only; the regulated one stays off, flagged", async () => {
      const r = await run([draft("base", [["std", null]])], all, groups);
      expect(asObj(r.placed)).toEqual({ base: ["std2"] });
      expect(r.needsReview).toBe(true);
    });

    it("the regulated draft takes its own group only; the standard line stays off, flagged", async () => {
      const r = await run([draft("r1", [["reg", "R"]])], all, groups);
      expect(asObj(r.placed)).toEqual({ r1: ["reg2"] });
      expect(r.needsReview).toBe(true);
    });

    it("only its own group's lines unbilled: placed, no flag", async () => {
      const r = await run([draft("base", [["std", null]])], ["std", "std2", "reg"], groups, [
        { items: [{ orderItemId: "reg" }] },
      ]);
      expect(asObj(r.placed)).toEqual({ base: ["std2"] });
      expect(r.needsReview).toBe(false);
    });

    it("an empty draft is not the base: nothing placed, flagged", async () => {
      const r = await run([draft("base")], all, groups);
      expect(asObj(r.placed)).toEqual({});
      expect(r.needsReview).toBe(true);
    });

    it("two categories on the draft: unreadable, nothing placed, flagged", async () => {
      const g3 = [...groups, { trackedCategoryId: "S", lineIds: ["s1"] }];
      const two = draft("d1", [
        ["reg", "R"],
        ["s1", "S"],
      ]);
      const r = await run([two], [...all, "s1"], g3);
      expect(asObj(r.placed)).toEqual({});
      expect(r.needsReview).toBe(true);
    });

    it("a category that is not a group (no standard group, a null key): nothing placed, flagged", async () => {
      const noStd = [
        { trackedCategoryId: "R", lineIds: ["reg", "reg2"] },
        { trackedCategoryId: "S", lineIds: ["s1"] },
      ];
      const r = await run([draft("d1", [["x", null]])], ["x", "reg", "reg2", "s1"], noStd);
      expect(asObj(r.placed)).toEqual({});
      expect(r.needsReview).toBe(true);
    });
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
