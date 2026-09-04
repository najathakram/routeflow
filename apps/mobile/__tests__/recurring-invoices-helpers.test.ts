/**
 * P10-PAR-3 pure-logic guards for the mobile recurring-invoices parity screen.
 * Locks the Active/Paused pill mapping and the human schedule label.
 */
import {
  freqLabel,
  recurringActionFlags,
  recurringPillFor,
  recurringScheduleFields,
} from "../lib/recurring-invoices-logic";
import type { RecurringFrequency } from "../lib/api/recurring-invoices";
import * as logic from "../lib/recurring-invoices-logic";

describe("recurringPillFor", () => {
  it.each([
    [true, "green", "Active"],
    [false, "gray", "Paused"],
  ] as const)("%s → %s / %s", (isActive, variant, label) => {
    expect(recurringPillFor(isActive)).toEqual({ variant, label });
  });
});

describe("recurringActionFlags", () => {
  it("active → generate + pause, never resume", () => {
    expect(recurringActionFlags(true)).toEqual({
      canRunNow: true,
      canPause: true,
      canActivate: false,
    });
  });
  it("paused → generate + resume, never pause", () => {
    expect(recurringActionFlags(false)).toEqual({
      canRunNow: true,
      canPause: false,
      canActivate: true,
    });
  });
});

describe("recurringScheduleFields", () => {
  it("MONTHLY sends only dayOfMonth (clamped 1–28)", () => {
    expect(recurringScheduleFields("MONTHLY", 3, 15)).toEqual({ dayOfMonth: 15 });
    expect(recurringScheduleFields("MONTHLY", 3, 31)).toEqual({ dayOfMonth: 28 });
    expect(recurringScheduleFields("MONTHLY", 3, 0)).toEqual({ dayOfMonth: 1 });
  });
  it("WEEKLY / BIWEEKLY send only dayOfWeek (clamped 0–6)", () => {
    expect(recurringScheduleFields("WEEKLY", 2, 15)).toEqual({ dayOfWeek: 2 });
    expect(recurringScheduleFields("BIWEEKLY", 9, 15)).toEqual({ dayOfWeek: 6 });
    expect(recurringScheduleFields("WEEKLY", -1, 15)).toEqual({ dayOfWeek: 0 });
  });
});

describe("freqLabel", () => {
  it.each([
    ["WEEKLY", 1, undefined, "Weekly — Mon"],
    ["BIWEEKLY", 3, undefined, "Every 2 weeks — Wed"],
    ["MONTHLY", undefined, 15, "Monthly — day 15"],
    ["WEEKLY", undefined, undefined, "Weekly — Mon"], // default day-of-week
    ["MONTHLY", undefined, undefined, "Monthly — day 1"], // default day-of-month
  ] as const)("%s/%s/%s → %s", (f, dow, dom, out) => {
    expect(freqLabel(f as RecurringFrequency, dow, dom)).toBe(out);
  });
});

describe("REG-B106 lastRunOutcome", () => {
  // T22 (R17): not exported yet — `fn` is undefined, so each expect fails on
  // its own concrete expected value rather than on an unresolved import.
  const fn = (logic as any).lastRunOutcome;

  it("T22a — no last run, or a run with no recorded status → null", () => {
    expect(fn ? fn({ lastRunAt: null }) : undefined).toEqual(null);
    expect(fn ? fn({ lastRunAt: "2026-07-01T00:00:00Z", lastRunStatus: null }) : undefined).toEqual(
      null,
    );
  });

  it("T22b — FAILED run → red pill with the error detail", () => {
    expect(
      fn
        ? fn({
            lastRunAt: "2026-07-01T00:00:00Z",
            lastRunStatus: "FAILED",
            lastError: "Customer not found",
          })
        : undefined,
    ).toEqual({ variant: "red", label: "Last run failed", detail: "Customer not found" });
  });

  it("T22c — SUCCESS run → green pill", () => {
    expect(
      fn
        ? fn({
            lastRunAt: "2026-07-01T00:00:00Z",
            lastRunStatus: "SUCCESS",
          })
        : undefined,
    ).toEqual({ variant: "green", label: "Last run succeeded" });
  });
});
