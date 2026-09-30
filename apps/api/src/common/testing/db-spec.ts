// One guard everywhere (#2204): the shared helper, NOT a hostname allowlist a `?host=` query walks past.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isLocalDbTarget, LOCAL_DB_HOSTS } = require("../../../scripts/lib/local-db-target.cjs") as {
  isLocalDbTarget: (url: unknown) => boolean;
  LOCAL_DB_HOSTS: string[];
};

export function requireLocalDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DB-backed specs need DATABASE_URL — run `npm run local:test:db`");
  // No CI escape hatch: CI's postgres service is reachable at `localhost`, so the refusal never
  // needed one — and a `RUN_DB_SPECS=ci` bypass would disable the guard exactly where these
  // specs run unattended against whatever DATABASE_URL the job happens to carry.
  if (!isLocalDbTarget(url)) {
    let named = "";
    try {
      named = ` ${new URL(url).hostname}`; // the host only, never the credentials
    } catch {
      /* unparseable: nothing to name */
    }
    throw new Error(
      `Refusing to run DB-backed specs against a target that is not provably local (host${named}; ` +
        `allowed: ${LOCAL_DB_HOSTS.join(", ")}; host/hostaddr/service overrides, multi-host and socket targets are refused)`,
    );
  }
  return url;
}

export function describeDb(name: string, fn: () => void): void {
  // A silently-skipped lane reports green with zero executed tests — the failure mode this
  // lane exists to close. An unset RUN_DB_SPECS is therefore a hard error, not a skip.
  if (!process.env.RUN_DB_SPECS) {
    throw new Error(
      "DB-backed specs invoked without RUN_DB_SPECS — run them through npm run local:test:db (or the CI lane)",
    );
  }
  describe(name, fn);
}

/** Anything with a pg-style `query` (a `pg` Client or Pool). */
export interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * T6: the `<table>_tenantId_nn` CHECK constraints refuse a NULL `tenantId` on the 56 guarded tables.
 * A spec that plants LEGACY NULL-tenant rows on purpose (a backfill / normaliser / repair-report
 * spec) must lift the guard on exactly the tables it needs for the duration of the file. Returns
 * the function that puts them back (as NOT VALID: the spec has just deleted its rows, and a
 * re-validating scan is not its job). A guard that is not present (a DB migrated without T6) is
 * neither dropped nor re-added. Call the restore FIRST in `afterAll` (it is NOT VALID, so the rows the spec has not yet deleted cannot make it fail, and a throwing cleanup can no longer leave the DB without its guard).
 */
export async function relaxTenantIdGuards(
  db: PgQueryable,
  tables: string[],
): Promise<() => Promise<void>> {
  const { rows } = await db.query(
    `SELECT c.conrelid::regclass::text AS tbl, c.conname
       FROM pg_constraint c WHERE c.conname = ANY($1::text[])`,
    [tables.map((t) => `${t}_tenantId_nn`)],
  );
  const present = rows.map((r) => ({ tbl: String(r.tbl), name: String(r.conname) }));
  for (const g of present) await db.query(`ALTER TABLE ${g.tbl} DROP CONSTRAINT "${g.name}"`);
  return async () => {
    for (const g of present) {
      await db.query(`ALTER TABLE ${g.tbl} DROP CONSTRAINT IF EXISTS "${g.name}"`);
      await db.query(
        `ALTER TABLE ${g.tbl} ADD CONSTRAINT "${g.name}" CHECK ("tenantId" IS NOT NULL) NOT VALID`,
      );
    }
  };
}
