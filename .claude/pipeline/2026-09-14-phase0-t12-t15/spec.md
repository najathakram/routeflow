# Spec — Phase 0 W2 Tasks T12–T15 must do

**Status:** `APPROVED`
**Stage:** S2 — Spec (what) · **Author:** Fable 5.1 (planning subagent) · **Date:** 2026-09-14
**Lives at:** `.claude/pipeline/2026-09-14-phase0-t12-t15/spec.md`
**Prev:** [discovery.md](./discovery.md) · **Next:** [test-plan.md](./test-plan.md)
(No `ux-spec.md`: T14's three surfaces reuse existing, established visual patterns from the exact
files being edited — new badge color/label entries in an existing map, a `<select>` fed from a
different data source with the same markup, an existing stat-card component with a relabeled
value. No new visual pattern is introduced, so S3's "derive before you design" has nothing to
derive; this is recorded here rather than in a separate file so the fence is explicit.)

## 1. Core capability, in one sentence

> The platform admin sees one true, correctly-labeled MRR figure everywhere, and every real
> tenant has a corresponding record on the new `routeflow-hq` house tenant for later phases to
> bill and message against.

## 2. Core use cases, in priority order

| #   | Use case                                                                                                                      | Priority | Justifies shipping |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------ |
| U1  | As the platform admin, I create/view tenants and see the dashboard's MRR match the billing page's MRR, both correctly labeled | must     | ★                  |
| U2  | As the platform admin, I create a tenant on the GROWTH or SCALE plan from the Create Tenant form                              | must     |                    |
| U3  | As a later-phase engineer, I find one HQ `Customer` row per real tenant to build invoicing/messaging against                  | must     |                    |

## 3. Completeness sweep — T13 (`TenantMirrorService`)

| Lifecycle step     | What it means here                                                              | Decision             | Req IDs       | Note                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------- | -------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create             | Mint a placeholder `User` + `Customer` mirroring a real tenant, first time seen | keep                 | R9, R11, R12  | One `$transaction`; placeholder-identity precedent from `customers.service.ts`                                                                                                                                |
| Read (detail)      | n/a — no admin UI reads a single mirror row this phase                          | n/a                  | —             | Phase 5/6 (Tenant 360) territory                                                                                                                                                                              |
| List/filter/search | The nightly sweep enumerates all eligible tenants                               | keep                 | R16           | `class ∈ {PRODUCTION, DEMO}`, `deletedAt: null`                                                                                                                                                               |
| Edit/update        | Refresh `businessName` on rename                                                | keep                 | R10, R18, R19 | `contactName` deliberately NOT refreshed (HQ staff may hand-edit)                                                                                                                                             |
| Delete/undo        | Mirror rows for deleted tenants                                                 | defer                | R-NG1         | Non-goal this phase — Phase 1 needs the history; HQ soft-delete is a later, HQ-side decision                                                                                                                  |
| Permissions        | Who may trigger this                                                            | n/a                  | —             | Internal service + cron only, no endpoint this phase                                                                                                                                                          |
| Audit trail        | `AdminAuditAction` row?                                                         | keep (ruled: NO row) | R22           | A derived, idempotent nightly projection is not an admin decision; N/night of audit noise would drown real actions. `Logger` warn/error + `Customer.createdAt`/`representsTenantId` already record provenance |
| Notification       | n/a                                                                             | n/a                  | —             | Nothing user-facing                                                                                                                                                                                           |
| Export             | n/a                                                                             | n/a                  | —             | Nothing user-facing                                                                                                                                                                                           |

## 4. States, per surface — T14

### Surface: `AdminBadge` plan colors/labels

| State                                                             | Required behavior                                                       | Req ID                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------- |
| Known key (5 total: STARTER/PROFESSIONAL/ENTERPRISE/GROWTH/SCALE) | Correct color + label                                                   | R23                           |
| Unknown key                                                       | Existing fallback (raw value / default ring color) — unchanged behavior | n/a — pre-existing, untouched |
| Loading/Empty/Error                                               | n/a — pure synchronous map lookup, no async state                       | n/a                           |

### Surface: Create Tenant plan `<select>`

| State                                 | Required behavior                                                                                                                                    | Req ID |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Loading                               | Disabled select, single option "Loading plans…"                                                                                                      | R25    |
| Loaded                                | Options = live catalog, sorted `sortOrder`, value `planKey`, text via `planLabel`                                                                    | R24    |
| Error / empty catalog                 | Single option = current `form.plan` value, enabled; muted inline text "Plan catalog unavailable — showing the default plan only"; submit still works | R25    |
| Loaded but `form.plan` not in catalog | Reset `form.plan` to `plans[0].planKey` so the select never shows one value and submits another                                                      | R26    |
| Unauthorized                          | n/a — pre-existing SUPER_ADMIN page guard, untouched                                                                                                 | n/a    |
| Concurrent edit                       | n/a — single-admin form, no shared state                                                                                                             | n/a    |

### Surface: Dashboard MRR card

| State                                  | Required behavior                                                                 | Req ID |
| -------------------------------------- | --------------------------------------------------------------------------------- | ------ |
| Loaded, figures equal                  | "MRR" label, `usd(mrr)` value, "Reconciled to ledger: $X" sub-line, no diff badge | R27    |
| Loaded, figures differ by ≥ 1¢         | Same, plus amber "· differs by $Y" suffix (cents-compared, never float `!==`)     | R27    |
| Fields missing (api/web deploy skew)   | Render "—", never "NaN"                                                           | R27    |
| Loading/Error of the whole stats fetch | n/a — pre-existing page-level state, untouched by this card                       | n/a    |

## 5. Non-functional requirements

| Area                                   | Requirement                                                                                                                                                                                                                                       | Budget / rule                                                                                                                                                                                 | Req ID       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Tenancy/ownership scoping              | Every row `TenantMirrorService` writes (`User`, `Customer`, `ContactPerson`) carries `tenantId === houseTenantId`, **never** the represented tenant's id; `representsTenantId` set exactly once per real tenant, backed by a DB-unique constraint | No `forTenant()`/`tenantCtx.run()` in this service — bare client + explicit `tenantId`, matching `platform-admin.service.ts`'s own established pattern (L-124 does not apply to this pattern) | R21, R13     |
| Idempotency                            | `upsert()` and `bootstrap-house-tenant.mjs` are safe to run any number of times                                                                                                                                                                   | Second run: zero additional writes beyond a `businessName` refresh                                                                                                                            | R3, R10, R12 |
| Security                               | Placeholder users are non-loginable in practice                                                                                                                                                                                                   | Random 32-byte hashed password never disclosed; non-routable `.placeholder.local` email; `forcePasswordChange: true`; least-privilege `CUSTOMER` role                                         | R11          |
| Performance                            | Nightly sweep is O(tenants) × ~5 queries, sequential                                                                                                                                                                                              | Acceptable at current + near-term tenant counts; revisit batching only past ~1,000 tenants                                                                                                    | —            |
| Observability                          | Cron failures are visible without an audit row                                                                                                                                                                                                    | `warn` (no house tenant), `error` (per-tenant failure), `warn` (sweep summary with failure count)                                                                                             | R16          |
| Money-figure consistency (L-119 class) | Dashboard `mrr`/`ledgerMrr` and billing's `/billing/admin/mrr` must trace to the SAME `MrrService.computeOverview()` call                                                                                                                         | Confirmed: `getStats()` and `billing.controller.ts`'s `getMrr()` both call `computeOverview()` directly — no independent estimate anywhere                                                    | R27, R28     |

## 6. Overlap and scope fence

- **Existing feature this overlaps:** none — `routeflow-hq`/`TenantMirrorService` are new; the
  placeholder-identity technique reuses `customers.service.ts`'s established pattern rather than
  inventing a second one.
- **In scope:** T12 (config key + bootstrap script), T13 (mirror service + cron + wiring), T14
  (3 web files: `AdminBadge.tsx`, `admin/tenants/new/page.tsx`, `admin/dashboard/page.tsx`), T15
  (verification only).
- **Out of scope:** `admin/billing/page.tsx`, `admin/tenants/[id]/page.tsx` (R29) — see §9's
  non-goals; any new Prisma migration.
- **Do-not-introduce check:** no new dependency, no second HTTP client, no second test runner,
  no `forTenant()` misuse (see NFR above).

## 7. Deploy day

- **Existing users on deploy day:** no house tenant exists until the owner manually runs
  `bootstrap-house-tenant.mjs` against prod (a separate, owner-gated step, post-merge — not part
  of this PR's automated deploy). Until then, every `upsert()` call logs one `warn` and returns
  with zero writes (R6); `createTenant`/`updateTenantConfig` are completely unaffected by this
  no-op. The nightly sweep logs exactly **one** warning per run pre-bootstrap (the house-tenant
  check is hoisted above the per-tenant loop), not one per tenant.
- **Existing data:** no backfill needed — the mirror populates itself the next time each tenant
  is touched (create, config update) or at the next 06:00 UTC sweep, once the house tenant exists.
- **Backfill:** none required; the sweep IS the backfill mechanism, run nightly forever.
- **Migration:** none this phase.
- **Gate table:** not applicable — nothing here is flag/plan/entitlement-gated.

## 8. Rollback

- **Kill switch:** none needed — this is additive (new service, new config key, new script, 3 UI
  edits), not a behavior change to an existing gated path.
- **Code rollback:** safe to revert the commit/PR.
- **Data rollback:** a revert leaves behind the `routeflow-hq` Tenant + its `TenantConfig` + the
  `platform.houseTenantId` config key (created by the manual bootstrap script, not by the reverted
  code) and any mirrored `Customer`/`User`/`ContactPerson` rows. **Acceptable to leave in place** —
  all of it lives inside the `INTERNAL`-class house tenant, which `MrrService` and the T1–T3 truth
  layer already exclude from every revenue/KPI query. No cleanup script is required or shipped.
- **Blast radius:** display-only for T14 (no writes, admin-only surface); T13's blast radius is a
  wrong `tenantId` on a write, which the tenancy-invariant tests (R21, T13-1) and the tenant-isolation
  NFR above exist specifically to catch before merge.
- **Detection:** `no-bare-cron.spec.ts`'s count assertion catches a dropped/duplicated cron site
  immediately; the nightly sweep's `warn` summary is the ongoing signal; a wrong-tenant write would
  surface as an unexpected row inside `routeflow-hq`'s own tenant-scoped views.

## 9. Requirements table

| ID    | Task            | Requirement                                                                                                                                                                                                                                                                  | Priority        | Verification                                          | Test IDs            |
| ----- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------- | ------------------- |
| R1    | T12             | `PlatformConfigService.getHouseTenantId()` reads key `platform.houseTenantId` via the existing private `getValue`; returns `null` when absent                                                                                                                                | must            | unit                                                  | T12-1               |
| R2    | T12             | `setHouseTenantId(id)` writes via the existing `setValue` (upsert via `ON CONFLICT`)                                                                                                                                                                                         | must            | unit                                                  | T12-2               |
| R3    | T12             | `bootstrap-house-tenant.mjs` creates Tenant `routeflow-hq` (`ACTIVE`, `ENTERPRISE`, `INTERNAL`) + `TenantConfig` in one transaction, then sets the config key; second run is a no-op that writes nothing                                                                     | must            | compose                                               | T12-3               |
| R4    | T12             | Script never overwrites an existing key; if the tenant exists but the key is missing, it sets the key to the existing tenant's id                                                                                                                                            | must            | compose                                               | T12-4               |
| R5    | T12             | Script's only legitimate write target is `routeflow-hq` (hardcoded, no CLI/env override) — not a client-tenant policy violation since it never targets a live/test tenant                                                                                                    | must (negative) | review                                                | —                   |
| R6    | T13             | `upsert(tenantId)` with no house tenant configured: one `warn` log, return, zero Prisma calls                                                                                                                                                                                | must            | unit                                                  | T13-2               |
| R7    | T13             | `upsert(houseTenantId)` (mirroring HQ into itself) is a no-op                                                                                                                                                                                                                | must            | unit                                                  | T13-3               |
| R8    | T13             | Tenants with `class ∉ {PRODUCTION, DEMO}` are skipped by `upsert()` itself (same rule the sweep uses)                                                                                                                                                                        | must            | unit                                                  | T13-4               |
| R9    | T13             | First `upsert(t)` creates exactly one placeholder `User` + one `Customer` in one `$transaction`; both `tenantId === houseTenantId`; `Customer = {userId: placeholder.id, businessName: tenant.name, contactName: firstAdmin.username ?? tenant.name, representsTenantId: t}` | must            | unit + DB-lane                                        | T13-1, T13-9        |
| R10   | T13             | Second `upsert(t)` updates only `businessName` on the existing mirror; no new User/Customer created; `contactName` never refreshed                                                                                                                                           | must            | unit + DB-lane                                        | T13-1               |
| R11   | T13             | Placeholder identity: `{tenantId: houseTenantId, email: "mirror+<tenantId>@placeholder.local", username: "mirror_<tenantId>", role: CUSTOMER, password: bcrypt(random 32 bytes), forcePasswordChange: true}` — keyed by immutable tenant **id**, never slug                  | must            | unit                                                  | T13-1               |
| R12   | T13             | An orphaned placeholder `User` (Customer hand-deleted, User left behind) is reused on the next create, not recreated (avoids a P2002 loop)                                                                                                                                   | must            | unit                                                  | T13-5               |
| R13   | T13 (invariant) | If an existing mirror `Customer.tenantId !== houseTenantId`, log `error` and skip — never update a row in a foreign tenant                                                                                                                                                   | must            | unit                                                  | T13-6               |
| R14   | T13             | One `ContactPerson` per `TENANT_ADMIN` on the mirrored Customer, keyed idempotently by email, on both create and update paths                                                                                                                                                | should          | DB-lane                                               | T13-9               |
| R15   | T13 (negative)  | A tenant with zero `TENANT_ADMIN` users still gets its mirror; `contactName` falls back to `tenant.name`; no throw                                                                                                                                                           | must            | unit                                                  | T13-7               |
| R16   | T13             | `mirrorSync()` under `@LeaderCron("0 6 * * *", "platform-admin.mirrorSync")`: house-tenant check hoisted above the loop; one tenant's failure never stops another's; ends with a failure-count summary                                                                       | must            | unit                                                  | T13-8, T13-8b       |
| R17   | T13             | `no-bare-cron.spec.ts`'s `expect(declared).toBe(14)` becomes `toBe(15)`                                                                                                                                                                                                      | must            | existing spec                                         | T13-13              |
| R18   | T13             | `createTenant()` calls `tenantMirror.upsert(<new id>)` after its transaction, and `updateTenantConfig()` likewise at its end — both best-effort, `logger.debug` on failure, never rethrown                                                                                   | must            | unit                                                  | T13-10, T13-11      |
| R19   | T13             | If a `PlatformAdminService` method exists that writes `Tenant.name` directly (e.g. a tenant-rename endpoint), add the same best-effort mirror call there                                                                                                                     | should          | review                                                | —                   |
| R20   | T13             | `TenantMirrorService` registered in `platform-admin.module.ts` providers; DI resolves; compose API boots cleanly                                                                                                                                                             | must            | check-types + compose health                          | T15-2               |
| R21   | T13 (invariant) | No `forTenant()`/`tenantCtx.run()` anywhere in `tenant-mirror.service.ts`; every write carries an explicit `tenantId: houseTenantId`                                                                                                                                         | must            | unit (asserts `data.tenantId` on every create) + grep | —                   |
| R22   | T13             | No `AdminAuditAction` row written by the mirror (see §3's ruling)                                                                                                                                                                                                            | must            | review                                                | —                   |
| R23   | T14             | `AdminBadge` gains `GROWTH→"Growth"` (teal), `SCALE→"Scale"` (indigo); existing entries unchanged                                                                                                                                                                            | must            | RTL                                                   | T14-1               |
| R24   | T14             | Create Tenant `<select>` options come from `fetchPlanCatalog().plans`, sorted by `sortOrder`; hardcoded `PLANS` array deleted; `isCustom` plans NOT filtered out                                                                                                             | must            | RTL                                                   | T14-2               |
| R25   | T14             | Loading state: disabled select, one "Loading plans…" option. Error/empty state: single option = current `form.plan`, enabled, with inline "Plan catalog unavailable" text; submit still works                                                                                | must            | RTL                                                   | T14-3               |
| R26   | T14             | After load, if `form.plan` is not in the catalog, reset it to `plans[0].planKey`                                                                                                                                                                                             | must            | RTL                                                   | T14-4               |
| R27   | T14             | Dashboard: `estMrrUsd` removed from `PlatformStats`, `mrr`/`ledgerMrr` added; card renders "MRR" (not "Est. MRR"), `usd(stats.mrr)`, a "Reconciled to ledger" sub-line, and an amber diff badge only when the two differ by ≥ 1¢ (cents-compared); missing fields render "—" | must            | RTL                                                   | T14-5, T14-6, T14-7 |
| R28   | T14             | `getStats()` no longer returns `estMrrUsd` at all (ruled: delete in this PR, not defer — see spec §3's precedent)                                                                                                                                                            | must            | unit                                                  | T13-12              |
| R29   | T14 (negative)  | `admin/billing/page.tsx` and `admin/tenants/[id]/page.tsx` are NOT modified                                                                                                                                                                                                  | must            | `git diff --stat` at review                           | —                   |
| R30   | T14             | Zero remaining references to `estMrrUsd`/"Est. MRR" under the dashboard directory and `apps/web/e2e`; `01-super-admin.spec.ts` updated                                                                                                                                       | must            | grep + local:e2e                                      | T15-4               |
| R31   | T15             | `npm run verify` green (fresh worktree — force the turbo test cache)                                                                                                                                                                                                         | must            | Final                                                 | T15-1               |
| R32   | T15             | Full compose chain green (`local:up`→`migrate`→`seed`→bootstrap×2→`validate`→`test:db`→`e2e`); health 200; no DI-resolution errors in logs                                                                                                                                   | must            | Final                                                 | T15-2               |
| R33   | T15             | Exit-criteria count: after creating one tenant via the web form, exactly 1 `Customer` row has `representsTenantId` set, and its `tenantId` is the house tenant's id                                                                                                          | must            | Final                                                 | T15-3               |
| R-NG1 | T13             | Mirror rows for deleted tenants are neither removed nor reconciled this phase                                                                                                                                                                                                | non-goal        | —                                                     | —                   |

## 10. Assumptions (unverified)

| #   | Claim                                                                       | Basis                                                               | Confirm                                                                                            | R#s at risk  | What breaks                                                | Status                                       |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------- | -------------------------------------------- |
| A1  | A placeholder-User row triggers no hidden Prisma side effect                | precedent in production at `customers.service.ts`                   | Baseline grep for `$use(`/`$extends(` on the Prisma client                                         | R9, R11      | An unwanted email/billing side effect on a placeholder row | unverified — checked at Baseline             |
| A2  | `Customer.representsTenantId` is `@unique`                                  | read directly from `sales.prisma:135`                               | already confirmed                                                                                  | R9, R10, R13 | confirmed 2026-09-14                                       |
| A3  | `password`/hasher column names match `customers.service.ts:484-509` exactly | that file is the named precedent, not re-read verbatim in this pack | implementer copies the exact lines when writing WP-B; `tsc` rejects a wrong field name immediately | R9, R11      | Compile failure, caught immediately, not a silent defect   | unverified — self-correcting at compile time |

---

## STOP GATE — S2 → S4

- [x] Core capability is one sentence
- [x] Exactly one ★ use case
- [x] Completeness sweep has an explicit decision on every row
- [x] Every T14 surface has all applicable states, `n/a` reasoned elsewhere
- [x] NFRs cover tenancy scoping, idempotency, security, observability, money-figure consistency
- [x] Deploy day answered (no gate table — ungated feature)
- [x] Rollback and blast radius written
- [x] Every requirement has an ID, priority, verification method
- [x] Negative requirements present (R5, R13, R15, R21, R29)
- [x] Assumptions block filled

**Gate outcome:** PASS — S4 may start.
**Assumptions carried into S4:** A1 (Baseline check), A3 (compile-time self-check).

**Next:** [test-plan.md](./test-plan.md)
**Approved by:** orchestrating session (Sonnet 5) · **on:** 2026-09-14
