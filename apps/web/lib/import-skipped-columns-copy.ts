import {
  IMPORT_COLUMN_REQUIREMENT_VALUES,
  type ImportColumnRequirement,
  type ImportSkippedColumn,
} from "@routeflow/types";

/**
 * SA-1193 K6 (B1377): fixed words for the columns a product import skipped because the account lacks what they need.
 * Built from `requires` only, never from a server sentence. Every key of the union needs a name (the type enforces it).
 */
export const IMPORT_REQUIREMENT_NAME: Record<ImportColumnRequirement, string> = {
  MSRP: "the MSRP add-on",
  TOBACCO_DEALER: "the Tobacco dealer add-on",
  FORECASTING: "Forecasting",
};

/**
 * A next step only where one is true today. Forecasting is a self-serve add-on on the Plan & billing page. MSRP and the
 * Tobacco dealer add-on are managed by RouteFlow (read-only on that page) and the app has no contact link, so they get none.
 */
export const IMPORT_REQUIREMENT_NEXT_STEP: Partial<
  Record<ImportColumnRequirement, { before: string; label: string; href: string; after: string }>
> = {
  FORECASTING: {
    before: "You can add Forecasting in ",
    label: "Plan & billing",
    href: "/settings/billing",
    after: ".",
  },
};

/** Toast line after an apply that skipped columns. */
export const IMPORT_SKIPPED_COLUMNS_TOAST = "Some columns weren’t imported.";

/** “A”, “A” and “B”, “A”, “B”, and “C” (serial comma). */
function quoteList(headers: string[]): string {
  const q = headers.map((h) => `“${h}”`);
  if (q.length <= 2) return q.join(" and ");
  return `${q.slice(0, -1).join(", ")}, and ${q[q.length - 1]}`;
}

export interface SkippedColumnsNotice {
  title: string;
  lines: { requires: ImportColumnRequirement; text: string }[];
  footer: string;
}

/** The notice for a preview (`done` false) or a finished apply (`done` true); null when nothing was skipped. */
export function skippedColumnsNotice(
  skipped: ImportSkippedColumn[] | undefined,
  done: boolean,
): SkippedColumnsNotice | null {
  if (!skipped || skipped.length === 0) return null;
  const one = skipped.length === 1;
  const lines = IMPORT_COLUMN_REQUIREMENT_VALUES.flatMap((requires) => {
    const headers = skipped.filter((s) => s.requires === requires).map((s) => s.column);
    if (headers.length === 0) return [];
    const verb = headers.length === 1 ? "needs" : "need";
    return [
      { requires, text: `${quoteList(headers)} ${verb} ${IMPORT_REQUIREMENT_NAME[requires]}.` },
    ];
  });
  return {
    title: done
      ? one
        ? "This column wasn’t imported"
        : "These columns weren’t imported"
      : one
        ? "This column won’t be imported"
        : "These columns won’t be imported",
    lines,
    footer: done
      ? "Your other columns were imported as shown below."
      : "Your other columns import as shown below.",
  };
}
