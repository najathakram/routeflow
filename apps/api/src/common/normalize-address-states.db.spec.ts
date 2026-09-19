/**
 * DB lane — `apps/api/scripts/normalize-address-states.mjs` executed against a REAL Postgres, so
 * the paths that actually touch data are proven rather than described.
 *
 * The sibling `normalize-address-states-script.spec.ts` covers the pure classifier, the Google leg
 * (fake fetch), the write-list builder and the argument refusals with no database at all. What it
 * cannot cover is the half that matters on the day the owner runs this: that report and `--dry-run`
 * leave the rows untouched, that `--live` writes exactly the resolvable rows and only FLAGS the
 * rest, that a second `--live` is a no-op, that a mismatched confirmation writes nothing, that a
 * row that changes under the run rolls the WHOLE batch back (exit 4), and that
 * `--only-test-tenants` refuses a batch that reaches a non-approved tenant. Those only exist
 * against a database.
 *
 * Cases (D1..D13): D1 report is read-only and prints ids/verdicts only; D2 an unscoped report lists
 * the NULL-tenant row and never writes it; D3 --dry-run prints the exact guarded statements and
 * writes nothing; D4 the read-only session statement the script issues really rejects a write;
 * D5/D6 a wrong phrase / no TTY exit 3 with zero writes; D7 --live normalises exactly the
 * resolvable rows and flags the rest; D8 a second run is a no-op; D9 a row changed under the run
 * exits 4 and rolls everything back; D10 the guard refuses a non-approved tenant in every mode;
 * D11 the guard's happy path (unattended, test tenant); D12 an unknown --tenant-slug is exit 1;
 * D13 the --json document.
 *
 * NEVER CALLS GOOGLE. `runCli` strips GOOGLE_MAPS_API_KEY from the child's environment and no case
 * passes `--google`, so nothing in this file can send an address anywhere; the Google leg is
 * covered by the fake-fetch cases in the script spec.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`) — run it through
 * `npm run local:test:db`, which points DATABASE_URL at the compose Postgres and sets
 * RUN_DB_SPECS. `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * SAFETY. Every row this file creates carries a `qa-nas-` id prefix, and its tenant is a throwaway
 * `qa-nas-*` slug (`assertTestTenant`). The CLI scans the WHOLE database unless scoped, so every
 * case that can WRITE passes `--tenant-slug` for that throwaway tenant — a compose database
 * carrying somebody else's NULL-`stateCode` rows is never touched (only the read-only D2 runs
 * unscoped). The one inert refusal fixture is a tenant whose slug is deliberately NOT approved
 * (`zz-not-approved-*`); it exists only to be REFUSED by the guard, and teardown deletes it by
 * prefix in FK order.
 */
import { spawn, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { Client } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(API_DIR, "scripts/normalize-address-states.mjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
const ID_PREFIX = `qa-nas-${RUN_SUFFIX}-`;
const TENANT_ID = `${ID_PREFIX}tenant`;
const TENANT_SLUG = assertTestTenant(`qa-nas-${RUN_SUFFIX}`, "normalize-address-states.db.spec.ts");
const USER_ID = `${ID_PREFIX}user`;
const CUSTOMER_ID = `${ID_PREFIX}customer`;

// The inert refusal fixture: NOT an approved test-tenant slug, on purpose. `assertTestTenant` is
// deliberately not called on it — being un-approved is the entire point of D10.
const NOT_APPROVED_TENANT_ID = `${ID_PREFIX}tenant-zz`;
const NOT_APPROVED_SLUG = `zz-not-approved-${RUN_SUFFIX}`;
const NOT_APPROVED_USER_ID = `${ID_PREFIX}user-zz`;
const NOT_APPROVED_CUSTOMER_ID = `${ID_PREFIX}customer-zz`;
const NOT_APPROVED_ADDRESS_ID = `${ID_PREFIX}addr-zz`;

// Fixture address data: fake and distinctive, so a leak into an output is a plain substring match.
const FIX = { line1: "1 Nas-Spec Fixture Way", city: "Nasfixtureville", zip: "90909" };

const addrId = (n: number) => `${ID_PREFIX}addr-${n}`;
const A1 = addrId(1); // "tx"            -> RESOLVED_LOCAL_EXACT  TX
const A2 = addrId(2); // "N.Y."          -> RESOLVED_LOCAL_ALIAS  NY
const A3 = addrId(3); // "Texas, USA"    -> RESOLVED_LOCAL_ALIAS  TX
const A4 = addrId(4); // "Tejas"         -> unresolved, flagged
const A5 = addrId(5); // ""              -> unresolved (EMPTY), flagged
const A6 = addrId(6); // "Houston"       -> unresolved, flagged
const A7 = addrId(7); // stateCode = CA  -> NOT a candidate (control)
const A8 = addrId(8); // NULL tenant     -> reported, never written (control)

const ATTESTATION = "spec";
const PHRASE_6 = "NORMALIZE 6 ADDRESSES";

const SET_SQL =
  'UPDATE "CustomerAddress" SET "stateCode" = $1, "stateNeedsReview" = false, "updatedAt" = now() ' +
  'WHERE "id" = $2 AND "stateCode" IS NULL RETURNING "id"';
const FLAG_SQL =
  'UPDATE "CustomerAddress" SET "stateNeedsReview" = true, "updatedAt" = now() ' +
  'WHERE "id" = $1 AND "stateCode" IS NULL AND "stateNeedsReview" = false RETURNING "id"';

type Snap = { stateCode: string | null; stateNeedsReview: boolean; updatedAt: number };

describeDb("normalize-address-states.mjs — real Postgres (report / dry-run / live)", () => {
  // Nothing env-dependent at collection time (db-lane.db.spec.ts's rule): Jest evaluates a
  // skipped describe body, so the connection and the URL read both live in hooks.
  let db: Client;
  let databaseUrl: string;

  function cliEnv(extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
    // The Railway proxy pair wins over DATABASE_URL in lib/railway-db-url.mjs; strip both
    // families so this child can only ever resolve the local URL asserted above.
    for (const key of Object.keys(env)) {
      if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) delete env[key];
    }
    // No case in this file may reach Google: without the key `--google` is an exit-2 refusal.
    delete env.GOOGLE_MAPS_API_KEY;
    env.DATABASE_URL = databaseUrl;
    return env;
  }

  function runCli(args: string[], extraEnv: Record<string, string> = {}) {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd: API_DIR,
      encoding: "utf8",
      env: cliEnv(extraEnv),
      timeout: 120_000,
    });
  }

  /** Every case that can WRITE is scoped to this spec's own throwaway tenant. */
  const scoped = (...args: string[]) => ["--tenant-slug", TENANT_SLUG, ...args];

  async function insertTenantGraph(
    tenantId: string,
    slug: string,
    userId: string,
    customerId: string,
  ) {
    await db.query(
      `INSERT INTO "Tenant" ("id","slug","name","createdAt","updatedAt")
       VALUES ($1,$2,$3, now(), now())`,
      [tenantId, slug, `Normalize spec ${RUN_SUFFIX}`],
    );
    // email/username exist only because the columns are NOT NULL; nothing the tool prints may
    // contain them.
    await db.query(
      `INSERT INTO "User" ("id","email","username","role","status","createdAt","updatedAt","tenantId")
       VALUES ($1,$2,$3,'CUSTOMER'::"UserRole",'ACTIVE'::"UserStatus", now(), now(), $4)`,
      [userId, `${userId}@example.invalid`, userId, tenantId],
    );
    await db.query(
      `INSERT INTO "Customer" ("id","userId","businessName","contactName","createdAt","updatedAt","tenantId")
       VALUES ($1,$2,$3,$4, now(), now(), $5)`,
      [customerId, userId, `Nas spec business ${RUN_SUFFIX}`, "Nas Spec", tenantId],
    );
  }

  /** `n` orders the listing (createdAt is `now() - 1 day + n seconds`); updatedAt is a day old. */
  async function seedAddress(
    id: string,
    n: number,
    state: string,
    opts: {
      tenantId?: string | null;
      customerId?: string;
      stateCode?: string | null;
      needsReview?: boolean;
    } = {},
  ) {
    await db.query(
      `INSERT INTO "CustomerAddress"
         ("id","customerId","label","line1","city","state","zip","isDefault","addressType",
          "stateCode","stateNeedsReview","createdAt","updatedAt","tenantId")
       VALUES ($1,$2,'default',$3,$4,$5,$6,false,'BILLING',$7,$8,
               now() - interval '1 day' + make_interval(secs => $9),
               now() - interval '1 day', $10)`,
      [
        id,
        opts.customerId ?? CUSTOMER_ID,
        FIX.line1,
        FIX.city,
        state,
        FIX.zip,
        opts.stateCode ?? null,
        opts.needsReview ?? false,
        n,
        opts.tenantId === undefined ? TENANT_ID : opts.tenantId,
      ],
    );
  }

  /** Deletes every address this run seeded in the throwaway tenant graph and reseeds the standard
   *  set, so each case starts from the same eight rows. */
  async function resetAddresses() {
    await db.query('DELETE FROM "CustomerAddress" WHERE "id" LIKE $1 AND "id" <> $2', [
      `${ID_PREFIX}addr-%`,
      NOT_APPROVED_ADDRESS_ID,
    ]);
    await seedAddress(A1, 1, "tx");
    await seedAddress(A2, 2, "N.Y.");
    await seedAddress(A3, 3, "Texas, USA");
    await seedAddress(A4, 4, "Tejas");
    await seedAddress(A5, 5, "");
    await seedAddress(A6, 6, "Houston");
    await seedAddress(A7, 7, "California", { stateCode: "CA" });
    await seedAddress(A8, 8, "Texas", { tenantId: null });
  }

  async function snapshot(ids: string[]): Promise<Map<string, Snap>> {
    const { rows } = await db.query(
      `SELECT "id","stateCode","stateNeedsReview","updatedAt" FROM "CustomerAddress"
        WHERE "id" = ANY($1::text[])`,
      [ids],
    );
    expect(rows).toHaveLength(ids.length);
    return new Map(
      rows.map(
        (r: {
          id: string;
          stateCode: string | null;
          stateNeedsReview: boolean;
          updatedAt: Date;
        }): [string, Snap] => [
          r.id,
          {
            stateCode: r.stateCode,
            stateNeedsReview: r.stateNeedsReview,
            updatedAt: r.updatedAt.getTime(),
          },
        ],
      ),
    );
  }

  const ALL = [A1, A2, A3, A4, A5, A6, A7, A8];

  /** The rows the run would consider, read back through its own `--json` report. */
  function jsonReport(args: string[]) {
    const res = runCli([...args, "--json"]);
    expect(res.status).toBe(0);
    return JSON.parse(res.stdout) as {
      mode: string;
      tenantSlug: string | null;
      rows: {
        id: string;
        verdict: string;
        stateCode: string | null;
        alreadyFlagged: boolean;
        tenantSlug: string | null;
      }[];
      summary: { candidates: number; toWrite: number; toSetState: number; toFlag: number };
      updates: { sql: string; params: string[] }[] | null;
      applied: Record<string, number> | null;
    };
  }

  beforeAll(async () => {
    databaseUrl = requireLocalDatabaseUrl();
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    await insertTenantGraph(TENANT_ID, TENANT_SLUG, USER_ID, CUSTOMER_ID);
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    // FK order, and never anything outside this run's own id prefix. By prefix, not by id: it is
    // also the net that removes the refusal fixture if D10 ever fails part-way.
    await db.query('DELETE FROM "CustomerAddress" WHERE "id" LIKE $1', [`${ID_PREFIX}%`]);
    await db.query('DELETE FROM "Customer" WHERE "id" LIKE $1', [`${ID_PREFIX}%`]);
    await db.query('DELETE FROM "User" WHERE "id" LIKE $1', [`${ID_PREFIX}%`]);
    await db.query('DELETE FROM "Tenant" WHERE "id" LIKE $1', [`${ID_PREFIX}%`]);
    await db.end();
  }, 120_000);

  beforeEach(async () => {
    await resetAddresses();
  });

  it("D1 report: lists each candidate with a verdict and a code, prints no address data, writes nothing", async () => {
    const before = await snapshot(ALL);

    const res = runCli(scoped());

    expect(res.status).toBe(0);
    const out = res.stdout;
    expect(out).toContain(`id=${A1}`);
    expect(out).toMatch(new RegExp(`id=${A1}.*\\[RESOLVED_LOCAL_EXACT\\].*stateCode=TX`));
    expect(out).toMatch(new RegExp(`id=${A2}.*\\[RESOLVED_LOCAL_ALIAS\\].*stateCode=NY`));
    expect(out).toMatch(new RegExp(`id=${A3}.*\\[RESOLVED_LOCAL_ALIAS\\].*stateCode=TX`));
    // no --google: the rows that WOULD need it say so, and EMPTY is never a Google candidate
    expect(out).toMatch(new RegExp(`id=${A4}.*\\[UNRESOLVED:NEEDS_GOOGLE\\].*state="Tejas"`));
    expect(out).toMatch(new RegExp(`id=${A5}.*\\[UNRESOLVED:EMPTY\\]`));
    expect(out).toMatch(new RegExp(`id=${A6}.*\\[UNRESOLVED:NEEDS_GOOGLE\\].*state="Houston"`));
    expect(out).toContain(`tenantSlug=${TENANT_SLUG}`);
    // the control row (already normalised) and the NULL-tenant row are not in a scoped listing
    expect(out).not.toContain(A7);
    expect(out).not.toContain(A8);
    // output discipline, proven on real rows: no address line, city or zip; a RESOLVED row never
    // echoes its raw state text
    for (const secret of [FIX.line1, FIX.city, FIX.zip, "@example.invalid", "Nas spec business"]) {
      expect(out + res.stderr).not.toContain(secret);
    }
    expect(out).not.toContain("Texas, USA");
    expect(out).toMatch(/candidates\s+6/);
    expect(out).toMatch(/rows to write\s+6\s+\(set state 3, flag for review 3\)/);

    // read-only in fact, not only in the banner
    expect(await snapshot(ALL)).toEqual(before);
  });

  it("D2 an UNSCOPED report lists the NULL-tenant row as NULL_TENANT and writes nothing", async () => {
    const before = await snapshot(ALL);

    const report = jsonReport([]);

    expect(report.mode).toBe("report");
    expect(report.tenantSlug).toBeNull();
    expect(report.updates).toBeNull();
    const ours = new Map(report.rows.map((r) => [r.id, r]));
    expect(ours.get(A8)?.verdict).toBe("UNRESOLVED:NULL_TENANT");
    expect(ours.get(A8)?.stateCode).toBeNull();
    expect(ours.get(A1)?.verdict).toBe("RESOLVED_LOCAL_EXACT");
    expect(ours.has(A7)).toBe(false);
    expect(await snapshot(ALL)).toEqual(before);
  });

  it("D3 --dry-run: prints the exact guarded statements with their bound values and still writes nothing", async () => {
    const before = await snapshot(ALL);

    const res = runCli(scoped("--dry-run"));

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("the 6 statement(s) --live would execute");
    expect(res.stdout).toContain(SET_SQL);
    expect(res.stdout).toContain(FLAG_SQL);
    expect(res.stdout).toContain("$1 = TX");
    expect(res.stdout).toContain("$1 = NY");
    expect(res.stdout).toContain(`$2 = ${A1}`);
    expect(res.stdout).toContain(`$1 = ${A4}`);
    // an unresolved row's statement has ONE parameter and can never carry a code
    expect(res.stdout).not.toMatch(/stateCode" = \$1, "stateNeedsReview" = true/);
    expect(await snapshot(ALL)).toEqual(before);
  });

  it("D4 the read-only session statement the script issues really rejects a write", async () => {
    // The statement is read out of the script itself, so this pins what the tool actually sends
    // first — not a copy of it typed here.
    const src = fs.readFileSync(CLI, "utf8");
    const found = /client\.query\("(SET default_transaction_read_only = on)"\)/.exec(src);
    expect(found).not.toBeNull();

    const probe = new Client({ connectionString: databaseUrl });
    await probe.connect();
    try {
      await probe.query(found![1]);
      await expect(
        probe.query('UPDATE "CustomerAddress" SET "stateCode" = $1 WHERE "id" = $2', ["TX", A4]),
      ).rejects.toMatchObject({ code: "25006" }); // read_only_sql_transaction
    } finally {
      await probe.end();
    }
    expect((await snapshot([A4])).get(A4)?.stateCode).toBeNull();
  });

  it("D5 --live with a mismatched confirmation: exit 3 and no row is touched", async () => {
    const before = await snapshot(ALL);

    const res = runCli(scoped("--live", "--backup-attested", ATTESTATION), {
      NORMALIZE_CONFIRM_TOKEN: "NORMALIZE 99 ADDRESSES",
    });

    expect(res.status).toBe(3);
    expect(res.stderr).toContain("confirmation text did not match");
    expect(res.stdout).not.toContain("=== APPLIED ===");
    expect(await snapshot(ALL)).toEqual(before);
  });

  it("D6 --live on a non-TTY with no token: exit 3 before any write", async () => {
    const before = await snapshot(ALL);

    // spawnSync gives the child a pipe, not a terminal, so this is the unattended case the TTY
    // check exists for — and NORMALIZE_CONFIRM_TOKEN is deliberately absent here.
    const res = runCli(scoped("--live", "--backup-attested", ATTESTATION));

    expect(res.status).toBe(3);
    expect(res.stderr).toContain("interactive TTY");
    expect(await snapshot(ALL)).toEqual(before);
  });

  it("D7 --live: exactly the resolvable rows get a code, the rest are only FLAGGED, nothing else moves", async () => {
    const before = await snapshot(ALL);

    const res = runCli(scoped("--live", "--backup-attested", ATTESTATION), {
      NORMALIZE_CONFIRM_TOKEN: PHRASE_6,
    });

    expect(res.status).toBe(0);
    // the override is announced, never silent
    expect(res.stderr).toContain("WARNING: test override NORMALIZE_CONFIRM_TOKEN active");
    expect(res.stdout).toContain("=== APPLIED ===");
    expect(res.stdout).toMatch(/set-state\s+3/);
    expect(res.stdout).toMatch(/flag-review\s+3/);
    for (const secret of [FIX.line1, FIX.city, FIX.zip]) {
      expect(res.stdout + res.stderr).not.toContain(secret);
    }

    const after = await snapshot(ALL);
    // resolved: code written, review cleared, updatedAt moved
    for (const [rowId, code] of [
      [A1, "TX"],
      [A2, "NY"],
      [A3, "TX"],
    ] as const) {
      expect(after.get(rowId)).toMatchObject({ stateCode: code, stateNeedsReview: false });
      expect(after.get(rowId)!.updatedAt).toBeGreaterThan(before.get(rowId)!.updatedAt);
    }
    // unresolved: NEVER a code, ONLY the review annotation
    for (const rowId of [A4, A5, A6]) {
      expect(after.get(rowId)).toMatchObject({ stateCode: null, stateNeedsReview: true });
      expect(after.get(rowId)!.updatedAt).toBeGreaterThan(before.get(rowId)!.updatedAt);
    }
    // the already-normalised control and the NULL-tenant row are byte-identical
    expect(after.get(A7)).toEqual(before.get(A7));
    expect(after.get(A8)).toEqual(before.get(A8));
    expect(after.get(A8)).toMatchObject({ stateCode: null, stateNeedsReview: false });
  });

  it("D8 a second run is a no-op: resolved rows are no longer candidates, flagged rows are not rewritten", async () => {
    const first = runCli(scoped("--live", "--backup-attested", ATTESTATION), {
      NORMALIZE_CONFIRM_TOKEN: PHRASE_6,
    });
    expect(first.status).toBe(0);
    const between = await snapshot(ALL);

    const report = jsonReport(scoped());
    // only the three unresolved rows remain candidates, all already flagged
    expect(report.rows.map((r) => r.id).sort()).toEqual([A4, A5, A6].sort());
    expect(report.rows.every((r) => r.alreadyFlagged)).toBe(true);
    expect(report.summary).toMatchObject({ candidates: 3, toWrite: 0 });

    const again = runCli(scoped("--live", "--backup-attested", ATTESTATION), {
      NORMALIZE_CONFIRM_TOKEN: "NORMALIZE 0 ADDRESSES",
    });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("nothing to do");
    expect(again.stdout).not.toContain("=== APPLIED ===");
    // not even updatedAt moved
    expect(await snapshot(ALL)).toEqual(between);
  });

  it("D9 a row that changes under the run: exit 4 and the WHOLE batch rolls back", async () => {
    const before = await snapshot(ALL);

    // Hold A6's row lock with an uncommitted change. The child's listing is a plain SELECT (MVCC),
    // so it still sees A6 as a NULL-stateCode candidate; its guarded UPDATE for A6 — the LAST
    // statement in report order — then blocks on the lock, and when we commit, Postgres re-checks
    // the WHERE and finds "stateCode" no longer NULL: zero rows -> ROLLBACK -> exit 4. A1..A5's
    // statements already ran inside that transaction, so unchanged rows prove the rollback.
    const blocker = new Client({ connectionString: databaseUrl });
    await blocker.connect();
    let committed = false;
    let child: ReturnType<typeof spawn> | null = null;
    try {
      await blocker.query("BEGIN");
      await blocker.query('UPDATE "CustomerAddress" SET "stateCode" = $1 WHERE "id" = $2', [
        "NY",
        A6,
      ]);

      child = spawn(
        process.execPath,
        [CLI, ...scoped("--live", "--backup-attested", ATTESTATION)],
        {
          cwd: API_DIR,
          env: cliEnv({ NORMALIZE_CONFIRM_TOKEN: PHRASE_6 }),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
      const exited = new Promise<number | null>((resolve) => child!.on("close", resolve));

      // Wait until the child is genuinely parked on the lock — no sleeps standing in for it.
      const deadline = Date.now() + 60_000;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        const { rows } = await db.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query LIKE 'UPDATE "CustomerAddress"%'`,
        );
        blocked = rows.length > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 100));
      }
      expect(blocked).toBe(true);

      await blocker.query("COMMIT");
      committed = true;

      expect(await exited).toBe(4);
      expect(stderr).toContain("ROLLED BACK");
      expect(stderr).toContain(A6);
      expect(stderr).toContain("nothing was written");
      expect(stdout).not.toContain("=== APPLIED ===");
    } finally {
      if (!committed) await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
      if (child && child.exitCode === null) child.kill("SIGKILL");
    }

    const after = await snapshot(ALL);
    // A6 is the blocker's own committed change; A1..A5 are exactly as they were
    expect(after.get(A6)).toMatchObject({ stateCode: "NY" });
    for (const rowId of [A1, A2, A3, A4, A5, A7, A8]) {
      expect(after.get(rowId)).toEqual(before.get(rowId));
    }
  }, 120_000);

  it("D10 --only-test-tenants: a target row in a NON-approved tenant refuses the batch in EVERY mode, exit 3, zero writes", async () => {
    await insertTenantGraph(
      NOT_APPROVED_TENANT_ID,
      NOT_APPROVED_SLUG,
      NOT_APPROVED_USER_ID,
      NOT_APPROVED_CUSTOMER_ID,
    );
    // resolvable ("Texas"), so absent the guard it is an ordinary candidate
    await seedAddress(NOT_APPROVED_ADDRESS_ID, 9, "Texas", {
      tenantId: NOT_APPROVED_TENANT_ID,
      customerId: NOT_APPROVED_CUSTOMER_ID,
    });
    const before = await snapshot([NOT_APPROVED_ADDRESS_ID]);
    const guardScope = ["--tenant-slug", NOT_APPROVED_SLUG];

    // Without the flag the row is a perfectly ordinary repair candidate — which is what makes the
    // refusals below attributable to the guard and to nothing else.
    const plain = runCli([...guardScope, "--dry-run"]);
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain("the 1 statement(s) --live would execute");

    const live = runCli([
      ...guardScope,
      "--only-test-tenants",
      "--live",
      "--confirm",
      "NORMALIZE 1 ADDRESSES",
      "--backup-attested",
      ATTESTATION,
    ]);
    expect(live.status).toBe(3);
    const combined = live.stdout + live.stderr;
    expect(combined).toContain("--only-test-tenants refuses this batch");
    expect(combined).toContain(`CustomerAddress ${NOT_APPROVED_ADDRESS_ID}`);
    expect(combined).toContain(`tenantSlug=${NOT_APPROVED_SLUG}`);
    expect(combined).toContain("NOTHING was written");
    expect(live.stdout).not.toContain("=== APPLIED ===");

    // enforced in --dry-run and in the plain report, so the preflight the owner reads IS the gate
    const dry = runCli([...guardScope, "--only-test-tenants", "--dry-run"]);
    expect(dry.status).toBe(3);
    expect(dry.stdout).toContain("=== REFUSED — --only-test-tenants ===");
    expect(dry.stdout).not.toContain("statement(s) --live would execute");
    expect(runCli([...guardScope, "--only-test-tenants"]).status).toBe(3);

    // Unscoped, the same row is in the whole-database write list — so the guard refuses that too,
    // whatever else the compose database holds.
    expect(runCli(["--only-test-tenants", "--dry-run"]).status).toBe(3);

    expect(await snapshot([NOT_APPROVED_ADDRESS_ID])).toEqual(before);
  });

  it("D11 --only-test-tenants --confirm: the throwaway test tenant is normalised unattended, and the count is a real check", async () => {
    const before = await snapshot(ALL);

    // wrong count first: the guard PASSES (approved tenant), so only the phrase can refuse this
    const wrong = runCli(
      scoped(
        "--only-test-tenants",
        "--live",
        "--confirm",
        "NORMALIZE 5 ADDRESSES",
        "--backup-attested",
        ATTESTATION,
      ),
    );
    expect(wrong.status).toBe(3);
    expect(wrong.stderr).toContain("confirmation text did not match");
    expect(await snapshot(ALL)).toEqual(before);

    const res = runCli(
      scoped(
        "--only-test-tenants",
        "--live",
        "--confirm",
        PHRASE_6,
        "--backup-attested",
        ATTESTATION,
      ),
    );
    expect(res.status).toBe(0);
    // the owner's own flag did the confirming — not the jest-only token
    expect(res.stderr).not.toContain("NORMALIZE_CONFIRM_TOKEN");
    expect(res.stdout).toContain("=== APPLIED ===");
    const after = await snapshot(ALL);
    expect(after.get(A1)).toMatchObject({ stateCode: "TX", stateNeedsReview: false });
    expect(after.get(A4)).toMatchObject({ stateCode: null, stateNeedsReview: true });
    expect(after.get(A8)).toEqual(before.get(A8));
  });

  it("D12 an unknown --tenant-slug is exit 1 and touches nothing", async () => {
    const before = await snapshot(ALL);

    const res = runCli(["--tenant-slug", `qa-nas-nonexistent-${RUN_SUFFIX}`]);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("no tenant has the slug");
    expect(await snapshot(ALL)).toEqual(before);
  });

  it("D13 --json: one document, the same rows and statements, and no address data", async () => {
    const res = runCli(scoped("--dry-run", "--json"));

    expect(res.status).toBe(0);
    for (const secret of [FIX.line1, FIX.city, FIX.zip, "@example.invalid"]) {
      expect(res.stdout).not.toContain(secret);
    }
    const doc = JSON.parse(res.stdout) as ReturnType<typeof jsonReport>;
    expect(doc.mode).toBe("dry-run");
    expect(doc.tenantSlug).toBe(TENANT_SLUG);
    expect(doc.rows).toHaveLength(6);
    expect(doc.updates).toHaveLength(6);
    expect(doc.applied).toBeNull();
    expect(doc.summary).toMatchObject({ candidates: 6, toWrite: 6, toSetState: 3, toFlag: 3 });
    const verdicts = Object.fromEntries(doc.rows.map((r) => [r.id, r.verdict]));
    expect(verdicts).toEqual({
      [A1]: "RESOLVED_LOCAL_EXACT",
      [A2]: "RESOLVED_LOCAL_ALIAS",
      [A3]: "RESOLVED_LOCAL_ALIAS",
      [A4]: "UNRESOLVED:NEEDS_GOOGLE",
      [A5]: "UNRESOLVED:EMPTY",
      [A6]: "UNRESOLVED:NEEDS_GOOGLE",
    });
    expect(doc.updates!.every((u) => u.sql === SET_SQL || u.sql === FLAG_SQL)).toBe(true);
  });
});
