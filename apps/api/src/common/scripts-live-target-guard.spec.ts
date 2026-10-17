/**
 * Row 195 / SA-756r — structural pin: every script that can WRITE to a database goes through the
 * live-target guard, or is on the exempt list below with a reason.
 *
 * In scope: any file under apps/api/scripts/, scripts/ (repo root) or apps/api/prisma/*.ts that
 * imports `pg` / `@prisma/client` or names `PrismaClient` / `resolveDatabaseUrl`, or imports (by a
 * relative path) a file that is itself in scope. Each in-scope file must contain a REAL CALL to
 * `assertWritableTenant(`, `filterWritableTenants(` or (SQL writers) `protectedTenantIds(` — found on the parsed AST, so a name in a
 * comment or a string does not count — or be listed in EXEMPT. A new DB script that does neither is a
 * red build, never a silently-unguarded writer.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";

const API_DIR = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(API_DIR, "../..");

// protectedTenantIds feeds the SQL exclusion (`AND "tenantId" <> ALL($1::text[])`) of row-level writers.
// assertNoLiveProtectedTenants is the destructive local scripts' tunnel-proof refusal.
const GUARD_CALLS = new Set([
  "assertWritableTenant",
  "filterWritableTenants",
  "protectedTenantIds",
  "assertNoLiveProtectedTenants",
]);
const DB_MODULES = [
  /^pg$/,
  /(^|\/)node_modules\/pg$/,
  /^@prisma\/client$/,
  /node_modules\/@prisma\/client$/,
];
const DB_IDENTIFIERS = new Set(["PrismaClient", "resolveDatabaseUrl"]);

export const EXEMPT_REASONS = [
  "local-only", // productionGuard refuses any non-local target before the first connection
  "test-slug-only", // assertTestTenant / isTestTenant is the only way a target is chosen
  "read-only", // no INSERT/UPDATE/DELETE/DDL/$executeRaw/prisma write
  "schema-only", // DDL / migrations / RLS, no tenant rows
  "global-catalog", // writes only tenant-less reference tables
  "platform-users", // writes only platform/global User rows
  "not-a-db-client", // no database client of its own
  "retired-stub", // refuses to run
  "house-tenant", // the platform's own house tenant
  "localhost-url", // hardcoded localhost URL
  "guard-lib", // the guard libraries themselves
] as const;
type Reason = (typeof EXEMPT_REASONS)[number];

/** path (relative to the repo root, forward slashes) -> reason. */
const EXEMPT: Record<string, Reason> = {
  "apps/api/scripts/create-super-admin.js": "platform-users",
  "apps/api/scripts/pdf-render-smoke.mjs": "not-a-db-client",
  "apps/api/prisma/publish-plan-catalog-v10.ts": "global-catalog",
  "apps/api/prisma/publish-plan-catalog-v11.ts": "global-catalog",
  "apps/api/prisma/publish-plan-catalog-v12.ts": "global-catalog",
  "apps/api/prisma/publish-plan-catalog-v13.ts": "global-catalog",
  "apps/api/prisma/publish-plan-catalog-v8.ts": "global-catalog",
  "apps/api/prisma/publish-plan-catalog-v9.ts": "global-catalog",
  "apps/api/prisma/report-product-barcode-conflicts.ts": "read-only",
  "apps/api/prisma/report-variant-tier-drift.ts": "read-only",
  "apps/api/prisma/seed-expenses.ts": "global-catalog",
  "apps/api/prisma/seed-parity-buyer.ts": "test-slug-only",
  "apps/api/prisma/seed.ts": "test-slug-only",
  "apps/api/scripts/apply-rls.js": "schema-only",
  "apps/api/scripts/audit-buyer-verification-grandfather.mjs": "read-only",
  "apps/api/scripts/audit-tenant-entitlements.mjs": "read-only",
  "apps/api/scripts/backfill-invoices.js": "localhost-url",
  "apps/api/scripts/backup-production.mjs": "read-only",
  // An HTTP client of the platform-admin routes: no database client of its own. Its applyGate runs the guard
  // (assertWritableTenant) through lib/billing-catchup-core.cjs.
  "apps/api/scripts/billing-catchup.mjs": "not-a-db-client",
  "apps/api/scripts/bootstrap-house-tenant.mjs": "house-tenant",
  "apps/api/scripts/check-customer-tenants.js": "read-only",
  "apps/api/scripts/check-discrepancies.js": "read-only",
  "apps/api/scripts/check-tenant-logo.js": "read-only",
  "apps/api/scripts/data-questions-report.mjs": "read-only",
  "apps/api/scripts/demo-bookings.mjs": "global-catalog",
  "apps/api/scripts/demo-seed.js": "test-slug-only",
  "apps/api/scripts/demo-verify.js": "read-only",
  "apps/api/scripts/e2e-seed.js": "test-slug-only",
  "apps/api/scripts/finance-audit.js": "read-only",
  "apps/api/scripts/lib/live-target-guard.cjs": "guard-lib",
  "apps/api/scripts/lib/railway-db-url.mjs": "not-a-db-client",
  "apps/api/scripts/lib/report-db-url.mjs": "not-a-db-client",
  "apps/api/scripts/link-google.js": "platform-users",
  "apps/api/scripts/order-invoice-divergence-report.mjs": "read-only",
  "apps/api/scripts/prod-migrate.mjs": "schema-only",
  "apps/api/scripts/prod-readonly-audit.mjs": "read-only",
  "apps/api/scripts/purge-live-svg-xss.js": "test-slug-only",
  "apps/api/scripts/purge-xss-customer-names.js": "test-slug-only",
  "apps/api/scripts/qa-deep-audit-cleanup.js": "test-slug-only",
  "apps/api/scripts/qa-multi-seller.js": "test-slug-only",
  "apps/api/scripts/repair-costing.mjs": "read-only",
  "apps/api/scripts/report-2179-insights-scale.mjs": "read-only",
  "apps/api/scripts/report-2201-commission-sync-drift.mjs": "read-only",
  "apps/api/scripts/report-2392-taxed-nsf-lines.mjs": "read-only",
  "apps/api/scripts/report-2520-first-overdue-sweep.mjs": "read-only",
  "apps/api/scripts/report-477-sub-without-customer.mjs": "read-only",
  "apps/api/scripts/report-2533-product-image-keys.mjs": "read-only",
  "apps/api/scripts/report-2542-pod-keys.mjs": "read-only",
  "apps/api/scripts/report-addon-comp-candidates.mjs": "read-only",
  "apps/api/scripts/report-addon-default-grant-flip.mjs": "read-only",
  "apps/api/scripts/report-addon-gate-blast-radius.mjs": "read-only",
  "apps/api/scripts/report-billing-pause-blast-radius.mjs": "read-only",
  "apps/api/scripts/report-operator-account-blast-radius.mjs": "read-only",
  "apps/api/scripts/report-b1043-stale-tax-state.mjs": "read-only",
  "apps/api/scripts/report-b297-trio-sizing.mjs": "read-only",
  "apps/api/scripts/report-b2187-subscription-period-census.mjs": "read-only",
  "apps/api/scripts/report-b2188-duplicate-addon-rows.mjs": "read-only",
  "apps/api/scripts/report-b2197-issuedate-time-component.mjs": "read-only",
  "apps/api/scripts/report-b2230-unit-lines-without-boxes.mjs": "read-only",
  "apps/api/scripts/report-b2436-stripe-missing-sub.mjs": "read-only",
  "apps/api/scripts/report-b673-next-delivery-overcharge.mjs": "read-only",
  "apps/api/scripts/report-b861-numbering-config.mjs": "read-only",
  "apps/api/scripts/report-b894-prorate-counts.mjs": "read-only",
  "apps/api/scripts/report-b949-source-deleted-applications.mjs": "read-only",
  "apps/api/scripts/report-buyer-split-mismatch.mjs": "read-only",
  "apps/api/scripts/report-b961-already-returned-inline.mjs": "read-only",
  "apps/api/scripts/report-b965-mixed-unit-returns.mjs": "read-only",
  "apps/api/scripts/report-escaped-entities.mjs": "read-only",
  "apps/api/scripts/report-orphaned-order-docs-b1053.mjs": "read-only",
  "apps/api/scripts/report-profile-grant-overrides.mjs": "read-only",
  "apps/api/scripts/report-receiving-unit-drift.mjs": "read-only",
  "apps/api/scripts/report-recurring-boxed-template-qty.mjs": "read-only",
  "apps/api/scripts/report-read-only-sellers-with-buyers.mjs": "read-only",
  "apps/api/scripts/report-rf-invoice-calendar-census.mjs": "read-only",
  "apps/api/scripts/report-rf-invoice-zero-rows.mjs": "read-only",
  "apps/api/scripts/report-tenant-timezone-census.mjs": "read-only",
  "apps/api/scripts/report-train4-damage.mjs": "read-only",
  "apps/api/scripts/report-unsafe-customer-names.mjs": "read-only",
  "apps/api/scripts/sa077-split-qty-consistency.mjs": "read-only",
  "apps/api/scripts/sales-facts-timing.ts": "local-only",
  "apps/api/scripts/sales-gap-analysis.js": "read-only",
  "apps/api/scripts/schema-drift.mjs": "read-only",
  "apps/api/scripts/scrub-demo-contacts.mjs": "test-slug-only",
  "apps/api/scripts/seed-marketing-screenshot-products.js": "local-only",
  "apps/api/scripts/seed-test-catalog.js": "test-slug-only",
  "apps/api/scripts/stock-ledger-gap.mjs": "read-only",
  "apps/api/scripts/report-sa740-walkin-return-source.mjs": "read-only",
  "apps/api/scripts/t6-backfill-census.mjs": "read-only",
  "apps/api/scripts/t6-drop-guards.mjs": "schema-only",
  "apps/api/scripts/t6-null-census.mjs": "read-only",
  "apps/api/scripts/t6-null-rows-report.mjs": "read-only",
  "apps/api/scripts/tidy-regulated-categories.mjs": "test-slug-only",
  "apps/api/scripts/ux-audit-seed.js": "test-slug-only",
  "scripts/data-integrity-report.mjs": "read-only",
  "scripts/f07-conservation-report.mjs": "read-only",
  // The DB-spec lane runner: creates and drops only its own rf_dbspec_* databases on the local compose
  // Postgres (SPEC_DB_PATTERN enforced), never a tenant table.
  "scripts/local-db-specs.mjs": "local-only",
  "scripts/local-super-admin.mjs": "local-only",
  "scripts/repair-integrity.mjs": "retired-stub",
  "scripts/report-f25-licence-dates.mjs": "read-only",
  "scripts/rls-preflight.mjs": "read-only",
};

type Analysis = { inScope: boolean; hasGuardCall: boolean; relativeImports: string[] };

export function analyze(fileName: string, text: string): Analysis {
  const kind = /\.(m|c)?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const specifiers: string[] = [];
  let usesDbIdentifier = false;
  // A computed require()/import() path (e.g. require(path.join(...))) hides which module is loaded,
  // so the file cannot be proven DB-free: it is treated as in scope.
  let usesComputedLoad = false;
  let hasGuardCall = false;

  // Names that load modules: `require`, plus any const bound to `createRequire(...)` (`const req =
  // createRequire(import.meta.url); req("pg")`). Collected first so a use before its declaration in
  // the walk order still resolves.
  const loaders = new Set<string>(["require"]);
  const isCreateRequire = (n: ts.Node): boolean =>
    ts.isCallExpression(n) &&
    ((ts.isIdentifier(n.expression) && n.expression.text === "createRequire") ||
      (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "createRequire"));
  const collect = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isCreateRequire(node.initializer)
    )
      loaders.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
      specifiers.push(node.moduleSpecifier.text);
    // `export { x } from "m"` / `export * from "m"` load the module too.
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isLoad =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && loaders.has(callee.text)) ||
        // createRequire(import.meta.url)("pg"): the callee is itself a createRequire(...) call.
        isCreateRequire(callee);
      if (isLoad && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]))
        specifiers.push(node.arguments[0].text);
      else if (isLoad) usesComputedLoad = true;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      if (GUARD_CALLS.has(name)) hasGuardCall = true;
    }
    if (ts.isIdentifier(node) && DB_IDENTIFIERS.has(node.text)) usesDbIdentifier = true;
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const importsDb = specifiers.some((s) => DB_MODULES.some((re) => re.test(s)));
  return {
    inScope: importsDb || usesDbIdentifier || usesComputedLoad,
    hasGuardCall,
    relativeImports: specifiers.filter((s) => s.startsWith(".")),
  };
}

function listFiles(dir: string, recurse: boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === ".next" || name === "dist") continue;
    if (statSync(full).isDirectory()) {
      if (recurse) out.push(...listFiles(full, recurse));
    } else if (
      /\.(m|c)?(js|ts)$/.test(name) &&
      !/\.(spec|test|self-test)\.[mc]?[jt]s$/.test(name) &&
      !name.endsWith(".d.ts") &&
      !name.endsWith(".d.cts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function resolveRelative(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec);
  for (const cand of [base, ...[".js", ".cjs", ".mjs", ".ts"].map((e) => base + e)]) {
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const rel = (abs: string) => path.relative(REPO_ROOT, abs).split(path.sep).join("/");

function scan() {
  const files = [
    ...listFiles(path.join(API_DIR, "scripts"), true),
    ...listFiles(path.join(REPO_ROOT, "scripts"), true),
    ...listFiles(path.join(API_DIR, "prisma"), false),
  ];
  // Read as UTF-8 text: one script carries a control character.
  const info = new Map<string, Analysis>(
    files.map((f) => [f, analyze(f, readFileSync(f, "utf8"))]),
  );
  // Fixed point: a file that imports an in-scope file is in scope.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [f, a] of info) {
      if (a.inScope) continue;
      for (const spec of a.relativeImports) {
        const target = resolveRelative(f, spec);
        if (target && info.get(target)?.inScope) {
          a.inScope = true;
          changed = true;
          break;
        }
      }
    }
  }
  return info;
}

describe("analyze() — the pin's own fixtures", () => {
  it("an unguarded DB writer is in scope without a guard call (fails the pin)", () => {
    const a = analyze(
      "fixture.mjs",
      `import pg from "pg";\nconst c = new pg.Client();\nawait c.query("UPDATE \\"Order\\" SET x = 1");`,
    );
    expect(a).toMatchObject({ inScope: true, hasGuardCall: false });
  });

  it("a guard name only in a comment or a string does not count", () => {
    const a = analyze(
      "fixture.mjs",
      `import pg from "pg";\n// assertWritableTenant(tenant, sub, slugs)\n/* filterWritableTenants(rows) */\nconst s = "assertWritableTenant(x)";`,
    );
    expect(a).toMatchObject({ inScope: true, hasGuardCall: false });
  });

  it("a real call counts, bare or through a property", () => {
    expect(
      analyze(
        "a.cjs",
        `const { PrismaClient } = require("@prisma/client");\nassertWritableTenant(t, s, z);`,
      ),
    ).toMatchObject({ inScope: true, hasGuardCall: true });
    expect(
      analyze("b.mjs", `import pg from "pg";\nguard.filterWritableTenants(rows, subs, slugs);`),
    ).toMatchObject({ inScope: true, hasGuardCall: true });
  });

  it("a file with no DB client is out of scope; a PrismaClient identifier alone is in scope", () => {
    expect(analyze("c.mjs", `console.log("hi");`).inScope).toBe(false);
    expect(analyze("d.ts", `const p = new PrismaClient();`).inScope).toBe(true);
  });

  it("a computed require path cannot hide a DB client: it is in scope", () => {
    expect(
      analyze("f.js", `const pg = require(path.join(root, "node_modules", "pg"));`),
    ).toMatchObject({ inScope: true, hasGuardCall: false });
    expect(analyze("g.js", `const x = require("path");`).inScope).toBe(false);
  });

  it('createRequire(...)("pg"), an aliased req("pg") and export-from are loads', () => {
    const direct = analyze(
      "i.mjs",
      `import { createRequire } from "module";\nconst { Client } = createRequire(import.meta.url)("pg");`,
    );
    expect(direct).toMatchObject({ inScope: true, hasGuardCall: false });
    const aliased = analyze(
      "j.mjs",
      `import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nconst { Client } = req("pg");`,
    );
    expect(aliased).toMatchObject({ inScope: true, hasGuardCall: false });
    expect(analyze("k.mjs", `export { Client } from "pg";`).inScope).toBe(true);
    expect(analyze("l.mjs", `export * from "@prisma/client";`).inScope).toBe(true);
    // a relative load through the alias joins the transitive scope
    expect(
      analyze("m.mjs", `const r = createRequire(import.meta.url);\nr("./lib/x.cjs");`)
        .relativeImports,
    ).toEqual(["./lib/x.cjs"]);
    // an alias that loads a non-DB module stays out of scope; an unrelated callee is not a load
    expect(
      analyze("n.mjs", `const req = createRequire(import.meta.url);\nreq("node:path");`).inScope,
    ).toBe(false);
    expect(analyze("o.mjs", `foo("pg");`).inScope).toBe(false);
    // a computed path through the alias cannot hide a client
    expect(
      analyze("p.mjs", `const req = createRequire(import.meta.url);\nreq(name);`).inScope,
    ).toBe(true);
  });

  it("the tunnel-proof destructive-script refusal counts as a real guard call", () => {
    expect(
      analyze(
        "h.js",
        `const pg = require("pg");\nawait assertNoLiveProtectedTenants(prisma, slugs);`,
      ),
    ).toMatchObject({ inScope: true, hasGuardCall: true });
  });

  it("a relative import is recorded for the transitive scope", () => {
    expect(analyze("e.mjs", `import { x } from "./lib/x.mjs";`).relativeImports).toEqual([
      "./lib/x.mjs",
    ]);
  });
});

describe("row 195 — every DB-writing script is guarded or exempt", () => {
  const info = scan();

  it("scans a real population (vacuity guard)", () => {
    const inScope = [...info.values()].filter((a) => a.inScope).length;
    expect(info.size).toBeGreaterThan(100);
    expect(inScope).toBeGreaterThan(50);
  });

  it("every in-scope file has a real guard call or is exempt", () => {
    const offenders = [...info]
      .filter(([f, a]) => a.inScope && !a.hasGuardCall && !(rel(f) in EXEMPT))
      .map(([f]) => rel(f))
      .sort();
    expect(offenders).toEqual([]);
  });

  it("the exempt list has no stale entries and no needless ones", () => {
    const byRel = new Map([...info].map(([f, a]) => [rel(f), a]));
    const stale = Object.keys(EXEMPT).filter((p) => !byRel.has(p));
    const needless = Object.keys(EXEMPT).filter((p) => {
      const a = byRel.get(p);
      return a && (!a.inScope || a.hasGuardCall) && EXEMPT[p] !== "guard-lib";
    });
    expect({ stale, needless }).toEqual({ stale: [], needless: [] });
  });

  it("every exempt reason is one of the known keywords", () => {
    for (const reason of Object.values(EXEMPT)) expect(EXEMPT_REASONS).toContain(reason);
  });
});
