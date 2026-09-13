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
