import {
  ABSENCE_GAP_MS,
  gateScan,
  SCAN_COOLDOWN_MS,
  SCAN_SLOTS,
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
