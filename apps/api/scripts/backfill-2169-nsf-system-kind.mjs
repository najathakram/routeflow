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
// APPLY replays a SAVED plan only (never a live re-query):
//   node apps/api/scripts/backfill-2169-nsf-system-kind.mjs --apply --plan <file> \
//     --confirm-plan <hash> --guard-sha <sha> --i-have-a-fresh-backup [--local] \
//     [--live-tenant-override --confirm "APPLY <n> LINES"]
// Gates, ALL must pass or nothing is written (SA-134 / B294's set):
//   1. --confirm-plan equals the plan file's own sha256;
//   2. --guard-sha is a git ancestor of this checkout's HEAD (the migration that adds the column);
//   3. the DB fingerprint (database, tenant ids) still matches the dry run;
//   4. a LIVE (non-test) tenant needs --live-tenant-override plus the literal type-back phrase;
//   5. --i-have-a-fresh-backup, always;
//   6. every planned LINE is RE-READ: systemKind still NULL, same invoiceId/description/unitPrice/
//      updatedAt; AND every planned PAYMENT is RE-READ: still status VOID + checkStatus BOUNCED,
//      same nsfFeeAmount — any change to either row refuses the WHOLE apply.
// One transaction. Exit: 0 ok · 1 refused (nothing written) · 2 env/connection error.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { roundMoney } from "@routeflow/pricing";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
import { isLocalDbTarget } from "./lib/local-db-target.cjs";
import { requireLocalPgConfig } from "./lib/local-pg-config.mjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

const TAG = "backfill-2169";
const NSF_FEE_DESCRIPTION_PREFIX = "NSF fee — returned check";
// The plain SQL scripts in this directory cannot cheaply value-import @prisma/client's generated
// TypeScript enum (no build step for a raw .mjs invoked with `node`), so this is a hand-copied
// string of the ONE Prisma enum member it writes: `InvoiceItemSystemKind.NSF_FEE` (see
// apps/api/src/invoices/nsf-line.ts, which DOES import the real generated enum). Pinned by
// --self-test below so a schema rename can't silently drift this string.
const NSF_FEE_SYSTEM_KIND = "NSF_FEE";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SELF = resolve(dirname(fileURLToPath(import.meta.url)), "backfill-2169-nsf-system-kind.mjs");

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
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
  const url = local
    ? process.env.DATABASE_URL
    : resolveDatabaseUrl(process.env, { requireProxy: true });
  if (!url) throw new Error("--local requires DATABASE_URL");
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

async function dryRun() {
  const url = await resolveTarget();
  console.log(`${TAG}: target ${redactUrl(url)} DRY-RUN`);
  const client = new pg.Client(dialConfig(url));
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const fp = await fingerprint(client);
    const lines = (await client.query(CANDIDATE_LINES_SQL, [`${NSF_FEE_DESCRIPTION_PREFIX}%`]))
      .rows;
    const payments = lines.length
      ? (await client.query(PAYMENTS_SQL, [lines.map((l) => l.invoiceId)])).rows
      : [];
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

    const plan = { generatedAt: new Date().toISOString(), fingerprint: fp, apply };
    const hash = sha256(plan);
    const dir = resolve(REPO_ROOT, "local-assets/handoff", new Date().toISOString().slice(0, 10));
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `2169-plan-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ ...plan, planHash: hash, review }, null, 2));

    // Aggregate counts PER TENANT ID only — never an invoice id, line id or tenant slug.
    const byTenant = new Map();
    for (const a of apply) {
      const t = byTenant.get(a.tenantId) ?? { stamped: 0, review: 0 };
      t.stamped += 1;
      byTenant.set(a.tenantId, t);
    }
    for (const r of review) {
      const t = byTenant.get(r.tenantId) ?? { stamped: 0, review: 0 };
      t.review += 1;
      byTenant.set(r.tenantId, t);
    }
    console.log(`\n${TAG}: ${lines.length} candidate line(s) scanned`);
    console.log(`  APPLY:  ${apply.length} line(s) total`);
    console.log(
      `  REVIEW: ${review.length} invoice(s) total (listed in the plan file; nothing is written for them)`,
    );
    console.log(`  per tenantId:`);
    for (const [tenantId, counts] of byTenant) {
      console.log(`    ${tenantId}: stamped=${counts.stamped} review=${counts.review}`);
    }
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
  console.log(`${TAG}: target ${redactUrl(url)} APPLY (${plan.apply.length} line(s))`);
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
    const live = tenantIds.filter((id) => !isTestTenant(slugById.get(id)));
    if (live.length > 0) {
      const phrase = `APPLY ${plan.apply.length} LINES`;
      if (!process.argv.includes("--live-tenant-override") || argOf("--confirm") !== phrase) {
        throw refuse(
          `${live.length} LIVE tenant(s) in this plan: pass --live-tenant-override --confirm "${phrase}"`,
        );
      }
    }

    let stamped = 0;
    for (const a of plan.apply) {
      const row = (
        await client.query(
          'SELECT "invoiceId", description, "unitPrice", "updatedAt", "systemKind" FROM "InvoiceItem" WHERE id = $1',
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
      if (lineChanged) throw refuse(`line ${a.lineId} has changed since the dry run`);

      const payment = (
        await client.query(
          'SELECT status, "checkStatus", "nsfFeeAmount" FROM "InvoicePayment" WHERE id = $1',
          [a.paymentId],
        )
      ).rows[0];
      const paymentChanged =
        !payment ||
        payment.status !== a.expected.paymentStatus ||
        payment.checkStatus !== a.expected.paymentCheckStatus ||
        String(payment.nsfFeeAmount) !== a.expected.paymentNsfFeeAmount;
      if (paymentChanged) throw refuse(`payment ${a.paymentId} has changed since the dry run`);

      const res = await client.query(
        'UPDATE "InvoiceItem" SET "systemKind" = $2 WHERE id = $1 AND "systemKind" IS NULL',
        [a.lineId, NSF_FEE_SYSTEM_KIND],
      );
      stamped += res.rowCount;
    }
    await client.query("COMMIT");
    console.log(`${TAG}: committed — ${stamped} line(s) stamped`);
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
  console.log(
    failed
      ? `${TAG} self-test: ${failed} FAILED`
      : `${TAG} self-test: all ${cases.length + 1} passed`,
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
