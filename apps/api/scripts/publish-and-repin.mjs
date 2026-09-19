#!/usr/bin/env node
/**
 * PR-0b "zero-loss report" — pre-flight gate for retiring the legacy entitlement layers
 * (`DARK_PLAN_FLAGS`, `PREPIN_DARK_FLAGS`, `PLAN_FLAG_ENFORCEMENT`) under the owner's 2026-09-17
 * "one rule: preset + grants − denies" ruling (`project_entitlements_one_rule_2026-09-17.md`).
 *
 * Full design: local-assets/handoff/2026-09-16/feature-grants-v2/design.md §3 "PR-0b". This
 * script builds the narrower slice design.md's PR-0b bullet describes plus the "owner-run report"
 * item from `local-assets/handoff/2026-09-19/decisions-prep.md` §1 (Decision A): the report, and
 * an apply step that closes a loss with an explicit per-tenant GRANT override — the SAME
 * mechanism the platform-admin console already uses (`FeatureOverrideService`/
 * `TenantFeatureOverride`). It deliberately does NOT implement design.md's fuller PR-0b (catalog
 * v12 re-pin, `previousPlanVersionId`/`repinnedAt`, `--rollback`, `entitlements.mode=live` switch,
 * or registry `usage` probes for usage-based grandfathering) — catalog v12 already has its own
 * publisher (`apps/api/prisma/publish-plan-catalog-v12.ts`), and the rest is out of scope for this
 * PR; see the PR description for the full scoping note. This script never touches
 * `plan-flag-policy.ts` / `plan-flag.guard.ts` — deleting those is PR-0, a separate change that
 * lands only after `--report` shows zero losses on prod.
 *
 * MODES (mutually exclusive; `--report` is the default)
 *   --report (default, READ-ONLY)   For every PRODUCTION tenant (Tenant.class = 'PRODUCTION',
 *       status NOT IN ('CANCELLED','SUSPENDED'), not soft-deleted) and every FEATURE_REGISTRY key,
 *       compute (a) today's effective entitlement under the current four-layer resolver
 *       (mirrors EntitlementAuthority.computeOldPathAll) and (b) the entitlement under the one
 *       rule ((preset ∪ purchasedAddons ∪ grants) − denies; mirrors resolveOneKey). Prints
 *       GAINS (one rule grants, today denies) and LOSSES (today grants, one rule denies), then
 *       totals. The exit code is the gate — see EXIT CODES below.
 *
 * PLAN_FLAG_ENFORCEMENT — READ THIS BEFORE TRUSTING A "LOSSES: 0" RESULT. The old-path
 *   computation needs to know whether the API service's PLAN_FLAG_ENFORCEMENT kill switch is
 *   currently "on" or "off" (it changes which flags the legacy dark-flag courtesy allow covers —
 *   see plan-flag-policy.ts). This script does NOT read that live — `railway run --service
 *   postgres <cmd>` injects only the POSTGRES service's variables, never the API service's, so
 *   `process.env.PLAN_FLAG_ENFORCEMENT` would silently read as unset (i.e. "off") regardless of
 *   the API service's real setting, understating real losses for every flag in DARK_PLAN_FLAGS
 *   but outside PREPIN_DARK_FLAGS. `--plan-flag-enforcement=on|off` makes the assumption an
 *   explicit, printed argument instead: it defaults to "on" (the known value since the
 *   2026-09-17 P0 flip — project_entitlements_one_rule_2026-09-17.md), and the report always
 *   prints which value it used. Before running for real, confirm today's actual value (Railway
 *   dashboard → api service → variables) and pass `--plan-flag-enforcement=off` if it disagrees.
 *   --apply    For each LOSS, writes an explicit per-tenant GRANT override (kind=GRANDFATHER) so
 *       the one rule reproduces today's access — the same "grandfather" idea design.md's fuller
 *       PR-0b describes, applied directly as overrides rather than via a catalog re-pin. Without
 *       `--live` this ONLY prints the preview (what would be granted) and writes nothing — run
 *       `--report`, then `--apply` (preview), then `--apply --live ...` in that order. `--live`
 *       requires `--backup-attested "<backup name>"` and a typed confirmation
 *       (`GRANT <n> OVERRIDES`, n computed from THIS run's own count). Idempotent: a key with an
 *       active override (from a prior run or a pre-existing manual one) can never show as a loss
 *       again — both paths check overrides FIRST and agree once one exists — and the INSERT
 *       itself is `ON CONFLICT (tenantId, featureKey) WHERE revokedAt IS NULL DO NOTHING`, so a
 *       second `--apply --live` writes nothing even under a concurrent write.
 *
 * UNATTENDED WRITES — ONLY INTO APPROVED TEST TENANTS (mirrors backfill-legacy-tenant-ids.mjs)
 *   --only-test-tenants   Before any write, every tenant that would receive a grant must resolve
 *       to an approved test tenant (isTestTenant, scripts/lib/test-tenants.cjs) — ONE offending
 *       tenant refuses the WHOLE batch, exit 3, zero writes. Enforced in the preview too, so the
 *       preview an operator reads is the exact preflight of what `--live` would do.
 *   --confirm "<phrase>"  Supplies the typed confirmation as a value instead of a TTY prompt.
 *       Accepted ONLY alongside `--only-test-tenants` (exit 2 otherwise, before connecting), and
 *       the phrase must equal exactly what the prompt would have asked for.
 *
 * TEST-ONLY HOOK
 *   PUBLISH_REPIN_CONFIRM_TOKEN — supplies the typed confirmation as a value instead of reading a
 *   TTY, so apps/api/src/common/publish-and-repin.db.spec.ts can execute --apply --live against
 *   the compose database. Honoured ONLY inside a jest worker (JEST_WORKER_ID set), with a WARNING
 *   line; ignored — loudly — anywhere else. Does NOT relax --backup-attested.
 *
 * NO PII — the report and apply preview print tenants as `#<ordinal> (<8-hex id hash>)`, NEVER a
 * slug, name, or email. (The `--only-test-tenants` REFUSAL diagnostic is the one deliberate
 * exception, matching backfill-legacy-tenant-ids.mjs precedent: it names the offending tenant's
 * slug so the operator can see exactly what tripped the guard — this only ever fires against a
 * non-production database, since a real prod `--apply` does not pass `--only-test-tenants`.)
 *
 * PRODUCTION-SAFETY RULES
 *   - `default_transaction_read_only = on` for the whole session in `--report` and for the
 *     preview half of `--apply`; lifted only after the typed confirmation, immediately before
 *     opening each tenant's write transaction (one transaction PER TENANT, not one for the whole
 *     run — a failure on tenant N never rolls back grants already committed for tenants 1..N-1).
 *   - `statement_timeout` caps every query.
 *   - Never prints a connection string — only host+database (see redactUrl in lib/railway-db-url.mjs).
 *   - OWNER-RUN ONLY, from any cwd (this file lives in apps/api/scripts, resolves its sibling
 *     lib/ files by its own location, and needs no other cwd-relative path):
 *       railway run --service postgres node apps/api/scripts/publish-and-repin.mjs --report
 *
 * EXIT CODES
 *   0  --report: LOSSES = 0 (safe to apply). --apply: preview printed, or --live applied
 *      everything (including "nothing to grant").
 *   1  error — no database URL, connection or query failure, transaction error.
 *   2  argument refusal, raised BEFORE any connection is opened.
 *   3  --live confirmation refused (non-TTY with no token, mismatched phrase, missing
 *      --backup-attested) or the --only-test-tenants guard refused the batch.
 *   4  --report only: LOSSES > 0 — repin required. THIS IS THE GATE.
 */
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import readline from "node:readline";
import { resolveDatabaseUrl, redactUrl } from "./lib/railway-db-url.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const {
  FEATURE_REGISTRY_MIRROR,
  computeOldPathEffective,
  computeNewPathEffective,
  planKeyFromEnum,
  findPlanDefinition,
  addonSkuCode,
} = require("./lib/feature-registry-mirror.cjs");
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const HELP = `publish-and-repin.mjs — PR-0b zero-loss report / grandfather-grant apply

Usage: node apps/api/scripts/publish-and-repin.mjs
         [--report | --apply] [--live] [--backup-attested "<text>"]
         [--only-test-tenants [--confirm "<phrase>"]] [--plan-flag-enforcement on|off]
         [--json] [--help]

Modes (default --report):
  --report    read-only: per-tenant GAINS/LOSSES vs. the one-rule resolver. Exit 4 if LOSSES > 0.
  --apply     without --live: preview only, writes nothing.
              with --live: writes one GRANT (kind=GRANDFATHER) override per LOSS. Requires
              --backup-attested AND a typed confirmation ("GRANT <n> OVERRIDES").

  --plan-flag-enforcement on|off   the API service's CURRENT PLAN_FLAG_ENFORCEMENT value — this
                         script cannot read it live (see the header doc). Defaults to "on" (the
                         known value since the 2026-09-17 P0). Confirm the real value before a
                         production run; the report always prints which one it used.

Unattended --apply --live (approved TEST tenants only):
  --only-test-tenants    every tenant that would receive a grant must be an approved test tenant
                         (scripts/lib/test-tenants.cjs) — one offender refuses the whole batch.
  --confirm "<phrase>"   supply the typed confirmation as a value (requires --only-test-tenants).

  --json      emit the report/preview as JSON instead of prose.
  --help      print this help and exit 0.

Exit codes: 0 ok · 1 error · 2 argument refusal · 3 confirmation/guard refused
            · 4 (--report only) LOSSES > 0 — repin required
`;

function parseArgs(argv) {
  const opts = {
    help: false,
    apply: false,
    live: false,
    json: false,
    backupAttested: null,
    onlyTestTenants: false,
    confirm: null,
    // See the header doc and the const below this function: this does NOT read the live API
    // service's actual env var. Defaults to "on" — the KNOWN current production value (the
    // 2026-09-17 P0 flip) — because `railway run --service postgres <cmd>` injects only the
    // POSTGRES service's variables, never the API service's PLAN_FLAG_ENFORCEMENT.
    planFlagEnforcement: "on",
    errors: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--report")
      continue; // accepted as an explicit synonym for the default
    else if (arg === "--apply") opts.apply = true;
    else if (arg === "--live") opts.live = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--backup-attested") opts.backupAttested = argv[++i] ?? "";
    else if (arg.startsWith("--backup-attested="))
      opts.backupAttested = arg.slice("--backup-attested=".length);
    else if (arg === "--only-test-tenants") opts.onlyTestTenants = true;
    else if (arg === "--confirm") opts.confirm = argv[++i] ?? "";
    else if (arg.startsWith("--confirm=")) opts.confirm = arg.slice("--confirm=".length);
    else if (arg === "--plan-flag-enforcement") opts.planFlagEnforcement = argv[++i] ?? "";
    else if (arg.startsWith("--plan-flag-enforcement="))
      opts.planFlagEnforcement = arg.slice("--plan-flag-enforcement=".length);
    else opts.errors.push(`unknown argument "${arg}"`);
  }
  if (opts.live && !opts.apply) {
    opts.errors.push("--live has no effect without --apply");
  }
  if (opts.planFlagEnforcement !== "on" && opts.planFlagEnforcement !== "off") {
    opts.errors.push('--plan-flag-enforcement must be exactly "on" or "off"');
  }
  if (opts.confirm !== null && !opts.onlyTestTenants) {
    opts.errors.push(
      '--confirm "<phrase>" requires --only-test-tenants — an unattended confirmation is allowed ' +
        "only when every tenant that would receive a grant resolves to an approved test tenant; " +
        "any other target keeps the interactive TTY confirmation as its only path",
    );
  }
  if (opts.live && !String(opts.backupAttested ?? "").trim()) {
    opts.errors.push(
      '--live requires --backup-attested "<free text naming the fresh backup>" — take the ' +
        "backup first, then say which one it is",
    );
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}
if (opts.errors.length > 0) {
  for (const error of opts.errors) console.error(`publish-and-repin: ${error}`);
  console.error("publish-and-repin: refused before opening any connection");
  process.exit(2);
}

const mode = opts.apply ? "apply" : "report";
const say = opts.json ? () => {} : (...args) => console.log(...args);

let databaseUrl;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch (e) {
  console.error(`publish-and-repin: ${e.message}`);
  process.exit(1);
}
const target = redactUrl(databaseUrl);

// ─── no-PII tenant display ──────────────────────────────────────────────────────────────────
// sha256, not for cryptographic secrecy (a tenant id is not a secret) but so the report never
// carries the raw id either — only a short, non-reversible-in-practice tag an operator can use to
// tell "the same tenant" apart across GAINS/LOSSES lines within one run.
function tenantTag(ordinal, tenantId) {
  const hash = createHash("sha256").update(tenantId).digest("hex").slice(0, 8);
  return `#${ordinal} (${hash})`;
}

// ─── catalog loading (mirrors PlanCatalogService, plain SQL — see audit-tenant-entitlements.mjs
// for the identical established pattern) ──────────────────────────────────────────────────────

function makeCatalogLoader(query) {
  const versionCache = new Map();
  let publishedVersion = null;

  async function loadCatalogVersion(id) {
    const [version] = await query(`SELECT id, version, status FROM "PlanVersion" WHERE id = $1`, [
      id,
    ]);
    if (!version) return null;
    const definitions = await query(
      `SELECT "planKey", "featureFlags" FROM "PlanDefinition" WHERE "planVersionId" = $1 ORDER BY "sortOrder" ASC`,
      [id],
    );
    const addonSkus = await query(
      `SELECT sku, "grantsFlags" FROM "AddonSku" WHERE "planVersionId" = $1 ORDER BY "sortOrder" ASC`,
      [id],
    );
    return { ...version, definitions, addonSkus };
  }

  async function loadPublishedVersion() {
    const [row] = await query(
      `SELECT id FROM "PlanVersion" WHERE status = 'PUBLISHED' ORDER BY version DESC LIMIT 1`,
    );
    if (!row) return null;
    return loadCatalogVersion(row.id);
  }

  async function getVersionById(id) {
    if (versionCache.has(id)) return versionCache.get(id);
    const v = await loadCatalogVersion(id);
    versionCache.set(id, v);
    return v;
  }

  async function init() {
    publishedVersion = await loadPublishedVersion();
    return publishedVersion;
  }

  async function getVersionForTenant(planVersionId) {
    const version = planVersionId
      ? ((await getVersionById(planVersionId)) ?? publishedVersion)
      : publishedVersion;
    if (!version) throw new Error("No published plan catalog exists.");
    return version;
  }

  return { init, getVersionForTenant, getPublished: () => publishedVersion };
}

// ─── EntitlementsService.compute() mirror (plain JS; see feature-registry-mirror.cjs's header for
// why this lives here rather than in a shared module, and audit-tenant-entitlements.mjs for the
// sibling copy this is kept in lock-step with) ─────────────────────────────────────────────────

async function computeEntitlements(tenant, activeAddons, catalog) {
  const planKey = tenant.subPlanKey ?? planKeyFromEnum(tenant.plan);
  const version = await catalog.getVersionForTenant(tenant.planVersionId);

  const exactDef = findPlanDefinition(version.definitions, planKey);
  const def =
    exactDef ?? version.definitions.find((d) => d.planKey === "STARTER") ?? version.definitions[0];
  if (!def) throw new Error(`Plan catalog version ${version.id} has no plan definitions`);
  const effectivePlanKey = def.planKey;

  const skuByCode = new Map(version.addonSkus.map((s) => [s.sku, s]));
  const flags = new Set(def.featureFlags);

  let publishedSkuByCode = null;
  for (const addon of activeAddons) {
    const code = addonSkuCode(addon);
    if (!code) continue;
    let meta = skuByCode.get(code);
    if (!meta) {
      if (!publishedSkuByCode) {
        const published = catalog.getPublished();
        publishedSkuByCode =
          published.id === version.id
            ? new Map()
            : new Map(published.addonSkus.map((s) => [s.sku, s]));
      }
      meta = publishedSkuByCode.get(code);
    }
    if (!meta) continue;
    for (const flag of meta.grantsFlags) flags.add(flag);
  }

  return { planKey: effectivePlanKey, flags: [...flags] };
}

// ─── main ─────────────────────────────────────────────────────────────────────────────────────

let client = null;

function connect(connectionString) {
  return new Client({ connectionString });
}

function confirmTokenOverride() {
  const raw = process.env.PUBLISH_REPIN_CONFIRM_TOKEN;
  if (!raw) return undefined;
  if (!process.env.JEST_WORKER_ID) {
    console.error(
      "publish-and-repin: PUBLISH_REPIN_CONFIRM_TOKEN is ignored outside test " +
        "(JEST_WORKER_ID unset); the confirmation must be typed on a TTY",
    );
    return undefined;
  }
  console.error(
    "publish-and-repin: WARNING: test override PUBLISH_REPIN_CONFIRM_TOKEN active — this is NOT " +
      "an owner-typed confirmation",
  );
  return raw;
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Loads every PRODUCTION tenant plus everything needed to resolve entitlements for each,
 *  and returns the per-tenant GAINS/LOSSES diff against FEATURE_REGISTRY_MIRROR. Read-only. */
async function computeDiff() {
  const tenants = await client
    .query(
      `SELECT t.id, t.slug, t.plan, t."planVersionId", s."planKey" AS "subPlanKey"
         FROM "Tenant" t
         LEFT JOIN "TenantSubscription" s ON s."tenantId" = t.id
        WHERE t.class = 'PRODUCTION'
          AND t.status NOT IN ('CANCELLED', 'SUSPENDED')
          AND t."deletedAt" IS NULL
        ORDER BY t.id ASC`,
    )
    .then((r) => r.rows);

  const addonRows = await client
    .query(`SELECT "tenantId", "addonKey", sku FROM "TenantAddon" WHERE active = true`)
    .then((r) => r.rows);
  const addonsByTenant = new Map();
  for (const row of addonRows) {
    const list = addonsByTenant.get(row.tenantId) ?? [];
    list.push(row);
    addonsByTenant.set(row.tenantId, list);
  }

  const overrideRows = await client
    .query(
      `SELECT "tenantId", "featureKey", effect, "expiresAt"
         FROM "TenantFeatureOverride"
        WHERE "revokedAt" IS NULL`,
    )
    .then((r) => r.rows);
  const overridesByTenant = new Map();
  const now = Date.now();
  for (const row of overrideRows) {
    if (row.expiresAt && new Date(row.expiresAt).getTime() <= now) continue; // expired, not active
    const map = overridesByTenant.get(row.tenantId) ?? new Map();
    map.set(row.featureKey, row.effect);
    overridesByTenant.set(row.tenantId, map);
  }

  const catalog = makeCatalogLoader((sql, params) => client.query(sql, params).then((r) => r.rows));
  const published = await catalog.init();
  if (!published) throw new Error("No PUBLISHED plan catalog version found — nothing to compute.");

  // Explicit, never ambient — see the header doc's "PLAN_FLAG_ENFORCEMENT" section for why this
  // is NOT read from process.env.PLAN_FLAG_ENFORCEMENT.
  const oldPathEnv = { PLAN_FLAG_ENFORCEMENT: opts.planFlagEnforcement };

  const gains = [];
  const losses = [];
  const errors = [];
  let ordinal = 0;
  for (const tenant of tenants) {
    ordinal++;
    const tag = tenantTag(ordinal, tenant.id);
    let ent;
    try {
      ent = await computeEntitlements(tenant, addonsByTenant.get(tenant.id) ?? [], catalog);
    } catch (e) {
      errors.push({ tag, tenantId: tenant.id, error: e.message });
      continue;
    }
    const ctx = {
      overrides: overridesByTenant.get(tenant.id) ?? new Map(),
      activeAddonSet: new Set((addonsByTenant.get(tenant.id) ?? []).map((a) => a.addonKey)),
      planKey: ent.planKey,
      entFlags: ent.flags,
    };
    for (const feature of FEATURE_REGISTRY_MIRROR) {
      const oldEff = computeOldPathEffective(feature, ctx, oldPathEnv);
      const newEff = computeNewPathEffective(feature, ctx);
      if (oldEff === newEff) continue;
      const row = { tag, tenantId: tenant.id, slug: tenant.slug, key: feature.key };
      if (newEff && !oldEff) gains.push(row);
      else losses.push(row);
    }
  }

  return {
    tenantCount: tenants.length,
    keyCount: FEATURE_REGISTRY_MIRROR.length,
    planFlagEnforcementAssumed: opts.planFlagEnforcement,
    gains,
    losses,
    errors,
  };
}

function printDiffTable(title, rows) {
  say(`\n${title} (${rows.length})`);
  if (rows.length === 0) {
    say("  (none)");
    return;
  }
  for (const row of rows) say(`  ${row.tag}  ${row.key}`);
}

function emitJsonDiff(diff, extra = {}) {
  if (!opts.json) return;
  console.log(
    JSON.stringify(
      {
        mode,
        target,
        generatedAt: new Date().toISOString(),
        tenantsScanned: diff.tenantCount,
        registryKeys: diff.keyCount,
        planFlagEnforcementAssumed: diff.planFlagEnforcementAssumed,
        gains: diff.gains.map((r) => ({ tenant: r.tag, key: r.key })),
        losses: diff.losses.map((r) => ({ tenant: r.tag, key: r.key })),
        resolutionErrors: diff.errors,
        summary: { gains: diff.gains.length, losses: diff.losses.length },
        ...extra,
      },
      null,
      2,
    ),
  );
}

async function runReport() {
  say(`\n=== PR-0b ZERO-LOSS REPORT — ${target} ===`);
  say("    session is READ ONLY; no writes are possible\n");
  say(
    `⚠ PLAN_FLAG_ENFORCEMENT assumed: "${opts.planFlagEnforcement}" (NOT read from the live API ` +
      `service — pass --plan-flag-enforcement=off if that disagrees with today's real value; see ` +
      "this script's header doc)\n",
  );

  const diff = await computeDiff();
  say(`Tenants scanned: ${diff.tenantCount}   Registry keys checked: ${diff.keyCount}`);
  if (diff.errors.length > 0) {
    say(`\n⚠ RESOLUTION ERRORS (${diff.errors.length}, excluded from the diff above):`);
    for (const e of diff.errors) say(`  ${e.tag}: ${e.error}`);
  }
  printDiffTable("=== GAINS — one rule grants, today's four-layer resolver denies ===", diff.gains);
  printDiffTable(
    "=== LOSSES — today's four-layer resolver grants, one rule denies ===",
    diff.losses,
  );

  say("\n=== TOTALS ===");
  say(`  GAINS:  ${diff.gains.length}`);
  say(`  LOSSES: ${diff.losses.length}`);

  const verdict =
    diff.losses.length === 0
      ? "LOSSES: 0 — safe to apply"
      : `LOSSES: ${diff.losses.length} — repin required`;
  say(`\n${verdict}`);
  say("\n=== END — session was read-only; nothing was modified ===\n");

  emitJsonDiff(diff, { verdict });
  return diff.losses.length === 0 ? 0 : 4;
}

/** Writes one GRANT/GRANDFATHER override per loss row. One transaction PER TENANT. Returns the
 *  number of rows actually inserted (ON CONFLICT DO NOTHING may insert fewer than losses.length
 *  if a concurrent writer or a prior partial run already created some of them). */
async function applyGrants(losses, batchId) {
  const byTenant = new Map();
  for (const row of losses) {
    const list = byTenant.get(row.tenantId) ?? [];
    list.push(row);
    byTenant.set(row.tenantId, list);
  }

  const reason =
    `PR-0b zero-loss grandfather grant (batch ${batchId}): today's four-layer resolver grants ` +
    `this key; the one rule (preset ∪ grants − denies) would deny it. Auto-generated by ` +
    `publish-and-repin.mjs --apply — see local-assets/handoff/2026-09-16/feature-grants-v2/design.md PR-0b.`;

  say("\n  session read-only flag lifted for this apply; opening one transaction per tenant");
  await client.query("SET default_transaction_read_only = off");

  let inserted = 0;
  const perTenant = [];
  for (const [tenantId, rows] of byTenant) {
    await client.query("BEGIN");
    try {
      let tenantInserted = 0;
      for (const row of rows) {
        const res = await client.query(
          `INSERT INTO "TenantFeatureOverride"
             ("id", "tenantId", "featureKey", "effect", "kind", "reason", "expiresAt", "createdById", "createdAt")
           VALUES ($1, $2, $3, 'GRANT', 'GRANDFATHER', $4, NULL, NULL, now())
           ON CONFLICT ("tenantId", "featureKey") WHERE "revokedAt" IS NULL DO NOTHING
           RETURNING id`,
          [randomUUID(), tenantId, row.key, reason],
        );
        if (res.rows.length === 1) tenantInserted++;
      }
      await client.query("COMMIT");
      inserted += tenantInserted;
      perTenant.push({ tag: rows[0].tag, inserted: tenantInserted, candidates: rows.length });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  }
  return { inserted, perTenant };
}

async function runApply() {
  say(`\n=== PR-0b APPLY (grandfather grants) — ${target} ===`);
  say(
    `⚠ PLAN_FLAG_ENFORCEMENT assumed: "${opts.planFlagEnforcement}" (NOT read from the live API ` +
      `service — pass --plan-flag-enforcement=off if that disagrees with today's real value)`,
  );

  const diff = await computeDiff();
  say(`Tenants scanned: ${diff.tenantCount}   Registry keys checked: ${diff.keyCount}`);
  printDiffTable(
    "=== WOULD GRANT (preview) — one GRANT/GRANDFATHER override per row ===",
    diff.losses,
  );

  if (diff.losses.length === 0) {
    say("\n=== NOTHING TO GRANT — every key is already explained by preset/grants ===\n");
    emitJsonDiff(diff, { applied: null });
    return 0;
  }

  if (opts.onlyTestTenants) {
    const offenders = diff.losses.filter((r) => !isTestTenant(r.slug));
    if (offenders.length > 0) {
      const distinctSlugs = [...new Set(offenders.map((r) => r.slug))];
      say("\n=== REFUSED — --only-test-tenants ===");
      say(
        `${offenders.length} candidate grant(s) target a tenant that is not an approved test ` +
          `tenant: ${distinctSlugs.join(", ")}`,
      );
      say("=== END — NOTHING was written ===\n");
      emitJsonDiff(diff, { testTenantError: distinctSlugs, applied: null });
      return 3;
    }
  }

  if (!opts.live) {
    say(
      `\n${diff.losses.length} override(s) across ${new Set(diff.losses.map((r) => r.tenantId)).size} ` +
        "tenant(s) would be GRANTED. Nothing was written — pass --apply --live " +
        '--backup-attested "<backup name>" to apply.',
    );
    say("\n=== END — nothing was modified ===\n");
    emitJsonDiff(diff, { applied: null });
    return 0;
  }

  const n = diff.losses.length;
  const phrase = `GRANT ${n} OVERRIDES`;
  const injected = opts.confirm !== null ? opts.confirm : confirmTokenOverride();
  if (injected === undefined && !process.stdin.isTTY) {
    console.error(
      "publish-and-repin: refused — --live needs an interactive TTY for the typed confirmation, " +
        "and stdin is not one",
    );
    emitJsonDiff(diff, { applyRefused: "no-tty", applied: null });
    return 3;
  }
  const answer = injected ?? (await ask(`Type "${phrase}" to proceed: `));
  if (answer.trim() !== phrase) {
    console.error("publish-and-repin: refused — confirmation text did not match");
    emitJsonDiff(diff, { applyRefused: "phrase-mismatch", applied: null });
    return 3;
  }

  const batchId = `pr0b-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const { inserted, perTenant } = await applyGrants(diff.losses, batchId);

  say(`\n=== APPLIED (batch ${batchId}) ===`);
  for (const t of perTenant) say(`  ${t.tag}  inserted=${t.inserted}/${t.candidates}`);
  say(`  TOTAL inserted=${inserted}/${n}`);
  if (inserted < n) {
    say(
      "  (fewer rows inserted than candidates — the remainder already had an active override, " +
        "written by a concurrent run or a prior partial apply; this run is idempotent by design)",
    );
  }
  say("");

  emitJsonDiff(diff, { applied: { batchId, inserted, candidates: n } });
  return 0;
}

async function main() {
  client = connect(databaseUrl);
  await client.connect();

  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '60s'");

  return mode === "apply" ? runApply() : runReport();
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`publish-and-repin: failed — ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => client?.end?.());
