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
