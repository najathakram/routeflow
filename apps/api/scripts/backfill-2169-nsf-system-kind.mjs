// #2169 (SA-395): stamp `InvoiceItem.systemKind = 'NSF_FEE'` onto pre-existing NSF bounce-fee
// lines that were written before this PR (InvoicesService.setCheckStatus's BOUNCED branch is the
// only writer of systemKind going forward — every new NSF line already gets it, deploy does not
// wait for this backfill). The rule mirrors backfill-b294-order-line-taxrate.mjs's gate set
// VERBATIM.
//
// STAMP KEY (a line is a backfill candidate only when ALL hold):
//   productId IS NULL, qty = 1, taxRate = 0, discount = 0, systemKind IS NULL,
//   description STARTS WITH the NSF fee prefix,
//   AND the same invoice has a VOID/BOUNCED InvoicePayment whose nsfFeeAmount === roundMoney(line.unitPrice).
// More than one candidate line on an invoice, or a candidate with no matching payment -> REVIEW
// (nothing written for it). This script writes InvoiceItem.systemKind ONLY — never a description,
// amount, status or any other column.
//
// DRY-RUN IS THE DEFAULT: a READ ONLY transaction, always rolled back. It classifies every
// candidate line in the database and saves a content-hashed plan (local-assets/handoff) that
// --apply later replays.
//   APPLY  — exactly one candidate line, exactly one matching BOUNCED/VOID payment.
//   REVIEW — more than one candidate line on the invoice, or no matching payment.
//   (skipped) — the line does not match the stamp key at all.
// Console output is PER-TENANT aggregate counts only (stamped/REVIEW, counts — never an invoice
// id, line id or tenant slug); per-row detail (ids, the matched payment) lives only in the plan
// file written to local-assets/handoff.
//
//   railway run --service postgres node apps/api/scripts/backfill-2169-nsf-system-kind.mjs
//   DATABASE_URL=postgresql://…@localhost:5432/<db> node apps/api/scripts/backfill-2169-nsf-system-kind.mjs --local
//   node apps/api/scripts/backfill-2169-nsf-system-kind.mjs --self-test
//
// SA-403 supersedes the earlier #2169 ruling with TWO independent belts, both enforced in both
// the dry run (planning) and --apply (stamping):
//
// BELT 1 — default ALLOW-LIST (SA-403a): without --live-tenant-override, only rows whose tenant
// passes isTestTenant(slug) (scripts/lib/test-tenants.cjs) are ever planned or stamped. Every
// other tenant's rows are skipped and folded into one aggregate `live-skipped: <n> line(s) across
// <k> tenant(s)` line — never named (no tenant slug is ever printed by this script). With
// --live-tenant-override, a live tenant's rows are included ONLY when --apply also receives a
// repeatable `--confirm-live "<slug>:<count>"` naming it and its EXACT plan stamp count; ANY live
// tenant without a matching confirmation aborts the WHOLE apply (nothing written). Slugs are typed
// by the operator on the command line and never appear in this script's own output.
//
// BELT 2 — external EXCLUSION LIST (unchanged from the original #2169 ruling, kept as a second,
// independent belt): --apply ABORTS (exit 1, nothing connected, nothing written) unless it
// resolves a non-empty tenant exclusion list, EITHER B2169_EXCLUDE_TENANT_IDS (comma/whitespace
// separated tenant ids) OR --exclude-file <path> (one id per line, `#` comments allowed) whose
// resolved real path is OUTSIDE the repository root — checked BEFORE resolving/connecting to any
// database. Excluded tenants' rows are never stamped even under --live-tenant-override, and are
// folded into `excluded: <n> line(s) across <k> tenant(s)` — excluded tenant ids are never
// printed. The dry-run plan records sha256 of the SORTED exclusion set (never the ids
// themselves); run the dry run with the SAME exclusion list (and the same --live-tenant-override
// state) you intend to --apply with, or the checks below refuse the apply.
//
// The B294-style typed "APPLY <n> LINES" phrase is DROPPED: --confirm-live's exact per-live-tenant
// count match already is the typed confirmation for the one case it protected (a live tenant in
// the plan); an allow-list-only apply (the default, no live tenants at all) needs no extra typed
// phrase beyond --i-have-a-fresh-backup, matching B294's own gate set.
//
//   B2169_EXCLUDE_TENANT_IDS="tenant-a,tenant-b" node apps/api/scripts/backfill-2169-nsf-system-kind.mjs
//   node apps/api/scripts/backfill-2169-nsf-system-kind.mjs --exclude-file /path/outside/repo/exclude.txt
//
// APPLY replays a SAVED plan only (never a live re-query):
//   node apps/api/scripts/backfill-2169-nsf-system-kind.mjs --apply --plan <file> \
//     --confirm-plan <hash> --guard-sha <sha> --i-have-a-fresh-backup \
//     --exclude-file /path/outside/repo/exclude.txt [--local]
//   # …and, only if the plan contains live tenants:
//     [--live-tenant-override --confirm-live "<slug-1>:<count-1>" --confirm-live "<slug-2>:<count-2>"]
// (B2169_EXCLUDE_TENANT_IDS may be used in place of --exclude-file.)
// Gates, ALL must pass or nothing is written (SA-134 / B294's set, plus SA-403's two belts):
//   0. a non-empty tenant exclusion list resolves (env var or an out-of-repo --exclude-file) —
//      checked first, before anything below, before any database resolution/connection;
//   1. --confirm-plan equals the plan file's own sha256;
//   2. --guard-sha is a git ancestor of this checkout's HEAD (the migration that adds the column);
//   3. the DB fingerprint (database, tenant ids) still matches the dry run;
//   4. the exclusion set's sha256 must equal the dry-run plan's recorded exclusionHash (re-run the
//      dry run with the same list to change it);
//   5. --i-have-a-fresh-backup, always;
//   6. every planned LINE is RE-READ: systemKind still NULL, same invoiceId/description/unitPrice/
//      updatedAt; AND every planned PAYMENT is RE-READ: still status VOID + checkStatus BOUNCED,
//      same nsfFeeAmount — any change to either row refuses the WHOLE apply;
//   7. excluded-tenant rows are re-filtered out of the plan at apply time too (defense in depth);
//   8. a LIVE (non-test) tenant needs --live-tenant-override AND an exact --confirm-live
//      "<slug>:<count>" match for every live tenant remaining in the plan, or the whole apply
//      aborts; without --live-tenant-override, live-tenant rows are simply skipped (not an abort).
// One transaction. Exit: 0 ok · 1 refused (nothing written) · 2 env/connection error.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { NSF_FEE_DESCRIPTION_PREFIX, NSF_FEE_SYSTEM_KIND, roundMoney } from "@routeflow/pricing";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
import { isLocalDbTarget } from "./lib/local-db-target.cjs";
import { requireLocalPgConfig } from "./lib/local-pg-config.mjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";
import guard from "./lib/live-target-guard.cjs";
import protectedSlugsLib from "./lib/protected-slugs.cjs";

// Row 195 (BELT 3): protected tenants (paying | stripe-linked | PROTECTED_TENANT_SLUGS) are never
// planned and never stamped, with or without --live-tenant-override. Counts only, never a slug.
const { protectedTenantIds } = guard;
const { loadProtectedSlugs } = protectedSlugsLib;

const TAG = "backfill-2169";
// NSF_FEE_SYSTEM_KIND / NSF_FEE_DESCRIPTION_PREFIX come from @routeflow/pricing (#2392 / SA-478 —
// the ONE shared NSF predicate's values; pricing pins NSF_FEE_SYSTEM_KIND to the Prisma enum via
// @routeflow/types + enum-parity.spec). --self-test below still checks the enum value.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SELF = resolve(dirname(fileURLToPath(import.meta.url)), "backfill-2169-nsf-system-kind.mjs");

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
/** Every occurrence of a repeatable flag (e.g. `--confirm-live` given more than once). */
const allArgsOf = (name) => {
  const out = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === name && process.argv[i + 1] !== undefined)
      out.push(process.argv[i + 1]);
  }
  return out;
};
const sha256 = (obj) => createHash("sha256").update(JSON.stringify(obj)).digest("hex");
const refuse = (msg) => Object.assign(new Error(msg), { refuse: true });

/**
 * Pure: one invoice's candidate lines (already stamp-key filtered by the SQL below) + its
 * VOID/BOUNCED payments -> "APPLY" (stamp the one line) / "REVIEW" (do nothing, flag it) / null
 * (no candidate line at all -- never reached once the caller only passes invoices WITH candidates,
 * kept here so the pure function stays total).
 */
export function classifyCandidate(lines, payments) {
  if (lines.length === 0) return null;
  if (lines.length > 1) {
    return { kind: "REVIEW", reason: "more than one candidate NSF-shaped line on this invoice" };
  }
  const line = lines[0];
  const target = roundMoney(Number(line.unitPrice));
  const match = (payments ?? []).find(
    (p) =>
      p.status === "VOID" &&
      p.checkStatus === "BOUNCED" &&
      p.nsfFeeAmount != null &&
      roundMoney(Number(p.nsfFeeAmount)) === target,
  );
  if (!match) {
    return {
      kind: "REVIEW",
      reason: "no matching VOID/BOUNCED payment with nsfFeeAmount == line.unitPrice",
    };
  }
  return { kind: "APPLY", lineId: line.id, paymentId: match.id, nsfFeeAmount: match.nsfFeeAmount };
}

// ─── tenant exclusion list (#2169 ruling) ──────────────────────────────────────────────────────

/**
 * Pure: env-var form ("comma or whitespace separated ids") -> deduped id array (order preserved).
 */
export function parseExclusionEnvList(raw) {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/** Pure: file form (one id per line, `#` starts a comment, blank lines ignored) -> deduped ids. */
export function parseExclusionFileContents(text) {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.replace(/#.*$/, "").trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Resolves the tenant exclusion list from EITHER B2169_EXCLUDE_TENANT_IDS OR --exclude-file
 * (never both required; --exclude-file wins if both are given). Throws (never returns an empty
 * list) when: neither source is given, the file resolves inside the repository, or either source
 * parses to zero ids. No database is touched by this function.
 */
export function parseExclusionList({
  env = process.env,
  excludeFileArg,
  repoRoot = REPO_ROOT,
  readFileText = (p) => readFileSync(p, "utf8"),
  resolveRealPath = (p) => realpathSync(p),
} = {}) {
  if (excludeFileArg) {
    let real;
    try {
      real = resolveRealPath(excludeFileArg);
    } catch (e) {
      throw new Error(`--exclude-file ${excludeFileArg} could not be resolved: ${e.message}`);
    }
    const realRoot = resolveRealPath(repoRoot);
    const rel = relative(realRoot, real);
    const isInsideRepo = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    if (isInsideRepo) {
      throw new Error(
        `--exclude-file must resolve OUTSIDE the repository (got ${real}, repo root ${realRoot})`,
      );
    }
    const ids = parseExclusionFileContents(readFileText(real));
    if (ids.length === 0) {
      throw new Error(`--exclude-file ${excludeFileArg} is empty — refusing to apply`);
    }
    return { ids, source: `--exclude-file ${excludeFileArg}` };
  }
  const envRaw = env.B2169_EXCLUDE_TENANT_IDS;
  if (envRaw == null) {
    throw new Error(
      "no tenant exclusion list supplied: set B2169_EXCLUDE_TENANT_IDS or pass --exclude-file <path outside the repo>",
    );
  }
  const ids = parseExclusionEnvList(envRaw);
  if (ids.length === 0) {
    throw new Error("B2169_EXCLUDE_TENANT_IDS is empty — refusing to apply");
  }
  return { ids, source: "B2169_EXCLUDE_TENANT_IDS" };
}

/** Pure: sha256 of the SORTED exclusion set — never the ids themselves, order-independent. */
export function exclusionSetHash(ids) {
  return createHash("sha256")
    .update(JSON.stringify([...ids].sort()))
    .digest("hex");
}

/** Pure: 0 → "A", 25 → "Z", 26 → "AA" (spreadsheet-style column letters). */
function tenantLabel(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return `tenant ${s}`;
}

/**
 * Pure: the per-tenant dry-run summary with ANONYMOUS labels ("tenant A: stamped=… review=…"),
 * never a tenant id — terminal output included (SA-403 (e) + the client-data policy). Largest
 * tenant first so the labels carry no id ordering.
 */
export function anonymousTenantSummary(byTenant) {
  return [...byTenant.values()]
    .sort((a, b) => b.stamped + b.review - (a.stamped + a.review))
    .map((c, i) => `${tenantLabel(i)}: stamped=${c.stamped} review=${c.review}`);
}

/**
 * Pure: the --apply refusal when planned rows changed since the dry run. Counts only, never a
 * line or payment id (SA-403 (e) aggregate output).
 */
export function staleRefusalMessage(changedLines, changedPayments) {
  const n = changedLines + changedPayments;
  return (
    `${n} planned row(s) changed since the plan (${changedLines} line(s), ` +
    `${changedPayments} payment(s)); re-run the dry run`
  );
}

/** Pure: splits APPLY candidates into non-excluded (kept) and excluded (never stamped). */
export function partitionApplyByExclusion(applyRows, excludedIds) {
  const excludedSet = new Set(excludedIds);
  const kept = [];
  const excludedTenantIds = new Set();
  let excludedCount = 0;
  for (const a of applyRows) {
    if (excludedSet.has(a.tenantId)) {
      excludedCount += 1;
      excludedTenantIds.add(a.tenantId);
    } else {
      kept.push(a);
    }
  }
  return { kept, excludedCount, excludedTenantIds };
}

/** Pure: same split for REVIEW entries (each carries its own lineIds, so a "line" ≠ one entry). */
export function partitionReviewByExclusion(reviewRows, excludedIds) {
  const excludedSet = new Set(excludedIds);
  const kept = [];
  const excludedTenantIds = new Set();
  let excludedCount = 0;
  for (const r of reviewRows) {
    if (excludedSet.has(r.tenantId)) {
      excludedCount += r.lineIds ? r.lineIds.length : 1;
      excludedTenantIds.add(r.tenantId);
    } else {
      kept.push(r);
    }
  }
  return { kept, excludedCount, excludedTenantIds };
}

// ─── SA-403 BELT 1: default test-tenant allow-list ─────────────────────────────────────────────

/** A "line" row (apply-shaped) counts as 1; a REVIEW row carries its own lineIds array. */
const rowUnitCount = (row) => (Array.isArray(row.lineIds) ? row.lineIds.length : 1);

/**
 * Pure: without `override`, only rows whose tenant passes isTestTenant(slugById.get(tenantId))
 * are kept — every other tenant's row is skipped and counted (never named: the caller must never
 * print a slug). With `override`, every row is kept (the live ones still need a matching
 * --confirm-live at apply time — see assertLiveTenantConfirmations below).
 */
export function partitionByAllowList(rows, slugById, override) {
  const kept = [];
  const skippedTenantIds = new Set();
  let skippedCount = 0;
  for (const r of rows) {
    const slug = slugById.get(r.tenantId) ?? null;
    if (override || isTestTenant(slug)) {
      kept.push(r);
    } else {
      skippedCount += rowUnitCount(r);
      skippedTenantIds.add(r.tenantId);
    }
  }
  return { kept, skippedCount, skippedTenantIds };
}

/** Pure: per-slug stamp counts among the NON-test-tenant rows of an (already override-kept) apply list. */
export function liveTenantStampCounts(applyRows, slugById) {
  const counts = new Map();
  for (const a of applyRows) {
    const slug = slugById.get(a.tenantId) ?? null;
    if (isTestTenant(slug)) continue;
    const key = slug ?? `<unresolvable:${a.tenantId}>`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Pure: "<slug>:<count>" -> { slug, count }. Throws on any shape other than exactly that. */
export function parseConfirmLiveArg(raw) {
  const idx = raw.lastIndexOf(":");
  if (idx <= 0 || idx === raw.length - 1) {
    // Never echo the operator's value: it carries a live tenant's slug (SA-403 (e)).
    throw refuse('every --confirm-live value must be "<slug>:<count>"');
  }
  const slug = raw.slice(0, idx);
  const count = Number(raw.slice(idx + 1));
  if (!Number.isInteger(count) || count < 0) {
    throw refuse("every --confirm-live value must end with a non-negative integer count");
  }
  return { slug, count };
}

/**
 * Pure: every live tenant in `liveCounts` (slug -> stamp count) needs an EXACT matching
 * --confirm-live entry, or the WHOLE apply is refused. Never names the offending slug(s) in the
 * thrown message — only a count — so a live tenant's slug never reaches this script's own output.
 */
export function assertLiveTenantConfirmations(liveCounts, confirmLiveArgs) {
  const given = new Map(
    confirmLiveArgs.map((raw) => {
      const { slug, count } = parseConfirmLiveArg(raw);
      return [slug, count];
    }),
  );
  const mismatched = [...liveCounts.entries()].filter(([slug, count]) => given.get(slug) !== count);
  if (mismatched.length > 0) {
    throw refuse(
      `${mismatched.length} live tenant(s) have no exactly-matching --confirm-live "<slug>:<count>" -- refusing the whole apply, nothing written`,
    );
  }
  return true;
}

const CANDIDATE_LINES_SQL = `
  SELECT ii.id, ii."invoiceId", i."tenantId", ii."unitPrice", ii.description, ii."updatedAt"
  FROM "InvoiceItem" ii
  JOIN "Invoice" i ON i.id = ii."invoiceId"
  WHERE ii."productId" IS NULL AND ii.qty = 1 AND ii."taxRate" = 0 AND ii.discount = 0
    AND ii."systemKind" IS NULL AND ii.description LIKE $1
  ORDER BY ii.id`;
const PAYMENTS_SQL = `
  SELECT id, "invoiceId", status, "checkStatus", "nsfFeeAmount"
  FROM "InvoicePayment"
  WHERE "invoiceId" = ANY($1::text[]) AND status = 'VOID' AND "checkStatus" = 'BOUNCED'`;

async function resolveTarget() {
  const local = process.argv.includes("--local");
  // B768: every target resolves through the shared resolver (never a direct env read). Under
  // --local it may fall back to the local connection string; isLocalDbTarget below still refuses
  // any non-local host, so a stray Railway proxy env cannot redirect a local run.
  const url = resolveDatabaseUrl(process.env, { requireProxy: !local });
  if (!url) throw new Error("--local requires a local database connection string");
  if (local && !isLocalDbTarget(url))
    throw new Error(`--local refuses a non-local host (${redactUrl(url)})`);
  return url;
}

const dialConfig = (url) =>
  process.argv.includes("--local") ? requireLocalPgConfig(url) : { connectionString: url };

async function fingerprint(client) {
  const [db, tenants] = await Promise.all([
    client.query("SELECT current_database() AS db"),
    client.query('SELECT id FROM "Tenant" ORDER BY id'),
  ]);
  return { database: db.rows[0].db, tenantIds: tenants.rows.map((t) => t.id) };
}

/** tenantId -> slug, for exactly the tenant ids given (SA-403's allow-list needs the slug). */
async function fetchSlugById(client, tenantIds) {
  if (tenantIds.length === 0) return new Map();
  const res = await client.query('SELECT id, slug FROM "Tenant" WHERE id = ANY($1::text[])', [
    tenantIds,
  ]);
  return new Map(res.rows.map((t) => [t.id, t.slug]));
}

async function dryRun() {
  // Exclusion list is OPTIONAL for the dry run — but --apply always requires one, and --apply
  // refuses unless the list it is given hashes the same as the one recorded here. Run the dry run
  // with the same list you intend to --apply with.
  let exclusion = null;
  try {
    const excludeFileArg = argOf("--exclude-file");
    if (excludeFileArg || process.env.B2169_EXCLUDE_TENANT_IDS != null) {
      exclusion = parseExclusionList({ excludeFileArg });
    }
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return 1;
  }

  let url, client, protectedSlugs;
  try {
    url = await resolveTarget();
    protectedSlugs = loadProtectedSlugs(process.env, url);
    console.log(`${TAG}: target ${redactUrl(url)} DRY-RUN`);
    client = new pg.Client(dialConfig(url));
    await client.connect();
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return 2;
  }
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const fp = await fingerprint(client);
    const lines = (await client.query(CANDIDATE_LINES_SQL, [`${NSF_FEE_DESCRIPTION_PREFIX}%`]))
      .rows;
    const payments = lines.length
      ? (await client.query(PAYMENTS_SQL, [lines.map((l) => l.invoiceId)])).rows
      : [];
    const slugById = await fetchSlugById(client, [...new Set(lines.map((l) => l.tenantId))]);
    const protectedIds = await protectedTenantIds(client, protectedSlugs);
    await client.query("ROLLBACK");

    const linesByInvoice = new Map();
    for (const l of lines)
      linesByInvoice.set(l.invoiceId, [...(linesByInvoice.get(l.invoiceId) ?? []), l]);
    const paymentsByInvoice = new Map();
    for (const p of payments)
      paymentsByInvoice.set(p.invoiceId, [...(paymentsByInvoice.get(p.invoiceId) ?? []), p]);

    const apply = [];
    const review = [];
    const paymentsById = new Map(payments.map((p) => [p.id, p]));
    for (const [invoiceId, own] of linesByInvoice) {
      const invoicePayments = paymentsByInvoice.get(invoiceId) ?? [];
      const c = classifyCandidate(own, invoicePayments);
      if (!c) continue;
      if (c.kind === "REVIEW") {
        review.push({ invoiceId, tenantId: own[0].tenantId, lineIds: own.map((l) => l.id) });
        continue;
      }
      const line = own.find((l) => l.id === c.lineId);
      const payment = paymentsById.get(c.paymentId);
      apply.push({
        invoiceId,
        lineId: line.id,
        paymentId: c.paymentId,
        tenantId: line.tenantId,
        expected: {
          invoiceId: line.invoiceId,
          description: line.description,
          unitPrice: String(line.unitPrice),
          updatedAt: new Date(line.updatedAt).toISOString(),
          paymentStatus: payment.status,
          paymentCheckStatus: payment.checkStatus,
          paymentNsfFeeAmount: String(payment.nsfFeeAmount),
        },
      });
    }

    // BELT 3 (row 195): protected tenants' rows are dropped before anything else is counted.
    const applyProtPartition = partitionApplyByExclusion(apply, protectedIds);
    const reviewProtPartition = partitionReviewByExclusion(review, protectedIds);
    const protectedLineCount = applyProtPartition.excludedCount + reviewProtPartition.excludedCount;
    const protectedTenantCount = new Set([
      ...applyProtPartition.excludedTenantIds,
      ...reviewProtPartition.excludedTenantIds,
    ]).size;

    // BELT 2 (external exclusion list, unchanged from #2169): excluded tenants' rows are never
    // stamped and never counted per-tenant — folded into one aggregate line. No-op when no list
    // was supplied to this dry run.
    const excludedIds = exclusion ? exclusion.ids : [];
    const applyExclPartition = partitionApplyByExclusion(applyProtPartition.kept, excludedIds);
    const reviewExclPartition = partitionReviewByExclusion(reviewProtPartition.kept, excludedIds);
    const excludedLineCount = applyExclPartition.excludedCount + reviewExclPartition.excludedCount;
    const excludedTenantIds = new Set([
      ...applyExclPartition.excludedTenantIds,
      ...reviewExclPartition.excludedTenantIds,
    ]);

    // BELT 1 (SA-403 default allow-list): of what BELT 2 kept, only test-tenant rows are planned
    // unless --live-tenant-override says otherwise. Also folded into one aggregate, never named.
    const liveOverride = process.argv.includes("--live-tenant-override");
    const applyAllowPartition = partitionByAllowList(
      applyExclPartition.kept,
      slugById,
      liveOverride,
    );
    const reviewAllowPartition = partitionByAllowList(
      reviewExclPartition.kept,
      slugById,
      liveOverride,
    );
    const finalApply = applyAllowPartition.kept;
    const finalReview = reviewAllowPartition.kept;
    const liveSkippedCount = applyAllowPartition.skippedCount + reviewAllowPartition.skippedCount;
    const liveSkippedTenantIds = new Set([
      ...applyAllowPartition.skippedTenantIds,
      ...reviewAllowPartition.skippedTenantIds,
    ]);

    const plan = {
      generatedAt: new Date().toISOString(),
      fingerprint: fp,
      apply: finalApply,
      exclusionHash: exclusion ? exclusionSetHash(exclusion.ids) : null,
    };
    const hash = sha256(plan);
    const dir = resolve(REPO_ROOT, "local-assets/handoff", new Date().toISOString().slice(0, 10));
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `2169-plan-${Date.now()}.json`);
    const excludedSummary = exclusion
      ? { lines: excludedLineCount, tenants: excludedTenantIds.size }
      : null;
    writeFileSync(
      file,
      JSON.stringify({ ...plan, planHash: hash, review: finalReview, excludedSummary }, null, 2),
    );

    // Aggregate counts PER TENANT ID only — never an invoice id, line id or tenant slug. Excluded
    // tenants never appear here (finalApply/finalReview already omit them).
    const byTenant = new Map();
    for (const a of finalApply) {
      const t = byTenant.get(a.tenantId) ?? { stamped: 0, review: 0 };
      t.stamped += 1;
      byTenant.set(a.tenantId, t);
    }
    for (const r of finalReview) {
      const t = byTenant.get(r.tenantId) ?? { stamped: 0, review: 0 };
      t.review += 1;
      byTenant.set(r.tenantId, t);
    }
    console.log(`\n${TAG}: ${lines.length} candidate line(s) scanned`);
    console.log(`  APPLY:  ${finalApply.length} line(s) total`);
    console.log(
      `  REVIEW: ${finalReview.length} invoice(s) total (listed in the plan file; nothing is written for them)`,
    );
    console.log(`  per tenant (anonymous labels, SA-403 (e)):`);
    for (const line of anonymousTenantSummary(byTenant)) console.log(`    ${line}`);
    if (exclusion) {
      console.log(
        `  excluded: ${excludedLineCount} line(s) across ${excludedTenantIds.size} tenant(s)`,
      );
    }
    console.log(
      `  protected-skipped: ${protectedLineCount} line(s) across ${protectedTenantCount} tenant(s)`,
    );
    console.log(
      `  live-skipped: ${liveSkippedCount} line(s) across ${liveSkippedTenantIds.size} tenant(s)${liveOverride ? " (override was on for THIS dry run — re-check --confirm-live at apply time)" : ""}`,
    );
    console.log(`\nplan: ${file}\nplan hash: ${hash}`);
    if (finalApply.length > 0) {
      console.log(
        `\nto apply: node ${SELF.replace(/\\/g, "/")} --apply --plan ${file.replace(/\\/g, "/")} --confirm-plan ${hash} --guard-sha <sha> --i-have-a-fresh-backup --exclude-file <same list>` +
          (liveOverride
            ? ` --live-tenant-override --confirm-live "<slug>:<count>" [--confirm-live "<slug-2>:<count-2>" ...]`
            : ""),
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

  // Gate 0 (#2169 ruling): a non-empty tenant exclusion list, resolved and validated BEFORE
  // anything below touches a database — env var or an out-of-repo --exclude-file.
  let exclusion;
  try {
    exclusion = parseExclusionList({ excludeFileArg: argOf("--exclude-file") });
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return 1;
  }

  const saved = JSON.parse(readFileSync(planFile, "utf8"));
  const { planHash, review: _review, excludedSummary: _excludedSummary, ...plan } = saved;
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

  // Gate 7: the exclusion list given now must be the SAME one the dry run recorded (hash of the
  // sorted set, never the ids themselves).
  if (plan.exclusionHash !== exclusionSetHash(exclusion.ids)) {
    console.error(
      `${TAG}: the exclusion list's hash does not match the dry-run plan's -- re-run the dry run with this same list first`,
    );
    return 1;
  }

  // Defensive re-filter: should be a no-op given the hash match above (the dry run already
  // excluded these rows before saving the plan), but guarantees an excluded tenant can never be
  // stamped even if the plan file was hand-edited.
  const {
    kept,
    excludedCount: reFilteredCount,
    excludedTenantIds: reFilteredTenants,
  } = partitionApplyByExclusion(plan.apply, exclusion.ids);
  if (reFilteredCount > 0) {
    console.error(
      `${TAG}: the plan still contains ${reFilteredCount} line(s) across ${reFilteredTenants.size} excluded tenant(s) -- refusing (was the plan file hand-edited?)`,
    );
    return 1;
  }

  let url, client, protectedSlugs;
  try {
    url = await resolveTarget();
    protectedSlugs = loadProtectedSlugs(process.env, url);
    console.log(
      `${TAG}: target ${redactUrl(url)} APPLY (${kept.length} line(s) proposed, excluding ${exclusion.ids.length} tenant(s))`,
    );
    client = new pg.Client(dialConfig(url));
    await client.connect();
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return 2;
  }
  try {
    await client.query("BEGIN");
    // Bounded like the dry run: a stuck lock or a slow statement aborts the apply (and rolls it
    // back) instead of holding InvoiceItem/InvoicePayment rows indefinitely.
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("SET LOCAL lock_timeout = '10s'");
    if (JSON.stringify(await fingerprint(client)) !== JSON.stringify(plan.fingerprint)) {
      throw refuse("DB fingerprint changed since the dry run (database or tenants differ)");
    }

    // Gate 9 (row 195 BELT 3): a plan row whose tenant is protected NOW (paying, Stripe-linked or
    // env-listed — it may have become so since the dry run) refuses the WHOLE apply. Counts only.
    const protectedHit = partitionApplyByExclusion(
      kept,
      await protectedTenantIds(client, protectedSlugs),
    );
    if (protectedHit.excludedCount > 0) {
      throw refuse(
        `${protectedHit.excludedCount} planned line(s) across ${protectedHit.excludedTenantIds.size} protected tenant(s); re-run the dry run`,
      );
    }

    // Gate 8 (SA-403 BELT 1): default allow-list, re-derived fresh (never trusts the dry run's
    // classification of test vs. live). Without --live-tenant-override, live rows are simply
    // skipped (not an abort). With it, every live tenant remaining needs an EXACT --confirm-live
    // "<slug>:<count>" match or the whole apply is refused — nothing written.
    const tenantIds = [...new Set(kept.map((a) => a.tenantId))];
    const slugById = await fetchSlugById(client, tenantIds);
    const liveOverride = process.argv.includes("--live-tenant-override");
    const allow = partitionByAllowList(kept, slugById, liveOverride);
    const stampSet = allow.kept;
    if (liveOverride) {
      const liveCounts = liveTenantStampCounts(stampSet, slugById);
      if (liveCounts.size > 0) {
        assertLiveTenantConfirmations(liveCounts, allArgsOf("--confirm-live"));
      }
    }

    // Re-read EVERY planned row before writing any (SA-403 (e): a refusal reports counts only,
    // never a line or payment id).
    let changedLines = 0;
    let changedPayments = 0;
    for (const a of stampSet) {
      const row = (
        await client.query(
          // FOR UPDATE: the row cannot change between this re-read and the stamp below.
          'SELECT "invoiceId", description, "unitPrice", "updatedAt", "systemKind" FROM "InvoiceItem" WHERE id = $1 FOR UPDATE',
          [a.lineId],
        )
      ).rows[0];
      const lineChanged =
        !row ||
        row.systemKind !== null ||
        row.invoiceId !== a.expected.invoiceId ||
        row.description !== a.expected.description ||
        String(row.unitPrice) !== a.expected.unitPrice ||
        new Date(row.updatedAt).toISOString() !== a.expected.updatedAt;
      if (lineChanged) {
        changedLines += 1;
        continue;
      }

      const payment = (
        await client.query(
          'SELECT status, "checkStatus", "nsfFeeAmount" FROM "InvoicePayment" WHERE id = $1 FOR UPDATE',
          [a.paymentId],
        )
      ).rows[0];
      const paymentChanged =
        !payment ||
        payment.status !== a.expected.paymentStatus ||
        payment.checkStatus !== a.expected.paymentCheckStatus ||
        String(payment.nsfFeeAmount) !== a.expected.paymentNsfFeeAmount;
      if (paymentChanged) changedPayments += 1;
    }
    if (changedLines + changedPayments > 0) {
      throw refuse(staleRefusalMessage(changedLines, changedPayments));
    }

    let stamped = 0;
    for (const a of stampSet) {
      const res = await client.query(
        'UPDATE "InvoiceItem" SET "systemKind" = $2 WHERE id = $1 AND "systemKind" IS NULL',
        [a.lineId, NSF_FEE_SYSTEM_KIND],
      );
      stamped += res.rowCount;
    }
    await client.query("COMMIT");
    console.log(`${TAG}: committed — ${stamped} line(s) stamped`);
    if (saved.excludedSummary) {
      console.log(
        `excluded: ${saved.excludedSummary.lines} line(s) across ${saved.excludedSummary.tenants} tenant(s)`,
      );
    }
    console.log(
      `live-skipped: ${allow.skippedCount} line(s) across ${allow.skippedTenantIds.size} tenant(s)`,
    );
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`${TAG}: ${e.message}${e.refuse ? " -- nothing was written" : ""}`);
    return e.refuse ? 1 : 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Reads the real `enum InvoiceItemSystemKind { ... }` block straight from the schema source (no
 * `@prisma/client` import — this is a plain .mjs, see the header comment above
 * `NSF_FEE_SYSTEM_KIND`), so the pin below fails the moment the schema enum is renamed rather
 * than trivially re-asserting the hand-copied string against itself.
 */
function readSchemaEnumMembers(enumName) {
  const schemaPath = resolve(REPO_ROOT, "apps/api/prisma/schema/finance.prisma");
  const src = readFileSync(schemaPath, "utf8");
  const m = src.match(new RegExp(`enum\\s+${enumName}\\s*\\{([^}]*)\\}`));
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean);
}

/** --self-test: the pure classifier, no database. */
function selfTest() {
  const cases = [
    [
      "APPLY: one candidate line, one matching VOID/BOUNCED payment at the same amount",
      [{ id: "li-1", unitPrice: 25 }],
      [{ status: "VOID", checkStatus: "BOUNCED", nsfFeeAmount: 25 }],
      "APPLY",
    ],
    [
      "REVIEW: two candidate lines on the same invoice",
      [
        { id: "li-1", unitPrice: 25 },
        { id: "li-2", unitPrice: 30 },
      ],
      [{ status: "VOID", checkStatus: "BOUNCED", nsfFeeAmount: 25 }],
      "REVIEW",
    ],
    ["REVIEW: no matching payment at all", [{ id: "li-1", unitPrice: 25 }], [], "REVIEW"],
    [
      "REVIEW: a payment exists but the amount differs",
      [{ id: "li-1", unitPrice: 25 }],
      [{ status: "VOID", checkStatus: "BOUNCED", nsfFeeAmount: 30 }],
      "REVIEW",
    ],
    [
      "REVIEW: a payment matches the amount but is not VOID/BOUNCED",
      [{ id: "li-1", unitPrice: 25 }],
      [{ status: "PAID", checkStatus: "CLEARED", nsfFeeAmount: 25 }],
      "REVIEW",
    ],
    [
      "APPLY: sub-cent rounding still matches (24.999 rounds to 25)",
      [{ id: "li-1", unitPrice: 24.999 }],
      [{ status: "VOID", checkStatus: "BOUNCED", nsfFeeAmount: 25 }],
      "APPLY",
    ],
  ];
  let failed = 0;
  for (const [name, lines, payments, kind] of cases) {
    const got = classifyCandidate(lines, payments);
    const ok = got?.kind === kind;
    if (!ok) failed += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)})`}`);
  }
  // L-072 pin: read the ACTUAL schema source rather than re-asserting the hand-copied string
  // against itself — this fails the moment `InvoiceItemSystemKind` is renamed or the member
  // dropped in apps/api/prisma/schema/finance.prisma.
  const schemaMembers = readSchemaEnumMembers("InvoiceItemSystemKind");
  const enumPinOk = schemaMembers.length > 0 && schemaMembers.includes(NSF_FEE_SYSTEM_KIND);
  if (!enumPinOk) failed += 1;
  console.log(
    `${enumPinOk ? "ok  " : "FAIL"} NSF_FEE_SYSTEM_KIND ("${NSF_FEE_SYSTEM_KIND}") is a member of finance.prisma's InvoiceItemSystemKind (${JSON.stringify(schemaMembers)})`,
  );

  // ─── SA-403: exclusion list, default allow-list, live-tenant confirmation (pure, no database) ──
  // Fake tenant ids / slugs ONLY — never real ones — and the pin at the end re-checks that this
  // whole block never printed one: every check() call below is captured, not sent straight to
  // stdout, and only replayed (still id-free — every case name is a fixed, static string) once the
  // capture confirms no fake id or slug leaked into it.
  let sa403Failed = 0;
  let sa403Total = 0;
  const sa403Lines = [];
  const check = (name, ok) => {
    sa403Total += 1;
    if (!ok) sa403Failed += 1;
    sa403Lines.push(`${ok ? "ok  " : "FAIL"} ${name}`);
  };
  const threw = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  {
    const byTenant = new Map([
      ["1f0e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b", { stamped: 1, review: 0 }],
      ["tenant-excl-1", { stamped: 3, review: 2 }],
    ]);
    const lines = anonymousTenantSummary(byTenant);
    check(
      "anonymousTenantSummary: labels only, largest first, no tenant id or UUID-shaped string",
      JSON.stringify(lines) ===
        JSON.stringify(["tenant A: stamped=3 review=2", "tenant B: stamped=1 review=0"]) &&
        !lines.some((l) => /[0-9a-f]{8}-[0-9a-f]{4}-|tenant-excl-1/i.test(l)),
    );
    check(
      "anonymousTenantSummary: 27th tenant is labelled AA",
      anonymousTenantSummary(
        new Map(Array.from({ length: 27 }, (_, i) => [`t${i}`, { stamped: 27 - i, review: 0 }])),
      )[26].startsWith("tenant AA:"),
    );
  }
  {
    const msg = staleRefusalMessage(2, 1);
    check(
      "staleRefusalMessage: counts only, no line/payment id (SA-403 (e))",
      msg ===
        "3 planned row(s) changed since the plan (2 line(s), 1 payment(s)); re-run the dry run" &&
        !/line-|pay-|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(msg),
    );
  }
  check(
    "parseExclusionEnvList: comma/whitespace separated, deduped",
    JSON.stringify(parseExclusionEnvList("tenant-excl-1, tenant-excl-2  tenant-excl-1")) ===
      JSON.stringify(["tenant-excl-1", "tenant-excl-2"]),
  );
  check(
    "parseExclusionFileContents: comments and blank lines ignored",
    JSON.stringify(
      parseExclusionFileContents("tenant-excl-1\n# a comment\n\n  tenant-excl-2 # trailing\n"),
    ) === JSON.stringify(["tenant-excl-1", "tenant-excl-2"]),
  );
  check(
    "parseExclusionList: an all-whitespace env value throws (empty, never an empty list)",
    threw(() => parseExclusionList({ env: { B2169_EXCLUDE_TENANT_IDS: "  , " } })),
  );
  check(
    "parseExclusionList: neither source given throws",
    threw(() => parseExclusionList({ env: {} })),
  );
  check(
    "parseExclusionList: --exclude-file resolving inside the repo throws",
    threw(() =>
      parseExclusionList({
        env: {},
        excludeFileArg: "exclude.txt",
        repoRoot: "/repo",
        resolveRealPath: (p) => (p === "/repo" ? "/repo" : "/repo/exclude.txt"),
        readFileText: () => "tenant-excl-1\n",
      }),
    ),
  );
  check(
    "parseExclusionList: an out-of-repo --exclude-file parses",
    (() => {
      const r = parseExclusionList({
        env: {},
        excludeFileArg: "/outside/exclude.txt",
        repoRoot: "/repo",
        resolveRealPath: (p) => (p === "/repo" ? "/repo" : "/outside/exclude.txt"),
        readFileText: () => "tenant-excl-1\ntenant-excl-2\n",
      });
      return JSON.stringify(r.ids) === JSON.stringify(["tenant-excl-1", "tenant-excl-2"]);
    })(),
  );
  check(
    "exclusionSetHash: stable under reordering (sorted before hashing)",
    exclusionSetHash(["tenant-excl-2", "tenant-excl-1"]) ===
      exclusionSetHash(["tenant-excl-1", "tenant-excl-2"]),
  );
  check(
    "exclusionSetHash: a different set hashes differently",
    exclusionSetHash(["tenant-excl-1"]) !== exclusionSetHash(["tenant-excl-1", "tenant-excl-2"]),
  );

  {
    const applyRows = [
      { lineId: "li-1", tenantId: "tenant-excl-1" },
      { lineId: "li-2", tenantId: "tenant-keep-1" },
    ];
    const p = partitionApplyByExclusion(applyRows, ["tenant-excl-1"]);
    check(
      "partitionApplyByExclusion: excluded rows filtered out of the plan and counted",
      p.kept.length === 1 &&
        p.kept[0].tenantId === "tenant-keep-1" &&
        p.excludedCount === 1 &&
        p.excludedTenantIds.size === 1,
    );
  }
  {
    const reviewRows = [
      { invoiceId: "inv-1", tenantId: "tenant-excl-1", lineIds: ["li-1", "li-2"] },
      { invoiceId: "inv-2", tenantId: "tenant-keep-1", lineIds: ["li-3"] },
    ];
    const p = partitionReviewByExclusion(reviewRows, ["tenant-excl-1"]);
    check(
      "partitionReviewByExclusion: a REVIEW entry's excluded LINES are counted, not the entry",
      p.kept.length === 1 && p.excludedCount === 2 && p.excludedTenantIds.size === 1,
    );
  }

  {
    const slugById = new Map([
      ["tenant-test-1", "test"],
      ["tenant-live-1", "live-fake-1"],
    ]);
    const rows = [
      { lineId: "li-1", tenantId: "tenant-test-1" },
      { lineId: "li-2", tenantId: "tenant-live-1" },
    ];
    const noOverride = partitionByAllowList(rows, slugById, false);
    check(
      "partitionByAllowList: default — a live-shaped tenant's row is skipped and counted",
      noOverride.kept.length === 1 &&
        noOverride.kept[0].tenantId === "tenant-test-1" &&
        noOverride.skippedCount === 1 &&
        noOverride.skippedTenantIds.size === 1,
    );
    const withOverride = partitionByAllowList(rows, slugById, true);
    check(
      "partitionByAllowList: --live-tenant-override keeps every row",
      withOverride.kept.length === 2 && withOverride.skippedCount === 0,
    );
    const liveCounts = liveTenantStampCounts(withOverride.kept, slugById);
    check(
      "liveTenantStampCounts: counts only the non-test-tenant rows, keyed by slug",
      liveCounts.size === 1 && liveCounts.get("live-fake-1") === 1,
    );
    check(
      "assertLiveTenantConfirmations: an exact slug:count match passes",
      !threw(() => assertLiveTenantConfirmations(liveCounts, ["live-fake-1:1"])),
    );
    check(
      "assertLiveTenantConfirmations: a count mismatch throws (refuses the WHOLE apply)",
      threw(() => assertLiveTenantConfirmations(liveCounts, ["live-fake-1:2"])),
    );
    check(
      "assertLiveTenantConfirmations: a missing confirmation throws",
      threw(() => assertLiveTenantConfirmations(liveCounts, [])),
    );
  }
  check(
    "parseConfirmLiveArg: parses '<slug>:<count>'",
    (() => {
      const r = parseConfirmLiveArg("live-fake-1:3");
      return r.slug === "live-fake-1" && r.count === 3;
    })(),
  );
  check(
    "parseConfirmLiveArg: a non-integer count throws",
    threw(() => parseConfirmLiveArg("live-fake-1:abc")),
  );
  {
    const msgOf = (fn) => {
      try {
        fn();
        return "";
      } catch (e) {
        return String(e.message);
      }
    };
    const m1 = msgOf(() => parseConfirmLiveArg("live-fake-9"));
    const m2 = msgOf(() => parseConfirmLiveArg("live-fake-9:abc"));
    check(
      "parseConfirmLiveArg: refusals never echo the operator's value (no live slug in output)",
      m1 !== "" && m2 !== "" && !m1.includes("live-fake-9") && !m2.includes("live-fake-9"),
    );
  }

  // The pin itself: nothing above may have printed a fake id or slug — console output is
  // aggregate-only by contract, in --self-test as much as in a real run. Every case name is a
  // fixed, static string, so this should always be true; asserted rather than assumed.
  const FAKE_NEEDLES = ["tenant-excl-1", "tenant-excl-2", "tenant-keep-1", "live-fake-1"];
  const noLeaks = !FAKE_NEEDLES.some((needle) => sa403Lines.some((line) => line.includes(needle)));
  sa403Total += 1;
  if (!noLeaks) sa403Failed += 1;
  sa403Lines.push(`${noLeaks ? "ok  " : "FAIL"} --self-test output never names a fake id or slug`);
  for (const line of sa403Lines) console.log(line);
  failed += sa403Failed;

  console.log(
    failed
      ? `${TAG} self-test: ${failed} FAILED`
      : `${TAG} self-test: all ${cases.length + 1 + sa403Total} passed`,
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
