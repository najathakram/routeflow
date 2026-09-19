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
 * identity-maps SCALE/LITE). Every case runs under the SCRIPT'S DEFAULT (--plan-flag-enforcement
 * defaults to "off" — the real, current production value per
 * project_entitlements_one_rule_2026-09-17.md: the 2026-09-17 P0 was the ON flip, reverted the
 * same morning and never re-enabled), matching what a real prod run actually computes:
 *   - the "loss" tenant: SCALE, whose plan definition matches feature-fixtures.ts's
 *     V11_PIN_FIXTURE (flag.msrp/flag.sales_agents/flag.reports/flag.returns only), no addons.
 *     EXPECTED_LOSS_KEYS (15, shown by --report): while enforcement is off, the legacy dark-flag
 *     courtesy allow is NOT limited to PREPIN_DARK_FLAGS — it covers all 13 DARK_PLAN_FLAGS keys,
 *     11 of which this tenant's plan doesn't already hold; the 3 RequireAddon-dark keys with no
 *     active addon — ocr/crm_gohighlevel/email.connected_mailbox (a SEPARATE courtesy mechanism,
 *     addon-gate state, which has no env kill switch at all and is unaffected by
 *     PLAN_FLAG_ENFORCEMENT); and flag.credit_limits (see below). EXPECTED_APPLICABLE_LOSS_KEYS
 *     (12 = 15 − 3): what --apply actually WRITES by default — it excludes the 3
 *     addon-gate-courtesy keys, because a permanent blanket GRANT would defeat those add-ons' own,
 *     separate, still-in-progress rollout process (design.md: "addon-gate-registry ... left
 *     alone, not an entitlement source").
 *   - the "zero" tenant: LITE (always-enforced — feature-fixtures.ts's LITE_FIXTURE), plus
 *     flag.credit_limits ADDED to its plan definition. LITE alone would still show exactly one
 *     loss while enforcement is off: orders.service.ts's real isCreditLimitCheckEnabled() returns
 *     true unconditionally whenever PLAN_FLAG_ENFORCEMENT is not "on" — a fact about that one
 *     service call, not a courtesy allow LITE's always-enforced status exempts it from (see
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
const ADDON_GATE_COURTESY_KEYS = ["ocr", "crm_gohighlevel", "email.connected_mailbox"];
// All 15 — what --report shows for the loss tenant (enforcement=off, the script's default).
const EXPECTED_LOSS_KEYS = [
  "flag.analytics",
  "flag.ap_bills",
  "flag.import_integrations",
  "flag.forecasting",
  "flag.pricing_tiers",
  "flag.estimates",
  "flag.recurring_invoices",
  "flag.credit_notes",
  "flag.suppliers",
  "flag.messaging",
  "addon.buyer_portal",
  ...ADDON_GATE_COURTESY_KEYS,
  "flag.credit_limits",
].sort();
// 12 — what --apply actually WRITES by default (excludes the 3 addon-gate-courtesy keys).
const EXPECTED_APPLICABLE_LOSS_KEYS = EXPECTED_LOSS_KEYS.filter(
  (k) => !ADDON_GATE_COURTESY_KEYS.includes(k),
).sort();
// N1, owner ruling 2026-09-19: of the 12 applicable keys, these three carry a real billing SKU
// (flag.analytics AND flag.forecasting both -> FORECASTING, addon.buyer_portal -> BUYER_PORTAL)
// and get a 90-day expiresAt instead of a permanent grant; every other applicable key stays
// non-expiring. Matches feature-registry-mirror.parity.spec.ts's darkBillablePlanFlagKeys pin.
const BILLABLE_APPLICABLE_KEYS = [
  "addon.buyer_portal",
  "flag.analytics",
  "flag.forecasting",
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
  losses: { tenant: string; key: string; mechanism: string }[];
  applied: { batchId: string; inserted: number; candidates: number } | null;
  applyRefused?: string;
  testTenantError?: string[];
  excludedAddonGateLosses?: number;
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

  /**
   * D6/D8/D9 confirm a --live apply using a whole-database loss count `n` read from a PRECEDING,
   * separate CLI invocation's preview, then pass `GRANT ${n} OVERRIDES` to a LATER, separate
   * `--live` invocation that independently recomputes its own current `n` and compares. On a
   * quiet database those two reads agree. But `jest.db.config.js` sets no maxWorkers/runInBand,
   * so this file runs as ONE of many PARALLEL jest workers against the SAME shared Postgres —
   * several of the other 27 `.db.spec.ts` files seed their own fixture tenants without bothering
   * to set `Tenant.class` away from its schema default, `'PRODUCTION'`, so this script's
   * (correct, safe) whole-database scan can see the total shift between the two calls. That is
   * the confirmation phrase doing exactly its job — refusing to act on a stale count, exit 3,
   * zero writes — not a bug in the script; a real operator hitting this would just re-run. This
   * is why a single-file `npx jest publish-and-repin.db.spec.ts` run is 100% stable (no sibling
   * workers touching the database) while the full `jest --config jest.db.config.js` lane (CI's
   * "Replay migrations on a fresh database" job runs exactly this) can catch it — a difference in
   * concurrency the earlier version of this file didn't account for, not in what the script does.
   * Retries with a fresh preview on a `phrase-mismatch` refusal only; any other refusal reason is
   * returned immediately rather than masked.
   */
  async function applyLiveWithRetry(
    extraArgs: string[],
    attempts = 8,
  ): Promise<{ res: ReturnType<typeof runCli>; n: number }> {
    let last: { res: ReturnType<typeof runCli>; n: number } | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const preview = runJson(["--apply", ...extraArgs]);
      const n = preview.losses.length - (preview.excludedAddonGateLosses ?? 0);
      const res = runCli([
        "--apply",
        "--live",
        ...extraArgs,
        "--only-test-tenants",
        "--confirm",
        `GRANT ${n} OVERRIDES`,
        "--backup-attested",
        "spec",
        "--json",
      ]);
      last = { res, n };
      if (res.status !== 3) return last;
      let refusal: string | undefined;
      try {
        refusal = (JSON.parse(res.stdout) as Partial<Diff>).applyRefused;
      } catch {
        // non-JSON stdout on this refusal path — treat as a non-retryable failure below
      }
      if (refusal !== "phrase-mismatch") return last;
    }
    return last!;
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

  /** `expiresAt`/`createdAt`/`revokedAt` are all Postgres "timestamp without time zone" columns
   *  (matches Prisma's DateTime on this table). node-postgres parses a naive timestamp value back
   *  into a JS Date using the CURRENT PROCESS's local timezone (not UTC, and not the DB session's
   *  timezone, which this compose DB confirms is already UTC) — so comparing a value read this way
   *  against `Date.now()` directly is wrong by a fixed offset for the whole test run, NOT a bug in
   *  the stored data itself (psql or Prisma would read the identical row back correctly). Reading
   *  a reference "now" through the exact same cast + driver path makes the offset cancel out. */
  async function dbNaiveNowMs(): Promise<number> {
    const { rows } = await db.query(`SELECT (now())::timestamp AS ref`);
    return new Date(rows[0].ref as string).getTime();
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

  it("D1 --report: the loss tenant shows all 15 EXPECTED_LOSS_KEYS as LOSSES; the zero tenant shows none", () => {
    const report = runReportJson();
    // the default — matches the real, current production value (see the file header)
    expect(report.planFlagEnforcementAssumed).toBe("off");

    const ourLosses = report.losses
      .filter((l) => l.tenant.includes(HASH_LOSS))
      .map((l) => l.key)
      .sort();
    expect(ourLosses).toEqual(EXPECTED_LOSS_KEYS);
    // every addon-gate-courtesy loss is labeled as such (report shows the FULL set — the
    // apply-time exclusion is a write-path decision, not a report-time one)
    const addonGateLosses = report.losses.filter(
      (l) => l.tenant.includes(HASH_LOSS) && ADDON_GATE_COURTESY_KEYS.includes(l.key),
    );
    expect(addonGateLosses.every((l) => l.mechanism === "addon-gate-courtesy")).toBe(true);

    const zeroLosses = report.losses.filter((l) => l.tenant.includes(HASH_ZERO));
    expect(zeroLosses).toEqual([]);
  });

  it("D2 --apply preview (no --live): shows the same 15 losses (unfiltered), writes nothing", async () => {
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
    // Runs here, BEFORE D6 applies our grants — our tenant has its full 15 losses at this point,
    // 12 of which appear in --apply's "WOULD GRANT" section and 3 (addon-gate-courtesy) in its
    // separate "EXCLUDED" section, which is what makes the "the redacted tag IS expected to
    // appear" check below meaningful for the --apply preview calls too.
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

  it("D6 --apply --live with the correct phrase: writes one GRANT/GRANDFATHER override per APPLICABLE loss, excluding addon-gate-courtesy ones", async () => {
    // See applyLiveWithRetry's own doc comment: n is read fresh on each attempt (mirrors
    // backfill-legacy-tenant-ids.db.spec.ts's "read n from the tool's own output" pattern) and
    // retried only on a whole-database count drift from a concurrent sibling worker, never
    // hard-coded. n is the APPLICABLE count (excludedAddonGateLosses subtracted) — what --apply
    // --live actually writes and what the typed confirmation phrase is computed from.
    const { res, n } = await applyLiveWithRetry([]);
    expect(n).toBeGreaterThanOrEqual(EXPECTED_APPLICABLE_LOSS_KEYS.length); // at least our own 12
    expect(res.status).toBe(0);
    const result = JSON.parse(res.stdout) as Diff;
    expect(result.applied?.inserted).toBe(n);

    const rows = await activeOverrides(TENANT_LOSS_ID);
    expect(rows.map((r) => r.featureKey).sort()).toEqual(EXPECTED_APPLICABLE_LOSS_KEYS);
    // the 3 addon-gate-courtesy keys were NOT granted — that's the whole point of the exclusion
    for (const key of ADDON_GATE_COURTESY_KEYS) {
      expect(rows.map((r) => r.featureKey)).not.toContain(key);
    }
    const dbNowMs = await dbNaiveNowMs();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    for (const row of rows) {
      expect(row.effect).toBe("GRANT");
      expect(row.kind).toBe("GRANDFATHER");
      expect(row.createdById).toBeNull();
      expect(String(row.reason)).toContain("PR-0b");
      if (BILLABLE_APPLICABLE_KEYS.includes(row.featureKey)) {
        // N1: billable keys get a 90-day expiry, not a permanent grant.
        expect(row.expiresAt).not.toBeNull();
        const expiresAtMs = new Date(row.expiresAt as unknown as string).getTime();
        // generous ±1 hour window around exactly-90-days-from-the-db's-own-now to absorb test
        // run time (both sides read through the same naive-timestamp path — see dbNaiveNowMs).
        expect(Math.abs(expiresAtMs - (dbNowMs + ninetyDaysMs))).toBeLessThan(60 * 60 * 1000);
        expect(String(row.reason)).toContain("billable SKU, 90-day");
      } else {
        expect(row.expiresAt).toBeNull();
      }
    }
    // the zero tenant received nothing
    expect(await activeOverrides(TENANT_ZERO_ID)).toEqual([]);
  }, 60_000); // applyLiveWithRetry may spawn up to 8 CLI round-trips under real drift

  it("D7 --report after D6: the loss tenant shows ONLY the 3 excluded addon-gate-courtesy keys — --apply's grants explain everything else, but those were deliberately never granted", () => {
    const report = runReportJson();
    const ourLosses = report.losses
      .filter((l) => l.tenant.includes(HASH_LOSS))
      .map((l) => l.key)
      .sort();
    expect(ourLosses).toEqual([...ADDON_GATE_COURTESY_KEYS].sort());
    const zeroLosses = report.losses.filter((l) => l.tenant.includes(HASH_ZERO));
    expect(zeroLosses).toEqual([]);
  });

  it("D8 --apply --live again: idempotent — inserts nothing new, our tenant's 12 rows are untouched", async () => {
    const before = await activeOverrides(TENANT_LOSS_ID);
    expect(before).toHaveLength(12);

    // Check the "nothing to grant" path with its own fresh preview first — a separate read from
    // applyLiveWithRetry's own, so this branch isn't itself racing the preview inside the helper.
    const preview = runJson(["--apply"]);
    const previewN = preview.losses.length - (preview.excludedAddonGateLosses ?? 0);
    if (previewN === 0) {
      const res = runCli(["--apply", "--json"]);
      const result = JSON.parse(res.status === 0 ? res.stdout : "{}") as Partial<Diff>;
      expect(res.status).toBe(0);
      expect(result.applied).toBeNull();
    } else {
      // Something else in the shared database still shows a loss (not ours) — apply live again
      // (retrying on a whole-database count drift, see applyLiveWithRetry) and prove OUR rows
      // specifically are untouched, whatever total n the run reports.
      const { res } = await applyLiveWithRetry([]);
      expect(res.status).toBe(0);
    }

    const after = await activeOverrides(TENANT_LOSS_ID);
    expect(after).toEqual(before);
  }, 60_000); // applyLiveWithRetry may spawn up to 8 CLI round-trips under real drift

  it("D9 --apply --live --include-addon-gates: the 3 previously-excluded addon-gate-courtesy keys are now granted too (ocr gets a 90-day expiry too — it carries a real billing SKU independent of the exclusion mechanism)", async () => {
    // A dedicated preview first for the tenant-scoped assertions (independent of the one
    // applyLiveWithRetry issues internally — this one is never retried, since these assertions
    // are about OUR tenant's own rows, which no sibling worker can touch).
    const preview = runJson(["--apply", "--include-addon-gates"]);
    const ourLosses = preview.losses
      .filter((l) => l.tenant.includes(HASH_LOSS))
      .map((l) => l.key)
      .sort();
    // with --include-addon-gates, nothing is excluded — our tenant now shows exactly the 3
    // remaining addon-gate keys (the other 12 already have active overrides from D6, so no
    // diff remains for them regardless of the flag).
    expect(ourLosses).toEqual([...ADDON_GATE_COURTESY_KEYS].sort());
    expect(preview.excludedAddonGateLosses ?? 0).toBe(0);

    // See applyLiveWithRetry's own doc comment: n is a WHOLE-DATABASE count and this file runs
    // as one of many parallel jest workers against the same shared Postgres, so it retries on a
    // count drift from a concurrent sibling worker's own fixture tenants rather than assuming
    // the count read here would still match a few hundred milliseconds later.
    const { res, n } = await applyLiveWithRetry(["--include-addon-gates"]);
    expect(res.status).toBe(0);
    const result = JSON.parse(res.stdout) as Diff;
    expect(result.applied?.inserted).toBe(n);

    const rows = await activeOverrides(TENANT_LOSS_ID);
    expect(rows).toHaveLength(15); // the original 12 (D6) + these 3
    for (const key of ADDON_GATE_COURTESY_KEYS) {
      const row = rows.find((r) => r.featureKey === key);
      expect(row).toBeDefined();
      expect(row!.effect).toBe("GRANT");
      expect(row!.kind).toBe("GRANDFATHER");
      if (key === "ocr") {
        // ocr carries a real billing SKU (OCR_PACK_250) despite being addon-gate-courtesy —
        // billable-ness and the addon-gate exclusion are independent, orthogonal checks.
        expect(row!.expiresAt).not.toBeNull();
      } else {
        expect(row!.expiresAt).toBeNull();
      }
    }

    // and --report now shows zero losses for our tenant — every key is explained
    const report = runReportJson();
    const ourFinalLosses = report.losses.filter((l) => l.tenant.includes(HASH_LOSS));
    expect(ourFinalLosses).toEqual([]);
  }, 60_000); // applyLiveWithRetry may spawn up to 8 CLI round-trips under real drift
});
