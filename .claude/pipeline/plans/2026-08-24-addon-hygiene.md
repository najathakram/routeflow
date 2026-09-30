# Plan: Addon hygiene — validation, invalidation, self-service gate, dead-toggle removal

> ## ⚠️ WORKTREE
>
> ALL work happens in `C:\ClaudeCode\routeflow\.claude\worktrees\ap-addon-hygiene`
> (branch `fix/addon-hygiene`, master `b3b0f72e`). `cd` there before any command; absolute
> paths under the worktree for every edit. Do not commit/stage/push — the orchestrator does.
> **NO Prisma schema change, NO migration anywhere in this PR.**

> Authored by Fable 5 on 2026-08-24. Status: IMPLEMENTED (pipeline wf_79cec8db-946, 2 fix rounds + orchestrator back-fill fix; fresh full API jest green 164/164; Fable money-pass PASS).
> Grounded in a 12-agent code evaluation (anchors verified 2026-08-24 vs master b3b0f72e).
> Owner decisions (2026-08-24): drop BUYER_PORTAL SKU · retire SEAT_EXTRA/OCR_PACK_250/
> ROUTE_EXTRA/MSG_BUNDLE_500 · MSRP+SALES_AGENTS are admin-only (not self-serviceable).

## Objective

Fix the three system-level addon bugs found 2026-08-24 and remove the drifted admin UI:

1. `AddonService.enableAddon` validates nothing against the catalog and never invalidates the
   entitlements cache (root cause of the sales-agents "not available on your plan" outage).
2. Any TENANT_ADMIN can self-enable admin-only SKUs (MSRP, SALES_AGENTS) via settings→billing.
3. Six platform-admin toggles are vaporware (`ai_scanning, advanced_routes, custom_branding,
advanced_reporting, api_access, priority_support`) — remove them.

Plus: catalog v11 (drops the 5 retired SKUs), platform-admin plan-change writes `planKey`,
mobile developer-mode fail-open race fix, MSRP admin copy + product-form hint.

## Verified anchors (trust these)

- `apps/api/src/billing/addon.service.ts` — constructor :16-19 (PrismaService + StripeService
  only), `enableAddon` :68-132 (upsert at ~:128, logger at ~:130), `disableAddon` :138-168
  (update ~:164, logger ~:166). Never calls `EntitlementsService.invalidate`.
- `apps/api/src/billing/entitlements.service.ts` — `invalidate(tenantId)` :110-112,
  `compute()` addon resolution :174-202 with silent `if (!meta) continue;` at ~:197.
- `apps/api/src/billing/plan-catalog.constants.ts` — `ADDON_SKUS` :123-134,
  `LEGACY_ADDON_KEY_TO_SKU` :239-243, `addonSkuCode()` :246-248.
- `apps/api/src/billing/settings-billing.controller.ts` :143-153 —
  `@Post("addons/:sku/enable") @Roles(TENANT_ADMIN)`, accepts any SKU string.
- `apps/api/src/billing/subscription-mutation.service.ts` :357-360 — self-service
  `enableAddon` checks only that the SKU exists in the version.
- `apps/api/src/billing/plan-catalog.service.ts` :105-135 — `getPublicCatalog()` returns every
  published AddonSku unfiltered.
- `apps/web/app/(dashboard)/settings/billing/page.tsx` :141 — filters only `sku !== "SEAT_EXTRA"`.
- `apps/api/src/platform-admin/platform-admin.service.ts` :380-395 — `updatePlan()` writes only
  legacy `Tenant.plan` + `TenantSubscription.currentPlan`, never `planKey`/`planVersionId`, no
  invalidate. Correct write shape: `SubscriptionMutationService.subscribe()`
  (subscription-mutation.service.ts:126-157). Spec: platform-admin.service.spec.ts:114-136.
- `apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx` — `AVAILABLE_ADDONS` :96-150
  (`sales_agents` entry ~:140; msrp copy ~:136-137; developer_mode copy ~:146-149).
- `apps/mobile/app/(operator)/_layout.tsx` :48 — gates on `!devLoading && !devMode`; the
  CORRECT pattern is the sibling `apps/mobile/app/_layout.tsx` :178 which uses `resolved`
  (fail-open contract documented in `apps/mobile/lib/api/addons.ts` :26-32, isLoading def :46).
- Catalog publish template: `apps/api/prisma/publish-plan-catalog-v10.ts` (whole-file pattern:
  DRAFT carrying plan definitions unchanged → PUBLISH via the same lifecycle; idempotent;
  npm alias in `apps/api/package.json` :27).
- MSRP product form field: `apps/web/app/(dashboard)/warehouse` product edit —
  grep `MSRP (Suggested Retail)` / `per piece — even for boxed products` to find the exact
  component; the hint text sits under that input.

## Work packages (files disjoint; WP2 depends on WP1's constant)

### WP1 — API: validation + invalidation + self-service gate

- **files:** `apps/api/src/billing/addon.service.ts`,
  `apps/api/src/billing/entitlements.service.ts`,
  `apps/api/src/billing/plan-catalog.constants.ts`,
  `apps/api/src/billing/subscription-mutation.service.ts`,
  `apps/api/src/billing/plan-catalog.service.ts`,
  `apps/api/src/billing/addon.service.spec.ts` (create if absent — check for an existing spec
  first), `apps/api/src/billing/subscription-mutation.service.spec.ts` (extend)
- **brief:**
  1. `plan-catalog.constants.ts`: add
     ```ts
     /**
      * SKUs a TENANT_ADMIN may enable from settings→billing. Everything else is
      * platform-admin-only ("ships dark") — owner decision 2026-08-24. SEAT_EXTRA is
      * seat-billing plumbing, never a toggle.
      */
     export const SELF_SERVICE_ADDON_SKUS: readonly AddonSkuCode[] = [
       "CUSTOMER_PACK_100",
       "FORECASTING",
     ] as const;
     ```
  2. `addon.service.ts`: inject `EntitlementsService` (BillingModule already imports
     EntitlementsModule — no module wiring change). In `enableAddon`, BEFORE the upsert:
     resolve `sku = dto.sku ?? LEGACY_ADDON_KEY_TO_SKU[addonKey]` — if a SKU resolves,
     verify it exists in the currently PUBLISHED PlanVersion's AddonSku rows; if it does
     not, throw `BadRequestException("Addon '<key>' maps to SKU '<sku>' which is not in the
published catalog — publish the catalog version that defines it first")`. If NO SKU
     resolves (legacy client-only key like developer_mode), allow the write unchanged (that
     is the documented developer_mode pattern). AFTER the upsert in `enableAddon` and after
     the update in `disableAddon`: `this.entitlements.invalidate(tenantId);`.
  3. `entitlements.service.ts` ~:197: replace the bare `continue` with
     `this.logger.warn(`tenant ${tenantId}: active addon '${row.addonKey}' resolves to SKU
     '${sku}' not present in pinned or published catalog — granting nothing`); continue;`
     (add a `Logger` if the service lacks one).
  4. `subscription-mutation.service.ts` `enableAddon`: after the existing exists-in-version
     check, `if (!SELF_SERVICE_ADDON_SKUS.includes(sku)) throw new ForbiddenException(
"This add-on is enabled by RouteFlow for your workspace — contact support");`.
  5. `plan-catalog.service.ts` `getPublicCatalog()`: filter the addons projection to
     `SELF_SERVICE_ADDON_SKUS` (the public/tenant-facing payload only — do NOT touch any
     platform-admin-facing catalog read).
  6. Specs: enable with unpublished-SKU key → 400 and NO TenantAddon write; enable with
     bridged published key → writes AND `invalidate` called (spy); disable → invalidate
     called; unbridged legacy key (developer_mode) → still allowed, invalidate called;
     self-service enable of MSRP/SALES_AGENTS → Forbidden; CUSTOMER_PACK_100 → allowed;
     public catalog omits MSRP/SALES_AGENTS/BUYER_PORTAL.

### WP2 — Catalog v11 publish script (dependsOn WP1 — imports the constant only if needed)

- **files:** `apps/api/prisma/publish-plan-catalog-v11.ts` (new), `apps/api/package.json`
- **brief:** Mirror `publish-plan-catalog-v10.ts` exactly (same DRAFT→PUBLISH lifecycle, same
  idempotency: exits 0 if the published version already lacks all five). v11 = same plan
  definitions unchanged; AddonSku rows = v10's MINUS `BUYER_PORTAL, SEAT_EXTRA, OCR_PACK_250,
ROUTE_EXTRA, MSG_BUNDLE_500` (owner decision 2026-08-24: retired until real enforcement
  exists; header comment must say re-adding any of them requires its cap check/gate to ship
  first). Keeps `CUSTOMER_PACK_100, FORECASTING, REGULATED_ITEMS, MSRP, SALES_AGENTS`.
  Grandfathering: pinned tenants keep their planVersionId — the header documents that flags
  granted BY PLAN DEFINITIONS (e.g. enterprise addon.\* flags) are untouched. npm alias
  `db:publish:catalog:v11` beside v10's. Do NOT run it — the orchestrator runs it in prod
  post-merge.

### WP3 — Platform-admin page cleanup

- **files:** `apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx`
- **brief:** Remove the six `AVAILABLE_ADDONS` entries: `ai_scanning, advanced_routes,
custom_branding, advanced_reporting, api_access, priority_support` (leaves tobacco_dealer,
  msrp, sales_agents, developer_mode). Reword msrp description to: "Suggested retail price
  (per piece) on products, customers, and invoice pricing — display-only. Nothing appears
  until MSRP values are entered, and only invoices created afterwards show them." Reword
  developer_mode description to end with "(UI-only — hides these surfaces in the official
  apps; not a server-side access control)".

### WP4 — Platform-admin plan change writes planKey

- **files:** `apps/api/src/platform-admin/platform-admin.service.ts`,
  `apps/api/src/platform-admin/platform-admin.service.spec.ts`
- **brief:** `updatePlan()` — in the same transaction as the existing writes: resolve the
  target plan through `normalizePlanKey` against the currently PUBLISHED PlanVersion (reuse
  exactly what `SubscriptionMutationService.subscribe()` does at :126-157 for
  `planKey`/`planVersionId` — extract a small shared helper on SubscriptionMutationService
  if cleanest, or duplicate the two-field write with a comment pointing at subscribe()),
  then call `entitlements.invalidate(tenantId)`. Extend the spec: asserts `planKey` +
  `planVersionId` written and invalidate called (the existing spec only asserts audit-log).
- **dependsOn:** WP1 (entitlements import precedent in the same module tree).

### WP5 — Mobile developer-mode fail-open race

- **files:** `apps/mobile/app/(operator)/_layout.tsx`
- **brief:** Line ~48: change the gate from `!devLoading && !devMode` to
  `devResolved && !devMode`, matching the documented fail-open contract in
  `apps/mobile/lib/api/addons.ts` :26-32 and the sibling chokepoint `app/_layout.tsx` :178.
  If the hook does not currently expose `resolved` under that name, use the same field the
  sibling uses — copy the sibling's exact pattern. One-line semantic change; no redesign.

### WP6 — MSRP first-run hint

- **files:** the web product-form component containing the "MSRP (Suggested Retail)" input
  (grep `per piece — even for boxed products` under `apps/web` to locate; ONLY that file)
- **brief:** Under the MSRP input, when the field is empty, render a muted one-liner:
  "Shown on new invoices once set — existing invoices keep their original snapshot." Static
  text, no new hooks, no API calls.

## Out of scope (do NOT touch)

Tobacco/Regulated consolidation (own session) · buyer-portal module gating (SKU is being
dropped instead) · any `apps/api/prisma/schema.prisma` change · TenantAddon row cleanup in
prod (orchestrator runs a script post-merge) · npm repair aliases (follow-up) ·
`DARK_PLAN_FLAGS` / enforcement semantics · Stripe.

## Acceptance criteria

1. No schema/migration changes; `git diff --stat` clean under `apps/api/prisma/` except the
   new v11 script.
2. Enabling a bridged addon whose SKU is missing from the published catalog returns 400 and
   writes nothing; the error names the key, the SKU, and the remedy.
3. Every addon enable/disable (admin AND self-service paths) invalidates the tenant's
   entitlements cache (spec-asserted via spy).
4. `entitlements.compute()` logs a warning naming tenant/key/SKU for unresolvable grants.
5. Self-service enable of any SKU outside `SELF_SERVICE_ADDON_SKUS` → 403; public catalog
   payload lists only self-service SKUs; platform-admin reads unchanged.
6. v11 script exists, mirrors v10's lifecycle + idempotency, drops exactly the five SKUs,
   has an npm alias, and was NOT executed by the pipeline.
7. Admin page shows exactly 4 toggles (tobacco_dealer, msrp, sales_agents, developer_mode)
   with the reworded msrp/developer_mode copy.
8. `updatePlan` writes planKey/planVersionId consistent with subscribe() and invalidates;
   spec asserts it.
9. Mobile operator chokepoint uses the resolved-gate; no other mobile change.
10. `npm run check-types`, `npm run lint`, `npm run test` green from the worktree root.

## Verification commands

- perRound: `cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-addon-hygiene && npm run check-types`
- final: check-types + `npm run lint` + `npm run test` (same cwd)
