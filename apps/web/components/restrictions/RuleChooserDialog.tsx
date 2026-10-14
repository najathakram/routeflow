"use client";

import * as React from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Modal, cn, useToast } from "@routeflow/ui/web";
import type { SellingRestrictionListItemDto } from "@routeflow/types";
import { useAuth } from "@/lib/auth-context";
import { WriteButton } from "@/lib/read-only-gate";
import { useRestrictionRules } from "@/lib/api/restrictions-admin";
import {
  addRuleTargetsRequest,
  removeRuleTargetsRequest,
  ruleErrorOf,
  useAddToRule,
  useRemoveFromRule,
  useRulesHolding,
} from "@/lib/api/rule-targets";
import { UNDO_VISIBLE_MS } from "@/lib/portal-limits";
import {
  ALREADY_IN_RULE,
  FEDERAL_ADMIN_ONLY,
  RESTRICT_MAX,
  RESTRICT_SAVE_FAILED,
  RESTRICT_TOO_MANY,
  RESTRICT_UNDO_FAILED,
  UNDO_ADD_REASON,
  addedTitle,
  chooserTitle,
  confirmButton,
  confirmTitle,
  needsATargetText,
  previewText,
  removedTitle,
  ruleHref,
  ruleLabel,
  ruleSentence,
  targetLimitText,
} from "@/lib/rule-chooser";
import { stateName } from "@/lib/restriction-rules";

/**
 * "Add to a rule…" / "Remove from a rule…" (row 509 PR5): pick a rule, confirm the count, done. Add mode lists the
 * ACTIVE and SCHEDULED rules; remove mode lists only the rules that directly hold some of the products ("holds 5 of
 * your 8"). Success toasts with Undo (the inverse call) and View rule. An all-customer rule is admin-only both ways
 * (owner L5), so it is shown but disabled, with the reason, for an operator.
 */

interface Row {
  rule: SellingRestrictionListItemDto;
  /** Remove mode: how many of the selected products the rule holds directly. */
  holds?: number;
}
interface Source {
  loading: boolean;
  error: boolean;
  rows: Row[];
}

const LIVE = new Set(["ACTIVE", "SCHEDULED"]);

function AddSource({ children }: { children: (s: Source) => React.ReactNode }) {
  const q = useRestrictionRules();
  const rows = React.useMemo(
    () => (q.data ?? []).filter((r) => LIVE.has(r.status)).map((rule) => ({ rule })),
    [q.data],
  );
  return <>{children({ loading: q.isLoading, error: q.isError, rows })}</>;
}

function RemoveSource({
  productIds,
  children,
}: {
  productIds: string[];
  children: (s: Source) => React.ReactNode;
}) {
  const q = useRulesHolding(productIds);
  const rows = React.useMemo(
    () => (q.data ?? []).map((i) => ({ rule: i.rule, holds: i.holds })),
    [q.data],
  );
  return <>{children({ loading: q.isLoading, error: q.isError, rows })}</>;
}

export function RuleChooserDialog({
  open,
  ...rest
}: {
  open: boolean;
  mode: "add" | "remove";
  productIds: string[];
  onClose: () => void;
  /** Runs after a successful write (the catalog clears its selection). */
  onDone?: () => void;
  /** Rules that already hold the products, shown disabled (the product page passes its own rules). */
  alreadyInRuleIds?: readonly string[];
}) {
  // Mounted only while open, so a reopened dialog starts at the list with an empty search.
  return open ? <Chooser {...rest} /> : null;
}

function Chooser({
  mode,
  productIds,
  onClose,
  onDone,
  alreadyInRuleIds,
}: {
  mode: "add" | "remove";
  productIds: string[];
  onClose: () => void;
  onDone?: () => void;
  alreadyInRuleIds?: readonly string[];
}) {
  const role = useAuth().user?.role;
  const isAdmin = role === "TENANT_ADMIN";
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();
  const add = useAddToRule();
  const remove = useRemoveFromRule();
  const [q, setQ] = React.useState("");
  const [chosen, setChosen] = React.useState<Row | null>(null);
  const [error, setError] = React.useState<React.ReactNode>(null);
  const n = productIds.length;
  const tooMany = n > RESTRICT_MAX;
  const already = new Set(alreadyInRuleIds ?? []);
  const pending = add.isPending || remove.isPending;

  const disabledReason = (r: SellingRestrictionListItemDto): string | null => {
    if (r.jurisdiction === "FEDERAL" && !isAdmin) return FEDERAL_ADMIN_ONLY;
    if (already.has(r.id)) return ALREADY_IN_RULE;
    return null;
  };

  const failure = (err: unknown, rule: SellingRestrictionListItemDto): React.ReactNode => {
    const { status, code, field, max } = ruleErrorOf(err);
    const label = ruleLabel(rule);
    if (code === "RULE_NEEDS_A_TARGET")
      return (
        <>
          <span>{needsATargetText(label)}</span>{" "}
          <NextLink href={ruleHref(rule.id)} className="font-medium underline">
            Go to the rule
          </NextLink>
        </>
      );
    if (code === "RULE_TARGET_LIMIT") return targetLimitText(field, max, label);
    if (code === "RULE_NOT_EDITABLE")
      return `“${label}” was lifted or has ended. Pick another rule.`;
    if (code === "RULE_TARGETS_NOT_FOUND")
      return "Some of these products no longer exist. Refresh the list and try again.";
    if (status === 403)
      return rule.jurisdiction === "FEDERAL"
        ? FEDERAL_ADMIN_ONLY
        : "You don't have permission to change this rule.";
    return RESTRICT_SAVE_FAILED;
  };

  const viewRule = (id: string) => ({
    label: "View rule",
    onClick: () => router.push(ruleHref(id)),
  });
  // The toast's Undo outlives this dialog, so it is a plain call + a cache refresh, not a hook callback.
  const undo = (run: () => Promise<unknown>) => () => {
    run()
      .then(() => {
        qc.invalidateQueries({ queryKey: ["selling-restrictions"] });
        toast({ title: "Undone", variant: "success" });
      })
      .catch(() => toast({ title: RESTRICT_UNDO_FAILED, variant: "error" }));
  };

  const confirm = () => {
    if (!chosen || pending) return;
    const rule = chosen.rule;
    setError(null);
    if (mode === "add") {
      add.mutate(
        { ruleId: rule.id, productIds },
        {
          onSuccess: (res) => {
            const skipped = new Set(res.skippedIds ?? []);
            const addedIds = productIds.filter((id) => !skipped.has(id));
            toast({
              title: addedTitle(res.added, skipped.size, n),
              variant: "success",
              duration: UNDO_VISIBLE_MS,
              secondaryAction: viewRule(rule.id),
              ...(res.added > 0
                ? {
                    action: {
                      label: "Undo",
                      onClick: undo(() =>
                        removeRuleTargetsRequest(rule.id, {
                          productIds: addedIds,
                          reason: UNDO_ADD_REASON,
                        }),
                      ),
                    },
                  }
                : {}),
            });
            onDone?.();
            onClose();
          },
          onError: (err) => setError(failure(err, rule)),
        },
      );
      return;
    }
    remove.mutate(
      { ruleId: rule.id, productIds },
      {
        onSuccess: (res) => {
          const notIn = new Set(res.notInRule ?? []);
          const removedIds = productIds.filter((id) => !notIn.has(id));
          toast({
            title: removedTitle(res.removed),
            variant: "success",
            duration: UNDO_VISIBLE_MS,
            secondaryAction: viewRule(rule.id),
            ...(res.removed > 0
              ? {
                  action: {
                    label: "Undo",
                    onClick: undo(() => addRuleTargetsRequest(rule.id, { productIds: removedIds })),
                  },
                }
              : {}),
          });
          onDone?.();
          onClose();
        },
        onError: (err) => setError(failure(err, rule)),
      },
    );
  };

  const needle = q.trim().toLowerCase();
  const matches = (r: SellingRestrictionListItemDto) =>
    !needle ||
    [
      ruleLabel(r),
      ruleSentence(r),
      previewText(r) ?? "",
      ...r.states.map((s) => stateName(s.toUpperCase())),
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle);

  const holdsText = (holds: number) =>
    n === 1 ? "holds this product" : `holds ${holds} of your ${n}`;

  const list = (src: Source) => {
    if (src.loading) return <p className="text-sm text-navy/60">Loading rules…</p>;
    if (src.error)
      return (
        <p role="alert" className="text-sm text-danger">
          Couldn&apos;t load the rules. Close this and try again.
        </p>
      );
    if (src.rows.length === 0)
      return (
        <p className="text-sm text-navy/70">
          {mode === "add"
            ? "No active rules yet. Start one with “New rule…”."
            : "None of these products is in a rule on its own."}
        </p>
      );
    const shown = src.rows.filter((row) => matches(row.rule));
    if (shown.length === 0)
      return <p className="text-sm text-navy/70">No rule matches “{q.trim()}”.</p>;
    return (
      <ul className="space-y-2" aria-label="Rules">
        {shown.map((row) => {
          const why = disabledReason(row.rule);
          const preview = previewText(row.rule);
          const reasonId = `rule-why-${row.rule.id}`;
          return (
            <li key={row.rule.id}>
              <button
                type="button"
                disabled={!!why}
                aria-describedby={why ? reasonId : undefined}
                onClick={() => setChosen(row)}
                className={cn(
                  "block min-h-11 w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-left",
                  "hover:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                  "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-surface-border",
                )}
              >
                <span className="block break-words text-sm font-medium text-navy">
                  {ruleLabel(row.rule)}
                </span>
                <span className="block text-xs text-navy/80">{ruleSentence(row.rule)}</span>
                {row.holds !== undefined && (
                  <span className="block text-xs font-medium text-brand-700">
                    {holdsText(row.holds)}
                  </span>
                )}
                {preview && <span className="block text-xs text-navy/60">{preview}</span>}
              </button>
              {why && (
                <p id={reasonId} className="mt-1 px-1 text-xs text-navy/70">
                  {why}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    );
  };

  const confirmCount = mode === "remove" ? (chosen?.holds ?? n) : n;

  return (
    <Modal
      open
      onClose={onClose}
      title={chooserTitle(mode, n)}
      scroll
      footer={
        chosen ? (
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setChosen(null);
                setError(null);
              }}
            >
              Back
            </Button>
            <WriteButton type="button" loading={pending} onClick={confirm}>
              {confirmButton(mode, confirmCount)}
            </WriteButton>
          </>
        ) : (
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        )
      }
    >
      <div className="space-y-3" data-testid="rule-chooser">
        {tooMany && (
          <p role="alert" className="text-sm text-danger">
            {RESTRICT_TOO_MANY}
          </p>
        )}
        {chosen ? (
          <div className="space-y-2" aria-live="polite">
            <p className="text-sm font-semibold text-navy">
              {confirmTitle(mode, confirmCount, ruleLabel(chosen.rule))}
            </p>
            <p className="text-sm text-navy/80">{ruleSentence(chosen.rule)}</p>
            {mode === "remove" && chosen.holds !== undefined && (
              <p className="text-xs text-navy/70">{holdsText(chosen.holds)}</p>
            )}
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
          </div>
        ) : (
          <>
            <input
              type="search"
              aria-label="Search rules"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search rules, states or products"
              className="h-11 w-full rounded border border-surface-border px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 sm:h-10"
            />
            {tooMany ? null : mode === "add" ? (
              <AddSource>{list}</AddSource>
            ) : (
              <RemoveSource productIds={productIds}>{list}</RemoveSource>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
