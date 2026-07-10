/**
 * P10-PAR-3 pure-logic guards for the mobile recurring-invoices parity screen.
 * Locks the Active/Paused pill mapping and the human schedule label.
 */
import { freqLabel, recurringActionFlags, recurringPillFor } from "../lib/recurring-invoices-logic";
import type { RecurringFrequency } from "../lib/api/recurring-invoices";

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
