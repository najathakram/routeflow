"use client";

import * as React from "react";
import { API_ERROR_CODES } from "@routeflow/types";
import { AdminModal } from "./AdminModal";

/**
 * Back-office confirmations for the tenant actions that act immediately: Impersonate, Extend
 * Trial, Suspend and Delete. Each dialog names the tenant, tells the truth about what the action does, and puts the
 * initial focus on Cancel so a stray Enter never fires it. They only GATE the existing calls: no
 * request is made here, `onConfirm` hands control back to the page, and Escape / Cancel / the close
 * button call `onClose` and nothing else.
 */
export interface TenantNameRef {
  name: string;
  businessName?: string | null;
  /** Shown beside the name in every dialog title: two tenants can share a business name. */
  slug?: string | null;
}

/** The name an operator knows the tenant by: its business name, else its name (never a dash). */
export const tenantLabel = (t: TenantNameRef): string => t.businessName?.trim() || t.name;

/** "Acme Wholesale (acme)": the label plus the slug, for a dialog title. */
export const tenantTitle = (t: TenantNameRef): string =>
  t.slug ? `${tenantLabel(t)} (${t.slug})` : tenantLabel(t);

/**
 * Fixed copy for a failed back-office tenant action. The server's own text is never shown (it can
 * carry internals); the dialogs and pages say what happened in the portal's own words.
 */
export const TENANT_ACTION_COPY = {
  impersonateFailed: "Couldn't start the impersonation. Try again.",
  noAdmin: (label: string) =>
    `${label} has no active admin. Create one in Admin Account, then try again.`,
  statusFailed: "Couldn't change the tenant's status. Try again.",
  extendFailed: "Couldn't extend the trial. Try again.",
  trialNotAllowed:
    "This tenant is Active, so it can't be put on a trial. Suspend it or change its plan instead.",
  planFailed: "Couldn't change the plan. Try again.",
  deleteRefused: "Only a suspended tenant can be deleted. Suspend it first, then delete.",
  deleteFailed: "Couldn't delete the tenant. Try again.",
  cancelSubscriptionFirst:
    "This tenant still has a Stripe subscription that hasn't ended (active, paused or incomplete). End it in Stripe first, then try again.",
  subscriptionUnconfirmed:
    "Couldn't confirm the tenant's Stripe subscription just now, or it changed meanwhile. Try again in a moment.",
  actionFailed: "That didn't work. Try again.",
  suspendAutoReinstate: "Suspended tenants are reinstated automatically when they pay.",
} as const;

const errorCodeOf = (err: unknown): string | undefined =>
  (err as { response?: { data?: { code?: string } } } | null)?.response?.data?.code;

/**
 * The Stripe gate's coded 409s on a tenant status change or delete (a CANCELLED / delete over a subscription that
 * has not ended, or one Stripe could not be read for): fixed copy, never the server's text. null = not one of them.
 */
function stripeGateCopy(err: unknown): string | null {
  const code = errorCodeOf(err);
  if (code === API_ERROR_CODES.TENANT_CANCEL_SUBSCRIPTION_FIRST) {
    return TENANT_ACTION_COPY.cancelSubscriptionFirst;
  }
  if (code === API_ERROR_CODES.CONCURRENT_UPDATE) return TENANT_ACTION_COPY.subscriptionUnconfirmed;
  return null;
}

/** A failed status change: the Stripe gate's fixed copy, else the plain failure. */
export function statusFailureCopy(err: unknown): string {
  return stripeGateCopy(err) ?? TENANT_ACTION_COPY.statusFailed;
}

/** The delete refusal (the server deletes only SUSPENDED tenants: a 400 / 409), the Stripe gate's, or a plain failure. */
export function deleteFailureCopy(err: unknown): string {
  const gate = stripeGateCopy(err);
  if (gate) return gate;
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return status === 400 || status === 409
    ? TENANT_ACTION_COPY.deleteRefused
    : TENANT_ACTION_COPY.deleteFailed;
}

/** Extend Trial failure: the server's coded refusal of an ACTIVE tenant, else a plain failure. */
export function extendFailureCopy(err: unknown): string {
  const code = (err as { response?: { data?: { code?: string } } } | null)?.response?.data?.code;
  return code === API_ERROR_CODES.TENANT_TRIAL_EXTEND_NOT_ALLOWED
    ? TENANT_ACTION_COPY.trialNotAllowed
    : TENANT_ACTION_COPY.extendFailed;
}

/** Days accepted by Extend Trial (the server's own range). */
export const isValidTrialDays = (days: number): boolean =>
  Number.isInteger(days) && days >= 1 && days <= 365;

/** "October 21, 2026" — the same long date in every dialog and success line. */
export const longDate = (d: Date): string =>
  d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

/** "ACTIVE" → "Active". */
const statusWord = (status: string): string =>
  status
    ? status.charAt(0).toUpperCase() + status.slice(1).toLowerCase().replace(/_/g, " ")
    : status;

const CANCEL_CLASS = "rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-700";
const PRIMARY_CLASS =
  "rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50";

/**
 * Cancel gets the initial focus. `AdminModal` focuses its first control when it opens (its close
 * button); this runs after it (a parent's effect follows its child's), so Cancel wins.
 */
function useCancelFocus(open: boolean) {
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);
  return cancelRef;
}

interface DialogBase {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  busy?: boolean;
}

export function ImpersonateDialog({
  open,
  tenant,
  adminUsername,
  busy,
  onClose,
  onConfirm,
}: DialogBase & { tenant: TenantNameRef; adminUsername?: string | null }) {
  const cancelRef = useCancelFocus(open);
  const label = tenantTitle(tenant);
  return (
    <AdminModal
      open={open}
      onClose={onClose}
      title={`Impersonate ${label}?`}
      footer={
        <>
          <button ref={cancelRef} type="button" onClick={onClose} className={CANCEL_CLASS}>
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={onConfirm} className={PRIMARY_CLASS}>
            Impersonate
          </button>
        </>
      }
    >
      <p className="text-sm text-slate-300">
        You&apos;ll sign in as{" "}
        <span className="font-mono text-white">{adminUsername || "its admin"}</span> with full
        access for up to 15 minutes. Changes you make are real.
      </p>
      <p className="mt-3 text-sm text-slate-400">
        The audit log records that this session started. To leave, click Exit impersonation in the
        red bar.
      </p>
    </AdminModal>
  );
}

export function ExtendTrialDialog({
  open,
  tenant,
  status,
  days,
  trialEndsAt,
  now,
  busy,
  onClose,
  onConfirm,
}: DialogBase & {
  tenant: TenantNameRef;
  status: string;
  days: number;
  /** The tenant's current trial end, when it has one (to warn when the new date is EARLIER). */
  trialEndsAt?: string | null;
  /** Injected by tests; the date is today + `days`. */
  now?: Date;
}) {
  const cancelRef = useCancelFocus(open);
  const label = tenantTitle(tenant);
  // A paying (ACTIVE) tenant is never moved to a trial: the server refuses it (409), so the dialog does too.
  const blocked = status === "ACTIVE";
  const valid = isValidTrialDays(days);
  const newEnd = new Date((now ?? new Date()).getTime() + (valid ? days : 0) * 24 * 60 * 60 * 1000);
  const ends = longDate(newEnd);
  // The server sets the status to TRIAL unconditionally, so on any other status the dialog says so.
  const onTrial = status === "TRIAL";
  // The server RESETS the end to today + days: a later current end would be cut short.
  const current = trialEndsAt ? new Date(trialEndsAt) : null;
  const shortens =
    valid && onTrial && current !== null && !Number.isNaN(current.getTime()) && current > newEnd;
  return (
    <AdminModal
      open={open}
      onClose={onClose}
      title={`Extend the trial for ${label}?`}
      footer={
        <>
          <button ref={cancelRef} type="button" onClick={onClose} className={CANCEL_CLASS}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !valid || blocked}
            onClick={onConfirm}
            className={PRIMARY_CLASS}
          >
            Extend Trial
          </button>
        </>
      }
    >
      {blocked ? (
        <p role="alert" className="text-sm font-medium text-yellow-400">
          {TENANT_ACTION_COPY.trialNotAllowed}
        </p>
      ) : valid ? (
        <>
          <p className="text-sm text-slate-300">
            {onTrial
              ? `The trial will end on ${ends}.`
              : `${label} is ${statusWord(status)}. Extending the trial changes its status to Trial until ${ends}.`}
          </p>
          <p className="mt-2 text-xs text-slate-400">
            {days} {days === 1 ? "day" : "days"} from today.
          </p>
          {shortens && current && (
            <p role="alert" className="mt-2 text-sm font-medium text-yellow-400">
              This shortens the trial from {longDate(current)} to {ends}.
            </p>
          )}
        </>
      ) : (
        <p role="alert" className="text-sm font-medium text-red-400">
          Enter 1–365 days.
        </p>
      )}
    </AdminModal>
  );
}

const SUSPEND_CLASS =
  "rounded-lg bg-yellow-600 px-4 py-2 text-sm font-semibold text-white hover:bg-yellow-500 disabled:opacity-50";
// Filled red only on the destructive confirm that cannot be undone.
const DELETE_CLASS =
  "rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50";

export function SuspendDialog({
  open,
  tenant,
  busy,
  onClose,
  onConfirm,
}: DialogBase & { tenant: TenantNameRef }) {
  const cancelRef = useCancelFocus(open);
  const label = tenantTitle(tenant);
  return (
    <AdminModal
      open={open}
      onClose={onClose}
      title={`Suspend "${label}"?`}
      footer={
        <>
          <button ref={cancelRef} type="button" onClick={onClose} className={CANCEL_CLASS}>
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={onConfirm} className={SUSPEND_CLASS}>
            Suspend
          </button>
        </>
      }
    >
      <p className="text-sm text-slate-300">
        People at {label} can&apos;t sign in while it&apos;s suspended. You can reactivate it at any
        time.
      </p>
      <p className="mt-2 text-sm text-slate-400">{TENANT_ACTION_COPY.suspendAutoReinstate}</p>
    </AdminModal>
  );
}

export function DeleteTenantDialog({
  open,
  tenant,
  busy,
  error,
  onClose,
  onConfirm,
}: DialogBase & {
  tenant: TenantNameRef & { slug: string };
  /** The server's refusal (it only deletes SUSPENDED tenants): shown here, the dialog stays open. */
  error?: string | null;
}) {
  const cancelRef = useCancelFocus(open);
  const [typed, setTyped] = React.useState("");
  // A new open starts empty, whatever was typed last time.
  React.useEffect(() => {
    if (open) setTyped("");
  }, [open]);
  const label = tenantTitle(tenant);
  const matches = typed === tenant.slug;
  return (
    <AdminModal
      open={open}
      onClose={onClose}
      title={`Delete ${label}?`}
      footer={
        <>
          <button ref={cancelRef} type="button" onClick={onClose} className={CANCEL_CLASS}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!matches || busy}
            onClick={() => {
              if (matches) onConfirm();
            }}
            className={DELETE_CLASS}
          >
            {busy ? "Deleting..." : "Delete Tenant"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error && (
          <div
            role="alert"
            className="rounded-lg bg-red-900/40 px-3 py-2 text-sm text-red-400 ring-1 ring-red-700"
          >
            {error}
          </div>
        )}
        <p className="text-sm text-slate-300">
          This cancels and archives {label}. You can&apos;t undo this.
        </p>
        <p className="text-sm text-slate-400">
          To confirm, type the tenant slug:{" "}
          <strong className="font-mono text-slate-200">{tenant.slug}</strong>
        </p>
        <input
          aria-label="Type the tenant slug to confirm deletion"
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={tenant.slug}
          className="h-9 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 text-sm text-white placeholder:text-slate-500 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/30"
        />
      </div>
    </AdminModal>
  );
}
