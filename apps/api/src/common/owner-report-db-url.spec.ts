import { readFileSync, readdirSync } from "fs";
import { join, relative, sep } from "path";

/**
 * B768 — owner-run READ-ONLY reports reach the database through ONE resolver.
 *
 * Under `railway run --service postgres`, DATABASE_URL is the *.railway.internal host, unreachable
 * from the owner's machine. A report that reads `process.env.DATABASE_URL` directly fails there
 * (ENOTFOUND) or, worse, reads whatever DATABASE_URL happens to be exported. The owner-run reports
 * go through scripts/lib/report-db-url.mjs, where Railway's TCP-proxy variables win.
 *
 * This pins two things:
 * 1. Every B768 report imports the shared resolver.
 * 2. DATABASE_URL is named in code (comments stripped) ONLY by the scripts in ALLOWED below. The
 *    scan matches the bare name, not just `process.env.DATABASE_URL`, so an aliased read
 *    (`const e = process.env; e.DATABASE_URL`) cannot slip past it. The list may only SHRINK: a
 *    NEW read fails, and so does a stale entry (a script that no longer names it, or no longer
 *    exists). A new owner-run report must use the resolver, not join the list.
 */
const SCRIPTS = join(__dirname, "..", "..", "scripts");

/** The owner-run read-only reports B768 moved onto scripts/lib/report-db-url.mjs. */
const B768_REPORTS = [
  "audit-tenant-entitlements.mjs",
  "check-customer-tenants.js",
  "check-discrepancies.js",
  "check-tenant-logo.js",
  "finance-audit.js",
  "prod-readonly-audit.mjs",
  "report-addon-gate-blast-radius.mjs",
  "report-escaped-entities.mjs",
  "report-receiving-unit-drift.mjs",
  "report-train4-damage.mjs",
  "sales-gap-analysis.js",
  "stock-ledger-gap.mjs", // B562 PR-2 (SA-136 §6.3) — born on the resolver
  "report-addon-comp-candidates.mjs", // SA-693 — born on the resolver
];

/**
 * Scripts that still name DATABASE_URL, each for a stated reason. None is an owner-run report that
 * reads the prod DB through it by default.
 */
const ALLOWED: Record<string, string> = {
  // `--local` mode only: production goes through resolveDatabaseUrl(); DATABASE_URL is read solely
  // when the operator explicitly asks for a local run.
  "data-questions-report.mjs": "--local mode only",
  "sa077-split-qty-consistency.mjs": "--local mode only",
  "t6-backfill-census.mjs": "--local mode only",
  "t6-null-census.mjs": "--local mode only",
  "t6-null-rows-report.mjs": "--local mode only",
  "stamp-addon-comp.mjs": "--local mode only (writer: id-pinned, dry-run first)",
  // B294: a gated WRITER; production resolves with requireProxy, DATABASE_URL is --local only.
  "backfill-b294-order-line-taxrate.mjs": "--local mode only (writer: requireProxy otherwise)",
  "backfill-b297-rate-snapshot.mjs": "--local mode only (writer: requireProxy otherwise)",
  // The drift gate and the production guard deliberately read the raw variable.
  "schema-drift.mjs": "drift gate (railway-db-url.mjs: read-only drift check)",
  // Writers, destructive/QA and admin scripts: out of B768's scope (a separate decision). Listed so
  // any change to them is deliberate. propose-pack-sizes.mjs reports by default but WRITES
  // unitsPerBox under --execute, so it is a writer.
  "DANGER-fresh-data-WIPES-ALL-DATA.js": "destructive",
  "apply-rls.js": "writer",
  "backfill-expense-status.js": "writer",
  "backfill-invoice-payments.js": "writer",
  "backfill-rf016-route-run-status.js": "writer",
  "backfill-route-stop-addresses.js": "writer",
  "backfill-tobacco-category.mjs": "writer",
  "cleanup-qa-data.js": "destructive",
  "create-super-admin.js": "writer",
  "fix-legacy-business-name.js": "writer",
  "fix-order-number-duplicates.js": "writer",
  "invalidate-tenant-pdf-cache.js": "writer",
  "link-google.js": "writer",
  "merge-duplicate-products.js": "destructive",
  "merge-pending-orders.js": "destructive",
  "migrate-legacy-users.js": "writer",
  "nuke-db.js": "destructive",
  "nuke-tenant-data.js": "destructive",
  "propose-pack-sizes.mjs": "writer under --execute",
  "purge-live-svg-xss.js": "destructive",
  "purge-xss-customer-names.js": "destructive",
  "qa-deep-audit-cleanup.js": "destructive",
  "qa-multi-seller.js": "QA seed",
  "repair-escaped-entities.mjs": "writer",
  "repair-receiving-units.mjs": "writer",
  "reset-super-admin.js": "writer",
  "seed-irs-categories.js": "writer",
  "t6-drop-guards.mjs": "writer",
  "t6-stamp-null-rows.mjs": "writer",
  "tidy-regulated-categories.mjs": "writer",
  "ux-audit-cleanup.js": "destructive",
  "ux-audit-seed.js": "QA seed",
  // Aliased or indirect readers, found once the scan matched the bare name.
  // The resolver itself, and the one writer that hands its requireProxy result to Prisma.
  "lib/railway-db-url.mjs": "the resolver: the fallback it implements",
  "prod-migrate.mjs": "passes resolveDatabaseUrl(requireProxy) to the Prisma child as DATABASE_URL",
  // Already on resolveDatabaseUrl; the name appears only in help, log or error text.
  "backfill-legacy-tenant-ids.mjs": "uses resolveDatabaseUrl; help text only",
  "demo-bookings.mjs": "uses resolveDatabaseUrl; error text only",
  "e2e-seed.js": "uses resolveDatabaseUrl; log text only",
  "normalize-address-states.mjs": "uses resolveDatabaseUrl; help text only",
  // A hand-rolled resolver in the right order: proxy variables win, DATABASE_URL is the local
  // fallback only.
  "audit-buyer-verification-grandfather.mjs": "read-only audit; proxy-first, local fallback",
  "demo-seed.js": "demo-tenant seed; proxy-first, local fallback",
  "demo-verify.js": "demo-tenant check; proxy-first, local fallback",
  "scrub-demo-contacts.mjs": "writer under --execute; proxy-first, local fallback",
  "seed-marketing-screenshot-products.js": "local compose seed; proxy-first, local fallback",
  "seed-test-catalog.js": "test-tenant seed; proxy-first, local fallback",
  // Writers that read DATABASE_URL BEFORE the proxy variables (the B768 order); out of B768's
  // scope like the writers above.
  "backfill-product-aliases.mjs": "writer under --apply; DATABASE_URL-first",
  "backfill-supplier-invoice-number.mjs": "writer under --execute; DATABASE_URL-first",
};

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === "node_modules"
      ? []
      : e.isDirectory()
        ? walk(join(dir, e.name))
        : /\.(js|mjs|cjs)$/.test(e.name)
          ? [join(dir, e.name)]
          : [],
  );

const scripts = walk(SCRIPTS).map((f) => relative(SCRIPTS, f).split(sep).join("/"));
const namesDbUrl = (code: string) => /\bDATABASE_URL\b/.test(strip(code));
const readsDbUrl = (rel: string) => namesDbUrl(readFileSync(join(SCRIPTS, rel), "utf8"));

describe("B768 — owner-run reports resolve the database through one resolver (REG-B768)", () => {
  it("the scanner sees a direct and an aliased read, but not a comment (never passes vacuously)", () => {
    expect(readsDbUrl("nuke-db.js")).toBe(true);
    expect(namesDbUrl("const e = process.env;\nconst url = e.DATABASE_URL || null;")).toBe(true);
    expect(namesDbUrl("const { DATABASE_URL: url } = process.env;")).toBe(true);
    expect(namesDbUrl("// process.env.DATABASE_URL\n/* e.DATABASE_URL */")).toBe(false);
  });

  it.each(B768_REPORTS)(
    "%s imports scripts/lib/report-db-url.mjs and reads no DATABASE_URL",
    (rel) => {
      const src = strip(readFileSync(join(SCRIPTS, rel), "utf8"));
      expect(src).toMatch(/["']\.\/lib\/report-db-url\.mjs["']/);
      expect(readsDbUrl(rel)).toBe(false);
    },
  );

  it("no script outside the allow-list names DATABASE_URL in code", () => {
    const offenders = scripts.filter((rel) => !(rel in ALLOWED) && readsDbUrl(rel));
    expect(offenders).toEqual([]);
  });

  it("every allow-list entry still exists and still reads it (the list may only shrink)", () => {
    const stale = Object.keys(ALLOWED).filter((rel) => !scripts.includes(rel) || !readsDbUrl(rel));
    expect(stale).toEqual([]);
  });

  it("read-only reports keep the local fallback: the shared resolver does not require the proxy", () => {
    // Lead ruling on B768: requireProxy is for schema WRITERS (railway-db-url.mjs's own contract);
    // these read-only reports keep the DATABASE_URL fallback for local docker-compose runs.
    const lib = readFileSync(join(SCRIPTS, "lib", "report-db-url.mjs"), "utf8");
    expect(lib).toMatch(/export const REPORT_REQUIRE_PROXY = false;/);
  });
});
