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

export interface RecurringActionFlags {
  canRunNow: boolean;
  canPause: boolean; // DELETE (soft deactivate)
  canActivate: boolean; // POST /:id/activate
}

/**
 * Detail-screen actions. Generate-now is always available (the server runs the
 * template regardless of active state); Pause only when active, Resume only when
 * paused — the pause/resume toggle.
 */
export function recurringActionFlags(isActive: boolean): RecurringActionFlags {
  return { canRunNow: true, canPause: isActive, canActivate: !isActive };
}

/**
 * The day fields to send on create: exactly ONE of dayOfWeek/dayOfMonth by
 * frequency (the DTO has no cross-field validator, so the client picks). MONTHLY
 * uses dayOfMonth (clamped 1–28 to dodge month-end); WEEKLY/BIWEEKLY use dayOfWeek.
 */
export function recurringScheduleFields(
  frequency: RecurringFrequency,
  dayOfWeek: number,
  dayOfMonth: number,
): { dayOfWeek?: number; dayOfMonth?: number } {
  if (frequency === "MONTHLY") {
    return { dayOfMonth: Math.min(28, Math.max(1, Math.floor(dayOfMonth))) };
  }
  return { dayOfWeek: Math.min(6, Math.max(0, Math.floor(dayOfWeek))) };
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
