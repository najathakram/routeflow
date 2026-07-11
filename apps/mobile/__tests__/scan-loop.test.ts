/**
 * Continuous-scan gate: camera decoders re-emit the same barcode every frame
 * while it stays in view. The gate must accept intentional scans (new code,
 * or the same code after it left the frame) and reject per-frame repeats —
 * including the "held steady past the cooldown" case, via the sliding window.
 */
import { gateScan, SCAN_COOLDOWN_MS, ScanGateState } from "../lib/scan-loop";

const t0 = 1_000_000;

describe("gateScan", () => {
  it("accepts the very first scan", () => {
    const r = gateScan("111", null, t0);
    expect(r.accept).toBe(true);
    expect(r.state).toEqual({ lastCode: "111", lastAt: t0 });
  });

  it("rejects blank codes", () => {
    expect(gateScan("", null, t0).accept).toBe(false);
    expect(gateScan("   ", null, t0).accept).toBe(false);
  });

  it("accepts a different code immediately (scan the next item)", () => {
    const first = gateScan("111", null, t0);
    const r = gateScan("222", first.state, t0 + 50);
    expect(r.accept).toBe(true);
  });

  it("rejects the same code re-decoded within the cooldown (per-frame repeat)", () => {
    const first = gateScan("111", null, t0);
    const r = gateScan("111", first.state, t0 + 100);
    expect(r.accept).toBe(false);
  });

  it("accepts the same code again after a full cooldown gap (second box of the same item)", () => {
    const first = gateScan("111", null, t0);
    const r = gateScan("111", first.state, t0 + SCAN_COOLDOWN_MS);
    expect(r.accept).toBe(true);
  });

  it("slides the window while the code stays in view — holding steady never re-adds", () => {
    // Simulate ~30fps frames of the same code for 3× the cooldown.
    let state: ScanGateState | null = null;
    let accepted = 0;
    for (let t = t0; t <= t0 + SCAN_COOLDOWN_MS * 3; t += 33) {
      const r = gateScan("111", state, t);
      state = r.state;
      if (r.accept) accepted += 1;
    }
    expect(accepted).toBe(1);
  });

  it("re-anchoring to completion time blocks a re-add of an item held past the cooldown", () => {
    // Models the scanner's busy-window fix: while onScanned is awaited, camera
    // frames DON'T call gateScan, so the window can't slide. If the lookup
    // outran the cooldown, the component re-anchors state to completion time.
    const first = gateScan("111", null, t0); // accepted, processing starts
    expect(first.accept).toBe(true);
    // ... onScanned takes 1.8s (> cooldown); frames during it are dropped by
    // the busyRef guard, so `first.state.lastAt` is still t0. The component's
    // finally block re-anchors:
    const reanchored = { lastCode: "111", lastAt: t0 + 1800 };
    // Next in-frame decode of the same code, just after completion:
    const next = gateScan("111", reanchored, t0 + 1850);
    expect(next.accept).toBe(false); // 50ms < cooldown → not re-added
  });

  it("A → B → A quickly counts every switch (alternating items on the bench)", () => {
    let state: ScanGateState | null = null;
    const codes = ["111", "222", "111"];
    const accepted = codes.filter((c, i) => {
      const r = gateScan(c, state, t0 + i * 200);
      state = r.state;
      return r.accept;
    });
    expect(accepted).toEqual(["111", "222", "111"]);
  });
});
