import type {
  InvoiceTreatment,
  ReportCadence,
  TrackedCategory,
  TrackedSubcategory,
} from "./api/tracked-categories";

/**
 * Pure regulated-category display helpers — mirrors apps/web/lib/regulated-format.ts
 * (sectionPickerOptions/subcategoryPickerOptions/taxRuleLabel/treatmentLabel only;
 * the filings-only lastCompletedPeriod helper is out of scope for mobile REG-2/REG-3).
 * No RN import so apps/mobile/__tests__/*.test.ts (pure-logic, node env) can lock it.
 */

/** One entry in a section/subcategory picker sheet. */
export interface RegulatedPickerOption {
  id: string;
  name: string;
  inactive: boolean;
}

/**
 * Options for a regulated-section picker: the tenant's active sections, plus the
 * product's current section injected (flagged inactive) when it was since
 * deactivated — so an edit form never silently drops a still-applied tag. Shared
 * by the product create form and edit form so their filtering can't drift. On
 * the create path `current` is omitted/null (a new product has no pre-existing
 * tag), so the result is simply the active sections.
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
 * Options for a subcategory picker within a section: the active subcategories,
 * plus the current selection (flagged inactive) if it was since deactivated.
 * Same drift-proofing as {@link sectionPickerOptions}.
 */
export function subcategoryPickerOptions(
  subcategories: TrackedSubcategory[],
  currentId?: string | null,
): RegulatedPickerOption[] {
  return subcategories
    .filter((s) => s.active || s.id === currentId)
    .map((s) => ({ id: s.id, name: s.name, inactive: !s.active }));
}

/** Human label for a section's tax rule (e.g. "$2.87 / pack", "5% of sale"). */
export function taxRuleLabel(c: TrackedCategory): string {
  const rate = Number(c.rate);
  const basis = c.unitBasis || "unit";
  switch (c.taxType) {
    case "EXCISE_PER_UNIT":
    case "PER_VOLUME":
    case "DEPOSIT_PER_CONTAINER":
      return `$${rate.toFixed(2)} / ${basis}`;
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

/**
 * The most recent COMPLETED period for a cadence, as {year, index} — mirrors
 * apps/web/lib/regulated-format.ts#lastCompletedPeriod exactly. Used by the
 * mobile section-detail screen's "Prepare filing" action (WP3) to default the
 * filing to the last full month/quarter/year rather than the still-in-progress
 * current one.
 */
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

/**
 * Format a money amount (a plain number, or a Prisma-Decimal serialized as a
 * string) as "$X.XX". Mirrors the local `fmt()` idiom already duplicated in
 * several mobile screens (e.g. app/(operator)/tobacco/index.tsx) — mobile has no
 * shared currency helper — centralized here since both the hub and per-section
 * detail screens (WP2/WP3) need it for both numeric ledger rows and
 * Decimal-string filing totals.
 */
export function fmtMoney(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}
