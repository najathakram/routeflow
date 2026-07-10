import type { RecurringFrequency } from "./api/recurring-invoices";

/**
 * Pure (screen-free, testable) recurring-invoice helpers — the Active/Paused pill
 * and the human schedule label. Kept out of the RN screens so
 * apps/mobile/__tests__/*.test.ts (pure-logic, node env) can lock them.
 *
 * No line-amount helper: the mobile screen shows the template's raw lines (qty ×
 * unitPrice) for reference; the actual invoice total is computed server-side at
 * generation time — the client never derives a money total here.
 */

export type PillVariant = "brand" | "green" | "orange" | "red" | "gray" | "purple";

/** State is a boolean, not an enum — Active (green) / Paused (gray). */
export function recurringPillFor(isActive: boolean): { variant: PillVariant; label: string } {
  return isActive ? { variant: "green", label: "Active" } : { variant: "gray", label: "Paused" };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human schedule label, e.g. "Weekly — Mon" / "Every 2 weeks — Wed" / "Monthly — day 15". */
export function freqLabel(
  frequency: RecurringFrequency,
  dayOfWeek?: number,
  dayOfMonth?: number,
): string {
  const dow = DAYS[dayOfWeek ?? 1] ?? "Mon";
  switch (frequency) {
    case "WEEKLY":
      return `Weekly — ${dow}`;
    case "BIWEEKLY":
      return `Every 2 weeks — ${dow}`;
    case "MONTHLY":
      return `Monthly — day ${dayOfMonth ?? 1}`;
    default:
      return frequency;
  }
}
