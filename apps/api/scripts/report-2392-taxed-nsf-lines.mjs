// #2392 (c) / SA-478: READ-ONLY report of NSF bounce-fee lines that an older code path already
// stamped as TAXED (taxRate > 0). The fix (#2392) stops new ones; this only COUNTS existing rows so
// the owner can decide on a repair. It never writes: one READ ONLY transaction, always rolled back.
//
// A line is NSF by the ONE shared rule (@routeflow/pricing isNsfLine: systemKind = NSF_FEE, or —
// while the transition leg is on — systemKind IS NULL and the description starts with the prefix).
//
// TENANT SAFETY (the #2169 / SA-403 belts, read-only form):
//   BELT 1 — by default only test tenants (scripts/lib/test-tenants.cjs isTestTenant) are reported,
//     per tenant, by slug. Every other tenant is folded into ONE aggregate line — never named.
//   BELT 2 — `--include-live` (counting non-test tenants in that aggregate) REQUIRES a non-empty
//     exclusion list — B2392_EXCLUDE_TENANT_IDS, or --exclude-file <path> OUTSIDE the repository —
//     checked before any database is resolved. Excluded tenants are never counted or printed.
// Output is aggregate counts only: never an invoice id, line id, amount or live tenant slug.
//
//   node apps/api/scripts/report-2392-taxed-nsf-lines.mjs --self-test
//   node apps/api/scripts/report-2392-taxed-nsf-lines.mjs                 # local compose DB (B768 resolver)
//   railway run --service postgres node apps/api/scripts/report-2392-taxed-nsf-lines.mjs \
//     --include-live --exclude-file /path/outside/repo/exclude.txt      # owner-run only
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import {
  NSF_FEE_DESCRIPTION_PREFIX,
  NSF_FEE_SYSTEM_KIND,
  NSF_HAS_TRANSITION_LEG,
} from "@routeflow/pricing";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
// B768: owner-run read-only reports reach the database through the ONE shared resolver.
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const TAG = "report-2392";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** SQL: "this InvoiceItem IS the NSF fee line" — the positive twin of the b294 script's filter. */
export function isNsfSql(firstParam) {
  const kind = `$${firstParam}`;
  if (!NSF_HAS_TRANSITION_LEG)
    return { sql: `"systemKind" = ${kind}`, params: [NSF_FEE_SYSTEM_KIND] };
  const prefix = `$${firstParam + 1}`;
  return {
    sql: `("systemKind" = ${kind} OR ("systemKind" IS NULL AND starts_with(COALESCE(description, ''), ${prefix})))`,
    params: [NSF_FEE_SYSTEM_KIND, NSF_FEE_DESCRIPTION_PREFIX],
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
  return parseExclusions(env.B2392_EXCLUDE_TENANT_IDS);
}

/** Pure: fold per-tenant counts into test rows (by slug) + one live aggregate (never named). */
export function summarize(rows, { includeLive, excluded }) {
  const ex = new Set(excluded);
  const test = [];
  let liveLines = 0;
  let liveTenants = 0;
  for (const r of rows) {
    if (ex.has(r.tenantId)) continue;
    if (isTestTenant(r.slug)) test.push({ slug: r.slug, lines: Number(r.lines) });
    else if (includeLive) {
      liveLines += Number(r.lines);
      liveTenants += 1;
    }
  }
  return { test, live: includeLive ? { lines: liveLines, tenants: liveTenants } : null };
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
  const url = resolveReportDbUrl("report-2392-taxed-nsf-lines");
  if (!url) return 2;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const nsf = isNsfSql(1);
    const { rows } = await client.query(
      `SELECT t.id AS "tenantId", t.slug, count(*)::int AS lines
         FROM "InvoiceItem" li JOIN "Tenant" t ON t.id = li."tenantId"
        WHERE li."taxRate" > 0 AND ${nsf.sql}
        GROUP BY t.id, t.slug ORDER BY t.slug`,
      nsf.params,
    );
    const out = summarize(rows, { includeLive, excluded });
    for (const t of out.test)
      console.log(`${TAG}: test tenant ${t.slug}: ${t.lines} taxed NSF line(s)`);
    if (out.live) {
      console.log(
        `${TAG}: non-test: ${out.live.lines} taxed NSF line(s) across ${out.live.tenants} tenant(s)`,
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
      "isNsfSql binds the kind and the prefix",
      () => {
        const q = isNsfSql(1);
        return (
          q.params[0] === "NSF_FEE" &&
          q.params[1] === NSF_FEE_DESCRIPTION_PREFIX &&
          q.sql.includes("COALESCE(description, '')")
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
        const rows = [
          { tenantId: "t1", slug: "qa-nsf-report", lines: 2 },
          { tenantId: "t2", slug: "acme-live", lines: 5 },
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
        summarize([{ tenantId: "t2", slug: "acme-live", lines: 5 }], {
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
