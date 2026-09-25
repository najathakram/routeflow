// F-05 (SA-210): set OrderTemplate.createdByRole / createdByUserId on legacy templates from the one thing
// that can prove it — the AuditLog row the global interceptor wrote for `POST /order-templates`. A template
// is matched to an audit row in the SAME tenant created within WINDOW_MS of the template; the row's user is
// the creator and its role is that user's role AT BACKFILL TIME (not a snapshot — a user promoted or demoted
// since then is recorded as they are now). Anything unmatched or ambiguous stays NULL, which the unattended
// standing-order run evaluates as the STRICTER buyer channel. This file is OPTIONAL: skipping it only means
// a legacy operator-made template may be suspended once on a buyer-only rule, and an operator lifts it (audited).
//
// DRY-RUN IS THE DEFAULT: a READ ONLY transaction, always rolled back; it saves a content-hashed plan.
//   APPLY  — exactly ONE audit row matches the template.
//   REVIEW — two or more audit rows match (nothing is written for these).
//
//   railway run --service postgres node apps/api/scripts/backfill-order-template-provenance.mjs
//   <local db url in the ambient env> node apps/api/scripts/backfill-order-template-provenance.mjs --local
//   node apps/api/scripts/backfill-order-template-provenance.mjs --self-test
//
// APPLY replays a SAVED plan only (never a live re-query):
//   node apps/api/scripts/backfill-order-template-provenance.mjs --apply --plan <file> \
//     --confirm-plan <hash> --guard-sha <sha> --i-have-a-fresh-backup [--local] \
//     [--live-tenant-override --confirm "APPLY <n> TEMPLATES"]
// Gates (B681's set), ALL must pass or nothing is written: --confirm-plan equals the plan's own sha256;
// --guard-sha (the code PR's merge) is an ancestor of HEAD; the DB fingerprint matches the dry run; a LIVE
// tenant needs --live-tenant-override plus the type-back phrase; --i-have-a-fresh-backup; every planned
// template is RE-READ and must still have a NULL createdByRole. One transaction.
// Exit: 0 ok · 1 refused (nothing written) · 2 env/connection error.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
import { isLocalDbTarget } from "./lib/local-db-target.cjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

const TAG = "backfill-template-provenance";
const WINDOW_MS = 60_000;
const ROLES = new Set(["SUPER_ADMIN", "TENANT_ADMIN", "OPERATOR", "DRIVER", "CUSTOMER"]);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SELF = fileURLToPath(import.meta.url);

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const sha256 = (obj) => createHash("sha256").update(JSON.stringify(obj)).digest("hex");
const refuse = (msg) => Object.assign(new Error(msg), { refuse: true });

/**
 * Pure: one template + the audit candidates for its tenant -> APPLY / REVIEW / null (no match).
 * A candidate is { userId, role, createdAt }.
 */
export function classifyTemplate(template, candidates, windowMs = WINDOW_MS) {
  const at = new Date(template.createdAt).getTime();
  const near = candidates.filter(
    (c) =>
      c.userId && ROLES.has(c.role) && Math.abs(new Date(c.createdAt).getTime() - at) <= windowMs,
  );
  if (near.length === 0) return null;
  if (near.length > 1) {
    return { kind: "REVIEW", reason: `${near.length} audit rows within ${windowMs / 1000}s` };
  }
  return {
    kind: "APPLY",
    role: near[0].role,
    userId: near[0].userId,
    auditKey: `${near[0].userId}|${new Date(near[0].createdAt).toISOString()}`,
  };
}

/**
 * Pure: one audit row can sit within the window of TWO templates (created back to back) — it proves
 * neither. Every APPLY row sharing an audit row moves to REVIEW.
 */
export function splitSharedAuditRows(apply) {
  const uses = new Map();
  for (const a of apply) uses.set(a.auditKey, (uses.get(a.auditKey) ?? 0) + 1);
  return {
    apply: apply.filter((a) => uses.get(a.auditKey) === 1),
    review: apply
      .filter((a) => uses.get(a.auditKey) > 1)
      .map((a) => ({
        templateId: a.templateId,
        reason: "one audit row matches several templates",
      })),
  };
}

const TEMPLATES_SQL = `
  SELECT id, "tenantId", "createdAt" FROM "OrderTemplate"
  WHERE "createdByRole" IS NULL AND "tenantId" IS NOT NULL ORDER BY id`;
const AUDIT_SQL = `
  SELECT a."tenantId", a."userId", a."createdAt", u.role::text AS role
  FROM "AuditLog" a JOIN "User" u ON u.id = a."userId"
  WHERE a.action = 'POST /order-templates' AND a."tenantId" = ANY($1::text[])
  ORDER BY a."createdAt"`;

async function resolveTarget() {
  // B768: the shared resolver only — this script never names the connection variable itself. A writer
  // requires the Railway proxy; `--local` may fall back to the ambient local URL, and refuses a non-local host.
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

async function dryRun() {
  const url = await resolveTarget();
  console.log(`${TAG}: target ${redactUrl(url)} DRY-RUN`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const fp = await fingerprint(client);
    const templates = (await client.query(TEMPLATES_SQL)).rows;
    const tenantIds = [...new Set(templates.map((t) => t.tenantId))];
    const audit = tenantIds.length ? (await client.query(AUDIT_SQL, [tenantIds])).rows : [];
    await client.query("ROLLBACK");

    const byTenant = new Map();
    for (const a of audit) byTenant.set(a.tenantId, [...(byTenant.get(a.tenantId) ?? []), a]);
    const apply = [];
    const review = [];
    let unmatched = 0;
    for (const t of templates) {
      const c = classifyTemplate(t, byTenant.get(t.tenantId) ?? []);
      if (!c) unmatched += 1;
      else if (c.kind === "REVIEW") review.push({ templateId: t.id, reason: c.reason });
      else
        apply.push({
          templateId: t.id,
          tenantId: t.tenantId,
          role: c.role,
          userId: c.userId,
          auditKey: c.auditKey,
        });
    }

    const split = splitSharedAuditRows(apply);
    apply.splice(0, apply.length, ...split.apply);
    review.push(...split.review);
    const plan = { generatedAt: new Date().toISOString(), fingerprint: fp, apply };
    const hash = sha256(plan);
    const dir = resolve(REPO_ROOT, "local-assets/handoff", new Date().toISOString().slice(0, 10));
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `template-provenance-plan-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ ...plan, planHash: hash, review }, null, 2));

    console.log(`\n${TAG}: ${templates.length} template(s) with NULL provenance scanned`);
    console.log(`  APPLY:     ${apply.length}`);
    // Which way each APPLY row goes, BEFORE anything is written. The role is the user's CURRENT role
    // (not a snapshot at creation); an unmatched template stays NULL = the stricter buyer channel.
    const byRole = new Map();
    for (const a of apply) byRole.set(a.role, (byRole.get(a.role) ?? 0) + 1);
    for (const [role, n] of [...byRole].sort()) console.log(`    -> ${role}: ${n}`);
    for (const a of apply) console.log(`    ${a.templateId}  ${a.role}  user ${a.userId}`);
    console.log(`  REVIEW:    ${review.length} (in the plan file; nothing is written for them)`);
    console.log(`  UNMATCHED: ${unmatched} (stay NULL = the stricter buyer channel)`);
    console.log(`\nplan: ${file}\nplan hash: ${hash}`);
    if (apply.length > 0) {
      console.log(
        `\nto apply: node ${SELF} --apply --plan ${file} --confirm-plan ${hash} --guard-sha <sha> --i-have-a-fresh-backup`,
      );
    }
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`${TAG}: ${e.message}`);
    return 2;
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

async function apply() {
  const planFile = argOf("--plan");
  const confirmPlan = argOf("--confirm-plan");
  const guardSha = argOf("--guard-sha");
  if (!planFile || !confirmPlan || !guardSha || !process.argv.includes("--i-have-a-fresh-backup")) {
    console.error(
      `${TAG}: --apply needs --plan, --confirm-plan, --guard-sha and --i-have-a-fresh-backup`,
    );
    return 1;
  }
  const saved = JSON.parse(readFileSync(planFile, "utf8"));
  const { planHash, review: _review, ...plan } = saved;
  if (sha256(plan) !== confirmPlan || planHash !== confirmPlan) {
    console.error(`${TAG}: --confirm-plan does not match the plan file's own hash -- refusing`);
    return 1;
  }
  try {
    verifyGuardSha(guardSha);
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return 1;
  }

  const url = await resolveTarget();
  console.log(`${TAG}: target ${redactUrl(url)} APPLY (${plan.apply.length} template(s))`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    if (JSON.stringify(await fingerprint(client)) !== JSON.stringify(plan.fingerprint)) {
      throw refuse("DB fingerprint changed since the dry run (database or tenants differ)");
    }
    const tenantIds = [...new Set(plan.apply.map((a) => a.tenantId))];
    const slugs = await client.query('SELECT id, slug FROM "Tenant" WHERE id = ANY($1::text[])', [
      tenantIds,
    ]);
    const slugById = new Map(slugs.rows.map((t) => [t.id, t.slug]));
    const live = tenantIds.filter((id) => !isTestTenant(slugById.get(id)));
    if (live.length > 0) {
      const phrase = `APPLY ${plan.apply.length} TEMPLATES`;
      if (!process.argv.includes("--live-tenant-override") || argOf("--confirm") !== phrase) {
        throw refuse(
          `${live.length} LIVE tenant(s) in this plan: pass --live-tenant-override --confirm "${phrase}"`,
        );
      }
    }
    let written = 0;
    for (const a of plan.apply) {
      const row = (
        await client.query(
          'SELECT "createdByRole" FROM "OrderTemplate" WHERE id = $1 AND "tenantId" = $2',
          [a.templateId, a.tenantId],
        )
      ).rows[0];
      if (!row || row.createdByRole !== null)
        throw refuse(`template ${a.templateId} has changed since the dry run`);
      const res = await client.query(
        'UPDATE "OrderTemplate" SET "createdByRole" = $1::"UserRole", "createdByUserId" = $2 WHERE id = $3 AND "createdByRole" IS NULL',
        [a.role, a.userId, a.templateId],
      );
      written += res.rowCount;
    }
    await client.query("COMMIT");
    console.log(`${TAG}: committed — ${written} template(s)`);
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`${TAG}: ${e.message}${e.refuse ? " -- nothing was written" : ""}`);
    return e.refuse ? 1 : 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** --self-test: the pure classifier, no database. */
function selfTest() {
  const t = { createdAt: "2026-09-01T12:00:00Z" };
  const row = (sec, role = "CUSTOMER", userId = "u1") => ({
    userId,
    role,
    createdAt: new Date(Date.parse(t.createdAt) + sec * 1000).toISOString(),
  });
  const cases = [
    ["APPLY: one customer row 2s away", [row(2)], "APPLY", "CUSTOMER"],
    ["APPLY: one operator row", [row(-5, "OPERATOR")], "APPLY", "OPERATOR"],
    ["REVIEW: two rows in the window", [row(1), row(3, "OPERATOR", "u2")], "REVIEW"],
    ["no match: row outside the window", [row(600)], null],
    ["no match: nothing", [], null],
    ["no match: unknown role", [row(1, "WIZARD")], null],
  ];
  let failed = 0;
  const shared = splitSharedAuditRows([
    { templateId: "a", auditKey: "k1" },
    { templateId: "b", auditKey: "k1" },
    { templateId: "c", auditKey: "k2" },
  ]);
  const sharedOk =
    shared.apply.length === 1 && shared.apply[0].templateId === "c" && shared.review.length === 2;
  if (!sharedOk) failed += 1;
  console.log(`${sharedOk ? "ok  " : "FAIL"} one audit row shared by two templates -> both REVIEW`);
  for (const [name, cands, kind, role] of cases) {
    const got = classifyTemplate(t, cands);
    const ok = kind === null ? got === null : got?.kind === kind && (!role || got.role === role);
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
  return process.argv.includes("--apply") ? apply() : dryRun();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
