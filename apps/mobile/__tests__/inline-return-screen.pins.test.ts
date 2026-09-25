import { readFileSync } from "fs";
import { join } from "path";

// Deletion-sensitive wiring pins for the operator inline-return screen (Opus #2087). The screen is
// not renderable in this pure-logic jest lane, so the money-critical wiring is source-pinned, the
// same convention as credit-limit-wiring.test.ts. Each pin names what removing it would cost.
const screen = readFileSync(
  join(__dirname, "..", "app", "(operator)", "returns", "inline.tsx"),
  "utf8",
);
const hook = readFileSync(join(__dirname, "..", "lib", "api", "inline-returns.ts"), "utf8");

describe("inline-return screen wiring pins", () => {
  it("capture is built from the QUOTED snapshot via buildInlineReturnCapture, never from live lines (§8.1a(5))", () => {
    expect(screen).toMatch(/buildInlineReturnCapture\(\s*screen,/);
    expect(screen).not.toMatch(/buildCaptureRequest\s*\(/);
  });

  it("captureStarted is dispatched BEFORE the capture mutation (locks navigation while it is in flight)", () => {
    const started = screen.indexOf('dispatch({ type: "captureStarted" })');
    const mutate = screen.indexOf("captureMut.mutate(");
    expect(started).toBeGreaterThan(-1);
    expect(mutate).toBeGreaterThan(started);
  });

  it("the back button and the swipe gesture are both locked by canLeaveInlineReturn", () => {
    expect(screen).toMatch(/const canLeave = canLeaveInlineReturn\(screen\)/);
    expect(screen).toMatch(/if \(!canLeave\) return;/);
    expect(screen).toMatch(/gestureEnabled:\s*canLeave/);
  });

  it("the screen registers the beforeRemove guard (Android system back + parent-stack swipe), not just the inner swipe", () => {
    expect(screen).toMatch(/addListener\("beforeRemove",/);
    expect(screen).toMatch(/guardInlineReturnRemove\(screen,\s*e\)/);
  });

  it("a failed capture is worded via captureFailureMessage, never as a bare refusal", () => {
    expect(screen).toMatch(/captureFailureMessage\(e\)/);
  });

  it("an offline-queued capture becomes the pending-success `queued` step, not a refusal (REG-B308)", () => {
    expect(screen).toMatch(/captureOutcomeFromError\(e\)\.kind === "queued"/);
    expect(screen).toMatch(/dispatch\(\{ type: "queued" \}\)/);
  });

  it("result steps (success / queued / refused) are never hidden behind the add-on gate", () => {
    for (const step of ["success", "queued", "refused"]) {
      expect(screen).toMatch(new RegExp(`\\{screen\\.step === "${step}" &&`));
      expect(screen).not.toMatch(new RegExp(`gate === "allowed" && screen\\.step === "${step}"`));
    }
  });

  it("the credit is shown through formatRefundAmount (a Decimal STRING), not a typeof number test", () => {
    expect(screen).toMatch(/formatRefundAmount\(screen\.result\.refundAmount\)/);
    expect(screen).not.toMatch(/typeof screen\.result\.refundAmount === "number"/);
  });

  it("controls carry accessibility roles/labels and 44pt targets", () => {
    expect(screen).toMatch(/const MIN_TARGET = 44;/);
    expect(screen).toMatch(/accessibilityRole="button"/);
    expect(screen).toMatch(/accessibilityRole="radio"/);
    expect(screen).toMatch(/accessibilityLabel=/);
  });
});

describe("useInlineReturnQuote wiring pin", () => {
  it("the quote POST opts out of the offline queue (a queued quote is meaningless)", () => {
    expect(hook).toMatch(
      /"\/returns\/inline\/quote",\s*dto,\s*\{\s*_skipOfflineQueue:\s*true\s*\}/,
    );
  });
});
