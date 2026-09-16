# Context pack — L2 "Lite $99/mo invite-only plan"

Worktree `rf-lite-L2` @ origin/master bc24582d. Read-only recon, no source edited.
Over 8KB cap (~12KB): schema+money+tenancy lane; §5's architecture gap needs evidence inline.

## 1. TenantPlan enum + plan-key vocabulary

- Prisma enum `apps/api/prisma/schema/tenancy.prisma:22-30`: `STARTER TEAM BUSINESS PROFESSIONAL
ENTERPRISE GROWTH SCALE` (7 values, additive history).
- `PLAN_KEYS` (4-member) `apps/api/src/billing/plan-catalog.constants.ts:16`:
  `["STARTER","GROWTH","SCALE","ENTERPRISE"]`. Mirrored, set-equal-pinned (REG-743-F4 spec) at
  `packages/types/api/enums.ts:290`. Both need `"LITE"` appended.
- `TenantPlanEnumValue` type + `SELECTABLE_TENANT_PLANS` (7-member, admin-DTO) —
  `plan-catalog.constants.ts:230-246`. Both need `"LITE"` for `update-tenant-plan.dto.ts`.
- `planKeyFromEnum()` switch (201-221): explicit case/value, `default→"STARTER"`. Add `case
"LITE": return "LITE"`.
- `planKeyToEnum()` switch (282-295): cases GROWTH/SCALE/ENTERPRISE/STARTER, `default: throw
UnknownPlanKeyError`. Add a LITE case. Routes through `normalizePlanKey()` (107-114) first,
  which accepts only `PLAN_KEYS` members or `LEGACY_PLAN_KEY_ALIASES` — adding LITE to `PLAN_KEYS`
  is sufficient.
- **TenantPlan is NOT in `enum-parity.spec.ts`'s `ENUM_TABLE`** (`apps/api/src/common/
enum-parity.spec.ts:46-91` — deliberately server-only shadow). A new Prisma _value_ isn't new
  `ENUM_TABLE` coverage and doesn't move `PINNED_PRISMA_ENUM_COUNT` (=84, line 125 — counts enum
  _types_). Only the `PLAN_KEYS` parity test (REG-743-F4, 280-288) applies, already exists.
- `planRank()` (117-120) ranks by `PLAN_KEYS.indexOf`, STARTER=0. **R1's "LITE below STARTER"
  needs LITE first in `PLAN_KEYS`, renumbering the rest** — no caller hardcodes a numeric rank
  (all go through `planRank`/`normalizePlanKey`) but the `.indexOf` sweep wasn't exhaustive.

## 2. Migration mechanics

- Naming: `YYYYMMDDHHMMSS_snake_case` (latest `20260913000000_backoffice_phase0_truth`).
- Enum-VALUE-add SQL precedent, same migration's `migration.sql:1-13`: two `ALTER TYPE
"TenantPlan" ADD VALUE '…'` statements in one migration (fine on PG17).
- `apps/api/.squawk.toml`: 9 kept destructive-only rules (drop-table/column/database,
  changing-column-type, adding-required-field, renaming-column/table, truncate-cascade,
  syntax-error) — none blocks ADD VALUE; `require-enum-value-ordering` is excluded.
- `apps/api/prisma.config.ts:7-14`: folder-form schema confirmed; TenantPlan in `tenancy.prisma`.
- `split-prisma-schema.mjs` auto-places enums beside their first referencing model (71-72,
  344-355) — adding a VALUE needs no `MODEL_DOMAIN` edit (models-only map).

## 3. Catalog / publisher / invite-only precedent

- `getPublicCatalog()` `apps/api/src/billing/plan-catalog.service.ts:105-142`. `plans` (110-123)
  is an **unfiltered** map over `v.definitions`. `addons` (127-140) IS filtered:
  `.filter(s => SELF_SERVICE_ADDON_SKUS.includes(s.sku))` — **exact precedent for R2**: add
  `INVITE_ONLY_PLAN_KEYS` beside `SELF_SERVICE_ADDON_SKUS` (`plan-catalog.constants.ts:345-348`,
  currently `["CUSTOMER_PACK_100","FORECASTING"]`), mirror onto `plans` as
  `.filter(d => !INVITE_ONLY_PLAN_KEYS.includes(d.planKey))`. No existing "invite" concept
  anywhere in billing (grep empty) — wholly new export.
- `PlanDefinition.planKey` is a plain `String`, not the Prisma enum (`platform.prisma:125`) — a
  LITE row needs no schema change. `PlanVersion` model: `platform.prisma:103-120`.
- Publishers: `apps/api/package.json:27-30`, latest `db:publish:catalog:v11` →
  `publish-plan-catalog-v11.ts`. LITE needs a new `publish-plan-catalog-v12.ts`: find latest
  PUBLISHED version, check a version-specific idempotency predicate (v11's: "lacks all five
  retired SKUs" — not generic; v12's would be "already has a LITE row"), clone published rows
  into a new DRAFT, add the LITE row, publish in one `$transaction` marking the prior version
  SUPERSEDED. **Existing tenants keep their pinned `planVersionId`** — publishing v12 doesn't
  migrate them, so R7 holds by construction if v12 byte-clones v11 plus the LITE row (same shape
  as v9's MSRP addition).

## 4. Self-serve vs admin endpoints

- `SettingsBillingController` (`settings-billing.controller.ts`): `subscribe` (105-111 →
  `SubscriptionMutationService.subscribe`), `upgrade` (113-119), `downgrade` (121-132), all
  `@Roles(TENANT_ADMIN)`.
- Refusal insertion: `subscription-mutation.service.ts:175-191` (`subscribe()`), after the
  `isCustom` check (179) and `normalizePlanKey` guard (187-191) — add an
  `INVITE_ONLY_PLAN_KEYS.includes(input.planKey)` check. Convention: **`BadRequestException`**
  for every disallowed client-supplied plan key (10+ sites, e.g. 178,179,188,627,717,742) —
  follow it. Same check needed in `upgrade()` (624-628); `downgrade()` (709+) targets a _lower_
  plan, so LITE-as-target is an R1 ranking question, not R2.
- Admin create-tenant `create-tenant.dto.ts:51-52`: `@IsIn(PLAN_KEYS)` already wired — adding
  `"LITE"` to `PLAN_KEYS` alone makes this accept it.
- Admin plan-change `update-tenant-plan.dto.ts:9-11`: `@IsIn(SELECTABLE_TENANT_PLANS)` — needs
  LITE added there (§1).

## 5. Gating mechanism — ARCHITECTURE GAP (read before planning R3)

- `PlanFlagGuard`/`DARK_PLAN_FLAGS` `apps/api/src/billing/plan-flag.guard.ts`. `DARK_PLAN_FLAGS`
  (21-29, `Set` of 7 keys) + `PLAN_FLAG_ENFORCEMENT` env (line 64) is **ONE GLOBAL BOOLEAN PER
  FLAG, not per-tenant/per-plan**: `if (DARK_PLAN_FLAGS.has(flagKey) && enforcement!=="on") return
true`. **No existing mechanism for "dark for all plans except one enforced plan"** — R3 assumes
  one; it doesn't exist. New R3 flags in `DARK_PLAN_FLAGS` with the switch off leave LITE ungated
  (contradicts "enforced for LITE from day one"); switch on enforces all 7 existing dark flags for
  every tenant too. **Needs a decision**: (a) guard reads resolved tenant planKey, skips the
  dark-allow when `planKey==="LITE"`, (b) a per-flag exemption list, or (c) ship always-enforced +
  explicitly grant on every existing plan's catalog row. Not to be inferred by the builder.
- `@RequirePlanFlag` decorator: `require-plan-flag.decorator.ts`; guard calls
  `EntitlementsService.hasFlag()`, fails CLOSED on error (74-84).
- Existing `@RequirePlanFlag` sites to reuse: `analytics.controller.ts:15` (class,
  `flag.analytics`), `returns.controller.ts:20` (class, `flag.returns`),
  `import/migration.controller.ts:26` (class, `flag.import_integrations`),
  `vendor-bills.controller.ts:40` (class, `flag.ap_bills`), `bookkeeping.controller.ts:202-353`
  (~19 handlers, `flag.reports`), `customers.controller.ts:235,243,255` (`flag.pricing_tiers`),
  `inventory.controller.ts:205,212` (`flag.forecasting`), `sales-agents.controller.ts:131` +
  `commission-statements.controller.ts:55` (class, `flag.sales_agents`), `products.controller.ts:
91` (`flag.msrp` — NOT dark, always enforced).
- `@RequireAddon` (separate system, priced add-ons, registry-backed) covers dispatch/routes:
  `drivers.controller.ts:37` (`("recurring_routes","order_delivery","developer_mode")` any-of,
  same shape on `routes.controller.ts` + route-optimization), OCR: `bookkeeping.controller.ts:194`,
  `import/batch.controller.ts:55`, tobacco: `regulated.controller.ts` (5 sites). **R3's OFF list
  spans both systems.**
- **Modules R3 wants OFF with NO gate today** (grep confirmed): `estimates/`,
  `recurring-invoices/`, `credit-notes/`, `suppliers/`, `notifications/` controllers carry neither
  decorator anywhere — new wiring, not a flag-key reuse. `addon.buyer_portal`'s call site not
  located (only its `FLAG_KEYS` entry, constants.ts:87) — confirm gate type before scoping.
- `addon-gate-registry.ts:20-145`: `AddonGateEntry{state,added,routes,grantPath,backfill,
reviewBy}` keyed by addon string, no plan dimension — confirms no plan-flag sibling registry
  exists anywhere in `src/billing`.

## 6. Entitlements read (GET /billing/subscription)

- `settings-billing.controller.ts:59-63` → `SubscriptionService.getSubscription`
  (`subscription.service.ts:24-70+`). Already computes `ent = await entitlements.resolve(
tenantId)` (line 25); `ent.flags` exists (`Entitlements.flags: string[]`,
  `entitlements.service.ts:22-29`) but the response (lines 50-70) doesn't include it — R4 is a
  one-line insert (`flags: ent.flags,`) beside `planKey: ent.planKey` (line 51). `resolve()` at
  `entitlements.service.ts:85`, `hasFlag()` at line 97.
- No `packages/types` type for this response yet — `apps/web/lib/api/billing.ts:52` hand-types
  `SubscriptionView` locally. R4's "packages/types typed" is a **new** shared type, not an edit.

## 7. Client nav / entitlement hiding precedent

- Web sidebar `apps/web/app/(dashboard)/layout.tsx`: `OPERATOR_NAV` array (90-153).
  Conditional-hide fn (182-208) filters group `.children` by href against access booleans; reads
  `useRoutesAccess()`/`useDeliveryAccess()` (302-303) from `apps/web/lib/api/addons.ts:56-64` —
  each returns `{enabled, resolved}`, **fails OPEN** when `!resolved` (addons.ts:13-19: never gate
  render off a bare `!enabled`). Mirror for LITE flags; note the **asymmetry** vs. the server
  guard's fail-CLOSED (§5) — a deliberate call, not a bug to "fix".
- Reusable "Not on your plan" page: `apps/web/app/(dashboard)/_components/gates/PlanGates.tsx` —
  `LockedPage` (14-53, default title "Not on your plan" line 40) is R4's deep-link treatment.
  `PlanGateNotice.tsx` is a smaller toast-only variant (GETs only) — not what R4 wants.
- Mobile: tabs at `apps/mobile/app/(operator)/(tabs)/_layout.tsx` +
  `apps/mobile/components/OperatorTabBar.tsx`; per-route `_layout.tsx` dirs already exist for
  every R3-OFF surface (`estimates/`, `recurring-invoices/`, `routes/`, etc.). `apps/mobile/lib/
api/addons.ts` mirrors web's hooks; `(tabs)/dispatch.tsx`/`more.tsx` already consume them. No
  mobile "not on your plan" component confirmed present or absent this pass.

## 8. Test commands

- API billing: `npx jest --selectProjects api -- billing` (root) or `cd apps/api && npx jest
src/billing`. Confirmed paths: `apps/api/src/common/enum-parity.spec.ts`,
  `apps/api/src/billing/addon-gate-registry.spec.ts`, `apps/api/src/billing/
plan-flag.guard.spec.ts` (not opened — read before extending), `apps/api/src/common/
no-bare-cron.spec.ts`. Drift: `npm run local:drift` (not re-verified).
- Web: `npm test -w apps/web` (Jest+RTL). Mobile: `jest --config jest.config.js`
  (`apps/mobile/package.json:16`), pure-logic only — a hook is testable there, a `_layout.tsx`
  route-group change generally isn't.

## 9. Applicable lessons (LESSONS-DIGEST.md)

- **L-072** — never hand-declare a client mirror of a server enum; derive from a shared package,
  pin set-equal in a spec. Governs §1's mirrors — reuse REG-743-F4's pattern.
- **L-128** — an equality check against one value of an enum-like status is usually an unwritten
  SET-membership test; name the set. Applies to §5's gap — the LITE-exemption mechanism should be
  an explicit named set/check, not a scattered inline compare.
- **L-130** — a control firing a server transition should render off the SAME predicate the
  server checks. Applies to §7 — nav hiding should read the same `flags` `PlanFlagGuard`
  resolves, not a separately-computed client guess.
- No digest entry for: dark-flag rollout pattern, catalog-publisher idempotency, or client
  entitlement/nav-hiding — gaps, not lessons yet.

## 10. Unknowns / contradictions (flagged, not resolved)

- **§5 is the big one** — `DARK_PLAN_FLAGS`/`PLAN_FLAG_ENFORCEMENT` cannot express "dark for
  existing plans, enforced for LITE only" as-is. Needs an owner/Fable decision before
  task-planning the gating mechanism.
- `addon.buyer_portal`'s gate call site not located — confirm mechanism before scoping "buyer
  portal/network OFF".
- Mobile "not on your plan" empty-state: existence unconfirmed either way.
- `planRank()`'s ordinal-by-array-position (§1): inserting LITE first renumbers every other
  plan's rank; no direct `.indexOf` caller found outside `planRank()` but the sweep wasn't
  exhaustive.
- `apps/mobile/__tests__/__mocks__/@routeflow/types.js` has no `PLAN_KEYS` export today — fine
  (nothing mobile-side imports it) but a new LITE-aware mobile test might need it added.
- `plan-flag.guard.spec.ts` contents not opened — read its fixture shape before adding
  DARK_PLAN_FLAGS tests.
