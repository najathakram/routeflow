import { playScanCue, unlockScanCue } from "./scan-cue";

// The cue is observational: whatever the browser lacks or refuses, it must never throw into the
// scan path. A bare jsdom (no AudioContext) would pass a "doesn't throw" test even with the
// try/catch deleted, so these install a host whose AudioContext constructor THROWS.
describe("scan cue", () => {
  const w = window as unknown as Record<string, unknown>;
  let vibrate: jest.Mock;

  beforeEach(() => {
    vibrate = jest.fn();
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
  });
  afterEach(() => {
    delete w.AudioContext;
    // @ts-expect-error — test-only cleanup
    delete navigator.vibrate;
  });

  it("accepted vibrates short; rejected vibrates in a distinct pattern", () => {
    playScanCue("accepted");
    expect(vibrate).toHaveBeenLastCalledWith(50);
    playScanCue("rejected");
    expect(vibrate).toHaveBeenLastCalledWith([40, 60, 40]);
  });

  it("'none' does nothing at all", () => {
    playScanCue("none");
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("never throws when the AudioContext constructor throws", () => {
    w.AudioContext = function () {
      throw new Error("autoplay blocked");
    };
    expect(() => playScanCue("accepted")).not.toThrow();
    expect(() => playScanCue("rejected")).not.toThrow();
    expect(() => unlockScanCue()).not.toThrow();
  });

  it("still vibrates when the AudioContext throws — the haptic is independent of the beep", () => {
    w.AudioContext = function () {
      throw new Error("autoplay blocked");
    };
    playScanCue("accepted");
    expect(vibrate).toHaveBeenCalledWith(50);
  });

  it("never throws when vibrate itself throws", () => {
    vibrate.mockImplementation(() => {
      throw new Error("not allowed");
    });
    expect(() => playScanCue("rejected")).not.toThrow();
  });

  it("never throws when vibrate is missing (iOS Safari)", () => {
    // @ts-expect-error — simulating a browser without the Vibration API
    delete navigator.vibrate;
    expect(() => playScanCue("accepted")).not.toThrow();
  });
});
