"use client";

import * as React from "react";
import type { CustomerChange, FollowerRow, PricePlan, PriceTier } from "@routeflow/pricing";
import { formatMoney } from "@/lib/format";
import { PLAN_TESTIDS as T } from "./plan-testids";
import { customerKeepKey, followerKey, type PlanSelection } from "./selection";

export interface PlanViewProps {
  plan: PricePlan;
  selection: PlanSelection;
  onToggleOffer: (index: number, on: boolean) => void;
  onToggleKeep: (follower: FollowerRow, on: boolean) => void;
  onToggleCustomerKeep?: (change: CustomerChange, on: boolean) => void;
  heading?: string;
  tierName: (tier: PriceTier) => string;
  customerName: (customerId: string) => string;
  hideFollowers?: boolean;
  extraOffers?: React.ReactNode;
  /** The server capped the customers it sent (K3b NIT-3): the Also update section says so. */
  customersTruncated?: boolean;
}

// V02 / SA-799: the one "this also changes / also update" panel. It renders a PricePlan and nothing else, so
// there is no money math here. Offers start unticked, and no row is hidden: rounding moves sit in a <details>.

const SECTION_LABEL = "text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70";
const AGAINST = "border-l-4 border-warning bg-warning-bg pl-2";

function Diff({ from, to }: { from: number; to: number }) {
  return (
    <span className="tabular-nums">
      <span className="text-ink-500 line-through">{formatMoney(from)}</span>{" "}
      <span className="font-medium text-navy">{formatMoney(to)}</span>
    </span>
  );
}

interface RowProps {
  testId: string;
  name: string;
  from: number;
  to: number;
  kept: boolean;
  against?: boolean;
  onKeep?: (on: boolean) => void;
  why?: string;
}
interface Row {
  key: string;
  rounding: boolean;
  props: RowProps;
}

function ChangeRow({ testId, name, from, to, kept, against, onKeep, why }: RowProps) {
  return (
    <li
      data-testid={testId}
      data-against={against ? "true" : "false"}
      className={`py-1.5 ${against ? AGAINST : ""}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 text-sm text-navy">{name}</span>
        {kept ? (
          <span className="text-xs text-ink-500">Kept as set</span>
        ) : (
          <Diff from={from} to={to} />
        )}
        {onKeep && (
          <label className="flex items-center gap-1.5 text-xs text-ink-500">
            <input
              type="checkbox"
              checked={kept}
              onChange={(e) => onKeep(e.target.checked)}
              aria-label={`Keep ${name} at ${formatMoney(from)}`}
            />
            Keep {formatMoney(from)}
          </label>
        )}
      </div>
      {why && <p className="mt-0.5 text-xs text-ink-500">{why}</p>}
    </li>
  );
}

// The API sends at most 500 customers with their own prices (CUSTOMER_PRICES_CAP) and says `truncated` past that.
const TRUNCATED_NOTE =
  "Showing the first 500 customers with their own prices. Others aren't included.";

const WHY = {
  rounding: "Rounding to the cent moves it the other way from your change.",
  shape: "It is worked out from a price that does not move the same way.",
};

export function PlanView({
  plan,
  selection,
  onToggleOffer,
  onToggleKeep,
  onToggleCustomerKeep,
  heading,
  tierName,
  customerName,
  hideFollowers = false,
  extraOffers,
  customersTruncated = false,
}: PlanViewProps) {
  const headingId = React.useId();
  const unitLabel = (ref: string) => plan.view.rows.find((r) => r.ref === ref)?.label ?? ref;
  const rows: Row[] = [
    ...(hideFollowers ? [] : plan.followers).map((f) => ({
      key: `f:${followerKey(f)}`,
      rounding: false,
      props: {
        testId: T.followerRow,
        name: `${tierName(f.tier)} ${f.label}`,
        from: f.from,
        to: f.to,
        kept: selection.keeps.has(followerKey(f)),
        onKeep: (on: boolean) => onToggleKeep(f, on),
      },
    })),
    ...plan.customerChanges.map((c) => ({
      key: `c:${customerKeepKey(c)}`,
      rounding: c.against && c.cause === "rounding",
      props: {
        testId: T.customerRow,
        name: `${customerName(c.customerId)}, ${unitLabel(c.ref)}`,
        from: c.from,
        to: c.to,
        against: c.against,
        kept: selection.customerKeeps.has(customerKeepKey(c)),
        onKeep:
          c.against && onToggleCustomerKeep
            ? (on: boolean) => onToggleCustomerKeep(c, on)
            : undefined,
        why: c.against ? WHY[c.cause] : undefined,
      },
    })),
  ];
  const rounding = rows.filter((r) => r.rounding);
  const againstCount = rows.filter((r) => r.props.against).length;
  const list = (items: Row[]) => (
    <ul className="divide-y divide-surface-border">
      {items.map((r) => (
        <ChangeRow key={r.key} {...r.props} />
      ))}
    </ul>
  );
  const hasAlso = plan.offers.length > 0 || extraOffers != null;

  return (
    <section
      data-testid={T.cellPlan}
      role="region"
      aria-labelledby={headingId}
      className="rounded-lg border border-l-4 border-surface-border border-l-accent bg-white p-3"
    >
      <h4 id={headingId} className={heading ? "text-sm font-semibold text-navy" : "sr-only"}>
        {heading ?? "What else changes"}
      </h4>
      {plan.problems.map((p) => (
        <p key={p} role="alert" className="mt-1 text-sm text-danger">
          {p}
        </p>
      ))}
      {rows.length > 0 && (
        <div data-testid={T.alsoChanges} className="mt-2">
          <p className={SECTION_LABEL}>This also changes:</p>
          {againstCount > 0 && (
            <p data-testid={T.againstSummary} className="mt-1 text-xs text-ink-500">
              {againstCount} {againstCount === 1 ? "price moves" : "prices move"} the other way
              {rounding.length > 0 && `: ${rounding.length} from rounding`}.
            </p>
          )}
          {list(rows.filter((r) => !r.rounding))}
          {rounding.length > 0 && (
            <details data-testid={T.roundingGroup} className="mt-1">
              <summary className="cursor-pointer text-xs text-ink-500">
                {rounding.length} {rounding.length === 1 ? "price moves" : "prices move"} 1 cent
                from rounding
              </summary>
              {list(rounding)}
            </details>
          )}
        </div>
      )}
      {hasAlso && (
        <div data-testid={T.alsoUpdate} className="mt-3">
          <p className={SECTION_LABEL}>Also update:</p>
          {customersTruncated && (
            <p data-testid={T.customersTruncated} className="mt-1 text-xs text-ink-500">
              {TRUNCATED_NOTE}
            </p>
          )}
          {extraOffers}
          <ul>
            {plan.offers.map((o, i) => {
              return (
                <li key={i} className="py-1.5">
                  <label className="flex items-start gap-2 text-sm text-navy">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={selection.ticked[i] === true}
                      onChange={(e) => onToggleOffer(i, e.target.checked)}
                    />
                    <span>
                      {o.title}
                      {o.kind === "tier" && (
                        <span className="block text-xs text-ink-500">{o.warning}</span>
                      )}
                    </span>
                  </label>
                  {o.kind === "customer" && (
                    <>
                      <p className="ml-6 text-xs text-ink-500">
                        Off by default. Their set prices stay as they are unless you tick this.
                      </p>
                      <ul className="ml-6 mt-1 text-xs text-ink-500">
                        {o.moves.map((m) => (
                          <li
                            key={`${m.customerId}|${m.ref}|${m.tier}`}
                            data-testid={T.offerMove}
                            data-against={m.against ? "true" : "false"}
                            className={`py-0.5 ${m.against ? AGAINST : ""}`}
                          >
                            <div className="flex gap-3">
                              <span className="flex-1">
                                {customerName(m.customerId)}, {unitLabel(m.ref)}
                                {m.tier === 1 ? "" : `, ${tierName(m.tier)}`}
                              </span>
                              <Diff from={m.from} to={m.to} />
                            </div>
                            {m.against && <p>{WHY[m.cause ?? "shape"]}</p>}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {rows.length === 0 && !hasAlso && plan.problems.length === 0 && (
        <p className="mt-2 text-sm text-ink-500">Nothing else changes.</p>
      )}
    </section>
  );
}
