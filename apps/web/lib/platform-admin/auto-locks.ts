import type {
  AutoLockKindValue,
  AutoLockPreview,
  AutoLockState,
  AutoLockWouldLock,
} from "@routeflow/types";

/**
 * SA-775 (row 381): the pure logic and fixed copy of the super-admin "Automatic locks" card. Nothing here
 * touches the network or the DOM, so the wording the owner confirms against is unit-tested. A tenant is shown
 * by id only; the server's own error text is never shown (fixed copy).
 */

export const REASON_MIN = 3;
export const REASON_MAX = 500;

/** Plain words for each kind of held lock. */
export const AUTO_LOCK_KIND_LABELS: Record<AutoLockKindValue, string> = {
  trial_expired: "Trial ended",
  subscription_cancelled: "Cancellation reached its period end",
  overdue_suspended: "Overdue subscription (Stripe check pending)",
  stripe_cancelled: "Cancelled in Stripe",
  payment_overdue: "Payment overdue",
  trial_cancelled: "Trial cancelled by the workspace admin",
};

export const kindLabel = (kind: string): string =>
  (AUTO_LOCK_KIND_LABELS as Record<string, string>)[kind] ?? kind;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The reason the server requires: trimmed, 3..500 characters. */
export const isReasonValid = (reason: string): boolean => {
  const n = reason.trim().length;
  return n >= REASON_MIN && n <= REASON_MAX;
};

/** The banner line over the card. A missing switch reads as paused (the server's default). */
export function autoLockBanner(
  state: Pick<AutoLockState, "paused" | "wouldLockNow"> | null,
): string {
  if (!state) return "Automatic locks: status unavailable";
  if (!state.paused) return "Automatic locks are on";
  const n = state.wouldLockNow.length;
  return n === 0
    ? "Automatic locks paused — no tenants would be locked now"
    : `Automatic locks paused — ${n} ${plural(n, "tenant", "tenants")} would be locked now`;
}

/** Heading + body of the unpause confirmation, built from the preview the owner is looking at. */
export function unpauseConfirmCopy(preview: Pick<AutoLockPreview, "wouldLock"> | null): {
  title: string;
  body: string;
  confirmLabel: string;
} {
  const title = "Unpause automatic locks?";
  const confirmLabel = "Unpause and allow locks";
  if (!preview) {
    return {
      title,
      body: "We couldn't load the preview, so we can't tell which tenants would be locked. Don't unpause until it loads.",
      confirmLabel,
    };
  }
  const n = preview.wouldLock.length;
  if (n === 0) {
    return {
      title,
      body: "No tenant would be locked right now. From now on, expired trials, cancellations that reach their period end and overdue subscriptions lock again on the next hourly pass.",
      confirmLabel,
    };
  }
  return {
    title,
    body:
      n === 1
        ? "Unpausing will lock this tenant within the hour:"
        : `Unpausing will lock these ${n} tenants within the hour:`,
    confirmLabel,
  };
}

/** One list row: the tenant id and what would lock it. */
export const wouldLockRowText = (r: AutoLockWouldLock): string =>
  `${r.tenantId} — ${kindLabel(r.kind)}`;

export const AUTO_LOCK_COPY = {
  loadFailed: "Couldn't load the automatic-locks status. Reload the page to try again.",
  previewFailed: "Couldn't load the unpause preview. Try again.",
  switchFailed: "Couldn't change the switch. Nothing was changed.",
  pausedNow:
    "Automatic locks are paused. Production tenants don't lock on their own until you unpause.",
  unpausedNow: "Automatic locks are on for every tenant.",
  neverUnlocks: "Pausing never unlocks a tenant that is already locked.",
} as const;
