import { resolveLinePack, groupContributionsByPack } from "./merge-pack-resolve";

describe("resolveLinePack — SA-101(1)(a) precedence", () => {
  it("prefers the line's own unitsPerBox snapshot over everything else", () => {
    const r = resolveLinePack({ qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 }, 6);
    expect(r).toEqual({ pack: 12, usedLivePack: false });
  });

  it("derives the pack from the line's own boxes/pieces/qty when no snapshot is stored", () => {
    // 2 boxes + 3 loose pieces = 27 total pieces -> pack = (27 - 3) / 2 = 12.
    const r = resolveLinePack({ qty: 27, boxes: 2, pieces: 3, unitsPerBox: null }, 6);
    expect(r).toEqual({ pack: 12, usedLivePack: false });
  });

  it("falls back to the live pack, flagged, for a box-unaware line with no split at all", () => {
    const r = resolveLinePack({ qty: 2, boxes: null, pieces: null, unitsPerBox: null }, 6);
    expect(r).toEqual({ pack: 6, usedLivePack: true });
  });

  it("falls back to the live pack for a degenerate split it cannot derive from (boxes: 0)", () => {
    const r = resolveLinePack({ qty: 5, boxes: 0, pieces: 5, unitsPerBox: null }, 6);
    expect(r).toEqual({ pack: 6, usedLivePack: true });
  });

  it("Opus round 3 (MED): a PLAIN product (live pack <= 1 too) resolves with usedLivePack false — never boxed is not a fallback", () => {
    const r = resolveLinePack({ qty: 5, boxes: null, pieces: null, unitsPerBox: null }, 0);
    expect(r).toEqual({ pack: 0, usedLivePack: false });
    const r2 = resolveLinePack({ qty: 5, boxes: null, pieces: null, unitsPerBox: null }, 1);
    expect(r2).toEqual({ pack: 1, usedLivePack: false });
  });
});

describe("groupContributionsByPack — SA-101(1)(b)", () => {
  const line = (over: Record<string, unknown>) => ({
    qty: 0,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    ...over,
  });

  it("agreeing packs land in ONE group", () => {
    const winner = line({ qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 });
    const loser = line({ qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12 });
    const { groups, disagreement, packsSeen } = groupContributionsByPack([winner], [loser], 12);
    expect(disagreement).toBe(false);
    expect(packsSeen).toEqual([12]);
    expect(groups).toHaveLength(1);
    expect(groups[0].isWinnerGroup).toBe(true);
    expect(groups[0].winnerInGroup).toBe(winner);
    expect(groups[0].contributions).toEqual([winner, loser]);
  });

  it("disagreeing packs split into separate groups, never folded, never refused", () => {
    const winner = line({ qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 });
    const loser = line({ qty: 6, boxes: 1, pieces: 0, unitsPerBox: 6 });
    const { groups, disagreement, packsSeen } = groupContributionsByPack([winner], [loser], 6);
    expect(disagreement).toBe(true);
    expect(packsSeen).toEqual([6, 12]);
    expect(groups).toHaveLength(2);
    const winnerGroup = groups.find((g) => g.isWinnerGroup)!;
    const loserGroup = groups.find((g) => !g.isWinnerGroup)!;
    expect(winnerGroup.pack).toBe(12);
    expect(winnerGroup.contributions).toEqual([winner]);
    expect(winnerGroup.isSingleMove).toBe(false); // it's the winner's own line, never a "move"
    expect(loserGroup.pack).toBe(6);
    expect(loserGroup.contributions).toEqual([loser]);
    expect(loserGroup.isSingleMove).toBe(true); // one loser, nothing to fold it with
  });

  it("two losers sharing a pack the winner does NOT have still merge with each other", () => {
    const winner = line({ qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 });
    const loserA = line({ qty: 6, boxes: 1, pieces: 0, unitsPerBox: 6 });
    const loserB = line({ qty: 6, boxes: 1, pieces: 0, unitsPerBox: 6 });
    const { groups } = groupContributionsByPack([winner], [loserA, loserB], 6);
    expect(groups).toHaveLength(2);
    const sixGroup = groups.find((g) => g.pack === 6)!;
    expect(sixGroup.contributions).toEqual([loserA, loserB]);
    expect(sixGroup.isSingleMove).toBe(false);
    expect(sixGroup.isWinnerGroup).toBe(false);
  });

  it("no winner line at all: a lone loser contribution is a single-move create", () => {
    const loser = line({ qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12 });
    const { groups } = groupContributionsByPack([], [loser], 12);
    expect(groups).toHaveLength(1);
    expect(groups[0].isSingleMove).toBe(true);
    expect(groups[0].isWinnerGroup).toBe(false);
    expect(groups[0].winnerInGroup).toBeUndefined();
  });

  it("a product made unboxed: a line with its own 12-pack snapshot keeps its pack despite live=0", () => {
    const winner = line({ qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12 });
    const { groups, packsSeen } = groupContributionsByPack([winner], [], 0);
    expect(packsSeen).toEqual([12]);
    expect(groups[0].pack).toBe(12);
  });

  describe("SA-124a: multiple winner lines for one product (the durable result of an earlier pack-mismatch sweep)", () => {
    it("two winner lines at different packs each land in their OWN group; a loser folds into only the matching one", () => {
      const winner12 = line({ qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 });
      const winner6 = line({ qty: 6, boxes: 1, pieces: 0, unitsPerBox: 6 });
      const loser = line({ qty: 6, boxes: 1, pieces: 0, unitsPerBox: 6 });
      const { groups, packsSeen } = groupContributionsByPack([winner12, winner6], [loser], 6);
      expect(packsSeen).toEqual([6, 12]);
      expect(groups).toHaveLength(2);
      const group12 = groups.find((g) => g.pack === 12)!;
      const group6 = groups.find((g) => g.pack === 6)!;
      // the 12-pack winner line has no loser to fold — untouched (contributions.length === 1).
      expect(group12.winnerInGroup).toBe(winner12);
      expect(group12.contributions).toEqual([winner12]);
      // the 6-pack winner line is the one the loser actually folds into.
      expect(group6.winnerInGroup).toBe(winner6);
      expect(group6.contributions).toEqual([winner6, loser]);
    });

    it("a loser matching NEITHER existing winner pack still becomes its own single-move group, both winner lines untouched", () => {
      const winner12 = line({ qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 });
      const winner6 = line({ qty: 6, boxes: 1, pieces: 0, unitsPerBox: 6 });
      const loser24 = line({ qty: 24, boxes: 1, pieces: 0, unitsPerBox: 24 });
      const { groups, packsSeen } = groupContributionsByPack([winner12, winner6], [loser24], 24);
      expect(packsSeen).toEqual([6, 12, 24]);
      expect(groups).toHaveLength(3);
      const group24 = groups.find((g) => g.pack === 24)!;
      expect(group24.isWinnerGroup).toBe(false);
      expect(group24.isSingleMove).toBe(true);
      expect(group24.contributions).toEqual([loser24]);
    });
  });
});
