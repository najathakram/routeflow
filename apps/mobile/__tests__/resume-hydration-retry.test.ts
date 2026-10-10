/**
 * SA-165 REQUIRED fix on #1339 @0b8b0cb2e (Opus independently found the same bug): a resume
 * hydration failed by a customer-prices error never actually recovered on Retry. retryHydrate
 * bumped hydrateAttempt but never refetched the prices query, so TanStack held the stale error and
 * decideResumeHydrationStart returned "failed" again the instant Retry was pressed — the dialog
 * reopened rather than retrying.
 */
import { decideResumeHydrationStart } from "../lib/order-draft-logic";
import { shouldRetryCustomerPrices } from "../lib/query-retry-policy";

describe("shouldRetryCustomerPrices (Opus W/N)", () => {
  it("never retries a 403 — the pricing_tiers plan gate, not a transient failure", () => {
    expect(shouldRetryCustomerPrices(0, { response: { status: 403 } })).toBe(false);
  });

  it("retries a 5xx up to the count cap", () => {
    expect(shouldRetryCustomerPrices(0, { response: { status: 500 } })).toBe(true);
    expect(shouldRetryCustomerPrices(2, { response: { status: 500 } })).toBe(true);
    expect(shouldRetryCustomerPrices(3, { response: { status: 500 } })).toBe(false);
  });

  it("retries a network error with no response at all", () => {
    expect(shouldRetryCustomerPrices(0, {})).toBe(true);
  });
});

describe("resume-hydration retry lifecycle (SA-165 REQUIRED, screen/hook-level via the pure gate)", () => {
  it("5xx -> failed, Retry fires a refetch (fetching=true, errored stays true) -> waiting, refetch succeeds -> start", () => {
    // 1. The prices query settles with a genuine failure.
    expect(decideResumeHydrationStart(true, false, true, false, 500)).toBe("failed");

    // 2. Retry is pressed: retryHydrate calls refetch(), which TanStack starts immediately —
    // isFetching flips true while isError STAYS true (TanStack does not clear the old error until
    // the new attempt settles). The gate must NOT re-fail here, or Retry would be a no-op.
    expect(decideResumeHydrationStart(true, false, true, true, 500)).toBe("waiting");

    // 3. The refetch resolves successfully: isFetched true, isError false, isFetching false.
    expect(decideResumeHydrationStart(true, true, false, false, undefined)).toBe("start");
  });

  it("a 403 followed by a Retry (still gated) settles straight back to start, never a spurious failure", () => {
    expect(decideResumeHydrationStart(true, false, true, false, 403)).toBe("start");
    // Pressing Retry anyway (e.g. the operator taps it out of habit) still resolves cleanly.
    expect(decideResumeHydrationStart(true, false, true, true, 403)).toBe("waiting");
    expect(decideResumeHydrationStart(true, false, true, false, 403)).toBe("start");
  });
});
