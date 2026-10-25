"use client";

import * as React from "react";

/**
 * F05: the scan box's answer, under the field. ONE region with a reserved height, so a miss appearing (or a confirmation
 * fading) never moves the scan row above it or the controls below it. A miss is an alert that names the rejected text;
 * otherwise the status line carries the cue ("Cola · now 2") or the "Added …" confirmation.
 */
export function CounterScanFeedback({
  miss,
  cue,
  added,
}: {
  miss: string;
  /** a repeat scan: "Cola · now 2" (wins over "Added …") */
  cue: string | null;
  /** a new line or picker add: "Added Corn Chips" */
  added: string;
}) {
  return (
    <div className="min-h-7" data-testid="counter-scan-feedback">
      {miss ? (
        <p role="alert" className="break-words text-sm font-medium text-red-700">
          {miss}
        </p>
      ) : null}
      {/* always mounted: a live region that already exists is announced when its text changes */}
      <div role="status" aria-live="polite">
        {!miss && (cue || added) ? (
          <p
            className="rounded bg-navy/5 px-2 py-1 text-sm font-medium"
            data-testid={cue ? "counter-scan-cue" : "counter-scan-added"}
          >
            {cue || added}
          </p>
        ) : null}
      </div>
    </div>
  );
}
