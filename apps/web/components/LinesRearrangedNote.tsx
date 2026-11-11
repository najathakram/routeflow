"use client";

import * as React from "react";

/** W-1187 BR7: staff see when the customer arranged the lines ("Customer rearranged the lines · 2:14 PM"). */
export function LinesRearrangedNote({
  rearranged,
}: {
  rearranged?: { by: "CUSTOMER" | "STAFF"; at: string } | null;
}) {
  if (!rearranged || rearranged.by !== "CUSTOMER") return null;
  const at = new Date(rearranged.at);
  // today: the time; any other day: the date as well, so "2:14 PM" is never read as today's
  const today = at.toDateString() === new Date().toDateString();
  const time = Number.isNaN(at.getTime())
    ? ""
    : ` · ${today ? "" : `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, `}${at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  return (
    <p className="pb-2 text-xs text-navy/70" data-testid="lines-rearranged-note">
      Customer rearranged the lines{time}
    </p>
  );
}
