/**
 * DB-lane spec for `../../scripts/backfill-tenant-class.mjs` — proves the dry-run/apply
 * mechanics against a REAL Postgres (idempotency, "dry run makes no writes", classification
 * actually persisted). Lives under `src/common` (not next to the script under `scripts/`)
 * because `jest.db.config.js` inherits `rootDir: "src"` from the base Jest config — a spec
 * under `apps/api/scripts/` would never be discovered by `npm run local:test:db`, matching
 * the sibling precedent `backfill-legacy-tenant-ids.db.spec.ts`.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`
 * (`node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api"`), which points
 * DATABASE_URL at the compose Postgres and sets RUN_DB_SPECS. `requireLocalDatabaseUrl()`
 * refuses any non-local host.
 *
 * Coverage is deliberately TEST + PRODUCTION only, not DEMO/INTERNAL: `routeflow-demo` and
 * `routeflow-hq` are real, singleton slugs (the standing sales-demo tenant and the house
 * tenant a later task bootstraps) — fabricating either here risks colliding with a real row on
 * a shared local compose database. DEMO/INTERNAL classification is fully covered with zero DB
 * risk by the pure unit spec (`./tenant-class.util.spec.ts`); this file only needs to prove the
 * script's read-tenants-then-write-changed-ones mechanism against a real table.
 *
 * The classify()-vs-classifyTenantSlug cross-check (Task 3 Step 1) lives in
 * `./tenant-class.util.spec.ts`, not here: `apps/api/package.json`'s Jest config ignores
 * `\.db\.spec\.ts$` in the normal lane, so a no-DB assertion kept in THIS file would never run
 * except under `npm run local:test:db` — moved so it executes on every ordinary `npm test`.
 *
 * SAFETY: `TEST_TENANT_SLUG` is `assertTestTenant`-approved (`qa-` prefix). `PRODUCTION_SLUG`
 * uses the repo's `acme-` placeholder convention for a deliberately non-approved slug (CLAUDE.md
 * forbids naming a real client anywhere) — `assertTestTenant` is NOT called on it, matching the
 * precedent in `backfill-legacy-tenant-ids.db.spec.ts` (`NONTEST_TENANT_SLUG`). Both rows are
 * created fresh by this file and deleted in `afterAll`.
 *
 * The CLI itself is a whole-table dark backfill by design (every tenant, not a `--tenant=` scope
 * like the tobacco backfill) — running an unscoped `--apply` in a shared local compose database
 * would therefore reclassify every OTHER tenant sitting in it too (e.g. a `qa-*`/`test` row left
 * over from another lane's run, or another `.db.spec.ts` suite's own PRODUCTION fixtures running
 * concurrently in a sibling Jest worker — this is exactly how L-129 was paid for). This spec
 * instead passes `--slug-prefix <SLUG_PREFIX>` on every invocation so the CLI's scan/apply never
 * touches a row outside its own fixtures — no whole-table snapshot/restore needed.
 */
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { pathToFileURL } from "url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(API_DIR, "scripts/backfill-tenant-class.mjs");
const RAILWAY_DB_URL_LIB_HREF = pathToFileURL(
  path.resolve(API_DIR, "scripts/lib/railway-db-url.mjs"),
).href;

// REG-743-N2 helper: computes the same `redactUrl(url)` value the real CLI is expected to
// print, via the actual `scripts/lib/railway-db-url.mjs` module (never a re-typed local
// mirror of its redaction logic) — mirrors the ESM-shim pattern in `railway-db-url.spec.ts`
// (ts-jest's CommonJS transform can't `import` a `.mjs` file directly).
function redactUrlViaLib(url: string): string {
  const script = `import { redactUrl } from "${RAILWAY_DB_URL_LIB_HREF}"; console.log(redactUrl(process.env.RDU_URL));`;
  return execSync(`node --input-type=module -e ${JSON.stringify(script)}`, {
    encoding: "utf-8",
    env: { ...process.env, RDU_URL: url },
  }).trim();
}

// REG-743-N2: every child CLI invocation in this file must get an env with every RAILWAY_*/
// POSTGRES_* key scrubbed, so a leftover `railway run` proxy export (or the N2 test's own
// deliberately-injected fake ones) can never make the CLI resolve anything but this spec's own
// local `dbUrl` — mirrors the fix required in the real script callers, not just this test.
function childEnv(dbUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) delete env[key];
  }
  env.DATABASE_URL = dbUrl;
  return env;
}

const RUN_SUFFIX = randomUUID().slice(0, 8);
const TEST_TENANT_SLUG = assertTestTenant(
  `qa-phase0-${RUN_SUFFIX}`,
  "backfill-tenant-class.db.spec.ts",
);
// Deliberately NOT assertTestTenant-approved — the negative control proving the classifier's
// fallback branch. See file header.
const PRODUCTION_SLUG = `acme-phase0-${RUN_SUFFIX}`;

describeDb("backfill-tenant-class.mjs (db)", () => {
  const dbUrl = requireLocalDatabaseUrl();
  const pool = new Pool({ connectionString: dbUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  // Snapshot of every OTHER tenant's class, taken before this file writes anything — the CLI's
  // `--apply` scans and reclassifies the whole table, so this is what lets `afterAll` restore
  // them exactly (see file header).
  let otherTenantsBefore: Array<{ id: string; class: string }> = [];

  beforeAll(async () => {
    otherTenantsBefore = await prisma.tenant.findMany({ select: { id: true, class: true } });
    for (const slug of [TEST_TENANT_SLUG, PRODUCTION_SLUG]) {
      await prisma.tenant.create({ data: { slug, name: slug, status: "ACTIVE" } });
    }
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({
      where: { slug: { in: [TEST_TENANT_SLUG, PRODUCTION_SLUG] } },
    });
    for (const t of otherTenantsBefore) {
      // updateMany + id: a concurrently-running spec may have already deleted this tenant as
      // part of its own teardown between our beforeAll snapshot and here; count 0 (no throw)
      // just means there is nothing left to restore, same race class as the CLI's own writes.
      await prisma.tenant.updateMany({
        where: { id: t.id },
        data: { class: t.class as never },
      });
    }
    await prisma.$disconnect();
    await pool.end();
  });

  it("dry run makes no writes", async () => {
    const before = await prisma.tenant.findMany({
      where: { slug: { in: [TEST_TENANT_SLUG, PRODUCTION_SLUG] } },
      select: { slug: true, class: true },
    });
    execSync(`node ${CLI}`, { encoding: "utf-8", env: childEnv(dbUrl) });
    const after = await prisma.tenant.findMany({
      where: { slug: { in: [TEST_TENANT_SLUG, PRODUCTION_SLUG] } },
      select: { slug: true, class: true },
    });
    expect(after).toEqual(before);
  });

  it("apply classifies each slug correctly", async () => {
    // Scoped per-slug (`--slug-prefix`), never a bare `--apply`: this CLI is a whole-table
    // backfill (see file header), and 15 other `.db.spec.ts` files run concurrently against
    // this same database — an unscoped apply here would also reclassify
    // `backfill-subscription-reconciliation.db.spec.ts`'s own `qa-*` PRODUCTION-class fixtures
    // (matched by `TEST_TENANT_PATTERN`) out from under it mid-run. TEST_TENANT_SLUG and
    // PRODUCTION_SLUG don't share a common prefix (`qa-` vs `acme-`), so each needs its own call.
    for (const slug of [TEST_TENANT_SLUG, PRODUCTION_SLUG]) {
      execSync(`node ${CLI} --apply --slug-prefix ${slug}`, {
        encoding: "utf-8",
        env: childEnv(dbUrl),
      });
    }
    const rows = await prisma.tenant.findMany({
      where: { slug: { in: [TEST_TENANT_SLUG, PRODUCTION_SLUG] } },
      select: { slug: true, class: true },
    });
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r.class]));
    expect(bySlug[TEST_TENANT_SLUG]).toBe("TEST");
    expect(bySlug[PRODUCTION_SLUG]).toBe("PRODUCTION");
  });

  it("a second apply is a no-op (idempotent) for this file's own tenants", async () => {
    // Assert only on this file's own rows, not the printed global change count: 15 other
    // db.spec.ts files run concurrently against this same database and create/delete their own
    // tenants throughout the run, so a global "0 classification change(s)" assertion would flake
    // whenever one of them happens to need reclassifying at the moment this runs. Scoped
    // per-slug for the same reason as the first apply above — never a bare `--apply`.
    for (const slug of [TEST_TENANT_SLUG, PRODUCTION_SLUG]) {
      execSync(`node ${CLI} --apply --slug-prefix ${slug}`, {
        encoding: "utf-8",
        env: childEnv(dbUrl),
      });
    }
    const rows = await prisma.tenant.findMany({
      where: { slug: { in: [TEST_TENANT_SLUG, PRODUCTION_SLUG] } },
      select: { slug: true, class: true },
    });
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r.class]));
    expect(bySlug[TEST_TENANT_SLUG]).toBe("TEST");
    expect(bySlug[PRODUCTION_SLUG]).toBe("PRODUCTION");
  });

  it("REG-743-N2 the spawned CLI targets the spec's local database even when Railway proxy vars are present in the environment", () => {
    // `resolveDatabaseUrl()` (scripts/lib/railway-db-url.mjs) picks the Railway TCP-proxy URL
    // FIRST whenever these five vars are all set. Faking them on THIS spec process's own
    // `process.env` (never the child's explicit env below) reproduces the exact shape of a
    // `railway run --service postgres` shell that also has docker-compose's local vars
    // exported — the failure mode N2 exists to close: `execSync` spreads
    // `...process.env` into the child unfiltered, so a Railway-shaped environment leaks into
    // a spec that must only ever touch its own local Postgres.
    const savedEnv: Record<string, string | undefined> = {
      RAILWAY_TCP_PROXY_DOMAIN: process.env.RAILWAY_TCP_PROXY_DOMAIN,
      RAILWAY_TCP_PROXY_PORT: process.env.RAILWAY_TCP_PROXY_PORT,
      POSTGRES_USER: process.env.POSTGRES_USER,
      POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,
      POSTGRES_DB: process.env.POSTGRES_DB,
    };
    process.env.RAILWAY_TCP_PROXY_DOMAIN = "prod.invalid";
    process.env.RAILWAY_TCP_PROXY_PORT = "5432";
    process.env.POSTGRES_USER = "prod-user";
    process.env.POSTGRES_PASSWORD = "prod-pass";
    process.env.POSTGRES_DB = "prod-db";

    try {
      // Caught, not left to throw: today (pre-fix) the leaked Railway vars make the spawned
      // CLI try to connect to `prod.invalid` and `execSync` throws (non-zero exit) before the
      // assertion below ever runs — that would fail the WHOLE test with a raw "Command failed"
      // error instead of a clean, reportable assertion failure. `error.stdout` still carries
      // whatever the child printed (or, pre-fix, nothing) before it died, so the comparison
      // below runs either way and fails on its own terms.
      let output: string;
      try {
        output = execSync(`node ${CLI}`, {
          encoding: "utf-8",
          env: childEnv(dbUrl),
        });
      } catch (err) {
        output = (err as { stdout?: string }).stdout ?? "";
      }
      const firstLine = output.split("\n")[0];
      // Head: with the Railway vars leaked into the child, `resolveDatabaseUrl` resolves
      // `prod.invalid` and the CLI fails to connect before ever printing this line — the
      // spec's own local `dbUrl` must be what the CLI actually resolves and reports.
      expect(firstLine).toBe(`Resolved database host: ${redactUrlViaLib(dbUrl)}`);
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
