"use client";

import { AlertTriangle } from "lucide-react";

/**
 * Row 616: when Stripe reports a refund or dispute on a card payment, the API appends a
 * "[REVIEW] ..." line to the staff-only free-text notes of the paid invoice / on-account credit
 * (it never changes an amount or a status). This surfaces those lines to STAFF only: the
 * invoice page is also viewed by CUSTOMER-role users, and `internalNotes` is a staff-only field
 * the API strips from every buyer surface, so the role gate here is a second line of defence,
 * not the first. Never feed it a buyer-facing field.
 */
const REVIEW_PREFIX = "[REVIEW]";

export function reviewFlagLines(notes: string | null | undefined): string[] {
  if (!notes) return [];
  return notes
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(REVIEW_PREFIX))
    .map((l) => l.slice(REVIEW_PREFIX.length).trim())
    .filter(Boolean);
}

function isStaff(role: string | undefined | null): boolean {
  return !!role && role !== "CUSTOMER" && role !== "DRIVER";
}

export function ReviewFlagNotice({
  notes,
  role,
  compact = false,
}: {
  notes: string | null | undefined;
  role: string | undefined | null;
  /** One-line form for list rows. */
  compact?: boolean;
}) {
  if (!isStaff(role)) return null;
  const lines = reviewFlagLines(notes);
  if (lines.length === 0) return null;
  return (
    <div
      role="alert"
      className={
        compact
          ? "mt-1 flex items-start gap-1.5 text-xs text-warning"
          : "flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-bg px-4 py-3"
      }
    >
      <AlertTriangle
        className={compact ? "mt-0.5 h-3 w-3 shrink-0" : "mt-0.5 h-4 w-4 shrink-0 text-warning"}
      />
      <ul className={compact ? "space-y-0.5" : "space-y-1 text-sm text-navy/80"}>
        {lines.map((l, i) => (
          <li key={i}>
            <span className="font-medium">Needs review:</span> {l}
          </li>
        ))}
      </ul>
    </div>
  );
}
