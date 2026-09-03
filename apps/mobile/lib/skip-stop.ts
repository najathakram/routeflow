/**
 * F11 (B34). The driver stop screen's "Skip stop" confirm handler, as a pure
 * function so the pure-logic runner can prove it (L-025). Before F11 the
 * onConfirm was a bare router.replace — no PATCH was ever sent, so the stop
 * stayed PENDING and the buyer card kept saying "You're next".
 *
 * Contract:
 *  - no resolved runId → toast, no mutate, no navigation (the run may still be
 *    loading from useActiveRouteRun);
 *  - a call while a previous mutate is in flight is a no-op (SecondaryBtn has
 *    no `disabled`, so the guard lives here); clears on success AND error;
 *  - navigate ONLY after the server (or the offline queue) accepted the write;
 *  - `isOfflineQueued` (api-client.ts enqueues the PATCH then rejects with
 *    that flag) counts as accepted: a skip is one idempotent PATCH
 *    (updateStopStatus has no same-status guard — a double replay rewrites
 *    SKIPPED), unlike adjust.tsx's half-applied edit which must refuse;
 *  - any other error → server message → error message → fallback; stay put.
 */
export interface SkipStopDeps {
  runId: string | undefined;
  stopId: string;
  mutate: (
    vars: { runId: string; stopId: string; status: "SKIPPED" },
    cbs: { onSuccess: () => void; onError: (e: unknown) => void },
  ) => void;
  navigateBack: () => void;
  toast: (msg: string) => void;
}

export function createSkipStopHandler(deps: SkipStopDeps): () => void {
  let inFlight = false;
  return () => {
    const runId = deps.runId;
    if (!runId) {
      deps.toast("Run not loaded yet — try again");
      return;
    }
    if (inFlight) return;
    inFlight = true;
    deps.mutate(
      { runId, stopId: deps.stopId, status: "SKIPPED" },
      {
        onSuccess: () => {
          inFlight = false;
          deps.toast("Stop skipped");
          deps.navigateBack();
        },
        onError: (e: unknown) => {
          inFlight = false;
          const err = e as any;
          if (err?.isOfflineQueued === true) {
            deps.toast("Offline — skip queued and will sync when you reconnect");
            deps.navigateBack();
            return;
          }
          deps.toast(err?.response?.data?.message ?? err?.message ?? "Could not skip this stop");
        },
      },
    );
  };
}
