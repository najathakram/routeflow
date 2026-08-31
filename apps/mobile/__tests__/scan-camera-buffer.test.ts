/**
 * F30 / R2 / REG-B192 — ScanCamera's busyRef is a plain drop-not-queue mutex:
 * `handleBarcodeScanned` early-returns with zero feedback while the previous
 * scan's server resolve is awaited (ScanCamera.tsx:81-98), and a real
 * catalog's local fast path misses often enough that this holds for a full
 * lookup round trip. Every scan that arrives during that window is lost
 * silently — no haptic, no pill, nothing recoverable.
 *
 * The fix extracts that mutex into `lib/scan-pending-buffer.ts`: a bounded
 * (depth 2) pending queue behind whichever code is currently resolving —
 * dedupe stays with `scan-loop.ts`'s gate, which is the only thing that can
 * tell frame spam from a deliberate re-present, and everything it accepts is
 * kept — so ScanCamera can buffer arrivals instead of dropping them and
 * ScanOrderSheet can render an `isResolving` state. That module doesn't
 * exist yet beyond a signature-only stub (every export returns `undefined`),
 * so every assertion below compares a whole returned value via `toEqual` —
 * never a property read off the stub's result — so the suite fails on a
 * clean assertion mismatch, not a crash.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  completeResolve,
  createPendingBuffer,
  pushScan,
  type PendingBufferState,
} from "../lib/scan-pending-buffer";

describe("scan-pending-buffer (REG-B192)", () => {
  it("REG-B192: starts resolving immediately when nothing is in flight", () => {
    const idle = createPendingBuffer();
    const result = pushScan(idle, "AAA");
    expect(result).toEqual({
      startResolving: "AAA",
      next: { isResolving: true, current: "AAA", pending: [] },
    });
  });

  it("REG-B192: buffers (never drops) scans that arrive while a resolve is in flight", () => {
    // AAA is already resolving. Two MORE distinct codes are detected before
    // it finishes — today's busyRef guard drops both with no trace.
    const resolvingAAA: PendingBufferState = { isResolving: true, current: "AAA", pending: [] };
    const afterB = pushScan(resolvingAAA, "BBB");
    expect(afterB).toEqual({
      startResolving: null, // buffered, not started — AAA is still busy
      next: { isResolving: true, current: "AAA", pending: ["BBB"] },
    });

    const withB: PendingBufferState = { isResolving: true, current: "AAA", pending: ["BBB"] };
    const afterC = pushScan(withB, "CCC");
    expect(afterC).toEqual({
      startResolving: null,
      // Depth 2: both BBB and CCC fit behind the one in-flight resolve —
      // none of the 3 distinct codes need to be discarded to honor the cap.
      next: { isResolving: true, current: "AAA", pending: ["BBB", "CCC"] },
    });
  });

  it("REG-B192: buffers a deliberate re-scan of the code currently resolving", () => {
    // The operator scans the same item twice to add a second unit while the
    // first lookup is still in flight. The gate ahead only lets a repeat
    // through once BOTH its clocks cleared (600ms since the last accept AND
    // 300ms out of frame), so this detection is already known to be a second
    // presentation, not frame spam. Deduping it away here is B192 all over
    // again: the cart lands at qty 1 while the operator counted 2.
    const resolvingAAA: PendingBufferState = { isResolving: true, current: "AAA", pending: [] };
    const afterRepeat = pushScan(resolvingAAA, "AAA");
    expect(afterRepeat).toEqual({
      startResolving: null,
      next: { isResolving: true, current: "AAA", pending: ["AAA"] },
    });

    // ...and it resolves on its own turn, so both units are counted.
    expect(completeResolve(afterRepeat.next)).toEqual({
      startResolving: "AAA",
      next: { isResolving: true, current: "AAA", pending: [] },
    });
  });

  it("REG-B192: holds the depth-2 cap once three scans are already in flight", () => {
    const withBC: PendingBufferState = {
      isResolving: true,
      current: "AAA",
      pending: ["BBB", "CCC"],
    };
    const afterFourth = pushScan(withBC, "BBB");
    expect(afterFourth).toEqual({
      startResolving: null,
      next: { isResolving: true, current: "AAA", pending: ["BBB", "CCC"] },
    });
  });

  it("REG-B192: drains the buffer in FIFO order as each resolve completes, then clears isResolving", () => {
    const withBC: PendingBufferState = {
      isResolving: true,
      current: "AAA",
      pending: ["BBB", "CCC"],
    };
    // AAA's resolve finishes: BBB — the oldest queued code — is pulled next.
    const afterAAAdone = completeResolve(withBC);
    expect(afterAAAdone).toEqual({
      startResolving: "BBB",
      next: { isResolving: true, current: "BBB", pending: ["CCC"] },
    });

    const resolvingBBB: PendingBufferState = {
      isResolving: true,
      current: "BBB",
      pending: ["CCC"],
    };
    const afterBBBdone = completeResolve(resolvingBBB);
    expect(afterBBBdone).toEqual({
      startResolving: "CCC",
      next: { isResolving: true, current: "CCC", pending: [] },
    });

    // CCC completes with nothing left queued — the indicator drops and all
    // three of the original distinct codes ended up resolved, in order, with
    // none silently discarded.
    const resolvingCCC: PendingBufferState = {
      isResolving: true,
      current: "CCC",
      pending: [],
    };
    const afterCCCdone = completeResolve(resolvingCCC);
    expect(afterCCCdone).toEqual({
      startResolving: null,
      next: { isResolving: false, current: null, pending: [] },
    });
  });
});

/**
 * WIRING — without this, every assertion above is satisfiable by filling in
 * lib/scan-pending-buffer.ts while `ScanCamera.tsx` keeps its drop-not-queue
 * `busyRef` and the user-visible bug (B192: scans arriving mid-resolve vanish
 * silently) survives untouched. Mobile tests are pure-logic only — no RN tree —
 * so the delegation is pinned at the source level, the same technique
 * barcode-normalize.test.ts already uses to keep its two copies in step.
 */
describe("ScanCamera delegates to the pending buffer (REG-B192 wiring)", () => {
  const scanCameraSrc = readFileSync(join(__dirname, "..", "components", "ScanCamera.tsx"), "utf8");

  it("REG-B192: ScanCamera imports the pending buffer instead of owning the mutex", () => {
    expect(scanCameraSrc).toMatch(/from\s+["']\.\.\/lib\/scan-pending-buffer["']/);
  });

  it("REG-B192: the drop-not-queue busyRef early-return is gone from handleBarcodeScanned", () => {
    // ScanCamera.tsx:81 today — `if (busyRef.current) return;` — is the exact
    // line that discards a scan arriving during a lookup, with no haptic, no
    // pill and nothing recoverable. A buffer that is never reached from here
    // fixes nothing.
    expect(scanCameraSrc).not.toMatch(/if\s*\(\s*busyRef\.current\s*\)\s*return\s*;/);
  });
});
