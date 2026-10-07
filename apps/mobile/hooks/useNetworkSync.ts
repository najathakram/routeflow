import { countLegacyNonAllowlisted } from "../lib/offline-allowlist";
import { useEffect, useRef } from "react";
import NetInfo from "@react-native-community/netinfo";
import { onlineManager } from "@tanstack/react-query";
import { useOfflineQueue, selectFailedActionCount, type QueuedAction } from "../store/offlineQueue";
import { apiClient } from "../lib/api-client";
import { showToast } from "../lib/toast";
import { alertInfo, chooseAction } from "../lib/confirm";
import { useAuthStore } from "../lib/auth-store";
import {
  drainQueue,
  buildReplayRequestConfig,
  describeFailedDrain,
  describeCreditsPendingDrain,
  nextDrainDelayMs,
  queriesToRefreshAfterDrain,
} from "../lib/queue-drain";
import { queryClient } from "../lib/query-client";
import { isLiveOnline } from "../lib/live-online";
import { resolveQueueIdentity, settleQueueOwnership } from "../lib/queue-identity";
import { inlineReturnDrainSettleRecords } from "../lib/inline-return-submit-key";
import { useInlineReturnSubmissionStore } from "../store/inlineReturnSubmissionStore";

/** B923: the legacy-replay count is logged once per app session. */
let legacyReplayLogged = false;

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
  const settleInlineReturnDrain = useInlineReturnSubmissionStore((s) => s.settleAfterDrain);
  // R6's badge leg: the drain-time alert is one-shot (dismissable, and it can
  // fire while the app is backgrounded), so the count has to stand on its own
  // until the operator acknowledges it — see components/OfflineBanner.tsx.
  const failedCount = useOfflineQueue(selectFailedActionCount);
  const syncing = useRef(false);
  // #2389 (tier 1): NetInfo's latest verdict + the backoff state for an unreachable drain. The
  // drain only ever runs when BOTH NetInfo and TanStack's onlineManager (window online/offline on
  // the web export) say online — a web NetInfo re-subscribe can report "connected" while the
  // browser is offline, and draining then dead-lettered a queued stop completion in ~0.2s.
  const netOnlineRef = useRef<boolean | undefined>(undefined);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const unreachedStreak = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveOnline = () =>
    isLiveOnline({ browserOnline: onlineManager.isOnline(), netInfoOnline: netOnlineRef.current });

  const runDrain = async (currentQueue: QueuedAction[]) => {
    if (syncing.current || currentQueue.length === 0) return;
    if (!liveOnline()) return; // #2389: never drain offline — offline time is not a retry

    // REG-B137: nothing is replayed under a session that does not own it.
    // With nobody signed in there is no token to replay under at all, so the
    // queue simply waits.
    const identity = resolveQueueIdentity();
    if (!identity) return;

    syncing.current = true;
    setSyncing(true);
    // #2389 Opus nit (c): a throw anywhere below must never leave `syncing` stuck true — that
    // would silently stop every later drain.
    try {
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
      // B923 ruling 5: entries persisted under the OLD "queue everything" default still replay. Count the
      // ones the allow-list no longer admits, once per app session, so we can see when it reaches zero.
      // Counts only (method + normalized path): never an id or a body.
      if (!legacyReplayLogged && remaining.length > 0) {
        legacyReplayLogged = true;
        const legacy = countLegacyNonAllowlisted(remaining);
        console.info(
          `[offline-queue] legacy non-allow-listed entries replayed this session: ${legacy.total}`,
          legacy.byEndpoint,
        );
      }

      const result = await drainQueue(remaining, {
        request: async (action) =>
          (await apiClient.request(buildReplayRequestConfig(action)))?.data,
        // REG-B143 / REG-B111: a 4xx or a retry-exhausted entry must never just
        // vanish — persist it (badge count) as it is classified, instead of a
        // bare dequeue.
        notifyFailed: addFailedAction,
      });

      for (const id of result.delivered) dequeue(id);
      // #2410: a delivered replay changed the run the route list reads — refresh it now, not on the
      // driver's next pull-to-refresh.
      const deliveredIds = new Set(result.delivered);
      for (const queryKey of queriesToRefreshAfterDrain(
        remaining.filter((a) => deliveredIds.has(a.id)),
      ))
        void queryClient.invalidateQueries({ queryKey });
      for (const id of result.retriedIds) incrementRetry(id);
      // #2389: unreached entries stay queued, retry counts untouched; try again on a bounded
      // backoff (the reconnect event below also re-triggers immediately). Never a hot loop.
      if (result.unreachedIds.length > 0) {
        const delay = nextDrainDelayMs(unreachedStreak.current);
        unreachedStreak.current += 1;
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null;
          void drainSafely(queueRef.current);
        }, delay);
      } else {
        unreachedStreak.current = 0;
      }
      for (const record of result.failedActions) dequeue(record.action.id);

      // SA-091b: a capture that lands (or is definitively refused) FROM THE OFFLINE QUEUE never
      // ran through useCaptureInlineReturn's onSuccess/onError, so its nonce would otherwise
      // survive forever and collide with the next genuine attempt on the same customer/order pair
      // — the same bug SA-091 fixed on the direct-submit path. `remaining` (not `owned` or
      // `currentQueue`) is deliberately the source for `attempted`: it is exactly the set drainQueue
      // actually ran against.
      settleInlineReturnDrain(
        inlineReturnDrainSettleRecords({
          delivered: result.delivered,
          failedActions: result.failedActions,
          attempted: remaining,
        }),
      );

      // B1205: a delivered order whose credit notes are still unapplied - say so (fixed copy) and,
      // for staff, offer to open the saved order. Drivers have no operator order route.
      if (result.creditsPending.length > 0) {
        const first = describeCreditsPendingDrain(result.creditsPending);
        const staff = useAuthStore.getState().user?.role !== "DRIVER";
        if (staff) {
          chooseAction(first.title, first.message, [
            { label: "Dismiss", style: "cancel" },
            {
              label: "Open order",
              onPress: () =>
                // Lazy: expo-router is not loadable in the pure-logic jest lane.
                void import("expo-router").then(({ router }) =>
                  router.push(`/(operator)/orders/${first.orderId}` as any),
                ),
            },
          ]);
        } else {
          alertInfo(first.title, first.message);
        }
      }

      // ONE alert for the whole drain, naming the work that was lost. Alerting
      // per record stacked a modal per stale entry on reconnect, each captioned
      // with a bare method + URL — see describeFailedDrain.
      if (result.failedActions.length > 0) {
        const { title, message } = describeFailedDrain(result.failedActions);
        alertInfo(title, message);
      }
    } finally {
      syncing.current = false;
      setSyncing(false);
    }
  };
  const drainSafely = (q: QueuedAction[]) =>
    runDrain(q).catch((e: unknown) => console.warn("[offline-queue] drain failed", e));

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const online = !!(state.isConnected && state.isInternetReachable !== false);
      netOnlineRef.current = online;
      setOnline(online);
      if (queue.length > 0) void drainSafely(queue); // runDrain gates on the LIVE online state
    });
    // #2389: the web export's reconnect arrives as the window "online" event, which TanStack's
    // onlineManager observes — NetInfo alone missed it, so a queued completion waited for the
    // next tap. Reconnect re-triggers the drain immediately.
    const unsubscribeOnline = onlineManager.subscribe((online) => {
      if (online && queue.length > 0) {
        unreachedStreak.current = 0;
        void drainSafely(queue);
      }
    });
    return () => {
      unsubscribe();
      unsubscribeOnline();
    };
  }, [queue]);

  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    [],
  );

  return {
    isOnline,
    queueLength: queue.length,
    failedCount,
    failedActions,
    clearFailedAction,
    clearFailedActions,
  };
}
