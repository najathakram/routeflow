import { readFileSync } from "fs";
import { join } from "path";

/**
 * B1409 (#4509 F5): the buyer line limit is ONE number, BUYER_LINE_QTY_MAX in @routeflow/pricing. The earlier
 * "no literal" guards covered only the API DTO and the stepper; these cover the other web callers.
 */
const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");

describe("no literal buyer line limit in the other web callers (B1409)", () => {
  it.each([
    ["buyer-cart-line.ts (the clamp helpers)", "buyer-cart-line.ts", "BUYER_LINE_QTY_MAX"],
    ["buyer-cart.ts (the cart hook)", "buyer-cart.ts", "lineMaxCount|lineLimit"],
    [
      "CartRowQty.tsx (cart and favorites)",
      "../app/buyer/portal/[seller]/_components/CartRowQty.tsx",
      "BUYER_LINE_QTY_MAX|lineMaxCount|lineLimit",
    ],
  ])("%s reads the shared limit, never a literal", (_n, rel, needle) => {
    const src = read(rel);
    expect(src).toMatch(new RegExp(needle));
    expect(src).not.toMatch(/100_?000/);
  });
});
