// SA-740 §1 / row 190: READ-ONLY census of WALK-IN inline returns whose goods were allocated to a sale OTHER than the one carrying the
// return. Before SA-740 the walk-in (one shared customer row) matched a return against its newest sales, so a return from receipt B could
// be priced at sale A's line and judged on A's tender. The damage is the walk-in `ReturnItem`s whose `sourceOrderId` differs from
// `Return.orderId` (the sale the counter flow carries the return on), plus the no-source (unreferenced) lines the walk-in rule now refuses.
// REPORT ONLY (L-207): no repair, no write. The owner sizes the damage from these counts and decides.
// COUNTS ONLY: one READ ONLY transaction, always rolled back; integers only (rows, returns, whole dollars); never an id or a live slug.
//
// TENANT SAFETY (the #2169 / SA-403 belts, read-only form), identical to report-b961-already-returned-inline.mjs:
//   BELT 1 — by default only test tenants (scripts/lib/test-tenants.cjs isTestTenant) are reported, per tenant, by slug. Every
//     other tenant is folded into ONE aggregate line — never named.
//   BELT 2 — `--include-live` REQUIRES a non-empty exclusion list (SA740_EXCLUDE_TENANT_IDS, or --exclude-file <path> OUTSIDE the
//     repository), checked before any database is resolved. Excluded tenants are never counted or printed.
//
//   node apps/api/scripts/report-sa740-walkin-return-source.mjs --self-test
//   node apps/api/scripts/report-sa740-walkin-return-source.mjs          # local compose DB (B768 resolver)
//   railway run --service postgres node apps/api/scripts/report-sa740-walkin-return-source.mjs --include-live --exclude-file <path outside repo>   # owner-run only
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
// B768: owner-run read-only reports reach the database through the ONE shared resolver.
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const TAG = "report-sa740";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Per tenant: the walk-in inline return LINES whose source sale differs from the carrying order, split into lines sourced on ANOTHER
 * sale (`elsewhere`) and lines with NO source at all (`unreferenced`), the distinct returns they sit on, and their credit in whole dollars
 * (subtotal + tax + category tax, as the credit mint issues it). Live statuses only (not CANCELLED / REJECTED). Pure text, no parameters. */
export const SIZING_SQL = `
  SELECT t.id AS "tenantId", t.slug,
         count(*) FILTER (WHERE ri."sourceOrderId" IS NOT NULL)::int AS elsewhere,
         count(*) FILTER (WHERE ri."sourceOrderId" IS NULL)::int AS unreferenced,
         count(DISTINCT r.id)::int AS returns,
         COALESCE(round(sum(COALESCE(ri.subtotal, 0) + COALESCE(ri."taxAmount", 0) + COALESCE(ri."categoryTax", 0)))::bigint, 0)::int AS dollars
    FROM "ReturnItem" ri
    JOIN "Return" r ON r.id = ri."returnId" AND r.kind = 'INLINE' AND r.status NOT IN ('CANCELLED', 'REJECTED')
    JOIN "Customer" c ON c.id = r."customerId" AND c."tenantId" = r."tenantId" AND c."isWalkIn" = true
    JOIN "Tenant" t ON t.id = r."tenantId"
   WHERE ri."sourceOrderId" IS DISTINCT FROM r."orderId"
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
  return parseExclusions(env.SA740_EXCLUDE_TENANT_IDS);
}

const counts = (r) => ({
  elsewhere: Number(r.elsewhere),
  unreferenced: Number(r.unreferenced),
  returns: Number(r.returns),
  dollars: Number(r.dollars),
});

/** Pure: fold per-tenant counts into test rows (by slug) + one live aggregate (never named). */
export function summarize(rows, { includeLive, excluded }) {
  const ex = new Set(excluded);
  const test = [];
  const live = { elsewhere: 0, unreferenced: 0, returns: 0, dollars: 0, tenants: 0 };
  for (const r of rows) {
    if (ex.has(r.tenantId)) continue;
    if (isTestTenant(r.slug)) test.push({ slug: r.slug, ...counts(r) });
    else if (includeLive) {
      const c = counts(r);
      live.elsewhere += c.elsewhere;
      live.unreferenced += c.unreferenced;
      live.returns += c.returns;
      live.dollars += c.dollars;
      live.tenants += 1;
    }
  }
  return { test, live: includeLive ? live : null };
}

const describeCounts = (c) =>
  `${c.elsewhere} line(s) sourced on another sale, ${c.unreferenced} with no source, on ${c.returns} return(s), $${c.dollars}`;

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
  const url = resolveReportDbUrl("report-sa740-walkin-return-source");
  if (!url) return 2;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const { rows } = await client.query(SIZING_SQL);
    const out = summarize(rows, { includeLive, excluded });
    for (const t of out.test) console.log(`${TAG}: test tenant ${t.slug}: ${describeCounts(t)}`);
    if (out.live) {
      console.log(
        `${TAG}: non-test: ${describeCounts(out.live)} across ${out.live.tenants} tenant(s)`,
      );
    } else {
      console.log(
        `${TAG}: non-test tenants not counted (pass --include-live with an exclusion list)`,
      );
    }
    console.log(`${TAG}: read-only — nothing was written, nothing was repaired`);
    return 0;
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

function selfTest() {
  const row = (tenantId, slug, elsewhere, unreferenced, returns, dollars) => ({
    tenantId,
    slug,
    elsewhere,
    unreferenced,
    returns,
    dollars,
  });
  const cases = [
    [
      "the sizing SQL is read-only text over walk-in inline lines whose source differs from the carrying order",
      () =>
        /"isWalkIn" = true/.test(SIZING_SQL) &&
        /r\.kind = 'INLINE'/.test(SIZING_SQL) &&
        /ri\."sourceOrderId" IS DISTINCT FROM r\."orderId"/.test(SIZING_SQL) &&
        !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/i.test(SIZING_SQL),
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
          row("t1", "qa-sa740-report", 2, 1, 2, 20),
          row("t2", "acme-live", 5, 0, 4, 50),
        ];
        const off = summarize(rows, { includeLive: false, excluded: [] });
        const on = summarize(rows, { includeLive: true, excluded: [] });
        return (
          off.test.length === 1 &&
          off.live === null &&
          on.live.elsewhere === 5 &&
          on.live.returns === 4 &&
          on.live.tenants === 1 &&
          !JSON.stringify(on.test).includes("acme-live")
        );
      },
    ],
    [
      "summarize: an excluded tenant is never counted",
      () =>
        summarize([row("t2", "acme-live", 5, 0, 4, 50)], { includeLive: true, excluded: ["t2"] })
          .live.elsewhere === 0,
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
