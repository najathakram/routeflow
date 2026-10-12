"use client";

import * as React from "react";
import { roundMoney } from "@routeflow/pricing";
import { cn } from "@routeflow/ui/web";
import { fmt } from "@/lib/formatting";

/**
 * The customer's credit-limit panel (D6 / B462 + B576).
 *
 * `creditExposure` is EXACTLY what the server's hard credit-limit block is checked against
 * (`getStatementForOperator`: open/delivered invoices and orders, each counted once), so the
 * bar can never disagree with the 409 an operator hits. `pendingExposure` is the balance of
 * DRAFT invoices with NO open or delivered order behind them (standalone / quote / bank-import
 * drafts — owner ruling D6: an unissued standalone draft is not a receivable) — shown, never
 * added into the bar. A draft on a real order still counts in the bar.
 *
 * B576: this panel used to read `customer.receivables`, a field `GET /customers/:id` never
 * returns, so the bar always read $0.00. It now reads the statement. While the statement is
 * loading (or an older API omits the field) the figure is "—", never a misleading $0.00; if the
 * statement request FAILS it says so instead of looking like it is still loading.
 *
 * Renders NOTHING when the customer has no credit limit configured (null). A limit of exactly 0 is a real
 * limit and renders with an explicit "$0.00 limit" line (B1032).
 */
export interface CreditLimitPanelProps {
  /** `Customer.creditLimit` — null / absent (or negative) means no limit, so no panel; 0 is a real $0 limit. */
  creditLimit?: number | null;
  /** `statement.creditExposure`; `undefined` while loading or on an older API. */
  creditExposure?: number;
  /** `statement.pendingExposure` — unissued DRAFT invoices, not part of the bar. */
  pendingExposure?: number;
  /** The statement request FAILED (e.g. a role that cannot read it): stop showing "loading". */
  statementUnavailable?: boolean;
}

export function CreditLimitPanel({
  creditLimit,
  creditExposure,
  pendingExposure,
  statementUnavailable = false,
}: CreditLimitPanelProps) {
  // B1032: only null / absent (or a nonsense negative) means "no limit". A real $0 limit is a limit — the
  // server's credit block refuses anything above it — so it renders, marked, instead of vanishing.
  if (creditLimit == null || creditLimit < 0) return null;
  const isZeroLimit = creditLimit === 0;

  const known = typeof creditExposure === "number" && Number.isFinite(creditExposure);
  const used = known ? Math.max(0, creditExposure) : 0;
  // A $0 limit has no ratio: any exposure is a full (over) bar, none is an empty one.
  const percent = known
    ? isZeroLimit
      ? used > 0
        ? 100
        : 0
      : Math.min(100, (used / creditLimit) * 100)
    : 0;
  // roundMoney BEFORE the comparison / the shown remainder (L-170): float dust must not flip "over".
  const remaining = known ? roundMoney(creditLimit - used) : 0;
  const over = known && remaining < 0;
  const pending = typeof pendingExposure === "number" && pendingExposure > 0 ? pendingExposure : 0;

  return (
    <div className="mt-5 border-t border-surface-border pt-4" data-testid="credit-limit-panel">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">Credit Limit</p>
        <p className="text-sm font-semibold text-navy" data-testid="credit-limit-figures">
          {known ? fmt(used) : "—"} / {fmt(creditLimit)}
        </p>
      </div>
      {/* The figure is exposure, not receivables: without this line it reads as contradicting the
          "Outstanding" tile (which has no unbilled open orders in it). */}
      {isZeroLimit && (
        <p className="mb-1.5 text-xs font-semibold text-navy" data-testid="credit-limit-zero">
          {fmt(0)} limit — no credit extended
        </p>
      )}
      <p className="mb-1.5 text-xs text-navy/60" data-testid="credit-limit-basis">
        What the credit block checks — includes unbilled open orders
      </p>
      <div
        className="h-2.5 w-full overflow-hidden rounded-full bg-surface-raised"
        role="progressbar"
        aria-label="Credit limit used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.round(percent) : undefined}
        aria-valuetext={known ? `${fmt(used)} of ${fmt(creditLimit)} used` : undefined}
        aria-busy={!known && !statementUnavailable}
      >
        <div
          className={cn(
            "h-full rounded-full transition-all",
            percent > 90 ? "bg-danger" : percent > 70 ? "bg-warning" : "bg-brand-500",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p
        className={cn("mt-1 text-xs", over ? "font-semibold text-danger" : "text-navy/70")}
        data-testid="credit-limit-caption"
      >
        {!known ? (
          statementUnavailable ? (
            "Exposure unavailable"
          ) : (
            "—"
          )
        ) : over ? (
          <>Over the limit by {fmt(-remaining)}</>
        ) : (
          <>
            {percent.toFixed(0)}% used
            {remaining > 0 && <> &middot; {fmt(remaining)} available</>}
          </>
        )}
      </p>
      {pending > 0 && (
        <p
          className="mt-2 flex items-start gap-1.5 text-xs text-navy/70"
          data-testid="credit-pending-exposure"
        >
          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
          <span>
            <span className="font-semibold text-navy">Pending exposure {fmt(pending)}</span> — draft
            invoices with no order behind them; counted toward the limit once issued
          </span>
        </p>
      )}
    </div>
  );
}
