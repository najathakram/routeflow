"use client";

import * as React from "react";
import { Button, Modal, useToast } from "@routeflow/ui/web";
import { useLiftBatch } from "@/lib/api/portal-limits";
import { LIFT_DEFAULT_REASON } from "@/lib/portal-limits";

/**
 * "Lift this limit?" (spec §2 undo path b/c): one confirm for one chip or N ticked rows, an optional note for the audit
 * trail and the primary `Lift`. The mutation toasts its own server errors once (global handler); the dialog stays open.
 */
export function LiftLimitsDialog({
  ids,
  onClose,
  onDone,
}: {
  /** Open while there is something to lift. */
  ids: string[];
  onClose: () => void;
  onDone?: () => void;
}) {
  const { toast } = useToast();
  const lift = useLiftBatch();
  const [note, setNote] = React.useState("");
  React.useEffect(() => setNote(""), [ids.join(",")]);
  const n = ids.length;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (n === 0 || lift.isPending) return;
    lift.mutate(
      { ids, reason: note.trim() || LIFT_DEFAULT_REASON },
      {
        onSuccess: (r) => {
          const lifted = r.lifted ?? n;
          toast({
            title: lifted === 1 ? "Limit lifted" : `${lifted} limits lifted`,
            variant: "success",
          });
          onDone?.();
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open={n > 0}
      onClose={onClose}
      title={n === 1 ? "Lift this limit?" : `Lift ${n} limits?`}
      description="Customers see these products in the portal again straight away. Lifted limits stay in the list."
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <label className="block text-sm font-medium text-navy">
          Note (optional)
          <input
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            className="mt-1 h-10 w-full rounded border border-surface-border px-3 text-sm font-normal text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </label>
        <div className="flex justify-end gap-3 border-t border-surface-border pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={lift.isPending}>
            Lift
          </Button>
        </div>
      </form>
    </Modal>
  );
}
