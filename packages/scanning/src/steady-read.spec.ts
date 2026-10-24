import {
  clearAfterAbsence,
  createSteadyReadState,
  STEADY_READ_MAX_GAP_MS,
  STEADY_READ_MIN_FRAMES,
  STEADY_READ_SLOTS,
  trackSteadyRead,
} from "./steady-read";

describe("trackSteadyRead", () => {
  it("is not steady on the first frame", () => {
    const r = trackSteadyRead(createSteadyReadState(), "A", 0);
    expect(r.steady).toBe(false);
    expect(r.next).toEqual([{ code: "A", lastSeenAt: 0, count: 1 }]);
  });

  it(`becomes steady on the ${STEADY_READ_MIN_FRAMES}th consecutive frame of the same code`, () => {
    let s = createSteadyReadState();
    let steadyAt = -1;
    for (let i = 0; i < STEADY_READ_MIN_FRAMES; i++) {
      const r = trackSteadyRead(s, "A", i * 10);
      s = r.next;
      if (r.steady && steadyAt === -1) steadyAt = i;
    }
    expect(steadyAt).toBe(STEADY_READ_MIN_FRAMES - 1);
  });

  // #2131 review round 1, point 1: a fixed window measured from the streak's FIRST frame
  // reset a continuously held code every ~300ms, because the window's own ceiling elapsed
  // long before the hold ended. There must be NO such ceiling — only a per-gap tolerance.
  it("stays steady indefinitely for a continuously held code, however long past the old fixed window", () => {
    let s = createSteadyReadState();
    for (let i = 0; i < STEADY_READ_MIN_FRAMES; i++) s = trackSteadyRead(s, "A", i * 100).next;
    // 50 more frames at 100ms apart (5s total) — well past the retired 300ms window.
    for (let i = STEADY_READ_MIN_FRAMES; i < 50; i++) {
      const r = trackSteadyRead(s, "A", i * 100);
      expect(r.steady).toBe(true);
      s = r.next;
    }
  });

  it("a different code gets its OWN streak, starting at count 1 and not steady", () => {
    let s = trackSteadyRead(createSteadyReadState(), "A", 0).next;
    s = trackSteadyRead(s, "A", 10).next;
    const switched = trackSteadyRead(s, "B", 20);
    expect(switched.steady).toBe(false);
    expect(switched.next[0]).toEqual({ code: "B", lastSeenAt: 20, count: 1 });
  });

  // #2131 review round 1, point 4: expo-camera reports every code it decodes in a frame,
  // so two codes genuinely present at once (an ITF-14 case code and an EAN-13 item code on
  // one carton) interleave in the event stream. A single shared streak would see each
  // OTHER code's frame as "a different code" and reset — neither could ever reach
  // threshold. Per-code slots (mirroring scan-loop's own multi-slot gate) fix this.
  it("two interleaved codes accumulate independent streaks and both eventually go steady", () => {
    let s = createSteadyReadState();
    const order: Array<{ code: string; steady: boolean }> = [];
    // A,B,A,B,A,B — each code's own consecutive gap is 200ms, well within tolerance.
    const frames: Array<[string, number]> = [
      ["A", 0],
      ["B", 100],
      ["A", 200],
      ["B", 300],
      ["A", 400],
      ["B", 500],
    ];
    for (const [code, t] of frames) {
      const r = trackSteadyRead(s, code, t);
      s = r.next;
      order.push({ code, steady: r.steady });
    }
    expect(order).toEqual([
      { code: "A", steady: false },
      { code: "B", steady: false },
      { code: "A", steady: false },
      { code: "B", steady: false },
      { code: "A", steady: true }, // A's 3rd frame
      { code: "B", steady: true }, // B's 3rd frame
    ]);
  });

  it(`keeps at most ${STEADY_READ_SLOTS} codes' streaks, dropping the LRU one`, () => {
    let s = createSteadyReadState();
    for (let i = 0; i < STEADY_READ_SLOTS + 1; i++) {
      s = trackSteadyRead(s, `code-${i}`, i).next;
    }
    expect(s).toHaveLength(STEADY_READ_SLOTS);
    expect(s.some((slot) => slot.code === "code-0")).toBe(false);
    expect(s[0].code).toBe(`code-${STEADY_READ_SLOTS}`);
  });

  // #2131 review round 1, point 2: iOS decodes Code 39 via ZXing at ≤6fps, and CameraView
  // itself throttles repeated identical-code events to ~1 per 500ms — three reads of one
  // Code 39 label are then AT LEAST ~1000ms apart. The old 300ms fixed window could never
  // fit that; the gap tolerance must clear a single ~500ms gap.
  it("tolerates identical events ~500ms apart (CameraView's own throttle) and still goes steady", () => {
    let s = createSteadyReadState();
    let r = trackSteadyRead(s, "CODE39LABEL", 0);
    s = r.next;
    expect(r.steady).toBe(false);
    r = trackSteadyRead(s, "CODE39LABEL", 500);
    s = r.next;
    expect(r.steady).toBe(false);
    r = trackSteadyRead(s, "CODE39LABEL", 1000);
    expect(r.steady).toBe(true);
  });

  it(`a gap past ${STEADY_READ_MAX_GAP_MS}ms since the PREVIOUS frame resets the streak`, () => {
    let s = trackSteadyRead(createSteadyReadState(), "A", 0).next;
    const late = trackSteadyRead(s, "A", STEADY_READ_MAX_GAP_MS + 1);
    expect(late.next[0]).toEqual({ code: "A", lastSeenAt: STEADY_READ_MAX_GAP_MS + 1, count: 1 });
  });

  it(`a frame exactly at the ${STEADY_READ_MAX_GAP_MS}ms boundary still continues the streak (inclusive)`, () => {
    let s = trackSteadyRead(createSteadyReadState(), "A", 0).next;
    const atBoundary = trackSteadyRead(s, "A", STEADY_READ_MAX_GAP_MS);
    expect(atBoundary.next[0].count).toBe(2);
  });

  it("a gap that resets the streak still measures from THIS frame, not the original one, on the next read", () => {
    let s = trackSteadyRead(createSteadyReadState(), "A", 0).next;
    s = trackSteadyRead(s, "A", STEADY_READ_MAX_GAP_MS + 1).next; // reset to count 1 @ t
    const r = trackSteadyRead(s, "A", STEADY_READ_MAX_GAP_MS + 1 + 100); // 100ms later — continues
    expect(r.next[0].count).toBe(2);
  });
});

describe("afterAbsence mark (#2131 @1f8b1ea4 review)", () => {
  it("is set only when the frame restarts the streak, and carried while it continues", () => {
    let r = trackSteadyRead(createSteadyReadState(), "A", 0, true);
    expect(r.afterAbsence).toBe(true);
    r = trackSteadyRead(r.next, "A", 100, false); // continuing: the flag argument is ignored
    expect(r.afterAbsence).toBe(true);
    r = trackSteadyRead(r.next, "A", 100 + STEADY_READ_MAX_GAP_MS + 1, false); // restart, not absent
    expect(r.afterAbsence).toBe(false);
  });

  it("clearAfterAbsence drops the mark for that code only, keeping its streak", () => {
    let s = trackSteadyRead(createSteadyReadState(), "A", 0, true).next;
    s = trackSteadyRead(s, "B", 10, true).next;
    s = clearAfterAbsence(s, "A");
    const a = trackSteadyRead(s, "A", 100);
    expect(a.afterAbsence).toBe(false);
    expect(a.next[0].count).toBe(2);
    expect(trackSteadyRead(s, "B", 110).afterAbsence).toBe(true);
  });
});

describe("clearAfterAbsence across gate candidates (SA-384a LOW)", () => {
  // Stand-in for mobile's normalizeScanCode: a UPC-A and its 0-prefixed EAN-13 are one item.
  const stripZeros = (code: string) => [code.replace(/^0+/, "")];

  it("an accept via the UPC-A form clears the EAN-13 slot's mark too", () => {
    let s = trackSteadyRead(createSteadyReadState(), "0036000291452", 0, true).next; // EAN-13
    s = trackSteadyRead(s, "036000291452", 10, true).next; // UPC-A
    s = clearAfterAbsence(s, "036000291452", stripZeros);
    expect(trackSteadyRead(s, "0036000291452", 100).afterAbsence).toBe(false);
    expect(trackSteadyRead(s, "036000291452", 100).afterAbsence).toBe(false);
  });

  it("leaves a genuinely different code's mark alone", () => {
    let s = trackSteadyRead(createSteadyReadState(), "036000291452", 0, true).next;
    s = trackSteadyRead(s, "4006381333931", 10, true).next;
    s = clearAfterAbsence(s, "036000291452", stripZeros);
    expect(trackSteadyRead(s, "4006381333931", 100).afterAbsence).toBe(true);
  });
});
