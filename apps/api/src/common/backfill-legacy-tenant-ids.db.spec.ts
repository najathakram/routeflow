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
 * D9–D11 cover the unattended-write flags (`--only-test-tenants` + the restricted `--confirm`).
 * All three are only meaningful against a real database, because the guard's input is a slug
 * READ from `Tenant`: D9 seeds a complete graph in a NON-approved tenant and proves the batch is
 * refused with exit 3 and zero writes in `--live` AND in `--dry-run`; D10 proves the phrase's row
 * count is a real check, not a formality; D11 drives the D7 production shape end to end with no
 * TTY and no `BACKFILL_CONFIRM_TOKEN` — only the owner's own two flags.
 *
 * D8 covers the SECOND task, `--deactivate-orphan-users` (owner decision 2026-09-05: deactivate,
 * never delete). Everything that matters about it is only true against a real database — that the
 * listing's WHERE hides SUPER_ADMINs and tenanted users rather than merely refusing them, that
 * `--live` writes the schema's inactive status onto exactly one row and moves nothing else, that
 * the row is still THERE afterwards, and that a second run has nothing to do.
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
// D8's own rows: the one repairable orphan, the platform account the WHERE must hide, and a
// perfectly ordinary tenanted user that must never be in scope at all.
const USER_ORPHAN_ADMIN = `${ID_PREFIX}user-orphan-admin`;
const USER_ORPHAN_SUPER = `${ID_PREFIX}user-orphan-super`;
const USER_TENANTED = `${ID_PREFIX}user-tenanted`;
// D9's negative control for `--only-test-tenants`: a tenant whose slug matches NONE of the
// approved patterns, standing in for a client tenant. `acme-` is the repo's placeholder prefix
// (CLAUDE.md forbids naming a real client anywhere), and `assertTestTenant` is deliberately NOT
// called on it — being un-approved is the entire point. It exists only inside this spec's own
// transaction of the local compose database (`requireLocalDatabaseUrl` refuses any other host)
// and D9 deletes its whole graph before the next case runs.
const NONTEST_TENANT_ID = `${ID_PREFIX}tenant-nontest`;
const NONTEST_TENANT_SLUG = "acme-widgets-e2eguard";
const NONTEST_ROUTE_ID = `${ID_PREFIX}route-nontest`;
const NONTEST_RUN_ID = `${ID_PREFIX}run-nontest`;
const NONTEST_STOP_ID = `${ID_PREFIX}stop-nontest`;
const NONTEST_RUN_STOP = `${ID_PREFIX}runstop-nontest`;
// D10's row (the count-mismatch case) and D11's happy-path graph.
const STOP_E = `${ID_PREFIX}stop-e`;
const RUN_STOP_E = `${ID_PREFIX}runstop-e`;
const RUN_3_ID = `${ID_PREFIX}run-3`;
const STOP_F = `${ID_PREFIX}stop-f`;
const STOP_G = `${ID_PREFIX}stop-g`;
const RUN_STOP_F = `${ID_PREFIX}runstop-f`;
const RUN_STOP_G = `${ID_PREFIX}runstop-g`;

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

  /** The ids the orphan-user task would deactivate, read back through its own `--json` report. */
  function okUserIds(): string[] {
    const res = runCli(["--deactivate-orphan-users", "--json"]);
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout) as { rows: { id: string; verdict: string }[] };
    return report.rows.filter((r) => r.verdict === "ok").map((r) => r.id);
  }

  async function userRowOf(
    userId: string,
  ): Promise<{ status: string; tenantId: string | null; deletedAt: Date | null }> {
    const { rows } = await db.query(
      'SELECT "status", "tenantId", "deletedAt" FROM "User" WHERE "id" = $1',
      [userId],
    );
    // The row still EXISTING is half of what D8 proves — this tool deactivates, never deletes.
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function seedUser(id: string, role: string, status: string, tenantId: string | null) {
    // email/username are unique per (tenantId, …) and are never read back by anything here; they
    // exist only because the columns are NOT NULL. Nothing the tool prints may contain them.
    await db.query(
      `INSERT INTO "User" ("id","email","username","role","status","createdAt","updatedAt","tenantId")
       VALUES ($1,$2,$3,$4::"UserRole",$5::"UserStatus", now(), now(), $6)`,
      [id, `${id}@example.invalid`, id, role, status, tenantId],
    );
  }

  async function seedTenantedRouteStop(
    id: string,
    stopNumber: number,
    routeId: string = ROUTE_ID,
    tenantId: string = TENANT_ID,
  ) {
    await db.query(
      `INSERT INTO "RouteStop" ("id","routeId","stopNumber","createdAt","updatedAt","tenantId")
       VALUES ($1,$2,$3, now(), now(), $4)`,
      [id, routeId, stopNumber, tenantId],
    );
  }

  /** A NULL-tenant `RouteRun` hanging off `routeId` — the production shape D7/D11 exercise. */
  async function seedNullRun(id: string, routeId: string = ROUTE_ID) {
    await db.query(
      `INSERT INTO "RouteRun" ("id","routeId","scheduledDate","createdAt","updatedAt","tenantId")
       VALUES ($1,$2, now(), now(), now(), NULL)`,
      [id, routeId],
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
    await db.query('DELETE FROM "User" WHERE "id" LIKE $1', [`${ID_PREFIX}%`]);
    await db.query('DELETE FROM "RouteRunStop" WHERE "id" LIKE $1', [`${ID_PREFIX}%`]);
    await db.query('DELETE FROM "RouteRun" WHERE "id" LIKE $1', [`${ID_PREFIX}%`]);
    await db.query('DELETE FROM "RouteStop" WHERE "id" LIKE $1', [`${ID_PREFIX}%`]);
    await db.query('DELETE FROM "Route" WHERE "id" LIKE $1', [`${ID_PREFIX}%`]);
    // By prefix, not by id: D9's negative-control tenant is deleted in the case itself, and this
    // is the net that removes it (and any future sibling) if that case ever fails part-way.
    await db.query('DELETE FROM "Tenant" WHERE "id" LIKE $1', [`${ID_PREFIX}%`]);
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
    await seedNullRun(RUN_2_ID);
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

  it("D8 --deactivate-orphan-users: the NULL-tenant TENANT_ADMIN is deactivated, nothing else is", async () => {
    // The prod shape (census 2026-09-05): NULL-tenant users are three SUPER_ADMINs, which are
    // platform accounts and correct as they are, and three April-2026 TENANT_ADMIN leftovers that
    // would 401 at login. The tenanted user is the control: it is not NULL-tenant and must never
    // be in scope, however the WHERE is later edited.
    await seedUser(USER_ORPHAN_ADMIN, "TENANT_ADMIN", "ACTIVE", null);
    await seedUser(USER_ORPHAN_SUPER, "SUPER_ADMIN", "ACTIVE", null);
    await seedUser(USER_TENANTED, "OPERATOR", "ACTIVE", TENANT_ID);

    // Whole-database, like the tenant cases: a compose DB carrying somebody else's NULL-tenant
    // user fails this test rather than getting it deactivated.
    expect(okUserIds().sort()).toEqual([USER_ORPHAN_ADMIN]);

    const report = runCli(["--deactivate-orphan-users"]);
    expect(report.status).toBe(0);
    expect(report.stdout).toContain(`User ${USER_ORPHAN_ADMIN} role=TENANT_ADMIN status=ACTIVE`);
    expect(report.stdout).toContain("-> ok");
    // The SUPER_ADMIN and the tenanted user are not refused — they are never listed at all,
    // because the listing's own WHERE excludes them.
    expect(report.stdout).not.toContain(USER_ORPHAN_SUPER);
    expect(report.stdout).not.toContain(USER_TENANTED);
    // Output discipline, proven on real rows: no email, username or name reaches stdout.
    expect(report.stdout).not.toContain("@example.invalid");
    expect(report.stdout).toMatch(/User\s+ok=1 refused=0/);
    expect((await userRowOf(USER_ORPHAN_ADMIN)).status).toBe("ACTIVE");

    const dry = runCli(["--deactivate-orphan-users", "--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("the 1 statement(s) --live would execute");
    expect(dry.stdout).toContain(
      'UPDATE "User" SET "status" = $1, "updatedAt" = now() WHERE "id" = $2 ' +
        'AND "tenantId" IS NULL AND "role" <> \'SUPER_ADMIN\' AND "status" = $3',
    );
    expect(dry.stdout).toContain("$1 = INACTIVE");
    expect(dry.stdout).toContain(`$2 = ${USER_ORPHAN_ADMIN}`);
    expect(dry.stdout).toContain("$3 = ACTIVE");
    expect((await userRowOf(USER_ORPHAN_ADMIN)).status).toBe("ACTIVE");

    const res = runCli(["--deactivate-orphan-users", "--live", "--backup-attested", ATTESTATION], {
      BACKFILL_CONFIRM_TOKEN: "DEACTIVATE 1 USERS",
    });

    expect(res.status).toBe(0);
    expect(res.stderr).toContain("WARNING: test override BACKFILL_CONFIRM_TOKEN active");
    expect(res.stdout).toContain("=== APPLIED ===");

    // Deactivated, NEVER deleted: the row is still there, still NULL-tenant, still not
    // soft-deleted — only its status moved, and only to the schema's inactive value.
    const after = await userRowOf(USER_ORPHAN_ADMIN);
    expect(after.status).toBe("INACTIVE");
    expect(after.deletedAt).toBeNull();
    expect(after.tenantId).toBeNull();
    // and nothing else moved
    expect((await userRowOf(USER_ORPHAN_SUPER)).status).toBe("ACTIVE");
    expect((await userRowOf(USER_TENANTED)).status).toBe("ACTIVE");

    // re-runnable: the `"status" = $3` guard makes a second pass a no-op
    expect(okUserIds()).toEqual([]);
    const again = runCli(
      ["--deactivate-orphan-users", "--live", "--backup-attested", ATTESTATION],
      { BACKFILL_CONFIRM_TOKEN: "DEACTIVATE 0 USERS" },
    );
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("nothing to do");
    expect((await userRowOf(USER_ORPHAN_ADMIN)).status).toBe("INACTIVE");
  });

  it("D9 --only-test-tenants: a target row in a NON-test tenant refuses the batch, exit 3, zero writes", async () => {
    // A complete graph in an un-approved tenant: Route, RouteStop and a TENANTED RouteRun (so the
    // stop is `ok` on its own merits and the ONLY thing that can stop it is the guard), plus the
    // NULL-tenant RouteRunStop the tool would repair.
    await db.query(
      `INSERT INTO "Tenant" ("id","slug","name","createdAt","updatedAt")
       VALUES ($1,$2,$3, now(), now())`,
      [NONTEST_TENANT_ID, NONTEST_TENANT_SLUG, `Backfill guard spec ${RUN_SUFFIX}`],
    );
    await db.query(
      `INSERT INTO "Route" ("id","name","createdAt","updatedAt","tenantId")
       VALUES ($1,$2, now(), now(), $3)`,
      [NONTEST_ROUTE_ID, `Backfill guard route ${RUN_SUFFIX}`, NONTEST_TENANT_ID],
    );
    await seedTenantedRouteStop(NONTEST_STOP_ID, 1, NONTEST_ROUTE_ID, NONTEST_TENANT_ID);
    await db.query(
      `INSERT INTO "RouteRun" ("id","routeId","scheduledDate","createdAt","updatedAt","tenantId")
       VALUES ($1,$2, now(), now(), now(), $3)`,
      [NONTEST_RUN_ID, NONTEST_ROUTE_ID, NONTEST_TENANT_ID],
    );
    await seedNullRunStop(NONTEST_RUN_STOP, NONTEST_STOP_ID, 1, NONTEST_RUN_ID);

    // Without the flag the row is a perfectly ordinary repair candidate — which is what makes
    // the refusal below attributable to the guard and to nothing else.
    expectOnlyOurOkRows([NONTEST_RUN_STOP]);

    const res = runCli([
      "--live",
      "--only-test-tenants",
      "--confirm",
      "BACKFILL 1 ROWS",
      "--backup-attested",
      ATTESTATION,
    ]);

    expect(res.status).toBe(3);
    const combined = res.stdout + res.stderr;
    expect(combined).toContain("--only-test-tenants refuses this batch");
    expect(combined).toContain(`RouteRunStop ${NONTEST_RUN_STOP}`);
    expect(combined).toContain(`tenantSlug=${NONTEST_TENANT_SLUG}`);
    expect(combined).toContain("NOTHING was written");
    // no transaction was ever opened
    expect(res.stdout).not.toContain("=== APPLIED ===");
    expect(await tenantIdOf(NONTEST_RUN_STOP)).toBeNull();

    // The guard is the same in --dry-run, so the preflight the owner reads is the live gate.
    const dry = runCli(["--dry-run", "--only-test-tenants"]);
    expect(dry.status).toBe(3);
    expect(dry.stdout).toContain("=== REFUSED — --only-test-tenants ===");
    expect(dry.stdout).not.toContain("statement(s) --live would execute");
    expect(await tenantIdOf(NONTEST_RUN_STOP)).toBeNull();

    // Clean up this case's own graph so the later cases' ok sets are exactly their own rows.
    await db.query('DELETE FROM "RouteRunStop" WHERE "id" = $1', [NONTEST_RUN_STOP]);
    await db.query('DELETE FROM "RouteRun" WHERE "id" = $1', [NONTEST_RUN_ID]);
    await db.query('DELETE FROM "RouteStop" WHERE "id" = $1', [NONTEST_STOP_ID]);
    await db.query('DELETE FROM "Route" WHERE "id" = $1', [NONTEST_ROUTE_ID]);
    await db.query('DELETE FROM "Tenant" WHERE "id" = $1', [NONTEST_TENANT_ID]);
  });

  it("D10 --confirm with the wrong count: exit 3 and the test-tenant row is untouched", async () => {
    // Same approved tenant as everything else here, so the guard PASSES and the only thing left
    // to refuse the run is the phrase's row count — that is what this case pins.
    await seedTenantedRouteStop(STOP_E, 5);
    await seedNullRunStop(RUN_STOP_E, STOP_E, 5);
    expectOnlyOurOkRows([RUN_STOP_E]);

    const res = runCli([
      "--live",
      "--only-test-tenants",
      "--confirm",
      "BACKFILL 99 ROWS",
      "--backup-attested",
      ATTESTATION,
    ]);

    expect(res.status).toBe(3);
    expect(res.stderr).toContain("confirmation text did not match");
    expect(res.stdout).not.toContain("=== APPLIED ===");
    expect(await tenantIdOf(RUN_STOP_E)).toBeNull();

    // never written, so removing it is enough to leave D11 a clean ok set
    await db.query('DELETE FROM "RouteRunStop" WHERE "id" = $1', [RUN_STOP_E]);
    await db.query('DELETE FROM "RouteStop" WHERE "id" = $1', [STOP_E]);
  });

  it("D11 --only-test-tenants --confirm: the D7 shape is repaired unattended, then is a no-op", async () => {
    // The production shape again (a NULL-tenant run with two NULL-tenant stops), this time driven
    // with NO TTY and NO BACKFILL_CONFIRM_TOKEN — only the two new flags.
    await seedTenantedRouteStop(STOP_F, 6);
    await seedTenantedRouteStop(STOP_G, 7);
    await seedNullRun(RUN_3_ID);
    await seedNullRunStop(RUN_STOP_F, STOP_F, 1, RUN_3_ID);
    await seedNullRunStop(RUN_STOP_G, STOP_G, 2, RUN_3_ID);

    expectOnlyOurOkRows([RUN_3_ID, RUN_STOP_F, RUN_STOP_G]);

    // The slug the guard judges is printed on every target line, in every mode.
    const dry = runCli(["--dry-run", "--only-test-tenants"]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain(`tenantSlug=${TENANT_SLUG}`);
    expect(dry.stdout).toContain("the 3 statement(s) --live would execute");
    expect(dry.stdout).toContain(`[1] UPDATE "RouteRun" SET "tenantId"`);
    expect(await runTenantIdOf(RUN_3_ID)).toBeNull();

    const res = runCli([
      "--live",
      "--only-test-tenants",
      "--confirm",
      "BACKFILL 3 ROWS",
      "--backup-attested",
      ATTESTATION,
    ]);

    expect(res.status).toBe(0);
    // the owner's own flag did the confirming — not the jest-only token
    expect(res.stderr).not.toContain("BACKFILL_CONFIRM_TOKEN");
    expect(res.stdout).toContain("=== APPLIED ===");
    expect(res.stdout).toMatch(/RouteRun\s+1/);
    expect(res.stdout).toMatch(/RouteRunStop\s+2/);
    expect(await runTenantIdOf(RUN_3_ID)).toBe(TENANT_ID);
    expect(await tenantIdOf(RUN_STOP_F)).toBe(TENANT_ID);
    expect(await tenantIdOf(RUN_STOP_G)).toBe(TENANT_ID);

    // re-runnable, unattended, with the count the second pass computes for itself
    expectOnlyOurOkRows([]);
    const again = runCli([
      "--live",
      "--only-test-tenants",
      "--confirm",
      "BACKFILL 0 ROWS",
      "--backup-attested",
      ATTESTATION,
    ]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("nothing to do");
  });
});
