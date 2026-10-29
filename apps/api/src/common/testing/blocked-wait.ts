/**
 * Test-only: the one place a DB spec asks Postgres "which backends are blocked, and by whom".
 *
 * Why one helper (W-1003, #3691): `pg_stat_activity` is read from a per-transaction stats snapshot.
 * A poller that runs on a connection inside an open transaction (the usual `t2` holder in an
 * interleave spec) keeps seeing the first snapshot, so a backend that blocks later stays invisible
 * for the whole wait and the spec reports "not blocked" on a slow host. Every probe here clears the
 * snapshot first, on whatever connection the caller polls from, so no spec has to remember it.
 * `blocked-wait-inventory.spec.ts` fails if a spec asks `pg_blocking_pids` outside this file.
 */

/** A pg `Pool`, `Client` or `PoolClient`; anything with `query(sql, params)`. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** One blocked backend and the pids it waits behind. */
export interface BlockedBackend {
  pid: number;
  blockers: number[];
}

export interface BlockedFilter {
  /** Only backends blocked by this pid. Without it: every blocked backend in this database. */
  holderPid?: number;
  /** With `holderPid`: also backends blocked by a backend that is itself blocked by the holder. */
  transitive?: boolean;
  /** Never report these pids (for example a backend already accounted for). */
  excludePids?: number[];
}

export interface WaitOptions extends BlockedFilter {
  timeoutMs?: number;
  intervalMs?: number;
  /** Wait for at least this many blocked backends (default 1). */
  atLeast?: number;
  /** Stop early (returning `[]`) once this is true, before the next probe. */
  until?: () => boolean;
}

/** Drops the cached stats snapshot of the connection `db` queries on. */
export async function clearStatSnapshot(db: Queryable): Promise<void> {
  // `::text`: the function returns void, which Prisma `$queryRaw` cannot deserialize.
  await db.query("SELECT pg_stat_clear_snapshot()::text");
}

/** Blocked backends right now, read live (the snapshot is cleared first). */
export async function blockedBackends(
  db: Queryable,
  filter: BlockedFilter = {},
): Promise<BlockedBackend[]> {
  await clearStatSnapshot(db);
  const exclude = filter.excludePids ?? [];
  const params: unknown[] = [];
  let where: string;
  if (filter.holderPid === undefined) {
    where = `a.datname = current_database() AND a.pid <> pg_backend_pid()
             AND cardinality(pg_blocking_pids(a.pid)) > 0`;
  } else {
    params.push(filter.holderPid);
    where = filter.transitive
      ? `a.pid IN (
           WITH RECURSIVE w(pid) AS (
             SELECT s.pid FROM pg_stat_activity s WHERE $1::int = ANY(pg_blocking_pids(s.pid))
             UNION
             SELECT s.pid FROM pg_stat_activity s JOIN w ON w.pid = ANY(pg_blocking_pids(s.pid))
           ) SELECT pid FROM w)`
      : "$1::int = ANY(pg_blocking_pids(a.pid))";
  }
  if (exclude.length > 0) {
    params.push(exclude);
    where += ` AND NOT (a.pid = ANY($${params.length}::int[]))`;
  }
  const { rows } = await db.query(
    `SELECT a.pid, pg_blocking_pids(a.pid) AS blockers FROM pg_stat_activity a WHERE ${where}`,
    params,
  );
  return rows.map((r) => ({ pid: Number(r.pid), blockers: (r.blockers ?? []).map(Number) }));
}

/** Pids of the blocked backends right now. */
export async function blockedPids(db: Queryable, filter: BlockedFilter = {}): Promise<number[]> {
  return (await blockedBackends(db, filter)).map((b) => b.pid);
}

/**
 * Polls until `atLeast` (default 1) backends are blocked (per the filter) and returns them. On
 * timeout it returns the last list seen (`[]` if none); `[]` when `until()` turns true first.
 * Always probes at least once.
 */
export async function waitUntilBlocked(
  db: Queryable,
  opts: WaitOptions = {},
): Promise<BlockedBackend[]> {
  const { timeoutMs = 4_000, intervalMs = 25, atLeast = 1, until, ...filter } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (until?.()) return [];
    // eslint-disable-next-line no-await-in-loop
    const blocked = await blockedBackends(db, filter);
    if (blocked.length >= atLeast) return blocked;
    if (Date.now() >= deadline) return blocked;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** True once some backend is genuinely waiting on a lock held by `holderPid`. */
export async function waitUntilBlockedBy(
  db: Queryable,
  holderPid: number,
  opts: Omit<WaitOptions, "holderPid"> = {},
): Promise<boolean> {
  return (await waitUntilBlocked(db, { ...opts, holderPid })).length > 0;
}

/** Adapts a `PrismaClient` (or interactive-transaction client) to {@link Queryable}. */
export function prismaQueryable(client: {
  $queryRawUnsafe(sql: string, ...values: unknown[]): Promise<unknown>;
}): Queryable {
  return {
    async query(sql, params = []) {
      return { rows: (await client.$queryRawUnsafe(sql, ...params)) as any[] };
    },
  };
}
