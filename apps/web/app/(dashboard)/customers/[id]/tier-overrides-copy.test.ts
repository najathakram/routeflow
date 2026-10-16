/**
 * Units/prices S5 (copy only): the customer page's per-product section sets a pricing TIER (and an
 * MSRP), never a price of its own, so it must not be called "Product Overrides" or "Price Override".
 * Source pins, the same way `unit-vocabulary.pins.test.ts` reads copy.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(resolve(__dirname, "page.tsx"), "utf8");

describe("customer page: per-product tier overrides copy (S5)", () => {
  it.each([
    ">Product Overrides<",
    "Add Override",
    "No product overrides set.",
    "Add Price Override",
    "Edit Price Override",
    "Per-product overrides below",
  ])("no longer says %j", (s) => {
    expect(src).not.toContain(s);
  });

  it.each([
    ">Tier overrides<",
    "Add tier override",
    "No tier overrides set.",
    "Add tier override",
    "Edit tier override",
    "Tier overrides below take",
  ])("says %j", (s) => {
    expect(src).toContain(s);
  });

  it("uses no em dash in the section", () => {
    const start = src.indexOf(">Tier overrides<");
    expect(start).toBeGreaterThan(0);
    expect(src.slice(start, start + 1500)).not.toContain("\u2014");
  });
});

describe("product page: tier helper copy (S5)", () => {
  const product = readFileSync(resolve(__dirname, "../../products/[id]/page.tsx"), "utf8");
  it("says a blank tier follows the list price, in plain words", () => {
    expect(product).not.toContain("Tiers left at 0 inherit the list price at checkout.");
    expect(product).toContain("A tier left blank or at 0 follows the list price.");
  });
});
