"use client";

import * as React from "react";
import { WriteButton } from "@/lib/read-only-gate";

/**
 * F05: the scan box's answer, under the field. ONE region with a reserved height, so a miss appearing (or a confirmation
 * fading) never moves the scan row above it or the controls below it. A miss is an alert that names the rejected text;
 * otherwise the status line carries the cue ("Cola · now 2") or the "Added …" confirmation.
 */
export function CounterScanFeedback({
  miss,
  cue,
  added,
  onCreate,
}: {
  miss: string;
  /** a repeat scan: "Cola · now 2" (wins over "Added …") */
  cue: string | null;
  /** a new line or picker add: "Added Corn Chips" */
  added: string;
  /** W-1042: set only for a final not-found the clerk may create an item for; the miss line then carries the button. */
  onCreate?: () => void;
}) {
  return (
    <div className="min-h-7" data-testid="counter-scan-feedback">
      {miss ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="break-words text-sm font-medium text-red-700">
            {miss}
          </p>
          {onCreate ? (
            <WriteButton className="min-h-[44px]" variant="secondary" onClick={onCreate}>
              Create item
            </WriteButton>
          ) : null}
        </div>
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
