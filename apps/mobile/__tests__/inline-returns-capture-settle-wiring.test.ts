import { readFileSync } from "fs";
import { join } from "path";

// SA-091b (Opus review of #1270): a unit test of shouldSettleInlineReturnNonce/
// captureOutcomeFromError alone cannot catch a WIRING bug in useCaptureInlineReturn — deleting
// the markCaptureSettled call from onSuccess, or passing the wrong customerId/orderId, stays
// 13/13 green on the pure helpers. useMutation's onSuccess/onError aren't renderable in this
// jest lane (pure-logic only), so the wiring is source-pinned instead, the same convention as
// credit-limit-wiring.test.ts.
describe("useCaptureInlineReturn — nonce-settle wiring (SA-091/SA-091a/SA-091b)", () => {
  const src = readFileSync(join(__dirname, "..", "lib", "api", "inline-returns.ts"), "utf8");
  const onSuccessAt = src.indexOf("onSuccess:");
  const onErrorAt = src.indexOf("onError:");
  const onSuccessBody = src.slice(onSuccessAt, onErrorAt);
  const onErrorBody = src.slice(onErrorAt);

  it("onSuccess calls markCaptureSettled keyed on the mutation VARIABLES' customerId/orderId, gated on shouldSettleInlineReturnNonce", () => {
    expect(onSuccessAt).toBeGreaterThan(-1);
    expect(onErrorAt).toBeGreaterThan(onSuccessAt);
    expect(onSuccessBody).toMatch(/shouldSettleInlineReturnNonce\(\{\s*kind:\s*"success"\s*\}\)/);
    expect(onSuccessBody).toMatch(
      /markCaptureSettled\(\s*inlineReturnNonceKey\(\s*variables\.customerId,\s*variables\.orderId\s*\)\s*\)/,
    );
  });

  it("onError classifies through captureOutcomeFromError, never the raw error, and never settles a queued (not-yet-attempted) outcome", () => {
    expect(onErrorBody).toMatch(/captureOutcomeFromError\(error\)/);
    // The "queued" guard: a third outcome shape that must never reach markCaptureSettled here.
    expect(onErrorBody).toMatch(/outcome\.kind\s*!==\s*"queued"/);
    expect(onErrorBody).toMatch(/shouldSettleInlineReturnNonce\(outcome\)/);
    expect(onErrorBody).toMatch(
      /markCaptureSettled\(\s*inlineReturnNonceKey\(\s*variables\.customerId,\s*variables\.orderId\s*\)\s*\)/,
    );
  });

  it("onError does not hand-roll its own status check — it defers entirely to captureOutcomeFromError, the one place both the hook and the offline-queue drain share", () => {
    // A regression back to an inline `error.response?.status` check would silently diverge from
    // captureOutcomeFromError's retry-409/isOfflineQueued handling — this pin fails on that.
    expect(onErrorBody).not.toMatch(/error\.response\?\.\s*status/);
  });
});
