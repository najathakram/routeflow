/**
 * F30 / REG-B202 PR1 commit 2 — the ergonomics half of the web scan-engine
 * work: an audible + haptic accept/reject cue so an operator scanning fast
 * doesn't have to watch the screen to know a scan landed (silent drops used
 * to happen exactly when they weren't looking). The DECISION (this file)
 * is split from the PLAYING (`scan-cue(.web).ts`) so it unit-tests in plain
 * node Jest with zero AudioContext/vibrate involved — see `scan-feedback.ts`'s
 * header for why.
 *
 * `scan-feedback.ts` doesn't exist yet beyond a signature-only stub (every
 * export returns `undefined`), and `scan-cue.ts`'s `safePlay` stub calls its
 * argument UNGUARDED (no try/catch yet) — so every assertion below compares a
 * WHOLE returned value via `toEqual`, or asserts a throw expectation, never a
 * property read off a stub's result, so the suite fails on a clean assertion
 * mismatch (or an actual thrown error), not a crash from a missing export.
 */
import { cueForOutcome } from "../lib/scan-feedback";
import { safePlay } from "../lib/scan-cue";
import type { ScanOutcome } from "../lib/scan-loop";

describe("cueForOutcome (REG-B202 PR1 commit 2)", () => {
  it("REG-B202/CUE1: an 'added' feedback cues accepted", () => {
    const outcome: ScanOutcome = { feedback: { kind: "added", text: "Added 1x SKU-1" } };
    expect(cueForOutcome(outcome)).toEqual("accepted");
  });

  it("REG-B202/CUE2: an 'error' feedback cues rejected", () => {
    const outcome: ScanOutcome = { feedback: { kind: "error", text: "Not found" } };
    expect(cueForOutcome(outcome)).toEqual("rejected");
  });

  it("REG-B202/CUE3: a void outcome (still scanning, no feedback shown) cues none", () => {
    // The gate/dedupe reject path in scan-engine.ts never even calls the
    // handler, but a handler is also free to return nothing on purpose.
    const outcome: ScanOutcome = undefined;
    expect(cueForOutcome(outcome)).toEqual("none");
  });

  it("REG-B202/CUE4: an explicit undefined outcome cues none", () => {
    // Same runtime value as CUE3 (`void` and `undefined` are indistinguishable
    // at runtime) — pinned separately because the rules list both by name.
    expect(cueForOutcome(undefined)).toEqual("none");
  });

  it("REG-B202/CUE5: a close-only outcome (no feedback) cues none — a hand-off is not an accept/reject", () => {
    const outcome: ScanOutcome = { close: true };
    expect(cueForOutcome(outcome)).toEqual("none");
  });

  it("REG-B202/CUE6: an outcome with neither close nor feedback cues none", () => {
    const outcome: ScanOutcome = {};
    expect(cueForOutcome(outcome)).toEqual("none");
  });

  it("REG-B202/CUE7: a feedback carrying an action button still cues by kind alone", () => {
    // ScanFeedback.action only changes how the pill renders (a button vs
    // plain text) — it must never change which cue plays.
    const outcome: ScanOutcome = {
      feedback: {
        kind: "error",
        text: "Unknown SKU",
        action: { label: "Create it", onPress: () => undefined },
      },
    };
    expect(cueForOutcome(outcome)).toEqual("rejected");
  });
});

describe("safePlay (REG-B202 PR1 commit 2) — the total-ness contract", () => {
  it("REG-B202/CUE8: a throwing player never lets the throw past safePlay", () => {
    // This is the critical isolation pin: playScanCue's web implementation
    // does real AudioContext/vibrate work this suite can't exercise (no DOM
    // in node Jest), so the swallowing contract is pinned here instead, at
    // the seam both scan-cue.ts (native no-op) and scan-cue.web.ts share.
    expect(() =>
      safePlay(() => {
        throw new Error("AudioContext exploded");
      }),
    ).not.toThrow();
  });

  it("REG-B202/CUE9: a non-throwing player still actually runs", () => {
    // The swallow must not turn safePlay into a no-op — only a THROW gets
    // caught; a well-behaved player still fires.
    const spy = jest.fn();
    safePlay(spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

/**
 * The pins above exercise `scan-cue.ts` — the NATIVE no-op sibling. The file
 * that actually ships to the phone browsers this whole change is for is
 * `scan-cue.web.ts`, which is deliberately self-contained (it does not reuse
 * `safePlay`, see its header) and would otherwise have its "never throws"
 * contract entirely unpinned — the one contract standing between a broken
 * speaker and a broken scan.
 *
 * ⚠️ Asserting `.not.toThrow()` in a bare node env proves NOTHING here: with
 * no `window`, `beep` returns before it can touch an AudioContext, and
 * `navigator.vibrate?.()` optional-chains away. Verified by mutation — with
 * `playScanCue`'s try/catch DELETED, such a test still passed. So each pin
 * below installs a host that actively THROWS on the exact API the player
 * reaches for, which is the real failure being defended against (an autoplay-
 * blocked or unavailable AudioContext, a vibrate that rejects). The module is
 * re-required per test because its AudioContext handle is module-scoped, and
 * imported by explicit path because bare `"../lib/scan-cue"` resolves to the
 * native file under Jest.
 */
describe("scan-cue.web (REG-B202 PR1 commit 2) — the SHIPPED player is total", () => {
  const originalWindow = (globalThis as Record<string, unknown>).window;
  const originalNavigator = (globalThis as Record<string, unknown>).navigator;

  function loadWebCue(): { playScanCue: (c: string) => void; unlockScanCue: () => void } {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- explicit platform file, see block comment
    return require("../lib/scan-cue.web");
  }

  /** A host whose AudioContext constructor throws — an autoplay-blocked or
   *  unavailable audio stack, the most likely real failure on a phone. */
  function installExplodingAudio(): void {
    (globalThis as Record<string, unknown>).window = {
      AudioContext: function AudioContextThatThrows() {
        throw new Error("AudioContext blocked");
      },
    };
  }

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = originalWindow;
    }
    if (originalNavigator === undefined) {
      delete (globalThis as Record<string, unknown>).navigator;
    } else {
      (globalThis as Record<string, unknown>).navigator = originalNavigator;
    }
    jest.resetModules();
  });

  it("REG-B202/CUE10: an accepted cue swallows a throwing AudioContext", () => {
    installExplodingAudio();
    const webCue = loadWebCue();
    expect(() => webCue.playScanCue("accepted")).not.toThrow();
  });

  it("REG-B202/CUE11: a rejected cue swallows a throwing AudioContext", () => {
    installExplodingAudio();
    const webCue = loadWebCue();
    expect(() => webCue.playScanCue("rejected")).not.toThrow();
  });

  it("REG-B202/CUE12: a throwing navigator.vibrate is swallowed too", () => {
    // No window at all, so the beep is skipped and vibrate is the only thing
    // the player touches — isolating the haptic half of the contract.
    delete (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).navigator = {
      vibrate: () => {
        throw new Error("vibrate denied");
      },
    };
    const webCue = loadWebCue();
    expect(() => webCue.playScanCue("accepted")).not.toThrow();
  });

  it("REG-B202/CUE13: unlockScanCue swallows a throwing AudioContext", () => {
    installExplodingAudio();
    const webCue = loadWebCue();
    expect(() => webCue.unlockScanCue()).not.toThrow();
  });

  it("REG-B202/CUE14: 'none' stays a pure no-op — it never even reaches the audio stack", () => {
    // Proven by the exploding host: if 'none' touched audio at all, the
    // constructor would throw, and (per CUE10) only the try/catch would hide
    // it — so this also pins that the early return happens BEFORE the try.
    installExplodingAudio();
    const webCue = loadWebCue();
    expect(() => webCue.playScanCue("none")).not.toThrow();
  });
});
