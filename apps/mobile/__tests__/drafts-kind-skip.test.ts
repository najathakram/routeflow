/**
 * SA-1222 PR-A (R4): the phone cannot open a PURCHASE_ORDER builder draft. The drafts strip lists only the kinds
 * the order builder opens, so a PO draft is never offered as an "Order" (and never swept as a submitted one).
 */
import { openableDrafts } from "../lib/drafts-payload";

const draft = (id: string, kind: string) =>
  ({
    id,
    kind,
    payload: {},
    createdAt: "2026-11-22T10:00:00.000Z",
    updatedAt: "2026-11-22T10:00:00.000Z",
  }) as never;

describe("openableDrafts (SA-1222)", () => {
  it("R4: skips a PURCHASE_ORDER draft and keeps the order and invoice drafts, in order", () => {
    const list = [draft("a", "ORDER"), draft("po", "PURCHASE_ORDER"), draft("b", "INVOICE")];
    expect(openableDrafts(list).map((d: { id: string }) => d.id)).toEqual(["a", "b"]);
  });

  it("skips a kind this build has never heard of", () => {
    expect(openableDrafts([draft("x", "ESTIMATE")])).toEqual([]);
  });
});
