import { useEffect, useRef } from "react";
import NetInfo from "@react-native-community/netinfo";
import { useOfflineQueue } from "../store/offlineQueue";
import { apiClient } from "../lib/api-client";

const MAX_RETRIES = 3;

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
      try {
        await apiClient.request({
          method: action.method,
          url: action.endpoint,
          data: action.body,
        });
        dequeue(action.id);
      } catch {
        incrementRetry(action.id);
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
