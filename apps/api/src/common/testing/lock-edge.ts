/**
 * Test-only helpers for the row-lock interleave specs (variant-assign-lock-order.db.spec.ts).
 *
 * CTID PITFALL: never match a row-lock waiter to a row through a stored `ctid`. An UPDATE writes a
 * new tuple version, so a ctid read before the editor's UPDATE goes stale, and which version the
 * waiter's tuple lock sits on depends on vacuum/pruning history (cold first rounds flaked). Identify
 * the edge by pids and the editor's transaction id instead.
 */

/** One `pg_locks` row of the blocked (assign) backend. */
export interface LockRow {
  locktype: string;
  granted: boolean;
  /** `relation::regclass::text`, or null for non-relation locks. */
  relation: string | null;
  /** `transactionid::text`, or null. */
  transactionid: string | null;
}

/**
 * True iff the backend is the FIRST row-lock waiter on a "Product" row the editor updated: it holds
 * a GRANTED heavyweight `tuple` lock on Product and waits (not granted) on the editor's
 * `transactionid`. Postgres queues a row-lock waiter exactly so. A not-granted tuple lock would mean
 * a second waiter behind another backend, which is not this interleave.
 */
export function isFirstWaiterOnEditorRow(rows: LockRow[], editorXid: string): boolean {
  const tupleGranted = rows.some(
    (r) => r.locktype === "tuple" && r.granted && /(^|\.)"?Product"?$/.test(r.relation ?? ""),
  );
  const tupleUngranted = rows.some((r) => r.locktype === "tuple" && !r.granted);
  const waitsOnEditor = rows.some(
    (r) => r.locktype === "transactionid" && !r.granted && r.transactionid === editorXid,
  );
  return tupleGranted && !tupleUngranted && waitsOnEditor;
}

/**
 * Polls `probe` every `intervalMs` until it returns a non-undefined value or `timeoutMs` elapses
 * (then returns undefined). Always runs the probe at least once.
 */
export async function pollUntil<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs = 4_000,
  intervalMs = 25,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) return undefined;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
