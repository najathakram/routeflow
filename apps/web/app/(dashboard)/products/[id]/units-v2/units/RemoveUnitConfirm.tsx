"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import { useDeleteProductUnit } from "@/lib/api/product-units";
import { orderErrorText } from "@/lib/order-error-text";
import { DIRTY_HINT, usePanelDisclosure, useRevealOnOpen } from "./usePanelDisclosure";

const panelId = (unit: { id: string }, key?: string) =>
  `units-v2-remove-panel-${unit.id}${key ? `-${key}` : ""}`;

export interface RemovableUnit {
  id: string;
  label: string;
}

/**
 * The confirm shown before a unit is removed. It owns no open state: the caller renders it while a
 * removal is pending and gets `onClose` for Keep it, Escape and a finished delete. Focus starts on
 * Keep it (the safe choice); returning focus to the row's Remove button is the caller's job
 * (`RemoveUnitControl` does it).
 */
export function RemoveUnitConfirm({
  productId,
  unit,
  panelKey,
  onClose,
  onRemoved,
}: {
  productId: string;
  unit: RemovableUnit;
  /** Added to the panel's id when the same unit is drawn more than once on the page (a table row and a phone card). */
  panelKey?: string;
  onClose: () => void;
  /** After a finished delete, instead of `onClose` (the row is about to go, so focus must not go back to it). */
  onRemoved?: () => void;
}) {
  const remove = useDeleteProductUnit(productId);
  const keepRef = React.useRef<HTMLButtonElement>(null);
  const [err, setErr] = React.useState("");

  React.useEffect(() => keepRef.current?.focus(), []);
  const panelRef = React.useRef<HTMLDivElement>(null);
  useRevealOnOpen(panelRef);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Row 614: set before the request, so a second click in the same tick deletes nothing more.
  const inFlight = React.useRef(false);
  const confirm = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setErr("");
    remove.mutate(unit.id, {
      onSuccess: onRemoved ?? onClose,
      onError: (error) => setErr(orderErrorText(error)),
      onSettled: () => {
        inFlight.current = false;
      },
    });
  };

  return (
    <div
      ref={panelRef}
      id={panelId(unit, panelKey)}
      data-testid="units-v2-remove-panel"
      role="group"
      aria-label={`Remove the ${unit.label}`}
      className="space-y-3 rounded-lg border border-surface-border bg-white p-4"
    >
      <div>
        <h3 className="text-sm font-semibold text-navy">{`Remove the ${unit.label}?`}</h3>
        <p className="text-xs text-navy/70">
          Its prices are removed too. Orders and invoices keep what they charged.
        </p>
      </div>
      <p
        data-testid="units-v2-remove-err"
        role="alert"
        hidden={!err}
        className="text-sm text-danger"
      >
        {err}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="danger"
          data-testid="units-v2-rm-confirm"
          loading={remove.isPending}
          onClick={confirm}
        >
          {`Remove ${unit.label}`}
        </Button>
        <Button
          ref={keepRef}
          type="button"
          variant="secondary"
          data-testid="units-v2-rm-cancel"
          onClick={onClose}
        >
          Keep it
        </Button>
      </div>
    </div>
  );
}

/**
 * A row's Remove button plus its confirm. Escape, Keep it and a finished delete all close the confirm
 * and focus this button. Remove writes straight through the units endpoint, so it waits while the price
 * draft is dirty.
 */
export function RemoveUnitControl({
  productId,
  unit,
  dirty = false,
  disabled = false,
  panelKey,
  onRemoved,
}: {
  productId: string;
  unit: RemovableUnit;
  dirty?: boolean;
  disabled?: boolean;
  /** See RemoveUnitConfirm: keeps the confirm's id unique when this unit's row is drawn twice. */
  panelKey?: string;
  /**
   * Called after a finished delete. The row is gone once the grid refetches, so the control does not refocus its
   * own button then; the caller moves focus somewhere that stays (K10d: the units heading).
   */
  onRemoved?: () => void;
}) {
  const { open, setOpen, close, openerRef } = usePanelDisclosure();
  const hintId = React.useId();
  const blocked = dirty || disabled;

  React.useEffect(() => {
    if (blocked && open) setOpen(false);
  }, [blocked, open, setOpen]);

  return (
    <div className="space-y-2">
      <Button
        ref={openerRef}
        type="button"
        variant="secondary"
        size="sm"
        data-testid={`units-v2-rm-${unit.id}`}
        aria-expanded={open}
        aria-controls={panelId(unit, panelKey)}
        aria-describedby={dirty ? hintId : undefined}
        disabled={blocked}
        onClick={() => setOpen(true)}
      >
        {`Remove ${unit.label}`}
      </Button>
      {dirty && (
        <p id={hintId} className="text-xs text-navy/70">
          {DIRTY_HINT}
        </p>
      )}
      {open && !blocked && (
        <RemoveUnitConfirm
          productId={productId}
          unit={unit}
          panelKey={panelKey}
          onClose={close}
          onRemoved={
            onRemoved
              ? () => {
                  setOpen(false);
                  onRemoved();
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
