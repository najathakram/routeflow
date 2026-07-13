import { fmt } from "./formatting";
import type { InvoiceTreatment, ReportCadence, TrackedCategory } from "./api/tracked-categories";

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
