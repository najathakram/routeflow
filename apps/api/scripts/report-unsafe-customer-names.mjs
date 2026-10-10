// B956: READ-ONLY, COUNT-ONLY report of EXISTING customers whose businessName / contactName /
// displayName starts with a spreadsheet formula lead (= + - @ TAB CR LF, or the full-width forms)
// and is not numeric-only text. B956 only refuses NEW writes of such names; this lets staff find and
// fix the old ones. It never writes: one READ ONLY transaction, always rolled back, and the matching
// happens INSIDE the database so no name, id or email ever reaches this process or the output.
//
// The two grammars below mirror apps/api/src/common/csv.ts FORMULA_LEAD / PLAIN_DECIMAL (a .mjs
// script cannot import TypeScript); safe-text-cell.spec.ts pins `.source` equality so they cannot
// drift.
//
// TENANT SAFETY (the #2169 / SA-403 belts, read-only form):
//   BELT 1 — by default only test tenants (scripts/lib/test-tenants.cjs isTestTenant) are reported,
//     per tenant, by slug. Every other tenant is folded into ONE aggregate line — never named.
//   BELT 2 — `--include-live` REQUIRES a non-empty exclusion list — B956_EXCLUDE_TENANT_IDS, or
//     --exclude-file <path> OUTSIDE the repository — checked before any database is resolved.
//     Excluded tenants are never counted or printed.
// Output is aggregate counts only: never a customer id, name, email or live tenant slug.
//
//   node apps/api/scripts/report-unsafe-customer-names.mjs --self-test
//   node apps/api/scripts/report-unsafe-customer-names.mjs                 # local compose DB (B768 resolver)
//   railway run --service postgres node apps/api/scripts/report-unsafe-customer-names.mjs \
//     --include-live --exclude-file /path/outside/repo/exclude.txt      # owner-run only
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
// B768: owner-run read-only reports reach the database through the ONE shared resolver.
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const TAG = "report-b956";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Mirrors csv.ts FORMULA_LEAD / PLAIN_DECIMAL `.source` (pinned equal by safe-text-cell.spec.ts). */
export const FORMULA_LEAD_SOURCE = "^[=+\\-@\\t\\r\\n＝＋－＠]";
export const PLAIN_DECIMAL_SOURCE = "^[+-]?(?=[^0-9]*[0-9])[0-9 ().-]+$";

export const NAME_COLUMNS = ["businessName", "contactName", "displayName"];

/** SQL counting, per tenant, customers with a formula-led name in each column (and in any). */
export function countSql() {
  const bad = (col) => `("${col}" ~ $1 AND "${col}" !~ $2)`;
  const cols = NAME_COLUMNS.map((c) => `count(*) FILTER (WHERE ${bad(c)})::int AS "${c}"`).join(
    ",\n           ",
  );
  const any = NAME_COLUMNS.map(bad).join(" OR ");
  return {
    sql: `SELECT t.id AS "tenantId", t.slug,
           ${cols},
           count(*) FILTER (WHERE ${any})::int AS "anyName"
         FROM "Customer" c JOIN "Tenant" t ON t.id = c."tenantId"
        WHERE c."deletedAt" IS NULL
        GROUP BY t.id, t.slug ORDER BY t.slug`
      .replaceAll('"businessName"', 'c."businessName"')
      .replaceAll('"contactName"', 'c."contactName"')
      .replaceAll('"displayName"', 'c."displayName"')
      .replace(/AS c\."(\w+)"/g, 'AS "$1"'),
    params: [FORMULA_LEAD_SOURCE, PLAIN_DECIMAL_SOURCE],
  };
}

/** Parse an exclusion list (comma/whitespace separated; `#` comments). */
export function parseExclusions(text) {
  return [
    ...new Set(
      String(text ?? "")
        .split("\n")
        .map((l) => l.replace(/#.*$/, ""))
        .join(" ")
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/** BELT 2: the exclusion list, or a refusal — before any database is resolved. */
export function resolveExclusions(env, file, repoRoot = REPO_ROOT) {
  if (file) {
    const real = realpathSync(isAbsolute(file) ? file : resolve(file));
    const rel = relative(repoRoot, real);
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      throw new Error("--exclude-file must live OUTSIDE the repository");
    }
    return parseExclusions(readFileSync(real, "utf8"));
  }
  return parseExclusions(env.B956_EXCLUDE_TENANT_IDS);
}

/** Pure: fold per-tenant counts into test rows (by slug) + one live aggregate (never named). */
export function summarize(rows, { includeLive, excluded }) {
  const ex = new Set(excluded);
  const test = [];
  const live = { customers: 0, tenants: 0 };
  for (const r of rows) {
    if (ex.has(r.tenantId)) continue;
    const row = {
      businessName: Number(r.businessName),
      contactName: Number(r.contactName),
      displayName: Number(r.displayName),
      anyName: Number(r.anyName),
    };
    if (isTestTenant(r.slug)) test.push({ slug: r.slug, ...row });
    else if (includeLive && row.anyName > 0) {
      live.customers += row.anyName;
      live.tenants += 1;
    }
  }
  return { test, live: includeLive ? live : null };
}

async function main() {
  const includeLive = process.argv.includes("--include-live");
  let excluded = [];
  if (includeLive) {
    excluded = resolveExclusions(process.env, argOf("--exclude-file"));
    if (excluded.length === 0) {
      console.error(`${TAG}: --include-live needs a non-empty exclusion list -- nothing was read`);
      return 1;
    }
  }
  const url = resolveReportDbUrl("report-unsafe-customer-names");
  if (!url) return 2;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const q = countSql();
    const { rows } = await client.query(q.sql, q.params);
    const out = summarize(rows, { includeLive, excluded });
    for (const t of out.test) {
      console.log(
        `${TAG}: test tenant ${t.slug}: ${t.anyName} customer(s) (businessName ${t.businessName}, contactName ${t.contactName}, displayName ${t.displayName})`,
      );
    }
    if (out.live) {
      console.log(
        `${TAG}: non-test: ${out.live.customers} customer(s) across ${out.live.tenants} tenant(s)`,
      );
    } else {
      console.log(
        `${TAG}: non-test tenants not counted (pass --include-live with an exclusion list)`,
      );
    }
    console.log(`${TAG}: read-only — nothing was written`);
    return 0;
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

function selfTest() {
  const lead = new RegExp(FORMULA_LEAD_SOURCE);
  const plain = new RegExp(PLAIN_DECIMAL_SOURCE);
  const flagged = (v) => lead.test(v) && !plain.test(v);
  const cases = [
    [
      "flags formula leads, spares numeric-only text and ordinary names",
      () =>
        ["=1+1", "+SUM(A1)", "-2+3+cmd|' /C calc'!A0", "@x", "\tx"].every(flagged) &&
        ["+1 555 123 4567", "(555) 123-4567", "-12.50", "Acme", "A=B"].every((v) => !flagged(v)),
    ],
    [
      "countSql binds both grammars and is a pure SELECT",
      () => {
        const q = countSql();
        return (
          q.params.length === 2 &&
          /^SELECT/.test(q.sql) &&
          !/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i.test(q.sql)
        );
      },
    ],
    [
      "parseExclusions: commas, whitespace, comments, dedupe",
      () =>
        JSON.stringify(parseExclusions("a, b\n# note\nc a")) === JSON.stringify(["a", "b", "c"]),
    ],
    [
      "summarize: a live tenant is never listed by slug, and only counted with --include-live",
      () => {
        const row = (tenantId, slug, n) => ({
          tenantId,
          slug,
          businessName: n,
          contactName: 0,
          displayName: 0,
          anyName: n,
        });
        const rows = [row("t1", "qa-names-report", 2), row("t2", "acme-live", 5)];
        const off = summarize(rows, { includeLive: false, excluded: [] });
        const on = summarize(rows, { includeLive: true, excluded: [] });
        return (
          off.test.length === 1 &&
          off.live === null &&
          on.live.customers === 5 &&
          on.live.tenants === 1 &&
          !JSON.stringify(on.test).includes("acme-live")
        );
      },
    ],
    [
      "summarize: an excluded tenant is never counted",
      () =>
        summarize(
          [
            {
              tenantId: "t2",
              slug: "acme-live",
              businessName: 5,
              contactName: 0,
              displayName: 0,
              anyName: 5,
            },
          ],
          { includeLive: true, excluded: ["t2"] },
        ).live.customers === 0,
    ],
    [
      "resolveExclusions refuses a file inside the repository",
      () => {
        try {
          resolveExclusions({}, fileURLToPath(import.meta.url));
          return false;
        } catch (e) {
          return /OUTSIDE the repository/.test(e.message);
        }
      },
    ],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    const ok = fn();
    if (!ok) failed += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  }
  console.log(
    failed ? `${TAG} self-test: ${failed} FAILED` : `${TAG} self-test: all ${cases.length} passed`,
  );
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const run = process.argv.includes("--self-test") ? Promise.resolve(selfTest()) : main();
  run.then(
    (code) => process.exit(code),
    (e) => {
      console.error(`${TAG}: ${e.message}`);
      process.exit(2);
    },
  );
}
