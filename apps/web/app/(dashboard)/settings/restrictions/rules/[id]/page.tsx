"use client";

import * as React from "react";
import NextLink from "next/link";
import { useParams } from "next/navigation";
import { useQueries } from "@tanstack/react-query";
import { API_ERROR_CODES } from "@routeflow/types";
import type { RuleDetailDto, RuleTargetDto } from "@routeflow/types";
import { Badge, Button, Card, Skeleton, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useAuth } from "@/lib/auth-context";
import { fetchRuleDetail, restrictionRuleKey, useRuleDetail } from "@/lib/api/restrictions-admin";
import { useAddRuleTargets, useRemoveRuleTargets } from "@/lib/api/restrictions-admin-write";
import { ruleErrorCode } from "@/lib/restriction-rule-errors";
import { fmtDate } from "@/lib/formatting";
import {
  STATUS_BADGE,
  jurisdictionText,
  ruleSentence,
  stateName,
  surfaceText,
  windowText,
} from "@/lib/restriction-rules";
import { ruleCardTarget, targetsToInput } from "@/lib/rule-targets";
import { ReadOnlyHint, WriteButton } from "@/lib/read-only-gate";
import { LiftLimitsDialog } from "@/components/portal-limits/LiftLimitsDialog";
import { LiftRuleDialog } from "../_components/LiftRuleDialog";
import { EditRuleDialog } from "../_components/EditRuleDialog";
import { AddTargetsDialog } from "./_components/AddTargetsDialog";
import { RemoveTargetsDialog } from "./_components/RemoveTargetsDialog";
import { RuleHistory } from "./_components/RuleHistory";

const LIST_HREF = "/settings/restrictions/rules";
const ROLE_HINT = "Only an account admin can change a rule that applies everywhere.";
const UNDO_VISIBLE_MS = 10_000;

/** Targets pages beyond the first: each "Show more" appends the previous page's cursor. */
function useMorePages(id: string, cursors: string[]) {
  return useQueries({
    queries: cursors.map((c) => ({
      queryKey: restrictionRuleKey(id, c),
      queryFn: () => fetchRuleDetail(id, c),
    })),
  });
}

export default function RuleDetailPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => setTitle("Portal limits & rules"), [setTitle]);
  const { toast } = useToast();
  const id = String(useParams<{ id: string }>()?.id ?? "");
  const role = useAuth().user?.role;
  const isAdmin = role === "TENANT_ADMIN";

  const first = useRuleDetail(id);
  const [cursors, setCursors] = React.useState<string[]>([]);
  const more = useMorePages(id, cursors);
  const add = useAddRuleTargets();
  const remove = useRemoveRuleTargets();

  const [search, setSearch] = React.useState("");
  const [selected, setSelected] = React.useState<Map<string, RuleTargetDto>>(new Map());
  const [adding, setAdding] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [guard, setGuard] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [lifting, setLifting] = React.useState(false);
  const [liftingMany, setLiftingMany] = React.useState(false);

  const rule = first.data;
  const pages: RuleDetailDto[] = [
    ...(rule ? [rule] : []),
    ...more.flatMap((q) => (q.data ? [q.data] : [])),
  ];
  const lastPage = pages[pages.length - 1];
  const nextCursor = lastPage?.nextCursor ?? null;
  const loadingMore = more.some((q) => q.isFetching && !q.data);
  const rows: RuleTargetDto[] = pages.flatMap((p) => p.targets);

  if (first.isLoading) {
    return (
      <div
        className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6"
        role="status"
        aria-label="Loading rule"
      >
        <Skeleton width="40%" height={20} />
        <Skeleton width="70%" />
        <Skeleton width="55%" />
      </div>
    );
  }
  if (first.isError || !rule) {
    const status = (first.error as { response?: { status?: number } } | null)?.response?.status;
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <BackLink />
        <Card className="space-y-3 p-4" role="alert">
          <p className="font-medium text-danger">
            {status === 404
              ? "This rule no longer exists."
              : status === 403
                ? "You don't have access to selling restrictions."
                : "Couldn't load this rule."}
          </p>
          {status !== 404 && status !== 403 && (
            <Button size="sm" variant="secondary" onClick={() => first.refetch()}>
              Try again
            </Button>
          )}
        </Card>
      </div>
    );
  }

  const editable = rule.status === "ACTIVE" || rule.status === "SCHEDULED";
  // Owner L5: a rule that hides products from ALL portal customers is the account admin's to change.
  const roleBlocked = rule.jurisdiction === "FEDERAL" && !isAdmin;
  const canChange = editable && !roleBlocked;
  const total = rule.targetSummary
    ? rule.targetSummary.products + rule.targetSummary.categories
    : rows.length;
  const heading = ruleCardTarget(rule);
  const badge = STATUS_BADGE[rule.status];

  const needle = search.trim().toLowerCase();
  const shown = needle
    ? rows.filter((t) => `${t.name} ${t.sku ?? ""}`.toLowerCase().includes(needle))
    : rows;
  const allShownSelected = shown.length > 0 && shown.every((t) => selected.has(t.id));

  const toggle = (t: RuleTargetDto) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(t.id)) next.delete(t.id);
      else next.set(t.id, t);
      return next;
    });
  const toggleAllShown = () =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (allShownSelected) for (const t of shown) next.delete(t.id);
      else for (const t of shown) next.set(t.id, t);
      return next;
    });

  const inputOf = (list: RuleTargetDto[]) =>
    targetsToInput(
      list.map((t) => ({
        kind: t.kind,
        id: (t.kind === "PRODUCT" ? t.productId : t.categoryId) ?? "",
        name: t.name,
      })),
    );

  const startRemove = () => {
    if (selected.size === 0) return;
    // Taking out everything would leave a rule that covers nothing: offer to lift it instead.
    if (selected.size >= total) setGuard(true);
    else setRemoving(true);
  };

  const confirmRemove = (reason: string) => {
    const sent = Array.from(selected.values());
    remove.mutate(
      { id, targets: inputOf(sent), reason },
      {
        onSuccess: (r) => {
          const gone = new Set(r.notInRule);
          const restore = sent.filter((t) => !gone.has(t.productId ?? t.categoryId ?? ""));
          setSelected(new Map());
          setRemoving(false);
          toast({
            title: `${r.removed} removed`,
            variant: "success",
            duration: UNDO_VISIBLE_MS,
            ...(restore.length > 0
              ? {
                  action: {
                    label: "Undo",
                    onClick: () =>
                      add.mutate(
                        { id, targets: inputOf(restore) },
                        { onSuccess: () => toast({ title: "Undone", variant: "success" }) },
                      ),
                  },
                }
              : {}),
          });
        },
        onError: (err) => {
          const code = ruleErrorCode(err);
          if (code === API_ERROR_CODES.RULE_NEEDS_A_TARGET) {
            setRemoving(false);
            setGuard(true);
          } else if (code === API_ERROR_CODES.RULE_NOT_EDITABLE) setRemoving(false);
        },
      },
    );
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      <BackLink />
      <ReadOnlyHint />

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h1 className="min-w-0 break-words text-lg font-semibold text-navy">{heading.name}</h1>
          <Badge variant={badge.variant} label={badge.label} />
        </div>
        <p className="text-sm text-navy/80">{ruleSentence(rule)}</p>
        {isAdmin && editable && (
          <div>
            <Button size="sm" variant="secondary" onClick={() => setLifting(true)}>
              Lift rule
            </Button>
          </div>
        )}
        {rule.liftedAt && (
          <div className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-navy/80">
            <p className="font-medium">
              Lifted {fmtDate(rule.liftedAt)}
              {rule.liftedByName ? ` by ${rule.liftedByName}` : ""}
            </p>
            {rule.liftReason && <p className="break-words">{rule.liftReason}</p>}
          </div>
        )}
      </Card>

      <section className="space-y-3" aria-labelledby="rule-targets-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="rule-targets-heading" className="text-base font-semibold text-navy">
            Products &amp; labels ({total})
          </h2>
          {editable && (
            <WriteButton disabled={roleBlocked} onClick={() => setAdding(true)}>
              Add products
            </WriteButton>
          )}
        </div>
        {roleBlocked && editable && <p className="text-xs text-navy/70">{ROLE_HINT}</p>}
        {!editable && (
          <p className="text-sm text-navy/70">
            This rule has ended, so its list can&apos;t be changed.
          </p>
        )}

        {canChange && selected.size > 0 && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2">
            <span className="text-sm font-medium text-navy">{selected.size} selected</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="min-h-11 text-sm text-navy/70 hover:text-navy sm:min-h-0"
                onClick={() => {
                  setSelected(new Map());
                  setGuard(false);
                }}
              >
                Clear
              </button>
              <WriteButton variant="secondary" onClick={startRemove}>
                Remove {selected.size}
              </WriteButton>
            </div>
          </div>
        )}

        {guard && (
          <div role="alert" className="space-y-2 rounded-lg bg-warning-bg px-4 py-3">
            <p className="text-sm font-medium text-navy">
              This rule would cover nothing. Lift the rule instead?
            </p>
            <div className="flex gap-3">
              <Button
                size="sm"
                onClick={() => {
                  setGuard(false);
                  if (isAdmin) setLifting(true);
                  else setLiftingMany(true);
                }}
              >
                Lift rule
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setGuard(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        <input
          type="search"
          aria-label="Search these products"
          placeholder="Search these products"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
          className="h-11 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 sm:h-10"
        />
        {needle && nextCursor && (
          <p className="text-xs text-navy/60">
            Searching the {rows.length} shown. Show more to search the rest.
          </p>
        )}

        {canChange && shown.length > 0 && (
          <label className="flex min-h-11 items-center gap-3 text-sm text-navy/80 sm:min-h-0">
            <input
              type="checkbox"
              className="h-5 w-5 sm:h-4 sm:w-4"
              aria-label="Select all shown"
              checked={allShownSelected}
              onChange={toggleAllShown}
            />
            Select all shown
          </label>
        )}

        {shown.length === 0 ? (
          <p className="text-sm text-navy/70">
            {needle ? "No products match your search" : "This rule has no products or labels."}
          </p>
        ) : (
          <ul
            aria-label="Products and labels in this rule"
            className="divide-y divide-surface-border rounded-lg border border-surface-border bg-white"
          >
            {shown.map((t) => (
              <TargetRow
                key={t.id}
                t={t}
                mode={canChange ? "select" : roleBlocked && editable ? "disabled" : "none"}
                selected={selected.has(t.id)}
                onToggle={() => toggle(t)}
              />
            ))}
          </ul>
        )}
        {nextCursor && (
          <Button
            variant="secondary"
            loading={loadingMore}
            onClick={() => setCursors((c) => [...c, nextCursor])}
          >
            Show more
          </Button>
        )}
      </section>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-navy">Settings</h2>
          {editable && (
            <WriteButton
              variant="secondary"
              disabled={roleBlocked}
              onClick={() => setEditing(true)}
            >
              Edit settings
            </WriteButton>
          )}
        </div>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-navy/60">Where</dt>
            <dd className="text-navy/80">
              {jurisdictionText(rule)}
              {rule.jurisdiction === "STATE" && rule.states.length > 0 && (
                <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Banned states">
                  {rule.states.map((code) => (
                    <li
                      key={code}
                      title={stateName(code)}
                      className="rounded-full bg-danger-bg px-2 py-0.5 text-xs font-semibold text-danger"
                    >
                      {code}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-navy/60">Applies to</dt>
            <dd className="text-navy/80">{surfaceText(rule.surface)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-navy/60">In effect</dt>
            <dd className="text-navy/80">{windowText(rule)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-navy/60">Added</dt>
            <dd className="text-navy/80">
              {fmtDate(rule.createdAt)}
              {rule.createdByName ? ` by ${rule.createdByName}` : ""}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs uppercase tracking-wide text-navy/60">Reason</dt>
            <dd className="break-words text-navy/80">{rule.reason}</dd>
          </div>
        </dl>
        {roleBlocked && editable && <p className="text-xs text-navy/70">{ROLE_HINT}</p>}
      </Card>

      <RuleHistory revisions={rule.revisions ?? []} events={rule.targetEvents ?? []} />

      <AddTargetsDialog
        ruleId={id}
        open={adding}
        onClose={() => setAdding(false)}
        lockedProductIds={rows.flatMap((t) => (t.productId ? [t.productId] : []))}
        lockedCategoryIds={rows.flatMap((t) => (t.categoryId ? [t.categoryId] : []))}
      />
      <RemoveTargetsDialog
        count={selected.size}
        open={removing}
        pending={remove.isPending}
        onClose={() => setRemoving(false)}
        onConfirm={confirmRemove}
      />
      {editing && <EditRuleDialog rule={rule} open onClose={() => setEditing(false)} />}
      {isAdmin && <LiftRuleDialog rule={lifting ? rule : null} onClose={() => setLifting(false)} />}
      {liftingMany && <LiftLimitsDialog ids={[id]} onClose={() => setLiftingMany(false)} />}
    </div>
  );
}

function BackLink() {
  return (
    <NextLink
      href={LIST_HREF}
      className="inline-flex min-h-11 items-center text-sm font-medium text-navy/70 hover:text-navy sm:min-h-0"
    >
      &larr; Portal limits &amp; rules
    </NextLink>
  );
}

function TargetRow({
  t,
  mode,
  selected,
  onToggle,
}: {
  t: RuleTargetDto;
  /** select: tickable; disabled: shown but locked (role gate); none: an ended rule has no ticks. */
  mode: "select" | "disabled" | "none";
  selected: boolean;
  onToggle: () => void;
}) {
  const body = (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="break-words font-medium text-navy">{t.name}</span>
        {t.sku && <span className="font-mono text-xs text-navy/60">{t.sku}</span>}
        {t.kind === "CATEGORY" && (
          <span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-navy/70">
            Label
          </span>
        )}
      </div>
      {t.isFamily && t.variantCount !== null && (
        <p className="text-xs text-navy/60">Includes all {t.variantCount} variants</p>
      )}
      <p className="text-xs text-navy/60">
        Added {fmtDate(t.addedAt)}
        {t.addedByName ? ` by ${t.addedByName}` : ""}
      </p>
    </div>
  );
  return (
    <li>
      {mode === "none" ? (
        <div className="flex min-h-11 items-start gap-3 px-3 py-2">{body}</div>
      ) : (
        <label
          className={`flex min-h-11 items-start gap-3 px-3 py-2 ${
            mode === "select" ? "cursor-pointer" : "cursor-not-allowed opacity-70"
          }`}
        >
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5 sm:h-4 sm:w-4"
            aria-label={`Select ${t.name}`}
            checked={selected}
            disabled={mode === "disabled"}
            onChange={onToggle}
          />
          {body}
        </label>
      )}
    </li>
  );
}
