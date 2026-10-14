import { parseCreditLimitError, type CreditLimitExceededInfo } from "./credit-limit-error";
import {
  parseRegulatedAuthError,
  regulatedAuthErrorCopy,
  type BlockedCategory,
} from "./authorizations-logic";
import { parseDriverRestrictionBlock } from "./restriction-warning";

/**
 * B790 — the at-door adjust screen's submitEntry() creates a change request, then
 * self-resolves it; only the regulated-guard branch remembered the created CR (so
 * Remove/Cancel could decline it, its own deferred lifecycle — never touched here).
 * Every OTHER resolve failure (credit, LINE_ALREADY_DELIVERED, STOP_ALREADY_COMPLETED,
 * CHANGE_WINDOW_CLOSED, and any future code) just toasted and returned false, leaving
 * the CR PENDING — the buyer had already been notified, and processDiff resumes the
 * batch at the SAME index, so a bare retry (a plain "Save changes" tap rebuilds the
 * diff and resubmits) creates a SECOND change request for the same edit while the
 * first sits orphaned forever. This is live today, independent of any other in-flight
 * change to this flow.
 *
 * Row 510: the SECOND deliberate exception, `restricted`. A DRIVER may not override a selling restriction (the API
 * answers the resolve with the fixed 409 "Ask the office to approve this sale"), and the office can only approve a
 * request that is still PENDING. So, exactly like the REGULATED case, the caller leaves the CR PENDING and never
 * declines it. It also never arms the regulated deferred cleanup: nothing the driver does afterwards (Remove/Cancel)
 * may decline a request that the office is meant to approve.
 *
 * Pure classification of a resolve failure — no mutation calls here, so this is
 * directly unit-testable without RN rendering (adjust.tsx just acts on the result).
 * Keyed on the server's `code` where one exists; anything NOT explicitly matched
 * (including a future stable code) falls into `decline` — the safe default — rather
 * than needing a new branch added here first.
 */
export type AtStopResolveOutcome =
  | { action: "offline" }
  | { action: "regulated"; blocked: BlockedCategory[] }
  | { action: "restricted" }
  | { action: "already-resolved"; status?: string }
  | { action: "credit"; info: CreditLimitExceededInfo; reason: string }
  | { action: "decline"; reason: string };

export function classifyAtStopResolveError(e: unknown): AtStopResolveOutcome {
  const flags = e as { isOfflineQueued?: boolean; isOnlineRequired?: boolean } | null;
  if (flags?.isOfflineQueued || flags?.isOnlineRequired) {
    return { action: "offline" };
  }
  const blocked = parseRegulatedAuthError(e);
  if (blocked && blocked.length > 0) {
    return { action: "regulated", blocked };
  }
  // Row 510: the driver's hard block. The screen shows it through the shared warning modal (`rw.handle(e, ...)`), which
  // reads the same body; nothing is declined (see the header above).
  if (parseDriverRestrictionBlock(e)) {
    return { action: "restricted" };
  }
  const data = (e as { response?: { data?: { code?: string; message?: string } } } | null)?.response
    ?.data;
  if (data?.code === "CHANGE_REQUEST_ALREADY_RESOLVED") {
    // B795: carry the server's resolved status (e.g. DECLINED) when it sent one, so the
    // screen can name an office decline distinctly; omitted (not undefined) otherwise.
    const status = (data as { status?: unknown }).status;
    return typeof status === "string" && status
      ? { action: "already-resolved", status }
      : { action: "already-resolved" };
  }
  const creditInfo = parseCreditLimitError(e);
  if (creditInfo) {
    return { action: "credit", info: creditInfo, reason: creditInfo.message };
  }
  // LINE_ALREADY_DELIVERED / STOP_ALREADY_COMPLETED / CHANGE_WINDOW_CLOSED / any other or
  // future code (e.g. B753's) — decline so a retry can never leave this CR orphaned.
  // CQ-06: a license refusal with no categories (no guard to open) says what to fix, not the server's text.
  const reason =
    regulatedAuthErrorCopy(e) ??
    data?.message ??
    (e as { message?: string } | null)?.message ??
    "Couldn't save that change.";
  return { action: "decline", reason };
}

/** The final toast when a batch finished but a restricted change was handed to the office instead of applied. */
export const AT_STOP_RESTRICTED_SENT_COPY =
  "Order updated. The office will review the restricted item.";
