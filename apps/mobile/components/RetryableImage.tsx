import { useRef, useState } from "react";
import { Image, type ImageProps } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { refetchOnce } from "../lib/refetch-once";

/**
 * #2091: a product image that recovers ONCE from a failed load (the mobile twin of web's
 * `components/RetryableImg.tsx`).
 *
 * On its first `onError` it refetches the query that minted its URL — coalesced per burst, so
 * many images failing together refetch the list ONCE (`lib/refetch-once.ts`) — and, once that
 * settles, remounts the `Image` so it really loads again against the fresh data (a stable URL is
 * identical for 12 h, and the same `source` does not reload). Exactly one retry per mounted
 * image: a second failure stays failed, so a broken image never loops refetches.
 */
export function RetryableImage({
  staleQueryKey,
  onError,
  ...props
}: ImageProps & {
  /** The query (or key prefix) whose data carries this image's URL. */
  staleQueryKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  const retried = useRef(false);
  return (
    <Image
      key={attempt}
      {...props}
      onError={(e) => {
        onError?.(e);
        if (retried.current) return;
        retried.current = true;
        void refetchOnce(queryClient, staleQueryKey).then(() => setAttempt(1));
      }}
    />
  );
}
