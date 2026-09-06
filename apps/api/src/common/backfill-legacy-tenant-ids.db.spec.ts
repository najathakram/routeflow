/**
 * Close-out re-check (2026-09-05), DB lane — `apps/api/scripts/backfill-legacy-tenant-ids.mjs`
 * executed against a REAL Postgres, so the paths that actually touch data are proven rather
 * than described.
 *
 * The sibling `backfill-legacy-tenant-ids-script.spec.ts` covers the pure classifiers and the
 * argument refusals with no database at all. What it cannot cover is the half that matters on
 * the day the owner runs this: that report and `--dry-run` leave the row untouched, that
 * `--live` actually writes the derived tenant, that a second `--live` is a no-op, and that a
 * mismatched confirmation writes nothing. Those only exist against a database.
 *
 * D7 covers the shape production actually has (2026-09-05): the stop's parent `RouteRun` is
 * ITSELF NULL-tenant, so the run is repaired from its `Route` first and its stops follow in the
 * same transaction — with the `--dry-run` listing proving the parent statement really comes first.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`) — run it through
 * `npm run local:test:db`, which points DATABASE_URL at the compose Postgres and sets
 * RUN_DB_SPECS. `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * SAFETY. Every row this file creates carries an `e2e-backfill-` id prefix inside a throwaway
 * `e2e-backfill-*` tenant (`assertTestTenant`), and teardown deletes exactly those in FK order.
 * The CLI itself scans the WHOLE database, so before each `--live` case the spec asserts that
 * the ok set is exactly its own seeded row — a compose database carrying somebody else's
 * NULL-tenant rows fails the test instead of repairing them. (It is fail-safe even without the
 * assertion: the typed confirmation embeds the row COUNT, so an unexpected extra row makes the
 * token mismatch and the run exits 3 having written nothing.)
 */
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { Client } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(API_DIR, "scripts/backfill-legacy-tenant-ids.mjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
const ID_PREFIX = `e2e-backfill-${RUN_SUFFIX}-`;
const TENANT_ID = `${ID_PREFIX}tenant`;
const TENANT_SLUG = assertTestTenant(
  `e2e-backfill-${RUN_SUFFIX}`,
  "backfill-legacy-tenant-ids.db.spec.ts",
);
const ROUTE_ID = `${ID_PREFIX}route`;
const RUN_ID = `${ID_PREFIX}run`;
const STOP_A = `${ID_PREFIX}stop-a`;
const STOP_B = `${ID_PREFIX}stop-b`;
const RUN_STOP_A = `${ID_PREFIX}runstop-a`;
const RUN_STOP_B = `${ID_PREFIX}runstop-b`;
// D7's own graph: a SECOND run that is itself NULL-tenant, hanging off the same tenanted Route.
const RUN_2_ID = `${ID_PREFIX}run-2`;
const STOP_C = `${ID_PREFIX}stop-c`;
const STOP_D = `${ID_PREFIX}stop-d`;
const RUN_STOP_C = `${ID_PREFIX}runstop-c`;
const RUN_STOP_D = `${ID_PREFIX}runstop-d`;

const ATTESTATION = "spec";

describeDb("backfill-legacy-tenant-ids.mjs — real Postgres (report / dry-run / live)", () => {
  // Nothing env-dependent at collection time (db-lane.db.spec.ts's rule): Jest evaluates a
  // skipped describe body, so the connection and the URL read both live in hooks.
  let db: Client;
  let databaseUrl: string;

  function runCli(args: string[], extraEnv: Record<string, string> = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
    // The Railway proxy pair wins over DATABASE_URL in lib/railway-db-url.mjs; strip both
    // families so this child can only ever resolve the local URL asserted above.
    for (const key of Object.keys(env)) {
      if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) delete env[key];
    }
    env.DATABASE_URL = databaseUrl;
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd: API_DIR,
      encoding: "utf8",
      env,
      timeout: 120_000,
    });
  }

  /** The ids the tool would repair, read back through its own `--json` report. */
  function okRowIds(): string[] {
    const res = runCli(["--json"]);
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout) as {
      rows: { table: string; id: string; verdict: string }[];
    };
    return report.rows.filter((r) => r.verdict === "ok").map((r) => r.id);
  }

  /** Fails loudly rather than letting a `--live` case repair a row this spec did not seed. */
  function expectOnlyOurOkRows(expected: string[]): void {
    expect(okRowIds().sort()).toEqual([...expected].sort());
  }

  async function tenantIdOf(runStopId: string): Promise<string | null> {
    const { rows } = await db.query('SELECT "tenantId" FROM "RouteRunStop" WHERE "id" = $1', [
      runStopId,
    ]);
    expect(rows).toHaveLength(1);
    return rows[0].tenantId;
  }

  async function runTenantIdOf(runId: string): Promise<string | null> {
    const { rows } = await db.query('SELECT "tenantId" FROM "RouteRun" WHERE "id" = $1', [runId]);
    expect(rows).toHaveLength(1);
    return rows[0].tenantId;
  }

  async function seedNullRunStop(
    id: string,
    routeStopId: string,
    stopNumber: number,
    routeRunId: string = RUN_ID,
  ) {
    await db.query(
      `INSERT INTO "RouteRunStop"
         ("id","routeRunId","routeStopId","stopNumber","podPhotoUrls","createdAt","updatedAt","tenantId")
       VALUES ($1,$2,$3,$4,'{}'::text[], now(), now(), NULL)`,
      [id, routeRunId, routeStopId, stopNumber],
    );
  }

  async function seedTenantedRouteStop(id: string, stopNumber: number) {
    await db.query(
      `INSERT INTO "RouteStop" ("id","routeId","stopNumber","createdAt","updatedAt","tenantId")
       VALUES ($1,$2,$3, now(), now(), $4)`,
      [id, ROUTE_ID, stopNumber, TENANT_ID],
    );
  }

  beforeAll(async () => {
    databaseUrl = requireLocalDatabaseUrl();
    db = new Client({ connectionString: databaseUrl });
    await db.connect();

    // Ancestors all carry the tenant — that is what makes the NULL child's tenant derivable.
    await db.query(
      `INSERT INTO "Tenant" ("id","slug","name","createdAt","updatedAt")
       VALUES ($1,$2,$3, now(), now())`,
      [TENANT_ID, TENANT_SLUG, `Backfill spec ${RUN_SUFFIX}`],
    );
    await db.query(
      `INSERT INTO "Route" ("id","name","createdAt","updatedAt","tenantId")
       VALUES ($1,$2, now(), now(), $3)`,
      [ROUTE_ID, `Backfill spec route ${RUN_SUFFIX}`, TENANT_ID],
    );
    await seedTenantedRouteStop(STOP_A, 1);
    await seedTenantedRouteStop(STOP_B, 2);
    await db.query(
      `INSERT INTO "RouteRun" ("id","routeId","scheduledDate","createdAt","updatedAt","tenantId")
       VALUES ($1,$2, now(), now(), now(), $3)`,
      [RUN_ID, ROUTE_ID, TENANT_ID],
    );
    // Row A only — row B is seeded later, by the wrong-token case, so the earlier cases see
    // exactly one repairable row and can pin the confirmation phrase's count.
    await seedNullRunStop(RUN_STOP_A, STOP_A, 1);
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    // FK order, and never anything outside this run's own id prefix.
    await db.query('DELETE FROM "RouteRunStop" WHERE "id" LIKE $1', [`${ID_PREFIX}%`]);
    await db.query('DELETE FROM "RouteRun" WHERE "id" LIKE $1', [`${ID_PREFIX}%`]);
    await db.query('DELETE FROM "RouteStop" WHERE "id" LIKE $1', [`${ID_PREFIX}%`]);
    await db.query('DELETE FROM "Route" WHERE "id" LIKE $1', [`${ID_PREFIX}%`]);
    await db.query('DELETE FROM "Tenant" WHERE "id" = $1', [TENANT_ID]);
    await db.end();
  }, 120_000);

  it("D1 report: lists the NULL-tenant stop as ok and writes nothing", async () => {
    const res = runCli([]);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`RouteRunStop  id=${RUN_STOP_A}`);
    expect(res.stdout).toContain("[ok]");
    expect(res.stdout).toContain(`-> tenantId=${TENANT_ID}`);
    // read-only in fact, not only in the banner
    expect(await tenantIdOf(RUN_STOP_A)).toBeNull();
  });

  it("D2 --dry-run: prints the one guarded UPDATE with its bound values and still writes nothing", async () => {
    const res = runCli(["--dry-run"]);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain(
      'UPDATE "RouteRunStop" SET "tenantId" = $1 WHERE "id" = $2 AND "tenantId" IS NULL',
    );
    expect(res.stdout).toContain(`$1 = ${TENANT_ID}`);
    expect(res.stdout).toContain(`$2 = ${RUN_STOP_A}`);
    // exactly one statement — a blanket repair would show a different count
    expect(res.stdout).toContain("the 1 statement(s) --live would execute");
    expect(await tenantIdOf(RUN_STOP_A)).toBeNull();
  });

  it("D3 --live: with the attestation and the matching confirmation, the row gains the run's tenant", async () => {
    expectOnlyOurOkRows([RUN_STOP_A]);

    const res = runCli(["--live", "--backup-attested", ATTESTATION], {
      BACKFILL_CONFIRM_TOKEN: "BACKFILL 1 ROWS",
    });

    expect(res.status).toBe(0);
    // the override is announced, never silent
    expect(res.stderr).toContain("WARNING: test override BACKFILL_CONFIRM_TOKEN active");
    expect(res.stdout).toContain("=== APPLIED ===");
    expect(await tenantIdOf(RUN_STOP_A)).toBe(TENANT_ID);
  });

  it("D4 --live again: nothing left to repair — exit 0, no transaction opened", async () => {
    expectOnlyOurOkRows([]);

    const res = runCli(["--live", "--backup-attested", ATTESTATION], {
      BACKFILL_CONFIRM_TOKEN: "BACKFILL 0 ROWS",
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("nothing to do");
    expect(res.stdout).not.toContain("=== APPLIED ===");
    expect(await tenantIdOf(RUN_STOP_A)).toBe(TENANT_ID);
  });

  it("D5 --live with a mismatched confirmation: exit 3 and the row is untouched", async () => {
    await seedNullRunStop(RUN_STOP_B, STOP_B, 2);
    expectOnlyOurOkRows([RUN_STOP_B]);

    const res = runCli(["--live", "--backup-attested", ATTESTATION], {
      BACKFILL_CONFIRM_TOKEN: "BACKFILL ALL THE ROWS",
    });

    expect(res.status).toBe(3);
    expect(res.stderr).toContain("confirmation text did not match");
    expect(await tenantIdOf(RUN_STOP_B)).toBeNull();
  });

  it("D6 --live on a non-TTY with no token: exit 3 before any write", async () => {
    // spawnSync gives the child a pipe, not a terminal, so this is the unattended case the
    // TTY check exists for — and BACKFILL_CONFIRM_TOKEN is deliberately absent here.
    const res = runCli(["--live", "--backup-attested", ATTESTATION]);

    expect(res.status).toBe(3);
    expect(res.stderr).toContain("interactive TTY");
    expect(await tenantIdOf(RUN_STOP_B)).toBeNull();
  });

  it("D7 --live: a NULL-tenant RouteRun is repaired from its Route first, then its own stops", async () => {
    // D5/D6 deliberately left RUN_STOP_B NULL to prove the refusal paths. Repair it by hand so
    // the ok set below is exactly D7's own three rows and the confirmation count is pinnable.
    await db.query('UPDATE "RouteRunStop" SET "tenantId" = $1 WHERE "id" = $2', [
      TENANT_ID,
      RUN_STOP_B,
    ]);

    // The production shape (2026-09-05): the Route carries the tenant and the RouteStops agree,
    // but the RUN was never backfilled — so before the cascade every stop under it was
    // `refuse: parent missing` on account of its own parent, and could never be repaired.
    await seedTenantedRouteStop(STOP_C, 3);
    await seedTenantedRouteStop(STOP_D, 4);
    await db.query(
      `INSERT INTO "RouteRun" ("id","routeId","scheduledDate","createdAt","updatedAt","tenantId")
       VALUES ($1,$2, now(), now(), now(), NULL)`,
      [RUN_2_ID, ROUTE_ID],
    );
    await seedNullRunStop(RUN_STOP_C, STOP_C, 1, RUN_2_ID);
    await seedNullRunStop(RUN_STOP_D, STOP_D, 2, RUN_2_ID);

    expectOnlyOurOkRows([RUN_2_ID, RUN_STOP_C, RUN_STOP_D]);

    const report = runCli([]);
    expect(report.status).toBe(0);
    expect(report.stdout).toContain(`RouteRun  id=${RUN_2_ID}`);
    expect(report.stdout).toContain("stopCount=2");
    expect(report.stdout).toContain(`RouteRunStop  id=${RUN_STOP_C}`);
    // the stops are ok only BECAUSE this same batch repairs their run — and say so
    expect(report.stdout).toContain("(via run repaired in this batch)");
    // padEnd(16) sets the column width, so match the summary loosely rather than on spaces
    expect(report.stdout).toMatch(/RouteRun\s+ok=1 refused=0/);
    expect(report.stdout).toMatch(/RouteRunStop\s+ok=2 refused=0/);
    expect(await runTenantIdOf(RUN_2_ID)).toBeNull();

    // Parent before child, proven on the real listing rather than only in the unit spec.
    const dry = runCli(["--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("the 3 statement(s) --live would execute");
    expect(dry.stdout).toContain(`[1] UPDATE "RouteRun" SET "tenantId"`);
    expect(dry.stdout).toContain(`[2] UPDATE "RouteRunStop" SET "tenantId"`);
    expect(await runTenantIdOf(RUN_2_ID)).toBeNull();

    const res = runCli(["--live", "--backup-attested", ATTESTATION], {
      BACKFILL_CONFIRM_TOKEN: "BACKFILL 3 ROWS",
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("=== APPLIED ===");
    expect(await runTenantIdOf(RUN_2_ID)).toBe(TENANT_ID);
    expect(await tenantIdOf(RUN_STOP_C)).toBe(TENANT_ID);
    expect(await tenantIdOf(RUN_STOP_D)).toBe(TENANT_ID);

    // re-runnable: the whole cascade is now a no-op
    expectOnlyOurOkRows([]);
    const again = runCli(["--live", "--backup-attested", ATTESTATION], {
      BACKFILL_CONFIRM_TOKEN: "BACKFILL 0 ROWS",
    });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("nothing to do");
  });
});
