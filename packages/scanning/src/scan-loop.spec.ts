import {
  ABSENCE_GAP_MS,
  gateScan,
  isAbsentFromGate,
  isTrackedByGate,
  NEVER_ACCEPTED,
  SCAN_COOLDOWN_MS,
  SCAN_SLOTS,
  touchSeen,
  type ScanCandidates,
  type ScanGateState,
} from "./scan-loop";

// A stand-in for mobile's normalizeScanCode: two decodes that differ only by leading zeros are the
// same physical item (the real UPC-A/EAN-13 case). The real normalizer stays in apps/mobile;
// mobile's own __tests__/scan-loop.test.ts pins the wrapper that injects it.
const stripZeros: ScanCandidates = (code) => [code.replace(/^0+/, "")];

const T0 = 1_000_000;
const REPRESENT = SCAN_COOLDOWN_MS + ABSENCE_GAP_MS; // long enough to clear both clocks

function run(codes: Array<[string, number]>, candidatesOf?: ScanCandidates) {
  let state: ScanGateState | null = null;
  return codes.map(([code, at]) => {
    const r = gateScan(code, state, at, undefined, candidatesOf);
    state = r.state;
    return r.accept;
  });
}

describe("gateScan — default matcher is raw string equality", () => {
  it("accepts a new code immediately, rejects the same string inside the cooldown", () => {
    expect(
      run([
        ["A", T0],
        ["A", T0 + 33],
        ["A", T0 + 66],
      ]),
    ).toEqual([true, false, false]);
  });

  it("does NOT normalise: '0123' and '123' are two different items by default", () => {
    expect(
      run([
        ["0123", T0],
        ["123", T0 + 10],
      ]),
    ).toEqual([true, true]);
  });

  it("frame-spam protection: a code still in view never re-triggers just because the cooldown elapsed", () => {
    // Seen every 100ms for 2s — the cooldown (600) elapses but the absence gap (300) never does.
    const frames: Array<[string, number]> = Array.from({ length: 20 }, (_, i) => [
      "A",
      T0 + i * 100,
    ]);
    expect(run(frames).filter(Boolean)).toHaveLength(1);
  });

  it("a deliberate re-present (out of frame for the absence gap AND past the cooldown) is accepted again", () => {
    expect(
      run([
        ["A", T0],
        ["A", T0 + REPRESENT + 1],
      ]),
    ).toEqual([true, true]);
  });

  it("a rejected repeat never extends the suppression window (lastAcceptAt moves only on accept)", () => {
    expect(
      run([
        ["A", T0],
        ["A", T0 + 500],
        ["A", T0 + 500 + REPRESENT],
      ]),
    ).toEqual([true, false, true]);
  });

  it("alternating A,B,A,B inside the cooldown counts each item once (per-code clocks, not one slot)", () => {
    const seq: Array<[string, number]> = ["A", "B", "A", "B", "A", "B"].map((c, i) => [
      c,
      T0 + i * 40,
    ]);
    expect(run(seq)).toEqual([true, true, false, false, false, false]);
  });

  it(`remembers at most ${SCAN_SLOTS} codes, so the 5th distinct code evicts the oldest`, () => {
    const distinct: Array<[string, number]> = ["A", "B", "C", "D", "E"].map((c, i) => [
      c,
      T0 + i * 10,
    ]);
    // A was evicted by E, so a quick repeat of A is treated as a NEW item.
    expect(run([...distinct, ["A", T0 + 60]])).toEqual([true, true, true, true, true, true]);
  });

  it(`keeps at least ${SCAN_SLOTS} codes tracked at once (spec R1's floor): none of four alternating items re-adds`, () => {
    const four = ["A", "B", "C", "D"];
    const first: Array<[string, number]> = four.map((c, i) => [c, T0 + i * 10]);
    const repeats: Array<[string, number]> = four.map((c, i) => [c, T0 + 100 + i * 10]);
    expect(run([...first, ...repeats])).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("cooldown alone (absence gap already clear) still rejects a repeat, and clears at SCAN_COOLDOWN_MS", () => {
    // 400ms apart: out of frame long enough (>= ABSENCE_GAP_MS 300) but inside the 600ms cooldown.
    expect(
      run([
        ["A", T0],
        ["A", T0 + 400],
        ["A", T0 + 400 + SCAN_COOLDOWN_MS],
      ]),
    ).toEqual([true, false, true]);
  });

  it("ignores a blank decode without disturbing state", () => {
    const first = gateScan("A", null, T0);
    const blank = gateScan("   ", first.state, T0 + 5);
    expect(blank.accept).toBe(false);
    expect(blank.state).toBe(first.state);
  });
});

describe("gateScan — injected candidate matcher", () => {
  it("treats two decodes with intersecting candidate sets as ONE item (symbology flicker)", () => {
    expect(
      run(
        [
          ["0123", T0],
          ["123", T0 + 33],
          ["0123", T0 + 66],
        ],
        stripZeros,
      ),
    ).toEqual([true, false, false]);
  });

  it("still lets a genuinely different item through", () => {
    expect(
      run(
        [
          ["0123", T0],
          ["0456", T0 + 33],
        ],
        stripZeros,
      ),
    ).toEqual([true, true]);
  });
});

// #2131 review round 1: touchSeen lets a caller ahead of the gate (continuousFrameScanned's
// steady-read filter) keep lastSeenAt fresh for a code it hasn't decided to accept yet,
// without starting a phantom cooldown/absence window.
describe("touchSeen", () => {
  it("a first-ever touch creates a slot stamped NEVER_ACCEPTED, not a real timestamp", () => {
    const state = touchSeen(null, "A", T0);
    expect(state.slots?.[0]).toEqual({ code: "A", lastAcceptAt: NEVER_ACCEPTED, lastSeenAt: T0 });
  });

  it("gateScan treats a NEVER_ACCEPTED slot exactly like no slot — accepts immediately", () => {
    let state: ScanGateState | null = touchSeen(null, "A", T0);
    state = touchSeen(state, "A", T0 + 100); // a second touch, still never accepted
    // Immediately after, with NO cooldown/absence elapsed — a real slot would reject this.
    const { accept } = gateScan("A", state, T0 + 100);
    expect(accept).toBe(true);
  });

  it("a touch after a REAL accept preserves the real lastAcceptAt untouched", () => {
    const accepted = gateScan("A", null, T0);
    expect(accepted.accept).toBe(true);
    const touched = touchSeen(accepted.state, "A", T0 + 50);
    expect(touched.slots?.[0]?.lastAcceptAt).toBe(T0); // unchanged — only lastSeenAt moved
    expect(touched.slots?.[0]?.lastSeenAt).toBe(T0 + 50);
  });

  it("a touch keeps the code's real cooldown/absence enforced once it HAS been accepted for real", () => {
    const accepted = gateScan("A", null, T0);
    const touched = touchSeen(accepted.state, "A", T0 + 50);
    // Still well inside both the cooldown and the absence gap from the real accept.
    const { accept } = gateScan("A", touched, T0 + 60);
    expect(accept).toBe(false);
  });
});

describe("absence observed by the caller (#2131 @1f8b1ea4 review)", () => {
  const T = 5_000;
  const accepted = gateScan("A", null, T).state;

  it("isAbsentFromGate: never-seen and stale codes are absent, a fresh one is not", () => {
    expect(isAbsentFromGate(null, "A", T)).toBe(true);
    expect(isAbsentFromGate(accepted, "A", T + ABSENCE_GAP_MS - 1)).toBe(false);
    expect(isAbsentFromGate(accepted, "A", T + ABSENCE_GAP_MS)).toBe(true);
    expect(isAbsentFromGate(accepted, "B", T)).toBe(true);
  });

  it("isTrackedByGate matches a slot the same way gateScan does", () => {
    expect(isTrackedByGate(null, "A")).toBe(false);
    expect(isTrackedByGate(accepted, "A")).toBe(true);
    expect(isTrackedByGate(accepted, "B")).toBe(false);
  });

  it("absenceObserved skips the absence check but never the cooldown", () => {
    const fresh = touchSeen(accepted, "A", T + SCAN_COOLDOWN_MS); // seen just now
    expect(gateScan("A", fresh, T + SCAN_COOLDOWN_MS + 10).accept).toBe(false);
    expect(gateScan("A", fresh, T + SCAN_COOLDOWN_MS + 10, undefined, undefined, true).accept).toBe(
      true,
    );
    const early = touchSeen(accepted, "A", T + 100);
    expect(gateScan("A", early, T + 110, undefined, undefined, true).accept).toBe(false);
  });
});
