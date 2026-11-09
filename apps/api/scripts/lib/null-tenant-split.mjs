// C-1b (SA-1123): pure SQL builders + formatters for section 4b of prod-readonly-audit.mjs, which
// splits the NULL-tenantId counts of six tables into BY-DESIGN vs DEFECT buckets.
// COUNTS ONLY: every statement selects three counts, never a name, email, id or row content.
// No pg import and no top-level side effects, so the self-test runs without a database.

// The session guard the audit issues first. The self-test pins that the audit script uses this.
export const READ_ONLY_PRELUDE = [
  "SET default_transaction_read_only = on",
  "SET statement_timeout = '45s'",
];

// PR #2888 merge instant (merge commit df705828e4, merged 2026-10-01T04:47:45Z). VendorBillItem rows
// created before it are legacy NULL-tenant rows (by design). The deploy came a little later than the
// merge, so rows created within a few minutes after this cut are ambiguous, not proven defects.
export const VENDOR_BILL_ITEM_LEGACY_CUTOFF_ISO = "2026-10-01T04:47:45Z";

// Prisma stores timestamp(3) without a zone, in UTC: compare against a zone-less literal.
const CUTOFF_TS = VENDOR_BILL_ITEM_LEGACY_CUTOFF_ISO.replace("T", " ").replace("Z", "");

const SUPER_ADMIN_ACTOR = `EXISTS (SELECT 1 FROM public."User" u WHERE u.id = a."userId" AND u."role" = 'SUPER_ADMIN')`;

// Builds one single-statement, count-only SELECT. Table identifiers are hard-coded below, never input.
function build(table, alias, byDesignPredicate, defectPredicate) {
  const f = (pred) => `count(*) FILTER (WHERE "tenantId" IS NULL${pred ? ` AND ${pred}` : ""})`;
  const from = alias ? `public."${table}" ${alias}` : `public."${table}"`;
  const defect = defectPredicate ? `${f(defectPredicate)}::bigint` : "0::bigint";
  return (
    `SELECT ${f("")}::bigint AS total, ` +
    `${f(byDesignPredicate)}::bigint AS by_design, ` +
    `${defect} AS defect FROM ${from}`
  );
}

export const NULL_TENANT_SPLITS = [
  {
    table: "AuditLog",
    byDesignLabel: "by design (no actor, or SUPER_ADMIN actor)",
    defectLabel: "defect (tenant-user actor)",
    sql: build(
      "AuditLog",
      "a",
      `(a."userId" IS NULL OR ${SUPER_ADMIN_ACTOR})`,
      `a."userId" IS NOT NULL AND NOT ${SUPER_ADMIN_ACTOR}`,
    ),
  },
  {
    table: "RefreshToken",
    byDesignLabel: "by design (identity-scoped, all rows)",
    defectLabel: "defect (none defined)",
    sql: build("RefreshToken", "", "true", ""),
  },
  {
    table: "User",
    byDesignLabel: "by design (SUPER_ADMIN)",
    defectLabel: "defect (any other role)",
    sql: build("User", "", `"role" = 'SUPER_ADMIN'`, `"role" IS DISTINCT FROM 'SUPER_ADMIN'`),
  },
  {
    table: "ExpenseCategory",
    byDesignLabel: "by design (proxy: isCustom = false, global seed codes)",
    defectLabel: "defect (proxy: isCustom = true)",
    sql: build("ExpenseCategory", "", `"isCustom" = false`, `"isCustom" = true`),
  },
  {
    table: "PaymentCounter",
    byDesignLabel: "by design (legacy NULL-tenant row)",
    defectLabel: "defect (none defined)",
    sql: build("PaymentCounter", "", "true", ""),
  },
  {
    table: "VendorBillItem",
    byDesignLabel: "by design (legacy, created before the #2888 merge)",
    defectLabel:
      "defect (created at/after the #2888 merge; ambiguous for a few minutes, deploy lagged)",
    sql: build(
      "VendorBillItem",
      "",
      `"createdAt" < TIMESTAMP '${CUTOFF_TS}'`,
      `"createdAt" >= TIMESTAMP '${CUTOFF_TS}'`,
    ),
  },
];

// Adds the two buckets and reports whether they equal the total the same query counted.
export function sumBuckets(row) {
  const byDesign = Number(row.by_design);
  const defect = Number(row.defect);
  const total = Number(row.total);
  return { byDesign, defect, total, consistent: byDesign + defect === total };
}

// Count-only output: label + number per line, drawn from nothing but the three count columns.
export function formatSplitLines(split, row) {
  const s = sumBuckets(row);
  return [
    `   ${split.table} total NULL-tenant: ${s.byDesign + s.defect}`,
    `   ${split.table} ${split.byDesignLabel}: ${s.byDesign}`,
    `   ${split.table} ${split.defectLabel}: ${s.defect}`,
  ];
}

export function formatUnknownLine(split) {
  return `   ${split.table}: unknown`;
}
