/**
 * DB-lane spec for `../../scripts/backfill-subscription-reconciliation.mjs` — proves the
 * dry-run/apply mechanics against a REAL Postgres. F2/F3 (Phase 0 fix round 1): the script
 * NEVER invents a subscription and NEVER re-derives a planKey from the legacy `plan` enum — a
 * tenant with no subscription row (a free pilot) is only ever reported, and a plan the catalog
 * prices at null (ENTERPRISE) is skipped idempotently. Lives under `src/common` (not next to
 * the script under `scripts/`) because `jest.db.config.js` inherits `rootDir: "src"` from the
 * base Jest config — a spec under `apps/api/scripts/` would never be discovered by `npm run
 * local:test:db`, matching the sibling precedent `backfill-tenant-class.db.spec.ts`.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * SAFETY: all fixture slugs are `assertTestTenant`-approved (`qa-` prefix). Their `class` is
 * set DIRECTLY at creation to PRODUCTION/TEST rather than derived from the slug — the CLI reads
 * whatever `class` a tenant already carries, and this file never runs the class backfill
 * against these rows, so a qa-prefixed slug carrying `class: PRODUCTION` here does not
 * conflict with `classifyTenantSlug`'s independent slug->class mapping.
 *
 * Catalog self-provisioning: prefers a PUBLISHED PlanVersion that already exists (the compose
 * DB after `local:seed`'s genesis step) so it never collides with another lane's catalog
 * version. On a fresh CI database with no catalog at all (the "Replay migrations on a fresh
 * database" job), it creates a minimal one itself — SCALE (a real monthly price) and
 * ENTERPRISE (null price, custom) — and deletes exactly that version's definitions and the
 * version in `afterAll`, never touching a pre-existing catalog. No other `*.db.spec.ts` in this
 * repo reads a PUBLISHED PlanVersion (checked via grep across `apps/api/src`), so creating one
 * mid-run here cannot change another spec's observed catalog state.
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
const ENTERPRISE_SLUG = assertTestTenant(
  `qa-phase0-recon-${RUN_SUFFIX}-4`,
  "backfill-subscription-reconciliation.db.spec.ts",
);
// F7 (review): a planKey that isn't in the published catalog at all (a retired key, a typo,
// or one the catalog hasn't caught up to) — distinct from ENTERPRISE's catalog-known null
// price. `planKey` is a free string column (not a Prisma enum), so a stale value like this is
// a real reachable state and needs its own fixture.
const UNKNOWN_KEY_SLUG = assertTestTenant(
  `qa-phase0-recon-${RUN_SUFFIX}-5`,
  "backfill-subscription-reconciliation.db.spec.ts",
);
const ALL_SLUGS = [
  NO_SUB_SLUG,
  PARTIAL_SUB_SLUG,
  TEST_CLASS_SLUG,
  ENTERPRISE_SLUG,
  UNKNOWN_KEY_SLUG,
];

describeDb("backfill-subscription-reconciliation.mjs (db)", () => {
  const dbUrl = requireLocalDatabaseUrl();
  const pool = new Pool({ connectionString: dbUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  let tenantNoSub: { id: string } | undefined;
  let tenantPartial: { id: string } | undefined;
  let tenantTestClass: { id: string } | undefined;
  let tenantEnterprise: { id: string } | undefined;
  let tenantUnknownKey: { id: string } | undefined;
  let scalePrice: string;
  // Set only when this spec created the catalog itself (no PUBLISHED PlanVersion existed) —
  // afterAll deletes exactly this version's rows and nothing else.
  let createdVersionId: string | undefined;

  beforeAll(async () => {
    let publishedVersion = await prisma.planVersion.findFirst({
      where: { status: "PUBLISHED" },
      include: { definitions: true },
    });

    if (!publishedVersion) {
      // Fresh CI database (the "Replay migrations on a fresh database" job) has no catalog
      // at all — `local:seed`'s genesis publish step never ran here. Create the minimum
      // catalog this spec needs rather than failing: a PUBLISHED version with a real-priced
      // SCALE definition and a null-priced ENTERPRISE definition, mirroring the shape
      // `publish-plan-catalog-v11.ts` writes. `version` just needs to be unique — derive it
      // from the clock plus a random offset so parallel/retried runs never collide.
      const version = Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 1000);
      publishedVersion = await prisma.planVersion.create({
        data: {
          version,
          status: "PUBLISHED",
          publishedAt: new Date(),
          notes: "qa fixture — created by backfill-subscription-reconciliation.db.spec.ts",
          definitions: {
            create: [
              {
                planKey: "SCALE",
                name: "Scale",
                monthlyPrice: 249,
                isCustom: false,
                featureFlags: [],
              },
              {
                planKey: "ENTERPRISE",
                name: "Enterprise",
                monthlyPrice: null,
                isCustom: true,
                featureFlags: [],
              },
            ],
          },
        },
        include: { definitions: true },
      });
      createdVersionId = publishedVersion.id;
    }

    scalePrice = String(
      publishedVersion.definitions.find((d) => d.planKey === "SCALE")?.monthlyPrice,
    );

    // Pilot-like: PRODUCTION, ACTIVE, no subscription row at all — must be reported and
    // NEVER written (F2: the script never invents a subscription, or the free pilots would
    // become paying MRR on --apply).
    tenantNoSub = await prisma.tenant.create({
      data: { slug: NO_SUB_SLUG, name: NO_SUB_SLUG, status: "ACTIVE", class: "PRODUCTION" },
    });
    // Already has a planKey, missing only basePriceSnapshot (the one failure mode this
    // script still fixes — a Stripe-originated row created before the checkout webhook set
    // the price snapshot).
    tenantPartial = await prisma.tenant.create({
      data: {
        slug: PARTIAL_SUB_SLUG,
        name: PARTIAL_SUB_SLUG,
        status: "ACTIVE",
        class: "PRODUCTION",
        plan: "PROFESSIONAL",
        subscription: { create: { planKey: "SCALE", basePriceSnapshot: null } },
      },
    });
    // Excluded from reconciliation by class alone (not by slug) — proves the script's
    // `class: { in: ["PRODUCTION", "DEMO"] }` scope, matching MrrService's own PRODUCTION-only
    // revenue rule (Phase 0 T9): a TEST tenant must never get a real subscription minted for it.
    tenantTestClass = await prisma.tenant.create({
      data: { slug: TEST_CLASS_SLUG, name: TEST_CLASS_SLUG, status: "ACTIVE", class: "TEST" },
    });
    // ENTERPRISE: the published catalog prices it at null (custom, per-deal pricing) — F3:
    // skip idempotently, never write, never flagged again on a second run.
    tenantEnterprise = await prisma.tenant.create({
      data: {
        slug: ENTERPRISE_SLUG,
        name: ENTERPRISE_SLUG,
        status: "ACTIVE",
        class: "PRODUCTION",
        plan: "ENTERPRISE",
        subscription: { create: { planKey: "ENTERPRISE", basePriceSnapshot: null } },
      },
    });
    // F7: a planKey the published catalog has never heard of — must land in the "manual
    // decision" bucket, distinct from ENTERPRISE's known-null-price bucket, with no write and
    // no BillingEvent.
    tenantUnknownKey = await prisma.tenant.create({
      data: {
        slug: UNKNOWN_KEY_SLUG,
        name: UNKNOWN_KEY_SLUG,
        status: "ACTIVE",
        class: "PRODUCTION",
        plan: "ENTERPRISE",
        subscription: { create: { planKey: "RETIRED_LEGACY_TIER", basePriceSnapshot: null } },
      },
    });
  });

  afterAll(async () => {
    const tenantIds = [
      tenantNoSub?.id,
      tenantPartial?.id,
      tenantTestClass?.id,
      tenantEnterprise?.id,
      tenantUnknownKey?.id,
    ].filter((id): id is string => Boolean(id));
    if (tenantIds.length) {
      await prisma.billingEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
    }
    await prisma.tenant.deleteMany({ where: { slug: { in: ALL_SLUGS } } });
    if (createdVersionId) {
      await prisma.planDefinition.deleteMany({ where: { planVersionId: createdVersionId } });
      await prisma.planVersion.delete({ where: { id: createdVersionId } });
    }
    await prisma.$disconnect();
    await pool.end();
  });

  it("dry run makes no writes", async () => {
    execSync(`node ${CLI}`, { encoding: "utf-8", env: { ...process.env, DATABASE_URL: dbUrl } });

    const sub = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantNoSub!.id },
    });
    expect(sub).toBeNull();
    const partial = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantPartial!.id },
    });
    expect(partial?.basePriceSnapshot).toBeNull();
  });

  it("apply backfills the partial subscription, reports the pilot untouched, excludes TEST class", async () => {
    const output = execSync(`node ${CLI} --apply`, {
      encoding: "utf-8",
      env: { ...process.env, DATABASE_URL: dbUrl },
    });

    // F2: a pilot-like tenant (PRODUCTION class, no subscription) is reported — never
    // written — a real business becoming paying MRR just because this script ran.
    expect(output).toContain("no subscription — manual decision");
    const noSub = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantNoSub!.id },
    });
    expect(noSub).toBeNull();

    const backfilled = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantPartial!.id },
    });
    expect(backfilled?.planKey).toBe("SCALE");
    expect(String(backfilled?.basePriceSnapshot)).toBe(scalePrice);

    const testClassSub = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantTestClass!.id },
    });
    expect(testClassSub).toBeNull();

    // F3: ENTERPRISE (null catalog price) is reported "custom-priced (null price) —
    // skipped" and left untouched.
    expect(output).toContain("custom-priced (null price) — skipped");
    const enterpriseSub = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantEnterprise!.id },
    });
    expect(enterpriseSub?.basePriceSnapshot).toBeNull();

    // F7: a planKey the published catalog doesn't have at all — its own bucket, distinct
    // from ENTERPRISE's — no write, no event.
    expect(output).toContain("planKey not in the published catalog — manual decision");
    const unknownKeySub = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantUnknownKey!.id },
    });
    expect(unknownKeySub?.basePriceSnapshot).toBeNull();

    const events = await prisma.billingEvent.findMany({
      where: {
        tenantId: {
          in: [tenantNoSub!.id, tenantPartial!.id, tenantEnterprise!.id, tenantUnknownKey!.id],
        },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("reconciliation.snapshot_backfilled");
    expect(events[0].tenantId).toBe(tenantPartial!.id);
  });

  it("a second apply reports 0 changes and appends no new events (incl. the ENTERPRISE row)", async () => {
    const output = execSync(`node ${CLI} --apply`, {
      encoding: "utf-8",
      env: { ...process.env, DATABASE_URL: dbUrl },
    });

    expect(output).toContain("0 change(s)");

    const events = await prisma.billingEvent.findMany({
      where: {
        tenantId: {
          in: [tenantNoSub!.id, tenantPartial!.id, tenantEnterprise!.id, tenantUnknownKey!.id],
        },
      },
    });
    // Still exactly 1 (from the first apply) — the backfilled subscription now has a
    // basePriceSnapshot, so it's no longer flagged, and ENTERPRISE/unknown-key were never
    // flagged at all.
    expect(events).toHaveLength(1);
  });
});
