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

/** ISO day chips for schedule pickers — value 1..7 with the same Mon-first labels. */
export const ISO_DAY_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
];

/**
 * The staff list endpoint returns a `{data, meta}` envelope; some endpoints
 * (and older builds) return bare arrays. One tolerant unwrap so no consumer
 * ever calls `.filter` on the envelope again (the crash this fixes).
 */
export function unwrapListEnvelope<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  const data = (payload as { data?: unknown } | null | undefined)?.data;
  return Array.isArray(data) ? (data as T[]) : [];
}

export interface TemplateFormInput {
  name: string;
  daysOfWeek: number[];
  items: { productId: string; qty: number }[];
}

/**
 * The exact create rules web's StandingOrderModal enforces: a name, at least
 * one ISO day, at least one item with qty ≥ 1. Returns the first human error
 * or null when submittable.
 */
export function validateTemplateForm(form: TemplateFormInput): string | null {
  if (!form.name.trim()) return "Give this standing order a name.";
  if (!form.daysOfWeek.length) return "Pick at least one delivery day.";
  if (!form.items.length) return "Add at least one product.";
  if (form.items.some((i) => !i.productId || !Number.isFinite(i.qty) || i.qty < 1)) {
    return "Every line needs a product and a quantity of at least 1.";
  }
  return null;
}
