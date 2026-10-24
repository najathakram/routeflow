import {
  isSellerAccepting,
  sellerUnavailableCopy,
  submitErrorCopy,
} from "../lib/seller-unavailable";

/**
 * SA-733r6 (B4), mobile buyer side. The API sends ONE boolean (`acceptingOrders`) and no reason; the buyer sees one
 * quiet line and Place Order is disabled. Unknown (loading, error, absent) NEVER blocks. Mirrors web's
 * `SellerUnavailableLine` (apps/web/components/SellerUnavailableLine.tsx) word for word.
 */
const refusal = (status: number, data: unknown) =>
  Object.assign(new Error("Request failed"), { response: { status, data } });

describe("sellerUnavailableCopy", () => {
  it("names the seller", () => {
    expect(sellerUnavailableCopy("Acme Supply")).toBe(
      "Acme Supply isn't taking online orders right now. Please check back soon or contact them.",
    );
  });

  it("falls back to 'This seller' for a missing, empty or blank name", () => {
    const expected =
      "This seller isn't taking online orders right now. Please check back soon or contact them.";
    expect(sellerUnavailableCopy(undefined)).toBe(expected);
    expect(sellerUnavailableCopy(null)).toBe(expected);
    expect(sellerUnavailableCopy("")).toBe(expected);
    expect(sellerUnavailableCopy("   ")).toBe(expected);
  });

  it("trims the name", () => {
    expect(sellerUnavailableCopy("  Acme  ")).toMatch(/^Acme isn't taking/);
  });

  it("never mentions payment, billing or plans", () => {
    expect(sellerUnavailableCopy("Acme")).not.toMatch(/payment|billing|plan|subscription|trial/i);
  });
});

describe("isSellerAccepting", () => {
  it("is false only when the API says acceptingOrders is false", () => {
    expect(isSellerAccepting({ acceptingOrders: false })).toBe(false);
  });

  it("is true for acceptingOrders true", () => {
    expect(isSellerAccepting({ acceptingOrders: true })).toBe(true);
  });

  it("never blocks on unknown: absent field, loading, error, null", () => {
    expect(isSellerAccepting({})).toBe(true);
    expect(isSellerAccepting(undefined)).toBe(true);
    expect(isSellerAccepting(null)).toBe(true);
  });
});

describe("submitErrorCopy", () => {
  it("maps a 403 SELLER_UNAVAILABLE refusal to the same copy", () => {
    const err = refusal(403, { code: "SELLER_UNAVAILABLE", message: "raw server text" });
    expect(submitErrorCopy(err, "Acme")).toBe(sellerUnavailableCopy("Acme"));
    expect(submitErrorCopy(err, undefined)).toBe(sellerUnavailableCopy(undefined));
  });

  it("never returns the server's own message", () => {
    const err = refusal(403, { code: "SELLER_UNAVAILABLE", message: "raw server text" });
    expect(submitErrorCopy(err, "Acme")).not.toContain("raw server text");
  });

  it("leaves other errors untouched (null)", () => {
    expect(submitErrorCopy(refusal(403, { code: "FORBIDDEN" }), "Acme")).toBeNull();
    expect(submitErrorCopy(refusal(409, { code: "IDEMPOTENCY_KEY_CONFLICT" }), "Acme")).toBeNull();
    expect(submitErrorCopy(refusal(500, { message: "boom" }), "Acme")).toBeNull();
    expect(submitErrorCopy(refusal(403, {}), "Acme")).toBeNull();
    expect(submitErrorCopy(refusal(403, undefined), "Acme")).toBeNull();
  });

  it("requires the 403 status as well as the code", () => {
    expect(submitErrorCopy(refusal(400, { code: "SELLER_UNAVAILABLE" }), "Acme")).toBeNull();
  });

  it("returns null for non-HTTP errors and non-errors", () => {
    expect(submitErrorCopy(new Error("Network Error"), "Acme")).toBeNull();
    expect(submitErrorCopy(null, "Acme")).toBeNull();
    expect(submitErrorCopy(undefined, "Acme")).toBeNull();
    expect(submitErrorCopy("SELLER_UNAVAILABLE", "Acme")).toBeNull();
  });
});
