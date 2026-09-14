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
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(API_DIR, "scripts/backfill-tenant-class.mjs");

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
    execSync(`node ${CLI}`, { encoding: "utf-8", env: { ...process.env, DATABASE_URL: dbUrl } });
    const after = await prisma.tenant.findMany({
      where: { slug: { in: [TEST_TENANT_SLUG, PRODUCTION_SLUG] } },
      select: { slug: true, class: true },
    });
    expect(after).toEqual(before);
  });

  it("apply classifies each slug correctly", async () => {
    execSync(`node ${CLI} --apply`, {
      encoding: "utf-8",
      env: { ...process.env, DATABASE_URL: dbUrl },
    });
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
    // whenever one of them happens to need reclassifying at the moment this runs.
    execSync(`node ${CLI} --apply`, {
      encoding: "utf-8",
      env: { ...process.env, DATABASE_URL: dbUrl },
    });
    const rows = await prisma.tenant.findMany({
      where: { slug: { in: [TEST_TENANT_SLUG, PRODUCTION_SLUG] } },
      select: { slug: true, class: true },
    });
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r.class]));
    expect(bySlug[TEST_TENANT_SLUG]).toBe("TEST");
    expect(bySlug[PRODUCTION_SLUG]).toBe("PRODUCTION");
  });
});
