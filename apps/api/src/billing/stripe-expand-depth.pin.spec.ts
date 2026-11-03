import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { STRIPE_MAX_EXPAND_LEVELS, stripeExpandLevels } from "../testing/stripe-expand-rule";

/**
 * Class pin: no Stripe `expand` path in the API's source is deeper than Stripe allows (4 levels).
 *
 * `StripeService.getSubscriptionPaymentState` shipped asking for `latest_invoice.payments.data.payment.payment_intent`
 * (5 levels). Stripe refuses it, the reader rethrows, and a duplicate paid checkout could never be parked, cancelled
 * or applied. Its spec faked Stripe with a retrieve that accepts anything, and even pinned the path, so CI stayed
 * green. This reads the real strings out of the source: an `expand: [...]` list, or a `*_EXPAND` constant.
 */
const SRC = path.resolve(__dirname, "..");
const SCRIPTS = path.resolve(__dirname, "../../scripts");

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules" && name !== "dist") files(p, out);
    } else if (/\.(ts|mjs|cjs|js)$/.test(name) && !/\.(spec|test)\.|\.d\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Every `expand` path string in a source text: `expand: [..]` lists and `..EXPAND.. = [..]` constants. */
export function expandPaths(source: string): string[] {
  const text = stripComments(source);
  const lists = [
    ...text.matchAll(/\bexpand\s*:\s*\[([^\]]*)\]/g),
    ...text.matchAll(/\b\w*EXPAND\w*\s*(?::[^=]+)?=\s*\[([^\]]*)\]/g),
  ];
  const paths: string[] = [];
  for (const m of lists) {
    for (const lit of m[1].matchAll(/["'`]([A-Za-z0-9_.]+)["'`]/g)) paths.push(lit[1]);
  }
  return paths;
}

describe("Stripe expand depth (class pin)", () => {
  it("detector self-test: sees a 5-level path, a constant, and leaves 4 levels alone", () => {
    const bad = `await stripe.subscriptions.retrieve(id, { expand: ["latest_invoice.payments.data.payment.payment_intent"] });`;
    expect(expandPaths(bad)).toEqual(["latest_invoice.payments.data.payment.payment_intent"]);
    expect(expandPaths(bad).map(stripeExpandLevels)).toEqual([5]);
    const constant = `export const SOME_EXPAND = ["a.b.c.d", 'x'] as const;`;
    expect(expandPaths(constant)).toEqual(["a.b.c.d", "x"]);
    expect(
      expandPaths(constant).every((p) => stripeExpandLevels(p) <= STRIPE_MAX_EXPAND_LEVELS),
    ).toBe(true);
    expect(expandPaths(`// expand: ["a.b.c.d.e"]\n/* expand: ["a.b.c.d.e"] */`)).toEqual([]);
  });

  it("the scan is not vacuous: it finds the known paths", () => {
    const all = [...files(SRC), ...files(SCRIPTS)].flatMap((f) =>
      expandPaths(readFileSync(f, "utf8")),
    );
    for (const known of [
      "items.data.price.product",
      "discounts",
      "payments.data.payment.payment_intent",
    ]) {
      expect(all).toContain(known);
    }
  });

  it("no expand path in apps/api/src or apps/api/scripts is deeper than 4 levels", () => {
    const offenders: string[] = [];
    for (const f of [...files(SRC), ...files(SCRIPTS)]) {
      for (const p of expandPaths(readFileSync(f, "utf8"))) {
        if (stripeExpandLevels(p) > STRIPE_MAX_EXPAND_LEVELS) {
          offenders.push(
            `${path.relative(SRC, f).replace(/\\/g, "/")}: ${p} (${stripeExpandLevels(p)} levels)`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
