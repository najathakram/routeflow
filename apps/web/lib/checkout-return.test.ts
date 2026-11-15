import * as fs from "fs";
import * as path from "path";
import { isCheckoutCancelled, isStripeReturn } from "./checkout-return";

// SA-1139 R5 (amended): ONE predicate for "back from Stripe", read by every web reader.
describe("isStripeReturn", () => {
  it("is true for paid=1 or checkout=success, as a string or as params", () => {
    expect(isStripeReturn("paid=1")).toBe(true);
    expect(isStripeReturn("?checkout=success")).toBe(true);
    expect(isStripeReturn(new URLSearchParams("checkout=success&session_id=cs_1"))).toBe(true);
  });
  it("is false for anything else, cancelled included", () => {
    for (const q of ["", "paid=0", "checkout=cancelled", "checkout=other", "card=1"]) {
      expect(isStripeReturn(q)).toBe(false);
    }
    expect(isStripeReturn(null)).toBe(false);
  });
  it("cancelled is its own predicate", () => {
    expect(isCheckoutCancelled(new URLSearchParams("checkout=cancelled"))).toBe(true);
    expect(isCheckoutCancelled(new URLSearchParams("checkout=success"))).toBe(false);
  });
});

describe("structural pin: only lib/checkout-return.ts reads `paid` or `checkout` from the query", () => {
  const root = path.resolve(__dirname, "..");
  const SKIP = new Set(["node_modules", ".next", "e2e", "coverage", ".jest-cache", "public"]);
  function walk(dir: string, out: string[]) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p);
    }
  }
  it('no other source file calls get("paid") or get("checkout")', () => {
    const files: string[] = [];
    walk(root, files);
    const offenders = files
      .filter((f) => path.basename(f) !== "checkout-return.ts")
      .filter((f) => /\.get\(\s*["'](paid|checkout)["']\s*\)/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f));
    expect(offenders).toEqual([]);
  });
});
