import type { PoolClient, PoolConfig } from "pg";

/** The statement every app connection runs once, right after it connects. */
export const APP_SESSION_TIME_ZONE_SQL = "SET TIME ZONE 'UTC'";

/**
 * Row 361: ONE place that pins the session TIME ZONE of every Postgres connection the app opens to UTC.
 *
 * The schema's DateTime columns are `timestamp without time zone` holding UTC, and the Prisma pg adapter reads a
 * `timestamptz` as UTC. On a server (or role / database) whose `timezone` is not UTC, `clock_timestamp()` and
 * `now()` therefore come back shifted by the offset and every window check (the day close, the tender, ...)
 * reads the wrong instant. Pinning the SESSION makes `dbClockNow` and every timestamptz read independent of the
 * server's setting. A no-op on a UTC server (Railway).
 *
 * pg-pool's `onConnect` hook, not a `connect` event listener and not the `-c timezone=UTC` startup option:
 *  - it is AWAITED before the client is handed out, so the pin is in force for the first query by construction
 *    and a failed pin FAILS CLOSED (pg-pool ends the client and the acquire rejects) rather than leaving an
 *    unpinned connection in the pool;
 *  - a plain `SET` works through a connection pooler that refuses unknown startup parameters. (Under a
 *    transaction-mode pooler a session `SET` does not stick; the advisory session locks already require session
 *    pooling, so this changes nothing there.)
 *
 * Every `new Pool(` in production source is built from `utcPoolConfig(...)` (pinned by `pg-session.spec.ts`):
 * the Prisma adapter's pool (`PrismaService`) and the advisory-lock pools (`db-locks.ts`).
 */
export function utcPoolConfig<C extends PoolConfig>(
  config: C,
): C & { onConnect: (client: PoolClient) => Promise<void> } {
  const prior = config.onConnect;
  return {
    ...config,
    onConnect: async (client: PoolClient) => {
      await client.query(APP_SESSION_TIME_ZONE_SQL);
      await Promise.resolve(prior?.(client));
    },
  };
}
