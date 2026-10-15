/**
 * ONE FIFO lookup queue for every code that reaches the order builder outside the scan screen (a
 * wedge/USB scanner, a typed SKU + Enter, the single-shot camera overlay). Each code finishes -
 * lookup AND line commit - before the next one starts, so scans land in the order they were made and
 * two lookups can never race each other's merge. Unbounded on purpose: a counted scan must never be
 * dropped; a failure in one run never stalls the ones behind it.
 */
export function createSerialScanQueue<R>(run: (code: string) => Promise<R> | R) {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue(code: string): Promise<R> {
      const result = tail.then(() => run(code));
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
