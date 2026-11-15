// SA-1153 row 28: the one resolver's own unit spec: resolution order (order, then estimate, then own), both refusals, and guard G.
import {
  AFTER,
  BEFORE,
  CUTOVER,
  underCutover,
  withDiscountCutover,
} from "./testing/discount-cutover";
import { MoneyInvariantError } from "@routeflow/pricing";
import { discountModeOf, newDocumentDiscountMode } from "./discount-tax-mode";

describe("discountModeOf (SA-1141 R3/R4, SA-1153 row 28 and guard G)", () => {
  withDiscountCutover();

  it("a document with no source relations reads its own createdAt", () => {
    expect(discountModeOf({ createdAt: BEFORE })).toBe("LEGACY_POST_TAX");
    expect(discountModeOf({ createdAt: AFTER })).toBe("PRE_TAX");
    expect(discountModeOf({ createdAt: CUTOVER })).toBe("PRE_TAX"); // at the instant: PRE_TAX
  });

  it("order first: an invoice cut from an order made BEFORE is LEGACY whatever its own and its estimate's date", () => {
    const inv = {
      createdAt: AFTER,
      orderId: "o-1",
      order: { createdAt: BEFORE },
      estimate: { createdAt: AFTER },
    };
    expect(discountModeOf(inv)).toBe("LEGACY_POST_TAX");
  });

  it("then estimate: an invoice converted from a quote made BEFORE is LEGACY though it was created AFTER", () => {
    const inv = { createdAt: AFTER, orderId: null, order: null, estimate: { createdAt: BEFORE } };
    expect(discountModeOf(inv)).toBe("LEGACY_POST_TAX");
  });

  it("then own: estimate null resolves to the invoice's own createdAt", () => {
    expect(discountModeOf({ createdAt: AFTER, orderId: null, order: null, estimate: null })).toBe(
      "PRE_TAX",
    );
    expect(discountModeOf({ createdAt: BEFORE, orderId: null, order: null, estimate: null })).toBe(
      "LEGACY_POST_TAX",
    );
  });

  it("refusal 1 (:38-42): an order-linked invoice loaded without its order", () => {
    expect(() => discountModeOf({ createdAt: AFTER, orderId: "o-1", estimate: null })).toThrow(
      MoneyInvariantError,
    );
    expect(() => discountModeOf({ createdAt: AFTER, orderId: "o-1", estimate: null })).toThrow(
      /without its order/,
    );
  });

  it("refusal 2: a document with nothing to read", () => {
    expect(() => discountModeOf({})).toThrow(/no createdAt/);
    expect(() => discountModeOf(null)).toThrow(MoneyInvariantError);
  });

  describe("G: an invoice loaded without its estimate relation (the estimate gap)", () => {
    it("is refused: an invoice (orderId key), no order.createdAt, estimate undefined", () => {
      const inv = { createdAt: AFTER, orderId: null, order: null }; // `estimate` not selected
      expect(() => discountModeOf(inv)).toThrow(MoneyInvariantError);
      expect(() => discountModeOf(inv)).toThrow(/without its estimate/);
    });

    it("is refused when the order relation is absent too, and when order is null on a manual invoice", () => {
      expect(() => discountModeOf({ createdAt: BEFORE, orderId: null })).toThrow(
        /without its estimate/,
      );
    });

    it("estimate: null (loaded, none) resolves to own, not a refusal", () => {
      expect(discountModeOf({ createdAt: BEFORE, orderId: null, estimate: null })).toBe(
        "LEGACY_POST_TAX",
      );
    });

    it("a resolved order.createdAt needs no estimate relation (the order wins)", () => {
      expect(
        discountModeOf({ createdAt: AFTER, orderId: "o-1", order: { createdAt: BEFORE } }),
      ).toBe("LEGACY_POST_TAX");
    });

    it("an order or an estimate itself (no orderId key) is not an invoice: read as itself", () => {
      expect(discountModeOf({ createdAt: BEFORE })).toBe("LEGACY_POST_TAX");
    });

    it("dark it reads nothing: the same unloaded invoice is LEGACY, never a refusal", async () => {
      const dark = await underCutover(null, () =>
        discountModeOf({ createdAt: AFTER, orderId: null, order: null }),
      );
      expect(dark).toBe("LEGACY_POST_TAX");
      const darkLinked = await underCutover(null, () =>
        discountModeOf({ createdAt: AFTER, orderId: "o-1" }),
      );
      expect(darkLinked).toBe("LEGACY_POST_TAX");
    });
  });

  it("newDocumentDiscountMode is 'now' read against the cutover", () => {
    expect(newDocumentDiscountMode()).toBe("PRE_TAX");
    expect(newDocumentDiscountMode(BEFORE)).toBe("LEGACY_POST_TAX");
  });
});
