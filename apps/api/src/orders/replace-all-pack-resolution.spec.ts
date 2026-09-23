import { buildPriorOrderPackInfo, resolveReplaceAllLinePack } from "./replace-all-pack-resolution";

describe("buildPriorOrderPackInfo", () => {
  it("carries an unambiguousPack only when exactly one pre-edit line for a product had a real pack", () => {
    const info = buildPriorOrderPackInfo([
      { productId: "p1", unitsPerBox: 12 },
      { productId: "p2", unitsPerBox: 12 },
      { productId: "p2", unitsPerBox: 6 },
      { productId: "p3", unitsPerBox: null },
    ]);
    expect(info.get("p1")).toEqual({ unambiguousPack: 12, allPacks: [12] });
    expect(info.get("p2")).toEqual({ unambiguousPack: undefined, allPacks: [6, 12] });
    expect(info.get("p3")).toEqual({ unambiguousPack: undefined, allPacks: [] });
    expect(info.get("p-missing")).toBeUndefined();
  });
});

describe("resolveReplaceAllLinePack — SA-124e's order (payload -> unambiguous prior snapshot -> live with a warn)", () => {
  it("SA-124e HIGH pin: a bucket's own pack (from the fold's unitsPerBox output) is recreated as itself, never the live pack", () => {
    // lines at 12 (1 box, $36) and 6, live pack 6 — the 12-pack bucket must stay 12.
    const priorPacks = buildPriorOrderPackInfo([
      { productId: "p1", unitsPerBox: 12 },
      { productId: "p1", unitsPerBox: 6 },
    ]);
    const r = resolveReplaceAllLinePack(
      { productId: "p1", boxes: 1, pieces: 0, qty: 12, unitsPerBox: 12 },
      priorPacks,
      6,
    );
    expect(r).toEqual({ pack: 12, usedLivePack: false });
  });

  it("derives the pack from the payload's own split when no explicit unitsPerBox is carried", () => {
    const r = resolveReplaceAllLinePack(
      { productId: "p1", boxes: 2, pieces: 0, qty: 24, unitsPerBox: null },
      new Map(),
      6,
    );
    expect(r).toEqual({ pack: 12, usedLivePack: false });
  });

  it("a pieces-only payload for a product with two stored packs REFUSES naming both", () => {
    const priorPacks = buildPriorOrderPackInfo([
      { productId: "p1", unitsPerBox: 12 },
      { productId: "p1", unitsPerBox: 6 },
    ]);
    expect(() =>
      resolveReplaceAllLinePack(
        { productId: "p1", boxes: null, pieces: 5, qty: 5, unitsPerBox: null },
        priorPacks,
        6,
      ),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: "MERGE_PACK_MISMATCH",
          productId: "p1",
          existingPacks: [6, 12],
        }),
      }),
    );
  });

  it("SA-124e pin: one stored snapshot plus a bare-qty payload — the snapshot wins", () => {
    const priorPacks = buildPriorOrderPackInfo([{ productId: "p1", unitsPerBox: 12 }]);
    const r = resolveReplaceAllLinePack(
      { productId: "p1", boxes: null, pieces: null, qty: 3, unitsPerBox: null },
      priorPacks,
      0,
    );
    expect(r).toEqual({ pack: 12, usedLivePack: false });
  });

  it("SA-124e pin: no stored line and no split falls to the live pack, flagged", () => {
    const r = resolveReplaceAllLinePack(
      { productId: "p1", boxes: 1, pieces: 0, qty: 1, unitsPerBox: null },
      new Map(),
      6,
    );
    expect(r).toEqual({ pack: 6, usedLivePack: true });
  });

  it("a genuinely bare-qty item with nothing resolvable anywhere stays box-unaware, no warn", () => {
    const r = resolveReplaceAllLinePack(
      { productId: "p1", boxes: null, pieces: null, qty: 3, unitsPerBox: null },
      new Map(),
      0,
    );
    expect(r).toEqual({ usedLivePack: false });
  });

  it("box data present but unresolvable, product had only ONE prior pack (no real conflict) — falls to live, never refuses", () => {
    const priorPacks = buildPriorOrderPackInfo([{ productId: "p1", unitsPerBox: 12 }]);
    // boxes: 0 is a degenerate split packFromOwnSplit refuses — but the prior pack (12) is
    // unambiguous, so step (b) already resolves it before this scenario could even arise; use
    // a product with NO prior line at all to exercise the "no conflict, fall to live" path.
    const r = resolveReplaceAllLinePack(
      { productId: "p2", boxes: 0, pieces: 5, qty: 5, unitsPerBox: null },
      priorPacks,
      6,
    );
    expect(r).toEqual({ pack: 6, usedLivePack: true });
  });
});
