import {
  assertQtyNotBelowDelivered,
  isLiveDeliveredLine,
  ORDER_HAS_NO_LIVE_DELIVERED_LINE,
} from "./delivered-line-lock";

/** SA-1149 (corrected helper): refuses only when the next qty is below BOTH the delivered and the held qty. */
describe("assertQtyNotBelowDelivered", () => {
  const refuses = (d: number, held: number, next: number) =>
    expect(() => assertQtyNotBelowDelivered(d, held, next)).toThrow();
  const allows = (d: number | null, held: number, next: number) =>
    expect(() => assertQtyNotBelowDelivered(d, held, next)).not.toThrow();

  it("a cut below both is refused", () => {
    refuses(5, 5, 3);
    refuses(4, 2, 1);
    refuses(10, 10, 6);
  });
  it("equal, a raise, a restate of an over-delivered line, and an undelivered line are allowed", () => {
    allows(5, 5, 5);
    allows(5, 5, 7);
    allows(4, 2, 2);
    allows(4, 2, 3);
    allows(0, 5, 1);
    allows(null, 5, 1);
  });
});

/** SA-1149 M1-u: the JS twin and the Prisma fragment agree on live or CANCELLED x d 0 or 0.001. */
describe("ORDER_HAS_NO_LIVE_DELIVERED_LINE and isLiveDeliveredLine", () => {
  const none = ORDER_HAS_NO_LIVE_DELIVERED_LINE.lineItems.none;
  /** The fragment's `none` clause evaluated by hand on one line: does the line match it (making the order ineligible)? */
  const fragmentMatches = (l: { status: string; deliveredQty: number }) =>
    l.deliveredQty > none.deliveredQty.gt && l.status !== none.status.not;

  it.each([
    ["live, d 0", { status: "ACTIVE", deliveredQty: 0 }, false],
    ["live, d 0.001", { status: "ACTIVE", deliveredQty: 0.001 }, true],
    ["CANCELLED, d 0", { status: "CANCELLED", deliveredQty: 0 }, false],
    ["CANCELLED, d 0.001", { status: "CANCELLED", deliveredQty: 0.001 }, false],
  ])("%s", (_n, line, live) => {
    expect(isLiveDeliveredLine(line)).toBe(live);
    expect(fragmentMatches(line)).toBe(live);
  });
});
