import { reasonField, showsReason } from "../lib/invoice-edit-reason";

/**
 * H3b: the invoice edit screen shows (and sends) a price-change reason only for a product line whose
 * price moved off the price it was offered at, or one added on the screen. A re-sent stored price
 * sends nothing, so the server keeps the stored type, reason and author.
 */
const stored = { productId: "p1", unitPrice: 24, offeredPrice: 24 };

describe("invoice edit — the price-change reason (H3b)", () => {
  it("an untouched stored line shows no field and sends no reason, even with stale text", () => {
    expect(showsReason(stored)).toBe(false);
    expect(reasonField({ ...stored, overrideReason: "stale" })).toEqual({});
  });

  it("a moved price shows the field; the trimmed reason is sent once filled", () => {
    const moved = { ...stored, unitPrice: 20 };
    expect(showsReason(moved)).toBe(true);
    expect(reasonField(moved)).toEqual({});
    expect(reasonField({ ...moved, overrideReason: "  agreed at list " })).toEqual({
      overrideReason: "agreed at list",
    });
    expect(reasonField({ ...moved, overrideReason: "   " })).toEqual({});
  });

  it("moving the price back (within half a cent) hides the field again", () => {
    expect(showsReason({ ...stored, unitPrice: 24.004 })).toBe(false);
    expect(reasonField({ ...stored, unitPrice: 24.004, overrideReason: "stale" })).toEqual({});
  });

  it("a line added on this screen (no offered price) always shows the field", () => {
    const added = { productId: "p2", unitPrice: 24 };
    expect(showsReason(added)).toBe(true);
    expect(reasonField({ ...added, overrideReason: "agreed" })).toEqual({
      overrideReason: "agreed",
    });
  });

  it("an unlisted (custom) line never carries a reason", () => {
    const custom = { productId: null, unitPrice: 9, overrideReason: "x" };
    expect(showsReason(custom)).toBe(false);
    expect(reasonField(custom)).toEqual({});
  });
});
