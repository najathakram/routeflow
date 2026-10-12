import { API_ERROR_CODES, type SubscriptionView } from "@routeflow/types";
import { readOnlyLine } from "./subscription-banner-state";
import { readOnlyCopyForView } from "./read-only-copy";
import { markReadOnlyRefused } from "./read-only-gate";

/**
 * A write refused by a READ_ONLY workspace is a 403 whose body code is READ_ONLY (TenantStatusGuard). Every helper that
 * turns an error into user copy asks `isReadOnlyRefusal` BEFORE its generic 401 / 403 / "forbidden" fallback, so the user
 * sees the read-only line instead of "you don't have permission" (the permission is fine; the workspace is read-only).
 * The structural pin is `read-only-copy.pins.test.ts`.
 */

/**
 * True when `err` is a READ_ONLY refusal. Takes the shapes the copy helpers already receive: an axios error
 * (`{ response: { data: { code } } }`), a bare response (`{ data: { code } }`) or a body (`{ code }`).
 */
export function isReadOnlyRefusal(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: unknown;
    data?: { code?: unknown } | null;
    response?: { data?: { code?: unknown } | null } | null;
  };
  const code = e.response?.data?.code ?? e.data?.code ?? e.code;
  return code === API_ERROR_CODES.READ_ONLY;
}

/**
 * The read-only line a blocked control / a refused write shows: the shared read-only copy (SA-776, ONE helper) - the
 * owner's sentence, then the mapped reason and who to ask by e-mail when the caller holds the subscription view.
 * With no view it is the owner's sentence alone; the 403's own text is never shown.
 */
export function readOnlyRefusalCopy(
  view?: SubscriptionView | null,
  isAdmin: boolean = false,
): string {
  return readOnlyLine(view ?? null, isAdmin);
}

/**
 * A raw `apiClient` write (not a react-query mutation) is never seen by the app-wide mutation handler, so a READ_ONLY
 * refusal of it must be answered here: flip the gate (every control + dialog switches to the shared line) and toast
 * the shared copy (the owner's sentence, the mapped reason). Returns true when `err` was such a refusal, so the caller
 * skips its own generic "Failed to save" toast.
 */
export function showReadOnlyRefusal(
  err: unknown,
  toast: (o: { title: string; description?: string; variant: "warning" }) => unknown,
): boolean {
  if (!isReadOnlyRefusal(err)) return false;
  const body = (err as { response?: { data?: { reason?: unknown } } }).response?.data;
  const reason = typeof body?.reason === "string" ? body.reason : null;
  markReadOnlyRefused(reason);
  const copy = readOnlyCopyForView({ readOnlyReason: reason } as SubscriptionView, false);
  toast({
    title: copy.sentence,
    description: [copy.reasonLine, copy.contactLine].filter(Boolean).join(" ") || undefined,
    variant: "warning",
  });
  return true;
}
