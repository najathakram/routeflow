// SA-744r2 (row 80): the calendar-window helper, pure. Examples are the spec's pins; the properties run a
// seeded generator (deterministic - no fast-check dependency in this workspace).
import {
  addBoundaryMonths,
  alignPart,
  boundary,
  effectiveCycle,
  isAligned,
  isCalendarWindow,
  isContiguous,
  nextBillingWindow,
  nextBoundaryAfter,
  paidThrough,
  snapToBoundary,
  windowParts,
} from "./calendar-windows";

const D = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();
const DAY = 24 * 60 * 60 * 1000;

/** mulberry32: a tiny seeded PRNG. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("snap (inclusive 24 h around B(m) = the 1st at 12:00Z)", () => {
  it("a legacy 00:00Z end snaps to the 12:00Z boundary of the same day", () => {
    expect(iso(snapToBoundary(D("2026-11-01T00:00:00.000Z")))).toBe("2026-11-01T12:00:00.000Z");
  });

  it("exactly 24 h either side snaps; 24 h + 1 ms does not (inclusive pin)", () => {
    const b = boundary(2026, 10); // Nov 1 12:00Z
    expect(snapToBoundary(new Date(b.getTime() - DAY)).getTime()).toBe(b.getTime());
    expect(snapToBoundary(new Date(b.getTime() + DAY)).getTime()).toBe(b.getTime());
    const justOut = new Date(b.getTime() - DAY - 1);
    expect(snapToBoundary(justOut).getTime()).toBe(justOut.getTime());
    expect(isAligned(justOut)).toBe(false);
    expect(isAligned(new Date(b.getTime() + DAY + 1))).toBe(false);
  });

  it("a non-boundary instant is returned unchanged (a copy, never the same object)", () => {
    const d = D("2026-11-17T03:04:05.000Z");
    const s = snapToBoundary(d);
    expect(s.getTime()).toBe(d.getTime());
    expect(s).not.toBe(d);
  });

  it("snaps across a month and year edge (Dec 31 12:00Z -> Jan 1 12:00Z)", () => {
    expect(iso(snapToBoundary(D("2026-12-31T12:00:00.000Z")))).toBe("2027-01-01T12:00:00.000Z");
    expect(iso(snapToBoundary(D("2027-01-02T12:00:00.000Z")))).toBe("2027-01-01T12:00:00.000Z");
  });
});

describe("nextBillingWindow", () => {
  it("M1 master value: a 00:00Z Nov 1 end gives ONE window [Nov 1 12:00Z, Dec 1 12:00Z) (master: [Nov 1 00:00Z, Dec 2 00:00Z))", () => {
    const w = nextBillingWindow(D("2026-11-01T00:00:00.000Z"), "MONTHLY");
    expect([iso(w.periodStart), iso(w.periodEnd)]).toEqual([
      "2026-11-01T12:00:00.000Z",
      "2026-12-01T12:00:00.000Z",
    ]);
  });

  it("MONTHLY aligned: [B(m), B(m+1)); the year edge and Feb 2028 (29 days) are calendar months", () => {
    const dec = nextBillingWindow(D("2026-12-01T12:00:00.000Z"), "MONTHLY");
    expect(iso(dec.periodEnd)).toBe("2027-01-01T12:00:00.000Z");
    const feb = nextBillingWindow(D("2028-02-01T12:00:00.000Z"), "MONTHLY");
    expect((feb.periodEnd.getTime() - feb.periodStart.getTime()) / DAY).toBe(29);
  });

  it("unaligned MONTHLY: an alignment window to the next boundary, then full months", () => {
    const w = nextBillingWindow(D("2026-11-22T00:00:00.000Z"), "MONTHLY");
    expect([iso(w.periodStart), iso(w.periodEnd)]).toEqual([
      "2026-11-22T00:00:00.000Z",
      "2026-12-01T12:00:00.000Z",
    ]);
    const next = nextBillingWindow(w.periodEnd, "MONTHLY");
    expect([iso(next.periodStart), iso(next.periodEnd)]).toEqual([
      "2026-12-01T12:00:00.000Z",
      "2027-01-01T12:00:00.000Z",
    ]);
  });

  it("M3 row: an end of Nov 29 00:00Z (2.5 days to Dec 1 12:00Z) is MERGED: [Nov 29, Jan 1 12:00Z)", () => {
    const w = nextBillingWindow(D("2026-11-29T00:00:00.000Z"), "MONTHLY");
    expect([iso(w.periodStart), iso(w.periodEnd)]).toEqual([
      "2026-11-29T00:00:00.000Z",
      "2027-01-01T12:00:00.000Z",
    ]);
    expect(windowParts(w.periodStart, w.periodEnd, "MONTHLY")).toEqual([
      { kind: "ALIGN", daysRemaining: 2.5, daysInCycle: 30 },
      { kind: "FULL", months: 1 },
    ]);
  });

  it("exactly 3 days is NOT merged; 3 days minus 1 ms is", () => {
    const b = boundary(2026, 11); // Dec 1 12:00Z
    const three = nextBillingWindow(new Date(b.getTime() - 3 * DAY), "MONTHLY");
    expect(three.periodEnd.getTime()).toBe(b.getTime());
    const under = nextBillingWindow(new Date(b.getTime() - 3 * DAY + 1), "MONTHLY");
    expect(iso(under.periodEnd)).toBe("2027-01-01T12:00:00.000Z");
  });

  it("the 25-hour case merges into the December invoice (1.0417 / 30 days, never 2)", () => {
    const w = nextBillingWindow(D("2026-11-30T11:00:00.000Z"), "MONTHLY");
    expect(iso(w.periodEnd)).toBe("2027-01-01T12:00:00.000Z");
    const parts = windowParts(w.periodStart, w.periodEnd, "MONTHLY");
    expect(parts?.[0]).toMatchObject({ kind: "ALIGN", daysInCycle: 30 });
    expect((parts?.[0] as { daysRemaining: number }).daysRemaining).toBeCloseTo(25 / 24, 10);
    expect(parts?.[1]).toEqual({ kind: "FULL", months: 1 });
  });

  it("ANNUAL aligned: [B(m), B(m+12)); unaligned: the alignment is merged into the first year [s, B(m+12))", () => {
    const a = nextBillingWindow(D("2026-11-01T00:00:00.000Z"), "ANNUAL");
    expect([iso(a.periodStart), iso(a.periodEnd)]).toEqual([
      "2026-11-01T12:00:00.000Z",
      "2027-11-01T12:00:00.000Z",
    ]);
    // Pin a second roll on a non-1st fixture: the first roll merges, the second is a plain year.
    const first = nextBillingWindow(D("2026-10-08T00:00:00.000Z"), "ANNUAL");
    expect([iso(first.periodStart), iso(first.periodEnd)]).toEqual([
      "2026-10-08T00:00:00.000Z",
      "2027-11-01T12:00:00.000Z",
    ]);
    const second = nextBillingWindow(first.periodEnd, "ANNUAL");
    expect([iso(second.periodStart), iso(second.periodEnd)]).toEqual([
      "2027-11-01T12:00:00.000Z",
      "2028-11-01T12:00:00.000Z",
    ]);
    expect(windowParts(first.periodStart, first.periodEnd, "ANNUAL")?.map((p) => p.kind)).toEqual([
      "ALIGN",
      "FULL",
    ]);
  });
});

describe("effectiveCycle (M4 / B863)", () => {
  const start = D("2026-01-01T00:00:00.000Z");
  it("a 365-day MONTHLY-labelled window is ANNUAL; 364 days (>= 360) too", () => {
    expect(effectiveCycle("MONTHLY", start, new Date(start.getTime() + 365 * DAY))).toBe("ANNUAL");
    expect(effectiveCycle("MONTHLY", start, new Date(start.getTime() + 364 * DAY))).toBe("ANNUAL");
  });
  it("359 days stays on the label (super admin edits the period so it is under 360 d)", () => {
    expect(effectiveCycle("MONTHLY", start, new Date(start.getTime() + 359 * DAY))).toBe("MONTHLY");
    expect(effectiveCycle("ANNUAL", start, new Date(start.getTime() + 90 * DAY))).toBe("ANNUAL");
  });
  it("no period: the label", () => {
    expect(effectiveCycle("ANNUAL", null, null)).toBe("ANNUAL");
    expect(effectiveCycle("MONTHLY", null, null)).toBe("MONTHLY");
  });
});

describe("alignPart / windowParts", () => {
  it("[Nov 22 00:00Z, Dec 1 12:00Z) is 9.5 / 30 exactly; Feb 2028 uses 29", () => {
    expect(alignPart(D("2026-11-22T00:00:00.000Z"), boundary(2026, 11))).toEqual({
      kind: "ALIGN",
      daysRemaining: 9.5,
      daysInCycle: 30,
    });
    expect(alignPart(D("2028-02-20T12:00:00.000Z"), boundary(2028, 2))).toMatchObject({
      daysRemaining: 10,
      daysInCycle: 29,
    });
  });

  it("M2 pin: [Dec 4 00:00Z, Jan 1 12:00Z) is 28.5 / 31", () => {
    expect(
      windowParts(D("2026-12-04T00:00:00.000Z"), D("2027-01-01T12:00:00.000Z"), "MONTHLY"),
    ).toEqual([{ kind: "ALIGN", daysRemaining: 28.5, daysInCycle: 31 }]);
  });

  it("shapes the helper never produces are null (defensive IRREGULAR path)", () => {
    // both ends unaligned, a 45-day window, an unaligned end, a reversed window
    expect(
      windowParts(D("2026-10-12T00:00:00.000Z"), D("2026-11-26T00:00:00.000Z"), "MONTHLY"),
    ).toBeNull();
    expect(
      windowParts(D("2026-10-01T12:00:00.000Z"), D("2026-11-26T00:00:00.000Z"), "MONTHLY"),
    ).toBeNull();
    expect(
      windowParts(D("2026-12-01T12:00:00.000Z"), D("2026-11-01T12:00:00.000Z"), "MONTHLY"),
    ).toBeNull();
    // a 2-month start-aligned window is regular MONTHLY months; an ANNUAL one must be 12
    expect(
      windowParts(D("2026-10-01T12:00:00.000Z"), D("2026-12-01T12:00:00.000Z"), "MONTHLY"),
    ).toEqual([{ kind: "FULL", months: 2 }]);
    expect(
      windowParts(D("2026-10-01T12:00:00.000Z"), D("2026-12-01T12:00:00.000Z"), "ANNUAL"),
    ).toBeNull();
  });

  it("legacy 00:00Z aligned windows are whole months (Oct 1 00:00Z -> Nov 1 00:00Z is 1 month)", () => {
    expect(
      windowParts(D("2026-10-01T00:00:00.000Z"), D("2026-11-01T00:00:00.000Z"), "MONTHLY"),
    ).toEqual([{ kind: "FULL", months: 1 }]);
    expect(
      isCalendarWindow(D("2026-10-01T00:00:00.000Z"), D("2026-11-01T00:00:00.000Z"), "MONTHLY"),
    ).toBe(true);
  });
});

describe("properties (seeded, 2000 random ends x both cycles)", () => {
  const rand = rng(744);
  const ends: Date[] = [];
  const base = D("2026-01-01T00:00:00.000Z").getTime();
  for (let i = 0; i < 2000; i++) ends.push(new Date(base + Math.floor(rand() * 4 * 365 * DAY)));
  // pin the edges around a boundary too
  for (const off of [-25, -24, -12, 0, 12, 24, 25]) {
    ends.push(new Date(boundary(2027, 5).getTime() + off * 3600 * 1000));
  }

  it.each(["MONTHLY", "ANNUAL"] as const)(
    "%s: start = snap(end); window is positive, ends aligned, parses into parts",
    (cycle) => {
      for (const end of ends) {
        const w = nextBillingWindow(end, cycle);
        expect(w.periodStart.getTime()).toBe(snapToBoundary(end).getTime());
        expect(w.periodEnd.getTime()).toBeGreaterThan(w.periodStart.getTime());
        expect(isAligned(w.periodEnd)).toBe(true);
        const parts = windowParts(w.periodStart, w.periodEnd, cycle);
        expect(parts).not.toBeNull();
        const aligned = isAligned(end);
        expect(parts?.[0].kind).toBe(aligned ? "FULL" : "ALIGN");
        // The parts tile the window EXACTLY: the alignment stretch, then whole calendar months, end on `end`.
        const head = parts?.[0];
        const b1 =
          head?.kind === "ALIGN"
            ? new Date(w.periodStart.getTime() + head.daysRemaining * DAY)
            : w.periodStart;
        const fullMonths = parts?.find((x) => x.kind === "FULL")?.months ?? 0;
        const expectedEnd = addBoundaryMonths(b1, fullMonths * (cycle === "ANNUAL" ? 12 : 1));
        expect(expectedEnd.getTime()).toBe(w.periodEnd.getTime());
      }
    },
  );

  it.each(["MONTHLY", "ANNUAL"] as const)(
    "%s: chained windows are contiguous - no gap, no overlap, no free days",
    (cycle) => {
      for (const end of ends.slice(0, 300)) {
        let cur = nextBillingWindow(end, cycle);
        for (let i = 0; i < 6; i++) {
          const next = nextBillingWindow(cur.periodEnd, cycle);
          expect(next.periodStart.getTime()).toBe(cur.periodEnd.getTime());
          expect(isContiguous(cur.periodEnd, next.periodStart)).toBe(true);
          cur = next;
        }
      }
    },
  );

  it("MONTHLY: the full months in a window are calendar months of 28..31 days", () => {
    for (const end of ends.slice(0, 500)) {
      const w = nextBillingWindow(end, "MONTHLY");
      const parts = windowParts(w.periodStart, w.periodEnd, "MONTHLY") ?? [];
      const full = parts.find((p) => p.kind === "FULL");
      const len = (w.periodEnd.getTime() - w.periodStart.getTime()) / DAY;
      const alignDays = parts.find((p) => p.kind === "ALIGN");
      if (alignDays?.kind === "ALIGN" && !full) expect(len).toBeLessThan(31 + 1e-9);
      if (alignDays?.kind === "ALIGN" && !full)
        expect(alignDays.daysRemaining).toBeGreaterThanOrEqual(3 - 1e-9);
      if (alignDays?.kind === "ALIGN" && full) expect(alignDays.daysRemaining).toBeLessThan(3);
      if (!alignDays && full?.kind === "FULL") expect(len).toBeGreaterThanOrEqual(28);
    }
  });

  it("addBoundaryMonths and nextBoundaryAfter agree on the month arithmetic", () => {
    for (let m = 0; m < 48; m++) {
      const b = boundary(2026, m);
      expect(nextBoundaryAfter(new Date(b.getTime() - 1)).getTime()).toBe(b.getTime());
      expect(nextBoundaryAfter(b).getTime()).toBe(addBoundaryMonths(b, 1).getTime());
    }
  });
});

describe("paidThrough / isContiguous (SA-733r4 r4a)", () => {
  const p = (a: string, b: string) => ({ periodStart: D(a), periodEnd: D(b) });

  it("contiguous = next start within the inclusive 24 h snap of the previous end", () => {
    expect(isContiguous(D("2026-11-01T00:00:00.000Z"), D("2026-11-01T12:00:00.000Z"))).toBe(true);
    expect(isContiguous(D("2026-11-01T00:00:00.000Z"), D("2026-11-03T00:00:00.000Z"))).toBe(false);
    expect(isContiguous(D("2026-11-04T00:00:00.000Z"), D("2026-11-04T00:00:00.000Z"))).toBe(true);
  });

  it("legacy 00:00Z periods chain across the snap: paid-through = snap(last end)", () => {
    const paid = [
      p("2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"),
      p("2026-11-01T12:00:00.000Z", "2026-12-01T12:00:00.000Z"),
    ];
    expect(iso(paidThrough(paid, D("2026-10-01T00:00:00.000Z")) as Date)).toBe(
      "2026-12-01T12:00:00.000Z",
    );
  });

  it("a gap stops the run; the legacy end snaps", () => {
    const paid = [
      p("2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"),
      p("2026-12-01T12:00:00.000Z", "2027-01-01T12:00:00.000Z"),
    ];
    expect(iso(paidThrough(paid, D("2026-10-01T00:00:00.000Z")) as Date)).toBe(
      "2026-11-01T12:00:00.000Z",
    );
  });

  it("no periods: null without a reference, snap(from) with one", () => {
    expect(paidThrough([])).toBeNull();
    expect(iso(paidThrough([], D("2026-11-01T00:00:00.000Z")) as Date)).toBe(
      "2026-11-01T12:00:00.000Z",
    );
  });
});
