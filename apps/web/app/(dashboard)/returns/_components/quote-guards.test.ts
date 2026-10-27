import * as fs from "fs";
import * as path from "path";
import { REFUND_COPY } from "./refund-copy";
import { confirmRefusal, walkInStoreCreditRefused } from "./quote-guards";

/**
 * Review-a P1 (SA-972 §2.2): the two last-line guards of the inline-return dialog, pure so a quote shape can be thrown at
 * them without the footer that normally hides the button. A walk-in is a walk-in whatever the quote's `canRefund` says.
 */
describe("walkInStoreCreditRefused: keyed on the quote's customerIsWalkIn, never on the derived walkIn", () => {
  it("a walk-in quote that cannot be refunded still refuses store credit (the derived `walkIn` is false there)", () => {
    expect(walkInStoreCreditRefused({ canRefund: false, customerIsWalkIn: true })).toBe(true);
  });
  it("a refundable walk-in refuses it too", () => {
    expect(walkInStoreCreditRefused({ canRefund: true, customerIsWalkIn: true })).toBe(true);
  });
  it("a named customer, a missing quote and a quote with no flag do not", () => {
    expect(walkInStoreCreditRefused({ canRefund: true, customerIsWalkIn: false })).toBe(false);
    expect(walkInStoreCreditRefused({ canRefund: false })).toBe(false);
    expect(walkInStoreCreditRefused(null)).toBe(false);
  });
});

describe("confirmRefusal: a walk-in that cannot be refunded is refused, never captured with no resolution", () => {
  it("names the refusal, ahead of the reason check", () => {
    expect(confirmRefusal({ walkInNoRefund: true, hasReason: true })).toBe(
      REFUND_COPY.walkInNoRefund,
    );
    expect(confirmRefusal({ walkInNoRefund: true, hasReason: false })).toBe(
      REFUND_COPY.walkInNoRefund,
    );
  });
  it("a missing reason is the reason prompt; a refundable return passes", () => {
    expect(confirmRefusal({ walkInNoRefund: false, hasReason: false })).toBe(
      "Choose a reason before confirming",
    );
    expect(confirmRefusal({ walkInNoRefund: false, hasReason: true })).toBeNull();
  });
});

describe("the dialog uses them (a structural pin: the guards are not re-derived inline)", () => {
  const src = fs.readFileSync(path.join(__dirname, "RecordInlineReturnDialog.tsx"), "utf8");
  it("doStoreCredit asks walkInStoreCreditRefused(quoted), not the derived walkIn", () => {
    const body = src.slice(src.indexOf("function doStoreCredit("));
    expect(
      body.slice(0, body.indexOf("busyRef.current")).includes("walkInStoreCreditRefused(quoted)"),
    ).toBe(true);
  });
  it("handleConfirm asks confirmRefusal before any capture is sent", () => {
    const at = src.indexOf("function handleConfirm()");
    expect(src.indexOf("confirmRefusal(", at)).toBeGreaterThan(at);
    expect(src.indexOf("confirmRefusal(", at)).toBeLessThan(
      src.indexOf("captureMutation.mutate(", at),
    );
  });
});
