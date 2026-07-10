/**
 * Pure (screen-free, testable) order-template ("standing order") helpers — the
 * Active/Paused pill, the detail-screen action flags, and the schedule label.
 * Kept out of the RN screens so apps/mobile/__tests__/*.test.ts (pure-logic,
 * node env) can lock them.
 *
 * No line-amount/money helper: order-template items are `{ productId, qty, notes }`
 * with NO price — there is nothing monetary to render or derive on this feature.
 */

export type PillVariant = "brand" | "green" | "orange" | "red" | "gray" | "purple";

/** State is a boolean, not an enum — Active (green) / Paused (gray). */
export function orderTemplatePillFor(isActive: boolean): { variant: PillVariant; label: string } {
  return isActive ? { variant: "green", label: "Active" } : { variant: "gray", label: "Paused" };
}

export interface OrderTemplateActionFlags {
  canGenerate: boolean; // POST /:id/generate — always
  canPause: boolean; // PATCH { isActive:false } — when active
  canActivate: boolean; // PATCH { isActive:true }  — when paused
}

/**
 * Detail-screen actions. Generate-now is always available; Pause only when
 * active, Resume only when paused — both directions are the same safe PATCH.
 */
export function orderTemplateActionFlags(isActive: boolean): OrderTemplateActionFlags {
  return { canGenerate: true, canPause: isActive, canActivate: !isActive };
}

// ISO weekday 1..7 → Mon..Sun. Index 0 is a placeholder so `iso` maps directly.
// NOTE: this API uses ISO weekdays (Mon=1 … Sun=7), NOT JS getDay() (Sun=0). Do
// NOT reuse recurring's 0-indexed ["Sun","Mon",…] array (it shifts every day by
// one) and do NOT index a Sun-first array by the raw value (Sunday=7 → undefined,
// the latent bug in app/(customer)/standing-orders.tsx). Mapping 7→"Sun" here
// renders all seven days correctly.
const ISO_DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** e.g. [1,3,5] → "Mon, Wed, Fri"; [] / undefined → "No schedule". */
export function daysLabel(daysOfWeek: number[] | undefined): string {
  if (!daysOfWeek?.length) return "No schedule";
  return [...daysOfWeek]
    .sort((a, b) => a - b)
    .map((d) => ISO_DAYS[d])
    .filter(Boolean)
    .join(", ");
}
