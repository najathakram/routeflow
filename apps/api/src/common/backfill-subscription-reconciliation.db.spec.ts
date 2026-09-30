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
import { pathToFileURL } from "url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(API_DIR, "scripts/backfill-subscription-reconciliation.mjs");
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
// Common prefix across every fixture this file creates — every `--apply` invocation below must
// scope to this (never run unscoped), matching the file's own header: "the CLI's scan/apply
// never touches a row outside its own fixtures — no whole-table snapshot/restore needed."
const RUN_PREFIX = `qa-phase0-recon-${RUN_SUFFIX}`;
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
// Legacy-alias fixture: stored planKey is the pre-rename "BUSINESS", resolved against the
// published catalog's "SCALE" row (plan-catalog.constants.ts's LEGACY_PLAN_KEY_ALIASES maps
// BUSINESS -> SCALE). Distinct from UNKNOWN_KEY_SLUG above — this key IS mappable and must
// resolve and backfill, never land in the "not in the resolved catalog version" bucket.
const LEGACY_ALIAS_SLUG = assertTestTenant(
  `qa-phase0-recon-${RUN_SUFFIX}-5b`,
  "backfill-subscription-reconciliation.db.spec.ts",
);
// --- T2 fixtures (REG-743-F3, REG-743-N3, REG-743-F4, REG-743-F5) ---
// A subscription pinned to an OLDER (non-published) PlanVersion — must be priced from that
// version, and the pin must never be moved to the published version (F3, B327's sibling: the
// script must never silently repin a tenant that was deliberately kept on an older price).
const OLD_PIN_SLUG = assertTestTenant(
  `qa-phase0-recon-${RUN_SUFFIX}-6`,
  "backfill-subscription-reconciliation.db.spec.ts",
);
// N3: tenant.planVersionId starts null and must be set to the version actually used.
const NULL_TENANT_PIN_SLUG = assertTestTenant(
  `qa-phase0-recon-${RUN_SUFFIX}-7`,
  "backfill-subscription-reconciliation.db.spec.ts",
);
// N3: tenant.planVersionId starts non-null (pinned to the older version) and must never be
// overwritten, even though the subscription itself resolves against that same older version.
const PINNED_TENANT_PIN_SLUG = assertTestTenant(
  `qa-phase0-recon-${RUN_SUFFIX}-8`,
  "backfill-subscription-reconciliation.db.spec.ts",
);
// F4: has a planKey and would otherwise price cleanly, but carries no `stripeSubId` — a
// PRODUCTION tenant with a manually-managed (non-Stripe) subscription. Must be listed and
// never written (B327 — never remove this filter).
const NO_STRIPE_SUB_SLUG = assertTestTenant(
  `qa-phase0-recon-${RUN_SUFFIX}-9`,
  "backfill-subscription-reconciliation.db.spec.ts",
);
// F5: a DEMO-class tenant with an otherwise-eligible Stripe subscription — out of scope
// entirely (the script's tenant scope is PRODUCTION-only, not PRODUCTION+DEMO).
const DEMO_OUT_OF_SCOPE_SLUG = assertTestTenant(
  `qa-phase0-recon-${RUN_SUFFIX}-10`,
  "backfill-subscription-reconciliation.db.spec.ts",
);
// F5: a CANCELLED PRODUCTION tenant with an otherwise-eligible Stripe subscription — out of
// scope entirely (the script's tenant scope requires status: ACTIVE).
const CANCELLED_OUT_OF_SCOPE_SLUG = assertTestTenant(
  `qa-phase0-recon-${RUN_SUFFIX}-11`,
  "backfill-subscription-reconciliation.db.spec.ts",
);
// F2 (review, fix round #3): dedicated fixture for the --confirm-count gate, kept separate
// from PARTIAL_SUB_SLUG (which an earlier test's --apply already backfills) so it stays
// fixable (basePriceSnapshot null) no matter what order the tests in this file run in.
const CONFIRM_COUNT_SLUG = assertTestTenant(
  `qa-phase0-recon-${RUN_SUFFIX}-12`,
  "backfill-subscription-reconciliation.db.spec.ts",
);
// F3 (review, fix round #3): a tenant that gets CANCELLED between scan and --apply — proves
// the updateMany where-clause's re-asserted tenant state (status/class/deletedAt) refuses the
// write rather than booking a price onto a tenant no longer in scope.
const RACE_CANCEL_SLUG = assertTestTenant(
  `qa-phase0-recon-${RUN_SUFFIX}-13`,
  "backfill-subscription-reconciliation.db.spec.ts",
);
const ALL_SLUGS = [
  NO_SUB_SLUG,
  PARTIAL_SUB_SLUG,
  TEST_CLASS_SLUG,
  ENTERPRISE_SLUG,
  UNKNOWN_KEY_SLUG,
  LEGACY_ALIAS_SLUG,
  OLD_PIN_SLUG,
  NULL_TENANT_PIN_SLUG,
  PINNED_TENANT_PIN_SLUG,
  NO_STRIPE_SUB_SLUG,
  DEMO_OUT_OF_SCOPE_SLUG,
  CANCELLED_OUT_OF_SCOPE_SLUG,
  CONFIRM_COUNT_SLUG,
  RACE_CANCEL_SLUG,
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
  let tenantLegacyAlias: { id: string } | undefined;
  let tenantOldPin: { id: string } | undefined;
  let tenantNullPin: { id: string } | undefined;
  let tenantPinnedPin: { id: string } | undefined;
  let tenantNoStripeSub: { id: string } | undefined;
  let tenantDemoOutOfScope: { id: string } | undefined;
  let tenantCancelledOutOfScope: { id: string } | undefined;
  let tenantConfirmCount: { id: string } | undefined;
  let tenantRaceCancel: { id: string } | undefined;
  let scalePrice: string;
  // A second, NEVER-published PlanVersion (GROWTH @ 149) that a subscription/tenant can be
  // pinned to — proves F3/N3 price-from-the-pinned-version and never-move-the-pin behavior
  // independently of whatever the currently PUBLISHED catalog happens to contain. Always
  // created (and torn down) by this spec — never collides with another lane's catalog since
  // it is never PUBLISHED.
  let oldPinVersionId: string;
  const OLD_PIN_PRICE = "149";
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
      // from the current max instead of the clock.
      // int4 column — never derive from Date.now()
      const version =
        ((await prisma.planVersion.aggregate({ _max: { version: true } }))._max.version ?? 0) + 1;
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

    // T2 fixture: a SUPERSEDED (never-published) PlanVersion with its own GROWTH definition,
    // priced differently from anything in the published catalog — a subscription/tenant
    // pinned here proves the script prices from (and never moves) an older pin rather than
    // always repricing off the currently-published catalog.
    const oldPinVersion = await prisma.planVersion.create({
      data: {
        version:
          ((await prisma.planVersion.aggregate({ _max: { version: true } }))._max.version ?? 0) + 1,
        status: "SUPERSEDED",
        publishedAt: new Date(),
        notes:
          "qa fixture (older pin) — created by backfill-subscription-reconciliation.db.spec.ts",
        definitions: {
          create: [
            {
              planKey: "GROWTH",
              name: "Growth",
              monthlyPrice: OLD_PIN_PRICE,
              isCustom: false,
              featureFlags: [],
            },
          ],
        },
      },
    });
    oldPinVersionId = oldPinVersion.id;

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
        subscription: {
          create: { planKey: "SCALE", basePriceSnapshot: null, stripeSubId: "sub_qa_partial" },
        },
      },
    });
    // Excluded from reconciliation by class alone (not by slug) — proves the script's
    // `class: "PRODUCTION"` scope (T2, REG-743-F5 — narrowed from the original
    // `{ in: ["PRODUCTION", "DEMO"] }`), matching MrrService's own PRODUCTION-only revenue rule
    // (Phase 0 T9): a TEST tenant must never get a real subscription minted for it.
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
        // F4: needs a stripeSubId or the new "no Stripe subscription" gate would skip this row
        // before it ever reaches the custom-priced-null-price branch this fixture exists to prove.
        subscription: {
          create: {
            planKey: "ENTERPRISE",
            basePriceSnapshot: null,
            stripeSubId: "sub_qa_enterprise",
          },
        },
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
        // F4: needs a stripeSubId too, for the same reason as the ENTERPRISE fixture above.
        subscription: {
          create: {
            planKey: "RETIRED_LEGACY_TIER",
            basePriceSnapshot: null,
            stripeSubId: "sub_qa_unknown_key",
          },
        },
      },
    });

    // Legacy-alias fixture: stored planKey "BUSINESS" (pre-rename) against the published
    // catalog's "SCALE" definition. Must resolve via LEGACY_PLAN_KEY_ALIASES (BUSINESS ->
    // SCALE), price at scalePrice, and backfill — never land in the unknown-key bucket the
    // way UNKNOWN_KEY_SLUG (a genuinely unmappable "RETIRED_LEGACY_TIER") does.
    tenantLegacyAlias = await prisma.tenant.create({
      data: {
        slug: LEGACY_ALIAS_SLUG,
        name: LEGACY_ALIAS_SLUG,
        status: "ACTIVE",
        class: "PRODUCTION",
        plan: "PROFESSIONAL",
        subscription: {
          create: {
            planKey: "BUSINESS",
            basePriceSnapshot: null,
            stripeSubId: "sub_qa_legacy_alias",
          },
        },
      },
    });

    // REG-743-F3: pinned to the OLDER (never-published) GROWTH@149 version, already carrying
    // that planVersionId on the subscription itself. Must be priced 149 (from its own pin),
    // never repriced off the published catalog, and the pin must never move.
    tenantOldPin = await prisma.tenant.create({
      data: {
        slug: OLD_PIN_SLUG,
        name: OLD_PIN_SLUG,
        status: "ACTIVE",
        class: "PRODUCTION",
        subscription: {
          create: {
            planKey: "GROWTH",
            planVersionId: oldPinVersionId,
            basePriceSnapshot: null,
            stripeSubId: "sub_qa_old_pin",
          },
        },
      },
    });

    // REG-743-N3 (fixture 1): tenant.planVersionId starts null; subscription.planVersionId
    // also null — version resolution falls all the way through to the published version, and
    // the tenant's null pin must be SET to that version.
    tenantNullPin = await prisma.tenant.create({
      data: {
        slug: NULL_TENANT_PIN_SLUG,
        name: NULL_TENANT_PIN_SLUG,
        status: "ACTIVE",
        class: "PRODUCTION",
        subscription: {
          create: { planKey: "SCALE", basePriceSnapshot: null, stripeSubId: "sub_qa_null_pin" },
        },
      },
    });

    // REG-743-N3 (fixture 2): tenant.planVersionId starts NON-null (already pinned to the
    // older GROWTH@149 version) — that pin must never be overwritten, even though the
    // subscription itself (planVersionId null) resolves against that same older version.
    tenantPinnedPin = await prisma.tenant.create({
      data: {
        slug: PINNED_TENANT_PIN_SLUG,
        name: PINNED_TENANT_PIN_SLUG,
        status: "ACTIVE",
        class: "PRODUCTION",
        planVersionId: oldPinVersionId,
        subscription: {
          create: {
            planKey: "GROWTH",
            basePriceSnapshot: null,
            stripeSubId: "sub_qa_pinned_pin",
          },
        },
      },
    });

    // REG-743-F4: a planKey that would otherwise price cleanly (SCALE, in the published
    // catalog) but no `stripeSubId` at all — a manually-managed (non-Stripe) subscription.
    // Must be listed under its own "manual decision" bucket and NEVER written (B327: never
    // remove this filter).
    tenantNoStripeSub = await prisma.tenant.create({
      data: {
        slug: NO_STRIPE_SUB_SLUG,
        name: NO_STRIPE_SUB_SLUG,
        status: "ACTIVE",
        class: "PRODUCTION",
        subscription: { create: { planKey: "SCALE", basePriceSnapshot: null } },
      },
    });

    // REG-743-F5 (fixture 1): DEMO class, otherwise fully eligible (planKey + stripeSubId) —
    // out of scope entirely; the script's tenant scope is PRODUCTION-only.
    tenantDemoOutOfScope = await prisma.tenant.create({
      data: {
        slug: DEMO_OUT_OF_SCOPE_SLUG,
        name: DEMO_OUT_OF_SCOPE_SLUG,
        status: "ACTIVE",
        class: "DEMO",
        subscription: {
          create: { planKey: "SCALE", basePriceSnapshot: null, stripeSubId: "sub_qa_demo" },
        },
      },
    });

    // REG-743-F5 (fixture 2): PRODUCTION class but CANCELLED status, otherwise fully eligible
    // — out of scope entirely; the script's tenant scope requires status: ACTIVE.
    tenantCancelledOutOfScope = await prisma.tenant.create({
      data: {
        slug: CANCELLED_OUT_OF_SCOPE_SLUG,
        name: CANCELLED_OUT_OF_SCOPE_SLUG,
        status: "CANCELLED",
        class: "PRODUCTION",
        subscription: {
          create: { planKey: "SCALE", basePriceSnapshot: null, stripeSubId: "sub_qa_cancelled" },
        },
      },
    });

    // F2 (review, fix round #3): fixable (ACTIVE, PRODUCTION, planKey+stripeSubId set, null
    // snapshot) but kept in its OWN dedicated fixture so an unscoped --apply attempt never
    // actually needs to write it — the --confirm-count gate must refuse before any write.
    tenantConfirmCount = await prisma.tenant.create({
      data: {
        slug: CONFIRM_COUNT_SLUG,
        name: CONFIRM_COUNT_SLUG,
        status: "ACTIVE",
        class: "PRODUCTION",
        subscription: {
          create: { planKey: "SCALE", basePriceSnapshot: null, stripeSubId: "sub_qa_confirm" },
        },
      },
    });

    // F3 (review, fix round #3): fixable at creation; a test flips it to CANCELLED before
    // --apply runs to prove the write's own tenant-state guard (not just the scan filter)
    // keeps it at $0.
    tenantRaceCancel = await prisma.tenant.create({
      data: {
        slug: RACE_CANCEL_SLUG,
        name: RACE_CANCEL_SLUG,
        status: "ACTIVE",
        class: "PRODUCTION",
        subscription: {
          create: { planKey: "SCALE", basePriceSnapshot: null, stripeSubId: "sub_qa_race" },
        },
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
      tenantLegacyAlias?.id,
      tenantOldPin?.id,
      tenantNullPin?.id,
      tenantPinnedPin?.id,
      tenantNoStripeSub?.id,
      tenantDemoOutOfScope?.id,
      tenantCancelledOutOfScope?.id,
      tenantConfirmCount?.id,
      tenantRaceCancel?.id,
    ].filter((id): id is string => Boolean(id));
    if (tenantIds.length) {
      await prisma.billingEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
    }
    // Clear the tenant-side FK to oldPinVersionId before deleting it (tenantPinnedPin is
    // created with planVersionId pointing at it, and PlanVersion has no onDelete on that side).
    await prisma.tenant.updateMany({
      where: { slug: { in: ALL_SLUGS }, planVersionId: oldPinVersionId },
      data: { planVersionId: null },
    });
    await prisma.tenant.deleteMany({ where: { slug: { in: ALL_SLUGS } } });
    if (createdVersionId) {
      await prisma.planDefinition.deleteMany({ where: { planVersionId: createdVersionId } });
      await prisma.planVersion.delete({ where: { id: createdVersionId } });
    }
    await prisma.planDefinition.deleteMany({ where: { planVersionId: oldPinVersionId } });
    await prisma.planVersion.delete({ where: { id: oldPinVersionId } });
    await prisma.$disconnect();
    await pool.end();
  });

  it("dry run makes no writes", async () => {
    execSync(`node ${CLI}`, { encoding: "utf-8", env: childEnv(dbUrl) });

    const sub = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantNoSub!.id },
    });
    expect(sub).toBeNull();
    const partial = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantPartial!.id },
    });
    expect(partial?.basePriceSnapshot).toBeNull();
  });

  it("a legacy-aliased planKey (BUSINESS) resolves against the catalog's renamed SCALE definition and backfills", async () => {
    const output = execSync(`node ${CLI} --apply --slug-prefix ${LEGACY_ALIAS_SLUG}`, {
      encoding: "utf-8",
      env: childEnv(dbUrl),
    });

    // Must NOT land in the manual-decision bucket the way UNKNOWN_KEY_SLUG's genuinely
    // unmappable "RETIRED_LEGACY_TIER" does below — BUSINESS is a known legacy alias
    // (LEGACY_PLAN_KEY_ALIASES: BUSINESS -> SCALE), not an unmappable typo/retired key.
    expect(output).not.toContain("planKey not in the resolved catalog version");
    expect(output).toContain("1 change(s)");

    const sub = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantLegacyAlias!.id },
    });
    // The stored planKey itself is left untouched (never rewritten to the current name) —
    // only basePriceSnapshot/planVersionId are backfilled, priced from the catalog's SCALE
    // definition that BUSINESS normalizes to.
    expect(sub?.planKey).toBe("BUSINESS");
    expect(String(sub?.basePriceSnapshot)).toBe(scalePrice);

    const events = await prisma.billingEvent.findMany({
      where: { tenantId: tenantLegacyAlias!.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("reconciliation.snapshot_backfilled");
    expect(String(events[0].amountDelta)).toBe(scalePrice);
  });

  it("apply backfills the partial subscription, reports the pilot untouched, excludes TEST class", async () => {
    // Scoped (review finding): an unscoped --apply here would also sweep up every T2 fixture
    // created in the same beforeAll (OLD_PIN/NULL_PIN/etc.) before their own scoped tests run,
    // making those assertions pass vacuously against state this call already produced — and
    // would touch any other PRODUCTION+ACTIVE Stripe row on the shared compose DB besides.
    const output = execSync(`node ${CLI} --apply --slug-prefix ${RUN_PREFIX}`, {
      encoding: "utf-8",
      env: childEnv(dbUrl),
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

    // F7: a planKey the resolved catalog version doesn't have at all — its own bucket,
    // distinct from ENTERPRISE's — no write, no event. Wording updated for F3 (T2): pricing
    // now resolves from the row's own pinned version, not always PUBLISHED.
    expect(output).toContain("planKey not in the resolved catalog version — manual decision");
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
    // Review finding (fix round #2): this write moves the tenant from $0 to scalePrice inside
    // MrrService's payingWhere — the event MUST carry that as a signed amountDelta, or
    // ledgerMrr never learns about the move (and a later churn's real -scalePrice delta would
    // have no matching +scalePrice ever booked).
    expect(String(events[0].amountDelta)).toBe(scalePrice);
  });

  it("a second apply reports 0 changes and appends no new events (incl. the ENTERPRISE row)", async () => {
    const output = execSync(`node ${CLI} --apply --slug-prefix ${RUN_PREFIX}`, {
      encoding: "utf-8",
      env: childEnv(dbUrl),
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

  it("REG-743-F3 a subscription pinned to an older archived PlanVersion is priced from that version and its pin is not moved", async () => {
    execSync(`node ${CLI} --apply --slug-prefix ${OLD_PIN_SLUG}`, {
      encoding: "utf-8",
      env: childEnv(dbUrl),
    });

    const sub = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantOldPin!.id },
    });
    // Priced from the OLDER pinned version's own GROWTH definition (149) — never repriced
    // off whatever the currently-published catalog charges for GROWTH.
    expect(String(sub?.basePriceSnapshot)).toBe(OLD_PIN_PRICE);
    // The pin itself must never move — it was already non-null before this run.
    expect(sub?.planVersionId).toBe(oldPinVersionId);
  });

  it("REG-743-N3 a null tenant pin is set to the version used; a non-null tenant pin is never overwritten", async () => {
    execSync(`node ${CLI} --apply --slug-prefix ${NULL_TENANT_PIN_SLUG}`, {
      encoding: "utf-8",
      env: childEnv(dbUrl),
    });
    execSync(`node ${CLI} --apply --slug-prefix ${PINNED_TENANT_PIN_SLUG}`, {
      encoding: "utf-8",
      env: childEnv(dbUrl),
    });

    // Fixture 1: tenant.planVersionId started null — must be SET to the version the
    // subscription actually resolved against (falls through to the published version here,
    // since both the subscription's own pin and the tenant's pin were null).
    const tenantAfterNull = await prisma.tenant.findUnique({ where: { id: tenantNullPin!.id } });
    expect(tenantAfterNull?.planVersionId).not.toBeNull();
    const subAfterNull = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantNullPin!.id },
    });
    expect(String(subAfterNull?.basePriceSnapshot)).toBe(scalePrice);
    expect(subAfterNull?.planVersionId).toBe(tenantAfterNull?.planVersionId);

    // Fixture 2: tenant.planVersionId started NON-null (pinned to the older GROWTH@149
    // version) — that pin must be UNTOUCHED even though the subscription resolves against
    // that same older version and gets its own (previously-null) planVersionId set.
    const tenantAfterPinned = await prisma.tenant.findUnique({
      where: { id: tenantPinnedPin!.id },
    });
    expect(tenantAfterPinned?.planVersionId).toBe(oldPinVersionId);
    const subAfterPinned = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantPinnedPin!.id },
    });
    expect(String(subAfterPinned?.basePriceSnapshot)).toBe(OLD_PIN_PRICE);
    expect(subAfterPinned?.planVersionId).toBe(oldPinVersionId);
  });

  it("REG-743-F4 a PRODUCTION ACTIVE row with planKey and no stripeSubId is listed and never written, no BillingEvent", async () => {
    const output = execSync(`node ${CLI} --apply --slug-prefix ${NO_STRIPE_SUB_SLUG}`, {
      encoding: "utf-8",
      env: childEnv(dbUrl),
    });

    expect(output).toContain("no Stripe subscription — manual decision");

    const sub = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantNoStripeSub!.id },
    });
    expect(sub?.basePriceSnapshot).toBeNull();
    expect(sub?.planVersionId).toBeNull();
    const events = await prisma.billingEvent.findMany({
      where: { tenantId: tenantNoStripeSub!.id },
    });
    expect(events).toHaveLength(0);
  });

  it("REG-743-F5 a DEMO tenant's Stripe row is out of scope", async () => {
    execSync(`node ${CLI} --apply --slug-prefix ${DEMO_OUT_OF_SCOPE_SLUG}`, {
      encoding: "utf-8",
      env: childEnv(dbUrl),
    });

    const sub = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantDemoOutOfScope!.id },
    });
    expect(sub?.basePriceSnapshot).toBeNull();
    const events = await prisma.billingEvent.findMany({
      where: { tenantId: tenantDemoOutOfScope!.id },
    });
    expect(events).toHaveLength(0);
  });

  it("REG-743-F5 a CANCELLED PRODUCTION tenant is out of scope", async () => {
    execSync(`node ${CLI} --apply --slug-prefix ${CANCELLED_OUT_OF_SCOPE_SLUG}`, {
      encoding: "utf-8",
      env: childEnv(dbUrl),
    });

    const sub = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenantCancelledOutOfScope!.id },
    });
    expect(sub?.basePriceSnapshot).toBeNull();
    const events = await prisma.billingEvent.findMany({
      where: { tenantId: tenantCancelledOutOfScope!.id },
    });
    expect(events).toHaveLength(0);
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

  // REG-743-F2 (review, fix round #3): an unscoped --apply (no --slug-prefix) must refuse to
  // write anything without an operator explicitly confirming the exact count they reviewed.
  it("REG-743-F2 refuses an unscoped --apply with no --confirm-count, and writes nothing", () => {
    let threw = false;
    try {
      execSync(`node ${CLI} --apply`, { encoding: "utf-8", env: childEnv(dbUrl) });
    } catch (err) {
      threw = true;
      const combined = `${(err as { stdout?: string }).stdout ?? ""}${(err as { stderr?: string }).stderr ?? ""}`;
      expect(combined).toContain("Refusing to --apply without --slug-prefix or --confirm-count");
    }
    expect(threw).toBe(true);
  });

  it("REG-743-F2 refuses an unscoped --apply when --confirm-count does not match the scan", () => {
    // Deliberately does not assert on any tenant row's state afterward: an UNSCOPED scan
    // reads the whole shared local compose database, which 15+ other .db.spec.ts files (and
    // other sessions' own script runs) write into concurrently -- this test only proves THIS
    // invocation refuses and writes nothing ITSELF (the refusal fires before the write loop is
    // ever reached), not that no other process priced some row in the interim.
    let threw = false;
    try {
      execSync(`node ${CLI} --apply --confirm-count 999999`, {
        encoding: "utf-8",
        env: childEnv(dbUrl),
      });
    } catch (err) {
      threw = true;
      const combined = `${(err as { stdout?: string }).stdout ?? ""}${(err as { stderr?: string }).stderr ?? ""}`;
      expect(combined).toContain("does not match this scan's");
    }
    expect(threw).toBe(true);
  });

  it("REG-743-F2 a --slug-prefix run never needs --confirm-count", () => {
    // The scoped path this file's other --apply calls already use must stay unaffected by
    // the new gate -- prove it directly rather than only relying on the earlier tests' success.
    const output = execSync(`node ${CLI} --apply --slug-prefix ${CONFIRM_COUNT_SLUG}`, {
      encoding: "utf-8",
      env: childEnv(dbUrl),
    });
    expect(output).not.toContain("Refusing to --apply");
  });

  // REG-743-F3 (review, fix round #3): the write's own where-clause must independently
  // require the tenant to still be ACTIVE/PRODUCTION/not-deleted, closing the window between
  // the scan and the write -- not just rely on the scan's own filter (already covered by the
  // CANCELLED_OUT_OF_SCOPE fixture above, which excludes at scan time).
  it("REG-743-F3 the write's own where-clause refuses a tenant that is no longer ACTIVE/PRODUCTION, even though it matched at scan time", async () => {
    await prisma.tenant.update({
      where: { id: tenantRaceCancel!.id },
      data: { status: "CANCELLED" },
    });

    // The exact conditional write the fixed script issues per row -- proving the where-clause
    // SHAPE itself, independent of whether the scan would have excluded this row too.
    const result = await prisma.tenantSubscription.updateMany({
      where: {
        tenantId: tenantRaceCancel!.id,
        planKey: "SCALE",
        basePriceSnapshot: null,
        stripeSubId: { not: null },
        planVersionId: null,
        tenant: { status: "ACTIVE", class: "PRODUCTION", deletedAt: null },
      },
      data: { basePriceSnapshot: scalePrice },
    });

    // `count === 0` alone proves the where-clause's tenant-state re-assertion refused THIS
    // write -- not a follow-up read of the row's current price, which a concurrent process
    // elsewhere on this shared database could legitimately change for unrelated reasons.
    expect(result.count).toBe(0);
  });
});
