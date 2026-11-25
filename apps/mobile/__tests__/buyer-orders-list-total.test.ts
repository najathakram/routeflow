import { readFileSync } from "fs";
import { join } from "path";
import { buyerOrderListTotal } from "../lib/buyer-order-filters";

// B1391 (SA-1286 part 3): the buyer orders list showed `Number(order.total) || sum(qty x unitPrice)`.
// A genuine $0 order (an order discount equal to the subtotal) fell through to the gross
// qty x unitPrice of a boxed line: a 3-box line (qty 36 pieces, $18.00 a box) read "$648.00" where
// the stored total is "$0.00". The server total is the authority; the client never re-derives it.
describe("buyerOrderListTotal (B1391)", () => {
  // The 3-box line the old fallback multiplied: 36 x 18 = 648.
  const boxedLine = { qty: 36, unitPrice: 18 };

  it("a stored $0 total on a 3-box line is 0, not the gross 648 (number form)", () => {
    const order = { total: 0, lineItems: [boxedLine] };
    expect(buyerOrderListTotal(order)).toBe(0);
  });

  it("a stored $0 total on a 3-box line is 0, not the gross 648 (string form)", () => {
    const order = { total: "0.00", lineItems: [boxedLine] };
    expect(buyerOrderListTotal(order)).toBe(0);
  });

  it("a stored total is passed through as a number (keep-green)", () => {
    const order = { total: "54.00", lineItems: [boxedLine] };
    expect(buyerOrderListTotal(order)).toBe(54);
  });
});

describe("mobile buyer orders list screen (B1391)", () => {
  const src = readFileSync(join(__dirname, "..", "app/(customer)/(tabs)/orders.tsx"), "utf8");
  it("has no client qty x unitPrice fallback and uses the helper", () => {
    expect(src).not.toMatch(/Number\(i\.qty\)\s*\*\s*Number\(i\.unitPrice\)/);
    expect(src).toMatch(/buyerOrderListTotal\(order\)/);
  });
});
