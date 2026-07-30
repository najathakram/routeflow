import { fmt } from "./formatting";
import type {
  InvoiceTreatment,
  ReportCadence,
  TrackedCategory,
  TrackedSubcategory,
} from "./api/tracked-categories";

/** One entry in a section/subcategory `<select>`. */
export interface RegulatedPickerOption {
  id: string;
  name: string;
  inactive: boolean;
}

/**
 * Options for a regulated-section `<select>`: the tenant's active sections, plus
 * the product's current section injected (flagged inactive) when it was since
 * deactivated — so an edit form never silently drops a still-applied tag. Shared
 * by the product create modal and the inline product edit so their filtering
 * rules can't drift. On the create path `current` is omitted (a new product has
 * no pre-existing tag), so the result is simply the active sections.
 */
export function sectionPickerOptions(
  activeSections: TrackedCategory[],
  current?: { id: string; name: string } | null,
): RegulatedPickerOption[] {
  const opts: RegulatedPickerOption[] = activeSections.map((s) => ({
    id: s.id,
    name: s.name,
    inactive: false,
  }));
  if (current && !opts.some((o) => o.id === current.id)) {
    opts.push({ id: current.id, name: current.name, inactive: true });
  }
  return opts;
}

/**
 * Options for a subcategory `<select>` within a section: the active
 * subcategories, plus the current selection (flagged inactive) if it was since
 * deactivated. Same drift-proofing as {@link sectionPickerOptions}.
 */
export function subcategoryPickerOptions(
  subcategories: TrackedSubcategory[],
  currentId?: string | null,
): RegulatedPickerOption[] {
  return subcategories
    .filter((s) => s.active || s.id === currentId)
    .map((s) => ({ id: s.id, name: s.name, inactive: !s.active }));
}

/** The most recent completed period for a cadence, as {year, index}. */
export function lastCompletedPeriod(cadence: ReportCadence): { year: number; index: number } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1-12
  if (cadence === "ANNUAL") return { year: y - 1, index: 1 };
  if (cadence === "QUARTERLY") {
    const q = Math.floor((m - 1) / 3) + 1; // current quarter 1-4
    return q === 1 ? { year: y - 1, index: 4 } : { year: y, index: q - 1 };
  }
  return m === 1 ? { year: y - 1, index: 12 } : { year: y, index: m - 1 }; // MONTHLY: prev month
}

/** Human label for a section's tax rule (e.g. "$2.87 / pack", "5% of sale"). */
export function taxRuleLabel(c: TrackedCategory): string {
  const rate = Number(c.rate);
  const basis = c.unitBasis || "unit";
  switch (c.taxType) {
    case "EXCISE_PER_UNIT":
    case "PER_VOLUME":
    case "DEPOSIT_PER_CONTAINER":
      return `${fmt(rate)} / ${basis}`;
    case "PERCENT_OF_SALE": {
      const pct = rate * 100;
      return `${pct % 1 === 0 ? pct : pct.toFixed(2)}% of sale`;
    }
    case "NONE":
    default:
      return "Tracked only · no auto tax";
  }
}

/** Human label for how a section appears on invoices. */
export function treatmentLabel(t: InvoiceTreatment): string {
  return t === "SEPARATE_INVOICE"
    ? "Separate invoice"
    : t === "SEPARATE_SECTION"
      ? "Sectioned on invoice"
      : "Per-line tax";
}

/** Date-range presets for the Reports panel (arbitrary-range report preview/CSV). */
export type ReportRangePreset = "last-month" | "this-month" | "last-quarter" | "year-to-date";

/**
 * Inclusive `{from, to}` (YYYY-MM-DD, UTC) for a report date-range preset. Sibling of
 * {@link lastCompletedPeriod}, but for the Reports panel — which runs over arbitrary
 * date ranges rather than filing periods — so it works off calendar months/quarters
 * relative to `today` instead of a filing cadence.
 */
export function presetRange(
  preset: ReportRangePreset,
  today: Date = new Date(),
): { from: string; to: string } {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth(); // 0-11
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = (yy: number, mm: number, dd: number) => `${yy}-${pad(mm + 1)}-${pad(dd)}`;
  const lastDayOfMonth = (yy: number, mm: number) => new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();

  switch (preset) {
    case "this-month":
      return { from: iso(y, m, 1), to: iso(y, m, lastDayOfMonth(y, m)) };
    case "last-quarter": {
      const q = Math.floor(m / 3); // current quarter, 0-3
      const lastQ = q === 0 ? 3 : q - 1;
      const lastQYear = q === 0 ? y - 1 : y;
      const startMonth = lastQ * 3;
      const endMonth = startMonth + 2;
      return {
        from: iso(lastQYear, startMonth, 1),
        to: iso(lastQYear, endMonth, lastDayOfMonth(lastQYear, endMonth)),
      };
    }
    case "year-to-date":
      return { from: iso(y, 0, 1), to: iso(y, m, today.getUTCDate()) };
    case "last-month":
    default: {
      const lm = m === 0 ? 11 : m - 1;
      const lmYear = m === 0 ? y - 1 : y;
      return { from: iso(lmYear, lm, 1), to: iso(lmYear, lm, lastDayOfMonth(lmYear, lm)) };
    }
  }
}
