import {
  createSteadyReadState,
  STEADY_READ_MIN_FRAMES,
  STEADY_READ_WINDOW_MS,
  trackSteadyRead,
} from "./steady-read";

describe("trackSteadyRead", () => {
  it("is not steady on the first frame", () => {
    const r = trackSteadyRead(createSteadyReadState(), "A", 0);
    expect(r.steady).toBe(false);
    expect(r.next).toEqual({ code: "A", firstSeenAt: 0, count: 1 });
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

  it("stays steady for every further frame of the same held code, not just the threshold frame", () => {
    let s = createSteadyReadState();
    for (let i = 0; i < STEADY_READ_MIN_FRAMES; i++) s = trackSteadyRead(s, "A", i * 10).next;
    const oneMore = trackSteadyRead(s, "A", STEADY_READ_MIN_FRAMES * 10);
    expect(oneMore.steady).toBe(true);
    const another = trackSteadyRead(oneMore.next, "A", (STEADY_READ_MIN_FRAMES + 1) * 10);
    expect(another.steady).toBe(true);
  });

  it("a different code resets the streak to count 1, never steady on that frame", () => {
    let s = trackSteadyRead(createSteadyReadState(), "A", 0).next;
    s = trackSteadyRead(s, "A", 10).next;
    const switched = trackSteadyRead(s, "B", 20);
    expect(switched.steady).toBe(false);
    expect(switched.next).toEqual({ code: "B", firstSeenAt: 20, count: 1 });
  });

  it(`a gap past ${STEADY_READ_WINDOW_MS}ms since the streak's OWN first frame resets it, even for the same code`, () => {
    let s = trackSteadyRead(createSteadyReadState(), "A", 0).next; // firstSeenAt = 0
    const late = trackSteadyRead(s, "A", STEADY_READ_WINDOW_MS + 1);
    expect(late.next).toEqual({ code: "A", firstSeenAt: STEADY_READ_WINDOW_MS + 1, count: 1 });
  });

  it(`a frame exactly at the ${STEADY_READ_WINDOW_MS}ms boundary still continues the streak (inclusive)`, () => {
    let s = trackSteadyRead(createSteadyReadState(), "A", 0).next;
    const atBoundary = trackSteadyRead(s, "A", STEADY_READ_WINDOW_MS);
    expect(atBoundary.next.count).toBe(2);
    expect(atBoundary.next.firstSeenAt).toBe(0);
  });

  it("the window is anchored to the streak's FIRST frame, not extended by each new one — a streak read just under the limit every frame cannot run forever", () => {
    let s = createSteadyReadState();
    // Frame 0 at t=0 starts the streak. Each further frame arrives just under the window
    // relative to the FIRST frame, not the previous one — by frame 4 (t=280), still within
    // 300ms of t=0, so it must still count as the same streak (already steady by then).
    const times = [0, 90, 180, 270];
    for (const t of times) s = trackSteadyRead(s, "A", t).next;
    expect(s.count).toBe(times.length);
    expect(s.firstSeenAt).toBe(0);
    // Now a frame past the window measured from the ORIGINAL first frame — must reset,
    // even though it's only 30ms after the previous frame.
    const reset = trackSteadyRead(s, "A", 301);
    expect(reset.next).toEqual({ code: "A", firstSeenAt: 301, count: 1 });
  });

  it("realistic ~30fps hold clears steady well under the window", () => {
    let s = createSteadyReadState();
    let result = trackSteadyRead(s, "A", 0);
    s = result.next;
    result = trackSteadyRead(s, "A", 33);
    s = result.next;
    result = trackSteadyRead(s, "A", 66);
    expect(result.steady).toBe(true);
    expect(66).toBeLessThan(STEADY_READ_WINDOW_MS);
  });
});
