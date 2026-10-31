import { waitUntilBlocked, type BlockedBackend, type Queryable } from "./blocked-wait";

/**
 * Test-only: wait for a write to be GENUINELY blocked on a lock, by the database's own answer, not by a clock.
 *
 * The shape this replaces: start the write, `await setTimeout(300)`, then assert "it has not landed yet". On a
 * loaded host the write may not even have connected after 300 ms (the assertion passes vacuously: nothing was
 * waiting on the lock yet), and it spends the write's own wait budget on the idle wait. Here the test waits until
 * the database reports the write waiting behind a holder, then asserts and releases at once, so load can only make
 * the wait longer, never the assertion wrong. The probe is `blocked-wait.ts` (the one place that asks Postgres).
 *
 * `settled` is the write's promise. If it fails before it ever blocked, its error is what the test reports; if it
 * finishes without ever blocking, the lock held nothing back, which is a failure of the thing under test. The
 * ceiling is a safety stop for a test that would otherwise hang, not a window the assertion depends on.
 */
export const BLOCKED_WRITE_CEILING_MS = 120_000;

export async function awaitBlockedWrite(
  db: Queryable,
  settled: Promise<unknown>,
  opts: { ceilingMs?: number; intervalMs?: number } = {},
): Promise<BlockedBackend[]> {
  const ceilingMs = opts.ceilingMs ?? BLOCKED_WRITE_CEILING_MS;
  const outcome = { done: false, failed: false, error: undefined as unknown };
  settled.then(
    () => {
      outcome.done = true;
    },
    (error) => {
      outcome.done = true;
      outcome.failed = true;
      outcome.error = error;
    },
  );
  const blocked = await waitUntilBlocked(db, {
    timeoutMs: ceilingMs,
    intervalMs: opts.intervalMs,
    until: () => outcome.done,
  });
  if (blocked.length > 0) return blocked;
  if (outcome.failed) throw outcome.error;
  if (outcome.done)
    throw new Error("the write finished without ever blocking: nothing held it back");
  throw new Error(`no backend blocked within ${ceilingMs}ms`);
}
