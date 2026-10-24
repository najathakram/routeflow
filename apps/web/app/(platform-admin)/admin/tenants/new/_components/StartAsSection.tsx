"use client";

import * as React from "react";
import { BILLING_PERIODS, EXTERNAL_PAYMENT_METHODS } from "@routeflow/types";

/** How the new account starts: a trial, or active because the business has already paid outside Stripe. */
export interface StartAs {
  mode: "trial" | "active";
  /** Kept as typed so the field can be cleared; parsed by `trialDaysOf`. */
  trialDays: string;
  paymentMethod: string;
  billingPeriodDays: number;
  paymentRef: string;
}

export const DEFAULT_TRIAL_DAYS = 14;

export const START_AS_DEFAULT: StartAs = {
  mode: "trial",
  trialDays: String(DEFAULT_TRIAL_DAYS),
  paymentMethod: "ZELLE",
  billingPeriodDays: 30,
  paymentRef: "",
};

/** Lite is invite only and has no trial: it always starts active. */
export function isTrialDisabled(plan: string): boolean {
  return plan === "LITE";
}

export function effectiveMode(plan: string, mode: StartAs["mode"]): StartAs["mode"] {
  return isTrialDisabled(plan) ? "active" : mode;
}

/** The trial length in days, or `null` when the field is blank or outside 1-90 (the create API's own bounds). */
export function trialDaysOf(value: string): number | null {
  const n = Number(value);
  return value.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= 90 ? n : null;
}

export function formatDay(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function addDays(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

/**
 * The one-line "what happens to billing" sentence. Trial: nothing is charged and the account goes read-only when the
 * trial ends. Active: Manual Activation sets the paid period to now + the billing period, with no Stripe charge.
 */
export function billingLine(mode: StartAs["mode"], value: StartAs): string {
  if (mode === "trial") {
    const days = trialDaysOf(value.trialDays);
    return days === null
      ? "Enter a trial length from 1 to 90 days."
      : `No charge now. On ${formatDay(addDays(days))} the account becomes read-only unless you activate it.`;
  }
  return `Paid through ${formatDay(addDays(value.billingPeriodDays))}. No Stripe charge. You record each payment yourself.`;
}

const FIELD =
  "h-10 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-60";

export function StartAsSection({
  plan,
  planName,
  priceText,
  value,
  onChange,
  disabled,
  trialError,
}: {
  plan: string;
  planName: string;
  /** "$99/month", or `null` when the catalog has no price for this plan. */
  priceText: string | null;
  value: StartAs;
  onChange: (next: StartAs) => void;
  disabled?: boolean;
  /** Fixed copy under the trial-length field when it is empty or out of range. */
  trialError?: string | null;
}) {
  const trialOff = isTrialDisabled(plan);
  const mode = effectiveMode(plan, value.mode);
  const set = (patch: Partial<StartAs>) => onChange({ ...value, ...patch });
  const name = "create-tenant-start-as";

  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-1 text-sm font-medium text-slate-300">Plan and start</legend>
      {priceText && (
        <p data-testid="plan-line" className="text-xs text-slate-400">
          {planName}: {priceText}.
        </p>
      )}

      <label
        className={`flex min-h-[44px] items-center gap-3 text-sm ${trialOff ? "text-slate-400" : "text-slate-200"}`}
      >
        <input
          type="radio"
          name={name}
          checked={mode === "trial"}
          disabled={trialOff}
          onChange={() => set({ mode: "trial" })}
        />
        Start a trial
      </label>
      {trialOff && (
        <p className="pl-7 text-xs text-slate-400">Lite is invite only and has no trial.</p>
      )}
      {mode === "trial" && (
        <div className="flex flex-col gap-1.5 pl-7">
          <label className="text-xs font-medium text-slate-300" htmlFor="create-tenant-start-days">
            Trial length (days)
          </label>
          <input
            id="create-tenant-start-days"
            type="number"
            min={1}
            max={90}
            inputMode="numeric"
            required
            value={value.trialDays}
            onChange={(e) => set({ trialDays: e.target.value })}
            aria-invalid={trialError ? true : undefined}
            aria-describedby={trialError ? "create-tenant-start-days-error" : undefined}
            className={`${FIELD} sm:max-w-[10rem]`}
          />
          {trialError && (
            <p id="create-tenant-start-days-error" className="text-xs text-red-400">
              {trialError}
            </p>
          )}
        </div>
      )}

      <label className="flex min-h-[44px] items-center gap-3 text-sm text-slate-200">
        <input
          type="radio"
          name={name}
          checked={mode === "active"}
          onChange={() => set({ mode: "active" })}
        />
        Start active
      </label>
      {mode === "active" && (
        <div className="flex flex-col gap-3 pl-7">
          <p className="text-xs text-slate-400">You&apos;ve already been paid, outside Stripe.</p>
          <div className="flex flex-col gap-1.5">
            <label
              className="text-xs font-medium text-slate-300"
              htmlFor="create-tenant-start-method"
            >
              Payment method
            </label>
            <select
              id="create-tenant-start-method"
              value={value.paymentMethod}
              onChange={(e) => set({ paymentMethod: e.target.value })}
              className={FIELD}
            >
              {EXTERNAL_PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              className="text-xs font-medium text-slate-300"
              htmlFor="create-tenant-start-period"
            >
              Billing period (days)
            </label>
            <select
              id="create-tenant-start-period"
              value={String(value.billingPeriodDays)}
              onChange={(e) => set({ billingPeriodDays: Number(e.target.value) })}
              className={FIELD}
            >
              {BILLING_PERIODS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-300" htmlFor="create-tenant-start-ref">
              Reference (optional)
            </label>
            <input
              id="create-tenant-start-ref"
              value={value.paymentRef}
              onChange={(e) => set({ paymentRef: e.target.value })}
              placeholder="e.g. Zelle confirmation ID"
              className={FIELD}
            />
          </div>
        </div>
      )}

      <p data-testid="billing-line" className="mt-1 text-xs text-slate-300">
        {billingLine(mode, value)}
      </p>
    </fieldset>
  );
}
