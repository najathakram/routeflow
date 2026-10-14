"use client";

import * as React from "react";
import NextLink from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { API_ERROR_CODES, ruleEditImpactCopy } from "@routeflow/types";
import type {
  RuleChangeDirection,
  RuleChangeField,
  RuleEditPreviewResponse,
  RuleEditRequest,
  SellingRestrictionListItemDto,
} from "@routeflow/types";
import { Button, Modal, Textarea, useToast } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { useEditRule, useRuleEditPreview } from "@/lib/api/restrictions-admin-write";
import {
  ruleSettingsSchema,
  ruleToFormValues,
  toEditRequest,
  type RuleFormValues,
} from "@/lib/restriction-rule-form";
import { ADMIN_ONLY_FEDERAL_NOTE } from "@/lib/restriction-rules";
import { RULE_ERROR_COPY, ruleErrorCode } from "@/lib/restriction-rule-errors";
import { RuleSettingsFields, type RuleFormErrors } from "./RuleSettingsFields";

type EditableRule = Pick<
  SellingRestrictionListItemDto,
  "id" | "jurisdiction" | "states" | "surface" | "effectiveFrom" | "effectiveTo" | "reason"
>;

const FIELD_LABEL: Record<RuleChangeField, string> = {
  states: "States",
  jurisdiction: "Where",
  surface: "Sold through",
  window: "Dates",
  reason: "Reason",
};
const DIRECTION: Record<RuleChangeDirection, { text: string; className: string }> = {
  TIGHTENS: { text: "Tightens", className: "bg-danger-bg text-danger" },
  LOOSENS: { text: "Loosens", className: "bg-warning-bg text-navy" },
  NEUTRAL: { text: "No effect on sales", className: "bg-surface-raised text-navy/70" },
};
export const NOTE_MAX = 500;

/**
 * Edit a rule's settings in place (row 509 PR3, owner Q4). The targets are not here (they have their
 * own add / remove). Save never writes: it asks the server what the change does (which fields
 * tighten or loosen the rule, how many open orders it newly reaches), shows that, and only
 * "Confirm change" commits, carrying the revision and impact hash it was shown. A stale revision
 * says "someone changed this rule" with a Reload; a changed impact re-previews by itself.
 */
export function EditRuleDialog({
  rule,
  open,
  onClose,
}: {
  rule: EditableRule;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const preview = useRuleEditPreview();
  const edit = useEditRule();
  // Operators are near-admins, but making a rule apply everywhere is the account admin's (owner L5).
  const role = useAuth().user?.role;
  const isAdmin = role === "TENANT_ADMIN" || role === "SUPER_ADMIN";
  const [v, setV] = React.useState<RuleFormValues>(() => ruleToFormValues(rule));
  const [note, setNote] = React.useState("");
  const [errors, setErrors] = React.useState<RuleFormErrors>({});
  const [review, setReview] = React.useState<{
    body: RuleEditRequest;
    preview: RuleEditPreviewResponse;
  } | null>(null);
  const [stale, setStale] = React.useState(false);
  const [impactChanged, setImpactChanged] = React.useState(false);
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const reviewHeading = React.useRef<HTMLHeadingElement>(null);

  // The form's Save button is gone once the review shows, and a fresh preview (after the impact moved)
  // replaces the numbers: start the keyboard / screen-reader user at the heading each time.
  React.useEffect(() => {
    if (review) reviewHeading.current?.focus();
  }, [review]);

  const set = <K extends keyof RuleFormValues>(k: K, val: RuleFormValues[K]) => {
    setV((p) => ({ ...p, [k]: val }));
    setErrors((e) => (e[k] ? { ...e, [k]: undefined } : e));
  };

  React.useEffect(() => {
    if (open) {
      setV(ruleToFormValues(rule));
      setNote("");
      setErrors({});
      setReview(null);
      setStale(false);
      setImpactChanged(false);
    }
    // Re-seed on open only: a background refetch of the rule must not wipe what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = ruleSettingsSchema.safeParse(v);
    if (!parsed.success) {
      const next: RuleFormErrors = {};
      for (const i of parsed.error.issues) next[i.path[0] as keyof RuleFormValues] ??= i.message;
      setErrors(next);
      return;
    }
    setErrors({});
    const body = toEditRequest(v, rule, note);
    preview.mutate({ id: rule.id, body }, { onSuccess: (p) => setReview({ body, preview: p }) });
  };

  const confirm = () => {
    if (!review) return;
    const { body, preview: p } = review;
    edit.mutate(
      {
        id: rule.id,
        body: { ...body, expectedRevision: p.revision, confirmImpactHash: p.impactHash },
      },
      {
        onSuccess: () => {
          toast({ title: "Rule updated", variant: "success" });
          onClose();
        },
        onError: (err) => {
          const code = ruleErrorCode(err);
          if (code === API_ERROR_CODES.RULE_STALE) setStale(true);
          else if (code === API_ERROR_CODES.RULE_IMPACT_CHANGED) {
            // The orders this change reaches moved since the preview: look again, show the new number.
            preview.mutate(
              { id: rule.id, body },
              {
                onSuccess: (fresh) => {
                  setReview({ body, preview: fresh });
                  setImpactChanged(true);
                },
              },
            );
          } else if (code === API_ERROR_CODES.RULE_NOT_EDITABLE) onClose();
        },
      },
    );
  };

  const reload = () => {
    void qc.invalidateQueries({ queryKey: ["selling-restrictions"] });
    onClose();
  };

  const impactCount = review ? review.preview.impact.openOrders + review.preview.impact.drafts : 0;
  // SA: the scan is bounded, never the edit. Capped = counting stopped at the cap (a lower bound).
  const impactCapped = review?.preview.impact.capped === true;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit rule settings"
      description="Change where, when or why this rule applies. Its products and labels are edited on the page."
      className="max-h-[92vh] overflow-y-auto"
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
    >
      {review ? (
        <div className="space-y-4">
          <h3
            ref={reviewHeading}
            tabIndex={-1}
            className="text-sm font-semibold text-navy focus:outline-none"
          >
            Review this change
          </h3>
          {review.preview.changes.length === 0 ? (
            <p className="text-sm text-navy/80">Nothing changed.</p>
          ) : (
            <ul aria-label="What changes" className="space-y-1.5">
              {review.preview.changes.map((c) => (
                <li key={c.field} className="flex flex-wrap items-center gap-2 text-sm text-navy">
                  <span className="font-medium">{FIELD_LABEL[c.field] ?? c.field}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${DIRECTION[c.direction].className}`}
                  >
                    {DIRECTION[c.direction].text}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {impactChanged && (
            <p role="status" className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-navy/80">
              The open orders this change affects have changed.
            </p>
          )}
          {review.preview.changes.length > 0 && (
            <div className="space-y-1">
              <p className="text-sm text-navy/80">
                {impactCapped
                  ? ruleEditImpactCopy(impactCount, true)
                  : impactCount > 0
                    ? ruleEditImpactCopy(impactCount)
                    : "No open orders are affected."}
              </p>
              {(impactCount > 0 || impactCapped) && (
                <NextLink href="/orders" className="text-sm font-medium text-navy underline">
                  View open orders
                </NextLink>
              )}
            </div>
          )}

          {stale && (
            <div role="alert" className="space-y-2 rounded-lg bg-warning-bg px-3 py-2 text-sm">
              <p className="text-navy/80">{RULE_ERROR_COPY.RULE_STALE}</p>
              <Button type="button" size="sm" variant="secondary" onClick={reload}>
                Reload
              </Button>
            </div>
          )}

          <div className="flex justify-end gap-3 border-t border-surface-border pt-4">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setReview(null);
                setImpactChanged(false);
              }}
            >
              Back
            </Button>
            {!stale && review.preview.changes.length > 0 && (
              <Button type="button" loading={edit.isPending || preview.isPending} onClick={confirm}>
                Confirm change
              </Button>
            )}
          </div>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-4">
          <RuleSettingsFields
            v={v}
            set={set}
            errors={errors}
            federalNote={isAdmin ? undefined : ADMIN_ONLY_FEDERAL_NOTE}
          />
          <Textarea
            label="Note (optional)"
            rows={2}
            maxLength={NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex justify-end gap-3 border-t border-surface-border pt-4">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={preview.isPending}>
              Save
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
