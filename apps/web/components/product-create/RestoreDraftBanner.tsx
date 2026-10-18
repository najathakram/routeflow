"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";

/**
 * Offered at the top of the New product form when an unfinished product was saved on this device.
 * It is rendered from the modal's first render (the draft is read synchronously), so it never
 * pushes content down after the first paint.
 */
export function RestoreDraftBanner({
  onRestore,
  onDiscard,
}: {
  onRestore: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      data-testid="units-v2-restore-banner"
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-surface-border bg-surface-raised px-3 py-2.5"
    >
      <div className="min-w-0">
        <p className="text-sm font-semibold text-navy">Restore your unsaved product?</p>
        <p className="text-xs text-navy/70">You were adding a product when this closed.</p>
      </div>
      <div className="flex gap-2">
        <Button type="button" size="sm" data-testid="units-v2-restore-yes" onClick={onRestore}>
          Restore
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          data-testid="units-v2-restore-no"
          onClick={onDiscard}
        >
          Start fresh
        </Button>
      </div>
    </div>
  );
}
