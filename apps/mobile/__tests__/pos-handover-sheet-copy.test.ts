import * as fs from "fs";
import * as path from "path";
import { HAND_OVER_SHEET_COPY, handOverPrimaryLabel } from "../lib/pos-handover-sheet-copy";

/**
 * W-818 (apple-write score of the mobile counter screens): the hand-over sheet's primary button always names the action
 * it takes, never a state. While the balance is loading or failed it stays the action, disabled; the reason sits in the
 * sheet's own error line, beside Retry. The cash field is labelled with what the cashier enters.
 */
const src = fs.readFileSync(path.join(__dirname, "../components/PosHandOverSheet.tsx"), "utf8");

describe("handOverPrimaryLabel", () => {
  const base = { action: "Hand over", submitting: false, ready: true, nothingOwed: false };
  it("names the action and the payment when something is owed", () => {
    expect(handOverPrimaryLabel(base)).toBe("Hand over and take payment");
  });
  it("names the action alone when nothing is owed", () => {
    expect(handOverPrimaryLabel({ ...base, nothingOwed: true })).toBe("Hand over");
  });
  it("a balance not read yet (loading or failed) keeps the action, never a state", () => {
    expect(handOverPrimaryLabel({ ...base, ready: false })).toBe("Hand over");
  });
  it("the busy state is the one progressive form", () => {
    expect(handOverPrimaryLabel({ ...base, submitting: true })).toBe("Saving…");
  });
});

describe("PosHandOverSheet copy", () => {
  it("labels the cash field with what is entered", () => {
    expect(HAND_OVER_SHEET_COPY.cashReceived).toBe("Cash received");
    expect(src).toContain("HAND_OVER_SHEET_COPY.cashReceived");
    expect(src).not.toContain("Amount ($)");
  });
  // #3716 review N1/N2: with the label no longer saying "unavailable", the guard alone stops a payment against a balance
  // that isn't known, so it is pinned, and the button looks and announces disabled whenever it is.
  describe("the primary button while the balance is unknown", () => {
    const button = (() => {
      const at = src.indexOf("handOverPrimaryLabel(");
      const start = src.lastIndexOf("<Pressable", at);
      return src.slice(start, at);
    })();
    it("is disabled until the balance is ready (the only guard against paying an unknown balance)", () => {
      expect(button).toContain("disabled={submitting || !ready}");
    });
    it("is dimmed whenever it is disabled", () => {
      expect(button).toMatch(/\(submitting \|\| !ready\) && \{ opacity: 0\.5 \}/);
    });
    it("tells VoiceOver it is disabled", () => {
      expect(button).toContain("accessibilityState={{ disabled: submitting || !ready }}");
    });
  });

  it("the primary button reads handOverPrimaryLabel, and no state label is left in the sheet", () => {
    expect(src).toContain("handOverPrimaryLabel(");
    expect(src).not.toContain("Balance unavailable");
  });
});
