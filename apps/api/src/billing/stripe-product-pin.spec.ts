import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * W-810 / SA-931 structural pin. Every recurring price in billing points at a product WE own
 * (`ensureStripeProduct`); a Checkout-born inline product is born inactive and breaks the later price push.
 */
const dir = __dirname;
// Comments may explain the rule by naming the thing it bans.
const stripComments = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sources = readdirSync(dir)
  .filter((f) => f.endsWith(".ts") && !/\.spec\.ts$|\.db\.spec\.ts$/.test(f))
  .map((f) => ({ f, text: stripComments(readFileSync(join(dir, f), "utf8")) }));

describe("W-810 product pin", () => {
  it("no recurring price_data carries product_data (the one-time catch-up stub is the only exception)", () => {
    const offenders = sources
      .filter(({ text }) => /\bproduct_data\b/.test(text))
      .map(({ f }) => f)
      // catchup-session-params builds the ONE-TIME stub line (no recurring price to push) and documents it
      .filter((f) => f !== "catchup-session-params.ts");
    expect(offenders).toEqual([]);
  });

  it("catchup-session-params uses product_data only on the one-time stub", () => {
    const text = sources.find((s) => s.f === "catchup-session-params.ts")!.text;
    const uses = text.match(/product_data/g) ?? [];
    expect(uses.length).toBe(1);
    expect(text).toMatch(/unit_amount: stubCents,\s*product_data/);
  });

  it("nothing creates a product outside the helper", () => {
    const offenders = sources
      .filter(({ text }) => /products\s*\.\s*create\s*\(/.test(text))
      .map(({ f }) => f)
      .filter((f) => f !== "stripe-product.ts");
    expect(offenders).toEqual([]);
  });

  it("no push path takes its product from the item's current price", () => {
    const offenders = sources
      .filter(({ text }) => /\bprice\??\.product\b/.test(text))
      .map(({ f }) => f)
      // stripe-addon-items reads the product only to tell an add-on from the base plan (metadata.addonSku)
      // plan-change-stripe / plan-change-flow only SNAPSHOT or COMPARE the prior product for a revert
      .filter(
        (f) =>
          !["stripe-addon-items.ts", "plan-change-stripe.ts", "plan-change-flow.ts"].includes(f),
      );
    expect(offenders).toEqual([]);
  });
});
