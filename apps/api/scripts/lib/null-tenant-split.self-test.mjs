#!/usr/bin/env node
// Self-test for null-tenant-split.mjs (C-1b, SA-1123): the SQL builders behind section 4b of
// prod-readonly-audit.mjs. Fixtures and source-text checks only -- no database connection.
// Run directly: `node apps/api/scripts/lib/null-tenant-split.self-test.mjs`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NULL_TENANT_SPLITS,
  READ_ONLY_PRELUDE,
  VENDOR_BILL_ITEM_LEGACY_CUTOFF_ISO,
  sumBuckets,
  formatSplitLines,
  formatUnknownLine,
} from "./null-tenant-split.mjs";

let pass = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const bySlug = Object.fromEntries(NULL_TENANT_SPLITS.map((s) => [s.table, s]));
const TABLES = [
  "AuditLog",
  "RefreshToken",
  "User",
  "ExpenseCategory",
  "PaymentCounter",
  "VendorBillItem",
];

// --- (a) the six builders ---------------------------------------------------------------------

t("exactly the six tables, in order", () => {
  assert.deepEqual(
    NULL_TENANT_SPLITS.map((s) => s.table),
    TABLES,
  );
});

for (const table of TABLES) {
  t(`${table}: names its table, filters NULL tenant, selects counts only`, () => {
    const { sql } = bySlug[table];
    assert.match(sql, new RegExp(`FROM public\\."${table}"`));
    assert.match(sql, /"tenantId" IS NULL/);
    assert.match(sql, /^SELECT count\(\*\) FILTER \(WHERE /);
    assert.match(sql, /AS total/);
    assert.match(sql, /AS by_design/);
    assert.match(sql, /AS defect/);
  });
}

t("AuditLog: by design = no actor OR SUPER_ADMIN actor; defect = other actor", () => {
  const { sql } = bySlug.AuditLog;
  assert.match(sql, /"userId" IS NULL/);
  assert.match(sql, /EXISTS \(SELECT 1 FROM public\."User"/);
  assert.match(sql, /'SUPER_ADMIN'/);
  assert.match(sql, /"userId" IS NOT NULL AND NOT EXISTS/);
});

t("RefreshToken and PaymentCounter: one by-design bucket, defect is zero", () => {
  for (const table of ["RefreshToken", "PaymentCounter"]) {
    assert.match(bySlug[table].sql, /0::bigint AS defect/);
  }
});

t("User: SUPER_ADMIN by design, any other role defect", () => {
  const { sql } = bySlug.User;
  assert.match(sql, /"role" = 'SUPER_ADMIN'/);
  assert.match(sql, /"role" IS DISTINCT FROM 'SUPER_ADMIN'/);
});

t("ExpenseCategory: isCustom false is the by-design proxy, true is the defect", () => {
  const { sql, byDesignLabel } = bySlug.ExpenseCategory;
  assert.match(sql, /"isCustom" = false/);
  assert.match(sql, /"isCustom" = true/);
  assert.match(byDesignLabel, /proxy/);
});

t("VendorBillItem: createdAt vs the #2888 merge instant (df705828e4)", () => {
  assert.equal(VENDOR_BILL_ITEM_LEGACY_CUTOFF_ISO, "2026-10-01T04:47:45Z");
  const { sql, defectLabel } = bySlug.VendorBillItem;
  assert.match(sql, /"createdAt" < TIMESTAMP '2026-10-01 04:47:45'/);
  assert.match(sql, /"createdAt" >= TIMESTAMP '2026-10-01 04:47:45'/);
  // The deploy followed the merge by a few minutes: the after-bucket is labelled ambiguous.
  assert.match(defectLabel, /ambiguous/);
  const src = readFileSync(path.join(here, "null-tenant-split.mjs"), "utf8");
  assert.ok(src.includes("#2888") && src.includes("df705828e4"), "constant must cite #2888 + sha");
});

// --- (b) counts only --------------------------------------------------------------------------

t("no builder selects anything but counts", () => {
  for (const { table, sql } of NULL_TENANT_SPLITS) {
    assert.ok(!/SELECT\s+\*/i.test(sql), `${table}: SELECT *`);
    // Outer select list: everything between the first SELECT and the first top-level FROM.
    const outer = sql.slice(0, sql.indexOf("FROM public."));
    for (const col of ["email", "name", "id", "userId", "tenantId", "token"]) {
      // Columns may appear only inside FILTER (WHERE ...) predicates, never as selected output.
      const stripped = outer.replace(/FILTER \(WHERE[^;]*?\)(?= AS)/g, "");
      assert.ok(
        !new RegExp(`(^|[\\s,(])"?${col}"?\\s*(,|AS )`).test(stripped.replace(/count\(\*\)/g, "")),
        `${table}: selects ${col}`,
      );
    }
    const aliases = [...sql.matchAll(/ AS ([a-z_]+)/g)].map((m) => m[1]);
    assert.deepEqual(aliases, ["total", "by_design", "defect"], `${table}: aliases`);
  }
});

// --- (c) read-only SQL ------------------------------------------------------------------------

t("every statement begins with SELECT and has no write/DDL/SET word", () => {
  const banned = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|COPY|SET)\b/i;
  for (const { table, sql } of NULL_TENANT_SPLITS) {
    assert.match(sql, /^SELECT\b/, `${table}: must begin with SELECT`);
    assert.ok(!banned.test(sql), `${table}: contains a banned word`);
    assert.ok(!sql.includes(";"), `${table}: single statement`);
  }
});

// --- (d) the session is read-only -------------------------------------------------------------

t("READ_ONLY_PRELUDE sets default_transaction_read_only and a statement_timeout", () => {
  assert.ok(READ_ONLY_PRELUDE.includes("SET default_transaction_read_only = on"));
  assert.ok(READ_ONLY_PRELUDE.some((s) => /^SET statement_timeout = '\d+s'$/.test(s)));
  assert.equal(READ_ONLY_PRELUDE[0], "SET default_transaction_read_only = on");
});

const auditSrc = readFileSync(path.join(here, "..", "prod-readonly-audit.mjs"), "utf8");

t("audit script imports the prelude and issues it before any other query", () => {
  assert.match(
    auditSrc,
    /import \{[^}]*READ_ONLY_PRELUDE[^}]*\} from "\.\/lib\/null-tenant-split\.mjs"/,
  );
  const loop = auditSrc.search(/of READ_ONLY_PRELUDE/);
  assert.ok(loop > 0, "prelude loop missing");
  const body = auditSrc.replace(/const q = async[^\n]*\n/, "");
  const first = body.search(/\b(client\.query|q)\(/);
  const loopInBody = body.search(/of READ_ONLY_PRELUDE/);
  assert.ok(loopInBody > 0 && loopInBody < first, "a query runs before the prelude");
  assert.match(body.slice(loopInBody, first + 40), /client\.query\(stmt\)/);
  assert.ok(body.indexOf("client.connect()") < loopInBody, "prelude must follow connect");
});

t("audit script has no non-SELECT, non-SET query strings", () => {
  const re = /\b(?:q|client\.query)\(\s*(`[^`]*`|"[^"]*"|'[^']*')/g;
  let n = 0;
  for (const m of auditSrc.matchAll(re)) {
    n++;
    const text = m[1].slice(1, -1).trim();
    assert.match(text, /^(SELECT|SET)\b/i, `not SELECT/SET: ${text.slice(0, 30)}`);
  }
  assert.ok(n >= 6, "expected to find the audit's literal queries");
  assert.ok(!/\b(INSERT INTO|DELETE FROM|DROP TABLE|TRUNCATE)\b/i.test(auditSrc));
});

// --- (e) bucket sums and the formatter --------------------------------------------------------

t("by-design + defect == total, for fixtures", () => {
  for (const row of [
    { total: "10", by_design: "7", defect: "3" },
    { total: 0, by_design: 0, defect: 0 },
    { total: "5", by_design: "5", defect: "0" },
  ]) {
    const s = sumBuckets(row);
    assert.equal(s.byDesign + s.defect, s.total);
    assert.equal(s.total, Number(row.total));
  }
});

t("sumBuckets flags a mismatch instead of hiding it", () => {
  assert.equal(sumBuckets({ total: 10, by_design: 4, defect: 3 }).consistent, false);
  assert.equal(sumBuckets({ total: 7, by_design: 4, defect: 3 }).consistent, true);
});

t("formatter emits only label + count, and nothing from extra columns", () => {
  const row = {
    total: "10",
    by_design: "7",
    defect: "3",
    email: "someone@example.test",
    name: "Placeholder Name",
    id: "00000000-0000-0000-0000-000000000000",
  };
  for (const split of NULL_TENANT_SPLITS) {
    const lines = formatSplitLines(split, row);
    assert.equal(lines.length, 3);
    const text = lines.join("\n");
    for (const leak of ["someone@example.test", "Placeholder Name", "0000-0000"]) {
      assert.ok(!text.includes(leak), `${split.table}: leaked ${leak}`);
    }
    for (const line of lines) assert.match(line, /^ {3}\S.*: \d+$/);
    assert.ok(lines[0].includes(split.table));
    assert.ok(lines[1].endsWith(": 7") && lines[2].endsWith(": 3"));
  }
});

t("unknown line is label only, with no error text", () => {
  const line = formatUnknownLine(bySlug.User);
  assert.equal(line, "   User: unknown");
});

if (failures.length > 0) {
  console.error(`null-tenant-split self-test FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("self-test ok");
