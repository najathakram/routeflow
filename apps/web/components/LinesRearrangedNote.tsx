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
  const time = Number.isNaN(at.getTime())
    ? ""
    : ` · ${at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  return (
    <p className="pb-2 text-xs text-navy/70" data-testid="lines-rearranged-note">
      Customer rearranged the lines{time}
    </p>
  );
}
