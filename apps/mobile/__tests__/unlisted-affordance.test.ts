/**
 * The order/invoice builders must always offer a way to add an ad-hoc
 * ("unlisted") line. Every cart/review-sheet opener is gated on lines already
 * existing, so with a non-empty catalog and an empty cart the catalog list is
 * the only path in — "the customer wants something we don't stock" is exactly
 * how such an order STARTS.
 */
import { unlistedAffordancePlacement } from "../lib/unlisted-affordance";

describe("unlistedAffordancePlacement", () => {
  it("offers the list footer while the catalog has rows — the empty cart's only way in", () => {
    expect(unlistedAffordancePlacement({ rowCount: 120, loading: false })).toBe("list-footer");
  });

  it("offers the list footer even for a single row", () => {
    expect(unlistedAffordancePlacement({ rowCount: 1, loading: false })).toBe("list-footer");
  });

  it("hands the opener to the empty state when nothing matches", () => {
    expect(unlistedAffordancePlacement({ rowCount: 0, loading: false })).toBe("empty-state");
  });

  it("shows nothing while an empty catalog is still loading", () => {
    expect(unlistedAffordancePlacement({ rowCount: 0, loading: true })).toBe("none");
  });

  it("keeps the footer during a refetch that still has rows on screen", () => {
    expect(unlistedAffordancePlacement({ rowCount: 8, loading: true })).toBe("list-footer");
  });

  it("never places the opener twice, and never drops it once the catalog settles", () => {
    for (const rowCount of [0, 1, 2, 50]) {
      const placement = unlistedAffordancePlacement({ rowCount, loading: false });
      expect(placement).not.toBe("none");
      // One placement value ⇒ the empty state and the footer can never both render.
      expect(["empty-state", "list-footer"]).toContain(placement);
    }
  });
});
