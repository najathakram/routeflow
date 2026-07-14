import type {
  InvoiceTreatment,
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
