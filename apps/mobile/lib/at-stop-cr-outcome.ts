import { parseCreditLimitError, type CreditLimitExceededInfo } from "./credit-limit-error";
import {
  parseRegulatedAuthError,
  regulatedAuthErrorCopy,
  type BlockedCategory,
} from "./authorizations-logic";

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
 * Pure classification of a resolve failure — no mutation calls here, so this is
 * directly unit-testable without RN rendering (adjust.tsx just acts on the result).
 * Keyed on the server's `code` where one exists; anything NOT explicitly matched
 * (including a future stable code) falls into `decline` — the safe default — rather
 * than needing a new branch added here first.
 */
export type AtStopResolveOutcome =
  | { action: "offline" }
  | { action: "regulated"; blocked: BlockedCategory[] }
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
