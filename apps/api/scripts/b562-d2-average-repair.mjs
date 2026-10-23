// B562 PR-4 — D2 (SA-136 §5 as amended by SA-902), row 635: repair the AVCO average of every product whose legacy
// (pre-PR-2) sales the ledger never saw. Owner-run, ONE TENANT per plan, after D1.
//
// D1 closed each product's stock gap with ONE balancing SALE row at the cutover, but the average was folded as if those
// sales never happened (buy 10 @ $1, sell 8, buy 10 @ $3 reads 2.0, not 2.6667). D2 places each legacy order's stock
// events on the counter's clock (createdAt, each revision, updatedAt; cancels credited back), folds them through the
// app's own fold, and appends ONE input per product: a COST_BASIS row of quantity 0 at the reconstructed average AT THE
// CUTOVER, dated at the D1 row, then runs the app's own replay (which appends its correction dated now and sets
// Product.averageCost). Nothing is rewritten; no snapshot moves.
// Report per product: was / at cutover / now / EXACT|APPROX with reasons (a costful row inside an uncertain window, a
// residual between D1's quantity and the interposed sales, a line sized by the live pack, a window across the cutover).
// Blind spot (SA-373 e): order stock writers that wrote no OrderRevision are invisible here; their quantity lands in
// the residual. Residual (SA-902): a purchase dated BEFORE the cutover and entered AFTER the repair folds before the
// repair input, so the input hides its cost; use the manual cost setter for such a product.
//
// It runs the app's compiled code (dist/inventory/b562-repair/d2-runner.js): build first (npm run build -w apps/api).
//
//   railway run --service postgres node apps/api/scripts/b562-d2-average-repair.mjs --tenant <slug> [--products <id,id>]
//   node apps/api/scripts/b562-d2-average-repair.mjs --local --tenant <slug>
//   node apps/api/scripts/b562-d2-average-repair.mjs --self-test
//
// DRY-RUN IS THE DEFAULT: a default_transaction_read_only session (read back before any read). It saves a hashed plan
// (local-assets/handoff, or --out <dir>). APPLY replays a SAVED plan:
//   node apps/api/scripts/b562-d2-average-repair.mjs --apply --plan <file> --confirm-plan <hash> \
//     --guard-sha <sha> --backup-taken [--local] [--live-tenant-override --confirm "APPLY <n> PRODUCTS"] \
//     [--allow-protected <tenantId>]
// Gates, ALL must pass or nothing is written:
//   1. --confirm-plan equals the plan's hash, and the hash recomputed from the plan's entries;
//   2. --guard-sha is a git ancestor of HEAD (the release this plan was reviewed at), and the dist build is newer than
//      the sources it runs;
//   3. the database name and the tenant id still match the dry run's;
//   4. a LIVE (non-test) tenant needs --live-tenant-override plus the literal type-back phrase; a PROTECTED tenant
//      (paying, Stripe-linked, env-listed) also needs --allow-protected <tenantId> and the typed confirmation;
//   5. --backup-taken, always;
//   6. inside the ONE transaction: the plan's products are locked and the plan is re-derived; any change refuses all.
// Idempotent: a repaired product is skipped and the old hash refused. Exit: 0 ok · 1 refused (nothing written) · 2 error.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
import { isLocalDbTarget } from "./lib/local-db-target.cjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";
import guard from "./lib/live-target-guard.cjs";
import protectedSlugsLib from "./lib/protected-slugs.cjs";

const { confirmProtectedOverride, hasBackupAttestation, protectedTenantIds, refuseRetiredFlags } =
  guard;
const { loadProtectedSlugs } = protectedSlugsLib;

const TAG = "b562-d2";
const HERE = dirname(fileURLToPath(import.meta.url));
const API = resolve(HERE, "..");
const REPO_ROOT = resolve(API, "../..");
const RUNNER = resolve(API, "dist/inventory/b562-repair/d2-runner.js");
/** The sources the runner is built from: the dist must be newer than each. */
const RUNNER_SOURCES = [
  "src/inventory/b562-repair/d2-runner.ts",
  "src/inventory/b562-repair/d2-repair.ts",
  "src/inventory/b562-repair/d2-reconstruct.ts",
  "src/inventory/b562-repair/d2-interpose.ts",
  "src/inventory/fold-ledger.ts",
  "src/inventory/inventory.service.ts",
  "src/orders/order-stock.ts",
].map((f) => resolve(API, f));

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const refuse = (msg) => Object.assign(new Error(msg), { refuse: true });
const sha256 = (obj) => createHash("sha256").update(JSON.stringify(obj)).digest("hex");

/** Pure: a `postgresql://` URL whose sessions start read-only (libpq `options`). */
export function readOnlyUrl(url) {
  const u = new URL(url);
  u.searchParams.set("options", "-c default_transaction_read_only=on");
  return u.toString();
}

/** Pure: the type-back phrase a live tenant's apply needs. */
export const livePhrase = (n) => `APPLY ${n} PRODUCTS`;

/** Pure: refuse unless the dist runner exists and is newer than every source it was built from. */
export function assertFreshBuild(
  runner = RUNNER,
  sources = RUNNER_SOURCES,
  stat = statSync,
  exists = existsSync,
) {
  if (!exists(runner)) throw refuse(`no build at ${runner}: run npm run build -w apps/api first`);
  const built = stat(runner).mtimeMs;
  const stale = sources.filter((s) => exists(s) && stat(s).mtimeMs > built);
  if (stale.length)
    throw refuse(`the build is older than ${stale.length} source file(s): rebuild first`);
}

async function resolveTarget() {
  const local = process.argv.includes("--local");
  const url = resolveDatabaseUrl(process.env, { requireProxy: !local });
  if (local && !isLocalDbTarget(url))
    throw new Error(`--local refuses a non-local host (${redactUrl(url)})`);
  return url;
}

/** The database name and the tenant id behind a slug (read-only). */
async function fingerprint(url, tenantSlug) {
  const client = new pg.Client({ connectionString: readOnlyUrl(url) });
  await client.connect();
  try {
    const ro = (await client.query("SHOW default_transaction_read_only")).rows[0];
    if (ro?.default_transaction_read_only !== "on") throw new Error("the session is not read-only");
    const db = (await client.query("SELECT current_database() AS db")).rows[0].db;
    const t = (await client.query('SELECT id, slug FROM "Tenant" WHERE slug = $1', [tenantSlug]))
      .rows[0];
    if (!t) throw refuse(`no tenant ${tenantSlug}`);
    return { database: db, tenantId: t.id, tenantSlug: t.slug };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function loadRunner() {
  assertFreshBuild();
  return import(pathToFileURL(RUNNER).href);
}

async function dryRun() {
  const tenantSlug = argOf("--tenant");
  if (!tenantSlug) {
    console.error(`${TAG}: --tenant <slug> is required (one tenant per plan)`);
    return 1;
  }
  const productIds = argOf("--products")?.split(",").filter(Boolean);
  const url = await resolveTarget();
  console.log(`${TAG}: target ${redactUrl(url)} DRY-RUN (tenant ${tenantSlug})`);
  const fp = await fingerprint(url, tenantSlug);
  process.env.DATABASE_URL = readOnlyUrl(url);
  const runner = await loadRunner();
  const plan = await runner.runD2Plan({ tenantId: fp.tenantId, productIds });

  const out = {
    generatedAt: new Date().toISOString(),
    fingerprint: { database: fp.database, tenantId: fp.tenantId },
    planHash: plan.planHash,
    entries: plan.entries,
    skipped: plan.skipped,
  };
  const dir = argOf("--out")
    ? resolve(argOf("--out"))
    : resolve(REPO_ROOT, "local-assets/handoff", new Date().toISOString().slice(0, 10));
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `b562-d2-plan-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));

  console.log(
    `\n${TAG}: ${plan.entries.length} product(s) to repair, ${plan.skipped.length} skipped`,
  );
  for (const e of plan.entries.slice(0, 50)) {
    console.log(
      `  ${e.productId}  was ${e.averageCost ?? "none"}  at cutover ${e.xC}  now ${e.xNow}  ${e.confidence}` +
        `  residual ${e.residual}  legacy orders ${e.legacyOrders}` +
        (e.reasons.length
          ? `\n      ${e.reasons.slice(0, 3).join("; ")}${e.reasons.length > 3 ? " …" : ""}`
          : ""),
    );
  }
  const bySkip = plan.skipped.reduce((m, s) => ({ ...m, [s.reason]: (m[s.reason] ?? 0) + 1 }), {});
  if (plan.skipped.length)
    console.log(`  skipped: ${JSON.stringify(bySkip)} (ids in the plan file)`);
  console.log(`\nplan: ${file}\nplan hash: ${plan.planHash}`);
  if (plan.entries.length > 0) {
    console.log(
      `\nto apply: node ${resolve(HERE, "b562-d2-average-repair.mjs")} --apply --plan ${file} --confirm-plan ${plan.planHash} --guard-sha <sha> --backup-taken`,
    );
  }
  return 0;
}

function verifyGuardSha(guardSha) {
  const head = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  try {
    execFileSync("git", ["-C", REPO_ROOT, "merge-base", "--is-ancestor", guardSha, head]);
  } catch {
    throw refuse(`--guard-sha ${guardSha} is not an ancestor of this checkout's HEAD (${head})`);
  }
}

async function apply() {
  refuseRetiredFlags(process.argv);
  const planFile = argOf("--plan");
  const confirmPlan = argOf("--confirm-plan");
  const guardSha = argOf("--guard-sha");
  if (
    !planFile ||
    !confirmPlan ||
    !guardSha ||
    !hasBackupAttestation(process.argv, "--backup-taken")
  ) {
    console.error(`${TAG}: --apply needs --plan, --confirm-plan, --guard-sha and --backup-taken`);
    return 1;
  }
  const saved = JSON.parse(readFileSync(planFile, "utf8"));
  verifyGuardSha(guardSha);
  const runner = await loadRunner();
  if (saved.planHash !== confirmPlan || runner.planHashOf(saved.entries) !== confirmPlan) {
    throw refuse("--confirm-plan does not match the plan file's hash");
  }
  if (!saved.entries.length) throw refuse("the plan repairs nothing");

  const url = await resolveTarget();
  console.log(`${TAG}: target ${redactUrl(url)} APPLY (${saved.entries.length} product(s))`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let tenant;
  try {
    const db = (await client.query("SELECT current_database() AS db")).rows[0].db;
    tenant = (
      await client.query('SELECT id, slug FROM "Tenant" WHERE id = $1', [
        saved.fingerprint.tenantId,
      ])
    ).rows[0];
    if (db !== saved.fingerprint.database || !tenant) {
      throw refuse("DB fingerprint changed since the dry run (database or tenant differ)");
    }
    if (!isTestTenant(tenant.slug)) {
      const phrase = livePhrase(saved.entries.length);
      if (!process.argv.includes("--live-tenant-override") || argOf("--confirm") !== phrase) {
        throw refuse(`a LIVE tenant: pass --live-tenant-override --confirm "${phrase}"`);
      }
    }
    const protectedIds = await protectedTenantIds(client, loadProtectedSlugs(process.env, url));
    if (protectedIds.includes(tenant.id)) {
      await confirmProtectedOverride({ tenantId: tenant.id, argv: process.argv }).catch((e) => {
        throw refuse(e.message);
      });
    }
  } finally {
    await client.end().catch(() => undefined);
  }

  process.env.DATABASE_URL = url;
  const applied = await runner.runD2Apply({
    tenantId: tenant.id,
    planHash: confirmPlan,
    productIds: saved.entries.map((e) => e.productId),
  });
  console.log(
    `${TAG}: committed — ${applied.length} product(s) repaired (B562:REPAIR:${confirmPlan})`,
  );
  for (const a of applied) {
    console.log(
      `  ${a.productId}  ${a.averageCostBefore ?? "none"} → ${a.xNow}  (${a.confidence})`,
    );
  }
  return 0;
}

/** --self-test: the pure helpers, no database, no build. */
function selfTest() {
  const cases = [
    [
      "read-only URL",
      readOnlyUrl("postgresql://u:p@localhost:5432/db").includes(
        "options=-c+default_transaction_read_only%3Don",
      ),
      true,
    ],
    ["type-back phrase", livePhrase(3), "APPLY 3 PRODUCTS"],
    [
      "a missing build refuses",
      (() => {
        try {
          assertFreshBuild("/nope.js", [], statSync, () => false);
          return "passed";
        } catch (e) {
          return e.refuse === true;
        }
      })(),
      true,
    ],
    [
      "a source newer than the build refuses",
      (() => {
        const stat = (p) => ({ mtimeMs: p === "/run.js" ? 1 : 2 });
        try {
          assertFreshBuild("/run.js", ["/src.ts"], stat, () => true);
          return "passed";
        } catch (e) {
          return e.refuse === true;
        }
      })(),
      true,
    ],
    [
      "a fresh build passes",
      (() => {
        const stat = (p) => ({ mtimeMs: p === "/run.js" ? 3 : 2 });
        assertFreshBuild("/run.js", ["/src.ts"], stat, () => true);
        return true;
      })(),
      true,
    ],
    ["sha256 is stable", sha256({ a: 1 }) === sha256({ a: 1 }), true],
  ];
  let failed = 0;
  for (const [name, got, want] of cases) {
    const ok = got === want;
    if (!ok) failed += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)})`}`);
  }
  console.log(
    failed ? `${TAG} self-test: ${failed} FAILED` : `${TAG} self-test: all ${cases.length} passed`,
  );
  return failed ? 1 : 0;
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  try {
    return process.argv.includes("--apply") ? await apply() : await dryRun();
  } catch (e) {
    console.error(`${TAG}: ${e.message}${e.refuse ? " -- nothing was written" : ""}`);
    return e.refuse ? 1 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
