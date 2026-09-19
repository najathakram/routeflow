/**
 * PR-0b "zero-loss report" — `apps/api/scripts/publish-and-repin.mjs` executed against a REAL
 * Postgres, so the paths that actually touch data are proven rather than described. The pure
 * mirror-parity + fixture-logic proof lives in feature-registry-mirror.parity.spec.ts; what THIS
 * file proves is the CLI itself: that `--report` and `--apply` compute the same thing the pure
 * spec proves the mirror computes, that `--apply --live` actually writes, that a second
 * `--apply --live` is a no-op, that every refusal path writes nothing, and that no PII reaches
 * stdout.
 *
 * Two fixture tenants, both pinned directly to a throwaway PlanVersion this spec seeds (no
 * TenantSubscription row needed — Tenant.plan alone resolves via planKeyFromEnum, which
 * identity-maps SCALE/LITE):
 *   - the "loss" tenant: SCALE, whose plan definition matches feature-fixtures.ts's
 *     V11_PIN_FIXTURE (flag.msrp/flag.sales_agents/flag.reports/flag.returns only), no addons.
 *     EXPECTED_LOSS_KEYS (9): the 5 PREPIN_DARK_FLAGS keys (legacy flag courtesy-allow), the 3
 *     RequireAddon-dark keys with no active addon — ocr/crm_gohighlevel/email.connected_mailbox
 *     (legacy addon-gate courtesy-allow, an unconditional "dark" state with no env kill switch,
 *     same mechanism as the flag one but never PLAN_FLAG_ENFORCEMENT-gated) — and
 *     flag.credit_limits (see below).
 *   - the "zero" tenant: LITE (always-enforced — feature-fixtures.ts's LITE_FIXTURE), plus
 *     flag.credit_limits ADDED to its plan definition. LITE alone would still show exactly one
 *     loss: design.md (§"Credit-limit check") states plainly that today's credit-limit guard
 *     "always runs" — is "currently effective" for "everyone" — regardless of plan, because
 *     orders.service.ts does not consult the entitlement system for it at all yet; that is
 *     NOT a courtesy-allow LITE's always-enforced status exempts it from (see
 *     feature-registry-mirror.cjs's ALWAYS_EFFECTIVE_TODAY). Giving this tenant's plan the flag
 *     explicitly closes that one exception too, so it is a genuine zero-loss tenant — "a fixture
 *     tenant whose access is fully explained by preset/grants" in the literal, no-exceptions sense.
 *
 * The whole-database report/apply totals are NOT asserted exactly — a shared compose database may
 * carry other PRODUCTION-class tenants (the seeded `test` tenant, at minimum). Every assertion
 * instead keys off this spec's own tenants by their redacted `#<ordinal> (<8-hex hash>)` tag,
 * computed here with the SAME sha256 the script uses, and read `n`/count values back from the
 * tool's own preceding output rather than hard-coding them (same principle
 * backfill-legacy-tenant-ids.db.spec.ts uses for its BACKFILL <n> ROWS phrase).
 *
 * SAFETY. Every row this file creates lives inside two throwaway `e2e-pr0b-*` tenants
 * (assertTestTenant) plus one fixture PlanVersion/PlanDefinition pair; teardown deletes exactly
 * those, in FK order. `--apply --live` here always passes --only-test-tenants, so a compose
 * database carrying any OTHER non-test-tenant PRODUCTION row with a loss fails this spec (exit 3,
 * offending slug printed) instead of silently granting something.
 *
 * Collected only by jest.db.config.js (`.db.spec.ts$`) — run via `npm run local:test:db`.
 */
import { spawnSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import path from "path";
import { Client } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(API_DIR, "scripts/publish-and-repin.mjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
const ID_PREFIX = `e2e-pr0b-${RUN_SUFFIX}-`;

const TENANT_LOSS_ID = `${ID_PREFIX}tenant-loss`;
const TENANT_LOSS_SLUG = assertTestTenant(
  `e2e-pr0b-${RUN_SUFFIX}-loss`,
  "publish-and-repin.db.spec.ts",
);
const TENANT_ZERO_ID = `${ID_PREFIX}tenant-zero`;
const TENANT_ZERO_SLUG = assertTestTenant(
  `e2e-pr0b-${RUN_SUFFIX}-zero`,
  "publish-and-repin.db.spec.ts",
);
const PLAN_VERSION_ID = `${ID_PREFIX}planversion`;
const PLAN_DEF_SCALE_ID = `${ID_PREFIX}plandef-scale`;
const PLAN_DEF_LITE_ID = `${ID_PREFIX}plandef-lite`;
// Wide random range: a numeric PlanVersion.version collision with a concurrent lane is
// astronomically unlikely, and this row is deleted by id (not by version) in afterAll regardless.
const VERSION_NUM = 900000 + Math.floor(Math.random() * 90000);

const SCALE_FLAGS = ["flag.msrp", "flag.sales_agents", "flag.reports", "flag.returns"];
const LITE_ZERO_LOSS_FLAGS = ["flag.credit_limits"];
const EXPECTED_LOSS_KEYS = [
  "flag.estimates",
  "flag.recurring_invoices",
  "flag.credit_notes",
  "flag.suppliers",
  "flag.messaging",
  "ocr",
  "crm_gohighlevel",
  "email.connected_mailbox",
  "flag.credit_limits",
].sort();

function tag(tenantId: string) {
  return createHash("sha256").update(tenantId).digest("hex").slice(0, 8);
}
const HASH_LOSS = tag(TENANT_LOSS_ID);
const HASH_ZERO = tag(TENANT_ZERO_ID);

interface Diff {
  mode: string;
  planFlagEnforcementAssumed: string;
  gains: { tenant: string; key: string }[];
  losses: { tenant: string; key: string }[];
  applied: { batchId: string; inserted: number; candidates: number } | null;
  applyRefused?: string;
  testTenantError?: string[];
}

describeDb("publish-and-repin.mjs — real Postgres (report / apply / refusals / no-PII)", () => {
  let db: Client;
  let databaseUrl: string;

  function runCli(args: string[], extraEnv: Record<string, string> = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
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

  /** For --apply calls, which always exit 0 on a clean preview/apply. */
  function runJson(args: string[], extraEnv: Record<string, string> = {}): Diff {
    const res = runCli([...args, "--json"], extraEnv);
    expect(res.status).toBe(0);
    return JSON.parse(res.stdout) as Diff;
  }

  /** For --report calls: exit 0 (LOSSES: 0) or 4 (LOSSES > 0) are BOTH the tool working as
   *  designed — the exit code is the gate, not an error signal — so this accepts either and
   *  hands back the parsed document either way. */
  function runReportJson(extraEnv: Record<string, string> = {}): Diff {
    const res = runCli(["--report", "--json"], extraEnv);
    expect([0, 4]).toContain(res.status);
    return JSON.parse(res.stdout) as Diff;
  }

  async function activeOverrides(tenantId: string) {
    const { rows } = await db.query(
      `SELECT "featureKey", "effect", "kind", "reason", "expiresAt", "createdById"
         FROM "TenantFeatureOverride"
        WHERE "tenantId" = $1 AND "revokedAt" IS NULL
        ORDER BY "featureKey"`,
      [tenantId],
    );
    return rows;
  }

  beforeAll(async () => {
    databaseUrl = requireLocalDatabaseUrl();
    db = new Client({ connectionString: databaseUrl });
    await db.connect();

    await db.query(
      `INSERT INTO "PlanVersion" ("id", "version", "status", "createdAt", "updatedAt")
       VALUES ($1, $2, 'DRAFT', now(), now())`,
      [PLAN_VERSION_ID, VERSION_NUM],
    );
    await db.query(
      `INSERT INTO "PlanDefinition"
         ("id", "planVersionId", "planKey", "name", "msgsIncluded", "featureFlags", "sortOrder")
       VALUES ($1, $2, 'SCALE', 'Fixture Scale', 200, $3::text[], 0)`,
      [PLAN_DEF_SCALE_ID, PLAN_VERSION_ID, SCALE_FLAGS],
    );
    await db.query(
      `INSERT INTO "PlanDefinition"
         ("id", "planVersionId", "planKey", "name", "msgsIncluded", "featureFlags", "sortOrder")
       VALUES ($1, $2, 'LITE', 'Fixture Lite', 200, $3::text[], 1)`,
      [PLAN_DEF_LITE_ID, PLAN_VERSION_ID, LITE_ZERO_LOSS_FLAGS],
    );

    // The "loss" tenant: SCALE, pinned to the fixture version above — feature-fixtures.ts's
    // V11_PIN_FIXTURE shape. No addons, no overrides: today's courtesy allow (flag AND addon) is
    // the ONLY reason any of EXPECTED_LOSS_KEYS would show effective for it.
    await db.query(
      `INSERT INTO "Tenant"
         ("id", "slug", "name", "status", "plan", "class", "planVersionId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'ACTIVE', 'SCALE'::"TenantPlan", 'PRODUCTION', $4, now(), now())`,
      [TENANT_LOSS_ID, TENANT_LOSS_SLUG, `PR-0b spec loss tenant ${RUN_SUFFIX}`, PLAN_VERSION_ID],
    );
    // The "zero" tenant: LITE (always-enforced) — feature-fixtures.ts's LITE_FIXTURE shape.
    await db.query(
      `INSERT INTO "Tenant"
         ("id", "slug", "name", "status", "plan", "class", "planVersionId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'ACTIVE', 'LITE'::"TenantPlan", 'PRODUCTION', $4, now(), now())`,
      [TENANT_ZERO_ID, TENANT_ZERO_SLUG, `PR-0b spec zero tenant ${RUN_SUFFIX}`, PLAN_VERSION_ID],
    );
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await db.query('DELETE FROM "TenantFeatureOverride" WHERE "tenantId" = ANY($1)', [
      [TENANT_LOSS_ID, TENANT_ZERO_ID],
    ]);
    await db.query('DELETE FROM "Tenant" WHERE "id" = ANY($1)', [[TENANT_LOSS_ID, TENANT_ZERO_ID]]);
    await db.query('DELETE FROM "PlanDefinition" WHERE "planVersionId" = $1', [PLAN_VERSION_ID]);
    await db.query('DELETE FROM "PlanVersion" WHERE "id" = $1', [PLAN_VERSION_ID]);
    await db.end();
  }, 120_000);

  it("D1 --report: the loss tenant shows all 9 EXPECTED_LOSS_KEYS as LOSSES; the zero tenant shows none", () => {
    const report = runReportJson();
    expect(report.planFlagEnforcementAssumed).toBe("on"); // the default — matches known prod state

    const ourLosses = report.losses
      .filter((l) => l.tenant.includes(HASH_LOSS))
      .map((l) => l.key)
      .sort();
    expect(ourLosses).toEqual(EXPECTED_LOSS_KEYS);

    const zeroLosses = report.losses.filter((l) => l.tenant.includes(HASH_ZERO));
    expect(zeroLosses).toEqual([]);
  });

  it("D2 --apply preview (no --live): shows the same losses, writes nothing", async () => {
    const preview = runJson(["--apply"]);
    const ourLosses = preview.losses
      .filter((l) => l.tenant.includes(HASH_LOSS))
      .map((l) => l.key)
      .sort();
    expect(ourLosses).toEqual(EXPECTED_LOSS_KEYS);
    expect(preview.applied).toBeNull();

    expect(await activeOverrides(TENANT_LOSS_ID)).toEqual([]);
  });

  it("D2b no PII: neither tenant's slug or name reaches stdout, in prose or --json, for report or apply preview", () => {
    // Runs here, BEFORE D6 applies our grants — our tenant still has losses to show at this
    // point, which is what makes the "the redacted tag IS expected to appear" check below
    // meaningful for the --apply preview calls too (apply's preview only ever lists LOSSES,
    // never GAINS, so once D6 grants everything away there would be nothing of ours left to
    // print there at all).
    const proseReport = runCli(["--report"]);
    const jsonReport = runCli(["--report", "--json"]);
    const prosePreview = runCli(["--apply"]);
    const jsonPreview = runCli(["--apply", "--json"]);

    for (const res of [proseReport, jsonReport, prosePreview, jsonPreview]) {
      expect([0, 4]).toContain(res.status);
      expect(res.stdout).not.toContain(TENANT_LOSS_SLUG);
      expect(res.stdout).not.toContain(TENANT_ZERO_SLUG);
      expect(res.stdout).not.toContain(`PR-0b spec loss tenant ${RUN_SUFFIX}`);
      expect(res.stdout).not.toContain(`PR-0b spec zero tenant ${RUN_SUFFIX}`);
      expect(res.stdout).not.toContain(TENANT_LOSS_ID);
      expect(res.stdout).not.toContain(TENANT_ZERO_ID);
      // the redacted tag IS expected to appear — proves the assertions above aren't vacuous
      expect(res.stdout).toContain(HASH_LOSS);
    }
  });

  it("D3 --apply --live with no --backup-attested: refused before connecting, exit 2, writes nothing", async () => {
    const res = runCli(["--apply", "--live"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("--backup-attested");
    expect(await activeOverrides(TENANT_LOSS_ID)).toEqual([]);
  });

  it("D4 --apply --live on a non-TTY with no confirmation: exit 3, writes nothing", async () => {
    // spawnSync gives the child a pipe, not a terminal — the TTY check this proves, and neither
    // --confirm nor the jest-only token is supplied.
    const res = runCli(["--apply", "--live", "--backup-attested", "spec"]);
    expect(res.status).toBe(3);
    expect(res.stderr).toContain("interactive TTY");
    expect(await activeOverrides(TENANT_LOSS_ID)).toEqual([]);
  });

  it("D5 --apply --live with a WRONG confirmation phrase: exit 3, writes nothing", async () => {
    const res = runCli([
      "--apply",
      "--live",
      "--only-test-tenants",
      "--confirm",
      "GRANT 999999 OVERRIDES",
      "--backup-attested",
      "spec",
    ]);
    expect(res.status).toBe(3);
    expect(res.stderr).toContain("confirmation text did not match");
    expect(await activeOverrides(TENANT_LOSS_ID)).toEqual([]);
  });

  it("D6 --apply --live with the correct phrase: writes exactly one GRANT/GRANDFATHER override per loss", async () => {
    // Read the exact whole-database count from a fresh preview first — mirrors
    // backfill-legacy-tenant-ids.db.spec.ts's own "read n from the tool's own output" pattern;
    // this spec does not assume it owns every PRODUCTION-class row in a shared compose database.
    const preview = runJson(["--apply"]);
    const n = preview.losses.length;
    expect(n).toBeGreaterThanOrEqual(EXPECTED_LOSS_KEYS.length); // at least our own 9

    const res = runCli([
      "--apply",
      "--live",
      "--only-test-tenants",
      "--confirm",
      `GRANT ${n} OVERRIDES`,
      "--backup-attested",
      "spec",
      "--json",
    ]);
    expect(res.status).toBe(0);
    const result = JSON.parse(res.stdout) as Diff;
    expect(result.applied?.inserted).toBe(n);

    const rows = await activeOverrides(TENANT_LOSS_ID);
    expect(rows.map((r) => r.featureKey).sort()).toEqual(EXPECTED_LOSS_KEYS);
    for (const row of rows) {
      expect(row.effect).toBe("GRANT");
      expect(row.kind).toBe("GRANDFATHER");
      expect(row.expiresAt).toBeNull();
      expect(row.createdById).toBeNull();
      expect(String(row.reason)).toContain("PR-0b");
    }
    // the zero tenant received nothing
    expect(await activeOverrides(TENANT_ZERO_ID)).toEqual([]);
  });

  it("D7 --report after D6: the loss tenant now shows zero losses (grants explain the one rule too)", () => {
    const report = runReportJson();
    const ourLosses = report.losses.filter((l) => l.tenant.includes(HASH_LOSS));
    expect(ourLosses).toEqual([]);
    const zeroLosses = report.losses.filter((l) => l.tenant.includes(HASH_ZERO));
    expect(zeroLosses).toEqual([]);
  });

  it("D8 --apply --live again: idempotent — inserts nothing new, our tenant's 9 rows are untouched", async () => {
    const before = await activeOverrides(TENANT_LOSS_ID);
    expect(before).toHaveLength(9);

    const preview = runJson(["--apply"]);
    const n = preview.losses.length;

    if (n === 0) {
      // Nobody else in the shared database has a loss either — "nothing to grant" path.
      const res = runCli(["--apply", "--json"]);
      const result = JSON.parse(res.status === 0 ? res.stdout : "{}") as Partial<Diff>;
      expect(res.status).toBe(0);
      expect(result.applied).toBeNull();
    } else {
      // Something else in the shared database still shows a loss (not ours) — apply live again
      // and prove OUR rows specifically are untouched, whatever total n the run reports.
      const res = runCli([
        "--apply",
        "--live",
        "--only-test-tenants",
        "--confirm",
        `GRANT ${n} OVERRIDES`,
        "--backup-attested",
        "spec",
        "--json",
      ]);
      expect(res.status).toBe(0);
    }

    const after = await activeOverrides(TENANT_LOSS_ID);
    expect(after).toEqual(before);
  });
});
