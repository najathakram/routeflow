"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import { DIRTY_HINT, usePanelDisclosure, useRevealOnOpen } from "./usePanelDisclosure";

/**
 * "Reset all to Auto": a button that opens a confirm panel. It knows nothing about prices: the
 * caller owns what a reset does (`onApply`), what it previews (`preview`, `changedCount`) and when it
 * is blocked. While the price draft is dirty the opener is disabled with a hint; Escape and Cancel
 * close the panel and put focus back on the opener (V17).
 */
export function ResetToAutoPanel({
  onApply,
  onCancel,
  preview,
  changedCount,
  anchorName,
  dirty = false,
  disabled = false,
}: {
  onApply: () => void;
  onCancel?: () => void;
  /** The old-versus-new prices table, built by the caller from its plan. */
  preview?: React.ReactNode;
  /** How many prices the reset would change. */
  changedCount?: number;
  /** The unit whose Retail price Auto prices are worked out from (it is not reset). */
  anchorName?: string;
  /** The price draft has unsaved changes: Reset waits (shown with a hint). */
  dirty?: boolean;
  disabled?: boolean;
}) {
  const { open, close, toggle, openerRef } = usePanelDisclosure();
  const hintId = React.useId();
  const blocked = dirty || disabled;
  const panelRef = React.useRef<HTMLDivElement>(null);
  useRevealOnOpen(panelRef, open);

  React.useEffect(() => {
    if (dirty && open) close();
  }, [dirty, open, close]);

  return (
    <div className="space-y-2">
      <Button
        ref={openerRef}
        type="button"
        variant="secondary"
        data-testid="units-v2-reset-open"
        aria-expanded={open}
        aria-controls="units-v2-reset-panel"
        aria-describedby={dirty ? hintId : undefined}
        disabled={blocked && !open}
        hidden={open}
        style={open ? { display: "none" } : undefined}
        onClick={toggle}
      >
        Reset all to Auto
      </Button>
      {dirty && (
        <p id={hintId} className="text-xs text-navy/70">
          {DIRTY_HINT}
        </p>
      )}
      {open && (
        <div
          ref={panelRef}
          id="units-v2-reset-panel"
          data-testid="units-v2-reset-panel"
          role="group"
          aria-label="Reset all to Auto"
          className="space-y-3 rounded-lg border border-surface-border bg-white p-4"
        >
          <div>
            <h3 className="text-sm font-semibold text-navy">Reset all to Auto?</h3>
            <p className="text-xs text-navy/70">
              {anchorName
                ? `Every price you set goes back to Auto, except the ${anchorName} Retail price, which Auto prices are worked out from.`
                : "Every price you set goes back to Auto, except the Retail price Auto prices are worked out from."}
            </p>
          </div>
          {preview}
          {changedCount != null && (
            <p className="text-xs text-navy/70">
              {changedCount === 1 ? "1 price will change." : `${changedCount} prices will change.`}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              data-testid="units-v2-reset-apply"
              disabled={disabled}
              onClick={() => {
                onApply();
                close();
              }}
            >
              Reset to Auto
            </Button>
            <Button
              type="button"
              variant="secondary"
              data-testid="units-v2-reset-cancel"
              onClick={() => {
                onCancel?.();
                close();
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
