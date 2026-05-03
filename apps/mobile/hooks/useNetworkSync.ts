import { useEffect, useRef } from "react";
import NetInfo from "@react-native-community/netinfo";
import { useOfflineQueue } from "../store/offlineQueue";
import { apiClient } from "../lib/api-client";
import { showToast } from "../lib/toast";

const MAX_RETRIES = 3;

// RF-170: matches /route-runs/{runId}/stops/{stopId}/complete
const STOP_COMPLETE_RE = /\/route-runs\/([^/]+)\/stops\/[^/]+\/complete/;

export function useNetworkSync() {
  const { queue, isOnline, setOnline, setSyncing, dequeue, incrementRetry } = useOfflineQueue();
  const syncing = useRef(false);

  const drainQueue = async (currentQueue: typeof queue) => {
    if (syncing.current || currentQueue.length === 0) return;
    syncing.current = true;
    setSyncing(true);

    for (const action of currentQueue) {
      if (action.retries >= MAX_RETRIES) {
        dequeue(action.id);
        continue;
      }

      // RF-170: before submitting a stop-completion, verify the run is still active.
      // If it was cancelled while the driver was offline, silently drop the action.
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

      try {
        await apiClient.request({
          method: action.method,
          url: action.endpoint,
          data: action.body,
          ...(action.headers ? { headers: action.headers } : {}),
        });
        dequeue(action.id);
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        // CRIT-05: Discard non-retriable client errors immediately; only retry server errors
        if (status !== undefined && status >= 400 && status < 500) {
          dequeue(action.id);
        } else {
          incrementRetry(action.id);
        }
      }
    }

    syncing.current = false;
    setSyncing(false);
  };

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const online = !!(state.isConnected && state.isInternetReachable !== false);
      setOnline(online);
      if (online && queue.length > 0) {
        drainQueue(queue);
      }
    });
    return () => unsubscribe();
  }, [queue]);

  return { isOnline, queueLength: queue.length };
}
