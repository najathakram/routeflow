# Context pack — Phase 0 W2 Tasks T12–T15

Worktree: `.claude/worktrees/rf-phase0d`, branch `feat/phase0-t12-t15`, HEAD `96595470`
(a local-only merge of the still-open PR #743 [T9–T11] — not on master yet; see Delta 0).
Full task text (exact code samples, step-by-step): `docs/superpowers/plans/2026-09-12-backoffice-phase-0-truth.md`
Tasks 12–15 (lines 1543–2020). Read it for the parts with NO delta below — those are correct as written.
waves.json: W2 `moneyCarveOut: true` → gate says "Opus refute-first review is mandatory" for this wave.

## Scope

- **T12** PlatformConfig house-tenant key + `bootstrap-house-tenant.mjs` (2 files: modify
  `platform-config.service.ts`, create the script). No deltas found — plan code is correct.
- **T13** `TenantMirrorService` + `@LeaderCron` nightly sweep (create service+spec, modify
  `platform-admin.module.ts` + `platform-admin.service.ts`). **3 deltas — plan code will not
  compile/run as written.**
- **T14** Web: GROWTH/SCALE plan labels, live catalog in Create-Tenant, MRR field rename.
  **2 deltas — narrower scope than the plan text describes.**
- **T15** Verification pass only (no production files).

## Lessons already pulled (LESSONS.md)

- **L-113**: every new Prisma call site needs a proof its `where`/`data` matches the schema — a
  DB-lane spec or a unit spec asserting the exact shape against `Prisma.<Model>WhereInput`/the
  real model fields; an `any`-typed mock proves nothing about columns. Directly relevant to T13's
  `Customer`/`User` writes (see Delta 3).
- **L-119**: both halves of one money figure must derive from ONE collection; a reviewer inside
  the lane is the wrong instrument for a seam — independent pre-merge review needed. Relevant to
  T14 (dashboard `mrr` vs billing `/billing/admin/mrr` must both trace to the same
  `MrrService.computeOverview()` call — confirmed true, see Delta 5).
- **L-124**: a cron/bootstrap entry point has no ambient tenant — group by tenantId and use
  `tenantCtx.run(tenantId)`; `forTenant()` silently returns the unscoped client otherwise.
  **Does NOT apply to T13 as designed** — see Delta 3's note; flagging so nobody "fixes" it by
  adding `forTenant()` calls, which would introduce exactly this bug class.
- **L-129** (renumbered during my T9–T11 merge just now): before implementing a task from a
  written plan, grep the touched files for the task's own marker/state first — a prior lane's
  actual code often diverges from the plan's stale pseudocode. This whole pack is the product of
  doing exactly that for T12–T15.

## Delta 0 — T9–T11 base (context, not a defect)

PR #743 (T9–T11) is open, not merged to master. I merged `origin/feat/phase0-t9-t11` locally into
this branch (commit 96595470, user-approved) so T14/T15 have real `mrr`/`ledgerMrr` to build
against. The eventual T12–T15 PR will be stacked on #743 until it merges. Confirmed by direct
read: `mrr.service.ts` scopes every query by `class: "PRODUCTION"`; `create-tenant.dto.ts`
validates `plan` via `@IsIn(PLAN_KEYS)` and has `trialLengthDays`. Both match the plan exactly —
no delta on T9/T10 themselves.

## Delta 1 — LeaderCron name must be camelCase, no hyphens

`apps/api/src/common/cron-lock.ts:66`: `NAME_RE = /^[a-z0-9-]+\.[A-Za-z0-9]+$/` — the method
segment (after the dot) allows **no hyphens**. The plan's suggested
`@LeaderCron("0 6 * * *", "platform-admin.mirror-sync")` throws at class-definition time. Every
existing site in the repo (grepped all 14) uses camelCase after the dot, e.g.
`"billing-cron.expireTrials"`, `"crm-gohighlevel.poll"`, `"authorization-expiry.runExpirySweep"`.
Use `"platform-admin.mirrorSync"` (matching a method named `mirrorSync`, not the plan's
`nightlySweep` — either name is fine as long as the string after the dot matches it).

## Delta 2 — bump the LeaderCron site count

`apps/api/src/common/no-bare-cron.spec.ts:111-115` hardcodes
`expect(declared).toBe(14)` (currently exactly 14 sites, verified by grep). T13 adds a 15th.
This assertion must become `toBe(15)` in the SAME PR, or T13's own work fails a pre-existing test.

## Delta 3 — TenantMirrorService.upsert()'s Customer-creation code is broken against the schema

The plan's sample (`tenant-mirror.service.ts` Step 3) does:

```ts
await this.prisma.customer.create({
  data: { tenantId: houseTenantId, name: tenant.name, representsTenantId: tenantId },
});
```

The real `Customer` model (`apps/api/prisma/schema/sales.prisma:123-135`) has **no `name` field**
and requires `userId String @unique` (FK to `User`, NOT NULL, no default — confirmed via
`user User @relation(fields: [userId], references: [id])` at sales.prisma:179), plus required
`businessName: String` and `contactName: String`. There is no way to `customer.create()` without
a real, unique `User` row backing it — this would throw a Prisma validation error on the very
first tenant creation.

**The fix has an exact precedent already in this codebase**, so this is a design-completion, not
open-ended: `customers.service.ts:484-487`
(`// User.email is required + unique per tenant; mint a non-routable internal placeholder when
the customer has no email.` → `` `no-email+${crypto.randomUUID()}@placeholder.local` ``) is the
established pattern for exactly this situation — mint a placeholder `User` first, in the same
transaction, when there's no natural one. `User.email`/`username` are unique **per tenant**
(`@@unique([tenantId, email])`, `@@unique([tenantId, username])` — tenancy.prisma:294-295), so a
placeholder scoped to `tenantId: houseTenantId` with a slug-derived username/email is safe and
collision-free across mirrored tenants. `TenantMirrorService.upsert()` should, on the create path
only (not on update): create a `User` (`tenantId: houseTenantId`, `role: UserRole.CUSTOMER`
matching `customers.service.ts:506`'s convention, a placeholder email/username derived
deterministically from the represented tenant's slug or id, a random hashed password,
`forcePasswordChange: true`), then create the `Customer` with `userId: <that user's id>`,
`businessName: tenant.name`, `contactName: <best available — e.g. the first TENANT_ADMIN's
username already being fetched for `tenant.users`, else fall back to tenant.name>`,
`representsTenantId: tenantId`. The update path only needs to refresh `businessName` (the plan's
own `update()` call only touched one field; keep that minimal).

**On L-124 — do NOT add `forTenant()`/`tenantCtx.run()` here.** `TenantMirrorService` lives in
`platform-admin.module.ts`, architecturally the same bucket as `PlatformAdminService`, which
creates tenant-scoped `User`/`TenantConfig` rows via the **bare** `this.prisma.$transaction()`
client with an **explicit `tenantId`** on every row (`platform-admin.service.ts:243-288`,
already in production, already correct) — never `forTenant()`. L-124's warning is specifically
about `forTenant()` silently scoping to nothing without an active context; the bare-client +
explicit-`tenantId` pattern this codebase already uses for exactly this kind of platform-level,
cross-tenant write is unaffected and is the right one to follow here too.

## Delta 4 — T14 is narrower than the plan text: `admin/billing/page.tsx` needs NO change

Confirmed by reading the live file: `admin/billing/page.tsx` already calls its own dedicated
endpoint, `GET /billing/admin/mrr` (`billing.controller.ts:33-38`, handler body is literally
`return this.mrr.computeOverview();` — the exact same `MrrService` call `getStats()` uses), and
already falls back to a labeled `"Est. MRR"` client-side estimate only when that call fails,
switching to the plain `"MRR"` label when the real value loads. This already satisfies L-119 (one
collection backs both figures) and needs no edit. **Only `admin/dashboard/page.tsx` needs the
migration**: it fetches `GET /platform-admin/stats` (→ `getStats()`) and its `PlatformStats`
interface has `estMrrUsd: number` (line ~30) rendered at line ~209 as
`Est. MRR <span>{usd(stats.estMrrUsd)}</span>`. Replace both the interface field and the
render line with `stats.mrr` (drop "Est."), and add the plan's secondary `ledgerMrr` "reconciled"
line. `AdminBadge.tsx` and `admin/tenants/new/page.tsx` need exactly what the plan already says
(GROWTH/SCALE labels; live `fetchPlanCatalog()` replacing the hardcoded `PLANS` array — confirmed
`PlanCatalogEntry` already exports `{planKey, name, monthlyPrice, annualPrice, isCustom,
sortOrder}` from `apps/web/lib/api/platform-pricing.ts:68-75`).

## Delta 5 — `estMrrUsd` alias removal from `getStats()`

T9 (PR #743) kept `estMrrUsd: mrrOverview.mrr` in `getStats()`'s return
(`platform-admin.service.ts:943`, comment says "alias until Phase 0 T12 updates the dashboard" —
a mislabel in that comment; the plan's own Task 9 Interfaces section has the same T12/T14
mislabeling, this is a pre-existing plan typo, not a new problem). `estMrrUsd` is read in exactly
two web files: `admin/dashboard/page.tsx` (the one T14 migrates) and
`admin/tenants/[id]/page.tsx` (a **different, unrelated** per-tenant "stopgap estimate" field
from a different endpoint entirely — confirmed at line 70/436, explicitly out of scope per the
plan's own Task 9 Step 7 note). Once `dashboard/page.tsx` reads `mrr` instead, `getStats()`'s
`estMrrUsd` field has zero remaining consumers and should be deleted (completing what T9
deferred) — grep the whole repo for `estMrrUsd` after the web edit to confirm before deleting.

## Current-state facts for package boundaries

- `platform-admin.module.ts` providers today: `[PlatformAdminService, PlatformConfigService,
PlatformAdminBuyersService]` — T13 adds `TenantMirrorService`.
- `PlatformAdminService` constructor has 13 injected deps today, ending `mrrService: MrrService`
  (line 71) — T13 adds `tenantMirror: TenantMirrorService` as a 14th. `createTenant()` is at line
  219; its best-effort Stripe/email block runs after the `$transaction` (~line 288-330) — the
  plan's "add the mirror upsert call around line 314" is the right area.
- `platform-config.service.ts` already has the exact `getValue`/`setValue`/`deleteValue` private
  raw-SQL helpers (upsert via `ON CONFLICT ("key")`) the plan's T12 code reuses — no changes
  needed to those, just add the two public wrappers.
- `billing.module.ts` already exports `MrrService` (confirmed, line ~60) — no T9 follow-up needed
  there.
- Money/tenancy risk: T13 (cross-tenant Customer/User creation, a real invariant to get right —
  see Delta 3) and T14's dashboard MRR line (money display, L-119 seam class) should be treated
  as HIGH-risk packages per waves.json's mandatory Opus refute-first gate for this wave; T12 and
  the rest of T14 (labels, catalog fetch) are routine.

## Repo facts

- Test runner: Jest (`apps/api`: `*.spec.ts`; DB-lane: `*.db.spec.ts` via `npm run local:test:db`).
  Web: Jest+RTL (`*.test.tsx`) + Playwright (`e2e/*.spec.ts`).
- Typecheck: `npm run check-types` (turbo, per-workspace). Lint: `npm run lint` (per-workspace
  only, no root config). Format: `npm run format` (Prettier — semicolons, double quotes,
  printWidth 100, trailing commas; commitlint enforces Conventional Commits on the subject line,
  ≤72 chars, header ≤100).
- `npm ci` was in flight when this pack was written (package-lock.json changed by an unrelated
  fast-forward to origin/master) — confirm it finished before running any jest/tsc.
- No new Prisma models/migration needed for T12-T15 — `Customer.representsTenantId` (T1) and the
  widened `TenantPlan`/`TenantClass` (T1) already cover everything these four tasks need.

## Unknowns (Fable: raise if load-bearing, otherwise assume reasonable defaults)

- Exact placeholder-User email/username derivation for T13 (e.g. `mirror+<tenantId>@internal.routeflow.local`
  / `mirror_<slug>`) — pick a deterministic, collision-free scheme; not specified anywhere.
- Whether `UserRole.CUSTOMER` is the right role for a mirror placeholder vs. some other existing
  enum value — `CUSTOMER` matches the only established precedent found; no evidence of a more
  fitting alternative in the enum.
