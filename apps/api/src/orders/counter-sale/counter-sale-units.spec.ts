/**
 * SA-1040 B4a: a counter line can carry a unit (a Case, a Pallet). Pins the two pieces the counter owns:
 *  - the mapper passes the unit through, with the unit count as `qty` and nothing synthesised from boxes/pieces, so
 *    create() (buildUnitLine) makes every decision (it refuses `boxes` on a unit line);
 *  - the counter's own replay price check keys on product AND unit, so a Case line and a pack line of one product
 *    are two different lines (create()'s `replayLineKey` already keys that way).
 * REAL replayLineKey, REAL mapper: nothing mocked.
 */
import { replayLineKey } from "../unit-line-build";
import { toCounterOrderItem } from "./counter-sale-lines";
import { assertReplaySamePrices } from "./counter-sale-replay-price";

/** The response body of what `fn` throws (the coded 409 carries its code there), "" when it does not throw. */
const thrown = (fn: () => void): string => {
  try {
    fn();
    return "";
  } catch (e) {
    return JSON.stringify((e as { getResponse?: () => unknown }).getResponse?.() ?? String(e));
  }
};

describe("toCounterOrderItem with a unit", () => {
  it("passes the unit and the unit count; a pack line is unchanged", () => {
    expect(toCounterOrderItem({ productId: "p1", unitLabel: "Case", qty: 2 } as never, 10)).toEqual(
      {
        productId: "p1",
        unitLabel: "Case",
        qty: 2,
      },
    );
    expect(toCounterOrderItem({ productId: "p1", boxes: 2 } as never, 10)).toEqual({
      productId: "p1",
      qty: 20,
      boxes: 2,
    });
  });

  it("trims the label; a blank label is a pack line", () => {
    expect(
      toCounterOrderItem({ productId: "p1", unitLabel: "  Case ", qty: 1 } as never, 10),
    ).toMatchObject({ unitLabel: "Case" });
    expect(toCounterOrderItem({ productId: "p1", unitLabel: "  ", boxes: 1 } as never, 10)).toEqual(
      {
        productId: "p1",
        qty: 10,
        boxes: 1,
      },
    );
  });

  it("boxes on a unit line is passed on, never dropped: create() refuses it, the counter adds no rule", () => {
    expect(
      toCounterOrderItem({ productId: "p1", unitLabel: "Case", boxes: 1 } as never, 10),
    ).toMatchObject({ unitLabel: "Case", boxes: 1 });
  });

  it("carries the typed price, its reason and the note", () => {
    expect(
      toCounterOrderItem(
        {
          productId: "p1",
          unitLabel: "Case",
          qty: 1,
          unitPrice: 40,
          priceReason: "promo",
          note: " fragile ",
        } as never,
        10,
      ),
    ).toEqual({
      productId: "p1",
      unitLabel: "Case",
      qty: 1,
      unitPrice: 40,
      overrideReason: "promo",
      notes: "fragile",
    });
  });

  it("keys like the stored unit line: the unit count against the stored boxes", () => {
    const item = toCounterOrderItem({ productId: "p1", unitLabel: "Case", qty: 2 } as never, 10);
    const stored = { productId: "p1", qty: 400, boxes: 2, unitLabel: "Case" };
    expect(replayLineKey(item as never, false)).toBe(replayLineKey(stored as never, true));
  });
});

describe("assertReplaySamePrices keys on the unit", () => {
  const stored = (unitLabel: string | null, unitPrice: number) => ({
    productId: "p1",
    status: "PENDING",
    unitLabel,
    unitPrice,
    overriddenBy: null,
  });
  const order = (...lines: ReturnType<typeof stored>[]) => ({ id: "o1", lineItems: lines });

  it("passes when each request line meets a stored line of the same product and unit", () => {
    expect(() =>
      assertReplaySamePrices(order(stored("Case", 45), stored(null, 25)), [
        { productId: "p1", unitLabel: "Case", qty: 1 },
        { productId: "p1", boxes: 1 },
      ] as never),
    ).not.toThrow();
  });

  it("a pack request line does not take a stored Case line of the same product (a shape this ruling creates)", () => {
    const err = thrown(() =>
      assertReplaySamePrices(order(stored("Case", 45)), [{ productId: "p1", boxes: 1 }] as never),
    );
    expect(err).toContain("IDEMPOTENCY_KEY_CART_MISMATCH");
  });

  it("a Case request line does not take a stored pack line", () => {
    const err = thrown(() =>
      assertReplaySamePrices(order(stored(null, 25)), [
        { productId: "p1", unitLabel: "Case", qty: 1 },
      ] as never),
    );
    expect(err).toContain("IDEMPOTENCY_KEY_CART_MISMATCH");
  });

  it("the unit match ignores case and padding, like replayLineKey", () => {
    expect(() =>
      assertReplaySamePrices(order(stored("Case", 45)), [
        { productId: "p1", unitLabel: " case ", qty: 1 },
      ] as never),
    ).not.toThrow();
  });

  it("still judges the price on the matched unit line: a different typed price on the Case line is the 409", () => {
    const err = thrown(() =>
      assertReplaySamePrices(order(stored("Case", 45), stored(null, 25)), [
        { productId: "p1", unitLabel: "Case", qty: 1, unitPrice: 40 },
        { productId: "p1", boxes: 1 },
      ] as never),
    );
    expect(err).toContain("IDEMPOTENCY_KEY_CART_MISMATCH");
  });
});
