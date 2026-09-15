/**
 * REG-SCANPILL — the scan sheet's feedback pill is a state machine, and a
 * SUCCESSFUL scan clears the previous scan's miss.
 *
 * Before `lib/scan-feedback-slot.ts`, `ScanOrderSheet.handleOutcome` wrote the
 * pill from ONE branch: `showError` on an error outcome. The success branch
 * did haptics and a tray scroll and never touched the error state — and
 * `acceptScannedProduct` returns `undefined` while the sheet is open ("the
 * tray row is the confirmation"), so a success carried nothing to overwrite it
 * with either. A miss pill (`No product for "X"`, actionable, 8000ms) therefore
 * sat over the camera with a LIVE Create button while the next item was
 * already in the tray.
 *
 * These assertions are all on the pure reducer; the JSX side of the wiring is
 * pinned as source text in `new-order-durability.test.ts`.
 */
import {
  ACTION_PILL_MS,
  ERROR_PILL_MS,
  INITIAL_SCAN_SLOT,
  pillTtlMs,
  reduceScanSlot,
  scanSlotEffects,
  type ScanFeedbackSlotState,
} from "../lib/scan-feedback-slot";
import type { ScanFeedback } from "../lib/scan-loop";

const miss: ScanFeedback = {
  kind: "error",
  text: 'No product for "0123"',
  action: { label: "Create", onPress: () => undefined },
};
const plainError: ScanFeedback = { kind: "error", text: "Still looking that up — try again." };

/** The shape `acceptScannedProduct` returns while the scan sheet is open. */
const silentAccept = undefined;

function showing(feedback: ScanFeedback): ScanFeedbackSlotState {
  return reduceScanSlot(INITIAL_SCAN_SLOT, { type: "outcome", outcome: { feedback } });
}

describe("reduceScanSlot (REG-SCANPILL)", () => {
  it("REG-SCANPILL-A: a SUCCESS clears the stale miss pill instead of leaving it over the camera", () => {
    const stale = showing(miss);
    expect(stale.pill).toEqual(miss);

    const next = reduceScanSlot(stale, { type: "outcome", outcome: silentAccept });

    // The whole defect in one assertion: pre-fix the sheet's success branch
    // never wrote the pill, so this stayed `miss` for the rest of its 8s.
    expect(next.pill).toBeNull();
    expect(next.ttlMs).toBeNull();
    expect(next.nonce).toBe(stale.nonce + 1);
  });

  it("REG-SCANPILL-B: an accept that DOES carry feedback also clears a stale error", () => {
    const stale = showing(miss);
    const added: ScanFeedback = { kind: "added", text: "Added Widget" };
    expect(
      reduceScanSlot(stale, { type: "outcome", outcome: { feedback: added } }).pill,
    ).toBeNull();
  });

  it("REG-SCANPILL-C: an error still shows, with the right lifetime for its kind", () => {
    const actionable = showing(miss);
    expect(actionable.pill).toEqual(miss);
    expect(actionable.ttlMs).toBe(ACTION_PILL_MS);

    const plain = showing(plainError);
    expect(plain.pill).toEqual(plainError);
    expect(plain.ttlMs).toBe(ERROR_PILL_MS);

    expect(pillTtlMs(miss)).toBe(ACTION_PILL_MS);
    expect(pillTtlMs(plainError)).toBe(ERROR_PILL_MS);
  });

  it("REG-SCANPILL-D: a second error REPLACES the first and restarts its clock", () => {
    const first = showing(plainError);
    const second = reduceScanSlot(first, { type: "outcome", outcome: { feedback: miss } });
    expect(second.pill).toEqual(miss);
    expect(second.ttlMs).toBe(ACTION_PILL_MS);
    // The nonce moved, so the first pill's pending expiry is now stale.
    expect(second.nonce).not.toBe(first.nonce);
  });

  it("REG-SCANPILL-E: a stale expiry cannot wipe the pill that replaced it", () => {
    const first = showing(plainError);
    const second = reduceScanSlot(first, { type: "outcome", outcome: { feedback: miss } });
    const afterStaleTimer = reduceScanSlot(second, { type: "expire", nonce: first.nonce });
    expect(afterStaleTimer).toBe(second);
    expect(afterStaleTimer.pill).toEqual(miss);

    // The CURRENT timer does clear it.
    expect(reduceScanSlot(second, { type: "expire", nonce: second.nonce }).pill).toBeNull();
  });

  it("REG-SCANPILL-F: dismiss and reset clear the pill; both are idempotent", () => {
    const stale = showing(miss);
    expect(reduceScanSlot(stale, { type: "dismiss" }).pill).toBeNull();
    expect(reduceScanSlot(stale, { type: "reset" }).pill).toBeNull();

    // Nothing to clear → the SAME object, so no needless re-render and no
    // nonce churn that would cancel a live timer.
    expect(reduceScanSlot(INITIAL_SCAN_SLOT, { type: "dismiss" })).toBe(INITIAL_SCAN_SLOT);
    expect(reduceScanSlot(INITIAL_SCAN_SLOT, { type: "reset" })).toBe(INITIAL_SCAN_SLOT);
    expect(reduceScanSlot(INITIAL_SCAN_SLOT, { type: "outcome", outcome: silentAccept })).toBe(
      INITIAL_SCAN_SLOT,
    );
  });

  it("REG-SCANPILL-G: a hand-off close clears the pill as well as closing", () => {
    const stale = showing(miss);
    const next = reduceScanSlot(stale, { type: "outcome", outcome: { close: true } });
    expect(next.pill).toBeNull();
  });

  it("REG-SCANPILL-H: effects are unchanged per branch — error cue, close, or accept + scroll", () => {
    expect(scanSlotEffects({ feedback: miss })).toEqual(["error-cue"]);
    expect(scanSlotEffects({ close: true })).toEqual(["close-sheet"]);
    expect(scanSlotEffects(silentAccept)).toEqual(["added-cue", "scroll-tray-top"]);
    expect(scanSlotEffects({})).toEqual(["added-cue", "scroll-tray-top"]);
    expect(scanSlotEffects({ feedback: { kind: "added", text: "Added Widget" } })).toEqual([
      "added-cue",
      "scroll-tray-top",
    ]);
  });

  it("REG-SCANPILL-I: an error outcome that also says close is treated as an error (pill wins)", () => {
    // The ladder never emits this, but the old branch order resolved it the
    // same way — error first — and a silent flip would strand the operator.
    const next = reduceScanSlot(INITIAL_SCAN_SLOT, {
      type: "outcome",
      outcome: { close: true, feedback: plainError },
    });
    expect(next.pill).toEqual(plainError);
    expect(scanSlotEffects({ close: true, feedback: plainError })).toEqual(["error-cue"]);
  });
});
