/**
 * SA-1088 (SA-790 §1, SA-968 §3): the corrected-units sheet -- the pure part and the SQL of
 * report-corrected-units-sheet.mjs. READ ONLY: every statement here is SELECT / SHOW / SET (session read-only),
 * the transaction ends in ROLLBACK, and nothing is written to the database.
 *
 * For one tenant it lists, per filed period, every ledger line on the box axis with the "Unit Basis Qty" the
 * ledger carries now, the corrected figure per the B681 classifier (`computeLineCorrection`, on master's axis
 * rule), and the difference -- beside the period's FILED snapshot, never over it.
 */
import { createRequire } from "node:module";
import { computeLineCorrection } from "@routeflow/pricing";
import {
  BOX_UNAWARE_ROWS_SQL,
  assertRequiredColumns,
  buildLineContexts,
  rowEvidence,
} from "./b681-ledger-query.mjs";

const require = createRequire(import.meta.url);
const { isTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

export const NAME = "report-corrected-units-sheet";
export const REFERENCE_NOTE = "Reference only. The ledger and the filed forms are unchanged.";
/** The SA-790 census: 49 lines on the box axis. Any other count is printed loudly (design §3). */
export const EXPECTED_LINE_COUNT = 49;
export const WRITE_FLAGS = ["--apply", "--fix", "--repair"];
const EPS = 0.0005;
const ms = (v) => (v == null ? 0 : new Date(v).getTime());
const round3 = (n) => Math.round(n * 1000) / 1000;
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// --- the read-only transaction (same shape as report-839-regulated-void-residue) -----------------
export const READ_ONLY_SESSION = [
  "SET default_transaction_read_only = on",
  "SET statement_timeout = '120s'",
  "SET lock_timeout = '5s'",
  "SET idle_in_transaction_session_timeout = '300s'",
];
export const BEGIN_READ_ONLY = "BEGIN TRANSACTION READ ONLY";
export const SHOW_READ_ONLY = "SHOW transaction_read_only";
export const END_TX = "ROLLBACK";

export async function withReadOnlyTx(client, fn) {
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

// --- SQL (SELECT only) ----------------------------------------------------------------------------
export const TENANT_BY_SLUG_SQL = `SELECT id, slug FROM "Tenant" WHERE slug = $1`;

/** Every ledger row of the tenant, summed per (category, period): the live figure the filing snapshot is held to. */
export const PERIOD_SUMS_SQL = `
  SELECT "trackedCategoryId", "periodBucket", COUNT(*)::int AS row_count,
         COALESCE(SUM("unitBasisQty"), 0) AS unit_basis_sum
  FROM "RegulatedSalesLedger" WHERE "tenantId" = $1
  GROUP BY "trackedCategoryId", "periodBucket"
`;

/** Every filing of the tenant (instants read as UTC: the columns are timestamp-without-zone holding UTC; FAILED included, so it is listed; it is never the one compared with). */
export const FILINGS_SQL = `
  SELECT id, "trackedCategoryId", "periodKey", status, rows,
         ("periodStart" AT TIME ZONE 'UTC') AS "periodStart", ("periodEnd" AT TIME ZONE 'UTC') AS "periodEnd",
         ("generatedAt" AT TIME ZONE 'UTC') AS "generatedAt", ("lockedAt" AT TIME ZONE 'UTC') AS "lockedAt"
  FROM "RegulatedFiling" WHERE "tenantId" = $1
`;

/** Document number + the line's ordinal among its document's lines (by id; the tables hold no position column)
 *  and the product code, for the given line keys (an InvoiceItem id or an OrderItem id). */
export const LINE_REFS_SQL = `
  SELECT x.line_key, x.doc_kind, x.doc_no, x.ordinal, x.sku FROM (
    SELECT ii.id AS line_key, 'invoice' AS doc_kind, i."invoiceNumber" AS doc_no,
           ROW_NUMBER() OVER (PARTITION BY ii."invoiceId" ORDER BY ii.id)::int AS ordinal, p.sku AS sku
    FROM "InvoiceItem" ii
    JOIN "Invoice" i ON i.id = ii."invoiceId"
    LEFT JOIN "Product" p ON p.id = ii."productId"
    WHERE i."tenantId" = $1
    UNION ALL
    SELECT oi.id, 'order', o."orderNumber",
           ROW_NUMBER() OVER (PARTITION BY oi."orderId" ORDER BY oi.id)::int, p.sku
    FROM "OrderItem" oi
    JOIN "Order" o ON o.id = oi."orderId"
    LEFT JOIN "Product" p ON p.id = oi."productId"
    WHERE o."tenantId" = $1
  ) x WHERE x.line_key = ANY($2::text[])
`;

// --- arguments and guards ---------------------------------------------------------------------------
const KNOWN_FLAGS = new Set(["--self-test", "--live-tenant-override"]);
const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function checkArgs(argv) {
  const hit = WRITE_FLAGS.find((f) => argv.includes(f));
  if (hit) {
    return {
      ok: false,
      message: `refusing ${hit}: this sheet is read-only and has no write mode (the ledger and the filed forms do not change)`,
    };
  }
  const out = {
    ok: true,
    selfTest: false,
    liveOverride: false,
    tenant: null,
    targetHost: null,
    out: null,
  };
  const hostFlags = argv.filter((a) => a.startsWith("--target-host="));
  if (hostFlags.length > 1) return { ok: false, message: "--target-host given more than once" };
  if (hostFlags.length === 1) out.targetHost = hostFlags[0].slice("--target-host=".length);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--target-host=")) continue;
    if (a === "--tenant" || a === "--out") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) return { ok: false, message: `${a} needs a value` };
      if (a === "--tenant") out.tenant = v;
      else out.out = v;
      i++;
      continue;
    }
    if (!KNOWN_FLAGS.has(a)) return { ok: false, message: `unexpected argument ${a}` };
    if (a === "--self-test") out.selfTest = true;
    if (a === "--live-tenant-override") out.liveOverride = true;
  }
  if (!out.selfTest) {
    if (!out.tenant)
      return { ok: false, message: "--tenant <slug> is required (one tenant per run)" };
    if (!SLUG_SHAPE.test(out.tenant)) return { ok: false, message: "--tenant needs a tenant slug" };
  }
  return out;
}

export function targetOf(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "(default)",
  };
}

/** The live-target guard: exit 64 when --target-host is missing, 65 when it does not match the resolved host. */
export function guardTarget(targetHost, target) {
  if (!targetHost) {
    return {
      ok: false,
      code: 64,
      message: "refusing: --target-host=<host> is required (run once without it to see the host)",
    };
  }
  if (targetHost !== target.host) {
    return {
      ok: false,
      code: 65,
      message: `refusing: --target-host=${targetHost} does not match the resolved host ${target.host}`,
    };
  }
  return { ok: true };
}

/** One tenant per run: an approved test slug passes; any other slug needs --live-tenant-override. */
export function guardTenant(slug, liveOverride) {
  if (isTestTenant(slug)) return { ok: true, live: false };
  if (liveOverride) return { ok: true, live: true };
  return {
    ok: false,
    message: `refusing: "${slug}" is not an approved test tenant; a live tenant needs --live-tenant-override (read-only, with the exact command approved by the owner)`,
  };
}

/** A filing holds one snapshot row per (category, bucket); null when it has none (a TX report filing stores a report). */
export function snapshotRowOf(filing, categoryId, bucket) {
  const rows = filing.rows;
  if (!Array.isArray(rows)) return null; // a TX Comptroller filing stores a report, not per-bucket rows
  const hit = rows.filter(
    (r) => r && r.trackedCategoryId === categoryId && r.periodBucket === bucket,
  );
  return hit.length === 1 ? hit[0] : null;
}

/** Does the filing's half-open [periodStart, periodEnd) window hold the "YYYY-MM" bucket's first instant? */
export function covers(filing, bucket) {
  const m = /^(\d{4})-(\d{2})$/.exec(bucket);
  if (!m) return false;
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
  return ms(filing.periodStart) <= at && at < ms(filing.periodEnd);
}

const newestFirst = (a, b) => b.at - a.at;

/** The filing a period is compared with: the newest LOCKED, else the newest GENERATED (FAILED never). */
export function pickFiling(filings) {
  const locked = filings
    .filter((f) => f.status === "LOCKED")
    .map((f) => ({ f, at: ms(f.lockedAt ?? f.generatedAt) }));
  if (locked.length) return locked.sort(newestFirst)[0].f;
  const generated = filings
    .filter((f) => f.status === "GENERATED")
    .map((f) => ({ f, at: ms(f.generatedAt) }));
  return generated.length ? generated.sort(newestFirst)[0].f : null;
}

// --- classification --------------------------------------------------------------------------------
const NEW_SHAPE_REASON =
  "the line carries correction or counter-entry rows (written after the classifier's base); not classified, never guessed";

const NO_SALE_REASON =
  "the line has reversal rows but no sale row (no base to correct against); not classified, never guessed";
const UNPROVEN_REASON = (why) =>
  `a return-driven reversal on this line could not be proven (${why}); the classifier would correct the sale in pieces beside a reversal still in boxes, so no corrected figure is printed. Nothing is parked or changed by this sheet`;

/** One line entry (from buildLineContexts) -> its classification and per-row deltas. */
export function classifyEntry(entry, contexts) {
  const withCorrectionRows = entry.rows.some((r) => r.correctsEntryId != null);
  if (withCorrectionRows) {
    return {
      category: "unknown-basis",
      reason: NEW_SHAPE_REASON,
      packFactor: null,
      corrections: [],
      newShape: true,
      packSource: "",
    };
  }
  if (!entry.rows.some((r) => r.entryType === "SALE")) {
    return {
      category: "unknown-basis",
      reason: NO_SALE_REASON,
      packFactor: null,
      corrections: [],
      newShape: false,
      packSource: "",
    };
  }
  const rows = entry.rows.map((r) => ({
    id: r.id,
    entryType: r.entryType,
    qty: r.qty,
    unitBasisQty: r.unitBasisQty,
    netSales: r.netSales,
    categoryTax: r.categoryTax,
    writtenAt: r.writtenAt ?? null,
    returnEvidence: rowEvidence(entry, r, contexts).returnEvidence,
  }));
  const sourceLine = rows.length ? rowEvidence(entry, entry.rows[0], contexts).sourceLine : null;
  const priors = entry.rows.flatMap((r) => contexts.priorByCorrectedRow.get(r.id) ?? []);
  const res = computeLineCorrection(rows, entry.line, sourceLine, entry.productPackNow, priors);
  // HOLD 1 (#4140 reviews): the classifier corrects the SALE and leaves a reversal it cannot trust uncorrected,
  // because the apply path then parked a row to hold the filing. A read-only sheet has no such row, so the line
  // is listed unguessed and counted as uncorrected instead of printing a figure that mixes pieces and boxes.
  if ((res.parkedReversals?.length ?? 0) > 0) {
    const why = res.parkedReversals?.[0]?.reason ?? res.reason;
    return {
      category: "unproven-return",
      reason: UNPROVEN_REASON(String(why).replace(/^B681: /, "")),
      packFactor: null,
      corrections: [],
      newShape: false,
      packSource: "",
    };
  }
  const snap = Number(entry.line?.unitsPerBox);
  const packSource =
    res.packFactor == null
      ? ""
      : snap > 1
        ? "line snapshot"
        : "derived (sibling line or product now)";
  return {
    category: res.category,
    reason: res.reason,
    packFactor: res.packFactor,
    corrections: res.corrections,
    newShape: false,
    packSource,
  };
}

const CORRECTED = new Set(["A", "A-piece-reversal"]);

/**
 * Pure assembly. `contexts` is buildLineContexts' output; `refs` maps lineKey -> {docKind, docNo, ordinal, sku};
 * `filings` and `periodSums` are the tenant's rows. Returns the line rows, the period footers and the summary.
 */
export function assembleSheet({ contexts, refs, filings, periodSums }) {
  const lineRows = [];
  const categories = {};
  let listedLines = 0;
  let newShapeLines = 0;

  for (const entry of contexts.lines.values()) {
    const cls = classifyEntry(entry, contexts);
    if (cls.category === "clean") continue;
    listedLines++;
    categories[cls.category] = (categories[cls.category] ?? 0) + 1;
    if (cls.newShape) newShapeLines++;
    const deltaOf = new Map(cls.corrections.map((c) => [c.rowId, c]));
    const ref = refs.get(entry.lineKey) ?? {};
    const byBucket = new Map();
    for (const r of entry.rows) {
      const b = byBucket.get(r.periodBucket) ?? {
        ledger: 0,
        net: 0,
        tax: 0,
        delta: 0,
        netDelta: 0,
        taxDelta: 0,
      };
      b.ledger += num(r.unitBasisQty);
      b.net += num(r.netSales);
      b.tax += num(r.categoryTax);
      const c = deltaOf.get(r.id);
      if (c) {
        b.delta += c.unitBasisDelta;
        b.netDelta += c.netDelta;
        b.taxDelta += c.taxDelta;
      }
      byBucket.set(r.periodBucket, b);
    }
    const correctable = CORRECTED.has(cls.category) && cls.packFactor != null;
    for (const [bucket, b] of [...byBucket.entries()].sort()) {
      lineRows.push({
        period: bucket,
        categoryId: entry.trackedCategoryId,
        lineKey: entry.lineKey,
        lineRef: ref.docNo
          ? `${ref.docKind === "order" ? "order" : "invoice"} ${ref.docNo} line ${ref.ordinal}`
          : "(document not found)",
        product: ref.sku ?? "",
        category: cls.category,
        packFactor: cls.packFactor,
        packSource: cls.packSource,
        ledgerUnitBasis: round3(b.ledger),
        correctedUnitBasis: correctable ? round3(b.ledger + b.delta) : null,
        delta: correctable ? round3(b.delta) : null,
        netSales: round3(b.net),
        categoryTax: round3(b.tax),
        netDelta: correctable ? round3(b.netDelta) : 0,
        taxDelta: correctable ? round3(b.taxDelta) : 0,
        reason: correctable ? (cls.category === "A" ? "" : cls.reason) : cls.reason,
      });
    }
  }

  const periods = periodFooters({ lineRows, filings, periodSums });
  return {
    lineRows,
    periods,
    summary: {
      listedLines,
      categories,
      newShapeLines,
      expected: EXPECTED_LINE_COUNT,
      countMismatch: listedLines !== EXPECTED_LINE_COUNT,
      moneyDeltaRows: lineRows.filter(
        (r) => Math.abs(r.netDelta) >= EPS || Math.abs(r.taxDelta) >= EPS,
      ).length,
      exitCode: periods.some(
        (p) => p.status === "LEDGER MOVED SINCE FILING" || p.status === "NO SNAPSHOT ROW",
      )
        ? 1
        : 0,
    },
  };
}

function periodFooters({ lineRows, filings, periodSums }) {
  const keys = new Map();
  for (const r of lineRows)
    keys.set(`${r.categoryId}|${r.period}`, { categoryId: r.categoryId, period: r.period });
  const sums = new Map(periodSums.map((s) => [`${s.trackedCategoryId}|${s.periodBucket}`, s]));
  const out = [];
  for (const [key, { categoryId, period }] of [...keys.entries()].sort()) {
    const rowsHere = lineRows.filter((r) => r.categoryId === categoryId && r.period === period);
    const lineDeltaSum = round3(rowsHere.reduce((s, r) => s + (r.delta ?? 0), 0));
    const uncorrected = rowsHere.filter((r) => r.delta === null).length;
    const live = round3(num(sums.get(key)?.unit_basis_sum));
    // every LOCKED / GENERATED filing whose window covers this month, newest first, so a second filing is listed
    const covering = filings
      .filter(
        (f) => f.trackedCategoryId === categoryId && f.status !== "FAILED" && covers(f, period),
      )
      .sort((x, y) => ms(y.lockedAt ?? y.generatedAt) - ms(x.lockedAt ?? x.generatedAt));
    const snap = (f) => snapshotRowOf(f, categoryId, period);
    const listed = covering.map((f) => ({
      status: f.status,
      periodKey: f.periodKey,
      generatedAt: f.generatedAt,
      lockedAt: f.lockedAt ?? null,
      snapshotUnitBasisQty: snap(f) ? round3(num(snap(f).unitBasisQty)) : null,
    }));
    const chosen = pickFiling(covering);
    const base = {
      categoryId,
      period,
      filings: listed,
      liveLedgerSum: live,
      lineDeltaSum,
      uncorrectedLines: uncorrected,
    };
    if (!chosen) {
      out.push({
        ...base,
        status: "NOT FILED",
        comparedWith: null,
        snapshotUnitBasisQty: null,
        correctedTotal: null,
        movedBy: null,
      });
      continue;
    }
    const row = snap(chosen);
    if (!row) {
      out.push({
        ...base,
        status: "NO SNAPSHOT ROW",
        comparedWith: { status: chosen.status, periodKey: chosen.periodKey },
        snapshotUnitBasisQty: null,
        correctedTotal: null,
        movedBy: null,
      });
      continue;
    }
    const snapshot = round3(num(row.unitBasisQty));
    const movedBy = round3(live - snapshot);
    out.push({
      ...base,
      comparedWith: { status: chosen.status, periodKey: chosen.periodKey },
      snapshotUnitBasisQty: snapshot,
      correctedTotal: round3(snapshot + lineDeltaSum),
      movedBy,
      status: Math.abs(movedBy) < EPS ? "RECONCILED" : "LEDGER MOVED SINCE FILING",
    });
  }
  return out;
}

/** Everything the sheet reads, inside the caller's READ ONLY transaction. */
export async function readSheet(client, tenantId) {
  await assertRequiredColumns(client);
  const flat = (await client.query(BOX_UNAWARE_ROWS_SQL, [tenantId])).rows;
  const contexts = await buildLineContexts(client, flat);
  const keys = [...new Set([...contexts.lines.values()].map((e) => e.lineKey))];
  const refRows = keys.length ? (await client.query(LINE_REFS_SQL, [tenantId, keys])).rows : [];
  const refs = new Map(
    refRows.map((r) => [
      r.line_key,
      { docKind: r.doc_kind, docNo: r.doc_no, ordinal: r.ordinal, sku: r.sku },
    ]),
  );
  const filings = (await client.query(FILINGS_SQL, [tenantId])).rows;
  const periodSums = (await client.query(PERIOD_SUMS_SQL, [tenantId])).rows;
  return assembleSheet({ contexts, refs, filings, periodSums });
}

// --- output ------------------------------------------------------------------------------------------
const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const COLUMNS = [
  ["period", "period"],
  ["lineRef", "line_ref"],
  ["product", "product"],
  ["category", "category"],
  ["packFactor", "pack_factor"],
  ["packSource", "pack_source"],
  ["ledgerUnitBasis", "ledger_unit_basis"],
  ["correctedUnitBasis", "corrected_unit_basis"],
  ["delta", "delta"],
  ["netSales", "net_sales"],
  ["categoryTax", "category_tax"],
  ["netDelta", "net_delta"],
  ["taxDelta", "tax_delta"],
  ["reason", "reason"],
];

export function footerLines(sheet) {
  const lines = [];
  for (const p of sheet.periods) {
    const where = `category ${p.categoryId} period ${p.period}`;
    lines.push(`${where}: ${p.status}`);
    for (const f of p.filings) {
      lines.push(
        `  filing ${f.status} key ${f.periodKey} generated ${new Date(f.generatedAt).toISOString()}${f.lockedAt ? ` locked ${new Date(f.lockedAt).toISOString()}` : ""} snapshot unit basis ${f.snapshotUnitBasisQty}`,
      );
    }
    if (p.comparedWith) {
      lines.push(
        `  filed (snapshot, ${p.comparedWith.status}): ${p.snapshotUnitBasisQty} | sum of line deltas: ${p.lineDeltaSum} | corrected period total: ${p.correctedTotal}${p.uncorrectedLines ? ` (excludes ${p.uncorrectedLines} unclassified line row(s))` : ""}`,
      );
      if (p.status === "LEDGER MOVED SINCE FILING")
        lines.push(
          `  LEDGER MOVED SINCE FILING by ${p.movedBy} (live ledger sum ${p.liveLedgerSum})`,
        );
    } else {
      lines.push(
        `  live ledger sum ${p.liveLedgerSum} | sum of line deltas: ${p.lineDeltaSum}${p.status === "NOT FILED" ? " | no filing holds this period (nothing filed to compare)" : ""}`,
      );
    }
  }
  return lines;
}

export function summaryLines(sheet) {
  const s = sheet.summary;
  const lines = [
    `lines listed: ${s.listedLines} (${
      Object.entries(s.categories)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") || "none"
    })`,
  ];
  if (s.countMismatch)
    lines.push(
      `!!! LINE COUNT ${s.listedLines} IS NOT THE ${s.expected} OF THE SA-790 CENSUS: read the category split above before using these figures !!!`,
    );
  if (s.newShapeLines)
    lines.push(
      `!!! ${s.newShapeLines} line(s) carry correction or counter-entry rows and are listed unclassified (a row shape newer than the classifier) !!!`,
    );
  if (s.moneyDeltaRows)
    lines.push(
      `!!! ${s.moneyDeltaRows} line row(s) carry a net-sales or tax delta; money is not unchanged there (see net_delta, tax_delta) !!!`,
    );
  return lines;
}

export function formatCsv(sheet, meta) {
  const out = [`# ${REFERENCE_NOTE}`, `# generated ${meta.generatedAt}; one tenant; READ ONLY`];
  for (const l of summaryLines(sheet)) out.push(`# ${l}`);
  out.push(COLUMNS.map(([, h]) => h).join(","));
  for (const r of sheet.lineRows) out.push(COLUMNS.map(([k]) => csvCell(r[k])).join(","));
  out.push("# per-period footer");
  for (const l of footerLines(sheet)) out.push(`# ${l}`);
  return `${out.join("\n")}\n`;
}

export function formatConsole(sheet, meta) {
  const out = [REFERENCE_NOTE, `generated ${meta.generatedAt}`, ...summaryLines(sheet), ""];
  out.push(...footerLines(sheet));
  return out.join("\n");
}
