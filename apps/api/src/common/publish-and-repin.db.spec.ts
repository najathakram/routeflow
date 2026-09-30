/**
 * PR-0b "zero-loss report" — `apps/api/scripts/publish-and-repin.mjs` executed against a REAL
 * Postgres, so the paths that actually touch data are proven rather than described. The pure
 * mirror-parity + fixture-logic proof lives in feature-registry-mirror.parity.spec.ts; what THIS
 * file proves is the CLI itself: that `--report` and `--apply` compute the same thing the pure
 * spec proves the mirror computes, that `--apply --live` actually writes, that a second
 * `--apply --live` is a no-op, that every refusal path writes nothing, and that no PII reaches
 * stdout.
 *
 * Fixture tenants, all pinned directly to a throwaway DRAFT PlanVersion this spec seeds (no
 * TenantSubscription row needed — Tenant.plan alone resolves via planKeyFromEnum, which
 * identity-maps STARTER/SCALE/LITE). Every case runs under the SCRIPT'S DEFAULT (--plan-flag-enforcement
 * defaults to "off" — the real, current production value per
 * project_entitlements_one_rule_2026-09-17.md: the 2026-09-17 P0 was the ON flip, reverted the
 * same morning and never re-enabled), matching what a real prod run actually computes.
 *
 * #2700 (SA-559b, "flags gain forward"): because the pin is a non-PUBLISHED version, the script
 * resolves each tenant's flags as the pinned definition's ∪ the PUBLISHED same-plan definition's.
 * The published catalog here is the real v12 (a fresh DB: ensurePublishedBaseline publishes it)
 * or v13 (a seeded DB: `local:seed` publishes it). v13 differs from v12 ONLY in LITE's flags, so
 * the published STARTER and SCALE are identical on both, and every expected set below is the SAME
 * on a fresh and a seeded database (SA-559h). Derivation, for the reader; the counts are asserted:
 *   - published STARTER = flag.returns + v12's five (estimates, recurring_invoices, credit_notes,
 *     suppliers, messaging); published SCALE additionally carries every other DARK_PLAN_FLAGS key
 *     and flag.credit_limits.
 *   - the "loss" tenant (and the later "keys" tenant): STARTER, pinned to flag.msrp/
 *     flag.sales_agents/flag.reports — deliberately WITHOUT flag.returns — no addons.
 *     Without the union it would show 16 losses (the 13 DARK_PLAN_FLAGS keys minus flag.reports,
 *     i.e. 12, + flag.credit_limits + the 3 addon-gate keys); the union removes the six the
 *     published STARTER carries (flag.returns among them — the no-false-loss pin), leaving EXPECTED_LOSS_KEYS (10): analytics, ap_bills,
 *     import_integrations, forecasting, pricing_tiers, addon.buyer_portal, flag.credit_limits
 *     (see the zero tenant below), and the 3 RequireAddon-dark keys with no active addon —
 *     ocr/crm_gohighlevel/email.connected_mailbox (a SEPARATE courtesy mechanism, addon-gate state,
 *     which has no env kill switch at all and is unaffected by PLAN_FLAG_ENFORCEMENT). Each of the
 *     10 is absent from BOTH the pinned and the published STARTER definition: a REAL loss.
 *     EXPECTED_APPLICABLE_LOSS_KEYS (7 = 10 − 3): what --apply actually WRITES by default — it
 *     excludes the 3 addon-gate-courtesy keys, because a permanent blanket GRANT would defeat those
 *     add-ons' own, separate, still-in-progress rollout process (design.md: "addon-gate-registry
 *     ... left alone, not an entitlement source").
 *   - the "scale" tenant (D1b): SCALE, pinned to feature-fixtures.ts's V11_PIN_FIXTURE flags
 *     (flag.msrp/flag.sales_agents/flag.reports/flag.returns). Before the union it showed the same
 *     15 losses the loss tenant used to; the published SCALE carries all 12 plan-flag keys among
 *     them, so it now shows ONLY the 3 addon-gate keys — the false losses SA-559b removes.
 *   - the "zero" tenant: LITE (always-enforced — feature-fixtures.ts's LITE_FIXTURE), plus
 *     flag.credit_limits ADDED to its plan definition. LITE alone would still show exactly one
 *     loss while enforcement is off: orders.service.ts's real isCreditLimitCheckEnabled() returns
 *     true unconditionally whenever PLAN_FLAG_ENFORCEMENT is not "on" — a fact about that one
 *     service call, not a courtesy allow LITE's always-enforced status exempts it from (see
 *     feature-registry-mirror.cjs's ALWAYS_EFFECTIVE_TODAY). Giving this tenant's plan the flag
 *     explicitly closes that one exception too, so it is a genuine zero-loss tenant — "a fixture
 *     tenant whose access is fully explained by preset/grants" in the literal, no-exceptions sense.
 *
 * B824: every CLI call this file makes is scoped with `--only-tenants` (runCli's own doc comment)
 * to exactly this spec's own (up to 4) fixture tenants, so the report/apply totals below are this
 * spec's totals, full stop — not a whole-database scan filtered after the fact. Before this fix, a
 * shared compose database's OTHER PRODUCTION-class tenants (sibling `*.db.spec.ts` files' own
 * fixtures, at minimum) could tip `--only-test-tenants`'s refusal or receive/contribute writes
 * from an unscoped `--apply --live`; every assertion still additionally keys off this spec's own
 * tenants by their redacted `#<ordinal> (<8-hex hash>)` tag (computed here with the SAME sha256
 * the script uses) as defense in depth, and reads `n`/count values back from the tool's own
 * preceding output rather than hard-coding them (same principle backfill-legacy-tenant-ids.db.spec.ts
 * uses for its BACKFILL <n> ROWS phrase).
 *
 * SAFETY. Every row this file creates lives inside four throwaway `qa-pr0b-*` tenants
 * (assertTestTenant) plus one fixture DRAFT PlanVersion and its three PlanDefinitions; teardown
 * deletes exactly those, in FK order. No PUBLISHED PlanVersion is ever demoted or modified (SA-559h). `--apply --live` here always passes --only-test-tenants too, so even if the
 * `--only-tenants` scope above were ever widened by mistake, an offending non-test-tenant row with
 * a loss still fails this spec (exit 3, offending slug printed) instead of silently granting
 * something.
 *
 * Collected only by jest.db.config.js (`.db.spec.ts$`) — run via `npm run local:test:db`.
 */
import { spawnSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import path from "path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Client, Pool } from "pg";
import { publishV12 } from "../../prisma/publish-plan-catalog-v12";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(API_DIR, "scripts/publish-and-repin.mjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
const ID_PREFIX = `qa-pr0b-${RUN_SUFFIX}-`;

const TENANT_LOSS_ID = `${ID_PREFIX}tenant-loss`;
const TENANT_LOSS_SLUG = assertTestTenant(
  `qa-pr0b-${RUN_SUFFIX}-loss`,
  "publish-and-repin.db.spec.ts",
);
const TENANT_ZERO_ID = `${ID_PREFIX}tenant-zero`;
const TENANT_ZERO_SLUG = assertTestTenant(
  `qa-pr0b-${RUN_SUFFIX}-zero`,
  "publish-and-repin.db.spec.ts",
);
// A THIRD, independent tenant for --include-addon-keys — kept separate from TENANT_LOSS so its
// exact-override-count assertions (D6/D8/D9) are never disturbed by a key-scoped grant landing
// mid-sequence. Same STARTER fixture plan def as TENANT_LOSS, so it starts with the identical 10
// losses, the 3 addon-gate-courtesy ones (ocr/crm_gohighlevel/email.connected_mailbox) among them.
const TENANT_KEYS_ID = `${ID_PREFIX}tenant-keys`;
const TENANT_KEYS_SLUG = assertTestTenant(
  `qa-pr0b-${RUN_SUFFIX}-keys`,
  "publish-and-repin.db.spec.ts",
);
// A FOURTH tenant for D1b (SA-559b): SCALE, pinned to the V11_PIN_FIXTURE SCALE definition — the
// shape whose 12 plan-flag "losses" the union shows were never losses.
const TENANT_SCALE_ID = `${ID_PREFIX}tenant-scale`;
const TENANT_SCALE_SLUG = assertTestTenant(
  `qa-pr0b-${RUN_SUFFIX}-scale`,
  "publish-and-repin.db.spec.ts",
);
// B824: every CLI call this file makes is scoped to exactly these 4 slugs (--only-tenants,
// baked into runCli below) — see runCli's own doc comment for the flake this fixes.
const ALL_SPEC_SLUGS = [TENANT_LOSS_SLUG, TENANT_ZERO_SLUG, TENANT_KEYS_SLUG, TENANT_SCALE_SLUG];
const PLAN_VERSION_ID = `${ID_PREFIX}planversion`;
const PLAN_DEF_STARTER_ID = `${ID_PREFIX}plandef-starter`;
const PLAN_DEF_SCALE_ID = `${ID_PREFIX}plandef-scale`;
const PLAN_DEF_LITE_ID = `${ID_PREFIX}plandef-lite`;
// Wide random range: a numeric PlanVersion.version collision with a concurrent lane is
// astronomically unlikely, and this row is deleted by id (not by version) in afterAll regardless.
const VERSION_NUM = 900000 + Math.floor(Math.random() * 90000);

// Deliberately WITHOUT flag.returns: the published STARTER carries it, so it must NOT read as a
// loss (the no-false-loss pin, SA-559h (4)).
const STARTER_PINNED_FLAGS = ["flag.msrp", "flag.sales_agents", "flag.reports"];
const SCALE_FLAGS = ["flag.msrp", "flag.sales_agents", "flag.reports", "flag.returns"];
const LITE_ZERO_LOSS_FLAGS = ["flag.credit_limits"];
const ADDON_GATE_COURTESY_KEYS = ["ocr", "crm_gohighlevel", "email.connected_mailbox"];
// All 10 — what --report shows for the STARTER loss tenant (enforcement=off, the script's
// default). Each is absent from BOTH the pinned and the published STARTER definition (header).
const EXPECTED_LOSS_KEYS = [
  "flag.analytics",
  "flag.ap_bills",
  "flag.import_integrations",
  "flag.forecasting",
  "flag.pricing_tiers",
  "addon.buyer_portal",
  ...ADDON_GATE_COURTESY_KEYS,
  "flag.credit_limits",
].sort();
// 7 — what --apply actually WRITES by default (excludes the 3 addon-gate-courtesy keys).
const EXPECTED_APPLICABLE_LOSS_KEYS = EXPECTED_LOSS_KEYS.filter(
  (k) => !ADDON_GATE_COURTESY_KEYS.includes(k),
).sort();
// N1, owner ruling 2026-09-19: of the 7 applicable keys, these three carry a real billing SKU
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
const HASH_KEYS = tag(TENANT_KEYS_ID);
const HASH_SCALE = tag(TENANT_SCALE_ID);

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

  /**
   * B824: every call this file makes is scoped to exactly this spec's own (up to 3) fixture
   * tenants via `--only-tenants`, baked in here so no call site can forget it. Before this,
   * every CLI invocation computed its diff over the WHOLE shared database (every PRODUCTION-class
   * tenant, `publish-and-repin.mjs`'s own, correct design for a real prod run) — under
   * `--maxWorkers=2`, sibling `*.db.spec.ts` files seeding their own PRODUCTION-class fixture
   * tenants made that scan see foreign tenants mid-flight, which could both (a) trip
   * `--only-test-tenants`'s refusal (exit 3, unretried — see applyLiveWithRetry's doc comment,
   * which handles a DIFFERENT symptom, a stale whole-database COUNT, not this) on a tenant that
   * was never ours, and (b) let an unscoped `--apply --live` (D6/D8/D9/K3, via
   * applyLiveWithRetry, which passes no tenant filter) grant overrides to a concurrent sibling's
   * own fixture tenant, or have ITS OWN fixture mutated by a sibling's equally-unscoped apply —
   * three observed occurrences, a different leaked/affected key subset each time, always drawn
   * from this file's own applicable-loss vocabulary (flag.estimates/forecasting/
   * import_integrations/messaging/pricing_tiers/recurring_invoices/suppliers), consistent with
   * cross-contamination between concurrent runs rather than one fixed culprit (B824, diagnosed on
   * #938). `--only-tenants` (same PR) narrows computeDiff()'s own Tenant query to a slug allowlist
   * — scoping every call here makes this file's reads and writes fully independent of whatever
   * else is running against the shared compose database, without serializing the lane. A slug
   * that doesn't exist yet (TENANT_KEYS, created only after D9) is simply absent from the
   * scoped result — harmless on the earlier D-numbered calls.
   */
  function runCli(args: string[], extraEnv: Record<string, string> = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
    for (const key of Object.keys(env)) {
      if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) delete env[key];
    }
    env.DATABASE_URL = databaseUrl;
    return spawnSync(process.execPath, [CLI, ...args, "--only-tenants", ALL_SPEC_SLUGS.join(",")], {
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
   * D6/D8/D9/K3 confirm a --live apply using a loss count `n` read from a PRECEDING, separate CLI
   * invocation's preview, then pass `GRANT ${n} OVERRIDES` to a LATER, separate `--live`
   * invocation that independently recomputes its own current `n` and compares. Since B824, every
   * call runCli makes is scoped with `--only-tenants` to exactly this spec's own tenants (see
   * runCli's doc comment), so a sibling `*.db.spec.ts` file's own fixture tenants — this file runs
   * as ONE of many PARALLEL jest workers against the SAME shared Postgres (`jest.db.config.js`
   * sets no maxWorkers/runInBand) — can no longer shift `n` between the two calls. This retry loop
   * is kept anyway as defense in depth (e.g. two independent CLI round-trips against our own
   * tenants racing a driver bug would still show up as a mismatch rather than a wrong write) —
   * retries with a fresh preview on a `phrase-mismatch` refusal only; any other refusal reason is
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

  // B592: the CLI refuses to run at all without a PUBLISHED plan catalog version ("nothing to
  // compute"), and on a FRESH database nothing but another spec's leftovers provided one — so this
  // file passed or failed with the lane's file order. It now guarantees its own baseline: when the
  // database has none it publishes the real v12 catalog (the same publisher `local:seed` uses) and
  // removes exactly that version again in afterAll. A database that already has one is untouched.
  let baselineVersion: number | null = null;

  async function ensurePublishedBaseline(): Promise<void> {
    const have = await db.query(`SELECT 1 FROM "PlanVersion" WHERE status = 'PUBLISHED' LIMIT 1`);
    if (have.rowCount) return;
    const pool = new Pool({ connectionString: databaseUrl });
    const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    try {
      const out = await publishV12(prisma);
      if (out.action === "published") baselineVersion = out.version;
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  }

  beforeAll(async () => {
    databaseUrl = requireLocalDatabaseUrl();
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    await ensurePublishedBaseline();

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
    await db.query(
      `INSERT INTO "PlanDefinition"
         ("id", "planVersionId", "planKey", "name", "msgsIncluded", "featureFlags", "sortOrder")
       VALUES ($1, $2, 'STARTER', 'Fixture Starter', 200, $3::text[], 2)`,
      [PLAN_DEF_STARTER_ID, PLAN_VERSION_ID, STARTER_PINNED_FLAGS],
    );

    // The "loss" tenant: STARTER, pinned to the fixture DRAFT version above. No addons, no
    // overrides: today's courtesy allow (flag AND addon) is the ONLY reason any of
    // EXPECTED_LOSS_KEYS would show effective for it.
    await db.query(
      `INSERT INTO "Tenant"
         ("id", "slug", "name", "status", "plan", "class", "planVersionId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'ACTIVE', 'STARTER'::"TenantPlan", 'PRODUCTION', $4, now(), now())`,
      [TENANT_LOSS_ID, TENANT_LOSS_SLUG, `PR-0b spec loss tenant ${RUN_SUFFIX}`, PLAN_VERSION_ID],
    );
    // The "scale" tenant (D1b): SCALE, pinned to the same DRAFT — feature-fixtures.ts's
    // V11_PIN_FIXTURE shape.
    await db.query(
      `INSERT INTO "Tenant"
         ("id", "slug", "name", "status", "plan", "class", "planVersionId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'ACTIVE', 'SCALE'::"TenantPlan", 'PRODUCTION', $4, now(), now())`,
      [
        TENANT_SCALE_ID,
        TENANT_SCALE_SLUG,
        `PR-0b spec scale tenant ${RUN_SUFFIX}`,
        PLAN_VERSION_ID,
      ],
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
    const specTenants = [TENANT_LOSS_ID, TENANT_ZERO_ID, TENANT_SCALE_ID];
    await db.query('DELETE FROM "TenantFeatureOverride" WHERE "tenantId" = ANY($1)', [specTenants]);
    await db.query('DELETE FROM "Tenant" WHERE "id" = ANY($1)', [specTenants]);
    await db.query('DELETE FROM "PlanDefinition" WHERE "planVersionId" = $1', [PLAN_VERSION_ID]);
    await db.query('DELETE FROM "PlanVersion" WHERE "id" = $1', [PLAN_VERSION_ID]);
    if (baselineVersion !== null) {
      const ours = `(SELECT "id" FROM "PlanVersion" WHERE "version" = $1 AND "status" = 'PUBLISHED')`;
      await db.query(`DELETE FROM "AddonSku" WHERE "planVersionId" IN ${ours}`, [baselineVersion]);
      await db.query(`DELETE FROM "PlanDefinition" WHERE "planVersionId" IN ${ours}`, [
        baselineVersion,
      ]);
      await db.query(
        'DELETE FROM "PlanVersion" WHERE "version" = $1 AND "status" = \'PUBLISHED\'',
        [baselineVersion],
      );
    }
    await db.end();
  }, 120_000);

  it("D1 --report: the STARTER loss tenant shows exactly the 10 EXPECTED_LOSS_KEYS (7 applicable) as LOSSES — flag.returns is NOT one; the zero tenant shows none", async () => {
    const report = runReportJson();
    // the default — matches the real, current production value (see the file header)
    expect(report.planFlagEnforcementAssumed).toBe("off");

    const ourLosses = report.losses
      .filter((l) => l.tenant.includes(HASH_LOSS))
      .map((l) => l.key)
      .sort();
    expect(EXPECTED_LOSS_KEYS).toHaveLength(10);
    expect(EXPECTED_APPLICABLE_LOSS_KEYS).toHaveLength(7);
    expect(ourLosses).toEqual(EXPECTED_LOSS_KEYS);

    // SA-559h (4), the DB-level no-false-loss pin: the tenant's PINNED (DRAFT) STARTER definition
    // lacks flag.returns — read back from the database, not assumed — while the PUBLISHED STARTER
    // carries it, so flags-gain-forward explains it and it is NOT a loss. Without the union this
    // key reads as a loss (flag.returns is a DARK_PLAN_FLAGS courtesy key).
    const pinned = await db.query(`SELECT "featureFlags" FROM "PlanDefinition" WHERE "id" = $1`, [
      PLAN_DEF_STARTER_ID,
    ]);
    expect(pinned.rows[0].featureFlags).not.toContain("flag.returns");
    const published = await db.query(
      `SELECT d."featureFlags" FROM "PlanDefinition" d
         JOIN "PlanVersion" v ON v."id" = d."planVersionId"
        WHERE v."status" = 'PUBLISHED' AND d."planKey" = 'STARTER'`,
    );
    expect(published.rowCount).toBe(1);
    expect(published.rows[0].featureFlags).toContain("flag.returns");
    expect(ourLosses).not.toContain("flag.returns");
    // every addon-gate-courtesy loss is labeled as such (report shows the FULL set — the
    // apply-time exclusion is a write-path decision, not a report-time one)
    const addonGateLosses = report.losses.filter(
      (l) => l.tenant.includes(HASH_LOSS) && ADDON_GATE_COURTESY_KEYS.includes(l.key),
    );
    expect(addonGateLosses.every((l) => l.mechanism === "addon-gate-courtesy")).toBe(true);

    const zeroLosses = report.losses.filter((l) => l.tenant.includes(HASH_ZERO));
    expect(zeroLosses).toEqual([]);
  });

  it("D1b --report (SA-559b): the SCALE tenant pinned to the V11_PIN_FIXTURE shape shows EXACTLY the 3 addon-gate keys and no plan flag — the published SCALE carries the other 12, so they are not losses", () => {
    const report = runReportJson();
    const scaleLosses = report.losses.filter((l) => l.tenant.includes(HASH_SCALE));
    expect(scaleLosses.map((l) => l.key).sort()).toEqual([...ADDON_GATE_COURTESY_KEYS].sort());
    expect(scaleLosses.every((l) => l.mechanism === "addon-gate-courtesy")).toBe(true);
  });

  it("D2 --apply preview (no --live): shows the same 10 losses (unfiltered), writes nothing", async () => {
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
    // Runs here, BEFORE D6 applies our grants — our tenant has its full 10 losses at this point,
    // 7 of which appear in --apply's "WOULD GRANT" section and 3 (addon-gate-courtesy) in its
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
    // backfill-legacy-tenant-ids.db.spec.ts's "read n from the tool's own output" pattern), never
    // hard-coded. n is the APPLICABLE count (excludedAddonGateLosses subtracted) — what --apply
    // --live actually writes and what the typed confirmation phrase is computed from.
    const { res, n } = await applyLiveWithRetry([]);
    // SA-559h (5): the GRANT set EQUALS the applicable set — nothing more. Scoped to this spec's
    // own tenants (B824), n is exactly the loss tenant's 7; the scale and zero tenants have no
    // applicable loss (the scale tenant's 3 are all addon-gate-courtesy, excluded by default).
    expect(n).toBe(EXPECTED_APPLICABLE_LOSS_KEYS.length);
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
    // the zero and scale tenants received nothing
    expect(await activeOverrides(TENANT_ZERO_ID)).toEqual([]);
    expect(await activeOverrides(TENANT_SCALE_ID)).toEqual([]);
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

  it("D8 --apply --live again: idempotent — inserts nothing new, our tenant's 7 rows are untouched", async () => {
    const before = await activeOverrides(TENANT_LOSS_ID);
    expect(before).toHaveLength(EXPECTED_APPLICABLE_LOSS_KEYS.length);

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
      // Scoped to our own tenants (B824), previewN should always be 0 here — D6 already granted
      // everything applicable. Kept as a defensive branch: apply live again and prove OUR rows
      // specifically are untouched, whatever n this run reports.
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
    // remaining addon-gate keys (the other 7 already have active overrides from D6, so no
    // diff remains for them regardless of the flag).
    expect(ourLosses).toEqual([...ADDON_GATE_COURTESY_KEYS].sort());
    expect(preview.excludedAddonGateLosses ?? 0).toBe(0);

    // See applyLiveWithRetry's own doc comment: n is a WHOLE-DATABASE count and this file runs
    // as one of many parallel jest workers against the same shared Postgres, so it retries on a
    // count drift from a concurrent sibling worker's own fixture tenants rather than assuming
    // the count read here would still match a few hundred milliseconds later.
    const { res, n } = await applyLiveWithRetry(["--include-addon-gates"]);
    // Exactly the 3 addon-gate keys for each of the loss and scale tenants — nothing more.
    expect(n).toBe(2 * ADDON_GATE_COURTESY_KEYS.length);
    expect(res.status).toBe(0);
    const result = JSON.parse(res.stdout) as Diff;
    expect(result.applied?.inserted).toBe(n);
    expect((await activeOverrides(TENANT_SCALE_ID)).map((r) => r.featureKey).sort()).toEqual(
      [...ADDON_GATE_COURTESY_KEYS].sort(),
    );

    const rows = await activeOverrides(TENANT_LOSS_ID);
    expect(rows).toHaveLength(EXPECTED_LOSS_KEYS.length); // the original 7 (D6) + these 3
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

  describe("--include-addon-keys", () => {
    // TENANT_KEYS is created HERE, after D6/D8/D9 already ran their WHOLE-DATABASE `--apply
    // --live` writes — those grant every applicable loss for every PRODUCTION tenant, not just
    // TENANT_LOSS, so a tenant seeded any earlier would already be fully explained (zero losses)
    // by the time these tests run. Creating it in its own nested beforeAll, scheduled after D9's
    // `it`, is what keeps it a genuine 10-loss fixture for K3.
    beforeAll(async () => {
      await db.query(
        `INSERT INTO "Tenant"
           ("id", "slug", "name", "status", "plan", "class", "planVersionId", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, 'ACTIVE', 'STARTER'::"TenantPlan", 'PRODUCTION', $4, now(), now())`,
        [TENANT_KEYS_ID, TENANT_KEYS_SLUG, `PR-0b spec keys tenant ${RUN_SUFFIX}`, PLAN_VERSION_ID],
      );
    }, 120_000);

    afterAll(async () => {
      await db.query('DELETE FROM "TenantFeatureOverride" WHERE "tenantId" = $1', [TENANT_KEYS_ID]);
      await db.query('DELETE FROM "Tenant" WHERE "id" = $1', [TENANT_KEYS_ID]);
    }, 120_000);

    it("K1 conflicts with --include-addon-gates: exit 2, refused before connecting", () => {
      const res = runCli(["--apply", "--include-addon-gates", "--include-addon-keys", "ocr"]);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain("mutually exclusive");
    });

    it("K2 with an unknown/non-addon-gate key: exit 2, refused before connecting", () => {
      const res = runCli(["--apply", "--include-addon-keys", "flag.msrp,not_a_real_key"]);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('"flag.msrp" is not a FEATURE_REGISTRY addon-gate key');
      expect(res.stderr).toContain('"not_a_real_key" is not a FEATURE_REGISTRY addon-gate key');
    });

    it("K3 --apply --include-addon-keys ocr,email.connected_mailbox: preview names included vs. still-excluded addon keys; --live grants only those two (ocr gets a 90-day expiry, email.connected_mailbox does not), crm_gohighlevel stays excluded", async () => {
      const prose = runCli(["--apply", "--include-addon-keys", "ocr,email.connected_mailbox"]);
      expect(prose.status).toBe(0);
      expect(prose.stdout).toContain("included: email.connected_mailbox, ocr");
      expect(prose.stdout).toContain("still excluded: crm_gohighlevel");

      const { res, n } = await applyLiveWithRetry([
        "--include-addon-keys",
        "ocr,email.connected_mailbox",
      ]);
      // The keys tenant's 7 applicable losses + the 2 listed addon-gate keys, nothing more.
      expect(n).toBe(EXPECTED_APPLICABLE_LOSS_KEYS.length + 2);
      expect(res.status).toBe(0);
      const result = JSON.parse(res.stdout) as Diff;
      expect(result.applied?.inserted).toBe(n);

      // the default (unfiltered) 7 plan-flag-courtesy losses land too — --include-addon-keys
      // only narrows which addon-gate-courtesy rows join that same applicable set, the same code
      // path --include-addon-gates already uses — plus the two listed addon-gate keys;
      // crm_gohighlevel is the only one held back.
      const rows = await activeOverrides(TENANT_KEYS_ID);
      expect(rows.map((r) => r.featureKey).sort()).toEqual(
        [...EXPECTED_APPLICABLE_LOSS_KEYS, "email.connected_mailbox", "ocr"].sort(),
      );
      const ocrRow = rows.find((r) => r.featureKey === "ocr")!;
      const mailboxRow = rows.find((r) => r.featureKey === "email.connected_mailbox")!;
      expect(ocrRow.expiresAt).not.toBeNull(); // billable (OCR_PACK_250), same 90-day rule as N1
      expect(mailboxRow.expiresAt).toBeNull(); // not billable

      const report = runReportJson();
      const keysLosses = report.losses
        .filter((l) => l.tenant.includes(HASH_KEYS))
        .map((l) => l.key);
      expect(keysLosses).toEqual(["crm_gohighlevel"]);
    }, 60_000); // applyLiveWithRetry may spawn up to 8 CLI round-trips under real drift
  });
});
