/**
 * Pure (screen-free, testable) helpers for the operator customer-file
 * Licenses screen — mirrors web `lib/api/authorizations.ts`'s display logic
 * (`displayAuthStatus` / `authStatusBadge`) with mobile Pill variants, plus
 * the per-row action flags the server's status machine allows.
 */

export type AuthorizationStatus = "NONE" | "PENDING_REVIEW" | "VERIFIED" | "EXPIRED" | "REJECTED";
export type AuthorizationSource = "RETAILER_SUBMITTED" | "WHOLESALER_ADDED";

export type PillVariant = "brand" | "green" | "orange" | "red" | "gray" | "purple";

/**
 * Lazy-expiry display status: a VERIFIED authorization past its `expiresAt`
 * reads as EXPIRED (matches the sale guard; the daily cron flips the persisted
 * status separately).
 */
export function displayAuthStatus(
  a: { status: AuthorizationStatus; expiresAt: string | null },
  now: Date = new Date(),
): AuthorizationStatus {
  if (a.status === "VERIFIED" && a.expiresAt && new Date(a.expiresAt) < now) return "EXPIRED";
  return a.status;
}

/** Status → Pill. Same vocabulary as web's authStatusBadge. */
export function authStatusPill(status: AuthorizationStatus): {
  variant: PillVariant;
  label: string;
} {
  switch (status) {
    case "VERIFIED":
      return { variant: "green", label: "Verified" };
    case "PENDING_REVIEW":
      return { variant: "orange", label: "Pending review" };
    case "EXPIRED":
      return { variant: "red", label: "Expired" };
    case "REJECTED":
      return { variant: "red", label: "Rejected" };
    case "NONE":
    default:
      return { variant: "gray", label: "Not submitted" };
  }
}

/** "Submitted by buyer" vs "Added by you" — same copy as web's sourceLabel. */
export function authSourceLabel(source: AuthorizationSource): string {
  return source === "RETAILER_SUBMITTED" ? "Submitted by buyer" : "Added by you";
}

export interface AuthorizationActionFlags {
  /** PENDING_REVIEW only — the server rejects approve otherwise. */
  canApprove: boolean;
  /** PENDING_REVIEW only. */
  canReject: boolean;
  /** VERIFIED or EXPIRED (display status) — REJECTED/PENDING can't be laundered to VERIFIED. */
  canRenew: boolean;
}

/**
 * Per-row actions from the DISPLAY status (lazy expiry applied) — mirrors the
 * server's status machine so a tap never round-trips into a 400.
 */
export function authorizationActionFlags(
  displayStatus: AuthorizationStatus,
): AuthorizationActionFlags {
  return {
    canApprove: displayStatus === "PENDING_REVIEW",
    canReject: displayStatus === "PENDING_REVIEW",
    canRenew: displayStatus === "VERIFIED" || displayStatus === "EXPIRED",
  };
}

/**
 * Whole days until expiry (ceil — "expires today" is 0), or null when there is
 * no expiry. Negative = already past.
 */
export function expiresInDays(expiresAt: string | null, now: Date = new Date()): number | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.ceil(ms / 86_400_000);
}

/**
 * The row sub-line's expiry phrase, matching the server's 30/7/1 warning
 * windows: expired → "Expired <n> days ago"/"Expired today"; ≤30 days out →
 * "Expires in N days"; else "Expires <ISO date part>"; no expiry → null.
 */
export function expiryPhrase(expiresAt: string | null, now: Date = new Date()): string | null {
  const days = expiresInDays(expiresAt, now);
  if (days == null) return null;
  if (days < 0) {
    const ago = Math.abs(days);
    return ago === 0 ? "Expired today" : `Expired ${ago} day${ago === 1 ? "" : "s"} ago`;
  }
  if (days === 0) return "Expires today";
  if (days <= 30) return `Expires in ${days} day${days === 1 ? "" : "s"}`;
  return `Expires ${String(expiresAt).slice(0, 10)}`;
}

/**
 * The exact client rules web's LicenseModal enforces for capture/renew: both
 * fields required, expiry a valid future date. Returns the first human error
 * or null when submittable.
 */
export function validateLicenseForm(
  form: { licenseNumber: string; expiresAt: string },
  now: Date = new Date(),
): string | null {
  if (!form.licenseNumber.trim()) return "Enter the license number.";
  const raw = form.expiresAt.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "Enter the expiry as YYYY-MM-DD.";
  const date = new Date(`${raw}T23:59:59`);
  if (isNaN(date.getTime())) return "Enter a valid expiry date.";
  if (date < now) return "The expiry date is in the past.";
  return null;
}
