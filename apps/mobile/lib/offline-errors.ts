/**
 * REG-B308: api-client.ts:183 rejects an offline-queued mutation with
 * `isOfflineQueued: true` after enqueueing it — that is a pending success,
 * not a failure. Mirrors the pattern already correct in skip-stop.ts:48-57.
 */
export function classifyMutationError(e: unknown): { kind: "queued" | "error"; message: string } {
  if ((e as any)?.isOfflineQueued === true) {
    return { kind: "queued", message: (e as any).message };
  }
  return {
    kind: "error",
    message: (e as any)?.response?.data?.message ?? (e as any)?.message ?? "Try again.",
  };
}

/**
 * Driver-durability lane. `completeWithPayment` mints a fresh idempotency key
 * on every manual retry (see payment.tsx's `closeStop`), so RF-019 cannot
 * collapse a retry after a lost response — but the server refuses ANY write
 * once the stop is COMPLETED, before its transaction
 * (apps/api/src/routes/routes.service.ts `throw new BadRequestException("Stop
 * is already completed")`, thrown before the idempotency read). So this 400
 * on a retry means the FIRST call already landed; the caller should treat it
 * as success (refresh + navigate), not surface it as an error.
 *
 * Deliberately a SEPARATE predicate from `classifyMutationError` above, not a
 * third `kind` on its return type: that classifier is also used by
 * `components/NewOrderScreen.tsx`'s order-submit error handling, and baking a
 * route/stop-completion-specific server message into its generic `kind` union
 * would leak stop-completion semantics into an unrelated screen's error
 * handling and force every other caller to reason about a branch that can
 * never apply to them.
 *
 * Requires BOTH `status === 400` AND the message substring — never any 400 —
 * so a genuinely different 400 (wrong amount, validation failure) is never
 * misclassified as success. Substring match (not exact-string), matching the
 * existing precedent at `lib/returns-logic.ts#summarizeSubmissions`, since the
 * server has no error `code` for this path, only a raw `BadRequestException`
 * message — a substring match survives a minor server wording tweak.
 *
 * An API spec (`apps/api`) should separately assert `completeWithPayment`
 * throws exactly `"Stop is already completed"` at its guard(s), so a server
 * wording change is caught on that side too — see this run's `open_issues`;
 * a cross-workspace source-text pin from `apps/mobile` reading `apps/api`
 * source is deliberately NOT added here.
 */
export function isStopAlreadyCompletedError(e: unknown): boolean {
  const status = (e as any)?.response?.status;
  const message = String((e as any)?.response?.data?.message ?? "").toLowerCase();
  return status === 400 && message.includes("already completed");
}
