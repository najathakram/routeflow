import { useEffect, useRef } from "react";
import NetInfo from "@react-native-community/netinfo";
import { useOfflineQueue, selectFailedActionCount, type QueuedAction } from "../store/offlineQueue";
import { apiClient } from "../lib/api-client";
import { showToast } from "../lib/toast";
import { alertInfo } from "../lib/confirm";
import { drainQueue, buildReplayRequestConfig, describeFailedDrain } from "../lib/queue-drain";
import { resolveQueueIdentity, settleQueueOwnership } from "../lib/queue-identity";

// RF-170: matches /route-runs/{runId}/stops/{stopId}/complete
const STOP_COMPLETE_RE = /\/route-runs\/([^/]+)\/stops\/[^/]+\/complete/;

export function useNetworkSync() {
  const {
    queue,
    isOnline,
    setOnline,
    setSyncing,
    dequeue,
    incrementRetry,
    addFailedAction,
    restampAction,
    failedActions,
    clearFailedAction,
    clearFailedActions,
  } = useOfflineQueue();
  // R6's badge leg: the drain-time alert is one-shot (dismissable, and it can
  // fire while the app is backgrounded), so the count has to stand on its own
  // until the operator acknowledges it — see components/OfflineBanner.tsx.
  const failedCount = useOfflineQueue(selectFailedActionCount);
  const syncing = useRef(false);

  const runDrain = async (currentQueue: QueuedAction[]) => {
    if (syncing.current || currentQueue.length === 0) return;

    // REG-B137: nothing is replayed under a session that does not own it.
    // With nobody signed in there is no token to replay under at all, so the
    // queue simply waits.
    const identity = resolveQueueIdentity();
    if (!identity) return;

    syncing.current = true;
    setSyncing(true);

    // Partition by owner BEFORE anything is attempted — an entry queued by a
    // different user is moved to failedActions and dropped from the queue
    // rather than executed under this session (B137). Done ahead of the
    // RF-170 run check below so not even that lookup fires for someone
    // else's work.
    const owned = settleQueueOwnership(currentQueue, identity, {
      addFailedAction,
      removeAction: dequeue,
      restampAction,
    });

    // RF-170: before submitting a stop-completion, verify the run is still
    // active. If it was cancelled while the driver was offline, the action
    // is intentionally discarded — the run itself no longer exists, so this
    // is a deliberate short-circuit, not the silent-loss path REG-B143/B111
    // fixed below, and it never reaches the shared classification.
    const remaining: QueuedAction[] = [];
    for (const action of owned) {
      const stopMatch = STOP_COMPLETE_RE.exec(action.endpoint);
      if (stopMatch) {
        const runId = stopMatch[1];
        try {
          const { data: run } = await apiClient.get(`/route-runs/${runId}`);
          if (run?.status === "CANCELLED") {
            dequeue(action.id);
            showToast("A route run was cancelled — some offline actions have been discarded.");
            continue;
          }
        } catch {
          // Can't verify — attempt submission anyway; server will reject if needed.
        }
      }
      remaining.push(action);
    }

    // Shared, pure classification (lib/queue-drain.ts) — the ONLY place that
    // decides delivered vs retry vs never-silent-failure, so this hook and
    // its jest specs can never drift out of sync.
    const result = await drainQueue(remaining, {
      request: (action) => apiClient.request(buildReplayRequestConfig(action)),
      // REG-B143 / REG-B111: a 4xx or a retry-exhausted entry must never just
      // vanish — persist it (badge count) as it is classified, instead of a
      // bare dequeue.
      notifyFailed: addFailedAction,
    });

    for (const id of result.delivered) dequeue(id);
    for (const id of result.retriedIds) incrementRetry(id);
    for (const record of result.failedActions) dequeue(record.action.id);

    // ONE alert for the whole drain, naming the work that was lost. Alerting
    // per record stacked a modal per stale entry on reconnect, each captioned
    // with a bare method + URL — see describeFailedDrain.
    if (result.failedActions.length > 0) {
      const { title, message } = describeFailedDrain(result.failedActions);
      alertInfo(title, message);
    }

    syncing.current = false;
    setSyncing(false);
  };

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const online = !!(state.isConnected && state.isInternetReachable !== false);
      setOnline(online);
      if (online && queue.length > 0) {
        runDrain(queue);
      }
    });
    return () => unsubscribe();
  }, [queue]);

  return {
    isOnline,
    queueLength: queue.length,
    failedCount,
    failedActions,
    clearFailedAction,
    clearFailedActions,
  };
}
