"use client";

import * as React from "react";
import { restrictionOverrideLine, type OverrideStampSource } from "@/lib/restriction-override-note";

/**
 * Row 510: "Sold despite restriction · <reason> · by <name> · <when>" under a STAFF order or invoice line that was sold
 * with an override. Staff screens only: the API never sends the stamp on a buyer read, and nothing under app/buyer imports
 * this (a pin). A line with no stamp renders nothing.
 *
 * The name is the API's own `restrictionOverrideByName` (always sent on a staff line): a name, or null when the user is
 * gone, which reads "former user". The note fetches nothing: user management is admin-only, so a lookup from an operator's
 * screen would 403 and falsely read "former user".
 */
export function RestrictionOverrideNote({
  line,
}: {
  line: OverrideStampSource | null | undefined;
}) {
  const reason = line?.restrictionOverrideReason?.trim();
  if (!line || !reason) return null;
  return (
    <p
      data-testid="restriction-override-note"
      className="mt-0.5 text-xs font-normal text-amber-800"
    >
      {restrictionOverrideLine({
        reason,
        name: line.restrictionOverrideByName,
        at: line.restrictionOverrideAt,
      })}
    </p>
  );
}
