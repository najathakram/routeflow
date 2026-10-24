// B961 / SA-071c: READ-ONLY sizing of INLINE return lines that look like a double credit: an inline `ReturnItem` with NO
// `sourceInvoiceItemId` (an unreferenced over-return chunk, priced at the current price) of a product the SAME customer already has
// on an EARLIER live return (not CANCELLED/REJECTED). It is an UPPER-BOUND proxy for "the product was already fully returned or
// credited" (SQL cannot see line supply); the owner reads it as "how many rows the new already-returned rule would have flagged".
// COUNTS ONLY: one READ ONLY transaction, always rolled back; integers only (rows, and whole dollars); never an id or a live slug.
//
// TENANT SAFETY (the #2169 / SA-403 belts, read-only form), identical to report-2392-taxed-nsf-lines.mjs:
//   BELT 1 — by default only test tenants (scripts/lib/test-tenants.cjs isTestTenant) are reported, per tenant, by slug. Every
//     other tenant is folded into ONE aggregate line — never named.
//   BELT 2 — `--include-live` REQUIRES a non-empty exclusion list (B961_EXCLUDE_TENANT_IDS, or --exclude-file <path> OUTSIDE the
//     repository), checked before any database is resolved. Excluded tenants are never counted or printed.
//
//   node apps/api/scripts/report-b961-already-returned-inline.mjs --self-test
//   node apps/api/scripts/report-b961-already-returned-inline.mjs          # local compose DB (B768 resolver)
//   railway run --service postgres node apps/api/scripts/report-b961-already-returned-inline.mjs \
//     --include-live --exclude-file /path/outside/repo/exclude.txt          # owner-run only
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
// B768: owner-run read-only reports reach the database through the ONE shared resolver.
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const TAG = "report-b961";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** The sizing query: per tenant, the count and whole-dollar sum of unreferenced inline lines of a product the same customer
 * already has on an earlier live return. Pure text (no parameters): the statuses are literals. */
export const SIZING_SQL = `
  SELECT t.id AS "tenantId", t.slug,
         count(*)::int AS lines,
         COALESCE(round(sum(ri.subtotal))::bigint, 0)::int AS dollars
    FROM "ReturnItem" ri
    JOIN "Return" r ON r.id = ri."returnId" AND r.kind = 'INLINE' AND r.status NOT IN ('CANCELLED', 'REJECTED')
    JOIN "Tenant" t ON t.id = r."tenantId"
   WHERE ri."sourceInvoiceItemId" IS NULL
     AND EXISTS (
       SELECT 1
         FROM "Return" r0
         JOIN "ReturnItem" ri0 ON ri0."returnId" = r0.id
        WHERE r0."tenantId" = r."tenantId"
          AND r0."customerId" = r."customerId"
          AND r0.id <> r.id
          AND r0."createdAt" < r."createdAt"
          AND r0.status NOT IN ('CANCELLED', 'REJECTED')
          AND ri0."productId" = ri."productId")
   GROUP BY t.id, t.slug
   ORDER BY t.slug`;

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
  return parseExclusions(env.B961_EXCLUDE_TENANT_IDS);
}

/** Pure: fold per-tenant counts into test rows (by slug) + one live aggregate (never named). */
export function summarize(rows, { includeLive, excluded }) {
  const ex = new Set(excluded);
  const test = [];
  let liveLines = 0;
  let liveDollars = 0;
  let liveTenants = 0;
  for (const r of rows) {
    if (ex.has(r.tenantId)) continue;
    if (isTestTenant(r.slug))
      test.push({ slug: r.slug, lines: Number(r.lines), dollars: Number(r.dollars) });
    else if (includeLive) {
      liveLines += Number(r.lines);
      liveDollars += Number(r.dollars);
      liveTenants += 1;
    }
  }
  return {
    test,
    live: includeLive ? { lines: liveLines, dollars: liveDollars, tenants: liveTenants } : null,
  };
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
  const url = resolveReportDbUrl("report-b961-already-returned-inline");
  if (!url) return 2;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const { rows } = await client.query(SIZING_SQL);
    const out = summarize(rows, { includeLive, excluded });
    for (const t of out.test)
      console.log(`${TAG}: test tenant ${t.slug}: ${t.lines} line(s), $${t.dollars}`);
    if (out.live) {
      console.log(
        `${TAG}: non-test: ${out.live.lines} line(s), $${out.live.dollars} across ${out.live.tenants} tenant(s)`,
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
  const cases = [
    [
      "the sizing SQL is read-only text over unreferenced inline lines of an earlier-returned product",
      () =>
        /sourceInvoiceItemId" IS NULL/.test(SIZING_SQL) &&
        /r\.kind = 'INLINE'/.test(SIZING_SQL) &&
        /r0\."createdAt" < r\."createdAt"/.test(SIZING_SQL) &&
        !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i.test(SIZING_SQL),
    ],
    [
      "parseExclusions: commas, whitespace, comments, dedupe",
      () =>
        JSON.stringify(parseExclusions("a, b\n# note\nc a")) === JSON.stringify(["a", "b", "c"]),
    ],
    [
      "summarize: a live tenant is never listed by slug, and only counted with --include-live",
      () => {
        const rows = [
          { tenantId: "t1", slug: "qa-b961-report", lines: 2, dollars: 20 },
          { tenantId: "t2", slug: "acme-live", lines: 5, dollars: 50 },
        ];
        const off = summarize(rows, { includeLive: false, excluded: [] });
        const on = summarize(rows, { includeLive: true, excluded: [] });
        return (
          off.test.length === 1 &&
          off.live === null &&
          on.live.lines === 5 &&
          on.live.tenants === 1 &&
          !JSON.stringify(on.test).includes("acme-live")
        );
      },
    ],
    [
      "summarize: an excluded tenant is never counted",
      () =>
        summarize([{ tenantId: "t2", slug: "acme-live", lines: 5, dollars: 50 }], {
          includeLive: true,
          excluded: ["t2"],
        }).live.lines === 0,
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
