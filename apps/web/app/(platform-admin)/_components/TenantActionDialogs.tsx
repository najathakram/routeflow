"use client";

import * as React from "react";
import { AdminModal } from "./AdminModal";

/**
 * Back-office confirmations for the tenant actions that act immediately: Impersonate and Extend
 * Trial. Each dialog names the tenant, tells the truth about what the action does, and puts the
 * initial focus on Cancel so a stray Enter never fires it. They only GATE the existing calls: no
 * request is made here, `onConfirm` hands control back to the page, and Escape / Cancel / the close
 * button call `onClose` and nothing else.
 */
export interface TenantNameRef {
  name: string;
  businessName?: string | null;
}

/** The name an operator knows the tenant by: its business name, else its name (never a dash). */
export const tenantLabel = (t: TenantNameRef): string => t.businessName?.trim() || t.name;

/** "October 21, 2026" — the same long date in every dialog and success line. */
export const longDate = (d: Date): string =>
  d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

/** "ACTIVE" → "Active". */
const statusWord = (status: string): string =>
  status ? status.charAt(0).toUpperCase() + status.slice(1).toLowerCase() : status;

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
  const label = tenantLabel(tenant);
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
  now,
  busy,
  onClose,
  onConfirm,
}: DialogBase & {
  tenant: TenantNameRef;
  status: string;
  days: number;
  /** Injected by tests; the date is today + `days`. */
  now?: Date;
}) {
  const cancelRef = useCancelFocus(open);
  const label = tenantLabel(tenant);
  const ends = longDate(new Date((now ?? new Date()).getTime() + days * 24 * 60 * 60 * 1000));
  // The server sets the status to TRIAL unconditionally, so on any other status the dialog says so.
  const onTrial = status === "TRIAL";
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
          <button type="button" disabled={busy} onClick={onConfirm} className={PRIMARY_CLASS}>
            Extend Trial
          </button>
        </>
      }
    >
      <p className="text-sm text-slate-300">
        {onTrial
          ? `The trial will end on ${ends}.`
          : `${label} is ${statusWord(status)}. Extending the trial changes its status to Trial until ${ends}.`}
      </p>
    </AdminModal>
  );
}
