# Phase 0 — Truth, Hygiene, HQ Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every money number the platform admin shows true, and stand up the `routeflow-hq`
house tenant, before any later back-office phase builds on top of either.

**Architecture:** Backend-first. Add `Tenant.class` (dark, then filtered), widen `TenantPlan` to
include GROWTH/SCALE, replace `getStats()`'s MRR estimator with `MrrService.computeOverview()`
scoped to production tenants, reconcile every real tenant's `TenantSubscription` row via a
dry-run/apply script, fix the READ_ONLY quote allowlist and the OAuth device-info gap, then
bootstrap the `routeflow-hq` tenant and a `TenantMirrorService` that keeps one HQ `Customer` row
per real tenant in sync. Three small, targeted web changes (Create Tenant plan picker, tenant
list/detail plan display, dashboard/billing MRR fields) close the loop so what the admin *sees*
matches what the database now knows.

**Tech Stack:** NestJS 11 + Prisma 7 (schema folder) on the API; Next.js 15 App Router on the
web; Jest for unit and DB-lane specs; the local Docker compose stack for pre-push verification.

**Spec:** `docs/superpowers/specs/2026-09-12-backoffice-phase-0-truth-design.md` (this plan
implements it in full) and the parent `docs/superpowers/specs/2026-09-12-platform-backoffice-design.md`
for context on later phases this one unblocks.

## Global Constraints

- Money math: round every monetary write through `@routeflow/pricing`'s `roundMoney` (already
  used throughout `platform-admin.service.ts` and `mrr.service.ts` — keep using it, never
  reimplement rounding).
- Prisma schema is a FOLDER (`apps/api/prisma/schema/*.prisma`). Every new/changed model or enum
  goes in the domain file it belongs to; no new models this phase, so no `MODEL_DOMAIN` map
  change is needed, but run `node apps/api/scripts/split-prisma-schema.mjs --check` after the
  migration to confirm the invariants still hold.
- Scheduled jobs use `@LeaderCron(expr, "<area>.<method>")` only — never a bare `@Cron`.
- Every admin action that changes money state emits both an `AdminAuditAction` row (via
  `recordAdminAction`) and, when it moves a tenant into or out of the paying/production set, a
  `BillingEvent`.
- Test tenants: only `test`, `e2e-routeflow`, `routeflow-demo`, and `qa-*`/`e2e-*`/`ux-audit-*`
  slugs may ever be targeted by scripts/tests. `scripts/lib/test-tenants.cjs` is the source of
  truth for that pattern; the new tenant-class backfill must produce classifications consistent
  with it (TEST for everything that pattern matches except `routeflow-demo`, which is DEMO).
- No `--force-reset`, no destructive migrations without a `-- reason:` + `-- squawk-ignore`
  comment. Prod schema changes only via `railway run --service postgres node
  apps/api/scripts/prod-migrate.mjs`, after a fresh backup.
- Every PR passes `npm run verify` (check-types/lint/test) before push; DB-backed specs run via
  `npm run local:test:db` against the compose stack; no `SKIP_VERIFY` without a reason.
- Prettier: semicolons, double quotes, `printWidth` 100, trailing commas. Conventional Commit
  messages (`feat|fix|test|docs|chore|refactor`).
- Never reference a live client tenant slug/name in code, tests, or fixtures — use `acme`-style
  placeholders.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/prisma/schema/tenancy.prisma` | Modify: add `TenantClass` enum, `Tenant.class` field; widen `TenantPlan` enum with `GROWTH`, `SCALE` |
| `apps/api/prisma/schema/sales.prisma` | Modify: add `Customer.representsTenantId` (nullable, unique) |
| `apps/api/prisma/migrations/<ts>_backoffice_phase0_truth/migration.sql` | Create: the one migration covering all three schema changes above |
| `apps/api/src/common/tenant-class.util.ts` | Create: pure `classifyTenantSlug(slug): TenantClass` classification logic, shared by the backfill script and the class-change endpoint's validation |
| `apps/api/src/common/tenant-class.util.spec.ts` | Create: unit tests for the classifier |
| `apps/api/src/auth/device-info.util.ts` | Create: promote `extractDeviceInfo(req)` out of `AuthController` into a shared, exported function |
| `apps/api/src/auth/auth.controller.ts` | Modify: import and use the promoted `extractDeviceInfo` (no behavior change, just the extraction) |
| `apps/api/src/auth/auth.service.ts` | Modify: `DeviceInfo` type already exported here — no change needed beyond what's already there |
| `apps/api/src/auth/google-oauth.service.ts` | Modify: thread an optional `DeviceInfo` through `findOrCreateUser` → `handlePlatformAuth`/`handleTenantAuth` → `issueUserTokenPair` → `storeUserRefreshToken`, which gains `userAgent`/`ipAddress` columns on create/update |
| `apps/api/src/auth/platform-google-auth.controller.ts` | Modify: accept `@Req()`, extract device info, pass it into `findOrCreateUser` |
| `apps/api/src/tenant/tenant-status.guard.ts` | Modify: add `POST /api/v1/billing/quote` to the READ_ONLY allowlist |
| `apps/api/src/tenant/tenant-status.guard.spec.ts` | Modify: add the repro test (fails before the fix, passes after) |
| `apps/api/src/billing/plan-catalog.constants.ts` | Modify: add `TRIAL_LENGTH_DAYS = 14` |
| `apps/api/src/tenants/tenants.service.ts` | Modify: use `TRIAL_LENGTH_DAYS` instead of the inline `14` |
| `apps/api/src/platform-admin/dto/create-tenant.dto.ts` | Modify: validate `plan` against live `PLAN_KEYS`, add optional `trialLengthDays` |
| `apps/api/src/platform-admin/dto/update-tenant-class.dto.ts` | Create: `{ class: TenantClass; reason: string }` |
| `apps/api/src/platform-admin/audit-actions.constant.ts` | Modify: add `TENANT_CLASS_CHANGED` code + label |
| `apps/api/src/platform-admin/platform-admin.service.ts` | Modify: `createTenant` (trial length + plan validation), `getStats()` (call `MrrService` instead of the estimator, add `ledgerMrr`, add `class` to responses), add `updateTenantClass()` |
| `apps/api/src/platform-admin/platform-admin.controller.ts` | Modify: add `PATCH /platform-admin/tenants/:id/class`; add `includeClasses` query param |
| `apps/api/src/platform-admin/platform-admin.service.spec.ts` | Modify: update `getStats()` tests for the new MRR source; add tests for `updateTenantClass` |
| `apps/api/src/platform-admin/platform-config.service.ts` | Modify: add `getHouseTenantId()`/`setHouseTenantId()` wrappers over the existing `getValue`/`setValue` |
| `apps/api/src/platform-admin/tenant-mirror.service.ts` | Create: `TenantMirrorService.upsert(tenantId)` + nightly `@LeaderCron` sweep |
| `apps/api/src/platform-admin/tenant-mirror.service.spec.ts` | Create: unit tests for `upsert()` idempotency and per-tenant error isolation in the sweep |
| `apps/api/src/platform-admin/platform-admin.module.ts` | Modify: register `TenantMirrorService` |
| `apps/api/src/billing/billing.module.ts` | Modify: add `MrrService` to `exports` (currently only a provider — `PlatformAdminService` cannot inject it otherwise) |
| `apps/api/src/billing/mrr.service.ts` | Modify: scope every query by `tenant: { class: "PRODUCTION" }` |
| `apps/api/src/billing/mrr.service.spec.ts` | Create (if it doesn't exist) or modify: test that a TEST/DEMO-class tenant's subscription is excluded from `mrr` and `ledgerMrr` |
| `apps/api/scripts/backfill-tenant-class.mjs` | Create: dark backfill of `Tenant.class` from `classifyTenantSlug` |
| `apps/api/scripts/backfill-tenant-class.db.spec.ts` | Create: DB-lane test |
| `apps/api/scripts/backfill-subscription-reconciliation.mjs` | Create: dry-run/apply reconciliation of `TenantSubscription` rows |
| `apps/api/scripts/backfill-subscription-reconciliation.db.spec.ts` | Create: DB-lane test |
| `apps/api/scripts/bootstrap-house-tenant.mjs` | Create: one-time, idempotent `routeflow-hq` tenant creation + `PlatformConfig` key |
| `apps/web/lib/api/platform-pricing.ts` | Modify: nothing structural — `fetchPlanCatalog()` already exists and is reused as-is |
| `apps/web/app/(platform-admin)/_components/AdminBadge.tsx` | Modify: add `GROWTH`/`SCALE` to `PLAN_LABELS`/`PLAN_COLORS` |
| `apps/web/app/(platform-admin)/admin/tenants/new/page.tsx` | Modify: replace the hardcoded `PLANS` array with a live catalog fetch |
| `apps/web/app/(platform-admin)/admin/dashboard/page.tsx` | Modify: read `mrr`/`ledgerMrr` instead of `estMrrUsd` |
| `apps/web/app/(platform-admin)/admin/billing/page.tsx` | Modify: read the same `mrr` field so the two pages agree |

---

### Task 1: `TenantClass` enum, `TenantPlan` widening, `Customer.representsTenantId` — schema + migration

**Files:**
- Modify: `apps/api/prisma/schema/tenancy.prisma`
- Modify: `apps/api/prisma/schema/sales.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_backoffice_phase0_truth/migration.sql` (generated, not hand-written)

**Interfaces:**
- Produces: `TenantClass` enum (`PRODUCTION | DEMO | TEST | INTERNAL`) and `Tenant.class` field
  (default `PRODUCTION`), consumed by every later task in this plan and by Phase 1+.
- Produces: `TenantPlan` enum gains `GROWTH`, `SCALE` members (alongside the existing `STARTER,
  TEAM, BUSINESS, PROFESSIONAL, ENTERPRISE`), consumed by Task 6 (`CreateTenantDto`) and every
  DTO that does `@IsEnum(TenantPlan)`.
- Produces: `Customer.representsTenantId String? @unique`, schema-only in this phase (no writer
  until Phase 1); consumed by the HQ bootstrap work in Task 11 only as a column that must exist.

- [ ] **Step 1: Add the `TenantClass` enum and `Tenant.class` field**

In `apps/api/prisma/schema/tenancy.prisma`, add the enum next to `TenantStatus`/`TenantPlan`
(around line 20, after the existing `TenantPlan` block):

```prisma
enum TenantClass {
  PRODUCTION
  DEMO
  TEST
  INTERNAL
}
```

Widen `TenantPlan` (same file, the existing block) by adding two members — do not reorder or
remove the existing ones:

```prisma
enum TenantPlan {
  STARTER
  TEAM
  BUSINESS
  PROFESSIONAL
  ENTERPRISE
  GROWTH
  SCALE
}
```

Add the field to `model Tenant` (the existing `plan TenantPlan @default(STARTER)` line is at
tenancy.prisma:73 today — add `class` directly below it):

```prisma
  plan  TenantPlan   @default(STARTER)
  class TenantClass  @default(PRODUCTION)
```

- [ ] **Step 2: Add `Customer.representsTenantId`**

In `apps/api/prisma/schema/sales.prisma`, inside `model Customer` (starts at sales.prisma:123),
add a new optional unique field near the other identifier fields (e.g. near `zohoContactId`):

```prisma
  // Set only for Customer rows on the routeflow-hq house tenant: the platform Tenant this
  // row represents. Null for every ordinary tenant's own customers. Written by
  // TenantMirrorService (see tenant-mirror.service.ts); no writer exists before Phase 0's
  // HQ bootstrap task runs.
  representsTenantId String? @unique
```

- [ ] **Step 3: Generate and apply the migration locally**

Run:

```bash
cd apps/api
npx prisma migrate dev --name backoffice_phase0_truth
```

Expected: Prisma detects the additive enum values and the two new columns, generates a single
migration file under `apps/api/prisma/migrations/<timestamp>_backoffice_phase0_truth/`, and
applies it to your local dev database without a destructive-statement warning (both new columns
have defaults / are nullable, so this is additive-only).

- [ ] **Step 4: Verify the schema-folder invariants**

Run: `node apps/api/scripts/split-prisma-schema.mjs --check`
Expected: exits 0 — no unmapped models (no new models were added, only enum/field changes to
existing `Tenant` and `Customer`).

- [ ] **Step 5: Regenerate the Prisma client and confirm the API still builds**

Run: `npx prisma generate && npx tsc --noEmit -p apps/api`
Expected: no type errors. (`TenantClass` and the widened `TenantPlan` are now available from
`@prisma/client`.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/schema/tenancy.prisma apps/api/prisma/schema/sales.prisma apps/api/prisma/migrations
git commit -m "feat(schema): add Tenant.class, widen TenantPlan with GROWTH/SCALE, add Customer.representsTenantId"
```

---

### Task 2: `classifyTenantSlug` utility + unit tests

**Files:**
- Create: `apps/api/src/common/tenant-class.util.ts`
- Create: `apps/api/src/common/tenant-class.util.spec.ts`

**Interfaces:**
- Consumes: `TenantClass` from `@prisma/client` (Task 1); `TEST_TENANT_SLUGS`,
  `TEST_TENANT_PATTERN` from `scripts/lib/test-tenants.cjs` (already exist — read-only reuse, no
  changes to that file).
- Produces: `classifyTenantSlug(slug: string): TenantClass`, consumed by Task 3 (backfill
  script) and Task 8 (`updateTenantClass` validation).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/common/tenant-class.util.spec.ts
import { TenantClass } from "@prisma/client";
import { classifyTenantSlug } from "./tenant-class.util";

describe("classifyTenantSlug", () => {
  it("classifies the demo tenant as DEMO", () => {
    expect(classifyTenantSlug("routeflow-demo")).toBe(TenantClass.DEMO);
  });

  it("classifies exact test slugs as TEST", () => {
    expect(classifyTenantSlug("test")).toBe(TenantClass.TEST);
    expect(classifyTenantSlug("e2e-routeflow")).toBe(TenantClass.TEST);
  });

  it("classifies qa-/e2e-/ux-audit- prefixed slugs as TEST", () => {
    expect(classifyTenantSlug("qa-smoke-1")).toBe(TenantClass.TEST);
    expect(classifyTenantSlug("e2e-1789227134183")).toBe(TenantClass.TEST);
    expect(classifyTenantSlug("ux-audit-1777265477001")).toBe(TenantClass.TEST);
  });

  it("classifies the house tenant slug as INTERNAL", () => {
    expect(classifyTenantSlug("routeflow-hq")).toBe(TenantClass.INTERNAL);
  });

  it("classifies everything else as PRODUCTION", () => {
    expect(classifyTenantSlug("acme-wholesale")).toBe(TenantClass.PRODUCTION);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest apps/api/src/common/tenant-class.util.spec.ts`
Expected: FAIL — `Cannot find module './tenant-class.util'`.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/api/src/common/tenant-class.util.ts
import { TenantClass } from "@prisma/client";
import { TEST_TENANT_SLUGS, TEST_TENANT_PATTERN } from "../../../../scripts/lib/test-tenants.cjs";

/** The one hardcoded exception: routeflow-demo is TEST_TENANT_SLUGS-approved for the write
 * policy but is classified DEMO here — visible in lists, excluded from revenue and sends,
 * distinct from TEST which is hidden by default everywhere. */
const DEMO_SLUG = "routeflow-demo";

/** The house tenant's slug, classified INTERNAL. Set once by bootstrap-house-tenant.mjs
 * (Task 11); this classifier must recognize it even before that script has run, so a
 * re-run of the backfill after bootstrap never reclassifies it. */
const HOUSE_TENANT_SLUG = "routeflow-hq";

/**
 * Pure classification from slug alone. Order matters: DEMO and INTERNAL are checked
 * before the generic TEST pattern because routeflow-demo would otherwise match
 * TEST_TENANT_SLUGS. Every other approved-test slug pattern maps to TEST; everything
 * else is PRODUCTION.
 */
export function classifyTenantSlug(slug: string): TenantClass {
  if (slug === DEMO_SLUG) return TenantClass.DEMO;
  if (slug === HOUSE_TENANT_SLUG) return TenantClass.INTERNAL;
  if (TEST_TENANT_SLUGS.has(slug) || TEST_TENANT_PATTERN.test(slug)) return TenantClass.TEST;
  return TenantClass.PRODUCTION;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest apps/api/src/common/tenant-class.util.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/common/tenant-class.util.ts apps/api/src/common/tenant-class.util.spec.ts
git commit -m "feat(common): add classifyTenantSlug for Tenant.class backfill"
```

---

### Task 3: Dark backfill script for `Tenant.class`

**Files:**
- Create: `apps/api/scripts/backfill-tenant-class.mjs`
- Create: `apps/api/scripts/backfill-tenant-class.db.spec.ts`

**Interfaces:**
- Consumes: `classifyTenantSlug` (Task 2) — imported via a small `.mjs`-compatible re-export, see
  Step 1's note on ESM/CJS interop.
- Produces: every existing `Tenant` row gets a correct `class` value. No KPI query reads this
  column yet (that's Task 9, gated behind the manual checkpoint below).

- [ ] **Step 1: Write the script**

Prisma's TS enum (`classifyTenantSlug`) is compiled TS; scripts under `apps/api/scripts/` run as
plain `.mjs` against the built `@prisma/client`, matching the existing `publish-plan-catalog-v11.ts`
precedent of importing generated Prisma types directly. Write the classification inline in the
script (duplicating the five-line rule, not the whole module) so the script has no build-step
dependency on `dist/`, and cross-check it against `tenant-class.util.ts` in the DB-lane spec
(Step 3) so the two definitions can never silently drift:

```javascript
// apps/api/scripts/backfill-tenant-class.mjs
//
// Dark backfill of Tenant.class from the slug classification rule. "Dark" means: this
// script only WRITES the column. No KPI query filters on it until a human has reviewed
// the printed classification table against the known real-tenant list and a SEPARATE
// follow-up change (Task 9) flips MrrService/getStats() to filter by it. Idempotent —
// safe to run more than once; re-classifies every tenant every run (cheap, ~30 rows).
//
// Usage:
//   node apps/api/scripts/backfill-tenant-class.mjs           # dry run, prints table only
//   node apps/api/scripts/backfill-tenant-class.mjs --apply   # writes the classification

import { PrismaClient } from "@prisma/client";

const DEMO_SLUG = "routeflow-demo";
const HOUSE_TENANT_SLUG = "routeflow-hq";
const TEST_TENANT_SLUGS = new Set(["test", "e2e-routeflow", "routeflow-demo"]);
const TEST_TENANT_PATTERN = /^(qa|e2e|ux-audit)-/;

function classify(slug) {
  if (slug === DEMO_SLUG) return "DEMO";
  if (slug === HOUSE_TENANT_SLUG) return "INTERNAL";
  if (TEST_TENANT_SLUGS.has(slug) || TEST_TENANT_PATTERN.test(slug)) return "TEST";
  return "PRODUCTION";
}

async function main() {
  const apply = process.argv.includes("--apply");
  const prisma = new PrismaClient();

  try {
    const tenants = await prisma.tenant.findMany({
      select: { id: true, slug: true, name: true, class: true },
      orderBy: { slug: "asc" },
    });

    const changes = tenants
      .map((t) => ({ ...t, newClass: classify(t.slug) }))
      .filter((t) => t.newClass !== t.class);

    console.log(`${tenants.length} tenants scanned, ${changes.length} classification change(s):`);
    console.table(
      changes.map((c) => ({ slug: c.slug, name: c.name, from: c.class, to: c.newClass })),
    );

    if (!apply) {
      console.log("\nDry run only — pass --apply to write these changes.");
      return;
    }

    for (const c of changes) {
      await prisma.tenant.update({ where: { id: c.id }, data: { class: c.newClass } });
    }
    console.log(`Applied ${changes.length} classification change(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Write the failing DB-lane test**

```typescript
// apps/api/scripts/backfill-tenant-class.db.spec.ts
import { execSync } from "child_process";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

describe("backfill-tenant-class (db)", () => {
  const slugs = ["acme-co-phase0", "routeflow-demo", "qa-phase0-1", "routeflow-hq"];

  beforeAll(async () => {
    for (const slug of slugs) {
      await prisma.tenant.upsert({
        where: { slug },
        create: { slug, name: slug, status: "ACTIVE" },
        update: {},
      });
    }
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: { in: slugs } } });
    await prisma.$disconnect();
  });

  it("dry run makes no writes", async () => {
    const before = await prisma.tenant.findMany({ where: { slug: { in: slugs } } });
    execSync("node apps/api/scripts/backfill-tenant-class.mjs", { encoding: "utf-8" });
    const after = await prisma.tenant.findMany({ where: { slug: { in: slugs } } });
    expect(after.map((t) => t.class)).toEqual(before.map((t) => t.class));
  });

  it("apply classifies each slug correctly", async () => {
    execSync("node apps/api/scripts/backfill-tenant-class.mjs --apply", { encoding: "utf-8" });
    const rows = await prisma.tenant.findMany({
      where: { slug: { in: slugs } },
      select: { slug: true, class: true },
    });
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r.class]));
    expect(bySlug["acme-co-phase0"]).toBe("PRODUCTION");
    expect(bySlug["routeflow-demo"]).toBe("DEMO");
    expect(bySlug["qa-phase0-1"]).toBe("TEST");
    expect(bySlug["routeflow-hq"]).toBe("INTERNAL");
  });
});
```

- [ ] **Step 3: Run the DB-lane test against the local compose stack to verify it fails, then passes**

Run: `npm run db:up && npm run local:test:db -- backfill-tenant-class`
Expected: first run fails on the missing script/table state if the compose DB has no migration
yet — run `npm run local:migrate` first (per Global Constraints), then re-run; expect both tests
PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/scripts/backfill-tenant-class.mjs apps/api/scripts/backfill-tenant-class.db.spec.ts
git commit -m "feat(scripts): dark Tenant.class backfill (dry-run/apply)"
```

> **Manual checkpoint (owner, before Task 9):** run
> `node apps/api/scripts/backfill-tenant-class.mjs` (no `--apply`) against a local copy of prod
> data or against prod itself read-only, and read the printed table against the known real-tenant
> list. Only once that list looks right should Task 9 (KPI filtering) proceed. Do not skip this —
> it is the two-step order the parent spec requires so a misclassified real tenant cannot make
> its own revenue disappear in the same change that is supposed to make revenue trustworthy.

---

### Task 4: `TRIAL_LENGTH_DAYS` constant

**Files:**
- Modify: `apps/api/src/billing/plan-catalog.constants.ts`
- Modify: `apps/api/src/tenants/tenants.service.ts:97-98`
- Modify: `apps/api/src/platform-admin/platform-admin.service.ts:232` (also touched again in
  Task 6 for the `trialLengthDays` override — this step just centralizes the constant)

**Interfaces:**
- Produces: `TRIAL_LENGTH_DAYS: number`, consumed by Task 6.

- [ ] **Step 1: Add the constant**

In `apps/api/src/billing/plan-catalog.constants.ts`, near the existing `PLAN_KEYS` export
(line 10):

```typescript
/** Default self-serve and admin-created trial length in days. A single shared value so the
 * two tenant-creation paths (public self-signup and platform-admin Create Tenant) never
 * drift apart again — they previously used 14 and 7 respectively. */
export const TRIAL_LENGTH_DAYS = 14;
```

- [ ] **Step 2: Use it in `tenants.service.ts`**

Replace the two-line manual date math at `tenants.service.ts:97-98`:

```typescript
// before
const trialEndsAt = new Date();
trialEndsAt.setDate(trialEndsAt.getDate() + 14);
```

```typescript
// after
import { TRIAL_LENGTH_DAYS } from "../billing/plan-catalog.constants";
// ...
const trialEndsAt = new Date();
trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL_LENGTH_DAYS);
```

- [ ] **Step 3: Run the existing tenants unit tests**

Run: `npx jest apps/api/src/tenants`
Expected: PASS — behavior unchanged (still 14 days), only the source of the number moved.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/billing/plan-catalog.constants.ts apps/api/src/tenants/tenants.service.ts
git commit -m "refactor(billing): centralize TRIAL_LENGTH_DAYS constant"
```

(The admin-created path's `7 * 24 * 60 * 60 * 1000` at `platform-admin.service.ts:232` is
replaced in Task 6, alongside the plan-validation change, since both touch `createTenant()`.)

---

### Task 5: Promote `extractDeviceInfo` to a shared utility

**Files:**
- Create: `apps/api/src/auth/device-info.util.ts`
- Modify: `apps/api/src/auth/auth.controller.ts:481-488` (delete the private method, import the
  new one, update the 4 call sites at lines 84, 102, 139, 159 to call the imported function)

**Interfaces:**
- Produces: `extractDeviceInfo(req: Request): { userAgent?: string; ipAddress?: string }`,
  consumed by `auth.controller.ts` (unchanged behavior) and by Task 7
  (`platform-google-auth.controller.ts`).

- [ ] **Step 1: Read the current implementation to copy it exactly**

Read `apps/api/src/auth/auth.controller.ts:481-488` before editing — the exact header-parsing
logic (which header it reads for IP, any proxy-trust logic) must be preserved verbatim, not
reinvented.

- [ ] **Step 2: Create the shared utility with the copied logic**

```typescript
// apps/api/src/auth/device-info.util.ts
import type { Request } from "express";

export interface ExtractedDeviceInfo {
  userAgent?: string;
  ipAddress?: string;
}

/** Promoted from AuthController's former private method (unchanged logic) so the Google
 * OAuth flows can populate RefreshToken.userAgent/ipAddress the same way the credential
 * login path already does. */
export function extractDeviceInfo(req: Request): ExtractedDeviceInfo {
  // paste the exact body from the former AuthController.extractDeviceInfo here
}
```

- [ ] **Step 3: Update `auth.controller.ts` to import and use it**

Delete the private `extractDeviceInfo` method (lines 481-488) and its four call sites'
`this.extractDeviceInfo(req)` become `extractDeviceInfo(req)` after adding:

```typescript
import { extractDeviceInfo } from "./device-info.util";
```

- [ ] **Step 4: Run the auth unit tests**

Run: `npx jest apps/api/src/auth/auth.controller`
Expected: PASS — no behavior change, pure extraction.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/device-info.util.ts apps/api/src/auth/auth.controller.ts
git commit -m "refactor(auth): promote extractDeviceInfo to a shared utility"
```

---

### Task 6: Thread `DeviceInfo` through the Google OAuth platform-admin flow

**Files:**
- Modify: `apps/api/src/auth/google-oauth.service.ts` (`findOrCreateUser` at line 392,
  `handlePlatformAuth` at line 400, `issueUserTokenPair` at line 676,
  `storeUserRefreshToken` at line 746)
- Modify: `apps/api/src/auth/platform-google-auth.controller.ts` (`handleCallback` at line 84)

**Interfaces:**
- Consumes: `extractDeviceInfo` (Task 5), `DeviceInfo` type (already exported from
  `auth.service.ts:19-23`).
- Produces: `RefreshToken.userAgent`/`ipAddress` populated for platform-admin Google sign-ins
  going forward (pre-existing sessions remain "Unknown device" — this phase does not backfill
  history, per the parent spec's exit criteria).

This is a real signature-threading change across four call layers, not a three-line fix — the
Google-issued token path (`issueUserTokenPair` → `storeUserRefreshToken`) is a completely
separate, simpler implementation from the credential-login path (`AuthService.storeRefreshToken`,
which already accepts and writes `DeviceInfo`) and today accepts no device parameter at all.

- [ ] **Step 1: Add device info columns to `storeUserRefreshToken`**

In `google-oauth.service.ts`, change:

```typescript
private async storeUserRefreshToken(userId: string, token: string): Promise<void> {
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const decoded = this.jwtService.decode(token);
  const expiresAt = new Date(decoded.exp * 1000);
  await this.prisma.refreshToken.upsert({
    where: { tokenHash },
    create: { userId, tokenHash, expiresAt },
    update: { expiresAt },
  });
}
```

to:

```typescript
private async storeUserRefreshToken(
  userId: string,
  token: string,
  deviceInfo?: DeviceInfo,
): Promise<void> {
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const decoded = this.jwtService.decode(token);
  const expiresAt = new Date(decoded.exp * 1000);
  await this.prisma.refreshToken.upsert({
    where: { tokenHash },
    create: {
      userId,
      tokenHash,
      expiresAt,
      userAgent: deviceInfo?.userAgent,
      ipAddress: deviceInfo?.ipAddress,
    },
    update: { expiresAt, userAgent: deviceInfo?.userAgent, ipAddress: deviceInfo?.ipAddress },
  });
}
```

Add the import at the top of the file: `import type { DeviceInfo } from "./auth.service";`

- [ ] **Step 2: Thread the parameter through `issueUserTokenPair`**

```typescript
// signature change
private async issueUserTokenPair(
  user: any,
  tenantSlug: string | null,
  deviceInfo?: DeviceInfo,
): Promise<TokenPair> {
  // ...unchanged body until the final two lines...
  await this.storeUserRefreshToken(user.id, refreshToken, deviceInfo);
  return { accessToken, refreshToken };
}
```

- [ ] **Step 3: Thread it through `handlePlatformAuth` and its caller**

```typescript
// google-oauth.service.ts:400
private async handlePlatformAuth(
  profile: GoogleProfile,
  deviceInfo?: DeviceInfo,
): Promise<GoogleAuthResult> {
  // ...unchanged...
  const tokens = await this.issueUserTokenPair(user, null, deviceInfo);
  // ...unchanged return...
}
```

```typescript
// google-oauth.service.ts:392
async findOrCreateUser(profile: GoogleProfile, deviceInfo?: DeviceInfo): Promise<GoogleAuthResult> {
  return profile.type === "platform"
    ? this.handlePlatformAuth(profile, deviceInfo)
    : this.handleTenantAuth(profile, deviceInfo);
}
```

Also add the same `deviceInfo?: DeviceInfo` parameter to `handleTenantAuth` (line 440) and pass
it into its own `issueUserTokenPair` call (line 479) — the tenant-side Google sign-in gets the
same fix as a side effect, closing the same "Unknown device" gap for tenant operators, not only
platform admins.

- [ ] **Step 4: Capture device info at the callback controller and pass it in**

In `platform-google-auth.controller.ts`, add `@Req() req: Request` to `handleCallback`'s
parameters (it currently takes only `@Query(...)` and `@Res()`), import `Request` from
`"express"` and `extractDeviceInfo` from `"./device-info.util"`, then change:

```typescript
const result = await this.googleOAuth.findOrCreateUser(profile);
```

to:

```typescript
const result = await this.googleOAuth.findOrCreateUser(profile, extractDeviceInfo(req));
```

- [ ] **Step 5: Write a test proving the device columns are populated**

Add to `apps/api/src/auth/google-oauth.service.spec.ts` (create the file if it does not exist,
following the existing NestJS `Test.createTestingModule` mock-at-module-boundary pattern used
elsewhere in `apps/api/src/auth`):

```typescript
it("handlePlatformAuth stores the provided device info on the refresh token", async () => {
  // Arrange: mock prisma.user.findFirst to return an ACTIVE SUPER_ADMIN, mock
  // prisma.refreshToken.upsert, mock entitlements.claimsFor to resolve null.
  // Act: await service.findOrCreateUser(
  //   { type: "platform", googleId: "g1", email: "admin@example.com" } as any,
  //   { userAgent: "TestAgent/1.0", ipAddress: "10.0.0.1" },
  // );
  // Assert: prisma.refreshToken.upsert was called with
  //   create/update containing userAgent: "TestAgent/1.0", ipAddress: "10.0.0.1".
});
```

- [ ] **Step 6: Run the test to verify it fails, then implement, then verify it passes**

Run: `npx jest apps/api/src/auth/google-oauth.service.spec.ts`
Expected: FAIL before Steps 1-4 are applied (or if written first, FAIL on the assertion); PASS
after.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth/google-oauth.service.ts apps/api/src/auth/platform-google-auth.controller.ts apps/api/src/auth/google-oauth.service.spec.ts
git commit -m "fix(auth): record device info for Google OAuth sessions (both platform admin and tenant staff)"
```

---

### Task 7: READ_ONLY allowlist hotfix for `/billing/quote`

**Files:**
- Modify: `apps/api/src/tenant/tenant-status.guard.ts:134-138`
- Modify: `apps/api/src/tenant/tenant-status.guard.spec.ts`

**Interfaces:** none — self-contained guard logic change.

- [ ] **Step 1: Write the failing repro test**

Add to `tenant-status.guard.spec.ts` (follow the existing test structure in that file for how a
mock `Request`/tenant status is constructed):

```typescript
it("allows POST /billing/quote for a READ_ONLY tenant", () => {
  const req = { method: "POST", path: "/api/v1/billing/quote" } as any;
  expect(() => (guard as any).assertAllowed("READ_ONLY", req)).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest apps/api/src/tenant/tenant-status.guard.spec.ts -t "billing/quote"`
Expected: FAIL — throws `ForbiddenException` today.

- [ ] **Step 3: Add the allowlist entry**

```typescript
// tenant-status.guard.ts:134-138, before
const allowedMutation =
  path.startsWith("/api/v1/auth/") ||
  path === "/api/v1/billing/subscribe" ||
  path === "/api/v1/billing/subscription" ||
  path.startsWith("/api/v1/billing/subscription/");
```

```typescript
// after
const allowedMutation =
  path.startsWith("/api/v1/auth/") ||
  path === "/api/v1/billing/quote" ||
  path === "/api/v1/billing/subscribe" ||
  path === "/api/v1/billing/subscription" ||
  path.startsWith("/api/v1/billing/subscription/");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest apps/api/src/tenant/tenant-status.guard.spec.ts`
Expected: PASS (including all pre-existing tests in the file, unaffected).

- [ ] **Step 5: Manual verification on the local compose stack**

With `npm run local:up` running, force a tenant to `READ_ONLY` (via the platform-admin
`PATCH .../status` endpoint against a `qa-*` tenant) and confirm the choose-plan page's Subscribe
button now renders instead of erroring on the quote call. If any *other* route the Subscribe flow
needs also 403s, add it to the same allowlist in this same commit.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/tenant/tenant-status.guard.ts apps/api/src/tenant/tenant-status.guard.spec.ts
git commit -m "fix(billing): allow POST /billing/quote for READ_ONLY tenants so an expired trial can subscribe"
```

---

### Task 8: `updateTenantClass` endpoint

**Files:**
- Create: `apps/api/src/platform-admin/dto/update-tenant-class.dto.ts`
- Modify: `apps/api/src/platform-admin/audit-actions.constant.ts`
- Modify: `apps/api/src/platform-admin/platform-admin.service.ts`
- Modify: `apps/api/src/platform-admin/platform-admin.controller.ts`
- Modify: `apps/api/src/platform-admin/platform-admin.service.spec.ts`

**Interfaces:**
- Consumes: `classifyTenantSlug` is NOT used here — this is a manual override endpoint, distinct
  from the automated backfill; it takes an explicit target class from the admin, not a derived
  one.
- Produces: `PlatformAdminService.updateTenantClass(tenantId, dto, adminId): Promise<{id, slug,
  class}>`, and `PATCH /platform-admin/tenants/:id/class`, consumed by no other task in this
  plan (later phases' Tenant 360 UI is Phase 5) but exercised by its own tests here.

- [ ] **Step 1: Write the failing DTO test and service test**

```typescript
// apps/api/src/platform-admin/dto/update-tenant-class.dto.ts (new file, write first as a plain
// class so the service test below has something to import)
import { IsEnum, IsString, MinLength } from "class-validator";
import { TenantClass } from "@prisma/client";

export class UpdateTenantClassDto {
  @IsEnum(TenantClass)
  class!: TenantClass;

  @IsString()
  @MinLength(3)
  reason!: string;
}
```

Add to `platform-admin.service.spec.ts` (follow the existing spec's mock-prisma pattern used for
`updatePlan`/`updateStatus` tests in the same file):

```typescript
describe("updateTenantClass", () => {
  it("updates the class, writes an audit row, and emits a BillingEvent when leaving PRODUCTION", async () => {
    prisma.tenant.findUniqueOrThrow.mockResolvedValue({ id: TENANT_ID, slug: "acme", class: "PRODUCTION" });
    prisma.tenant.update.mockResolvedValue({ id: TENANT_ID, slug: "acme", class: "TEST" });

    await service.updateTenantClass(TENANT_ID, { class: "TEST", reason: "reclassified as QA" }, ADMIN_ID);

    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { class: "TEST" },
      select: { id: true, slug: true, class: true },
    });
    expect(billingEventService.record).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ type: "tenant.class_changed" }),
    );
  });

  it("does not emit a BillingEvent when moving between two non-PRODUCTION classes", async () => {
    prisma.tenant.findUniqueOrThrow.mockResolvedValue({ id: TENANT_ID, slug: "qa-1", class: "TEST" });
    prisma.tenant.update.mockResolvedValue({ id: TENANT_ID, slug: "qa-1", class: "DEMO" });

    await service.updateTenantClass(TENANT_ID, { class: "DEMO", reason: "repurposed for sales demo" }, ADMIN_ID);

    expect(billingEventService.record).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest apps/api/src/platform-admin/platform-admin.service.spec.ts -t updateTenantClass`
Expected: FAIL — `updateTenantClass` is not a function.

- [ ] **Step 3: Add the audit action code**

In `audit-actions.constant.ts`, add to `AdminAuditAction` and `ADMIN_AUDIT_ACTION_LABELS`
(both maps, keeping the existing entries untouched):

```typescript
  TENANT_CLASS_CHANGED: "TENANT_CLASS_CHANGED",
```
```typescript
  TENANT_CLASS_CHANGED: "Class changed",
```

- [ ] **Step 4: Implement `updateTenantClass`**

Add to `platform-admin.service.ts`, near the other `update*` tenant methods:

```typescript
async updateTenantClass(tenantId: string, dto: UpdateTenantClassDto, adminId: string | null) {
  const before = await this.prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { id: true, slug: true, class: true },
  });

  const updated = await this.prisma.tenant.update({
    where: { id: tenantId },
    data: { class: dto.class },
    select: { id: true, slug: true, class: true },
  });

  await this.recordAdminAction(tenantId, adminId, AdminAuditAction.TENANT_CLASS_CHANGED, {
    from: before.class,
    to: dto.class,
    reason: dto.reason,
  });

  // A class change that moves a tenant into or out of PRODUCTION changes what MrrService
  // counts as revenue — emit a ledger event so the change is traceable and excludable from
  // MRR-movement charts, per the parent spec's Section 5 (every admin money action emits one).
  const wasProd = before.class === "PRODUCTION";
  const isProd = dto.class === "PRODUCTION";
  if (wasProd !== isProd) {
    await this.billingEventService.record(tenantId, {
      type: "tenant.class_changed",
      payload: { from: before.class, to: dto.class, reason: dto.reason, actorId: adminId },
      amountDelta: null,
      actorId: adminId,
    });
  }

  return updated;
}
```

Check `BillingEventService.record`'s exact signature in `apps/api/src/billing/billing-event.service.ts`
before writing this call — adjust the call shape to match if it differs (e.g. positional args vs.
an options object); the intent (write one `BillingEvent` row with `type:
"tenant.class_changed"`) is what matters, the exact call shape must match the real method.

- [ ] **Step 5: Add the controller endpoint**

In `platform-admin.controller.ts`, near the other tenant-scoped `PATCH` routes:

```typescript
@Patch("tenants/:id/class")
@ApiOperation({ summary: "Change a tenant's classification (production/demo/test/internal)" })
async updateTenantClass(
  @Param("id") id: string,
  @Body() dto: UpdateTenantClassDto,
  @CurrentUser() admin: { sub: string },
) {
  return this.platformAdminService.updateTenantClass(id, dto, admin.sub);
}
```

Import `UpdateTenantClassDto` at the top of the file alongside the other DTO imports.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest apps/api/src/platform-admin/platform-admin.service.spec.ts`
Expected: PASS, including the two new tests and every pre-existing test in the file.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/platform-admin/dto/update-tenant-class.dto.ts apps/api/src/platform-admin/audit-actions.constant.ts apps/api/src/platform-admin/platform-admin.service.ts apps/api/src/platform-admin/platform-admin.controller.ts apps/api/src/platform-admin/platform-admin.service.spec.ts
git commit -m "feat(platform-admin): add PATCH tenants/:id/class with audit + ledger event on PRODUCTION transitions"
```

---

### Task 9: One MRR engine — export `MrrService`, scope it by class, wire `getStats()`

**Files:**
- Modify: `apps/api/src/billing/billing.module.ts`
- Modify: `apps/api/src/billing/mrr.service.ts`
- Modify or create: `apps/api/src/billing/mrr.service.spec.ts`
- Modify: `apps/api/src/platform-admin/platform-admin.service.ts` (constructor + `getStats()`)
- Modify: `apps/api/src/platform-admin/platform-admin.service.spec.ts`

**Interfaces:**
- Consumes: `MrrService.computeOverview()` (already exists — see Task description for its
  return shape), `Tenant.class` (Task 1 + the manual checkpoint after Task 3).
- Produces: `getStats()` response gains `mrr` and `ledgerMrr` fields; `estMrrUsd` is removed.
  Consumed by the web dashboard/billing pages in Task 12.

**Do not start this task until the manual checkpoint after Task 3 has been signed off** — this
is the task that starts filtering real KPIs by `Tenant.class`, and it must run after the
classification has been verified against the real tenant list, not before.

- [ ] **Step 1: Export `MrrService` from `BillingModule`**

In `billing.module.ts`, add `MrrService` to the `exports` array (it is already in `providers`):

```typescript
  exports: [
    StripeService,
    BillingService,
    PlatformPricingService,
    AddonService,
    AddonGuard,
    BillingEventService,
    EntitlementsModule,
    MrrService,
  ],
```

- [ ] **Step 2: Write the failing test for class-scoped MRR**

Create or extend `mrr.service.spec.ts` (follow the mock-prisma pattern used in
`platform-admin.service.spec.ts` for consistency):

```typescript
it("excludes non-PRODUCTION tenants from mrr and ledgerMrr", async () => {
  prisma.tenantSubscription.findMany.mockResolvedValue([
    { planKey: "GROWTH", basePriceSnapshot: 249, discount: 0 },
  ]);
  prisma.tenantAddon.findMany.mockResolvedValue([]);
  prisma.tenant.count.mockResolvedValue(0);
  prisma.billingEvent.aggregate.mockResolvedValue({ _sum: { amountDelta: 249 } });

  await service.computeOverview();

  // Assert every prisma call that scopes by tenant status also scopes by class:
  expect(prisma.tenantSubscription.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        tenant: expect.objectContaining({ class: "PRODUCTION" }),
      }),
    }),
  );
  expect(prisma.billingEvent.aggregate).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ tenant: { class: "PRODUCTION" } }) }),
  );
});
```

- [ ] **Step 2b: Run test to verify it fails**

Run: `npx jest apps/api/src/billing/mrr.service.spec.ts`
Expected: FAIL — current `where` clauses have no `class` filter.

- [ ] **Step 3: Add the class filter to every query in `computeOverview()`**

```typescript
// mrr.service.ts, before
const payingWhere = {
  planKey: { not: null },
  tenant: { status: "ACTIVE" as const, deletedAt: null },
};
```

```typescript
// after
const payingWhere = {
  planKey: { not: null },
  tenant: { status: "ACTIVE" as const, deletedAt: null, class: "PRODUCTION" as const },
};
```

Apply the same `class: "PRODUCTION"` addition to: the `tenantAddon.findMany` tenant filter
(line 65), the `trialTenants` count's `where` (line 69), the `readOnlyTenants` count's `where`
(line 70), and both `billingEvent.aggregate` calls' `where` — those currently have no tenant
filter at all (`this.prisma.billingEvent.aggregate({ _sum: { amountDelta: true } })`), so add
`where: { tenant: { class: "PRODUCTION" } }` to both (line 71's aggregate and line 72-75's
windowed aggregate, adding to its existing `createdAt` condition rather than replacing it).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest apps/api/src/billing/mrr.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `getStats()`'s new MRR source**

Update the existing `getStats()` describe block in `platform-admin.service.spec.ts` (it already
has tests around lines 460-530 per the plan-breakdown tests found during research) — replace any
assertion on `estMrrUsd` with one on `mrr`/`ledgerMrr`:

```typescript
it("sources MRR from MrrService, not the legacy estimator", async () => {
  mrrService.computeOverview.mockResolvedValue({
    mrr: 748, baseMrr: 748, addonMrr: 0, discountTotal: 0, payingTenants: 2,
    trialTenants: 1, readOnlyTenants: 0, byPlan: [], ledgerMrr: 748, momDelta: 0,
  });
  // ...existing mocked prisma calls for tenant counts unchanged...

  const stats = await service.getStats();

  expect(stats.mrr).toBe(748);
  expect(stats.ledgerMrr).toBe(748);
  expect(stats).not.toHaveProperty("estMrrUsd");
  expect(mrrService.computeOverview).toHaveBeenCalled();
});
```

Add a `mrrService = { computeOverview: jest.fn() }` mock provider to the module setup at the top
of the spec file, alongside the existing `planCatalogService` mock.

- [ ] **Step 6: Run test to verify it fails**

Run: `npx jest apps/api/src/platform-admin/platform-admin.service.spec.ts -t "sources MRR"`
Expected: FAIL.

- [ ] **Step 7: Wire `MrrService` into `PlatformAdminService` and rewrite `getStats()`**

Add `MrrService` to the constructor:

```typescript
constructor(
  // ...existing params...
  private readonly mrrService: MrrService,
) {}
```

Replace the `estMrrUsd` computation block (the `planScanRows`/`mrrTotal` reduce loop and the
`estMrrUsd: roundMoney(mrrTotal)` return field) with a call to `computeOverview()`, keeping the
tenant-count and plan-breakdown queries that are still needed for other dashboard cards:

```typescript
async getStats() {
  const now = new Date();
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    totalTenants, activeTenants, trialTenants, suspendedTenants, totalUsers,
    superAdminCount, newTenantsThisMonth, planScanRows, recentTenants,
    trialsExpiringSoon, atRiskTenants, mrrOverview,
  ] = await Promise.all([
    this.prisma.tenant.count({ where: { class: "PRODUCTION" } }),
    this.prisma.tenant.count({ where: { status: TenantStatus.ACTIVE, class: "PRODUCTION" } }),
    this.prisma.tenant.count({ where: { status: TenantStatus.TRIAL, class: "PRODUCTION" } }),
    this.prisma.tenant.count({ where: { status: TenantStatus.SUSPENDED, class: "PRODUCTION" } }),
    this.prisma.user.count({ where: { tenantId: { not: null }, tenant: { class: "PRODUCTION" } } }),
    this.prisma.user.count({ where: { role: "SUPER_ADMIN" } }),
    this.prisma.tenant.count({ where: { createdAt: { gte: startOfMonth }, class: "PRODUCTION" } }),
    this.prisma.tenant.findMany({
      where: { deletedAt: null, status: { not: TenantStatus.CANCELLED }, class: "PRODUCTION" },
      select: { status: true, plan: true, subscription: { select: { planKey: true } } },
    }),
    this.prisma.tenant.findMany({
      where: { class: "PRODUCTION" },
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { id: true, slug: true, name: true, status: true, plan: true, createdAt: true },
    }),
    this.prisma.tenant.findMany({
      where: {
        status: TenantStatus.TRIAL,
        trialEndsAt: { lte: sevenDaysFromNow, gte: now },
        class: "PRODUCTION",
      },
      orderBy: { trialEndsAt: "asc" },
      select: {
        id: true, slug: true, name: true, plan: true, trialEndsAt: true, createdAt: true,
        _count: { select: { users: true } },
      },
    }),
    this.prisma.tenant.findMany({
      where: {
        class: "PRODUCTION",
        OR: [
          { status: TenantStatus.SUSPENDED },
          { status: TenantStatus.TRIAL, trialEndsAt: { lt: now } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, slug: true, name: true, status: true, plan: true, trialEndsAt: true },
    }),
    this.mrrService.computeOverview(),
  ]);

  const planCounts: Record<string, number> = {};
  for (const t of planScanRows) {
    const planKey = normalizePlanKey(t.subscription?.planKey) ?? planKeyFromEnum(t.plan);
    planCounts[planKey] = (planCounts[planKey] ?? 0) + 1;
  }

  return {
    tenants: { total: totalTenants, active: activeTenants, trial: trialTenants, suspended: suspendedTenants },
    totalUsers,
    superAdminCount,
    newTenantsThisMonth,
    mrr: mrrOverview.mrr,
    ledgerMrr: mrrOverview.ledgerMrr,
    planBreakdown: planCounts,
    recentTenants,
    trialsExpiringSoon: trialsExpiringSoon.map((t) => ({
      id: t.id, slug: t.slug, name: t.name, plan: t.plan, trialEndsAt: t.trialEndsAt,
      createdAt: t.createdAt, userCount: t._count.users,
    })),
    atRiskTenants: atRiskTenants.map((t) => ({
      id: t.id, slug: t.slug, name: t.name, status: t.status, plan: t.plan,
      trialEndsAt: t.trialEndsAt, riskReason: this._riskReason(t.status, t.trialEndsAt, now),
    })),
  };
}
```

Do not delete `_monthlyPriceUsd`/`_catalogPriceByPlanKey` — they are used elsewhere (the
tenant-detail single-tenant Est. MRR card at line ~203-205), which is out of scope for this task.

- [ ] **Step 8: Run test to verify it passes**

Run: `npx jest apps/api/src/platform-admin/platform-admin.service.spec.ts`
Expected: PASS — including every other pre-existing `getStats()` test, updated as needed to stop
asserting on `estMrrUsd`/`catalogPriceByPlanKey` and assert on `mrr`/`ledgerMrr` instead.

- [ ] **Step 9: Register `MrrService` as a constructor dependency check**

Run: `npx tsc --noEmit -p apps/api`
Expected: no error — `PlatformAdminModule` already imports `BillingModule` (which now exports
`MrrService`), so Nest's DI resolves it without any module-import change.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/billing/billing.module.ts apps/api/src/billing/mrr.service.ts apps/api/src/billing/mrr.service.spec.ts apps/api/src/platform-admin/platform-admin.service.ts apps/api/src/platform-admin/platform-admin.service.spec.ts
git commit -m "fix(billing): one MRR engine — getStats() reads MrrService, scoped to PRODUCTION tenants"
```

---

### Task 10: `CreateTenantDto` plan validation + trial length + the `updatePlan`/`activateSubscription` DTOs pick up GROWTH/SCALE for free

**Files:**
- Modify: `apps/api/src/platform-admin/dto/create-tenant.dto.ts`
- Modify: `apps/api/src/platform-admin/platform-admin.service.ts` (`createTenant`)
- Modify: `apps/api/src/platform-admin/platform-admin.controller.ts` (pass `adminId` — already
  done for the audit call; no controller change needed beyond confirming the DTO still binds)
- Modify: `apps/api/src/platform-admin/platform-admin.service.spec.ts`

**Interfaces:**
- Consumes: `PLAN_KEYS`, `TRIAL_LENGTH_DAYS` (Task 4) from `plan-catalog.constants.ts`.
- Produces: `CreateTenantDto.plan` now validated against the live 4-key catalog instead of
  accepting any string; `CreateTenantDto.trialLengthDays?: number` new optional field.

`UpdateTenantPlanDto` and `ActivateSubscriptionDto` already use `@IsEnum(TenantPlan)`, so once
Task 1's Prisma migration lands, they accept `GROWTH`/`SCALE` with zero code change — nothing to
do there.

- [ ] **Step 1: Write the failing DTO validation test**

```typescript
// add to platform-admin.service.spec.ts's createTenant describe block
it("rejects a plan not in the live catalog", async () => {
  await expect(
    service.createTenant({ ...validCreateDto, plan: "NOT_A_REAL_PLAN" } as any),
  ).rejects.toThrow();
});

it("defaults trial length to TRIAL_LENGTH_DAYS and honors an override", async () => {
  const result = await service.createTenant({ ...validCreateDto, trialLengthDays: 30 });
  const expectedMs = 30 * 24 * 60 * 60 * 1000;
  const actualMs = result.trialEndsAt.getTime() - Date.now();
  expect(Math.abs(actualMs - expectedMs)).toBeLessThan(5000); // 5s tolerance for test runtime
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest apps/api/src/platform-admin/platform-admin.service.spec.ts -t "live catalog"`
Expected: FAIL — today any string is accepted and cast.

- [ ] **Step 3: Update the DTO**

```typescript
// create-tenant.dto.ts
import { IsString, MinLength, MaxLength, Matches, IsEmail, IsOptional, IsIn, IsInt, Min, Max } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { PLAN_KEYS } from "../../billing/plan-catalog.constants";

export class CreateTenantDto {
  // ...unchanged slug/businessName/adminEmail/adminUsername/adminPassword fields...

  @ApiPropertyOptional({ enum: PLAN_KEYS, default: "STARTER" })
  @IsOptional()
  @IsIn(PLAN_KEYS)
  plan?: (typeof PLAN_KEYS)[number];

  @ApiPropertyOptional({ description: "Trial length override in days (default: TRIAL_LENGTH_DAYS)" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  trialLengthDays?: number;
}
```

- [ ] **Step 4: Update `createTenant()` to use the validated plan and trial override**

```typescript
// platform-admin.service.ts, before
const tenantPlan = (plan as TenantPlan) ?? TenantPlan.STARTER;
const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
```

```typescript
// after
// PLAN_KEYS values (STARTER/GROWTH/SCALE/ENTERPRISE) are now a subset of the widened
// TenantPlan enum with matching names, so the validated key casts directly.
const tenantPlan = (plan as TenantPlan) ?? TenantPlan.STARTER;
const trialDays = dto.trialLengthDays ?? TRIAL_LENGTH_DAYS;
const trialEndsAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
```

Add the import: `import { TRIAL_LENGTH_DAYS } from "../billing/plan-catalog.constants";`

Also update the welcome-email copy at line 309 ("Your trial expires in 7 days...") to
interpolate `trialDays` instead of the hardcoded "7".

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest apps/api/src/platform-admin/platform-admin.service.spec.ts`
Expected: PASS, including all pre-existing `createTenant` tests (which use `STARTER`/etc. and
remain valid catalog keys).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/platform-admin/dto/create-tenant.dto.ts apps/api/src/platform-admin/platform-admin.service.ts apps/api/src/platform-admin/platform-admin.service.spec.ts
git commit -m "fix(platform-admin): validate CreateTenantDto.plan against the live catalog, support trial length override"
```

---

### Task 11: Subscription-set reconciliation script

**Files:**
- Create: `apps/api/scripts/backfill-subscription-reconciliation.mjs`
- Create: `apps/api/scripts/backfill-subscription-reconciliation.db.spec.ts`

**Interfaces:**
- Consumes: the published `PlanVersion`/`PlanDefinition` catalog (read via
  `PlanCatalogService`-equivalent raw queries — the script runs standalone, outside Nest DI, so
  it queries `PlanVersion`/`PlanDefinition` directly via Prisma rather than injecting the
  service, matching the existing `publish-plan-catalog-v11.ts` script's pattern of talking to
  Prisma directly).
- Produces: every `class: PRODUCTION | DEMO` tenant has exactly one `TenantSubscription` row
  with `planKey`/`basePriceSnapshot`/`planVersionId` set; writes a `BillingEvent` per change.

- [ ] **Step 1: Write the script**

```javascript
// apps/api/scripts/backfill-subscription-reconciliation.mjs
//
// Reconciles the TenantSubscription set so MrrService.computeOverview() (which only pays
// where planKey is set) sees every real tenant. Two failure modes it fixes:
//   1. A TenantSubscription row exists but is missing planKey/basePriceSnapshot/planVersionId
//      (Stripe-originated rows created before the checkout webhook set these fields).
//   2. No TenantSubscription row exists at all (self-signup seeds none).
// A tenant whose legacy `plan` enum value has no entry in LEGACY_PLAN_TO_CATALOG_KEY is
// skipped and listed separately — never guessed at.
//
// Usage:
//   node apps/api/scripts/backfill-subscription-reconciliation.mjs           # dry run
//   node apps/api/scripts/backfill-subscription-reconciliation.mjs --apply   # writes changes

import { PrismaClient } from "@prisma/client";

// Hand-checked mapping, not inferred — see Phase 0 spec Section 3. TEAM/BUSINESS have no
// direct live-catalog equivalent and are intentionally left unmapped; any tenant on those
// legacy values is skipped and reported for manual decision.
const LEGACY_PLAN_TO_CATALOG_KEY = {
  STARTER: "STARTER",
  PROFESSIONAL: "SCALE",
  ENTERPRISE: "ENTERPRISE",
};

async function main() {
  const apply = process.argv.includes("--apply");
  const prisma = new PrismaClient();

  try {
    const publishedVersion = await prisma.planVersion.findFirst({
      where: { status: "PUBLISHED" },
      include: { definitions: true },
    });
    if (!publishedVersion) {
      console.error("No PUBLISHED PlanVersion found — publish a catalog before running this.");
      process.exit(1);
    }
    const priceByKey = Object.fromEntries(
      publishedVersion.definitions.map((d) => [d.planKey, d.monthlyPrice]),
    );

    const tenants = await prisma.tenant.findMany({
      where: { class: { in: ["PRODUCTION", "DEMO"] }, deletedAt: null },
      select: { id: true, slug: true, plan: true, subscription: true },
    });

    const rows = [];
    const skipped = [];

    for (const t of tenants) {
      const catalogKey = LEGACY_PLAN_TO_CATALOG_KEY[t.plan];
      if (!catalogKey) {
        skipped.push({ slug: t.slug, legacyPlan: t.plan, reason: "no catalog mapping" });
        continue;
      }
      const price = priceByKey[catalogKey] ?? null;

      if (!t.subscription) {
        rows.push({ tenantId: t.id, slug: t.slug, action: "create", planKey: catalogKey, price });
      } else if (!t.subscription.planKey || t.subscription.basePriceSnapshot == null) {
        rows.push({ tenantId: t.id, slug: t.slug, action: "backfill", planKey: catalogKey, price });
      }
    }

    console.log(`${tenants.length} tenants scanned, ${rows.length} change(s), ${skipped.length} skipped:`);
    console.table(rows.map((r) => ({ slug: r.slug, action: r.action, planKey: r.planKey, price: r.price })));
    if (skipped.length) {
      console.log("\nSKIPPED — needs manual decision:");
      console.table(skipped);
    }

    if (!apply) {
      console.log("\nDry run only — pass --apply to write these changes.");
      return;
    }

    for (const r of rows) {
      if (r.action === "create") {
        await prisma.tenantSubscription.create({
          data: {
            tenantId: r.tenantId,
            planKey: r.planKey,
            basePriceSnapshot: r.price,
            planVersionId: publishedVersion.id,
            billingMode: "NONE",
          },
        });
      } else {
        await prisma.tenantSubscription.update({
          where: { tenantId: r.tenantId },
          data: { planKey: r.planKey, basePriceSnapshot: r.price, planVersionId: publishedVersion.id },
        });
      }
      await prisma.billingEvent.create({
        data: {
          tenantId: r.tenantId,
          type:
            r.action === "create"
              ? "reconciliation.subscription_created"
              : "reconciliation.snapshot_backfilled",
          payload: { planKey: r.planKey, price: r.price, scriptRun: new Date().toISOString() },
          amountDelta: null,
        },
      });
    }
    console.log(`Applied ${rows.length} change(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

`billingMode: "NONE"` on newly-created rows will not exist as a `TenantSubscription` column
until Phase 1 (see the parent spec's Section 5 data-model table) — **remove that field from the
`create` call in this task** and let Phase 1's migration add the column and a follow-up backfill
decide STRIPE vs MANUAL per tenant, exactly as the design spec's Section 3 states ("this phase
does not decide STRIPE vs MANUAL for a tenant with no row"). Write the `create` call without
`billingMode` for now.

- [ ] **Step 2: Write the failing DB-lane test**

```typescript
// apps/api/scripts/backfill-subscription-reconciliation.db.spec.ts
import { execSync } from "child_process";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

describe("backfill-subscription-reconciliation (db)", () => {
  let tenantNoSub, tenantMissingSnapshot, publishedVersionId;

  beforeAll(async () => {
    const version = await prisma.planVersion.findFirst({ where: { status: "PUBLISHED" } });
    publishedVersionId = version.id;

    tenantNoSub = await prisma.tenant.create({
      data: { slug: "qa-phase0-recon-1", name: "qa-phase0-recon-1", status: "ACTIVE", class: "TEST", plan: "STARTER" },
    });
    tenantMissingSnapshot = await prisma.tenant.create({
      data: {
        slug: "qa-phase0-recon-2", name: "qa-phase0-recon-2", status: "ACTIVE", class: "TEST", plan: "PROFESSIONAL",
        subscription: { create: { planKey: null, basePriceSnapshot: null } },
      },
    });
  });

  afterAll(async () => {
    await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: [tenantNoSub.id, tenantMissingSnapshot.id] } } });
    await prisma.billingEvent.deleteMany({ where: { tenantId: { in: [tenantNoSub.id, tenantMissingSnapshot.id] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantNoSub.id, tenantMissingSnapshot.id] } } });
    await prisma.$disconnect();
  });

  it("dry run makes no writes", async () => {
    execSync("node apps/api/scripts/backfill-subscription-reconciliation.mjs", { encoding: "utf-8" });
    const sub = await prisma.tenantSubscription.findUnique({ where: { tenantId: tenantNoSub.id } });
    expect(sub).toBeNull();
  });

  it("apply creates a missing subscription and backfills a partial one", async () => {
    execSync("node apps/api/scripts/backfill-subscription-reconciliation.mjs --apply", { encoding: "utf-8" });

    const created = await prisma.tenantSubscription.findUnique({ where: { tenantId: tenantNoSub.id } });
    expect(created.planKey).toBe("STARTER");
    expect(Number(created.basePriceSnapshot)).toBeGreaterThan(0);

    const backfilled = await prisma.tenantSubscription.findUnique({ where: { tenantId: tenantMissingSnapshot.id } });
    expect(backfilled.planKey).toBe("SCALE"); // PROFESSIONAL maps to SCALE
    expect(Number(backfilled.basePriceSnapshot)).toBeGreaterThan(0);

    const events = await prisma.billingEvent.findMany({ where: { tenantId: { in: [tenantNoSub.id, tenantMissingSnapshot.id] } } });
    expect(events).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run against the local compose stack to verify fail then pass**

Run: `npm run db:up && npm run local:migrate && npm run local:test:db -- backfill-subscription-reconciliation`
Expected: fails before the script exists / before catalog is published locally (run
`npm run local:seed` first, which publishes the genesis catalog per CLAUDE.md); passes after.

- [ ] **Step 4: Commit**

```bash
git add apps/api/scripts/backfill-subscription-reconciliation.mjs apps/api/scripts/backfill-subscription-reconciliation.db.spec.ts
git commit -m "feat(scripts): subscription-set reconciliation (dry-run/apply)"
```

> **Manual checkpoint (owner):** run the dry-run against a read-only copy of prod (or via
> `railway run --service postgres node apps/api/scripts/backfill-subscription-reconciliation.mjs`
> without `--apply`), review the printed table and the skipped list, take a fresh backup, then
> apply. This is the dry-run diff sign-off the parent spec's Section 8 risk mitigation requires.

---

### Task 12: `PlatformConfig` house-tenant key + `bootstrap-house-tenant.mjs`

**Files:**
- Modify: `apps/api/src/platform-admin/platform-config.service.ts`
- Create: `apps/api/scripts/bootstrap-house-tenant.mjs`

**Interfaces:**
- Produces: `PlatformConfigService.getHouseTenantId(): Promise<string | null>` and
  `setHouseTenantId(id: string): Promise<void>`, consumed by Task 13 (`TenantMirrorService`).

- [ ] **Step 1: Add the config wrapper methods**

In `platform-config.service.ts`, near the other typed accessors (after `getAiConfig`/
`updateAiConfig`), reusing the existing private `getValue`/`setValue`:

```typescript
// ─── Platform identity ──────────────────────────────────────────────────────

async getHouseTenantId(): Promise<string | null> {
  return this.getValue("platform.houseTenantId");
}

async setHouseTenantId(tenantId: string): Promise<void> {
  await this.setValue("platform.houseTenantId", tenantId);
}
```

- [ ] **Step 2: Write the bootstrap script**

```javascript
// apps/api/scripts/bootstrap-house-tenant.mjs
//
// One-time, idempotent creation of the routeflow-hq house tenant, used by Phase 0's
// TenantMirrorService and by every later phase's HQ-based invoicing/messaging. Running
// this twice is a no-op if routeflow-hq already exists — it does not overwrite config.
//
// Usage: node apps/api/scripts/bootstrap-house-tenant.mjs

import { PrismaClient } from "@prisma/client";
import * as crypto from "crypto";

const HOUSE_SLUG = "routeflow-hq";

async function main() {
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.tenant.findUnique({ where: { slug: HOUSE_SLUG } });
    if (existing) {
      console.log(`${HOUSE_SLUG} already exists (id ${existing.id}) — no-op.`);
      const configured = await prisma.$queryRaw`
        SELECT value FROM "PlatformConfig" WHERE key = 'platform.houseTenantId' LIMIT 1
      `;
      if (!configured[0]) {
        await prisma.$executeRaw`
          INSERT INTO "PlatformConfig" ("id", "key", "value", "updatedAt")
            VALUES (gen_random_uuid()::text, 'platform.houseTenantId', ${existing.id}, now())
        `;
        console.log("PlatformConfig key was missing — set it to the existing tenant's id.");
      }
      return;
    }

    const tenant = await prisma.$transaction(async (tx) => {
      const t = await tx.tenant.create({
        data: {
          slug: HOUSE_SLUG,
          name: "RouteFlow HQ",
          status: "ACTIVE",
          plan: "ENTERPRISE",
          class: "INTERNAL",
        },
      });
      await tx.tenantConfig.create({
        data: {
          tenantId: t.id,
          // Placeholder legal identity — the owner must supply the real entity name/address
          // before Phase 1 issues the first invoice off this tenant (see parent spec's
          // owner-decision list, item 3).
          businessName: "RouteFlow HQ",
        },
      });
      return t;
    });

    await prisma.$executeRaw`
      INSERT INTO "PlatformConfig" ("id", "key", "value", "updatedAt")
        VALUES (gen_random_uuid()::text, 'platform.houseTenantId', ${tenant.id}, now())
    `;

    console.log(`Created ${HOUSE_SLUG} (id ${tenant.id}) and set platform.houseTenantId.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Run it against the local compose stack and verify idempotency**

Run: `npm run local:up && node apps/api/scripts/bootstrap-house-tenant.mjs`
Expected: prints "Created routeflow-hq...". Run it again — expected: prints "already exists —
no-op."

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/platform-admin/platform-config.service.ts apps/api/scripts/bootstrap-house-tenant.mjs
git commit -m "feat(platform-admin): bootstrap the routeflow-hq house tenant + PlatformConfig key"
```

---

### Task 13: `TenantMirrorService`

**Files:**
- Create: `apps/api/src/platform-admin/tenant-mirror.service.ts`
- Create: `apps/api/src/platform-admin/tenant-mirror.service.spec.ts`
- Modify: `apps/api/src/platform-admin/platform-admin.module.ts`
- Modify: `apps/api/src/platform-admin/platform-admin.service.ts` (call `upsert` at the end of
  `createTenant` and wherever `updateTenantConfig` lives)

**Interfaces:**
- Consumes: `PlatformConfigService.getHouseTenantId()` (Task 12); `Customer.representsTenantId`
  (Task 1).
- Produces: `TenantMirrorService.upsert(tenantId: string): Promise<void>`, best-effort (never
  throws out of a caller's transaction — caught and logged), consumed by `createTenant()` and by
  its own nightly `@LeaderCron` sweep.

- [ ] **Step 1: Write the failing unit test for idempotency**

```typescript
// apps/api/src/platform-admin/tenant-mirror.service.spec.ts
describe("TenantMirrorService.upsert", () => {
  it("creates one Customer on first call and updates the same row on a second call", async () => {
    prisma.tenant.findUniqueOrThrow.mockResolvedValue({
      id: "t-1",
      name: "Acme Wholesale",
      users: [{ email: "owner@acme.example.com", username: "acme_owner", role: "TENANT_ADMIN" }],
    });
    platformConfig.getHouseTenantId.mockResolvedValue("hq-1");
    prisma.customer.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "cust-1" });
    prisma.customer.create.mockResolvedValue({ id: "cust-1" });

    await service.upsert("t-1");
    await service.upsert("t-1");

    expect(prisma.customer.create).toHaveBeenCalledTimes(1);
    expect(prisma.customer.update).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the house tenant is not configured yet", async () => {
    platformConfig.getHouseTenantId.mockResolvedValue(null);
    await expect(service.upsert("t-1")).resolves.not.toThrow();
    expect(prisma.customer.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest apps/api/src/platform-admin/tenant-mirror.service.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `TenantMirrorService`**

```typescript
// apps/api/src/platform-admin/tenant-mirror.service.ts
import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PlatformConfigService } from "./platform-config.service";
import { LeaderCron } from "../common/cron-lock";

/**
 * Keeps one HQ Customer row per real tenant in sync (name + admin contacts), so Phase 1's
 * invoicing and Phase 4's messaging always have a current record to bill/message against.
 * Best-effort: a failure here must never fail tenant creation or config updates — it is
 * caught and logged by every caller, and the nightly sweep isolates failures per tenant.
 */
@Injectable()
export class TenantMirrorService {
  private readonly logger = new Logger(TenantMirrorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformConfig: PlatformConfigService,
  ) {}

  async upsert(tenantId: string): Promise<void> {
    const houseTenantId = await this.platformConfig.getHouseTenantId();
    if (!houseTenantId) {
      this.logger.warn(`Skipping mirror sync for ${tenantId}: no house tenant configured yet.`);
      return;
    }
    if (tenantId === houseTenantId) return; // never mirror HQ into itself

    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        users: { where: { role: "TENANT_ADMIN", deletedAt: null }, select: { email: true, username: true } },
      },
    });

    const existing = await this.prisma.customer.findUnique({
      where: { representsTenantId: tenantId },
    });

    const customerId = existing
      ? existing.id
      : (
          await this.prisma.customer.create({
            data: {
              tenantId: houseTenantId,
              name: tenant.name,
              representsTenantId: tenantId,
            },
            select: { id: true },
          })
        ).id;

    if (existing) {
      await this.prisma.customer.update({ where: { id: customerId }, data: { name: tenant.name } });
    }

    for (const admin of tenant.users) {
      const contact = await this.prisma.contactPerson.findFirst({
        where: { customerId, email: admin.email },
      });
      if (!contact) {
        await this.prisma.contactPerson.create({
          data: {
            customerId,
            tenantId: houseTenantId,
            firstName: admin.username,
            lastName: "",
            email: admin.email,
          },
        });
      }
    }
  }

  /** Nightly sweep — walks every mirror-eligible tenant, isolating per-tenant failures so one
   * bad record never blocks the rest. Runs under @LeaderCron so a second replica is safe. */
  @LeaderCron("0 6 * * *", "platform-admin.mirror-sync")
  async nightlySweep(): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({
      where: { class: { in: ["PRODUCTION", "DEMO"] }, deletedAt: null },
      select: { id: true },
    });
    const failures: string[] = [];
    for (const t of tenants) {
      try {
        await this.upsert(t.id);
      } catch (err) {
        failures.push(t.id);
        this.logger.error(`Mirror sync failed for tenant ${t.id}: ${(err as Error).message}`);
      }
    }
    if (failures.length) {
      this.logger.warn(`Mirror sync completed with ${failures.length} failure(s): ${failures.join(", ")}`);
    }
  }
}
```

Check `LeaderCron`'s exact import path and decorator signature in `apps/api/src/common/cron-lock.ts`
before finalizing this — the parent spec requires `@LeaderCron(expr, "<area>.<method>")` and an
existing cron in `billing-cron.service.ts` is the reference implementation to match exactly
(argument order, decorator import name).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest apps/api/src/platform-admin/tenant-mirror.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Register the service and wire the two call sites**

In `platform-admin.module.ts`, add `TenantMirrorService` to `providers`.

In `platform-admin.service.ts`'s `createTenant()`, after the existing best-effort Stripe/email
block (around line 314), add:

```typescript
// Best-effort HQ mirror sync — never fails tenant creation.
try {
  await this.tenantMirror.upsert(result.tenant.id);
} catch (err) {
  this.logger.debug(`Mirror sync not created for ${slug}: ${(err as Error).message}`);
}
```

Add `TenantMirrorService` to the constructor. Find `updateTenantConfig`'s method (used by
`PATCH tenants/:id/config`) and add the same best-effort `upsert` call at its end, so a tenant
rename or admin-contact change re-syncs the mirror.

- [ ] **Step 6: Run the full platform-admin test suite**

Run: `npx jest apps/api/src/platform-admin`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/platform-admin/tenant-mirror.service.ts apps/api/src/platform-admin/tenant-mirror.service.spec.ts apps/api/src/platform-admin/platform-admin.module.ts apps/api/src/platform-admin/platform-admin.service.ts
git commit -m "feat(platform-admin): TenantMirrorService — keep one HQ Customer per real tenant in sync"
```

---

### Task 14: Web — live catalog in the Create Tenant plan picker, plan label fixes, MRR field rename

**Files:**
- Modify: `apps/web/app/(platform-admin)/_components/AdminBadge.tsx`
- Modify: `apps/web/app/(platform-admin)/admin/tenants/new/page.tsx`
- Modify: `apps/web/app/(platform-admin)/admin/dashboard/page.tsx`
- Modify: `apps/web/app/(platform-admin)/admin/billing/page.tsx`

**Interfaces:**
- Consumes: `fetchPlanCatalog()` from `@/lib/api/platform-pricing` (already exists, no change);
  the API's new `mrr`/`ledgerMrr` fields (Task 9).

- [ ] **Step 1: Add GROWTH/SCALE to the plan label/color maps**

In `AdminBadge.tsx`, extend both maps (keep the existing entries, including `PROFESSIONAL:
"Business"` — real tenants still on that legacy value until Phase 3's cutover need a label too):

```typescript
const PLAN_COLORS: Record<string, string> = {
  STARTER: "bg-slate-700 text-slate-300 ring-slate-600/30",
  PROFESSIONAL: "bg-blue-900/40 text-blue-400 ring-blue-600/30",
  ENTERPRISE: "bg-purple-900/40 text-purple-400 ring-purple-600/30",
  GROWTH: "bg-teal-900/40 text-teal-400 ring-teal-600/30",
  SCALE: "bg-indigo-900/40 text-indigo-400 ring-indigo-600/30",
};

const PLAN_LABELS: Record<string, string> = {
  STARTER: "Starter",
  PROFESSIONAL: "Business",
  ENTERPRISE: "Enterprise",
  GROWTH: "Growth",
  SCALE: "Scale",
};
```

- [ ] **Step 2: Replace the hardcoded plan list in Create Tenant with a live fetch**

In `admin/tenants/new/page.tsx`, replace:

```typescript
const PLANS = ["STARTER", "PROFESSIONAL", "ENTERPRISE"] as const;
```

with a state-driven fetch on mount, using the already-existing `fetchPlanCatalog`:

```typescript
import { fetchPlanCatalog, type PlanCatalogEntry } from "@/lib/api/platform-pricing";

// inside the component:
const [plans, setPlans] = React.useState<PlanCatalogEntry[]>([]);
React.useEffect(() => {
  fetchPlanCatalog()
    .then((catalog) => setPlans(catalog.plans))
    .catch(() => setPlans([])); // the <select> falls back to whatever `form.plan` already holds
}, []);
```

Update the `<select>` element (around line 256) to map over `plans` instead of the removed
`PLANS` constant, using `plan.planKey` as both the option value and, via `planLabel(plan.planKey)`,
its display text.

- [ ] **Step 3: Update the dashboard and billing pages to read the renamed MRR fields**

In `admin/dashboard/page.tsx`, find every reference to `estMrrUsd` (the field the walkthrough
showed as "Est. MRR $499") and replace it with `mrr`, adding a small secondary line showing
`ledgerMrr` labeled "reconciled" next to it — satisfying the parent spec's requirement that the
two MRR figures never appear as silently-different numbers again.

In `admin/billing/page.tsx`, find its existing MRR KPI card (the one the walkthrough showed as
"$0.00 (+$69.00 last 30d)") and point it at the same `mrr` field from the same `getStats()`/
`GET /billing/admin/mrr` response shape, so both pages show the identical number for the same
tenant set — check which endpoint this page currently calls (`GET /platform-admin/billing/overview`
per the earlier inventory) and confirm that endpoint's service method also now sources from
`MrrService` rather than its own estimate; if it has a separate estimate, apply the same Task 9
pattern to it in this task rather than leaving a third number in play.

- [ ] **Step 4: Manual verification on the local compose stack**

With `npm run local:up`, create a tenant with plan `GROWTH` via the Create Tenant form; confirm
the tenant list and detail page both show "Growth" (not blank, not a raw enum value, not
"Business"). Confirm the dashboard and billing page show the identical MRR figure.

- [ ] **Step 5: Run the web test suite**

Run: `npm test -w apps/web`
Expected: PASS. Update any existing Jest/RTL snapshot or assertion in
`admin/tenants/new/page.test.tsx` (if one exists) that hardcodes the old `PLANS` array.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/(platform-admin)/_components/AdminBadge.tsx" "apps/web/app/(platform-admin)/admin/tenants/new/page.tsx" "apps/web/app/(platform-admin)/admin/dashboard/page.tsx" "apps/web/app/(platform-admin)/admin/billing/page.tsx"
git commit -m "fix(web): live plan catalog in Create Tenant, GROWTH/SCALE labels, one MRR field everywhere"
```

---

### Task 15: Full verification pass and Playwright confirmation

**Files:** none (verification only).

- [ ] **Step 1: Run the full local verify chain**

```bash
npm run check-types
npm run lint
npm run test
```

Expected: all green.

- [ ] **Step 2: Run the full compose-stack gate**

```bash
npm run local:up
npm run local:migrate
npm run local:seed
npm run local:validate
npm run local:test:db
```

Expected: `local:validate` green (smoke + post-deploy-check + drift 0); the DB-lane specs from
Tasks 3, 11, and 13 all pass against the real compose Postgres.

- [ ] **Step 3: Run the existing super-admin Playwright suite**

```bash
npm run local:e2e
```

Expected: `01-super-admin.spec.ts`'s dashboard/tenants/create-tenant checks still pass — this
phase changed response shapes (`mrr` instead of `estMrrUsd`) and the Create Tenant plan picker,
so update any test in that spec that asserts on the removed field name or the old hardcoded
`STARTER/PROFESSIONAL/ENTERPRISE` option list before considering this task done.

- [ ] **Step 4: Manual exit-criteria walkthrough**

Against the local compose stack, by hand: confirm Dashboard MRR, Billing Overview MRR, and one
Tenant 360 page's MRR all show the identical figure for a `GROWTH`-plan test tenant; confirm an
expired-trial `qa-*` tenant reaches the Subscribe button; confirm `routeflow-hq` exists with one
mirrored `Customer` per PRODUCTION/DEMO test tenant (a count query, as the spec's exit criteria
requires); confirm a fresh Google-OAuth admin login shows a real device string in My Account
(not "Unknown device").

- [ ] **Step 5: Update the code map**

Per the project's code-map routine, update `.claude/code-map/api.md` entries for
`platform-admin.service.ts`, `mrr.service.ts`, and add a new entry for `tenant-mirror.service.ts`
and the three new scripts. Bump `.claude/code-map/_meta.json`'s `mappedSha`.

- [ ] **Step 6: Commit the code-map update and open the PR**

```bash
git add .claude/code-map
git commit -m "docs(code-map): update entries for Phase 0 platform-admin changes"
git push -u origin docs/platform-backoffice-design
```

Open the PR from this branch, citing the two spec files and this plan, and noting the two manual
checkpoints (tenant-class review after Task 3, subscription-reconciliation dry-run sign-off after
Task 11) that must be completed against prod data before this is merged and deployed, per the
parent spec's risk mitigations.

---

## Self-Review

**Spec coverage:** every numbered section of the Phase 0 design spec has a task —
classification (Tasks 2-3, 8), legacy plan enum (Tasks 1, 10, 14), subscription reconciliation
(Task 11), one MRR engine (Task 9), trial length (Task 4), READ_ONLY hotfix (Task 7), session
device parsing (Tasks 5-6), HQ bootstrap (Task 12), TenantMirrorService (Task 13). The spec's
"do not decide billingMode" instruction is honored explicitly in Task 11 (the `create` call omits
that field, deferring it to Phase 1).

**Placeholder scan:** no "TBD"/"fill in" steps remain; the one flagged placeholder (HQ's legal
business name in Task 12) is an explicit, named owner input, not an unfinished plan step, and the
task still produces working, testable code without it.

**Type consistency:** `classifyTenantSlug` (Task 2) returns `TenantClass` from `@prisma/client`;
every later reference to a class value uses the same string literals (`"PRODUCTION"`, `"DEMO"`,
`"TEST"`, `"INTERNAL"`). `updateTenantClass` (Task 8) takes `UpdateTenantClassDto` with a `class`
field of that same type. `TenantMirrorService.upsert(tenantId: string)` is the one signature used
consistently by `createTenant()`, `updateTenantConfig()`, and the nightly sweep (Task 13).
`MrrService.computeOverview()`'s return shape (`mrr`, `ledgerMrr`, ...) is unchanged by this plan
— only its query scoping changes — so `getStats()`'s consumption of `mrrOverview.mrr` and
`mrrOverview.ledgerMrr` (Task 9) matches the interface already defined in `mrr.service.ts`.

---

**Plan complete and saved to `docs/superpowers/plans/2026-09-12-backoffice-phase-0-truth.md`.**
