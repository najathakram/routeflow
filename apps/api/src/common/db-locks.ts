/**
 * Cross-process critical sections on PostgreSQL advisory locks.
 *
 * WHY A DEDICATED CONNECTION: a session-level advisory lock lives on the connection that took
 * it, so the whole critical section has to run on ONE pinned connection. Prisma's pool is
 * private (`PrismaService` builds its own `pg.Pool` for `@prisma/adapter-pg` and never hands a
 * client out), and Prisma exposes no "pin this connection" API — an interactive transaction is
 * the only pinning primitive it offers, and the merge paths must NOT be wrapped in one (the
 * writes they guard run their own transactions with their own timeouts). So this module keeps
 * its own small `pg.Pool`s (one per family, sized below) purely for lock sessions: connect →
 * lock → run → unlock → release. They never run application queries, so they cannot deadlock
 * against the Prisma pool.
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
 * WHY ONE POOL PER FAMILY (the sizing derivation): the three workloads have different hold
 * profiles, so they must not share slots. An `order-merge` checkout is request-path and short;
 * a `cron` checkout is a `@LeaderCron` tick (`./cron-lock.ts`, `mode: "try"`) whose LOSERS free
 * their slot at once but whose WINNER pins one for the WHOLE tick — full-tenant sweeps that run
 * for minutes. One shared pool therefore let the schedule starve the request path: 5 jobs share
 * the top of every hour (4 × `EVERY_HOUR` + `orders.cronSweepPendingOrders`), rising to 7 at
 * 02:00 UTC on the 1st (+ `billing-cron.applyScheduledDowngrades` +
 * `tobacco-report.generateMonthlyReports`), which left 3 slots for merges hourly and 1 on the
 * monthly peak — a merge finding none waits `connectionTimeoutMillis` and then 503s on a key
 * nobody was holding.
 *
 * `pools` keys one pool per family instead, each sized for its OWN peak, so the peak above is
 * bounded inside the family that causes it. `cron` gets `max: 12`: the monthly 7-holder peak plus
 * a straggling hourly sweep still holding its slot when the next hour's five fire must not
 * exhaust the pool, because a cron holder that cannot get a connection skips its tick outright.
 * `order-merge` keeps `max: 8` — its checkouts are request-path and short, and its real bound is
 * the callers' wait budgets, not the schedule. `billing` gets `max: 4`: like `order-merge` its
 * checkouts (`addon.service.ts`'s `enableAddon`, serialising the Stripe-item-create + row-upsert
 * window per `(tenantId, addonKey)`) are short and request-path, but toggling an add-on is a rare
 * admin/self-serve settings action, not a per-order hot path — nowhere near order-merge's
 * checkout volume — so 4 slots covers plausible concurrent enables across different tenants
 * without idling connections sized for a workload this family doesn't have; a caller that still
 * can't get a slot within its wait budget surfaces cleanly as a 503 to retry. `tenant-mirror`
 * (F3, review round, 2026-09-15) gets `max: 4` for the same reason as `billing`: its callers are
 * `createTenant()`/`updateTenantConfig()` (rare admin actions, one per source tenant) plus the
 * nightly `mirrorSync()` sweep, which holds at most ONE slot at a time — its own loop awaits each
 * tenant's `upsert()` serially, never fanning out. `mode: "try"`, matching the service's
 * best-effort contract: a caller that loses the race skips this sync rather than blocking a
 * live admin request, and the next sweep or admin action retries it. Worst case is therefore
 * 12 + 8 + 4 + 4 = 28 lock connections; with Prisma's pool (default 10) that is 38 — far
 * below Postgres's `max_connections`, so the split costs nothing it cannot pay for.
 * Exhausting the CRON pool surfaces as `LockUnavailableError`, which `@LeaderCron` turns into a
 * skipped tick plus a warn — never a request-path error. `LOCK_FAMILIES` is the closed
 * allow-list of families (they are code literals, never derived from data), enforced before any
 * connect, so a typo cannot silently stand up a FOURTH pool whose holders serialize against
 * nobody while reading as locked.
 *
 * RETIRED (F5 round 2 / N1, independent review round 2, PR-2, 2026-09-15): a fourth
 * `"idempotency"` family briefly lived here (round 1, `max: 6`) backing
 * `ReturnsService#create`'s check-then-create-then-save guard. The independent review judged a
 * whole dedicated 6-connection pool an unjustified extra failure surface for that one caller —
 * it now takes a TRANSACTION-scoped `pg_advisory_xact_lock` on its own transaction's connection
 * instead (`common/idempotency.service.ts#acquireLock`), needing no pool here at all. If a
 * future caller has a genuinely SESSION-scoped (not transaction-scoped) locking need, mirror
 * `billing`'s sizing reasoning rather than reusing this note.
 *
 * WHY KEEPALIVE (`keepAlive: true`, `keepAliveInitialDelayMillis: 30_000`, on BOTH families —
 * `pg` forwards both straight to the socket): a Postgres advisory lock lives with the SESSION,
 * and a cron leader's lock connection is SOCKET-IDLE for the whole tick — the tick's actual work
 * runs on the Prisma pool, so nothing is sent on the lock connection between
 * `pg_try_advisory_lock` and the `pg_advisory_unlock` minutes later. Any intermediate idle-reap
 * on that path (NAT table, load balancer, the platform's own network) would drop the session
 * silently; Postgres then releases the lock while the tick is still running, and the next
 * replica's election WINS a job that is already in flight — precisely the duplicate money run
 * `@LeaderCron` exists to prevent. TCP keepalive probes every 30 s keep the session provably
 * alive, so the lock is released only when the session really ends. `order-merge` gets the same
 * setting: its holds are short, but a reaped socket strands a merge there the same way.
 *
 * RESIDUAL (known, bounded, not fixed here): a `wait` caller pins one slot of ITS family's pool
 * for the WHOLE time it waits, so contention on a single hot customer can occupy all 8
 * order-merge slots — and every other customer's merge then fails `pool.connect()` on
 * `connectionTimeoutMillis` and surfaces as `LockUnavailableError` → 503, even though its own key
 * was free. Contention on one key degrading an unrelated key is the residual; it is now confined
 * to the family that caused it, and bounded by the callers' wait budgets (the staff controller
 * waits 10s precisely to cap how long a slot can be held by a loser).
 *
 * A pinned client also carries its own `error` listener (added at checkout,
 * removed before release) so a socket failure mid-lock destroys the connection instead of
 * crashing the process the way an idle client's unhandled `error` event would.
 */

import { ConflictException, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Pool, type PoolClient } from "pg";

export type LockMode = "wait" | "try";
/**
 * Every advisory-lock family this module will open a pool for. Families are code literals, never
 * derived from data, so the list is closed: `withAdvisoryLock` rejects anything else BEFORE it
 * connects (see the header's "WHY ONE POOL PER FAMILY").
 */
export const LOCK_FAMILIES = [
  "order-merge",
  "cron",
  "billing",
  "tenant-mirror",
  "demo-booking",
  "mailbox",
] as const;
export type LockFamily = (typeof LOCK_FAMILIES)[number];
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

// One pool per family, created on that family's first use. Sharing a pool across families let a
// cron tick that pins a slot for minutes starve the request-path merges — see the header.
const pools = new Map<string, Pool>();
/**
 * Per-family `max`, derived in the header's "WHY ONE POOL PER FAMILY": `cron` needs room for the
 * monthly 7-holder peak PLUS a straggling hourly sweep (a cron holder that finds no slot skips
 * its tick); `order-merge` checkouts are short and request-path with real checkout volume;
 * `billing` checkouts are the same short, request-path shape but a far rarer settings action, so
 * it gets a smaller pool rather than order-merge's size. Declared `number | undefined` so the
 * fallback below is a real branch: `withAdvisoryLock` rejects an unknown family before `lockPool`
 * is ever reached, so it is unreachable in practice.
 */
const POOL_MAX: Record<string, number | undefined> = {
  "order-merge": 8,
  cron: 12,
  billing: 4,
  "tenant-mirror": 4,
  // Public, anonymous, request-path and short (check-slot-then-create), same
  // shape as `billing`'s reasoning — but reachable by anyone on the internet
  // rather than an authenticated admin action, so it gets `billing`'s size
  // rather than `order-merge`'s: there is no real tenant base bounding how
  // many concurrent submissions arrive, but each holds its slot only for one
  // availability re-check + one insert.
  "demo-booking": 4,
  // `mailbox` (email-connect-google, PR-3): `MailboxSendService`'s lazy access-token
  // refresh, one checkout per connected-mailbox send that finds the cached access token
  // within 60s of expiry — request-path and short (one token POST + one row update), and
  // bounded by how many tenants have a connected mailbox AND are sending concurrently at
  // the exact moment their token expires, a narrower slice than `billing`'s per-tenant
  // admin actions. Same size as `billing`/`tenant-mirror` for the same reason: short,
  // request-path, no real hot-path volume.
  mailbox: 4,
};
const DEFAULT_POOL_MAX = 8;
function lockPool(family: string): Pool {
  let pool = pools.get(family);
  if (!pool) {
    // `connectionTimeoutMillis` matters here because every checkout is pinned for the whole
    // critical section: without it `pool.connect()` queues with NO timer once `max` is reached
    // (pg-pool `connect()`), so an overflowing caller would hang unbounded instead of surfacing
    // as LockUnavailableError → 503.
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: POOL_MAX[family] ?? DEFAULT_POOL_MAX,
      connectionTimeoutMillis: 5_000,
      // A lock connection is idle at the SOCKET for the whole critical section — a cron leader's
      // tick does its work on the Prisma pool — so an intermediate idle-reap would end the
      // session and release the advisory lock mid-tick, letting another replica win an election
      // for a job still running. See the header's "WHY KEEPALIVE".
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
    });
    // pg-pool re-emits an idle client's socket error on the pool; with no listener an
    // EventEmitter "error" throws as an uncaught exception and takes the API process down.
    // The client is already removed from the pool by the time this runs — log and nothing else.
    pool.on("error", (err) =>
      logger.error(`db-locks: idle ${family} lock connection error — ${err?.message ?? err}`),
    );
    pools.set(family, pool);
  }
  return pool;
}
/** Test hook: end and drop EVERY lazily-created pool so a suite can start clean. */
export async function _resetLockPoolForTests(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map((p) => p.end()));
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
  // programming error never consumes one of its family's pool slots.
  if (
    typeof opts.family !== "string" ||
    opts.family.length === 0 ||
    typeof opts.key !== "string" ||
    opts.key.length === 0
  ) {
    throw new TypeError("withAdvisoryLock: family and key must be non-empty strings");
  }
  // Closed allow-list, checked for the same reason and at the same point as the emptiness check
  // above: an unknown family would lazily stand up a POOL OF ITS OWN (8 more pinned connections)
  // whose holders serialize against nothing, so a typo would read as "locked" while running
  // concurrently with the family it meant to join.
  if (!(LOCK_FAMILIES as readonly string[]).includes(opts.family)) {
    throw new TypeError(
      `withAdvisoryLock: unknown lock family "${opts.family}" (expected one of ${LOCK_FAMILIES.join(", ")})`,
    );
  }
  // `SET lock_timeout` is a utility statement: it takes no bind parameters, so the value has to
  // be interpolated. Only a validated finite integer ever reaches the string.
  const waitMs = Number.isFinite(opts.waitMs)
    ? Math.max(1, Math.floor(opts.waitMs as number))
    : DEFAULT_WAIT_MS;
  let client: PoolClient;
  try {
    client = await lockPool(opts.family).connect();
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

/**
 * Tables `lockRowsNoWait` will take a row lock on. Closed list for the same reason
 * `LOCK_FAMILIES` is: the caller passes a code literal, never data, and a table name cannot be
 * bound as a parameter — so the SQL below is written out once PER TABLE instead of interpolating
 * an identifier at all.
 */
export const NOWAIT_LOCK_TABLES = ["RouteRunStop", "Invoice"] as const;
export type NoWaitLockTable = (typeof NOWAIT_LOCK_TABLES)[number];

/**
 * Take `FOR NO KEY UPDATE NOWAIT` on the given rows inside `tx`; a lock held by an in-flight
 * writer surfaces as 409 CONCURRENT_UPDATE (retryable) instead of a wait.
 *
 * What NOWAIT buys is exactly this much: the transaction never WAITS on these rows, so it cannot
 * deadlock while ACQUIRING them. It still HOLDS them for the rest of the tx — so this is not a
 * licence to take them out of order. Callers must take them in the same order as every other
 * writer of the same rows (Invoice LAST, after InvoicePayment/CreditNote — see
 * CreditNotesService.voidInvoice), or a later blocking lock can still close a cycle.
 *
 * NO KEY UPDATE, not FOR UPDATE, so a transaction merely holding an FK KEY SHARE on the row does
 * not trip it while a real UPDATE does. The busy path writes nothing — callers take this before
 * their first mutation.
 */
export async function lockRowsNoWait(
  tx: any,
  table: NoWaitLockTable,
  ids: string[],
  reason: string,
): Promise<void> {
  if (ids.length === 0) return;
  if (!(NOWAIT_LOCK_TABLES as readonly string[]).includes(table)) {
    throw new Error(
      `lockRowsNoWait: unknown table "${table}" (expected one of ${NOWAIT_LOCK_TABLES.join(", ")})`,
    );
  }
  try {
    // One literal statement per table rather than an interpolated identifier: the table name
    // never reaches the SQL from a value. This helper is the shared home of the lock — the
    // hand-written statements it replaced locked a single id (`WHERE id = $1`); it takes a set.
    if (table === "RouteRunStop") {
      await tx.$executeRaw`SELECT id FROM "RouteRunStop" WHERE id IN (${Prisma.join(ids)}) FOR NO KEY UPDATE NOWAIT`;
    } else {
      await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id IN (${Prisma.join(ids)}) FOR NO KEY UPDATE NOWAIT`;
    }
  } catch (err) {
    // Prisma surfaces the SQLSTATE on `meta.code` for a raw query, but not on every driver/error
    // shape — the message check is the fallback so a wrapped error is never mistaken for a real
    // failure and rethrown as a 500.
    const lockUnavailable =
      (err as any)?.meta?.code === "55P03" ||
      /55P03|could not obtain lock/i.test(String((err as any)?.message ?? ""));
    if (!lockUnavailable) throw err;
    throw new ConflictException({
      code: "CONCURRENT_UPDATE",
      reason,
      retryable: true,
      message: "Another update to this record is in progress. Try again in a moment.",
    });
  }
}
