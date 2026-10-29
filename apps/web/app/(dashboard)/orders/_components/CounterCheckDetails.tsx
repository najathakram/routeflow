"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import { CheckNotReceivedChoice } from "./CheckNotReceivedChoice";
import {
  COUNTER_CHECK_POSTDATED_COPY,
  COUNTER_CHECK_ZONE_FAILED_COPY,
  COUNTER_CHECK_ZONE_LOADING_COPY,
  isPostdatedCheck,
} from "@/lib/counter-sale";

export const COUNTER_CHECK_WALK_IN_COPY =
  "A walk-in has no account. Pick a customer to put this sale on account.";

export interface CounterCheckDetailsProps {
  reference: string;
  onReferenceChange: (value: string) => void;
  /** The date written on the check, YYYY-MM-DD ("" = not entered). The parent defaults it to `today`. */
  checkDate: string;
  onCheckDateChange: (value: string) => void;
  /** The business's own calendar day (YYYY-MM-DD), never the browser's. "" while that day is not known. */
  today: string;
  /** Whether the business's day is known: until it is, no date is judged (never against UTC). Default "ready". */
  zoneStatus?: "ready" | "loading" | "failed";
  /** Re-read the business's day after a failure. */
  onRetryZone?: () => void;
  walkIn: boolean;
  /** The sale is locked (its POST is in flight or its outcome unknown). */
  disabled: boolean;
  /** Switch the sale's method to On account. */
  onPutOnAccount: () => void;
  /** SA-1026: "Check not received yet" is on: the number and date are not asked. Offered only with a handler and a named customer. */
  notReceived?: boolean;
  onNotReceivedChange?: (value: boolean) => void;
}

/**
 * Interim till guard (owner P0): the Payment section's Check fields. A check dated after the tenant's today is never
 * tendered at the till, so a date in the future says so and offers the one way forward: put the sale on account and
 * record the check when it clears. The server refuses the same check (400 COUNTER_CHECK_POSTDATED), so this is guidance,
 * not the guard. Props in, no fetching.
 */
export function CounterCheckDetails({
  reference,
  onReferenceChange,
  checkDate,
  onCheckDateChange,
  today,
  zoneStatus = "ready",
  onRetryZone,
  walkIn,
  disabled,
  onPutOnAccount,
  notReceived = false,
  onNotReceivedChange,
}: CounterCheckDetailsProps) {
  const postdated = zoneStatus === "ready" && isPostdatedCheck(checkDate, today);
  const offerNotReceived = !walkIn && onNotReceivedChange !== undefined;
  if (offerNotReceived && notReceived) {
    return (
      <div className="space-y-3" data-testid="counter-check-details">
        <CheckNotReceivedChoice checked onChange={onNotReceivedChange} disabled={disabled} />
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid="counter-check-details">
      <label className="block text-sm">
        Check number
        <input
          aria-label="Check number"
          className="mt-1 min-h-[44px] w-full rounded border px-3 py-2"
          value={reference}
          disabled={disabled}
          onChange={(e) => onReferenceChange(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Check date
        <input
          type="date"
          aria-label="Check date"
          className="mt-1 min-h-[44px] w-full rounded border px-3 py-2"
          value={checkDate}
          disabled={disabled}
          onChange={(e) => onCheckDateChange(e.target.value)}
        />
      </label>
      {zoneStatus === "loading" ? (
        <p role="status" className="text-sm text-navy/70" data-testid="counter-check-zone-loading">
          {COUNTER_CHECK_ZONE_LOADING_COPY}
        </p>
      ) : null}
      {zoneStatus === "failed" ? (
        <div
          role="alert"
          className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm"
          data-testid="counter-check-zone-failed"
        >
          <p className="font-semibold">{COUNTER_CHECK_ZONE_FAILED_COPY}</p>
          <Button type="button" className="min-h-[44px]" variant="secondary" onClick={onRetryZone}>
            Retry
          </Button>
        </div>
      ) : null}
      {postdated ? (
        <div
          role="alert"
          className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm"
          data-testid="counter-check-postdated"
        >
          <p className="font-semibold">{COUNTER_CHECK_POSTDATED_COPY}</p>
          <Button
            type="button"
            className="min-h-[44px]"
            variant="secondary"
            disabled={disabled || walkIn}
            onClick={onPutOnAccount}
          >
            Put this sale on account
          </Button>
          {walkIn ? <p>{COUNTER_CHECK_WALK_IN_COPY}</p> : null}
        </div>
      ) : null}
      {offerNotReceived ? (
        <CheckNotReceivedChoice
          checked={false}
          onChange={onNotReceivedChange}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}
