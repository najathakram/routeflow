import { readFileSync } from "fs";
import { join } from "path";

/**
 * SA-733r6 (B4), mobile buyer checkout. Jest here is pure-logic only, so the wiring is source-pinned: the buyer cart
 * reads `useSellerAcceptingOrders`, renders ONE quiet status line, disables Place Order when the seller is paused, and
 * maps a 403 SELLER_UNAVAILABLE submit refusal to the same copy. The decisions themselves are pinned in
 * seller-unavailable.test.ts. The operator order screen (NewOrderScreen) is NOT a buyer surface and stays untouched.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");
const cart = read("app", "(customer)", "orders", "cart.tsx");
const hook = read("lib", "api", "buyer-capabilities.ts");
const helper = read("lib", "seller-unavailable.ts");
const operator = read("components", "NewOrderScreen.tsx");

describe("buyer cart read-only seller wiring (SA-733r6)", () => {
  it("the cart reads the hook and the seller name from the buyer session", () => {
    expect(cart).toMatch(/useSellerAcceptingOrders\(\)/);
    expect(cart).toMatch(/useBuyerSessionStore/);
    expect(cart).toMatch(/activeSeller\?\.tenant\.name/);
  });

  it("renders the quiet line as a status role with the shared copy, only when not accepting", () => {
    expect(cart).toMatch(/!sellerAccepting \? \(/);
    expect(cart).toMatch(/role="status"/);
    expect(cart).toMatch(/accessibilityLiveRegion="polite"/);
    expect(cart).toMatch(/sellerUnavailableCopy\(sellerName\)/);
  });

  it("disables Place Order when not accepting, with the reason as the accessibility hint", () => {
    expect(cart).toMatch(/disabled=\{createMut\.isPending \|\| !sellerAccepting\}/);
    expect(cart).toMatch(
      /accessibilityState=\{\{ disabled: createMut\.isPending \|\| !sellerAccepting \}\}/,
    );
    expect(cart).toMatch(/accessibilityHint=\{sellerAccepting \? undefined : unavailableCopy\}/);
  });

  it("onPlaceOrder refuses to submit while not accepting", () => {
    expect(cart).toMatch(/if \(!sellerAccepting\) return;/);
  });

  it("maps a SELLER_UNAVAILABLE refusal through submitErrorCopy before the generic fallback", () => {
    expect(cart).toMatch(/submitErrorCopy\(e, sellerName\)/);
    const onError = cart.slice(cart.indexOf("onError:"));
    expect(onError.indexOf("submitErrorCopy(")).toBeGreaterThan(-1);
    expect(onError.indexOf("submitErrorCopy(")).toBeLessThan(
      onError.indexOf("Couldn't update your cart. Try again."),
    );
  });

  it("the code is the API_ERROR_CODES constant, never a bare literal in production code", () => {
    expect(helper).toMatch(/API_ERROR_CODES\.SELLER_UNAVAILABLE/);
    expect(helper).not.toMatch(/["']SELLER_UNAVAILABLE["']/);
    expect(cart).not.toMatch(/["']SELLER_UNAVAILABLE["']/);
  });

  it("the hook reads the one buyer capability source, keyed by seller, 5 min stale, off without a seller", () => {
    expect(hook).toMatch(/buyerApiClient\.get\("\/buyer\/capabilities"\)/);
    expect(hook).toMatch(/queryKey: \[\.\.\.BUYER_CAPABILITIES_KEY, sellerSlug\]/);
    expect(hook).toMatch(/staleTime: 5 \* 60 \* 1000/);
    expect(hook).toMatch(/enabled: !!sellerSlug/);
    expect(hook).toMatch(/isSellerAccepting\(data\)/);
  });

  it("the operator order screen is not a buyer surface and does not use the gate", () => {
    expect(operator).not.toMatch(/useSellerAcceptingOrders|sellerUnavailableCopy/);
  });
});
