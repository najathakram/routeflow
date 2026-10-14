"use client";

import * as React from "react";
import NextLink from "next/link";
import { Badge, Button, Card, EmptyState, PageHeader, Skeleton, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useAuth } from "@/lib/auth-context";
import {
  RULES_LIST_CAP,
  useRestrictionRules,
  type RestrictionStatus,
  type SellingRestrictionListItemDto,
} from "@/lib/api/restrictions-admin";
import { fmtDate } from "@/lib/formatting";
import {
  STATUS_BADGE,
  STATUS_FILTERS,
  emptyText,
  jurisdictionText,
  stateName,
  surfaceText,
  windowText,
} from "@/lib/restriction-rules";
import { ruleCardTarget } from "@/lib/rule-targets";
import { WriteButton } from "@/lib/read-only-gate";
import { LiftLimitsDialog } from "@/components/portal-limits/LiftLimitsDialog";
import { LiftRuleDialog } from "./_components/LiftRuleDialog";
import { RuleFormDialog } from "./_components/RuleFormDialog";

function RuleCard({
  rule,
  onLift,
  selected,
  onToggle,
}: {
  rule: SellingRestrictionListItemDto;
  onLift?: () => void;
  /** Present only for a rule that can still be lifted by this viewer. */
  selected?: boolean;
  onToggle?: () => void;
}) {
  const target = ruleCardTarget(rule);
  const detailHref = `/settings/restrictions/rules/${rule.id}`;
  const badge = STATUS_BADGE[rule.status];
  return (
    <Card className="space-y-3 p-4" data-testid="rule-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-3">
          {onToggle && (
            <input
              type="checkbox"
              className="mt-1 h-4 w-4"
              checked={!!selected}
              onChange={onToggle}
              aria-label={`Select the limit on ${target.name}`}
            />
          )}
          <div className="min-w-0">
            {target.total !== null ? (
              <NextLink
                href={detailHref}
                className="break-words font-semibold text-navy underline-offset-2 hover:underline"
              >
                {target.name}
              </NextLink>
            ) : (
              <p className="break-words font-semibold text-navy">{target.name}</p>
            )}
            {(target.kind ?? target.names) && (
              <p className="break-words text-xs text-navy/60">{target.kind ?? target.names}</p>
            )}
          </div>
        </div>
        <Badge variant={badge.variant} label={badge.label} />
      </div>

      <div className="space-y-1.5">
        <p className="text-sm text-navy/80">{jurisdictionText(rule)}</p>
        {rule.jurisdiction === "STATE" && rule.states.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Banned states">
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
      </div>

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-navy/60">Applies to</dt>
          <dd className="text-navy/80">{surfaceText(rule.surface)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-navy/60">In effect</dt>
          <dd className="text-navy/80">{windowText(rule)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs uppercase tracking-wide text-navy/60">Reason</dt>
          <dd className="break-words text-navy/80">{rule.reason}</dd>
        </div>
      </dl>

      <p className="text-xs text-navy/60">
        Added {fmtDate(rule.createdAt)}
        {rule.createdByName ? ` by ${rule.createdByName}` : ""}
      </p>

      {(target.total !== null ||
        (onLift && (rule.status === "ACTIVE" || rule.status === "SCHEDULED"))) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {onLift && (rule.status === "ACTIVE" || rule.status === "SCHEDULED") && (
            <Button size="sm" variant="secondary" onClick={onLift}>
              Lift rule
            </Button>
          )}
          {target.total !== null && (
            <NextLink
              href={detailHref}
              className="inline-flex min-h-11 items-center text-sm font-medium text-navy underline sm:min-h-0"
            >
              Products ({target.total})
            </NextLink>
          )}
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
  );
}

export default function RestrictionRulesPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => setTitle("Portal limits & rules"), [setTitle]);

  const role = useAuth().user?.role;
  const isAdmin = role === "TENANT_ADMIN";
  // Owner ruling 10-07: operators are near-admins and may lift portal limits (the server decides).
  const canLiftMany = isAdmin || role === "OPERATOR";
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [confirmLift, setConfirmLift] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [lifting, setLifting] = React.useState<SellingRestrictionListItemDto | null>(null);
  const [filter, setFilter] = React.useState<RestrictionStatus | "ALL">("ALL");
  const rules = useRestrictionRules(filter === "ALL" ? undefined : filter);
  const data = rules.data ?? [];
  const forbidden =
    (rules.error as { response?: { status?: number } } | null)?.response?.status === 403;

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Portal limits & rules"
        subtitle="What your portal customers can't see, and the rules that stop products being sold where they are banned."
        action={isAdmin ? <Button onClick={() => setCreating(true)}>New rule</Button> : undefined}
      />
      {isAdmin && creating && <RuleFormDialog open onClose={() => setCreating(false)} />}
      {isAdmin && <LiftRuleDialog rule={lifting} onClose={() => setLifting(null)} />}

      {canLiftMany && picked.size > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3">
          <span className="text-sm font-medium text-navy">{picked.size} selected</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="text-sm text-navy/70 hover:text-navy"
              onClick={() => setPicked(new Set())}
            >
              Clear
            </button>
            <WriteButton onClick={() => setConfirmLift(true)}>Lift {picked.size}</WriteButton>
          </div>
        </div>
      )}
      {confirmLift && (
        <LiftLimitsDialog
          ids={Array.from(picked)}
          onClose={() => setConfirmLift(false)}
          onDone={() => setPicked(new Set())}
        />
      )}

      <div role="group" aria-label="Filter rules by status" className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={filter === f.value}
            onClick={() => {
              setFilter(f.value);
              setPicked(new Set());
            }}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
              filter === f.value
                ? "border-brand-500 bg-brand-50 text-brand-600"
                : "border-surface-border bg-white text-navy/70 hover:border-brand-300",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {rules.isLoading ? (
        <div className="space-y-3" role="status" aria-label="Loading rules">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="space-y-3 p-4">
              <Skeleton width="40%" height={16} />
              <Skeleton width="70%" />
              <Skeleton width="55%" />
            </Card>
          ))}
        </div>
      ) : rules.isError ? (
        <Card className="space-y-3 p-4" role="alert">
          <p className="font-medium text-danger">
            {forbidden
              ? "You don't have access to selling restrictions."
              : "Couldn't load the rules."}
          </p>
          {!forbidden && (
            <Button size="sm" variant="secondary" onClick={() => rules.refetch()}>
              Try again
            </Button>
          )}
        </Card>
      ) : data.length === 0 ? (
        <EmptyState variant="data" {...emptyText(filter)} />
      ) : (
        <>
          {data.length >= RULES_LIST_CAP && (
            <p role="status" className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-navy/80">
              Showing the newest {RULES_LIST_CAP} rules. Use a status filter to see the rest.
            </p>
          )}
          <ul className="space-y-3" aria-label="Portal limits and rules">
            {data.map((r) => (
              <li key={r.id}>
                <RuleCard
                  rule={r}
                  onLift={isAdmin ? () => setLifting(r) : undefined}
                  selected={picked.has(r.id)}
                  onToggle={
                    canLiftMany && (r.status === "ACTIVE" || r.status === "SCHEDULED")
                      ? () =>
                          setPicked((prev) => {
                            const next = new Set(prev);
                            if (next.has(r.id)) next.delete(r.id);
                            else next.add(r.id);
                            return next;
                          })
                      : undefined
                  }
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
