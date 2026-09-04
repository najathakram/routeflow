/**
 * Cross-process critical sections on PostgreSQL advisory locks.
 *
 * WHY A DEDICATED CONNECTION: a session-level advisory lock lives on the connection that took
 * it, so the whole critical section has to run on ONE pinned connection. Prisma's pool is
 * private (`PrismaService` builds its own `pg.Pool` for `@prisma/adapter-pg` and never hands a
 * client out), and Prisma exposes no "pin this connection" API — an interactive transaction is
 * the only pinning primitive it offers, and the merge paths must NOT be wrapped in one (the
 * writes they guard run their own transactions with their own timeouts). So this module keeps
 * its own small `pg.Pool` (max 8) purely for lock sessions: connect → lock → run → unlock →
 * release. It never runs application queries, so it cannot deadlock against the Prisma pool.
 *
 * WHY THE KEY IS (hashtext(family), hashtext(key)): `pg_advisory_lock` addresses a lock by two
 * 32-bit ints in ONE global namespace. Hashing the family into the first int and the key into
 * the second means an "order-merge" lock on some id can never collide with a different
 * subsystem's lock on the same id — each family gets its own effective namespace, and both
 * halves are computed by Postgres so every replica derives the identical pair.
 *
 * `wait` blocks up to `waitMs` (Postgres raises SQLSTATE 55P03 on `lock_timeout`, mapped to
 * `LockTimeoutError`); `try` returns `{ acquired: false }` instead of waiting. `fn` never runs
 * without the lock held.
 *
 * RESIDUAL (known, bounded, not fixed here): a `wait` caller pins one pool slot for the WHOLE
 * time it waits, so contention on a single hot customer can occupy all 8 slots — and every other
 * customer's merge then fails `pool.connect()` on `connectionTimeoutMillis` and surfaces as
 * `LockUnavailableError` → 503, even though its own key was free. Contention on one key
 * degrading an unrelated key is the residual. It is bounded by the callers' wait budgets (the
 * staff controller waits 10s precisely to cap how long a slot can be held by a loser), and pool
 * sizing is deliberately left alone until PR-2b adds the cron leader lock — that PR changes the
 * demand on this pool, so `max` is re-derived once, there, against both workloads rather than
 * guessed at twice. A pinned client also carries its own `error` listener (added at checkout,
 * removed before release) so a socket failure mid-lock destroys the connection instead of
 * crashing the process the way an idle client's unhandled `error` event would.
 */

import { Logger } from "@nestjs/common";
import { Pool, type PoolClient } from "pg";

export type LockMode = "wait" | "try";
export interface AdvisoryLockOptions {
  family: string;
  key: string;
  mode: LockMode;
  waitMs?: number;
}
export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

export class LockTimeoutError extends Error {
  constructor(
    public readonly family: string,
    public readonly key: string,
    public readonly waitMs: number,
  ) {
    super(`advisory lock ${family}:${key} not acquired within ${waitMs}ms`);
    this.name = "LockTimeoutError";
  }
}
export class LockUnavailableError extends Error {
  constructor(public readonly cause: unknown) {
    super("advisory lock connection unavailable");
    this.name = "LockUnavailableError";
  }
}

const logger = new Logger("db-locks");

let pool: Pool | null = null;
function lockPool(): Pool {
  if (!pool) {
    // `connectionTimeoutMillis` matters here because every checkout is pinned for the whole
    // critical section: without it `pool.connect()` queues with NO timer once `max` is reached
    // (pg-pool `connect()`), so an overflowing caller would hang unbounded instead of surfacing
    // as LockUnavailableError → 503.
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 8,
      connectionTimeoutMillis: 5_000,
    });
    // pg-pool re-emits an idle client's socket error on the pool; with no listener an
    // EventEmitter "error" throws as an uncaught exception and takes the API process down.
    // The client is already removed from the pool by the time this runs — log and nothing else.
    pool.on("error", (err) =>
      logger.error(`db-locks: idle lock connection error — ${err?.message ?? err}`),
    );
  }
  return pool;
}
/** Test hook: drop the lazily-created pool so a suite can start clean. */
export async function _resetLockPoolForTests(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.end();
}

const LOCK_SQL = {
  wait: "SELECT pg_advisory_lock(hashtext($1), hashtext($2))",
  try: "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS ok",
} as const;
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))";

const DEFAULT_WAIT_MS = 20_000;

/**
 * Run `fn` inside the advisory lock named by `(family, key)`, on a dedicated pinned connection.
 *
 * Resolves `{ acquired: true, value }` when `fn` ran, or `{ acquired: false }` when `mode: "try"`
 * found the lock held (in which case `fn` is not called and no UNLOCK is issued). Rejects with
 * `LockTimeoutError` when a `wait` acquire hits `lock_timeout` (55P03), with `LockUnavailableError`
 * when the connection or its session setup fails, and with whatever `fn` threw otherwise — the
 * lock is always released first.
 */
export async function withAdvisoryLock<T>(
  opts: AdvisoryLockOptions,
  fn: () => Promise<T>,
): Promise<LockResult<T>> {
  // Validate BEFORE taking a connection. `hashtext(NULL)` is NULL, so a missing key would
  // acquire a lock on (family, NULL) — a namespace every other bad caller shares — and the
  // critical section would run believing it was serialized. Failing loudly here also means a
  // programming error never consumes one of the 8 pool slots.
  if (
    typeof opts.family !== "string" ||
    opts.family.length === 0 ||
    typeof opts.key !== "string" ||
    opts.key.length === 0
  ) {
    throw new TypeError("withAdvisoryLock: family and key must be non-empty strings");
  }
  // `SET lock_timeout` is a utility statement: it takes no bind parameters, so the value has to
  // be interpolated. Only a validated finite integer ever reaches the string.
  const waitMs = Number.isFinite(opts.waitMs)
    ? Math.max(1, Math.floor(opts.waitMs as number))
    : DEFAULT_WAIT_MS;
  let client: PoolClient;
  try {
    client = await lockPool().connect();
  } catch (e: any) {
    logger.error(`db-locks: could not obtain a lock connection — ${e?.message ?? e}`);
    throw new LockUnavailableError(e);
  }
  const args = [opts.family, opts.key];
  // The value `release(err)` reports when the connection must be destroyed. `failure` alone
  // cannot say whether one was recorded (a thrown `undefined`, or any non-Error, is
  // indistinguishable from "no failure"), so `hasFailure` tracks that separately — and the FIRST
  // failure recorded wins, so a later unlock error never masks what actually went wrong.
  let failure: unknown;
  let hasFailure = false;
  const recordFailure = (e: unknown) => {
    if (hasFailure) return;
    failure = e;
    hasFailure = true;
  };
  // `release(err)` DESTROYS the connection instead of returning it to the pool. Set ONLY where
  // the session may still hold state — see the `finally` at the bottom for the exhaustive list.
  let destroy = false;
  // A socket-level failure while this client is checked out would otherwise emit "error" on a
  // listener-less EventEmitter (pg-pool removes its idle listener at checkout) and crash the process.
  const onClientError = (err: Error) => {
    logger.error(
      `[db-locks] pinned connection error family=${opts.family} key=${opts.key}: ${err.message}`,
    );
    recordFailure(err);
    destroy = true;
  };
  client.on("error", onClientError);
  try {
    try {
      await client.query(`SET lock_timeout = '${waitMs}ms'`);
    } catch (e) {
      recordFailure(e);
      destroy = true;
      throw new LockUnavailableError(e);
    }
    let acquired = true;
    try {
      const res = await client.query(LOCK_SQL[opts.mode], args);
      if (opts.mode === "try") acquired = res.rows[0]?.ok === true;
    } catch (e: any) {
      if (e?.code === "55P03") {
        // A `lock_timeout` means the acquire gave up WITHOUT taking the lock, on a connection
        // that is otherwise healthy: there is nothing to unlock and nothing to destroy. So this
        // path deliberately leaves `destroy` false and takes the clean `release()` below —
        // destroying here would burn a good connection on every contended merge and shrink the
        // 8-slot pool exactly when it is busiest. `destroy` stays reserved for the two cases
        // where the session may still hold state: a failed unlock, and a connection/session-setup
        // error (which may have left the session mid-statement or the socket half-dead).
        logger.warn(`db-locks: lock timeout after ${waitMs}ms for ${opts.family}:${opts.key}`);
        throw new LockTimeoutError(opts.family, opts.key, waitMs);
      }
      recordFailure(e);
      destroy = true;
      throw e;
    }
    // `try` that lost the race returns BEFORE the inner try, so no UNLOCK is ever issued for a
    // lock this call does not hold (unlocking someone else's lock would be a no-op plus a
    // warning, but the query would still be wrong).
    if (!acquired) return { acquired: false };
    try {
      return { acquired: true, value: await fn() };
    } catch (e) {
      // Deliberately NOT `destroy`: the `finally` below unlocks either way, and an unlock that
      // lands leaves the session holding nothing — a thrown `fn` is an APPLICATION failure, not
      // a sick connection, and destroying on it would burn one of the 8 slots every time a merge
      // hits a validation error or a dead dependency. The failure is still recorded, because it
      // is the value `release(err)` must report if the unlock then fails too.
      recordFailure(e);
      throw e;
    } finally {
      try {
        await client.query(UNLOCK_SQL, args);
      } catch (e: any) {
        logger.error(
          `db-locks: unlock failed for ${opts.family}:${opts.key} — ${e?.message ?? e}; connection will be destroyed`,
        );
        recordFailure(e);
        destroy = true;
      }
    }
  } finally {
    // release(err) DESTROYS the connection instead of returning it to the pool, so the server
    // drops any session lock still held on it. That is reserved for the three cases where this
    // session may still hold state: an unlock that never landed, a connection/session-setup
    // error, and a socket-level error reported by the `onClientError` listener above. Everything
    // else — including a thrown `fn` whose unlock succeeded, and a 55P03 that never took the lock
    // — releases CLEANLY with no argument (a truthy arg would destroy a healthy connection).
    client.removeListener("error", onClientError);
    if (destroy) client.release(failure instanceof Error ? failure : new Error(String(failure)));
    else client.release();
  }
}
