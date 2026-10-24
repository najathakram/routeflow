import * as fs from "fs";
import * as path from "path";

/**
 * The cart screen must not render raw server text (`response.data.message`) in its toast: it shows
 * fixed copy instead. Source guard, per the mobile pure-logic test style.
 */
const src = fs.readFileSync(path.join(__dirname, "../app/(customer)/orders/cart.tsx"), "utf8");

describe("customer cart screen error copy", () => {
  it("does not render response.data.message or the raw error message", () => {
    expect(src).not.toMatch(/data\?\.message/);
    expect(src).not.toMatch(/\be\?\.message\b/);
  });

  it("falls back to fixed copy", () => {
    expect(src).toContain("Couldn't update your cart. Try again.");
  });
});
