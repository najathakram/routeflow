/**
 * DB-lane spec for `../../scripts/backfill-subscription-reconciliation.mjs` — proves the
 * dry-run/apply mechanics against a REAL Postgres (create-if-missing, backfill-if-partial,
 * PRODUCTION/DEMO-only scope, idempotency). Lives under `src/common` (not next to the script
 * under `scripts/`) because `jest.db.config.js` inherits `rootDir: "src"` from the base Jest
 * config — a spec under `apps/api/scripts/` would never be discovered by `npm run
 * local:test:db`, matching the sibling precedent `backfill-tenant-class.db.spec.ts`.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * SAFETY: both fixture slugs are `assertTestTenant`-approved (`qa-` prefix). Their `class` is
 * set DIRECTLY at creation to PRODUCTION/TEST rather than derived from the slug — the CLI reads
 * whatever `class` a tenant already carries, and this file never runs the class backfill
 * against these rows, so a qa-prefixed slug carrying `class: PRODUCTION` here does not
 * conflict with `classifyTenantSlug`'s independent slug->class mapping. Requires a PUBLISHED
 * PlanVersion to already exist locally (published by `local:seed`'s genesis step) — this spec
 * reads it rather than publishing its own, so it never collides with another lane's catalog
 * version.
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
const CLI = path.resolve(API_DIR, "scripts/backfill-subscription-reconciliation.mjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
const NO_SUB_SLUG = assertTestTenant(
  `qa-phase0-recon-${RUN_SUFFIX}-1`,
  "backfill-subscription-reconciliation.db.spec.ts",
);
const PARTIAL_SUB_SLUG = assertTestTenant(
  `qa-phase0-recon-${RUN_SUFFIX}-2`,
  "backfill-subscription-reconciliation.db.spec.ts",
);
const TEST_CLASS_SLUG = assertTestTenant(
  `qa-phase0-recon-${RUN_SUFFIX}-3`,
  "backfill-subscription-reconciliation.db.spec.ts",
);
const ALL_SLUGS = [NO_SUB_SLUG, PARTIAL_SUB_SLUG, TEST_CLASS_SLUG];

describeDb("backfill-subscription-reconciliation.mjs (db)", () => {
  const dbUrl = requireLocalDatabaseUrl();
  const pool = new Pool({ connectionString: dbUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  let tenantNoSub: { id: string };
  let tenantPartial: { id: string };
  let tenantTestClass: { id: string };
  let starterPrice: string;
  let scalePrice: string;

  beforeAll(async () => {
    const publishedVersion = await prisma.planVersion.findFirst({
      where: { status: "PUBLISHED" },
      include: { definitions: true },
    });
    if (!publishedVersion) {
      throw new Error(
        "No PUBLISHED PlanVersion in the compose DB — run `npm run local:seed` first.",
      );
    }
    starterPrice = String(
      publishedVersion.definitions.find((d) => d.planKey === "STARTER")?.monthlyPrice,
    );
    scalePrice = String(
      publishedVersion.definitions.find((d) => d.planKey === "SCALE")?.monthlyPrice,
    );

    tenantNoSub = await prisma.tenant.create({
      data: { slug: NO_SUB_SLUG, name: NO_SUB_SLUG, status: "ACTIVE", class: "PRODUCTION" },
    });
    tenantPartial = await prisma.tenant.create({
      data: {
        slug: PARTIAL_SUB_SLUG,
        name: PARTIAL_SUB_SLUG,
        status: "ACTIVE",
        class: "PRODUCTION",
        plan: "PROFESSIONAL",
        subscription: { create: { planKey: null, basePriceSnapshot: null } },
      },
    });
    // Excluded from reconciliation by class alone (not by slug) — proves the script's
    // `class: { in: ["PRODUCTION", "DEMO"] }` scope, matching MrrService's own PRODUCTION-only
    // revenue rule (Phase 0 T9): a TEST tenant must never get a real subscription minted for it.
    tenantTestClass = await prisma.tenant.create({
      data: { slug: TEST_CLASS_SLUG, name: TEST_CLASS_SLUG, status: "ACTIVE", class: "TEST" },
    });
  });

  afterAll(async () => {
    const tenantIds = [tenantNoSub.id, tenantPartial.id, tenantTestClass.id];
    await prisma.billingEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.tenant.deleteMany({ where: { slug: { in: ALL_SLUGS } } });
    await prisma.$disconnect();
    await pool.end();
  });

  it("dry run makes no writes", async () => {
    execSync(`node ${CLI}`, { encoding: "utf-8", env: { ...process.env, DATABASE_URL: dbUrl } });

    const sub = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantNoSub.id },
    });
    expect(sub).toBeNull();
    const partial = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantPartial.id },
    });
    expect(partial?.planKey).toBeNull();
  });

  it("apply creates a missing subscription and backfills a partial one, excluding TEST class", async () => {
    execSync(`node ${CLI} --apply`, {
      encoding: "utf-8",
      env: { ...process.env, DATABASE_URL: dbUrl },
    });

    const created = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantNoSub.id },
    });
    expect(created?.planKey).toBe("STARTER");
    expect(String(created?.basePriceSnapshot)).toBe(starterPrice);

    const backfilled = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantPartial.id },
    });
    // PROFESSIONAL maps to SCALE (v8 rename — same mapping planKeyFromEnum already uses).
    expect(backfilled?.planKey).toBe("SCALE");
    expect(String(backfilled?.basePriceSnapshot)).toBe(scalePrice);

    const testClassSub = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantTestClass.id },
    });
    expect(testClassSub).toBeNull();

    const events = await prisma.billingEvent.findMany({
      where: { tenantId: { in: [tenantNoSub.id, tenantPartial.id] } },
    });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.type).sort()).toEqual([
      "reconciliation.snapshot_backfilled",
      "reconciliation.subscription_created",
    ]);
  });

  it("a second apply is idempotent — no duplicate BillingEvent rows for this file's own tenants", async () => {
    execSync(`node ${CLI} --apply`, {
      encoding: "utf-8",
      env: { ...process.env, DATABASE_URL: dbUrl },
    });

    const events = await prisma.billingEvent.findMany({
      where: { tenantId: { in: [tenantNoSub.id, tenantPartial.id] } },
    });
    // Still exactly 2 — both subscriptions now have planKey + basePriceSnapshot set, so
    // neither is flagged as a "change" on the second scan.
    expect(events).toHaveLength(2);
  });
});
