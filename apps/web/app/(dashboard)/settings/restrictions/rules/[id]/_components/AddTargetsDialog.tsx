"use client";

import * as React from "react";
import { Button, Modal, useToast } from "@routeflow/ui/web";
import { API_ERROR_CODES } from "@routeflow/types";
import { RuleTargetPicker } from "@/components/restrictions/RuleTargetPicker";
import { useAddRuleTargets, useRemoveRuleTargets } from "@/lib/api/restrictions-admin-write";
import { ruleErrorCode } from "@/lib/restriction-rule-errors";
import { targetsToInput, type PickedTarget } from "@/lib/rule-targets";

/** The reason Undo leaves on the audit trail. */
export const UNDO_ADD_REASON = "Undone right after adding";
/** How long the "N added" toast (and its Undo) stays up. */
const UNDO_VISIBLE_MS = 10_000;

/**
 * "Add products" on a rule: the same picker as New rule, in add mode (products the rule already shows
 * read "In rule" and cannot be picked; the server skips any it has beyond those and says so). One
 * primary, "Add N". Success closes and toasts "N added" with Undo, which removes exactly what was added.
 */
export function AddTargetsDialog({
  ruleId,
  open,
  onClose,
  lockedProductIds,
  lockedCategoryIds,
}: {
  ruleId: string;
  open: boolean;
  onClose: () => void;
  lockedProductIds: string[];
  lockedCategoryIds: string[];
}) {
  const { toast } = useToast();
  const add = useAddRuleTargets();
  const undo = useRemoveRuleTargets();
  const [picks, setPicks] = React.useState<PickedTarget[]>([]);
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (open) setPicks([]);
  }, [open]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (picks.length === 0 || add.isPending) return;
    const sent = picks;
    add.mutate(
      { id: ruleId, targets: targetsToInput(sent) },
      {
        onSuccess: (r) => {
          const skipped = new Set(r.skippedIds);
          const added = sent.filter((t) => !skipped.has(t.id));
          const already = r.skippedIds.length;
          toast({
            title:
              r.added === 0 && already > 0
                ? "Already in this rule"
                : already > 0
                  ? `${r.added} added · ${already} already in it`
                  : `${r.added} added`,
            variant: "success",
            duration: UNDO_VISIBLE_MS,
            ...(added.length > 0
              ? {
                  action: {
                    label: "Undo",
                    onClick: () =>
                      undo.mutate(
                        { id: ruleId, targets: targetsToInput(added), reason: UNDO_ADD_REASON },
                        { onSuccess: () => toast({ title: "Undone", variant: "success" }) },
                      ),
                  },
                }
              : {}),
          });
          onClose();
        },
        onError: (err) => {
          if (ruleErrorCode(err) === API_ERROR_CODES.RULE_NOT_EDITABLE) onClose();
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add products"
      description="Search for products or pick a label. A family includes all its variants, now and later."
      className="max-h-[92vh] overflow-y-auto"
      onOpenAutoFocus={(e) => {
        returnFocusTo.current = document.activeElement as HTMLElement | null;
        // The dialog is for searching: start typing at once.
        if (searchRef.current) {
          e.preventDefault();
          searchRef.current.focus();
        }
      }}
      onCloseAutoFocus={(e) => {
        const el = returnFocusTo.current;
        returnFocusTo.current = null;
        if (el && el.isConnected && el !== document.body) {
          e.preventDefault();
          el.focus();
        }
      }}
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <RuleTargetPicker
          value={picks}
          onChange={setPicks}
          searchRef={searchRef}
          lockedProductIds={lockedProductIds}
          lockedCategoryIds={lockedCategoryIds}
        />
        <div className="flex justify-end gap-3 border-t border-surface-border pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={picks.length === 0} loading={add.isPending}>
            {picks.length > 0 ? `Add ${picks.length}` : "Add"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
