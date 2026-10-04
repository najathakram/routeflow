import { readFileSync } from "fs";
import { join } from "path";
import { freshLineStartPrice } from "../lib/start-price";
import { pricingGate } from "../lib/pricing-gate";

/**
 * B1037 (money): a line added in the order editor starts at the customer's OWN price (tier or special, owner ruling
 * 10-03), never their remembered last price. A driver still starts at LIST: the server bills list for a non-staff
 * driver until the server fix removes that gate (the same gate as #3114's picker).
 * B1038 (money): when the customer-pricing fetch FAILS the editor must not fall back to tier 1 (list) while the
 * server bills the tier price: pricing is NOT ready, the picker/substitute stay shut, and the banner offers Retry.
 */
describe("B1037: the fresh-line start price", () => {
  it("a remembered 7 against a tier price of 8: the line starts at 8", () => {
    expect(freshLineStartPrice({ catalogPrice: 8, listPrice: 10, isDriver: false })).toBe(8);
  });
  it("a SPECIAL price is the catalog price the editor already resolved: it is the start", () => {
    expect(freshLineStartPrice({ catalogPrice: 6.5, listPrice: 10, isDriver: false })).toBe(6.5);
  });
  it("a driver starts at LIST (what today's server bills), not the tier price", () => {
    expect(freshLineStartPrice({ catalogPrice: 8, listPrice: 10, isDriver: true })).toBe(10);
  });
});

describe("B1038: pricingGate", () => {
  const base = {
    customerId: "c1",
    customerPending: false,
    customerFailed: false,
    pricesPending: false,
    pricesFailed: false,
  };
  it("no customer: ready (a disabled query stays pending forever)", () => {
    expect(
      pricingGate({ ...base, customerId: undefined, customerPending: true, pricesPending: true }),
    ).toEqual({ ready: true, loading: false, failed: false });
  });
  it("both settled ok: ready", () => {
    expect(pricingGate(base)).toEqual({ ready: true, loading: false, failed: false });
  });
  it("either query in flight: loading, not ready", () => {
    expect(pricingGate({ ...base, pricesPending: true })).toEqual({
      ready: false,
      loading: true,
      failed: false,
    });
  });
  it("a FAILED customer fetch or a FAILED prices fetch: NOT ready, failed (never the tier-1 fallback)", () => {
    expect(pricingGate({ ...base, customerFailed: true })).toEqual({
      ready: false,
      loading: false,
      failed: true,
    });
    expect(pricingGate({ ...base, pricesFailed: true })).toMatchObject({
      ready: false,
      failed: true,
    });
  });
  it("failed wins over a still-pending sibling", () => {
    expect(pricingGate({ ...base, customerFailed: true, pricesPending: true })).toMatchObject({
      ready: false,
      failed: true,
      loading: false,
    });
  });
});

describe("wiring in the order editor", () => {
  const src = readFileSync(
    join(__dirname, "..", "app/(operator)/(tabs)/orders/[id]/edit-items.tsx"),
    "utf8",
  );
  it("B1037: addPickedToDraft starts at freshLineStartPrice and no longer reads the remembered price", () => {
    expect(src).toMatch(/freshLineStartPrice\(\{ catalogPrice, listPrice, isDriver \}\)/);
    expect(src).not.toMatch(/hist\.lastPrice/);
    expect(src).not.toMatch(/useCustomerPriceHistory/);
  });
  it("B1038: pricingReady comes from pricingGate, and the old 'errored fetch is ready' rule is gone", () => {
    expect(src).toMatch(/pricingGate\(/);
    expect(src).not.toMatch(/customerFailed\) && \(!pricesPending \|\| pricesFailed\)/);
  });
  it("B1038: the Add button shows fixed 'Price unavailable' copy with a Retry that refetches both queries", () => {
    expect(src).toMatch(/Price unavailable/);
    expect(src).toMatch(/refetchCustomer\(\)/);
    expect(src).toMatch(/refetchPrices\(\)/);
  });
});
