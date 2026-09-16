Status: IMPLEMENTED

# Build plan: Phase 0 W2 Tasks T12–T15

> **Stage S5.** Authored by Fable 5.1 (planning subagent) on 2026-09-14. Status: `APPROVED`.
> Inputs: [discovery.md](./discovery.md), [spec.md](./spec.md), [test-plan.md](./test-plan.md).

**Gate to pass before S6:** every package declares `satisfies:`/`provenBy:`. Satisfied below.

---

## Objective

Close out Phase 0 Wave W2: a `PlatformConfig`-backed house-tenant identity + idempotent bootstrap
script (T12); a `TenantMirrorService` that keeps one HQ `Customer` per real tenant in sync, on a
`@LeaderCron` nightly sweep plus best-effort create/update-time calls (T13); three web edits that
close the "one true MRR figure" loop and add GROWTH/SCALE plan support to the admin UI (T14); and
a full verification pass (T15).

**In scope:** the 4 tasks above, exactly as scoped in
`docs/superpowers/plans/2026-09-12-backoffice-phase-0-truth.md` Tasks 12–15, corrected per
[spec.md](./spec.md)'s two rulings (T13's Customer/User creation design; T14's narrower actual
file scope).
**Explicitly out of scope:** any new Prisma migration; `admin/billing/page.tsx`;
`admin/tenants/[id]/page.tsx`; T7/T9/T10/T11 (already built); a manual-trigger endpoint for the
mirror sweep; mirror-row deletion/undo.

---

## Constraints & conventions

- **Stack:** NestJS 11 + Prisma 7 (api), Next.js 14 App Router (web), npm workspaces + Turbo.
- **Test runner:** Jest (`*.spec.ts` api/web unit, `*.db.spec.ts` DB-lane via
  `npm run local:test:db`), RTL (`*.test.tsx` web), Playwright (`apps/web/e2e/*.spec.ts`).
- **Lint/format:** ESLint per-workspace (no root config — always `npm run lint` or inside a
  workspace); Prettier (semicolons, double quotes, printWidth 100, trailing commas).
- **Commits:** Conventional Commits; commitlint enforces subject ≤72 chars, header ≤100 chars —
  put detail in the body, not the subject line.
- **Existing patterns to copy rather than invent:**
  - `apps/api/src/customers/customers.service.ts:484-509` — the placeholder-identity-when-no-
    natural-one pattern (email/password/role/forcePasswordChange), for WP-B.
  - `apps/api/src/platform-admin/platform-admin.service.ts:243-288` — bare `$transaction` +
    explicit `tenantId` for cross-tenant writes from a platform-level service (never
    `forTenant()`/`tenantCtx.run()`), for WP-B.
  - `apps/api/src/billing/billing-cron.service.ts` — any existing `@LeaderCron` site, for the
    exact decorator import/usage shape, for WP-B.
  - `apps/api/src/platform-admin/platform-config.service.ts`'s existing `getValue`/`setValue`
    private helpers — reuse as-is, for WP-A.
- **Must NOT change:** `admin/billing/page.tsx`, `admin/tenants/[id]/page.tsx` (R29); the public
  shape of `MrrService.computeOverview()` (unchanged by this plan — only its consumers change).
- **Do-not-introduce:** nothing new needed — no new dependency.
- **Landmines:**
  - `LeaderCron`'s `NAME_RE` rejects hyphens after the dot — use `"platform-admin.mirrorSync"`,
    not `"platform-admin.mirror-sync"`.
  - `no-bare-cron.spec.ts` hardcodes the total `@LeaderCron(` site count — bump `14`→`15` in the
    SAME PR as WP-B, or a pre-existing test goes red on merge.
  - A fresh worktree/rebase needs `npx prisma generate` before any typecheck/test — already run
    during this session's setup, but WP-B/WP-C implementers should re-run it if they rebase.
  - `Customer.userId` is a required, unique FK — see WP-B's exact code below; do not attempt a
    `customer.create()` without first resolving a `User` row.
  - Windows: drive `grep`/`find` through the Grep tool, never a piped shell `grep -r | head`
    (hangs) — applies to the Final-phase verification greps below.

---

## Test packages

_Written before any implementation. Test-only — no source edits._

### TP-A — `PlatformConfigService` house-tenant wrappers

- **writes:** `apps/api/src/platform-admin/platform-config.service.spec.ts` (extend existing file)
- **tests:** T12-1, T12-2
- **brief:** Two `it` blocks asserting `getHouseTenantId()`/`setHouseTenantId()` call the private
  `getValue`/`setValue` helpers with key `"platform.houseTenantId"`, per test-plan §2.
- **must fail with:** `getHouseTenantId is not a function`

### TP-B — `TenantMirrorService` unit specs

- **writes:** `apps/api/src/platform-admin/tenant-mirror.service.spec.ts`
- **tests:** T13-0, T13-1, T13-2, T13-3, T13-4, T13-5, T13-6, T13-7, T13-8, T13-8b
- **brief:** Exactly the Given/When/Then and oracles in test-plan.md §2 — mock `PrismaService`
  with `$transaction = jest.fn(async (fn) => fn(prisma))` so calls inside the transaction are
  assertable; mock `PlatformConfigService.getHouseTenantId`; `jest.spyOn(Logger.prototype, "warn"|"error")`
  for the log-message oracles. Fixture tenant: `{id:"t-1", name:"Acme Wholesale", class:"PRODUCTION",
users:[{email:"owner@acme.example.com", username:"acme_owner"}]}`, house `"hq-1"`.
- **must fail with:** `Cannot find module './tenant-mirror.service'`

### TP-C — `TenantMirrorService` DB-lane spec

- **writes:** `apps/api/src/platform-admin/tenant-mirror.service.db.spec.ts`
- **tests:** T13-9
- **brief:** Real Postgres via `npm run local:test:db`. Create `qa-hq-<rand>` (class `INTERNAL`)
  and `qa-mirror-<rand>` (class `PRODUCTION`, one `TENANT_ADMIN` `username:"qa_owner"`). Mock only
  `PlatformConfigService.getHouseTenantId` to return the created house tenant's real id (everything
  else hits real Postgres). Run `upsert` ×2, rename the tenant, `upsert` ×1. Assert per test-plan
  §2.1. Clean up in FK-safe order in `afterAll` regardless of test outcome.
- **must fail with:** module/file does not exist

### TP-D — `PlatformAdminService` wiring specs

- **writes:** extend `apps/api/src/platform-admin/platform-admin.service.spec.ts`
- **tests:** T13-10, T13-11, T13-12
- **brief:** Add a `{ provide: TenantMirrorService, useValue: { upsert: jest.fn() } }` mock
  provider to the existing test module setup (needed once `TenantMirrorService` is a real ctor
  dependency, or the whole file's `beforeEach` fails to compile the testing module). Three new
  `it` blocks per test-plan §2 (createTenant calls upsert; updateTenantConfig calls upsert;
  getStats no longer has estMrrUsd).
- **must fail with:** `Nest can't resolve dependencies` (module setup) until WP-C registers the
  mock; then `estMrrUsd` presence failures until WP-C removes the field.

### TP-E — web unit/RTL specs

- **writes:** `apps/web/app/(platform-admin)/_components/AdminBadge.test.tsx`,
  `apps/web/app/(platform-admin)/admin/tenants/new/page.test.tsx`,
  `apps/web/app/(platform-admin)/admin/dashboard/page.test.tsx` (all new files)
- **tests:** T14-1, T14-2, T14-3, T14-4, T14-5, T14-6, T14-7
- **brief:** Per test-plan §2's exact Given/When/Then; mock `@/lib/api/platform-pricing`'s
  `fetchPlanCatalog` and the dashboard's stats-fetch call (`superAdminClient.get`) at the module
  boundary, matching this codebase's existing RTL mocking convention in this directory.
- **must fail with:** missing text/testid assertions (elements not yet rendered)

**Red gate command:**

```bash
cd apps/api && npx jest src/platform-admin/platform-config.service.spec.ts src/platform-admin/tenant-mirror.service.spec.ts src/platform-admin/platform-admin.service.spec.ts src/common/no-bare-cron.spec.ts
cd apps/web && npx jest AdminBadge admin/tenants/new admin/dashboard
```

---

## Work packages

### WP-A — T12: PlatformConfig house-tenant key + bootstrap script

- **files:** `apps/api/src/platform-admin/platform-config.service.ts`,
  `apps/api/scripts/bootstrap-house-tenant.mjs` (new)
- **satisfies:** R1, R2, R3, R4, R5
- **provenBy:** T12-1, T12-2, T12-3, T12-4
- **dependsOn:** none
- **brief:** Add `getHouseTenantId()`/`setHouseTenantId()` as thin wrappers over the existing
  private `getValue`/`setValue` (see the class's existing `getAiConfig`-style accessors for the
  pattern to match). Write the bootstrap script exactly as
  `docs/superpowers/plans/2026-09-12-backoffice-phase-0-truth.md` Task 12 Step 2 specifies (no
  delta found there) — idempotent create-or-noop, key-repair branch, `TenantConfig.businessName`
  placeholder text noting the owner must supply the real legal entity name before Phase 1 invoices
  off this tenant.
- **exact code:**

```typescript
// platform-config.service.ts — add near the other typed accessors
async getHouseTenantId(): Promise<string | null> {
  return this.getValue("platform.houseTenantId");
}

async setHouseTenantId(tenantId: string): Promise<void> {
  await this.setValue("platform.houseTenantId", tenantId);
}
```

### WP-B — T13: `TenantMirrorService` (HIGH risk — money/tenancy package)

- **files:** `apps/api/src/platform-admin/tenant-mirror.service.ts` (new)
- **satisfies:** R6, R7, R8, R9, R10, R11, R12, R13, R14, R15, R16, R17, R21, R22
- **provenBy:** T13-0, T13-1..T13-9, T13-13
- **dependsOn:** none (new file; TP-B/TP-C prove it)
- **effort:** high — **money/tenancy package; waves.json's `moneyCarveOut` makes Opus refute-first
  review mandatory for this package**
- **brief:** Implement exactly the corrected design in spec.md §3a. Also bump
  `apps/api/src/common/no-bare-cron.spec.ts`'s `expect(declared).toBe(14)` to `toBe(15)` in this
  same package (R17) — it is a one-line change but must land with the 15th `@LeaderCron` site, not
  as an afterthought. If `ContactPerson`'s actual fields don't match the loop below (check-types
  will say so immediately), drop the loop and note the deferral in the docstring rather than
  force-fit it — R14 is a `should`, not a `must`.
- **exact code:**

```typescript
// apps/api/src/platform-admin/tenant-mirror.service.ts
import { Injectable, Logger } from "@nestjs/common";
import { TenantClass, UserRole } from "@prisma/client";
import * as bcrypt from "bcrypt"; // match the hasher import used at customers.service.ts:484-509
import * as crypto from "crypto";
import { LeaderCron } from "../common/cron-lock";
import { PrismaService } from "../prisma/prisma.service";
import { PlatformConfigService } from "./platform-config.service";

/** Tenant classes that get an HQ mirror — shared by upsert() and the nightly sweep. */
export const MIRROR_CLASSES: TenantClass[] = [TenantClass.PRODUCTION, TenantClass.DEMO];

/**
 * Deterministic, non-routable identity for the placeholder User that backs a mirrored Customer
 * (Customer.userId is a required unique FK). Keyed by the immutable tenant id — never the slug,
 * which can be reassigned — and unique inside the house tenant via
 * @@unique([tenantId, email]) / @@unique([tenantId, username]).
 */
export function mirrorUserIdentity(tenantId: string): { email: string; username: string } {
  return { email: `mirror+${tenantId}@placeholder.local`, username: `mirror_${tenantId}` };
}

/**
 * Keeps one HQ Customer row per real tenant in sync (name + admin contacts), so Phase 1's
 * invoicing and Phase 4's messaging always have a current record to bill/message against.
 * Best-effort: a failure here must never fail tenant creation or config updates — it is
 * caught and logged by every caller, and the nightly sweep isolates failures per tenant.
 *
 * Tenancy invariant: every row written here carries tenantId = the HOUSE tenant, never the
 * represented tenant. Writes go through the bare Prisma client with an explicit tenantId
 * (the platform-admin.service.ts:243-288 pattern) — NOT forTenant()/tenantCtx.run(); L-124
 * is about forTenant() silently unscoping and does not apply to this pattern.
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
        class: true,
        users: {
          where: { role: UserRole.TENANT_ADMIN, deletedAt: null },
          orderBy: { createdAt: "asc" },
          select: { email: true, username: true },
        },
      },
    });
    if (!MIRROR_CLASSES.includes(tenant.class)) return; // same eligibility rule as the sweep

    const existing = await this.prisma.customer.findUnique({
      where: { representsTenantId: tenantId },
      select: { id: true, tenantId: true },
    });

    let customerId: string;
    if (existing) {
      if (existing.tenantId !== houseTenantId) {
        this.logger.error(
          `Mirror for tenant ${tenantId} lives in tenant ${existing.tenantId}, not the house tenant ${houseTenantId}; skipping.`,
        );
        return;
      }
      await this.prisma.customer.update({
        where: { id: existing.id },
        data: { businessName: tenant.name },
      });
      customerId = existing.id;
    } else {
      const identity = mirrorUserIdentity(tenantId);
      const firstAdmin = tenant.users[0];
      customerId = await this.prisma.$transaction(async (tx) => {
        const placeholder =
          (await tx.user.findFirst({
            where: { tenantId: houseTenantId, email: identity.email },
            select: { id: true },
          })) ??
          (await tx.user.create({
            data: {
              tenantId: houseTenantId,
              email: identity.email,
              username: identity.username,
              role: UserRole.CUSTOMER,
              password: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10),
              forcePasswordChange: true,
            },
            select: { id: true },
          }));

        const created = await tx.customer.create({
          data: {
            tenantId: houseTenantId,
            userId: placeholder.id,
            businessName: tenant.name,
            contactName: firstAdmin?.username ?? tenant.name,
            representsTenantId: tenantId,
          },
          select: { id: true },
        });
        return created.id;
      });
    }

    for (const admin of tenant.users) {
      const contact = await this.prisma.contactPerson.findFirst({
        where: { customerId, email: admin.email },
        select: { id: true },
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

  @LeaderCron("0 6 * * *", "platform-admin.mirrorSync")
  async mirrorSync(): Promise<void> {
    if (!(await this.platformConfig.getHouseTenantId())) {
      this.logger.warn("Mirror sync skipped: no house tenant configured yet.");
      return;
    }
    const tenants = await this.prisma.tenant.findMany({
      where: { class: { in: MIRROR_CLASSES }, deletedAt: null },
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
      this.logger.warn(
        `Mirror sync completed with ${failures.length} failure(s): ${failures.join(", ")}`,
      );
    }
  }
}
```

### WP-C — T13 wiring + estMrrUsd removal

- **files:** `apps/api/src/platform-admin/platform-admin.module.ts`,
  `apps/api/src/platform-admin/platform-admin.service.ts`
- **satisfies:** R18, R19, R20, R28
- **provenBy:** T13-10, T13-11, T13-12, T15-2
- **dependsOn:** WP-B (imports `TenantMirrorService`)
- **brief:** Add `TenantMirrorService` to `platform-admin.module.ts`'s `providers` array. Add
  `tenantMirror: TenantMirrorService` as the 14th constructor parameter of `PlatformAdminService`
  (after the existing `mrrService`). In `createTenant()`, after the existing `$transaction` result
  is destructured (around where the Stripe/email best-effort block runs), add:
  ```typescript
  try {
    await this.tenantMirror.upsert(result.tenant.id); // adapt to the actual local variable name
  } catch (err) {
    this.logger.debug(`Mirror sync not created for ${slug}: ${(err as Error).message}`);
  }
  ```
  Find `updateTenantConfig()` (the method backing `PATCH tenants/:id/config`) and add the
  equivalent best-effort call at its end. Grep the file for any method that writes `Tenant.name`
  directly (a tenant-rename endpoint, if one exists) and add the same call there too (R19) — if
  none exists, note that in the task report rather than inventing one. Delete the `estMrrUsd`
  field from `getStats()`'s return object entirely (it currently reads
  `estMrrUsd: mrrOverview.mrr,` with a comment about "alias until Phase 0 T12" — remove both the
  field and that comment).
- **dependsOn note:** every existing spec file that builds a `PlatformAdminService` test module
  (not just its own `.spec.ts`) needs the new `TenantMirrorService` mock provider added, or the
  module fails to compile — grep the repo for `PlatformAdminService` in test files beyond the one
  named in TP-D.

### WP-D — T14: dashboard MRR card (HIGH risk — money display, L-119 seam class)

- **files:** `apps/web/app/(platform-admin)/admin/dashboard/page.tsx`
- **satisfies:** R27
- **provenBy:** T14-5, T14-6, T14-7
- **dependsOn:** none (no compile dependency on WP-C; the two sides of this seam are proven to
  agree by the Final-phase grep, not by a build-time link)
- **effort:** high — **money display; L-119 seam class; refute-first mandatory**
- **brief:** Replace `PlatformStats.estMrrUsd: number` with `mrr: number; ledgerMrr: number`.
  Replace the existing "Est. MRR" stat card with the `MrrCard` component below, reusing the
  existing card's wrapper CSS classes verbatim (do not invent new spacing/color tokens).
- **exact code:**

```tsx
// PlatformStats interface: replace `estMrrUsd: number;` with:
//   mrr: number;
//   ledgerMrr: number;

// Module scope, next to the existing usd() helper:
function MrrCard({ mrr, ledgerMrr }: { mrr: number | undefined; ledgerMrr: number | undefined }) {
  const ready = typeof mrr === "number" && typeof ledgerMrr === "number";
  const gapCents = ready ? Math.round(mrr * 100) - Math.round(ledgerMrr * 100) : 0;
  return (
    <div className={/* copy the current "Est. MRR" stat card's wrapper classes verbatim */}>
      <div className="text-xs uppercase tracking-wide text-slate-400">MRR</div>
      <div className="text-2xl font-semibold" data-testid="dashboard-mrr">
        {ready ? usd(mrr) : "—"}
      </div>
      <div
        className="mt-1 text-xs text-slate-400"
        data-testid="dashboard-ledger-mrr"
        title="MRR and its ledger reconciliation come from one computation over PRODUCTION tenants."
      >
        Reconciled to ledger: {ready ? usd(ledgerMrr) : "—"}
        {ready && gapCents !== 0 && (
          <span className="ml-1 text-amber-400">· differs by {usd(Math.abs(gapCents) / 100)}</span>
        )}
      </div>
    </div>
  );
}

// In the stats grid, replace the card rendering usd(stats.estMrrUsd) with:
<MrrCard mrr={stats.mrr} ledgerMrr={stats.ledgerMrr} />;
```

### WP-E — T14: plan labels + live catalog (routine)

- **files:** `apps/web/app/(platform-admin)/_components/AdminBadge.tsx`,
  `apps/web/app/(platform-admin)/admin/tenants/new/page.tsx`
- **satisfies:** R23, R24, R25, R26
- **provenBy:** T14-1, T14-2, T14-3, T14-4
- **dependsOn:** none
- **brief:** In `AdminBadge.tsx`, add `GROWTH: "bg-teal-900/40 text-teal-400 ring-teal-600/30"` /
  `SCALE: "bg-indigo-900/40 text-indigo-400 ring-indigo-600/30"` to `PLAN_COLORS`, and
  `GROWTH: "Growth"` / `SCALE: "Scale"` to `PLAN_LABELS`, keeping every existing entry unchanged.
  Confirm `planLabel` is already exported (it is, per the current file) — no new export needed.
  In `admin/tenants/new/page.tsx`, delete the hardcoded `const PLANS = [...]` array; add
  `React.useState<PlanCatalogEntry[]>([])` populated by `fetchPlanCatalog()` on mount (import from
  `@/lib/api/platform-pricing`); on catalog load, if `form.plan` is not among the loaded
  `planKey`s, reset it to the first plan's `planKey`; render the `<select>` with a "Loading
  plans…" disabled option while the fetch is in flight, the sorted live options once loaded, or a
  single fallback option (the current `form.plan`) plus inline "Plan catalog unavailable —
  showing the default plan only" text if the fetch rejects or returns an empty array.

### WP-F — T14/T15: e2e sweep

- **files:** `apps/web/e2e/01-super-admin.spec.ts`
- **satisfies:** R30
- **provenBy:** T15-4
- **dependsOn:** WP-D, WP-E (asserts against their output — testids/copy/live catalog)
- **brief:** Update any assertion on the removed "Est. MRR" label or `estMrrUsd` field to the new
  "MRR" label / `dashboard-mrr` testid; update any assertion on the hardcoded
  `STARTER/PROFESSIONAL/ENTERPRISE` option list to check against the live catalog endpoint's
  `planKey`s in `sortOrder` order instead of a hardcoded array.

### Package map

| WP   | satisfies        | provenBy          | dependsOn  | Wave |
| ---- | ---------------- | ----------------- | ---------- | ---- |
| WP-A | R1-R5            | T12-1..4          | —          | 1    |
| WP-B | R6-R17, R21, R22 | T13-0..9, T13-13  | —          | 1    |
| WP-C | R18-R20, R28     | T13-10..12, T15-2 | WP-B       | 2    |
| WP-D | R27              | T14-5..7          | —          | 1    |
| WP-E | R23-R26          | T14-1..4          | —          | 1    |
| WP-F | R30              | T15-4             | WP-D, WP-E | 2    |

Cross-check: every R# in spec.md §9 appears in some package's `satisfies:` above except R5, R19,
R22 (deliberately review-only per test-plan §3) and R-NG1 (a non-goal). Every T# in test-plan.md
§2 appears in some package's `provenBy:` except T15-1/2/3 (Final-phase, not a package).

---

## Coverage

Closeout tail (2026-09-16), written after the run's own artifacts: `result.json` (final state
`clean: true`, `remainingFindings: []`, `confirmedByPhase: {}` — every finding raised during Gate &
Review/UI verify in the phase snapshots was resolved by the Fix phase) and the merged PR
[#767](https://github.com/najathakram/routeflow/pull/767) (`0d54f46d`, 2026-09-15), which carries
this exact `runDir`'s artifacts verbatim. Result = PASS for every `R#`/`T#` below unless noted.

| R#    | Requirement (short)                 | T#(s)                     | Result | Note                                                                                                                                                                                                                                                                                                                                                   |
| ----- | ----------------------------------- | ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1    | getHouseTenantId                    | T12-1                     | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R2    | setHouseTenantId                    | T12-2                     | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R3    | bootstrap idempotent create         | T12-3                     | PASS   | DEVIATION: shipped as dry-run-by-default + `--apply` flag (`bootstrap-house-tenant.mjs`), not the plain create-or-noop in WP-A's exact code — added during the fix round for a safer owner-run post-merge step                                                                                                                                         |
| R4    | bootstrap key-repair                | T12-4                     | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R5    | bootstrap only targets routeflow-hq | review                    | PASS   | `HOUSE_SLUG` hardcoded, no CLI/env override — confirmed in shipped file                                                                                                                                                                                                                                                                                |
| R6    | upsert no-house-tenant no-op        | T13-2                     | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R7    | upsert(house) no-op                 | T13-3                     | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R8    | class eligibility in upsert         | T13-4                     | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R9    | create path shape                   | T13-1, T13-9              | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R10   | update path minimal refresh         | T13-1, T13-9              | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R11   | placeholder identity scheme         | T13-1                     | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R12   | orphan placeholder reuse            | T13-5                     | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R13   | foreign-tenant guard                | T13-6                     | PASS   | DEVIATION: shipped guard re-validates the house tenant is still class `INTERNAL` and not soft-deleted before every write (not just the mirror row's own `tenantId` check in WP-B's original code) — found by the independent Opus review round (F1-F4) as a real gap: a house tenant later reclassified or deleted would otherwise still accept writes |
| R14   | ContactPerson sync                  | T13-9                     | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R15   | no-admin tenant doesn't crash       | T13-7                     | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R16   | nightly sweep isolation             | T13-8, T13-8b             | PASS   | DEVIATION: shipped `upsert()` additionally serializes per-tenant via a tenant-mirror advisory try-lock and retries once on Prisma P2002 (lost create race) — neither is in WP-B's original exact code; added in the F1-F4 fix round                                                                                                                    |
| R17   | cron count bump                     | T13-13                    | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R18   | call sites wired                    | T13-10, T13-11            | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R19   | rename path (if applicable)         | review                    | PASS   | no direct `Tenant.name`-writing rename endpoint found; documented as such rather than invented, per the build-plan's own instruction                                                                                                                                                                                                                   |
| R20   | DI resolves / boots                 | T15-2                     | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R21   | no forTenant/explicit tenantId      | T13-1 (assertions) + grep | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R22   | no audit row                        | review (absence)          | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R23   | plan badge labels                   | T14-1                     | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R24   | live catalog select                 | T14-2                     | PASS   | DEVIATION: shipped select additionally filters the fetched catalog to `PLAN_KEYS` members only (`@routeflow/types`) before rendering — WP-E's brief didn't call this out; needed because `create-tenant.dto.ts` only accepts a `PLAN_KEYS` member and the live catalog can contain non-`PLAN_KEYS`/legacy rows (tracked in-repo as REG-743-F1)         |
| R25   | loading/error states                | T14-3                     | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R26   | plan reconciliation                 | T14-4                     | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R27   | MRR card                            | T14-5, T14-6, T14-7       | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R28   | estMrrUsd removed                   | T13-12                    | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R29   | untouched files stay untouched      | git diff at review        | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R30   | e2e updated, no stale refs          | T15-4 + grep              | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R31   | verify green                        | T15-1                     | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R32   | compose green                       | T15-2                     | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R33   | exit-criteria count                 | T15-3                     | PASS   |                                                                                                                                                                                                                                                                                                                                                        |
| R-NG1 | (non-goal) deleted-tenant mirrors   | —                         | N/A    | correctly not implemented                                                                                                                                                                                                                                                                                                                              |

**Findings resolved in the Fix phase (not failures of this coverage matrix):** the `06-verify.json`
phase snapshot shows 23 blocker / 8 major / 8 minor findings raised across Baseline/Red
gate/Gate & Review/UI verify; the Fix phase (15 agents, ~12.0M tokens, `claude-opus-5`) resolved
all of them, and the final `result.json` records `remainingFindings: []`. The three DEVIATION notes
above are the substantive, still-visible traces of that round — all three make the shipped code
stricter/safer than the original build-plan, not a scope cut.

**Not independently re-verified by this closeout pass:** T15-2/T15-3/T15-4 (full compose chain,
manual mirror-count check, Playwright e2e) were Final-phase/manual per the test plan and are taken
on the merged PR's own record (`local:validate` + DB lane + CI green per the merge commit message)
rather than re-run here.

---

## Acceptance criteria

1. `R9` — Creating a real tenant (via `createTenant()` or the sweep) produces exactly one
   `Customer` row on `routeflow-hq` with `representsTenantId` set to that tenant's id.
2. `R10` — Running the mirror twice never duplicates the User or Customer row.
3. `R21` — No write in `tenant-mirror.service.ts` carries any `tenantId` other than the house
   tenant's.
4. `R27` — Dashboard and billing pages show the identical MRR figure for the same tenant set.
5. `R29` (negative) — `git diff --stat` against this PR shows no changes to
   `admin/billing/page.tsx` or `admin/tenants/[id]/page.tsx`.
6. Deploy day: with no house tenant configured, every existing tenant-creation/config-update flow
   completes normally (best-effort mirror call fails silently, logged at `debug`/`warn`).

---

## Verification commands

Per round — api packages (WP-A, WP-B, WP-C):

```bash
npm run check-types -w apps/api
npm run lint -w apps/api
cd apps/api && npx jest src/platform-admin src/common/no-bare-cron.spec.ts
```

Per round — web packages (WP-D, WP-E, WP-F):

```bash
npm run check-types -w apps/web
npm run lint -w apps/web
cd apps/web && npx jest platform-admin
```

Final:

```bash
npm run verify
npm run local:down
npm run local:up
npm run local:migrate
npm run local:seed
node apps/api/scripts/bootstrap-house-tenant.mjs
node apps/api/scripts/bootstrap-house-tenant.mjs
npm run local:validate
npm run local:test:db
npm run local:e2e
```

(Grep checks for stray `estMrrUsd`/"Est. MRR"/`forTenant`/`mirror-sync` references are run via the
Grep tool by the reviewing agent, not a piped shell `grep -r` — Windows trap.)

---

## UI verification

- **URL:** `http://localhost:3001/admin` (compose stack, per CLAUDE.md's local hosting runbook)
- **Start command:** none — `npm run local:up` is a prerequisite already covered by the Final
  verification commands above, not something this UI-verify step starts/stops itself.
- **Flows:** (1) Create a tenant with plan GROWTH, confirm the list/detail show "Growth". (2) Open
  the dashboard, confirm MRR is unlabeled "Est." and a reconciled sub-line is present. (3) Open
  Billing Overview immediately after, confirm the same MRR figure.
- **Viewports:** desktop
- **Checks:** `console-errors`, `network-failures`

---

## Risks & rollback

| Risk                                                   | Likelihood                                                   | Blast radius                                        | Mitigation                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------- |
| A mirror write lands with the wrong `tenantId`         | low (guarded by explicit-tenantId pattern + unit assertions) | cross-tenant data placement inside the house tenant | R21's assertions in every WP-B unit test; DB-lane spec; mutation probe #1 |
| `estMrrUsd` removal breaks an unnoticed third consumer | low (two-consumer grep already done)                         | dashboard or another page shows nothing/errors      | Final-phase repo-wide grep (T15, R30) before merge                        |
| Placeholder User triggers a hidden Prisma side effect  | low (precedent already in production)                        | unwanted email/billing action on a system row       | Baseline grep for `$use(`/`$extends(` (discovery.md A1)                   |

- **Rollback:** revert the PR/commit; additive only — see spec.md §8 for what a revert leaves in
  place (acceptable, no cleanup needed).
- **Migration reversibility:** n/a — no migration this phase.
- **Feature flag / entitlement:** none — ungated.
- **Deploy day:** covered in spec.md §7.
- **Observability:** `TenantMirrorService`'s three log levels (warn/error/warn-summary) are the
  ongoing signal; no new metric or alert this phase.

---

## Pipeline args

```js
{
  planPath: '.claude/pipeline/2026-09-14-phase0-t12-t15/build-plan.md',
  discoveryPath: '.claude/pipeline/2026-09-14-phase0-t12-t15/discovery.md',
  specPath: '.claude/pipeline/2026-09-14-phase0-t12-t15/spec.md',
  testPlanPath: '.claude/pipeline/2026-09-14-phase0-t12-t15/test-plan.md',
  lessonsPath: '.claude/lessons/LESSONS.md',
  startedAt: '2026-09-14T16:30:00Z',
  scale: 'major',
  workdir: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-phase0d',
  context: 'Phase 0 W2 T12-T15: house-tenant bootstrap, TenantMirrorService, MRR/plan-label web edits, verification pass — stacked locally on the still-open PR #743 (T9-T11)',

  testPackages: [
    { id: 'TP-A', title: 'PlatformConfig house-tenant wrappers', files: ['apps/api/src/platform-admin/platform-config.service.spec.ts'], brief: 'T12-1, T12-2 per test-plan.md §2' },
    { id: 'TP-B', title: 'TenantMirrorService unit specs', files: ['apps/api/src/platform-admin/tenant-mirror.service.spec.ts'], brief: 'T13-0, T13-1..8b per test-plan.md §2', effort: 'high' },
    { id: 'TP-C', title: 'TenantMirrorService DB-lane spec', files: ['apps/api/src/platform-admin/tenant-mirror.service.db.spec.ts'], brief: 'T13-9 per test-plan.md §2.1', dependsOn: ['TP-B'] },
    { id: 'TP-D', title: 'PlatformAdminService wiring specs', files: ['apps/api/src/platform-admin/platform-admin.service.spec.ts'], brief: 'T13-10, T13-11, T13-12 per test-plan.md §2 — extend existing file' },
    { id: 'TP-E', title: 'Web unit/RTL specs', files: [
        'apps/web/app/(platform-admin)/_components/AdminBadge.test.tsx',
        'apps/web/app/(platform-admin)/admin/tenants/new/page.test.tsx',
        'apps/web/app/(platform-admin)/admin/dashboard/page.test.tsx'
      ], brief: 'T14-1..7 per test-plan.md §2' },
  ],
  redGate: {
    commands: [
      'cd apps/api && npx jest src/platform-admin/platform-config.service.spec.ts src/platform-admin/tenant-mirror.service.spec.ts src/platform-admin/platform-admin.service.spec.ts src/common/no-bare-cron.spec.ts',
      'cd apps/web && npx jest AdminBadge admin/tenants/new admin/dashboard',
    ],
    expect: 'fail',
  },

  packages: [
    { id: 'WP-A', title: 'T12: PlatformConfig house-tenant key + bootstrap script', files: ['apps/api/src/platform-admin/platform-config.service.ts', 'apps/api/scripts/bootstrap-house-tenant.mjs'], brief: 'see build-plan.md WP-A', satisfies: ['R1','R2','R3','R4','R5'], provenBy: ['T12-1','T12-2','T12-3','T12-4'] },
    { id: 'WP-B', title: 'T13: TenantMirrorService', files: ['apps/api/src/platform-admin/tenant-mirror.service.ts', 'apps/api/src/common/no-bare-cron.spec.ts'], brief: 'see build-plan.md WP-B (full exact code included)', satisfies: ['R6','R7','R8','R9','R10','R11','R12','R13','R14','R15','R16','R17','R21','R22'], provenBy: ['T13-0','T13-1','T13-2','T13-3','T13-4','T13-5','T13-6','T13-7','T13-8','T13-8b','T13-9','T13-13'], effort: 'high' },
    { id: 'WP-C', title: 'T13 wiring + estMrrUsd removal', files: ['apps/api/src/platform-admin/platform-admin.module.ts', 'apps/api/src/platform-admin/platform-admin.service.ts'], brief: 'see build-plan.md WP-C', dependsOn: ['WP-B'], satisfies: ['R18','R19','R20','R28'], provenBy: ['T13-10','T13-11','T13-12'] },
    { id: 'WP-D', title: 'T14: dashboard MRR card', files: ['apps/web/app/(platform-admin)/admin/dashboard/page.tsx'], brief: 'see build-plan.md WP-D (full exact code included)', satisfies: ['R27'], provenBy: ['T14-5','T14-6','T14-7'], effort: 'high' },
    { id: 'WP-E', title: 'T14: plan labels + live catalog', files: ['apps/web/app/(platform-admin)/_components/AdminBadge.tsx', 'apps/web/app/(platform-admin)/admin/tenants/new/page.tsx'], brief: 'see build-plan.md WP-E', satisfies: ['R23','R24','R25','R26'], provenBy: ['T14-1','T14-2','T14-3','T14-4'] },
    { id: 'WP-F', title: 'T14/T15: e2e sweep', files: ['apps/web/e2e/01-super-admin.spec.ts'], brief: 'see build-plan.md WP-F', dependsOn: ['WP-D', 'WP-E'], satisfies: ['R30'], provenBy: ['T15-4'] },
  ],

  verifyCommands: {
    perRound: [
      'npm run check-types -w apps/api',
      'npm run lint -w apps/api',
      'cd apps/api && npx jest src/platform-admin src/common/no-bare-cron.spec.ts',
      'npm run check-types -w apps/web',
      'npm run lint -w apps/web',
      'cd apps/web && npx jest platform-admin',
    ],
    final: [
      'npm run verify',
    ],
  },

  formatCommand: 'npm run format',

  uiVerify: {
    url: 'http://localhost:3001/admin',
    startCommand: '',
    flows: [
      'Create a tenant with plan GROWTH; confirm the tenant list and detail page show "Growth"',
      'Open the dashboard; confirm the MRR card shows an unlabeled figure with a "Reconciled to ledger" sub-line, no "Est." prefix',
      'Open Billing Overview immediately after; confirm its MRR figure equals the dashboard\'s',
    ],
    viewports: ['desktop'],
    checks: ['console-errors', 'network-failures'],
  },

  mutationProbe: {
    targets: [
      { file: 'apps/api/src/platform-admin/tenant-mirror.service.ts', behavior: 'Every User/Customer create carries tenantId: houseTenantId, never the represented tenant\'s id', test: 'T13-1' },
      { file: 'apps/api/src/platform-admin/tenant-mirror.service.ts', behavior: 'An existing mirror Customer in a foreign tenant is never updated', test: 'T13-6' },
      { file: 'apps/web/app/(platform-admin)/admin/dashboard/page.tsx', behavior: 'The MRR diff badge compares cents, not raw floats', test: 'T14-6' },
    ],
  },

  runDir: '.claude/pipeline/2026-09-14-phase0-t12-t15',
}
```
