// B294 (SA-141): stamp the inferred flat sales-tax rate onto legacy order- and estimate-derived
// invoice lines stored with `taxRate: 0`, so a later recompute (price adjustment, edit) keeps the
// tax instead of silently dropping it to $0. The rule is @routeflow/pricing's inferredFlatRate,
// the SAME one applyPriceAdjustment and the mobile edit use: every line at 0, a real regular tax
// (taxAmount − Σ categoryTaxAmount), a subtotal > 0, and a 4-dp rate that reproduces the tax to
// the cent. It writes InvoiceItem.taxRate ONLY — never an amount, total or status.
//
// DRY-RUN IS THE DEFAULT: a READ ONLY transaction, always rolled back. It classifies every
// order/estimate-derived, non-VOID invoice created before --before (default: now) and saves a
// content-hashed plan (local-assets/handoff) that --apply later replays.
//   APPLY  — inferred and verified, created before the fix (2026-09-13).
//   REVIEW — inferred but NOT verified, or created on/after 2026-09-13 (#725 should have stamped
//            it — a match there means something else wrote 0; a human looks, nothing is written).
//   (skipped) — the rule does not apply (a rated line, no tax, zero subtotal).
//
//   railway run --service postgres node apps/api/scripts/backfill-b294-order-line-taxrate.mjs
//   DATABASE_URL=postgresql://…@localhost:5432/<db> node apps/api/scripts/backfill-b294-order-line-taxrate.mjs --local
//   node apps/api/scripts/backfill-b294-order-line-taxrate.mjs --self-test
//
// APPLY replays a SAVED plan only (never a live re-query):
//   node apps/api/scripts/backfill-b294-order-line-taxrate.mjs --apply --plan <file> \
//     --confirm-plan <hash> --guard-sha <sha> --i-have-a-fresh-backup [--local] \
//     [--live-tenant-override --confirm "APPLY <n> INVOICES"]
// Gates, ALL must pass or nothing is written (SA-134 / B681's set):
//   1. --confirm-plan equals the plan file's own sha256;
//   2. --guard-sha is a git ancestor of this checkout's HEAD (the fix that stops new 0-rate lines);
//   3. the DB fingerprint (database, tenant ids) still matches the dry run;
//   4. a LIVE (non-test) tenant needs --live-tenant-override plus the literal type-back phrase;
//   4b. #2639 / SA-547 / row 195: a PROTECTED tenant (paying, Stripe-linked, or named in
//      PROTECTED_TENANT_SLUGS) is HELD at the dry run (PAYING-HELD, never planned) unless the
//      operator names its id with --allow-protected <tenantId> (repeatable). The apply RE-DERIVES
//      protection in its transaction, refuses the whole apply if a tenant turned protected since
//      the dry run, and for every protected tenant it writes needs --allow-protected <tenantId>
//      plus a typed "ALLOW PROTECTED <tenantId>" at a real terminal (live-target-guard.cjs). The
//      retired --allow-paying-tenant / --confirm-paying are unknown arguments. The plan file and
//      the logs carry tenant IDS and counts only — never slugs;
//   5. --i-have-a-fresh-backup, always;
//   6. every planned invoice is RE-READ: subtotal, taxAmount, updatedAt, its line ids, and every
//      line still at 0 — any change refuses the whole apply.
// One transaction. Exit: 0 ok · 1 refused (nothing written) · 2 env/connection error.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import {
  NSF_FEE_DESCRIPTION_PREFIX,
  NSF_FEE_SYSTEM_KIND,
  NSF_HAS_TRANSITION_LEG,
  inferredGoodsFlatRate,
  isNsfLine,
} from "@routeflow/pricing";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
import payingTenant from "./lib/paying-tenant.cjs";
import protectedSlugsLib from "./lib/protected-slugs.cjs";
import liveTargetGuard from "./lib/live-target-guard.cjs";
import { isLocalDbTarget } from "./lib/local-db-target.cjs";
import { requireLocalPgConfig } from "./lib/local-pg-config.mjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

const TAG = "backfill-b294";
const FIX_DATE = new Date("2026-09-13T00:00:00Z");
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SELF = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "backfill-b294-order-line-taxrate.mjs",
);

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
/** Every value of a repeatable flag: `--allow-protected a --allow-protected b` -> ["a", "b"]. */
const argvAll = (name) =>
  process.argv.flatMap((a, i, all) => (a === name && all[i + 1] !== undefined ? [all[i + 1]] : []));
const sha256 = (obj) => createHash("sha256").update(JSON.stringify(obj)).digest("hex");
const refuse = (msg) => Object.assign(new Error(msg), { refuse: true });

/**
 * #2392 / SA-478: the SQL twin of @routeflow/pricing isNsfLine — "this InvoiceItem is NOT the NSF
 * fee line", with the same transition flag. `starts_with` on COALESCE(description, ''): a bare
 * NULL description would make `NOT (… AND NULL)` NULL and silently skip an ordinary line.
 */
export function notNsfSql(firstParam) {
  const kind = `$${firstParam}`;
  if (!NSF_HAS_TRANSITION_LEG) {
    return { sql: `"systemKind" IS DISTINCT FROM ${kind}`, params: [NSF_FEE_SYSTEM_KIND] };
  }
  const prefix = `$${firstParam + 1}`;
  return {
    sql: `("systemKind" IS DISTINCT FROM ${kind} AND NOT ("systemKind" IS NULL AND starts_with(COALESCE(description, ''), ${prefix})))`,
    params: [NSF_FEE_SYSTEM_KIND, NSF_FEE_DESCRIPTION_PREFIX],
  };
}

/** Pure: one invoice → APPLY / REVIEW / null (skipped). */
export function classifyInvoice(invoice, lines, fixDate = FIX_DATE) {
  // #2392 / SA-478: the NSF bounce-fee line is never taxed — excluded from the inference, both its
  // line and its money. #2656: that goods-only rule (rounded) is the ONE shared helper.
  const inferred = inferredGoodsFlatRate({
    subtotal: invoice.subtotal,
    taxAmount: invoice.taxAmount,
    lines,
  });
  if (!inferred) return null;
  // #2656 / SA-549: an NSF line ALREADY carrying a rate means the header tax includes tax on the fee,
  // so the goods-only rate is inflated. Never APPLY it (the apply's re-read gate would refuse the whole
  // tx on that line anyway) — a human looks.
  if (lines.some((l) => isNsfLine(l) && Number(l.taxRate ?? 0) > 0)) {
    return { kind: "REVIEW", rate: inferred.rate, reason: "NSF line already taxed" };
  }
  if (!inferred.verified) {
    return {
      kind: "REVIEW",
      rate: inferred.rate,
      reason: "rate does not reproduce the tax to the cent",
    };
  }
  if (new Date(invoice.createdAt) >= fixDate) {
    return {
      kind: "REVIEW",
      rate: inferred.rate,
      reason: "created after the #725 fix yet all lines are 0",
    };
  }
  return { kind: "APPLY", rate: inferred.rate };
}

const { protectedArm } = payingTenant;
const { loadProtectedSlugs } = protectedSlugsLib;
const {
  assertWritableTenant,
  confirmProtectedOverride,
  hasBackupAttestation,
  refuseRetiredFlags,
  ProtectedTenantError,
} = liveTargetGuard;

/** #2639: each tenant's protection inputs (same client as the backfill; read in its transaction). */
const PROTECTION_SQL = `
  SELECT t.id, t.slug, t.status, t.class, t."deletedAt", s."planKey", s."stripeSubId"
  FROM "Tenant" t LEFT JOIN "TenantSubscription" s ON s."tenantId" = t.id
  WHERE t.id = ANY($1::text[])`;

/** Pure (#2639): rows from PROTECTION_SQL → Map<tenantId, "paying" | "stripe-linked"> (protected only). */
export function protectedTenants(rows, protectedSlugs) {
  const out = new Map();
  for (const r of rows) {
    const arm = protectedArm(
      { slug: r.slug, status: r.status, class: r.class, deletedAt: r.deletedAt },
      { planKey: r.planKey, stripeSubId: r.stripeSubId },
      protectedSlugs,
    );
    if (arm) out.set(r.id, arm);
  }
  return out;
}

/**
 * Pure (#2639 / SA-547, dry run): a protected tenant's candidates are HELD (never planned) unless the
 * operator named the tenant's id with --allow-protected. Returns the plan's apply list, the held list
 * and the protected tenant ids the plan ADMITS (only those named) — ids, never slugs.
 */
export function splitProtected(candidates, protectedById, allowedIds) {
  const apply = [];
  const held = [];
  for (const c of candidates) {
    if (!protectedById.has(c.tenantId)) apply.push(c);
    else if (allowedIds.has(c.tenantId)) apply.push(c);
    else
      held.push({
        invoiceId: c.invoiceId,
        tenantId: c.tenantId,
        arm: protectedById.get(c.tenantId),
      });
  }
  const admitted = [
    ...new Set(apply.filter((c) => protectedById.has(c.tenantId)).map((c) => c.tenantId)),
  ].sort();
  return { apply, held, admittedProtectedTenantIds: admitted };
}

/**
 * Pure (#2639 / SA-547, apply): the apply NEVER trusts the plan. `nowProtected` is re-derived in the
 * apply transaction for the plan's tenants (Map id → { arm }). A tenant protected NOW that the plan
 * did not admit (it turned protected since the dry run) refuses the WHOLE apply. The per-tenant
 * override itself (flag + terminal + typed phrase) is checked by assertWritableTenant in the apply.
 * The refusal text names tenant IDS only.
 */
export function payingGate({ admittedProtectedTenantIds, nowProtected }) {
  const admitted = new Set(admittedProtectedTenantIds ?? []);
  const turned = [...nowProtected.keys()].filter((id) => !admitted.has(id)).sort();
  if (turned.length)
    return {
      ok: false,
      reason: `tenant(s) ${turned.join(", ")} became protected (paying / Stripe-linked / listed) since the dry run — re-run the dry run`,
    };
  return { ok: true };
}

/**
 * Pure (#2639, lead's Opus HIGH-1): THE plan-file shape, written by the dry run and verified by the
 * apply. The hash covers the plan BODY only; `planHash`, `review` and `held` ride along unhashed. One
 * pair of functions on both sides, so the dry run and the apply can never disagree on what is hashed
 * (a `held` key hashed out but not stripped back made every --apply refuse).
 */
const UNHASHED_PLAN_KEYS = ["planHash", "review", "held"];
export function planFileOf(plan, review, held) {
  return { ...plan, planHash: sha256(plan), review, held };
}
/** The plan body when `saved` is intact and `confirmPlan` is its hash; null otherwise. */
export function verifyPlanFile(saved, confirmPlan) {
  const plan = Object.fromEntries(
    Object.entries(saved).filter(([k]) => !UNHASHED_PLAN_KEYS.includes(k)),
  );
  return sha256(plan) === confirmPlan && saved.planHash === confirmPlan ? plan : null;
}

const DERIVED_INVOICES_SQL = `
  SELECT i.id, i."tenantId", i.subtotal, i."taxAmount", i."createdAt", i."updatedAt"
  FROM "Invoice" i
  WHERE i.status <> 'VOID' AND i."createdAt" < $1
    AND (i."orderId" IS NOT NULL
         OR EXISTS (SELECT 1 FROM "Estimate" e WHERE e."invoiceId" = i.id))
  ORDER BY i.id`;
const LINES_SQL = `
  SELECT id, "invoiceId", "taxRate", "categoryTaxAmount", subtotal, "systemKind", description
  FROM "InvoiceItem" WHERE "invoiceId" = ANY($1::text[]) ORDER BY id`;

async function resolveTarget() {
  const local = process.argv.includes("--local");
  const url = local
    ? process.env.DATABASE_URL
    : resolveDatabaseUrl(process.env, { requireProxy: true });
  if (!url) throw new Error("--local requires DATABASE_URL");
  if (local && !isLocalDbTarget(url))
    throw new Error(`--local refuses a non-local host (${redactUrl(url)})`);
  return url;
}

/** What pg dials: under --local the explicit, vetted fields (never the raw string a `?host=` could redirect). */
const dialConfig = (url) =>
  process.argv.includes("--local") ? requireLocalPgConfig(url) : { connectionString: url };

async function fingerprint(client) {
  const [db, tenants] = await Promise.all([
    client.query("SELECT current_database() AS db"),
    client.query('SELECT id FROM "Tenant" ORDER BY id'),
  ]);
  return { database: db.rows[0].db, tenantIds: tenants.rows.map((t) => t.id) };
}

async function dryRun() {
  const url = await resolveTarget();
  const protectedSlugs = loadProtectedSlugs(process.env, url);
  const before = argOf("--before") ? new Date(argOf("--before")) : new Date();
  console.log(
    `${TAG}: target ${redactUrl(url)} DRY-RUN (invoices created before ${before.toISOString()})`,
  );
  const client = new pg.Client(dialConfig(url));
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const fp = await fingerprint(client);
    const invoices = (await client.query(DERIVED_INVOICES_SQL, [before])).rows;
    const lines = invoices.length
      ? (await client.query(LINES_SQL, [invoices.map((i) => i.id)])).rows
      : [];
    const scopeTenantIds = [...new Set(invoices.map((i) => i.tenantId))];
    const protectedById = protectedTenants(
      scopeTenantIds.length ? (await client.query(PROTECTION_SQL, [scopeTenantIds])).rows : [],
      protectedSlugs,
    );
    await client.query("ROLLBACK");

    const linesBy = new Map();
    for (const l of lines) linesBy.set(l.invoiceId, [...(linesBy.get(l.invoiceId) ?? []), l]);
    const candidates = [];
    const review = [];
    for (const inv of invoices) {
      const own = linesBy.get(inv.id) ?? [];
      const c = classifyInvoice(inv, own);
      if (!c) continue;
      if (c.kind === "REVIEW") {
        review.push({ invoiceId: inv.id, rate: c.rate, reason: c.reason });
        continue;
      }
      candidates.push({
        invoiceId: inv.id,
        tenantId: inv.tenantId,
        rate: c.rate,
        expected: {
          subtotal: String(inv.subtotal),
          taxAmount: String(inv.taxAmount),
          updatedAt: new Date(inv.updatedAt).toISOString(),
          lineIds: own.map((l) => l.id),
        },
      });
    }

    // #2639 / SA-547: a protected tenant is HELD unless --allow-protected names its id (ids + counts only).
    const allowedIds = new Set(argvAll("--allow-protected"));
    const { apply, held, admittedProtectedTenantIds } = splitProtected(
      candidates,
      protectedById,
      allowedIds,
    );
    const plan = {
      generatedAt: new Date().toISOString(),
      fingerprint: fp,
      admittedProtectedTenantIds,
      apply,
    };
    const planFile = planFileOf(plan, review, held);
    const hash = planFile.planHash;
    const dir = resolve(REPO_ROOT, "local-assets/handoff", new Date().toISOString().slice(0, 10));
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `b294-plan-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(planFile, null, 2));

    console.log(`\n${TAG}: ${invoices.length} derived invoice(s) scanned`);
    console.log(
      `  APPLY:  ${apply.length} invoice(s), ${apply.reduce((s, a) => s + a.expected.lineIds.length, 0)} line(s)`,
    );
    console.log(
      `  REVIEW: ${review.length} invoice(s) (listed in the plan file; nothing is written for them)`,
    );
    console.log(
      `  PAYING-HELD: ${held.length} invoice(s) across ${new Set(held.map((h) => h.tenantId)).size} protected tenant(s)` +
        (admittedProtectedTenantIds.length
          ? `; ${admittedProtectedTenantIds.length} protected tenant(s) ADMITTED (--allow-protected)`
          : " (pass --allow-protected <tenantId> to plan them; ids are in the plan file)"),
    );
    console.log(`\nplan: ${file}\nplan hash: ${hash}`);
    if (apply.length > 0) {
      console.log(
        `\nto apply: node ${SELF.replace(/\\/g, "/")} --apply --plan ${file.replace(/\\/g, "/")} --confirm-plan ${hash} --guard-sha <sha> --i-have-a-fresh-backup`,
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
  if (
    !planFile ||
    !confirmPlan ||
    !guardSha ||
    !hasBackupAttestation(process.argv.slice(2), "--i-have-a-fresh-backup")
  ) {
    console.error(
      `${TAG}: --apply needs --plan, --confirm-plan, --guard-sha and --backup-taken (the old --i-have-a-fresh-backup still works)`,
    );
    return 1;
  }
  const saved = JSON.parse(readFileSync(planFile, "utf8"));
  const plan = verifyPlanFile(saved, confirmPlan);
  if (!plan) {
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
  const protectedSlugs = loadProtectedSlugs(process.env, url);
  // Row 195: every protected tenant the plan admitted needs its OWN operator confirmation, taken
  // BEFORE the transaction opens (a prompt must not hold row locks).
  const overrides = new Map();
  for (const id of plan.admittedProtectedTenantIds ?? []) {
    try {
      overrides.set(
        id,
        await confirmProtectedOverride({
          tenantId: id,
          argv: process.argv.slice(2),
          backupFlag: "--i-have-a-fresh-backup",
        }),
      );
    } catch (e) {
      console.error(`${TAG}: ${e.message}`);
      return 1;
    }
  }
  console.log(`${TAG}: target ${redactUrl(url)} APPLY (${plan.apply.length} invoice(s))`);
  const client = new pg.Client(dialConfig(url));
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
    // #2639 / SA-547: protection is RE-DERIVED here, in the apply transaction — the plan is never trusted.
    const protRows = tenantIds.length
      ? (await client.query(`${PROTECTION_SQL} FOR SHARE OF t`, [tenantIds])).rows
      : [];
    const nowArm = protectedTenants(protRows, protectedSlugs);
    const nowProtected = new Map(
      [...nowArm.entries()].map(([id, arm]) => [id, { arm, slug: slugById.get(id) }]),
    );
    const gate = payingGate({
      admittedProtectedTenantIds: plan.admittedProtectedTenantIds,
      nowProtected,
    });
    if (!gate.ok) throw refuse(gate.reason);
    for (const r of protRows) {
      try {
        assertWritableTenant(
          { id: r.id, slug: r.slug, status: r.status, class: r.class, deletedAt: r.deletedAt },
          { planKey: r.planKey, stripeSubId: r.stripeSubId },
          protectedSlugs,
          { allowProtected: overrides.get(r.id) },
        );
      } catch (e) {
        if (e instanceof ProtectedTenantError) throw refuse(e.message);
        throw e;
      }
    }
    const live = tenantIds.filter((id) => !isTestTenant(slugById.get(id)));
    if (live.length > 0) {
      const phrase = `APPLY ${plan.apply.length} INVOICES`;
      if (!process.argv.includes("--live-tenant-override") || argOf("--confirm") !== phrase) {
        throw refuse(
          `${live.length} LIVE tenant(s) in this plan: pass --live-tenant-override --confirm "${phrase}"`,
        );
      }
    }

    let stamped = 0;
    for (const a of plan.apply) {
      const inv = (
        await client.query(
          'SELECT subtotal, "taxAmount", "updatedAt" FROM "Invoice" WHERE id = $1',
          [a.invoiceId],
        )
      ).rows[0];
      const lines = (
        await client.query(
          'SELECT id, "taxRate" FROM "InvoiceItem" WHERE "invoiceId" = $1 ORDER BY id',
          [a.invoiceId],
        )
      ).rows;
      const changed =
        !inv ||
        String(inv.subtotal) !== a.expected.subtotal ||
        String(inv.taxAmount) !== a.expected.taxAmount ||
        new Date(inv.updatedAt).toISOString() !== a.expected.updatedAt ||
        JSON.stringify(lines.map((l) => l.id)) !== JSON.stringify(a.expected.lineIds) ||
        lines.some((l) => Number(l.taxRate) !== 0);
      if (changed) throw refuse(`invoice ${a.invoiceId} has changed since the dry run`);
      // #2392: never stamp a rate onto the NSF fee line.
      const notNsf = notNsfSql(3);
      const res = await client.query(
        `UPDATE "InvoiceItem" SET "taxRate" = $1 WHERE "invoiceId" = $2 AND "taxRate" = 0 AND ${notNsf.sql}`,
        [a.rate, a.invoiceId, ...notNsf.params],
      );
      stamped += res.rowCount;
    }
    await client.query("COMMIT");
    console.log(`${TAG}: committed — ${stamped} line(s) across ${plan.apply.length} invoice(s)`);
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
  const before = "2026-09-01T00:00:00Z";
  const after = "2026-09-20T00:00:00Z";
  const zero = [{ taxRate: 0, categoryTaxAmount: 0 }];
  const cases = [
    [
      "APPLY: $100 at 7.5%, lines at 0, before the fix",
      { subtotal: 100, taxAmount: 7.5, createdAt: before },
      zero,
      "APPLY",
      0.075,
    ],
    [
      "REVIEW: the same, created after the fix",
      { subtotal: 100, taxAmount: 7.5, createdAt: after },
      zero,
      "REVIEW",
      0.075,
    ],
    [
      "REVIEW: a rate that cannot reproduce the tax",
      { subtotal: 100000, taxAmount: 7.33, createdAt: before },
      zero,
      "REVIEW",
      0.0001,
    ],
    [
      "skipped: MIXED — one line at 7.5%, one at 0",
      { subtotal: 100, taxAmount: 3.75, createdAt: before },
      [{ taxRate: 0.075 }, { taxRate: 0 }],
      null,
    ],
    ["skipped: no tax", { subtotal: 100, taxAmount: 0, createdAt: before }, zero, null],
    // #2392: $125 = $100 goods + a $25 NSF fee; $7.50 tax is 7.5% of the goods — never 0.06.
    [
      "APPLY #2392: a stamped NSF line is out of the inference (7.5% on goods, not 0.06)",
      { subtotal: 125, taxAmount: 7.5, createdAt: before },
      [
        { taxRate: 0, subtotal: 100, systemKind: null, description: "Cola 12pk" },
        {
          taxRate: 0,
          subtotal: 25,
          systemKind: "NSF_FEE",
          description: `${NSF_FEE_DESCRIPTION_PREFIX} #9`,
        },
      ],
      "APPLY",
      0.075,
    ],
    [
      "APPLY #2392: a pre-backfill NSF line (prefix only) is out of the inference too",
      { subtotal: 125, taxAmount: 7.5, createdAt: before },
      [
        { taxRate: 0, subtotal: 100, systemKind: null, description: "Cola 12pk" },
        {
          taxRate: 0,
          subtotal: 25,
          systemKind: null,
          description: `${NSF_FEE_DESCRIPTION_PREFIX} #9`,
        },
      ],
      "APPLY",
      0.075,
    ],
    // #2656 / SA-549: goods at 0 but the NSF line ALREADY taxed (7.5% on the $25 fee, $1.88) —
    // the header tax is inflated to $9.38, which a goods-only inference reads as 0.0938. Never APPLY
    // (the apply's re-read gate would refuse the whole tx on the rated NSF line anyway): REVIEW.
    [
      "REVIEW #2656: goods at 0 + an NSF line already taxed is never planned as APPLY",
      { subtotal: 125, taxAmount: 9.38, createdAt: before },
      [
        { taxRate: 0, subtotal: 100, systemKind: null, description: "Cola 12pk" },
        {
          taxRate: 0.075,
          subtotal: 25,
          systemKind: "NSF_FEE",
          description: `${NSF_FEE_DESCRIPTION_PREFIX} #9`,
        },
      ],
      "REVIEW",
      0.0938,
    ],
    [
      "skipped: only category tax",
      { subtotal: 100, taxAmount: 5, createdAt: before },
      [{ taxRate: 0, categoryTaxAmount: 5 }],
      null,
    ],
  ];
  let failed = 0;
  for (const [name, inv, lines, kind, rate] of cases) {
    const got = classifyInvoice(inv, lines);
    const ok = kind === null ? got === null : got?.kind === kind && got?.rate === rate;
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
    refuseRetiredFlags(process.argv.slice(2));
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return 1;
  }
  return process.argv.includes("--apply") ? apply() : dryRun();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
