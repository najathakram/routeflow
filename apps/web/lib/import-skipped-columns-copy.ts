import {
  IMPORT_COLUMN_REQUIREMENT_VALUES,
  type ImportColumnRequirement,
  type ImportSkippedColumn,
} from "@routeflow/types";

/**
 * SA-1193 K6 + A1-2 (B1377): fixed sentences for the columns a product import skipped because the account lacks what
 * they need. The sentence is ours, never a server sentence. The add-on's NAME is the server's `label`, the name the
 * billing page shows for it (A1-2), so this file types no add-on name (pinned by a grep in the panel's test).
 * Every key of the union needs a sentence (the type enforces it).
 */
const NAME_IN_SENTENCE: Record<ImportColumnRequirement, (label: string) => string> = {
  MSRP: (label) => `the ${label} add-on`,
  TOBACCO_DEALER: (label) => `the ${label} add-on`,
  FORECASTING: (label) => label,
};

/** An older server sent no `label`: say only what is true without a name. */
const NO_NAME = "an add-on";

/**
 * A next step only where one is true today. Forecasting is a self-serve add-on on the Plan & billing page. MSRP and the
 * Tobacco add-on are managed by RouteFlow (read-only on that page) and the app has no contact link, so they get none.
 */
export const IMPORT_REQUIREMENT_NEXT_STEP: Partial<
  Record<
    ImportColumnRequirement,
    { before: (label: string) => string; linkText: string; href: string; after: string }
  >
> = {
  FORECASTING: {
    before: (label) => `You can add ${label} in `,
    linkText: "Plan & billing",
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
  /** `label` is undefined when an older server sent none: the line has no name and no next step. */
  lines: { requires: ImportColumnRequirement; label: string | undefined; text: string }[];
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
    const mine = skipped.filter((s) => s.requires === requires);
    if (mine.length === 0) return [];
    const headers = mine.map((s) => s.column);
    const label = mine.find((s) => typeof s.label === "string" && s.label.trim() !== "")?.label;
    const verb = headers.length === 1 ? "needs" : "need";
    const name = label ? NAME_IN_SENTENCE[requires](label) : NO_NAME;
    return [{ requires, label, text: `${quoteList(headers)} ${verb} ${name}.` }];
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
