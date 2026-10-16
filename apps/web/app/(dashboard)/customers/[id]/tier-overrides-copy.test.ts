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
    "These beat the customer's default tier",
  ])("no longer says %j", (s) => {
    expect(src).not.toContain(s);
  });

  it.each([
    ">Tier overrides<",
    "Add tier override",
    "No tier overrides set.",
    "Edit tier override",
    "Tier overrides below take",
    "These take precedence over the customer's default tier",
  ])("says %j", (s) => {
    expect(src).toContain(s);
  });

  it("uses no em dash anywhere in the section's copy (comments are not copy)", () => {
    const start = src.indexOf(">Tier overrides<");
    const end = src.indexOf("function CommentsTab");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const copy = src
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(copy.length).toBeGreaterThan(1500); // the whole section, not a slice
    expect(copy).not.toContain("\u2014");
  });
});

describe("product page: tier helper copy (S5)", () => {
  const product = readFileSync(resolve(__dirname, "../../products/[id]/page.tsx"), "utf8");
  it("says a blank tier follows the list price, in plain words", () => {
    expect(product).not.toContain("Tiers left at 0 inherit the list price at checkout.");
    expect(product).toContain("A tier left blank or at 0 follows the list price.");
  });
});
