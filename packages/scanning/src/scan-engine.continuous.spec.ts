import {
  continuousFrameScanned,
  createContinuousScanState,
  scanSettled,
  type ContinuousScanState,
} from "./scan-engine";
import type { AimBoxRect, BarcodeBoundsLike } from "./aim-box";

const T0 = 1_000_000;
const IN_BOX: AimBoxRect = { x: 0, y: 0, width: 100, height: 100 };
const IN_BOX_BOUNDS: BarcodeBoundsLike = {
  origin: { x: 40, y: 40 },
  size: { width: 20, height: 20 },
};
const OUT_OF_BOX_BOUNDS: BarcodeBoundsLike = {
  origin: { x: 500, y: 500 },
  size: { width: 20, height: 20 },
};

/** Feeds a continuous hold of `code` at `fps` for `durationMs`, returns every step. */
function holdFrames(
  state: ContinuousScanState,
  code: string,
  fps: number,
  durationMs: number,
  opts: { aimBox?: AimBoxRect | null; bounds?: BarcodeBoundsLike | null } = {},
) {
  const intervalMs = 1000 / fps;
  const steps: ReturnType<typeof continuousFrameScanned>[] = [];
  let s = state;
  for (let t = 0; t <= durationMs; t += intervalMs) {
    const step = continuousFrameScanned(s, code, T0 + Math.round(t), {
      bounds: opts.bounds ?? IN_BOX_BOUNDS,
      aimBox: opts.aimBox ?? IN_BOX,
    });
    s = step.next;
    steps.push(step);
  }
  return steps;
}

describe("continuousFrameScanned — #2131 review round 1 regression pins", () => {
  it.each([10, 30])(
    "a 5s continuous hold at %dHz produces EXACTLY ONE accept, never a periodic re-accept",
    (fps) => {
      const steps = holdFrames(createContinuousScanState(), "HELD-CODE", fps, 5000);
      const accepts = steps.filter((s) => s.startResolving === "HELD-CODE");
      expect(accepts).toHaveLength(1);
    },
  );

  it("a 5s hold with dropped frames (misses) still produces exactly one accept", () => {
    // ~10Hz with every 3rd frame dropped (a decoder miss) — gaps stay well under the
    // steady-read AND absence-gap tolerances, so this must behave identically to a clean hold.
    let s = createContinuousScanState();
    let accepts = 0;
    let frame = 0;
    for (let t = 0; t <= 5000; t += 100) {
      frame++;
      if (frame % 3 === 0) continue; // simulate a missed decode this tick
      const step = continuousFrameScanned(s, "HELD-CODE", T0 + t, {
        bounds: IN_BOX_BOUNDS,
        aimBox: IN_BOX,
      });
      s = step.next;
      if (step.startResolving) accepts++;
    }
    expect(accepts).toBe(1);
  });

  it("tolerates identical events ~500ms apart (a slow Code 39 decode) and still accepts once", () => {
    let s = createContinuousScanState();
    let accepts = 0;
    for (const t of [0, 500, 1000]) {
      const step = continuousFrameScanned(s, "CODE39", T0 + t, {
        bounds: IN_BOX_BOUNDS,
        aimBox: IN_BOX,
      });
      s = step.next;
      if (step.startResolving) accepts++;
    }
    expect(accepts).toBe(1);
  });

  it("two codes present at once (A/B interleave) each accept independently, neither blocking the other", () => {
    let s = createContinuousScanState();
    const accepted: string[] = [];
    const frames: Array<[string, number]> = [
      ["A", 0],
      ["B", 100],
      ["A", 200],
      ["B", 300],
      ["A", 400], // A's 3rd frame -> steady -> accept
      ["B", 500], // B's 3rd frame -> steady -> accept
      ["A", 600],
      ["B", 700],
    ];
    for (const [code, t] of frames) {
      const step = continuousFrameScanned(s, code, T0 + t, {
        bounds: IN_BOX_BOUNDS,
        aimBox: IN_BOX,
      });
      s = step.next;
      if (step.startResolving) {
        accepted.push(step.startResolving);
        // Drain the buffer immediately — this test is about the aim-box/steady-read/gate
        // composition per code, not the pending-buffer's own bounded-queue behavior
        // (covered by scan-engine.spec.ts), so each accept resolves before the next frame.
        s = scanSettled(s).next;
      }
    }
    expect(accepted).toEqual(["A", "B"]);
  });

  it("a not-yet-steady frame still keeps the gate's lastSeenAt fresh (the round-1 absence-gap bug)", () => {
    let s = createContinuousScanState();
    // Frame 1 and 2: not yet steady (count 1, 2). Must not start resolving, but the
    // engine's own gate clock must already reflect frame 2's timestamp.
    let step = continuousFrameScanned(s, "A", T0, { bounds: IN_BOX_BOUNDS, aimBox: IN_BOX });
    s = step.next;
    expect(step.startResolving).toBeNull();
    step = continuousFrameScanned(s, "A", T0 + 100, { bounds: IN_BOX_BOUNDS, aimBox: IN_BOX });
    s = step.next;
    expect(step.startResolving).toBeNull();
    expect(s.gate?.lastSeenAt).toBe(T0 + 100);
  });

  it("a not-yet-steady frame never starts the real accept cooldown early (lastAcceptAt untouched)", () => {
    // Regression pin for the composition bug a naive `gateScan`-on-every-frame would hit:
    // frame 1 would already read as "accept" (fresh code, no slot yet) and stamp
    // lastAcceptAt at frame 1 even though steady-read suppressed it — blocking the LATER
    // real accept behind a cooldown that never should have started.
    let s = createContinuousScanState();
    let step = continuousFrameScanned(s, "A", T0, { bounds: IN_BOX_BOUNDS, aimBox: IN_BOX });
    s = step.next;
    step = continuousFrameScanned(s, "A", T0 + 100, { bounds: IN_BOX_BOUNDS, aimBox: IN_BOX });
    s = step.next;
    step = continuousFrameScanned(s, "A", T0 + 200, { bounds: IN_BOX_BOUNDS, aimBox: IN_BOX }); // 3rd -> steady -> real accept
    s = step.next;
    expect(step.startResolving).toBe("A");
    expect(s.gate?.lastAcceptAt).toBe(T0 + 200);
  });

  it("an out-of-box frame is pure noise: no gate touch, no steady progress, no accept", () => {
    let s = createContinuousScanState();
    for (const t of [0, 100, 200, 300, 400]) {
      const step = continuousFrameScanned(s, "A", T0 + t, {
        bounds: OUT_OF_BOX_BOUNDS,
        aimBox: IN_BOX,
      });
      s = step.next;
      expect(step.startResolving).toBeNull();
    }
    expect(s.gate).toBeNull();
    expect(s.steady).toEqual([]);
  });

  it("omitting aimBox entirely disables aim-box filtering (ScanOrderSheet's no-viewfinder case)", () => {
    let s = createContinuousScanState();
    let accepts = 0;
    for (const t of [0, 100, 200]) {
      const step = continuousFrameScanned(s, "A", T0 + t, { bounds: OUT_OF_BOX_BOUNDS }); // no aimBox
      s = step.next;
      if (step.startResolving) accepts++;
    }
    expect(accepts).toBe(1);
  });

  it("a genuine re-present after the code actually leaves frame (absence gap clears) accepts again", () => {
    let s = createContinuousScanState();
    for (const t of [0, 100, 200]) {
      s = continuousFrameScanned(s, "A", T0 + t, { bounds: IN_BOX_BOUNDS, aimBox: IN_BOX }).next;
    }
    s = scanSettled(s).next; // the first accept resolves before the item is ever removed
    // Gone from frame entirely (no frames fed at all, matching a real absence — nothing
    // decodes a code that isn't in view) for well past ABSENCE_GAP_MS (300) and
    // SCAN_COOLDOWN_MS (600), then reappears. Ramp-up frames 350ms apart — within
    // steady-read's own gap tolerance, but each individually past ABSENCE_GAP_MS too, so
    // the re-present's own debounce frames never race the absence check.
    const reappearAt = T0 + 200 + 1000;
    s = continuousFrameScanned(s, "A", reappearAt, { bounds: IN_BOX_BOUNDS, aimBox: IN_BOX }).next;
    s = continuousFrameScanned(s, "A", reappearAt + 350, {
      bounds: IN_BOX_BOUNDS,
      aimBox: IN_BOX,
    }).next;
    const third = continuousFrameScanned(s, "A", reappearAt + 700, {
      bounds: IN_BOX_BOUNDS,
      aimBox: IN_BOX,
    });
    expect(third.startResolving).toBe("A");
  });
});
