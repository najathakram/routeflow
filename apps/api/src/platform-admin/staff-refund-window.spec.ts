import {
  REFUND_WINDOW_MS,
  checkRefundDate,
  refundDeadline,
  type RefundDateVerdict,
} from "./staff-refund-window";

/**
 * R-2 (SA-1297 ruling 1, tests 1-5): the 14-day clock is judged on the ENTERED refundDate, in UTC instants.
 *   deadline = paidAt + 14 x 24h;  dayStart = Date.UTC(Y, M-1, D);  dayEnd = dayStart + 24h - 1ms
 *   not before the payment: dayEnd >= paidAt;  not in the future: dayStart <= now;
 *   within the window: dayStart <= deadline (inclusive, exactly at 14 x 24h). There is no recording deadline.
 * L-353: the clock is pinned and every date derives from NOW or from the stated instants.
 */
const NOW = new Date("2026-11-20T12:00:00.000Z");
const DAY = 24 * 3600 * 1000;

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
});
afterEach(() => {
  jest.useRealTimers();
});

const check = (paidAt: string, refundDate: string, now: Date = new Date()): RefundDateVerdict =>
  checkRefundDate(new Date(paidAt), refundDate, now);

describe("R-2 test 1: the boundary is inclusive at exactly 14 x 24h", () => {
  it("paidAt 2026-11-01T00:00Z, refundDate 2026-11-15 (the day starts exactly at the deadline) is accepted", () => {
    expect(refundDeadline(new Date("2026-11-01T00:00:00.000Z")).toISOString()).toBe(
      "2026-11-15T00:00:00.000Z",
    );
    expect(check("2026-11-01T00:00:00.000Z", "2026-11-15")).toEqual({ ok: true });
  });
  it("the window is 14 x 24 x 3600 x 1000 ms", () => {
    expect(REFUND_WINDOW_MS).toBe(14 * DAY);
  });
});

describe("R-2 test 2: one millisecond past the boundary", () => {
  it("paidAt 2026-10-31T23:59:59.999Z, refundDate 2026-11-15 is STAFF_REFUND_WINDOW_PASSED", () => {
    expect(check("2026-10-31T23:59:59.999Z", "2026-11-15")).toEqual({
      ok: false,
      reason: "WINDOW_PASSED",
    });
  });
});

describe("R-2 test 3: late recording of an in-window refund is accepted", () => {
  it("refundDate = the UTC day of paidAt + 13 days, now = paidAt + 15 days", () => {
    const paidAt = new Date("2026-11-01T09:30:00.000Z");
    const now = new Date(paidAt.getTime() + 15 * DAY);
    const refundDay = new Date(paidAt.getTime() + 13 * DAY).toISOString().slice(0, 10);
    expect(refundDay).toBe("2026-11-14");
    expect(checkRefundDate(paidAt, refundDay, now)).toEqual({ ok: true });
  });
});

describe("R-2 test 4: a refund on the paid UTC day is accepted", () => {
  it("paidAt 2026-11-01T15:00Z, refundDate 2026-11-01 (dayEnd is after paidAt)", () => {
    expect(check("2026-11-01T15:00:00.000Z", "2026-11-01")).toEqual({ ok: true });
  });
  it("the last millisecond of the paid day still counts, the day before does not", () => {
    expect(check("2026-11-01T23:59:59.999Z", "2026-11-01")).toEqual({ ok: true });
    expect(check("2026-11-01T00:00:00.000Z", "2026-10-31")).toEqual({
      ok: false,
      reason: "OUT_OF_RANGE",
    });
  });
});

describe("R-2 test 5: out-of-range dates are a plain refusal, never the window code", () => {
  it("the paid UTC day minus one", () => {
    expect(check("2026-11-01T15:00:00.000Z", "2026-10-31")).toEqual({
      ok: false,
      reason: "OUT_OF_RANGE",
    });
  });
  it("UTC tomorrow", () => {
    expect(check("2026-11-01T15:00:00.000Z", "2026-11-21")).toEqual({
      ok: false,
      reason: "OUT_OF_RANGE",
    });
  });
  it("a local 'today' one day ahead of UTC (now 2026-11-25T22:00Z, refundDate 2026-11-26)", () => {
    const now = new Date("2026-11-25T22:00:00.000Z");
    expect(checkRefundDate(new Date("2026-11-20T10:00:00.000Z"), "2026-11-26", now)).toEqual({
      ok: false,
      reason: "OUT_OF_RANGE",
    });
    // UTC today is fine
    expect(checkRefundDate(new Date("2026-11-20T10:00:00.000Z"), "2026-11-25", now)).toEqual({
      ok: true,
    });
  });
  it("not a calendar day at all", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "26-11-01", "", "2026-11-15T10:00:00Z"]) {
      expect(check("2026-11-01T15:00:00.000Z", bad)).toEqual({ ok: false, reason: "OUT_OF_RANGE" });
    }
  });
  it("a future day wins over the window: the range is judged before the window", () => {
    // paid a month ago, entered day is tomorrow: out of range, not window passed
    expect(check("2026-10-01T00:00:00.000Z", "2026-11-21")).toEqual({
      ok: false,
      reason: "OUT_OF_RANGE",
    });
  });
});
