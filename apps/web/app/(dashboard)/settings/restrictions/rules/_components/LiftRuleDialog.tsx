"use client";

import * as React from "react";
import { Button, Modal, Textarea, useToast } from "@routeflow/ui/web";
import { REASON_MAX } from "@/lib/restriction-rule-form";
import { useLiftRestriction } from "@/lib/api/restrictions-admin-write";
import type { SellingRestrictionListItemDto } from "@/lib/api/restrictions-admin";
import { ruleCardTarget } from "@/lib/rule-targets";

/** "Hemp will" for one target, "The 12 products and labels in this rule will" for many. */
function liftSubject(rule: SellingRestrictionListItemDto): string {
  const t = ruleCardTarget(rule);
  return t.total !== null && t.total > 1
    ? `The ${t.total} products and labels in this rule will`
    : `${t.name} will`;
}

/**
 * Lift-rule dialog (Lane R step 5b-3): ends a rule now, with a reason for the audit trail. A server
 * refusal ("already been lifted") reaches the user through the app's one global toast; the dialog
 * adds no second message and stays open.
 */
export function LiftRuleDialog({
  rule,
  onClose,
}: {
  rule: SellingRestrictionListItemDto | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const lift = useLiftRestriction();
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState("");
  // Opened from a card button, not a Radix trigger, so focus would fall to <body> on close: keep the
  // opener and give focus back (the BlockedLinesDialog pattern).
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    setReason("");
    setError("");
  }, [rule?.id]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!rule) return;
    const trimmed = reason.trim();
    if (!trimmed) return setError("Add a reason");
    if (trimmed.length > REASON_MAX)
      return setError(`Keep the reason under ${REASON_MAX} characters`);
    setError("");
    lift.mutate(
      { id: rule.id, reason: trimmed },
      {
        onSuccess: () => {
          toast({ title: "Rule lifted", variant: "success" });
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open={!!rule}
      onClose={onClose}
      scroll
      onOpenAutoFocus={() => {
        returnFocusTo.current = document.activeElement as HTMLElement | null;
      }}
      onCloseAutoFocus={(e) => {
        const el = returnFocusTo.current;
        returnFocusTo.current = null;
        if (el && el.isConnected && el !== document.body) {
          e.preventDefault();
          el.focus();
        }
      }}
      title="Lift this rule?"
      description={
        rule
          ? `${liftSubject(rule)} stop being restricted straight away. This can't be undone; add a new rule to restrict ${(ruleCardTarget(rule).total ?? 1) > 1 ? "them" : "it"} again.`
          : undefined
      }
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <Textarea
          label="Reason"
          rows={3}
          maxLength={REASON_MAX + 50}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={error}
        />
        <div className="flex justify-end gap-3 border-t border-surface-border pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={lift.isPending}>
            Lift rule
          </Button>
        </div>
      </form>
    </Modal>
  );
}
