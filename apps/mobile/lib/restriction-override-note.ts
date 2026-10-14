import { RESTRICTION_OVERRIDE_LABEL, type OverrideStampView } from "@routeflow/types";

/** Row 510: the fallback when the overriding user no longer exists (or can't be read). */
export const FORMER_USER = "former user";

/** The stamp as a STAFF read carries it: the API always sends `restrictionOverrideByName` (null = the user is gone). */
export type OverrideStampSource = Partial<OverrideStampView> & {
  restrictionOverrideByName?: string | null;
};

/** "Oct 7, 2026", or null when the stamp has no readable time. */
function shortDate(at: string | null | undefined): string | null {
  if (!at) return null;
  const d = new Date(at);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** `Sold despite restriction · <reason> · by <name> · <when>`; the date is left out when the stamp has none. */
export function restrictionOverrideLine(p: {
  reason: string;
  /** The API's resolved name; null = the user is gone ("former user"). undefined = the field is absent (older API): the "by" part is left out. */
  name: string | null | undefined;
  at: string | null | undefined;
}): string {
  const parts = [RESTRICTION_OVERRIDE_LABEL, p.reason];
  if (p.name !== undefined) parts.push(`by ${p.name ?? FORMER_USER}`);
  const when = shortDate(p.at);
  if (when) parts.push(when);
  return parts.join(" · ");
}

/**
 * The note for a line, or null when the line carries no override reason. The ONE place a line becomes its note: the
 * order card model, the legacy order row and the invoice row all read it (a line with no reason is no note).
 */
export function restrictionOverrideNoteOf(
  line: OverrideStampSource | null | undefined,
): string | null {
  const reason = line?.restrictionOverrideReason?.trim();
  if (!line || !reason) return null;
  return restrictionOverrideLine({
    reason,
    name: line.restrictionOverrideByName,
    at: line.restrictionOverrideAt,
  });
}
