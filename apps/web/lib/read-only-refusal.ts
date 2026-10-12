import { API_ERROR_CODES, type SubscriptionView } from "@routeflow/types";
import { readOnlyLine } from "./subscription-banner-state";

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
