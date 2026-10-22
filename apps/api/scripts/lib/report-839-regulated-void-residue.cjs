/**
 * SA-839 section 6 (B705 / B706): the pure part of report-839-regulated-void-residue.mjs: the SQL, the
 * per-line classifier (`classifyLine`), the filed-period test, the per-tenant fold and the text/JSON
 * formatting. Kept in CommonJS so the jest spec requires it directly with a mocked client (no database).
 *
 * Everything here READS. The SQL is SELECT / SHOW / SET (session read-only) only, and the report is tenant ids
 * and counts: no slug, name, customer, invoice or credit-note number, amount or row id leaves this module.
 * The tenant `slug` is selected for exactly one purpose, `isTestTenant`, and is dropped on the spot.
 */
"use strict";

const { isTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

/** Every axis the ledger nets on; a line is "standing" when any |sum| exceeds it (regulated-ledger EPS). */
const EPS = 0.0005;

/** Session settings, first thing on the connection (the server then refuses any write). */
const READ_ONLY_SESSION = [
  "SET default_transaction_read_only = on",
  "SET statement_timeout = '120s'",
  "SET lock_timeout = '5s'",
  // a stalled owner shell must never hold the READ ONLY snapshot open indefinitely
  "SET idle_in_transaction_session_timeout = '300s'",
];
const BEGIN_READ_ONLY = "BEGIN TRANSACTION READ ONLY";
const SHOW_READ_ONLY = "SHOW transaction_read_only";
const END_TX = "ROLLBACK";

const CLASS = Object.freeze({
  UNVOID_UNBOOKED: "UNVOID_UNBOOKED",
  VOID_NOTE_ON_LIVE_INVOICE: "VOID_NOTE_ON_LIVE_INVOICE",
  VOID_RESIDUE: "VOID_RESIDUE",
});
const SUB = Object.freeze({
  RETURN_CANCELLED: "RETURN_CANCELLED",
  NOTE_VOIDED: "NOTE_VOIDED",
  AXIS_ONLY: "AXIS_ONLY",
  OTHER: "OTHER",
});
const CLASS_ORDER = [CLASS.UNVOID_UNBOOKED, CLASS.VOID_NOTE_ON_LIVE_INVOICE, CLASS.VOID_RESIDUE];
/** An invoiceId on a ledger row with no Invoice row (the invoice was removed). */
const GONE = "GONE";
const NO_PERIOD = "(no void row)";
const FILED = "filed";
const OPEN = "open";
const NA = "n/a";

// ─── SQL (SELECT only) ───────────────────────────────────────────────────────────────────────────

const TENANT_ROWS = `SELECT t.id AS "tenantId", t.slug AS "slug" FROM "Tenant" t WHERE ($1::text IS NULL OR t.id = $1::text) ORDER BY t.id`;

/**
 * Every ledger row of the candidate lines of one tenant, one row per ledger row, with the invoice status
 * (NULL = no Invoice row) and the invoice line's own qty / category (NULL = no InvoiceItem row).
 * Candidate = the invoice is VOID or gone, or the line carries a void-signature REVERSAL (all three pointers
 * NULL) or a credit-note row. A live line with none of those can be neither class.
 */
const LINE_ROWS = `
  WITH cand AS (
    SELECT DISTINCT x."invoiceItemId"
      FROM "RegulatedSalesLedger" x
     WHERE x."tenantId" = $1
       AND x."invoiceItemId" IS NOT NULL
       AND x."entryType" = 'REVERSAL'
       AND ((x."returnId" IS NULL AND x."creditNoteId" IS NULL AND x."correctsEntryId" IS NULL)
            OR x."creditNoteId" IS NOT NULL)
  )
  SELECT l.id AS "id", l."invoiceId" AS "invoiceId", l."invoiceItemId" AS "invoiceItemId",
         l."orderId" AS "orderId", l."trackedCategoryId" AS "trackedCategoryId",
         l."entryType"::text AS "entryType", l."returnId" AS "returnId", l."creditNoteId" AS "creditNoteId",
         l."correctsEntryId" AS "correctsEntryId",
         l.qty::float8 AS "qty", l."unitBasisQty"::float8 AS "unitBasisQty",
         l."netSales"::float8 AS "netSales", l."categoryTax"::float8 AS "categoryTax",
         l."soldAt" AS "soldAt", l."createdAt" AS "createdAt", l."periodBucket" AS "periodBucket",
         i.status::text AS "invoiceStatus",
         it.qty::float8 AS "lineQty", it."trackedCategoryId" AS "lineTrackedCategoryId"
    FROM "RegulatedSalesLedger" l
    LEFT JOIN "Invoice" i ON i.id = l."invoiceId"
    LEFT JOIN "InvoiceItem" it ON it.id = l."invoiceItemId"
   WHERE l."tenantId" = $1
     AND l."invoiceItemId" IS NOT NULL
     AND l."invoiceId" IS NOT NULL
     AND (i.id IS NULL OR i.status = 'VOID' OR l."invoiceItemId" IN (SELECT "invoiceItemId" FROM cand))
   ORDER BY l."invoiceItemId", l."createdAt", l.id`;

/** Status of the Return / CreditNote documents the candidate rows point at (ids are unique across both tables). */
const DOC_STATUS = `
  SELECT r.id AS "docId", r.status::text AS "status" FROM "Return" r WHERE r.id = ANY($1::text[])
  UNION ALL
  SELECT c.id AS "docId", c.status::text AS "status" FROM "CreditNote" c WHERE c.id = ANY($1::text[])`;

/** CANCELLED returns on any order the tenant's ledger rows sit on (the return's own order, or an INLINE source order). */
const CANCELLED_RETURNS = `
  SELECT r.id AS "returnId", r."orderId" AS "orderId",
         COALESCE(array_agg(DISTINCT ri."sourceOrderId") FILTER (WHERE ri."sourceOrderId" IS NOT NULL), '{}') AS "sourceOrderIds"
    FROM "Return" r
    LEFT JOIN "ReturnItem" ri ON ri."returnId" = r.id
   WHERE r.status = 'CANCELLED'
     AND (r."orderId" IN (SELECT l."orderId" FROM "RegulatedSalesLedger" l WHERE l."tenantId" = $1 AND l."orderId" IS NOT NULL)
          OR ri."sourceOrderId" IN (SELECT l."orderId" FROM "RegulatedSalesLedger" l WHERE l."tenantId" = $1 AND l."orderId" IS NOT NULL))
   GROUP BY r.id`;

/** VOID credit notes naming an invoice the tenant's ledger rows sit on. */
const VOID_NOTES = `
  SELECT c.id AS "creditNoteId", c."invoiceId" AS "invoiceId"
    FROM "CreditNote" c
   WHERE c.status = 'VOID'
     AND c."invoiceId" IN (SELECT l."invoiceId" FROM "RegulatedSalesLedger" l WHERE l."tenantId" = $1 AND l."invoiceId" IS NOT NULL)`;

/** GENERATED / LOCKED filings of the tenant: the `findFiledPeriod` predicate (regulated-ledger.service). */
const FILED_FILINGS = `
  SELECT f."trackedCategoryId" AS "trackedCategoryId", f."periodStart" AS "periodStart", f."periodEnd" AS "periodEnd"
    FROM "RegulatedFiling" f
   WHERE f."tenantId" = $1 AND f.status IN ('GENERATED', 'LOCKED')`;

const DOC_CHUNK = 1000;

// ─── pure classification ─────────────────────────────────────────────────────────────────────────

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const when = (v) => (v == null ? 0 : new Date(v).getTime());

/** The row a void / zeroing writes: a REVERSAL with no return, credit note or correction pointer. */
function isVoidSignature(r) {
  return (
    r.entryType === "REVERSAL" &&
    r.returnId == null &&
    r.creditNoteId == null &&
    r.correctsEntryId == null
  );
}

/** Oldest first. Rows of one transaction share `createdAt`, and a re-book writes its REVERSAL before its SALE. */
function chrono(a, b) {
  return (
    when(a.createdAt ?? a.soldAt) - when(b.createdAt ?? b.soldAt) ||
    (a.entryType === "SALE" ? 1 : 0) - (b.entryType === "SALE" ? 1 : 0) ||
    when(a.soldAt) - when(b.soldAt) ||
    String(a.id ?? "").localeCompare(String(b.id ?? ""))
  );
}

function sums(rows) {
  const s = { qty: 0, unitBasisQty: 0, netSales: 0, categoryTax: 0 };
  for (const r of rows) {
    s.qty += num(r.qty);
    s.unitBasisQty += num(r.unitBasisQty);
    s.netSales += num(r.netSales);
    s.categoryTax += num(r.categoryTax);
  }
  return s;
}
const standing = (s) =>
  Math.abs(s.qty) > EPS ||
  Math.abs(s.unitBasisQty) > EPS ||
  Math.abs(s.netSales) > EPS ||
  Math.abs(s.categoryTax) > EPS;

/** `docStatusById` as a Map or a plain object -> [id, status] pairs. */
function docEntries(docStatusById) {
  if (!docStatusById) return [];
  return docStatusById instanceof Map ? [...docStatusById] : Object.entries(docStatusById);
}

/**
 * Classify ONE invoice line (all of its ledger rows) against SA-839 section 6. Returns a list of findings
 * (empty = the line is clean):
 *   { cls: UNVOID_UNBOOKED, bucket }
 *   { cls: VOID_NOTE_ON_LIVE_INVOICE, noteId, bucket }        one per VOID note whose rows still stand
 *   { cls: VOID_RESIDUE, sub, bucket }                        sub: RETURN_CANCELLED | NOTE_VOIDED | AXIS_ONLY | OTHER
 * `bucket` is the period of the line's newest void-signature REVERSAL (null when there is none).
 *
 * @param rows            the line's ledger rows: { id, entryType, returnId, creditNoteId, correctsEntryId, qty,
 *                        unitBasisQty, netSales, categoryTax, periodBucket, createdAt, soldAt }
 * @param invoiceStatus   the invoice's status, or null / "GONE" when there is no Invoice row
 * @param docStatusById   id -> status of the Return / CreditNote documents that bear on the line: those its rows
 *                        point at, the CANCELLED returns on its order, the VOID notes naming its invoice
 * @param line            { qty, trackedCategoryId } of the InvoiceItem (absent when the item is gone)
 */
function classifyLine(rows, invoiceStatus, docStatusById, line = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const ordered = [...rows].sort(chrono);
  const status = invoiceStatus == null ? GONE : invoiceStatus;
  const live = status !== "VOID" && status !== GONE;
  const docs = docEntries(docStatusById);
  const statusOf = (id) => docs.find(([k]) => k === id)?.[1];
  const total = sums(ordered);

  const voidRows = ordered.filter(isVoidSignature);
  const bucket = voidRows.length ? (voidRows[voidRows.length - 1].periodBucket ?? null) : null;
  const findings = [];

  if (live) {
    // UNVOID_UNBOOKED (B706): the last thing the ledger saw on this line was a void, yet the invoice is live
    // and its sale-record no longer covers the line.
    const newest = ordered[ordered.length - 1];
    if (line.trackedCategoryId && Number.isFinite(Number(line.qty)) && isVoidSignature(newest)) {
      const saleRecordQty = sums(
        ordered.filter((r) => r.returnId == null && r.creditNoteId == null),
      ).qty;
      if (saleRecordQty < Number(line.qty) - EPS)
        findings.push({ cls: CLASS.UNVOID_UNBOOKED, bucket });
    }
    // VOID_NOTE_ON_LIVE_INVOICE (B706 example C): a VOID note's REVERSAL rows still stand on a live invoice.
    const noteIds = [
      ...new Set(
        ordered
          .filter((r) => r.entryType === "REVERSAL" && r.creditNoteId != null)
          .map((r) => r.creditNoteId),
      ),
    ];
    for (const noteId of noteIds) {
      if (statusOf(noteId) !== "VOID") continue;
      const own = ordered.filter((r) => r.entryType === "REVERSAL" && r.creditNoteId === noteId);
      if (standing(sums(own)))
        findings.push({ cls: CLASS.VOID_NOTE_ON_LIVE_INVOICE, noteId, bucket });
    }
    return findings;
  }

  // VOID_RESIDUE (B705): the invoice is VOID or gone, and the line still nets to something.
  if (standing(total)) {
    const moneyZero = Math.abs(total.netSales) <= EPS && Math.abs(total.categoryTax) <= EPS;
    const statuses = docs.map(([, s]) => s);
    // Precedence is deliberate: AXIS_ONLY (money exactly 0, pieces standing) is the strictest signature and no
    // removed return or note row with money could leave it, so it wins over the loose order-level evidence of a
    // CANCELLED return (RETURN_CANCELLED) or a VOID note (NOTE_VOIDED); RETURN_CANCELLED wins over NOTE_VOIDED.
    let sub;
    if (moneyZero && Math.abs(total.unitBasisQty) > EPS) sub = SUB.AXIS_ONLY;
    else if (statuses.includes("CANCELLED")) sub = SUB.RETURN_CANCELLED;
    else if (statuses.includes("VOID")) sub = SUB.NOTE_VOIDED;
    else sub = SUB.OTHER;
    findings.push({ cls: CLASS.VOID_RESIDUE, sub, bucket });
  }
  return findings;
}

/** The "YYYY-MM" bucket falls inside a GENERATED / LOCKED filing of the line's category. */
function isFiled(filings, trackedCategoryId, bucket) {
  const m = /^(\d{4})-(\d{2})$/.exec(bucket ?? "");
  if (!m || !trackedCategoryId) return false;
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
  return filings.some(
    (f) =>
      f.trackedCategoryId === trackedCategoryId &&
      when(f.periodStart) <= start &&
      when(f.periodEnd) > start,
  );
}

// ─── per-tenant fold ─────────────────────────────────────────────────────────────────────────────

/** Accumulator for one tenant: key (class, sub, period, filed) -> { invoices, lines, notes } id sets (never printed). */
function newFold() {
  return new Map();
}
function foldFindings(fold, { invoiceId, findings, filedFor }) {
  for (const f of findings) {
    const period = f.bucket ?? NO_PERIOD;
    const filed = f.bucket ? (filedFor(f.bucket) ? FILED : OPEN) : NA;
    const key = [f.cls, f.sub ?? "", period, filed].join("|");
    const e = fold.get(key) ?? { invoices: new Set(), lines: 0, notes: new Set() };
    e.invoices.add(invoiceId);
    e.lines += 1;
    if (f.noteId) e.notes.add(f.noteId);
    fold.set(key, e);
  }
}
/** Fold -> sorted plain rows of counts only. */
function foldRows(fold) {
  const rows = [...fold].map(([key, e]) => {
    const [cls, sub, period, filed] = key.split("|");
    return {
      class: cls,
      subclass: sub || null,
      period,
      filed,
      invoices: e.invoices.size,
      lines: e.lines,
      notes: e.notes.size,
    };
  });
  return rows.sort(
    (a, b) =>
      CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class) ||
      String(a.subclass).localeCompare(String(b.subclass)) ||
      a.period.localeCompare(b.period) ||
      a.filed.localeCompare(b.filed),
  );
}

// ─── DB passes (read-only) ───────────────────────────────────────────────────────────────────────

/**
 * Run the session settings, open a READ ONLY transaction, prove it is read-only, run `fn`, and always end
 * with ROLLBACK (nothing to keep).
 */
async function withReadOnlyTx(client, fn) {
  for (const sql of READ_ONLY_SESSION) await client.query(sql);
  await client.query(BEGIN_READ_ONLY);
  try {
    const ro = await client.query(SHOW_READ_ONLY);
    const flag = ro.rows?.[0]?.transaction_read_only;
    if (flag !== "on")
      throw new Error(`aborting: transaction_read_only is "${flag}", expected "on"`);
    return await fn();
  } finally {
    await client.query(END_TX);
  }
}

async function docStatuses(client, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += DOC_CHUNK) {
    const chunk = ids.slice(i, i + DOC_CHUNK);
    for (const r of (await client.query(DOC_STATUS, [chunk])).rows) out.set(r.docId, r.status);
  }
  return out;
}

/** One tenant: its candidate lines classified, folded to counts. Inside the caller's READ ONLY transaction. */
async function scanTenant(client, tenantId) {
  const rows = (await client.query(LINE_ROWS, [tenantId])).rows;
  const fold = newFold();
  if (rows.length === 0) return { rows: [], lines: 0 };

  const referenced = [
    ...new Set(rows.flatMap((r) => [r.returnId, r.creditNoteId]).filter((x) => x != null)),
  ];
  const statusById = await docStatuses(client, referenced);

  // CANCELLED returns by the order they touch; VOID notes by the invoice they name.
  const cancelledByOrder = new Map();
  for (const r of (await client.query(CANCELLED_RETURNS, [tenantId])).rows)
    for (const orderId of [r.orderId, ...(r.sourceOrderIds ?? [])]) {
      if (!cancelledByOrder.has(orderId)) cancelledByOrder.set(orderId, new Set());
      cancelledByOrder.get(orderId).add(r.returnId);
    }
  const voidNotesByInvoice = new Map();
  for (const r of (await client.query(VOID_NOTES, [tenantId])).rows) {
    if (!voidNotesByInvoice.has(r.invoiceId)) voidNotesByInvoice.set(r.invoiceId, new Set());
    voidNotesByInvoice.get(r.invoiceId).add(r.creditNoteId);
  }
  const filings = (await client.query(FILED_FILINGS, [tenantId])).rows;

  const byLine = new Map();
  for (const r of rows) {
    if (!byLine.has(r.invoiceItemId)) byLine.set(r.invoiceItemId, []);
    byLine.get(r.invoiceItemId).push(r);
  }
  for (const lineRows of byLine.values()) {
    const first = lineRows[0];
    const docs = new Map();
    for (const r of lineRows) {
      for (const id of [r.returnId, r.creditNoteId])
        if (id != null && statusById.has(id)) docs.set(id, statusById.get(id));
      for (const id of cancelledByOrder.get(r.orderId) ?? []) docs.set(id, "CANCELLED");
    }
    for (const id of voidNotesByInvoice.get(first.invoiceId) ?? []) docs.set(id, "VOID");
    const categoryId =
      lineRows.find((r) => r.entryType === "SALE")?.trackedCategoryId ?? first.trackedCategoryId;
    const findings = classifyLine(lineRows, first.invoiceStatus, docs, {
      qty: first.lineQty,
      trackedCategoryId: first.lineTrackedCategoryId,
    });
    foldFindings(fold, {
      invoiceId: first.invoiceId,
      findings,
      filedFor: (bucket) => isFiled(filings, categoryId, bucket),
    });
  }
  return { rows: foldRows(fold), lines: byLine.size };
}

/**
 * The report for every tenant (or `onlyTenant`). `protectedIds` is the Set of protected tenant ids (the caller
 * gets it from the live-target guard); `isTest(slug)` marks approved test tenants. Must run inside
 * `withReadOnlyTx`. Returns tenant ids, flags and counts only.
 */
async function buildReport(
  client,
  { protectedIds, onlyTenant = null, isTest = isTestTenant } = {},
) {
  const tenants = (await client.query(TENANT_ROWS, [onlyTenant])).rows;
  const out = [];
  let scannedLines = 0;
  for (const t of tenants) {
    const scan = await scanTenant(client, t.tenantId);
    scannedLines += scan.lines;
    if (scan.rows.length === 0) continue;
    out.push({
      tenantId: t.tenantId,
      protected: protectedIds.has(t.tenantId),
      test: isTest(t.slug) === true,
      findings: scan.rows,
    });
  }
  return { tenantsScanned: tenants.length, candidateLines: scannedLines, tenants: out };
}

// ─── formatting ──────────────────────────────────────────────────────────────────────────────────

function totalsOf(report) {
  const byClass = {};
  for (const c of CLASS_ORDER) byClass[c] = { tenants: 0, invoices: 0, lines: 0, notes: 0 };
  for (const t of report.tenants) {
    for (const c of CLASS_ORDER) {
      const rows = t.findings.filter((f) => f.class === c);
      if (rows.length === 0) continue;
      byClass[c].tenants += 1;
      for (const r of rows) {
        byClass[c].invoices += r.invoices;
        byClass[c].lines += r.lines;
        byClass[c].notes += r.notes;
      }
    }
  }
  return byClass;
}

function jsonReport(report, { generatedAt, scope }) {
  return {
    generatedAt,
    scope,
    tenantsScanned: report.tenantsScanned,
    candidateLines: report.candidateLines,
    tenantsWithFindings: report.tenants.length,
    totals: totalsOf(report),
    tenants: report.tenants,
  };
}

/** Plain-text report: one block per tenant id with findings, then totals. Counts and ids only. */
function formatReport(report, { generatedAt, scope }) {
  const lines = [
    "=== SA-839 REGULATED VOID RESIDUE: read-only, tenant ids + counts only ===",
    `generated ${generatedAt} · scope ${scope} · ${report.tenantsScanned} tenant(s) scanned · ${report.candidateLines} candidate line(s) · ${report.tenants.length} with findings`,
    "invoices and lines are counted per (class, sub-class, period, filed); notes only for VOID_NOTE_ON_LIVE_INVOICE.",
    "period = the bucket of the line's newest void-signature REVERSAL; filed = a GENERATED/LOCKED filing of the line's category covers it.",
    "",
  ];
  if (report.tenants.length === 0) lines.push("(no tenant has any finding)");
  for (const t of report.tenants) {
    const flags = [t.protected ? "PROTECTED" : null, t.test ? "TEST" : null].filter(Boolean);
    lines.push(`tenant ${t.tenantId}${flags.length ? ` [${flags.join(" ")}]` : ""}`);
    for (const f of t.findings) {
      const name = f.subclass ? `${f.class}/${f.subclass}` : f.class;
      const counts =
        f.class === CLASS.VOID_NOTE_ON_LIVE_INVOICE
          ? `notes ${f.notes}, invoices ${f.invoices}`
          : `invoices ${f.invoices}, lines ${f.lines}`;
      lines.push(`  ${name}  period ${f.period}  ${f.filed}  ${counts}`);
    }
  }
  lines.push("", "TOTALS (all tenants, protected and test included)");
  const totals = totalsOf(report);
  for (const c of CLASS_ORDER) {
    const x = totals[c];
    lines.push(
      c === CLASS.VOID_NOTE_ON_LIVE_INVOICE
        ? `  ${c}  tenants ${x.tenants}, notes ${x.notes}, invoices ${x.invoices}`
        : `  ${c}  tenants ${x.tenants}, invoices ${x.invoices}, lines ${x.lines}`,
    );
  }
  return lines.join("\n");
}

/** Arguments: `--json`, `--tenant ID`, `--self-test`. Write-shaped flags are refused (exit 2) by the caller. */
const WRITE_FLAGS = ["--apply", "--fix", "--repair"];
const TENANT_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
function checkArgs(argv) {
  const hit = WRITE_FLAGS.find((f) => argv.includes(f));
  if (hit)
    return {
      ok: false,
      message: `refusing ${hit}: this report is read-only and has no write mode (repair is the owner's decision, SA-839 G10 Q2)`,
    };
  const known = new Set(["--json", "--tenant", "--self-test"]);
  const hostFlag = argv.filter((a) => a.startsWith("--target-host="));
  if (hostFlag.length > 1) return { ok: false, message: "--target-host given more than once" };
  const tenantAt = argv.indexOf("--tenant");
  for (const [i, a] of argv.entries()) {
    if (a.startsWith("--target-host=")) continue;
    if (a.startsWith("--") ? !known.has(a) : argv[i - 1] !== "--tenant")
      return { ok: false, message: `unexpected argument ${a}` };
  }
  const tenant = tenantAt >= 0 ? argv[tenantAt + 1] : null;
  if (tenantAt >= 0 && (!tenant || !TENANT_ID_SHAPE.test(tenant)))
    return { ok: false, message: "--tenant needs a tenant id" };
  return {
    ok: true,
    json: argv.includes("--json"),
    selfTest: argv.includes("--self-test"),
    tenant,
    targetHost: hostFlag.length ? hostFlag[0].slice("--target-host=".length) : null,
  };
}

/** Host and database name of a postgres URL, for the type-back guard. Never the credentials. */
function targetOf(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "(default)",
  };
}

/**
 * The live-target guard (#3578 pattern): the owner runs once to see the host, then names it with
 * `--target-host=<host>`. Exit 64 when the flag is missing or empty, 65 when it does not equal the host the URL
 * resolves to. Pure; the caller prints the target and refuses BEFORE connecting.
 */
function guardTarget(targetHost, target) {
  if (!targetHost)
    return {
      ok: false,
      code: 64,
      message: "refusing: --target-host=<host> is required (run once without it to see the host)",
    };
  if (targetHost !== target.host)
    return {
      ok: false,
      code: 65,
      message: `refusing: --target-host=${targetHost} does not match the resolved host ${target.host}`,
    };
  return { ok: true };
}

module.exports = {
  EPS,
  READ_ONLY_SESSION,
  BEGIN_READ_ONLY,
  SHOW_READ_ONLY,
  END_TX,
  CLASS,
  SUB,
  CLASS_ORDER,
  GONE,
  NO_PERIOD,
  TENANT_ROWS,
  LINE_ROWS,
  DOC_STATUS,
  CANCELLED_RETURNS,
  VOID_NOTES,
  FILED_FILINGS,
  WRITE_FLAGS,
  isVoidSignature,
  classifyLine,
  isFiled,
  foldFindings,
  foldRows,
  newFold,
  withReadOnlyTx,
  scanTenant,
  buildReport,
  totalsOf,
  jsonReport,
  formatReport,
  checkArgs,
  targetOf,
  guardTarget,
};
