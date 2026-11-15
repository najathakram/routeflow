import { assertQtyNotBelowDelivered } from "./delivered-line-lock";

/** SA-1149 (corrected helper): refuses only when the next qty is below BOTH the delivered and the held qty. */
describe("assertQtyNotBelowDelivered", () => {
  const refuses = (d: number, held: number, next: number) =>
    expect(() => assertQtyNotBelowDelivered(d, held, next)).toThrow();
  const allows = (d: number, held: number, next: number) =>
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
