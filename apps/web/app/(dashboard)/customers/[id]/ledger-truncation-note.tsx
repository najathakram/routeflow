"use client";

import * as React from "react";

/**
 * B110 disclosure: the statement ledger is a capped read (the API returns
 * `transactionsTruncated` when its own reads hit their take caps), so a long
 * history renders as a partial view. Without this line the ledger reads as the
 * complete history. Renders NOTHING unless the server actually said `true` —
 * an absent/false flag must never add a scary label to a complete ledger.
 */
export function LedgerTruncationNote({ truncated }: { truncated?: boolean }) {
  if (truncated !== true) return null;
  return (
    <p className="mb-2 text-xs text-navy/70">
      Showing the most recent transactions only — older entries are not listed in this ledger.
    </p>
  );
}
