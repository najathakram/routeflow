"use client";

import * as React from "react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";

/**
 * #2091: one refetch per burst. When many images fail together (a throttled catalog page), each
 * would otherwise invalidate the same list query — N failures, N list refetches. While a refetch
 * for a key is in flight, every other failure on that key joins it instead of starting another.
 */
const inFlight = new WeakMap<QueryClient, Map<string, Promise<void>>>();

function refetchOnce(queryClient: QueryClient, queryKey: readonly unknown[]): Promise<void> {
  let byKey = inFlight.get(queryClient);
  if (!byKey) {
    byKey = new Map();
    inFlight.set(queryClient, byKey);
  }
  const id = JSON.stringify(queryKey);
  const running = byKey.get(id);
  if (running) return running;
  const p = queryClient
    .invalidateQueries({ queryKey: [...queryKey] })
    .catch(() => undefined)
    .finally(() => byKey!.delete(id));
  byKey.set(id, p);
  return p;
}

/**
 * #2091: a product image that recovers ONCE from a failed load.
 *
 * On its first `error` it refetches the query that minted its URL (coalesced per burst — see
 * `refetchOnce`) and, once that settles, remounts the `<img>` so the browser really requests the
 * image again against the fresh data (re-setting the SAME `src` issues no request, and a stable
 * URL is identical for 12 h). Exactly one retry per mounted image: a second failure stays failed,
 * so a persistently broken image can never loop refetches.
 */
export function RetryableImg({
  staleQueryKey,
  onError,
  ...img
}: React.ImgHTMLAttributes<HTMLImageElement> & {
  /** The query (or key prefix) whose data carries this image's URL. */
  staleQueryKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = React.useState(0);
  const retried = React.useRef(false);
  return (
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    <img
      key={attempt}
      {...img}
      onError={(e) => {
        onError?.(e);
        if (retried.current) return;
        retried.current = true;
        void refetchOnce(queryClient, staleQueryKey).then(() => setAttempt(1));
      }}
    />
  );
}
