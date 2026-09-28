/**
 * #2091: one refetch per burst. When many product images fail together (a throttled catalog),
 * each would otherwise invalidate the same list query — N failures, N refetches. While a refetch
 * for a key is in flight, every other failure on that key joins it instead of starting another.
 * Same rule as web's `components/RetryableImg.tsx#refetchOnce`.
 */
export interface InvalidatingClient {
  invalidateQueries(filters: { queryKey: unknown[] }): Promise<unknown>;
}

const inFlight = new WeakMap<InvalidatingClient, Map<string, Promise<void>>>();

export function refetchOnce(
  queryClient: InvalidatingClient,
  queryKey: readonly unknown[],
): Promise<void> {
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
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => byKey!.delete(id));
  byKey.set(id, p);
  return p;
}
