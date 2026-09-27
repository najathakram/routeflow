/**
 * #2265: the driver's offline decisions read connectivity LIVE, at the moment they decide —
 * never a value captured in a render closure (stale by the time an awaited request returns).
 *
 * Two independent signals, and EITHER one saying "offline" wins:
 *  - `browserOnline`: TanStack's `onlineManager.isOnline()` — on the Expo web export it follows
 *    the window's online/offline events; on native it stays true (no window events).
 *  - `netInfoOnline`: the offline queue store's `isOnline`, written only by useNetworkSync's
 *    NetInfo listener. It defaults to true and is a POSITIVE offline signal only — so `undefined`
 *    (never written) counts as online, exactly like the api-client interceptor reads it.
 *
 * Pure so the decision is pinned in jest without a network stack.
 */
export function isLiveOnline(signals: {
  browserOnline: boolean;
  netInfoOnline: boolean | undefined;
}): boolean {
  return signals.browserOnline && signals.netInfoOnline !== false;
}

/**
 * TanStack's default `networkMode: "online"` PAUSES a query/mutation while its onlineManager
 * says offline, so a paused call never rejects and the caller's offline branch (the api-client
 * interceptor's queue for a mutation, the invoice-later fallback for a fetch) never runs until
 * reconnect. Driver-critical calls opt out: they always hit the network and FAIL fast offline,
 * which is exactly what their catch paths are written for (#2265).
 */
export const DRIVER_CRITICAL_NETWORK_MODE = "always" as const;
