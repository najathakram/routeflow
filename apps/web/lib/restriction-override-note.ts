import { RESTRICTION_OVERRIDE_LABEL, type OverrideStampView } from "@routeflow/types";
import { fmtDate } from "@/lib/formatting";

/** Row 510: the fallback when the overriding user no longer exists (or can't be read). */
export const FORMER_USER = "former user";

/** The stamp as a STAFF read carries it; the API may also hand over an already-resolved `restrictionOverrideByName`. */
export type OverrideStampSource = Partial<OverrideStampView> & {
  restrictionOverrideByName?: string | null;
};

/** `Sold despite restriction · <reason> · by <name> · <when>`; the date is left out when the stamp has none. */
export function restrictionOverrideLine(p: {
  reason: string;
  /** null = could not be resolved: "former user". undefined = still resolving: the "by" part is left out for now. */
  name: string | null | undefined;
  at: string | null | undefined;
}): string {
  const parts = [RESTRICTION_OVERRIDE_LABEL, p.reason];
  if (p.name !== undefined) parts.push(`by ${p.name ?? FORMER_USER}`);
  if (p.at && fmtDate(p.at) !== "—") parts.push(fmtDate(p.at));
  return parts.join(" · ");
}
