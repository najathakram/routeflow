/**
 * OWNER-RUN rotation (row 633 / SA-820 S1): retire the codes of the live portal invites the census counts, so an
 * older logging format's record of them is worthless. The invite row stays; its stored code and expiry are
 * cleared, so the portal shows no live invite and the seller sends it again (the existing "send invite" action).
 * Nothing here e-mails anyone, and no historical audit row is rewritten.
 *
 * DRY-RUN IS THE DEFAULT: a READ ONLY transaction, always rolled back; it saves a content-hashed plan.
 *
 *   railway run --service postgres node apps/api/scripts/rotate-portal-invites.mjs --tenant <uuid> [--tenant <uuid> ...]
 *   <local db url in the ambient env> node apps/api/scripts/rotate-portal-invites.mjs --local --tenant <uuid>
 *   node apps/api/scripts/rotate-portal-invites.mjs --self-test
 *
 * ONE YES PER TENANT: `--tenant <uuid>` is REQUIRED and repeatable. There is no "every tenant" mode: the plan holds
 * only the tenants the owner named, and the apply refuses a plan that holds any other.
 *
 * APPLY replays a SAVED plan only (never a live re-query):
 *   node apps/api/scripts/rotate-portal-invites.mjs --apply --plan <file> --confirm-plan <hash> \
 *     --guard-sha <sha> --backup-taken [--local] \
 *     [--allow-protected <tenantId> ...] [--live-tenant-override --confirm "ROTATE <n> INVITES"]
 * Gates, ALL must pass or nothing is written: --confirm-plan equals the plan's own sha256; --guard-sha (the code
 * PR's merge) is an ancestor of HEAD; the DB fingerprint matches the dry run; --backup-taken; a PROTECTED tenant
 * (paying, Stripe-linked or listed) needs its own `--allow-protected <tenantId>` plus the typed phrase at a real
 * terminal (the repo's live-target guard); any other LIVE tenant needs --live-tenant-override plus the type-back
 * phrase; every planned link is RE-READ and must still hold the SAME code (compared by its SHA-256) and be live.
 * One transaction. The code is never printed, logged or stored: the plan holds link ids and a SHA-256 only.
 * Exit: 0 ok · 1 refused (nothing written) · 2 env/connection error.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import pg from "pg";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
import { isLocalDbTarget } from "./lib/local-db-target.cjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";
import protectedSlugsLib from "./lib/protected-slugs.cjs";
import { RECORDED_INVITES_SQL, uuidFlagValues } from "./lib/portal-invite-census.mjs";
const require = createRequire(import.meta.url);
const guard = require("./lib/live-target-guard.cjs");

const { protectedTenantIds, confirmProtectedOverride, hasBackupAttestation, refuseRetiredFlags } =
  guard;
const { loadProtectedSlugs } = protectedSlugsLib;

const TAG = "rotate-portal-invites";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SELF = fileURLToPath(import.meta.url);

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const sha256 = (obj) => createHash("sha256").update(JSON.stringify(obj)).digest("hex");
const refuse = (msg) => Object.assign(new Error(msg), { refuse: true });

/** The exact phrase a LIVE (non-test, unprotected) tenant's apply needs, typed back. */
export const livePhrase = (n) => `ROTATE ${n} INVITES`;

/** The ONLY write: clear the stored code and expiry of one planned link, only while it still holds the same code. */
export const ROTATE_SQL = `UPDATE "CustomerLink"
   SET "inviteToken" = NULL, "inviteExpiresAt" = NULL
 WHERE id = $1 AND "tenantId" = $2
   AND "inviteToken" IS NOT NULL
   AND encode(sha256(convert_to("inviteToken", 'UTF8')), 'hex') = $3
   AND ("inviteExpiresAt" IS NULL OR "inviteExpiresAt" > now())`;

/** Pure: the census rows narrowed to the tenants the owner named; every other tenant stays out of the plan. */
export function planRows(rows, tenantIds) {
  const named = new Set(tenantIds);
  return rows
    .filter((r) => named.has(String(r.tenantId).toLowerCase()))
    .map((r) => ({
      linkId: r.linkId,
      tenantId: r.tenantId,
      status: r.status,
      tokenSha256: r.tokenSha256,
      auditRows: r.auditRows,
    }));
}

/** Pure: throws (refuses the whole apply) if a planned row belongs to a tenant not named on this command line. */
export function assertPlanTenantsNamed(plan, namedTenantIds) {
  const named = new Set(namedTenantIds);
  const stray = plan.rotate.filter((r) => !named.has(String(r.tenantId).toLowerCase()));
  if (stray.length > 0) {
    throw refuse(
      `the plan holds ${stray.length} link(s) of a tenant not named with --tenant -- refusing`,
    );
  }
}

async function resolveTarget() {
  const local = process.argv.includes("--local");
  const url = resolveDatabaseUrl(process.env, { requireProxy: !local });
  if (local && !isLocalDbTarget(url))
    throw new Error(`--local refuses a non-local host (${redactUrl(url)})`);
  return url;
}

async function fingerprint(client) {
  const [db, tenants] = await Promise.all([
    client.query("SELECT current_database() AS db"),
    client.query('SELECT id FROM "Tenant" ORDER BY id'),
  ]);
  return { database: db.rows[0].db, tenantIds: tenants.rows.map((t) => t.id) };
}

async function dryRun(tenantIds) {
  const url = await resolveTarget();
  console.log(`${TAG}: target ${redactUrl(url)} DRY-RUN (${tenantIds.length} tenant(s) named)`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const fp = await fingerprint(client);
    const known = new Set(fp.tenantIds.map((id) => String(id).toLowerCase()));
    const unknown = tenantIds.filter((id) => !known.has(id));
    if (unknown.length > 0)
      throw refuse(`${unknown.length} named tenant(s) not found in this database`);
    const rows = (await client.query(RECORDED_INVITES_SQL)).rows;
    await client.query("ROLLBACK");

    const rotate = planRows(rows, tenantIds);
    const plan = { generatedAt: new Date().toISOString(), fingerprint: fp, tenantIds, rotate };
    const hash = sha256(plan);
    const dir = resolve(REPO_ROOT, "local-assets/handoff", new Date().toISOString().slice(0, 10));
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `portal-invite-rotation-plan-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ ...plan, planHash: hash }, null, 2));

    const perTenant = new Map();
    for (const r of rotate) perTenant.set(r.tenantId, (perTenant.get(r.tenantId) ?? 0) + 1);
    console.log(
      `\n${TAG}: ${rotate.length} live invite(s) to retire in ${perTenant.size} named tenant(s)`,
    );
    console.log(
      `  held back: ${rows.length - rotate.length} recorded invite(s) of tenants NOT named (never in the plan)`,
    );
    for (const [tenantId, n] of [...perTenant].sort()) console.log(`    ${tenantId}: ${n}`);
    console.log(`\nplan: ${file}\nplan hash: ${hash}`);
    if (rotate.length > 0) {
      console.log(
        `\nto apply (after a fresh backup): node ${SELF} --apply --plan ${file} --confirm-plan ${hash} --guard-sha <sha> --backup-taken` +
          tenantIds.map((t) => ` --tenant ${t}`).join(""),
      );
    }
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`${TAG}: ${e.message}`);
    return e.refuse ? 1 : 2;
  } finally {
    await client.end().catch(() => undefined);
  }
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

async function apply(tenantIds) {
  const planFile = argOf("--plan");
  const confirmPlan = argOf("--confirm-plan");
  const guardSha = argOf("--guard-sha");
  const argv = process.argv.slice(2);
  try {
    refuseRetiredFlags(argv);
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return 1;
  }
  if (
    !planFile ||
    !confirmPlan ||
    !guardSha ||
    !hasBackupAttestation(argv, "--i-have-a-fresh-backup")
  ) {
    console.error(`${TAG}: --apply needs --plan, --confirm-plan, --guard-sha and --backup-taken`);
    return 1;
  }
  const saved = JSON.parse(readFileSync(planFile, "utf8"));
  const { planHash, ...plan } = saved;
  if (sha256(plan) !== confirmPlan || planHash !== confirmPlan) {
    console.error(`${TAG}: --confirm-plan does not match the plan file's own hash -- refusing`);
    return 1;
  }
  try {
    verifyGuardSha(guardSha);
    assertPlanTenantsNamed(plan, tenantIds);
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return e.refuse ? 1 : 2;
  }
  const url = await resolveTarget();
  const protectedSlugs = loadProtectedSlugs(process.env, url);
  console.log(`${TAG}: target ${redactUrl(url)} APPLY (${plan.rotate.length} invite(s))`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    if (JSON.stringify(await fingerprint(client)) !== JSON.stringify(plan.fingerprint)) {
      throw refuse("DB fingerprint changed since the dry run (database or tenants differ)");
    }
    const planned = [...new Set(plan.rotate.map((r) => r.tenantId))];
    // A tenant protected NOW needs its own override, and the typed phrase, at a real terminal.
    const protectedIds = new Set(await protectedTenantIds(client, protectedSlugs));
    for (const tenantId of planned.filter((id) => protectedIds.has(id))) {
      await confirmProtectedOverride({ tenantId, argv, backupFlag: "--i-have-a-fresh-backup" });
    }
    const slugs = await client.query('SELECT id, slug FROM "Tenant" WHERE id = ANY($1::text[])', [
      planned,
    ]);
    const slugById = new Map(slugs.rows.map((t) => [t.id, t.slug]));
    const live = planned.filter((id) => !isTestTenant(slugById.get(id)) && !protectedIds.has(id));
    if (live.length > 0) {
      const phrase = livePhrase(plan.rotate.length);
      if (!argv.includes("--live-tenant-override") || argOf("--confirm") !== phrase) {
        throw refuse(
          `${live.length} LIVE tenant(s) in this plan: pass --live-tenant-override --confirm "${phrase}"`,
        );
      }
    }
    let written = 0;
    for (const r of plan.rotate) {
      const res = await client.query(ROTATE_SQL, [r.linkId, r.tenantId, r.tokenSha256]);
      if (res.rowCount !== 1) {
        throw refuse(
          `link ${r.linkId} has changed since the dry run (code, expiry or tenant differ)`,
        );
      }
      written += res.rowCount;
    }
    await client.query("COMMIT");
    console.log(`${TAG}: committed — ${written} invite(s) retired; the seller sends each again`);
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(
      `${TAG}: ${e.message}${e.refuse || e.name === "ProtectedTenantError" ? " -- nothing was written" : ""}`,
    );
    return e.refuse || e.name === "ProtectedTenantError" ? 1 : 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** --self-test: the pure parts and the SQL's shape, no database. */
export function selfTest() {
  let failed = 0;
  const ok = (name, cond) => {
    if (!cond) failed += 1;
    console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
  };
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const rows = [
    { linkId: "l1", tenantId: A, status: "INVITED", tokenSha256: "x", auditRows: 1 },
    { linkId: "l2", tenantId: B, status: "INVITED", tokenSha256: "y", auditRows: 2 },
  ];
  ok(
    "the plan holds only the named tenant's links",
    planRows(rows, [A]).length === 1 && planRows(rows, [A])[0].linkId === "l1",
  );
  ok("no named tenant, no plan", planRows(rows, []).length === 0);
  let refused = false;
  try {
    assertPlanTenantsNamed({ rotate: [{ tenantId: B }] }, [A]);
  } catch (e) {
    refused = e.refuse === true;
  }
  ok("a plan holding an un-named tenant is refused", refused);
  ok(
    "a plan of named tenants passes",
    (assertPlanTenantsNamed({ rotate: [{ tenantId: A.toUpperCase() }] }, [A]), true),
  );
  ok(
    "--tenant is repeatable, lowercased and de-duplicated",
    JSON.stringify(
      uuidFlagValues(["--tenant", B.toUpperCase(), "--tenant", A, "--tenant", B], "--tenant"),
    ) === JSON.stringify([A, B]),
  );
  let bad = false;
  try {
    uuidFlagValues(["--tenant", "acme"], "--tenant");
  } catch (e) {
    bad = e.refuse === true;
  }
  ok("--tenant refuses a slug (a UUID only)", bad);
  ok("the live phrase carries the count", livePhrase(3) === "ROTATE 3 INVITES");
  ok(
    "the one write clears only the code and expiry, guarded by id, tenant, code hash and liveness",
    /^UPDATE "CustomerLink"\s+SET "inviteToken" = NULL, "inviteExpiresAt" = NULL\s+WHERE id = \$1 AND "tenantId" = \$2/.test(
      ROTATE_SQL,
    ) &&
      /sha256/.test(ROTATE_SQL) &&
      !/\bDELETE\b|\bstatus\b|"buyerAccountId"/i.test(ROTATE_SQL),
  );
  console.log(failed ? `${TAG} self-test: ${failed} FAILED` : `${TAG} self-test: all passed`);
  return failed ? 1 : 0;
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  let tenantIds;
  try {
    tenantIds = uuidFlagValues(process.argv.slice(2), "--tenant");
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return 1;
  }
  if (tenantIds.length === 0) {
    console.error(
      `${TAG}: name at least one tenant with --tenant <uuid> (there is no all-tenants mode)`,
    );
    return 1;
  }
  return process.argv.includes("--apply") ? apply(tenantIds) : dryRun(tenantIds);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
