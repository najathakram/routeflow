# Build plan: Lite ($99/mo, invite-only) plan — L2

> **Stage S5 — "how".** Authored by Fable 5.1 on 2026-09-15 (S4+S5 ruling); expanded into this
> template by a Sonnet transcription agent on 2026-09-15.
> Status: `APPROVED`
> Written AFTER [test-plan.md](./test-plan.md) — the tests decide the shape of the work, not the
> reverse.
> Inputs: [discovery.md](./discovery.md) (why), [spec.md](./spec.md) (`R#`), [ux-spec.md](./ux-spec.md)
> (UI work), [test-plan.md](./test-plan.md) (`T#`), [s4-s5-ruling.md](./s4-s5-ruling.md) (the
> decisions this file transcribes — task graph, hard lines, verify commands, scale/profile call).

**Gate to pass before S6:** every work package declares `satisfies:` (R#s) and
`provenBy:` (T#s). A package that satisfies nothing is scope creep; a package proven by
nothing is unverifiable.

**Ground rule — nothing named here may be invented.** Every path was checked against the tree by
the ruling's author on 2026-09-15 (`ls`/`grep`); "(new)" marks files this lane creates.

---

## Preamble (small scale)

**DELETED.** This is `scale: 'major'` work (six HIGH-risk work packages touching money, tenancy,
and auth; a new Prisma migration; a UI surface across web and mobile) with the full artifact set
already authored — [discovery.md](./discovery.md), [spec.md](./spec.md) (49 R#),
[ux-spec.md](./ux-spec.md), and [test-plan.md](./test-plan.md). The Preamble's small-scale
sufficiency bar does not apply.

---

## Objective

HQ (SUPER_ADMIN) can put a known customer on a new "Lite" plan — orders, invoices, payments,
inventory, and customers, and nothing else — for $99/mo via the existing Stripe checkout, without
the plan ever being visible or selectable by anyone else, and without a single existing tenant
noticing anything changed (spec.md §1).

**In scope:** everything in spec.md §9 (R1, R2, R3a, R3b, R4, R7, R8) — the `LITE` enum value and
migration; the plan-vocabulary constants (`PLAN_KEYS`, `INVITE_ONLY_PLAN_KEYS`,
`ALWAYS_ENFORCED_PLAN_KEYS`); a new plan-keyed enforcement predicate (`allowsFlag`) alongside the
existing `DARK_PLAN_FLAGS` global courtesy; five newly-enforced flags wired onto five controllers'
guards plus the customers-portal handlers; a v12 catalog publish (LITE row + the five new flags on
the four existing plans, additive only); admin create-tenant / plan-change support for LITE; the
tenant-facing checkout endpoint and Settings → Billing CTA; web sidebar hiding + locked-panel deep
link handling; the mobile mirror of the same three-valued gating rule.

**Explicitly out of scope (spec.md §6 non-goals):** manual invoicing (the Stripe checkout lever
stays the only path); any self-serve path _to_ LITE; gating the buyer-facing portal controllers
(`BuyerSellerContextGuard` surface — follow-up F-1); flipping any existing dark flag to enforced
for non-LITE plans (owner's blast-radius call — F-2); a plan-flag registry (F-3); mobile billing
UI; changing STARTER's price or features; the admin create-tenant **form** UI/test
(`admin/tenants/new/page.tsx`, `page.test.tsx`) — owned by the Backoffice T12–T15 lane, see
"Scope boundary" below.

---

## Constraints & conventions

- **Stack / framework:** NestJS 11 + Prisma 7 + PostgreSQL (API); Next.js 14 App Router + Radix +
  Tailwind + TanStack Query (web); Expo 55 / RN 0.83 + expo-router (mobile). npm workspaces +
  Turbo.
- **Test runner and layout:** Jest for all three apps. API specs: `*.spec.ts` beside the source
  file, or a new sibling `*.db.spec.ts` for DB-backed specs (run via `npm run local:test:db`,
  never `npm run test`). Web: `*.test.tsx` (RTL) beside the source; Playwright E2E under
  `apps/web/e2e/*.spec.ts`. Mobile: `__tests__/*.test.ts`, pure-logic only.
- **Lint / format rules that will fail the gate:** ESLint flat config, per-workspace only — lint
  via `npm run lint` or from inside a workspace, never a bare root `eslint`. Prettier: semicolons,
  double quotes, `printWidth` 100, trailing commas — scoped to touched paths via `formatCommand`
  below, never the bare root `npm run format` (L-reference: dirties ~130 unrelated files).
- **Existing patterns to copy rather than invent:**
  - `apps/api/src/billing/addon-gate-registry.ts` + `addon.guard.ts` — the `dark`/`enforced` addon
    gate shape this lane's plan-flag gate parallels.
  - `apps/api/prisma/publish-plan-catalog-v11.ts` (lines 310-318, 327-337) — the idempotency
    predicate and stale-DRAFT refuse/resume shape the v12 publisher reuses verbatim.
  - `apps/web/lib/api/addons.ts` (`useDeveloperMode`-style hook) — the `{enabled, resolved,
failed}` three-valued shape `usePlanFlag` mirrors on both web and mobile.
  - `apps/web/app/(dashboard)/layout.tsx:195-210` (the Dispatch nav group) — the "a group whose
    every child is gated hides with its children" precedent WP8 reuses.
  - `apps/mobile/app/(auth)/operator-blocked.tsx` — the structural clone target for the new
    `PlanLockedScreen`.
  - `apps/api/src/common/addon-guard-module-import.spec.ts` — the repo-truth pattern T16 clones
    for `PlanFlagGuard` consumers.
- **Design system source:** [ux-spec.md](./ux-spec.md)'s "Design-system compliance" table — every
  web/mobile element reuses an existing token or component (`LockedPage`, `Button`, `MobileButton`,
  `packages/ui/src/tokens.ts`); the only new UI is `PlanLockedScreen` (mobile), justified there.
- **Must NOT change:** `admin/tenants/new/page.tsx` / `page.test.tsx` (Backoffice lane owns it —
  see Scope boundary); v11's rows in `publish-plan-catalog-v11.ts` (never edited, only imported);
  the wire shape of any existing `SubscriptionView` field (additive only, R7.6); `notifications.controller.ts`
  (stays ungated, R3b.3 negative).
- **Do-not-introduce list (repo CLAUDE.md):** Vitest, Biome, Supabase, Vercel, a second HTTP
  client, a root-level test runner or root ESLint config. No new dependency, HTTP client, or test
  runner in this lane (spec.md §6 do-not-introduce check) — one new Prisma migration (additive),
  one new shared types file.
- **Landmines (lessons cited by the ruling):** L-072 (a hand-typed mirror of a server enum is how
  three real bugs shipped — `enum-parity.spec.ts` must stay green); L-128 (name the set —
  `ALWAYS_ENFORCED_PLAN_KEYS`, never an inline `=== "LITE"`); L-130 (one predicate feeds both the
  guard and the client's `flags` — never a second decision surface); L-113 (compose boot gate —
  a DI wiring gap between a new guard and its module surfaces only at boot, not at `tsc`/lint);
  L-132 (a mock-shape change in a fixture is not a behavioral assertion change — existing
  assertions in T5/T6 stay byte-identical); L-134 (a DB-backed spec must create what it reads and
  restore what it superseded — never assert against a shared long-lived row); L-063/L-105 (a jest
  invocation's `--reporters=default` must be LAST, or a partial run can overwrite
  `.campaign/runs/*.json`); L-106 (`--passWithNoTests` plus close-out confirms the named T#s
  actually executed); L-151 (`npx prisma generate` before launch — a fresh worktree/rebase carries
  a stale client that fails typecheck at Baseline and gets excluded as a broken command); L-154
  (`hasFlag`'s existing semantics are untouched — `commission-reconciliation` reads it as a pure
  grant check, do not repurpose it); L-008 (F-4/F-5, pre-existing bugs surfaced during research,
  stay out of this lane's scope).

**Scope boundary (lead ruling, cross-lane):** `apps/web/app/(platform-admin)/admin/tenants/new/page.tsx`
and its `page.test.tsx` belong to the Backoffice T12–T15 lane (catalog-driven, filtered to
`PLAN_KEYS`). **No work package below lists either file, and none may.** This lane delivers R2.4's
admin half only by adding `"LITE"` to `PLAN_KEYS` in both `packages/types/api/enums.ts` and
`apps/api/src/billing/plan-catalog.constants.ts` (WP1); the admin form picks LITE up with zero
edits from this lane once that lane's own work lands.

---

## Test packages

_Each TP below merges into its matching WP's `tests[]` in the Pipeline args tasks below — this
build follows the engine's single task-graph shape (see the transcription note under Pipeline
args), so TPs are listed here for traceability against test-plan.md but are not separate tasks._

### TP1 — plan vocabulary + enum parity + migration

- **writes:** `apps/api/src/billing/plan-catalog.constants.spec.ts` (extend), `apps/api/src/common/enum-parity.spec.ts` (extend)
- **tests:** T1, T2, T3
- **brief:** T1 asserts every constant/function in plan-catalog.constants.ts per test-plan.md §2
  row T1 (exact deep-equal literals — `PLAN_KEYS`, `planRank` order, `INVITE_ONLY_PLAN_KEYS`,
  `ALWAYS_ENFORCED_PLAN_KEYS` subset, `LITE_PLAN_DISPLAY_NAME`, etc.). T2 pins API/shared
  `PLAN_KEYS`/`FLAG_KEYS` set-equality and the Prisma enum. T3 asserts exactly one additive-only
  migration file exists with the exact SQL body.
- **must fail with:** `PLAN_KEYS` has 4 members; `FLAG_KEYS` set-equal fails (`[]` vs 21); the
  migration glob returns 0 matches.

### TP2 — plan-flag policy + guard + addon-guard + entitlements matrix

- **writes:** `apps/api/src/billing/plan-flag-policy.spec.ts` (new), `apps/api/src/billing/plan-flag.guard.spec.ts` (extend), `apps/api/src/billing/addon.guard.spec.ts` (extend), `apps/api/src/billing/entitlements.service.spec.ts` (extend)
- **tests:** T4, T5, T6, T7
- **brief:** T4 is the exhaustive `allowsFlag` matrix + `DARK_PLAN_FLAGS` grep-pin. T5 is the
  `PlanFlagGuard` matrix including the R3a.4 DB-outage negative. T6 is `AddonGuard`'s
  always-enforced skip. T7 is `EntitlementsService.isAlwaysEnforcedTenant`.
- **must fail with:** module-not-found guarded to an assertion (T4, T7); dark+off+LITE resolves
  `true` today (T5); the 3rd ctor arg is ignored (T6).

### TP3a — self-serve refusal + public catalog filter

- **writes:** `apps/api/src/billing/subscription-mutation.service.spec.ts` (extend), `apps/api/src/billing/plan-catalog.service.spec.ts` (extend)
- **tests:** T8, T9
- **brief:** T8 proves `subscribe`/`upgrade`/`downgrade` refuse LITE as a target (and accept it as
  a source for the upsell). T9 proves the public catalog filters `isInviteOnlyPlanKey` rows.
- **must fail with:** LITE proceeds to `proration.quote`; `getPublicCatalog().plans` includes LITE.

### TP3b — admin create-tenant

- **writes:** `apps/api/src/platform-admin/platform-admin.service.spec.ts` (extend)
- **tests:** T10
- **brief:** the R1.8 negative (no silent STARTER fallback), the 0-day trial default + welcome
  copy branch, and the R8.2 cache-invalidation on plan-change.
- **must fail with:** `createTenant` never reads the published catalog; defaults to a 14-day trial.

### TP3c — subscription view + tenant checkout endpoint + pricing

- **writes:** `apps/api/src/billing/subscription.service.spec.ts` (extend), `apps/api/src/billing/settings-billing.controller.spec.ts` (extend), `apps/api/src/billing/platform-pricing.service.spec.ts` (extend)
- **tests:** T11, T12, T13
- **brief:** T11 proves the additive `flags`/`paymentRequired` fields and their parity with
  `allowsFlag`. T12 proves the new tenant-facing checkout endpoint. T13 proves the LITE Stripe
  line item name/amount (the STARTER-name-collision discriminator).
- **must fail with:** `flags`/`paymentRequired` undefined; `createCheckout` missing;
  `"RouteFlow Starter — monthly"` resolves for a LITE tenant.

### TP4 — v12 catalog definitions + publisher (db)

- **writes:** `apps/api/src/billing/plan-catalog-v12.spec.ts` (new), `apps/api/src/billing/publish-plan-catalog-v12.db.spec.ts` (new)
- **tests:** T14, T15
- **brief:** T14 pins v12 as a superset of v11 for the four existing plans plus the committed LITE
  row. T15 proves the publisher's idempotency and stale-DRAFT refusal against the compose Postgres.
- **must fail with:** neither definitions module nor `publishV12` exists.

### TP5a — repo-truth guard-import check + estimates/recurring-invoices gate metadata

- **writes:** `apps/api/src/common/plan-flag-guard-module-import.spec.ts` (new), `apps/api/src/estimates/estimates.plan-gate.spec.ts` (new), `apps/api/src/recurring-invoices/recurring-invoices.plan-gate.spec.ts` (new)
- **tests:** T16, T17 (estimates + recurring-invoices files only)
- **brief:** T16 is the repo-truth clone of `addon-guard-module-import.spec.ts` for `PlanFlagGuard`
  consumers. The two T17 files pin `@RequirePlanFlag`/`PlanFlagGuard` reflector metadata for
  `estimates.controller.ts` and `recurring-invoices.controller.ts`.
- **must fail with:** the 5 new controllers don't reference `PlanFlagGuard`; metadata undefined.

### TP5b — credit-notes/suppliers gate metadata

- **writes:** `apps/api/src/credit-notes/credit-notes.plan-gate.spec.ts` (new), `apps/api/src/suppliers/suppliers.plan-gate.spec.ts` (new)
- **tests:** T17 (credit-notes + suppliers files only)
- **brief:** same shape as TP5a's T17 rows, for `credit-notes.controller.ts` and
  `suppliers.controller.ts`.
- **must fail with:** metadata undefined.

### TP5c — messages/customers-portal gate metadata

- **writes:** `apps/api/src/messages/messages.plan-gate.spec.ts` (new), `apps/api/src/customers/customers.portal-plan-gate.spec.ts` (new)
- **tests:** T17 (messages + customers files only)
- **brief:** same shape, for `messages.controller.ts` (plus the R3b.3 negative that
  `notifications.controller.ts` carries no plan-flag metadata) and the 7 handler-level
  `addon.buyer_portal` gates on `customers.controller.ts`.
- **must fail with:** metadata undefined; `NotificationsController` assertion would currently
  vacuously pass (guard against writing a vacuous negative here — assert it explicitly).

### TP7 — web nav map + plan-flag hook

- **writes:** `apps/web/lib/plan-gated-nav.test.ts` (new), `apps/web/lib/api/plan-flags.test.tsx` (new)
- **tests:** T19, T20
- **brief:** T19 is `planFlagVisible`/`PLAN_GATED_NAV`/`matchPlanGatedRoute` pure logic plus the
  R4.8 grep-pin. T20 is `usePlanFlag`'s three-valued RTL hook test.
- **must fail with:** neither module exists.

### TP9 — Settings → Billing CTA

- **writes:** `apps/web/app/(dashboard)/settings/billing/billing-page.test.tsx` (extend)
- **tests:** T21
- **brief:** the "Complete payment" CTA visibility matrix (`paymentRequired` true/false) and its
  click wiring to `useCreateCheckout().mutate`.
- **must fail with:** the button does not render.

### TP10 — web e2e

- **writes:** `apps/web/e2e/47-lite-plan-gate.spec.ts` (new)
- **tests:** T23
- **brief:** the six ux-spec flows verbatim (test-plan.md §8), against `e2e-lite`/`e2e-routeflow`.
- **must fail with:** the tenant/plan fixture does not exist yet (`test.skip` when
  `PLAYWRIGHT_LITE_TENANT_SLUG` is unset — see Open questions §1).

### TP11 — mobile hook + pure helpers

- **writes:** `apps/mobile/__tests__/plan-flags.test.ts` (new)
- **tests:** T22
- **brief:** `planFlagVisible`/`planLockedSection`/`PLAN_GATED_SECTIONS` pure logic plus the R4.8
  grep-pin over mobile source.
- **must fail with:** the module does not exist.

**Red gate command** (runs only these new/extended tests; every one must fail on an assertion,
none may pass):

```bash
cd apps/api && npx jest src/billing src/platform-admin/platform-admin.service.spec.ts src/common/enum-parity.spec.ts src/common/plan-flag-guard-module-import.spec.ts src/common/addon-guard-module-import.spec.ts src/common/app-module-compile.spec.ts src/estimates src/recurring-invoices src/credit-notes src/suppliers src/messages src/customers --maxWorkers=2 --passWithNoTests --reporters=default
cd apps/web && npx jest lib/plan-gated-nav.test.ts lib/api/plan-flags.test.tsx "app/(dashboard)/settings/billing" --passWithNoTests --reporters=default
cd apps/mobile && npx jest __tests__/plan-flags.test.ts __tests__/operator-tabs.test.ts --passWithNoTests --reporters=default
```

---

## Work packages

### WP1 — enum + migration + PLAN_KEYS + plan vocabulary + shared billing types

- **files:** `apps/api/prisma/schema/tenancy.prisma`, `apps/api/prisma/migrations/20260915000000_tenant_plan_lite/migration.sql` (new), `apps/api/src/billing/plan-catalog.constants.ts`, `packages/types/api/enums.ts`, `packages/types/api/billing.ts` (new), `packages/types/index.ts`
- **satisfies:** R1.1, R1.2, R1.3, R1.4, R2.1, R2.7, R2.8, R3a.1, R3a.7, R3b.1, R8.1
- **provenBy:** T1, T2, T3
- **dependsOn:** none
- **risk:** HIGH
- **brief:** Add `LITE` to the Prisma enum (`tenancy.prisma`, after `SCALE`) + the migration (exact
  code below); run `npx prisma generate` in `apps/api` before anything else (L-151 — a stale
  client fails typecheck at Baseline). Constants file gains the full plan-vocabulary block below;
  `FLAG_KEYS` gains `flag.estimates`, `flag.recurring_invoices`, `flag.credit_notes`,
  `flag.suppliers`, `flag.messaging` (append; update the "16 keys" comment to 21). Shared:
  `packages/types/api/enums.ts` `PLAN_KEYS` mirrors the same literal; new
  `packages/types/api/billing.ts` exports `FLAG_KEYS` (same 21 strings), `FlagKey`,
  `SubscriptionView<TDate = string>` (the 14 fields at `apps/web/lib/api/billing.ts:52-70` with
  dates as `TDate | null`, plus `flags: string[]`, `paymentRequired: boolean`);
  `packages/types/index.ts` adds `export * from "./api/billing"`. Do NOT touch
  `apps/web/app/(platform-admin)/admin/tenants/new/page.tsx` or its test (Scope boundary above).
- **exact code:** see this WP's task entry (`id: 'WP1'`) in Pipeline args → `tasks[]` below — the
  migration SQL and the full plan-vocabulary constants block are transcribed there verbatim
  (hard lines a, b) so the code exists in exactly one place in this file.

### WP2 — plan-flag policy + PlanFlagGuard + EntitlementsService.isAlwaysEnforcedTenant + AddonGuard

- **files:** `apps/api/src/billing/plan-flag-policy.ts` (new), `apps/api/src/billing/plan-flag.guard.ts`, `apps/api/src/billing/entitlements.service.ts`, `apps/api/src/billing/addon.guard.ts`
- **satisfies:** R3a.1, R3a.2, R3a.3, R3a.4, R3a.5, R3a.6, R3b.2, R3b.7, R7.1, R8.5
- **provenBy:** T4, T5, T6, T7
- **dependsOn:** WP1
- **risk:** HIGH
- **brief:** New `plan-flag-policy.ts` (exact code below) moves `DARK_PLAN_FLAGS` +
  `isPlanFlagEnforcementOn` out of the guard and adds the five new flags + `addon.buyer_portal`,
  plus the `allowsFlag` predicate. `plan-flag.guard.ts` keeps `export { DARK_PLAN_FLAGS } from
"./plan-flag-policy"` so CLAUDE.md's pointer stays true until close-out; its `canActivate` body
  gets the insertion below. `EntitlementsService` gains `isAlwaysEnforcedTenant`. `AddonGuard`
  gains a 3rd ctor param and the always-enforced skip. Fixture note for T5/T6: the mocks gain
  `resolve` / a 3rd ctor arg — collaborator-contract updates; every existing behavioral assertion
  stays byte-identical (L-132 applies to assertions, not mock shapes).
- **exact code:** see this WP's task entry (`id: 'WP2'`) in Pipeline args → `tasks[]` below — the
  new `plan-flag-policy.ts` module, the guard's `canActivate` insertion, and
  `EntitlementsService`/`AddonGuard`'s new methods are transcribed there verbatim (hard line c).

### WP3a — self-serve refusal + public-catalog filter

- **files:** `apps/api/src/billing/subscription-mutation.service.ts`, `apps/api/src/billing/plan-catalog.service.ts`
- **satisfies:** R2.2, R2.3, R2.6
- **provenBy:** T8, T9
- **dependsOn:** WP1
- **risk:** HIGH
- **brief:** `getPublicCatalog().plans` gains `.filter((d) => !isInviteOnlyPlanKey(d.planKey))`
  before `.map` (mirror of the addons filter at `plan-catalog.service.ts:127`). The refusal below
  goes after the `isCustom` check in `subscribe()` (`:179`) and `upgrade()` (`:628`), and after the
  `planRank(targetPlanKey) < 0` check in `downgrade()` (`:721`), before any quote/read/write.
- **exact code:** see this WP's task entry (`id: 'WP3a'`) in Pipeline args → `tasks[]` below —
  the refusal (hard line e) is transcribed there verbatim.

### WP3b — admin create-tenant: catalog refusal, 0-day trial, welcome copy, checkout URLs

- **files:** `apps/api/src/platform-admin/platform-admin.service.ts`
- **satisfies:** R1.8, R2.4, R2.5, R2.7, R8.2
- **provenBy:** T10
- **dependsOn:** WP1
- **risk:** HIGH
- **brief:** Insert the block below before `tempPassword` (`:231`). `updatePlan` keeps its existing
  `NotFoundException` on a missing definition (already a refusal; no change). Pass explicit
  `successUrl`/`cancelUrl` to the welcome-email `createCheckoutSession` call (line 308) — the
  default `/billing/success` has no web route (Open question 4).
- **exact code:** see this WP's task entry (`id: 'WP3b'`) in Pipeline args → `tasks[]` below —
  the refusal + trial-days + email/checkout-URL block (hard line f) is transcribed there verbatim.

### WP3c — subscription view (`flags`, `paymentRequired`) + tenant checkout endpoint

- **files:** `apps/api/src/billing/subscription.service.ts`, `apps/api/src/billing/settings-billing.controller.ts`
- **satisfies:** R1.7, R2.5, R2.8, R4.1, R4.2, R7.6
- **provenBy:** T11, T12, T13
- **dependsOn:** WP2
- **risk:** HIGH
- **brief:** `SettingsBillingController` constructor gains `private readonly billing: BillingService`
  as the **4th** parameter (T12's `make()` passes it 4th).
- **exact code:** see this WP's task entry (`id: 'WP3c'`) in Pipeline args → `tasks[]` below — the
  `flags`/`paymentRequired` addition (hard line g) and the new checkout endpoint are transcribed
  there verbatim.

### WP4 — v12 catalog publisher (+ v11 pure extraction, scripts, local:seed)

- **files:** `apps/api/prisma/plan-catalog-v11.definitions.ts` (new), `apps/api/prisma/publish-plan-catalog-v11.ts` (imports only), `apps/api/prisma/plan-catalog-v12.definitions.ts` (new), `apps/api/prisma/publish-plan-catalog-v12.ts` (new), `apps/api/package.json`, `package.json`
- **satisfies:** R1.5, R1.6, R1.9, R3b.6, R7.2, R7.4
- **provenBy:** T14, T15
- **dependsOn:** WP1
- **risk:** HIGH
- **brief:** Extract v11's `DefinitionSeed`/`AddonSeed` types, the six `*_FLAGS` arrays,
  `DEFINITIONS`, `ADDON_SEEDS` into `plan-catalog-v11.definitions.ts` (exports `V11_DEFINITIONS`,
  `V11_ADDON_SEEDS`, `DefinitionSeed`, `AddonSeed`); v11 imports them — no other change (C8, a
  non-behavioral edit R7.2 already allows). `plan-catalog-v12.definitions.ts`: `NEW_PLAN_FLAGS` (5
  keys), `LITE_FEATURE_FLAGS = []`, `LITE_DEFINITION` (exact code below), `V12_DEFINITIONS` = LITE
  (sortOrder 0) + v11's four with `featureFlags: [...new Set([...d.featureFlags,
...NEW_PLAN_FLAGS])]` and `sortOrder: d.sortOrder + 1`, `V12_ADDON_SEEDS = V11_ADDON_SEEDS`,
  `buildV12Rows(published | null)`. `publish-plan-catalog-v12.ts`: exports `async function
publishV12(prisma): Promise<{action:"published"|"noop"; version:number}>` — v11's flow (find
  PUBLISHED → idempotency check below → resume/refuse DRAFT → createMany → `$transaction`
  SUPERSEDED+PUBLISHED, `notes: "v12: add LITE (invite-only) + enforce
estimates/recurring_invoices/credit_notes/suppliers/messaging flags, drafted from v<n>"`); the
  `Pool`/`PrismaClient` are built inside `main()`, and `main()` runs only under `if
(require.main === module)` (C8, so a spec can import it without side effects). Scripts:
  `apps/api/package.json` `"db:publish:catalog:v12": "ts-node -r tsconfig-paths/register
prisma/publish-plan-catalog-v12.ts"`; root `local:seed` appends
  ` && npm --prefix apps/api run db:publish:catalog:v12`. Never edit v11's rows.
- **exact code:** see this WP's task entry (`id: 'WP4'`) in Pipeline args → `tasks[]` below — the
  `LITE_DEFINITION` row and the idempotency/DRAFT predicates (hard line d) are transcribed there
  verbatim, one source only (lead instruction, 2026-09-15).

### WP5a — gate wiring: estimates + recurring-invoices

- **files:** `apps/api/src/estimates/estimates.controller.ts`, `apps/api/src/recurring-invoices/recurring-invoices.controller.ts`, `apps/api/src/recurring-invoices/recurring-invoices.module.ts`
- **satisfies:** R3b.3, R3b.5, R3b.9
- **provenBy:** T16, T17
- **dependsOn:** WP2
- **risk:** HIGH (Baseline-classified: authz)
- **brief:** Class-level `@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard)` +
  `@RequirePlanFlag("flag.estimates")` on `estimates.controller.ts`;
  `@RequirePlanFlag("flag.recurring_invoices")` on `recurring-invoices.controller.ts`. Each module
  without `EntitlementsModule` in `imports` adds it (`../billing/entitlements.module`) —
  `recurring-invoices.module.ts` needs the import; `estimates.module.ts` already has it (C2).

### WP5b — gate wiring: credit-notes + suppliers

- **files:** `apps/api/src/credit-notes/credit-notes.controller.ts`, `apps/api/src/credit-notes/credit-notes.module.ts`, `apps/api/src/suppliers/suppliers.controller.ts`, `apps/api/src/suppliers/suppliers.module.ts`
- **satisfies:** R3b.3, R3b.5
- **provenBy:** T17
- **dependsOn:** WP2
- **risk:** HIGH (Baseline-classified: authz)
- **brief:** `credit-notes.controller.ts` — class `@UseGuards(JwtAuthGuard, PlanFlagGuard)` +
  `@RequirePlanFlag("flag.credit_notes")` (its per-handler `RolesGuard` stays, per-handler, not
  moved to class level). `suppliers.controller.ts` — class-level `@UseGuards(JwtAuthGuard,
RolesGuard, PlanFlagGuard)` + `@RequirePlanFlag("flag.suppliers")`. Both modules add
  `EntitlementsModule` to `imports` if absent.

### WP5c — gate wiring: messages + customers portal handlers

- **files:** `apps/api/src/messages/messages.controller.ts`, `apps/api/src/messages/messages.module.ts`, `apps/api/src/customers/customers.controller.ts`
- **satisfies:** R3b.3, R3b.4, R3b.9
- **provenBy:** T17
- **dependsOn:** WP2
- **risk:** HIGH (Baseline-classified: authz)
- **brief:** `messages.controller.ts` — class `@UseGuards(JwtAuthGuard, PlanFlagGuard)` +
  `@RequirePlanFlag("flag.messaging")`; add `EntitlementsModule` to `messages.module.ts` imports.
  `notifications.controller` stays untouched (R3b.3 negative — it is operator device push, not
  customer transport, per correction C3). `customers.controller.ts` — handler-level
  `@UseGuards(PlanFlagGuard) @RequirePlanFlag("addon.buyer_portal")` on the 7 portal handlers
  (`:108,:356,:366,:372,:378,:384,:390`), pattern of `:234-235`; `findAll` and every non-portal
  handler carry no plan-flag metadata; `customers.module.ts` already imports `EntitlementsModule`
  (C2).

### WP7 — web: shared type import, `usePlanFlag`, `useCreateCheckout`, nav map + route matcher

- **files:** `apps/web/lib/api/billing.ts`, `apps/web/lib/api/plan-flags.ts` (new), `apps/web/lib/plan-gated-nav.ts` (new)
- **satisfies:** R2.5, R4.1, R4.3, R4.5
- **provenBy:** T19, T20
- **dependsOn:** WP1, WP3c
- **brief:** `billing.ts`: replace the local `SubscriptionView` with `import type {
SubscriptionView } from "@routeflow/types"; export type { SubscriptionView };`; add
  `useCreateCheckout()` = `useMutation<{checkoutUrl:string}>` posting
  `/billing/subscription/checkout`, `onSuccess: (r) => window.location.assign(r.checkoutUrl)`.
  `plan-flags.ts`: `usePlanFlag(key, opts?: {enabled?: boolean})` → `{enabled, resolved, failed}`
  from `useSubscription({ staleTime: 60_000, ...opts })` (`resolved = q.isSuccess`, `failed =
q.isError`, `enabled = q.data?.flags?.includes(key) ?? false`).
- **exact code:** see this WP's task entry (`id: 'WP7'`) in Pipeline args → `tasks[]` below
  (hard line h) — one source only (lead instruction, 2026-09-15).

### WP8 — web: sidebar hiding + RouteGuard LockedPage

- **files:** `apps/web/app/(dashboard)/layout.tsx`
- **satisfies:** R4.3, R4.5, R7.7
- **provenBy:** (none directly — proven by T19/T20's pure logic + T23's e2e)
- **dependsOn:** WP7
- **brief:** In `DashboardShell` (`layout.tsx:1057`) read one `useSubscription({staleTime:60_000,
enabled:isStaff})` result (it already exists at `:1078` — reuse, do not add a query) and derive
  a `planState`; filter `navStructure` leaves whose `href ∈ PLAN_GATED_NAV` by
  `planFlagVisible(...)` (omit — no skeleton, per ux-spec); a group left with zero children is
  dropped (Dispatch-group precedent `:195-210`). `RouteGuard` (`:298`): `const key =
matchPlanGatedRoute(pathname)`; when `key && planState.resolved &&
!planState.flags.includes(key)` render `<LockedPage gate={{code:"PLAN_GATE", flag:key,
message:` This feature isn't included in the ${planName} plan. `, upgrade:{planKey:null,
planMonthlyPrice:null, addonSku:null, addonMonthlyPrice:null}}}>` with the secondary line "Want
  it? Contact us to upgrade." under the CTA; while unresolved or failed, render the page as today
  (the existing `PlanGateNotice` toast covers a server 403 — Open question 6). CUSTOMER/DRIVER
  branches untouched.

### WP9 — web: Settings → Billing "Complete payment"

- **files:** `apps/web/app/(dashboard)/settings/billing/page.tsx`
- **satisfies:** R2.5, R2.8
- **provenBy:** T21
- **dependsOn:** WP7
- **brief:** Beside the plan header (`page.tsx:214`): when `s.paymentRequired` render `<Button
loading={checkout.isPending} onClick={() => checkout.mutate()}>Complete payment</Button>` with
  the price line `Lite · $99/mo` composed from `s.planName`/`money(s.monthlyPrice)` — never the
  literal. No other change.

### WP10 — web e2e spec + Playwright project

- **files:** `apps/web/e2e/47-lite-plan-gate.spec.ts` (new), `apps/web/playwright.config.ts`
- **satisfies:** R2.2, R2.5, R2.6, R2.8, R3b.8, R4.3, R4.5, R7.7
- **provenBy:** T23
- **dependsOn:** WP8, WP9
- **brief:** Copy ux-spec flows 1–6 verbatim. `test.skip` when `PLAYWRIGHT_LITE_TENANT_SLUG` is
  unset (fixture policy — Open question 1). Project `lite-plan-gate` (`testMatch:
/47-lite-plan-gate\.spec\.ts/`, `dependencies: ["setup"]`, operator storage state) — it is NOT
  in the local Playwright allow-list.

### WP11 — mobile: `useSubscription`/`usePlanFlag`, pure helpers, `PlanLockedScreen`

- **files:** `apps/mobile/lib/api/billing.ts` (new), `apps/mobile/lib/plan-flags.ts` (new), `apps/mobile/components/PlanLockedScreen.tsx` (new)
- **satisfies:** R4.4, R4.6, R4.8
- **provenBy:** T22
- **dependsOn:** WP1, WP3c
- **brief:** `lib/api/billing.ts`: `useSubscription()` = `useQuery<SubscriptionView>({queryKey:
["tenant", tenantSlug, "subscription"], queryFn: GET /billing/subscription, staleTime: 60_000,
retry: 2, enabled: isAuthenticated})` (pattern `lib/api/addons.ts`'s `useDeveloperMode`);
  `usePlanFlag(key)` → `{enabled, resolved, failed}`. `lib/plan-flags.ts`: exact code below.
  `PlanLockedScreen({planName, onBack})`: structural clone of `app/(auth)/operator-blocked.tsx` —
  `lock-closed-outline`, title "Not on your plan", message "This feature isn't included in the
  {planName} plan.", secondary "Manage your plan on the web dashboard.", `MobileButton
variant="secondary" size="lg"` "Go back" → `router.back()`.
- **exact code:**

```ts
// apps/mobile/lib/plan-flags.ts — sections = first non-group segment, as operator-tabs.ts:
export const PLAN_GATED_SECTIONS: Readonly<Record<string, FlagKey>> = {
  estimates: "flag.estimates",
  "recurring-invoices": "flag.recurring_invoices",
  "credit-notes": "flag.credit_notes",
  returns: "flag.returns",
  suppliers: "flag.suppliers",
  "vendor-bills": "flag.ap_bills",
  analytics: "flag.analytics",
  reports: "flag.reports",
  messages: "flag.messaging",
};
export function planLockedSection(
  segments: readonly string[],
  s: { flags: readonly string[]; resolved: boolean; failed: boolean },
): FlagKey | null {
  const section = segments
    .slice(segments.indexOf("(operator)") + 1)
    .find((x) => !x.startsWith("("));
  const key = section ? PLAN_GATED_SECTIONS[section] : undefined;
  if (!key || !s.resolved || s.failed) return null; // unknown ⇒ fail OPEN (web/addon parity)
  return s.flags.includes(key) ? null : key;
}
// expenses, finance, purchase-orders, statements are NOT gated (bookkeeping expenses/finance-
// dashboard are core money endpoints; POs/statements carry no flag) — not added to the map.
```

### WP12 — mobile: section lock in the operator layout + More rows

- **files:** `apps/mobile/app/(operator)/_layout.tsx`, `apps/mobile/app/(operator)/(tabs)/more.tsx`
- **satisfies:** R4.4, R4.6
- **provenBy:** (none directly — T22 + manual Expo check, unassigned T#, see test-plan.md §11)
- **dependsOn:** WP11
- **brief:** `(operator)/_layout.tsx`: after the existing addon `need` block, `const lockedKey =
planLockedSection(segments, planState)`; `if (lockedKey) return <PlanLockedScreen planName={sub.data?.planName
?? "current"} />` (render, not redirect). `more.tsx`: wrap each row whose target section ∈
  `PLAN_GATED_SECTIONS` in `planFlagVisible(usePlanFlag(key))`. Tabs untouched
  (`visibleOperatorTabs` unchanged — no tab is plan-gated).

### WP13 — docs + code map (same PR)

- **files:** `docs/design-package/project/specs/pricing-plans.md`, `.claude/code-map/api/feature-modules-4.md`, `.claude/code-map/web/api-hooks.md`, `.claude/code-map/web/app-shell-lib.md`, `.claude/code-map/mobile/app-shell-lib.md`, `.claude/code-map/packages.md`, `.claude/code-map/_meta.json`, `.claude/code-map/CHANGELOG.md`
- **satisfies:** R3b.1, R8.4
- **provenBy:** (none — review)
- **dependsOn:** WP1, WP2, WP3a, WP3b, WP3c, WP4, WP5a, WP5b, WP5c, WP7, WP8, WP9, WP10, WP11, WP12
- **brief:** Append the five keys to `pricing-plans.md:64-67` (correction C9 — this is the actual
  docs target, not `docs/product/billing-plans.md`). Map entries for every new/changed file
  (purpose, exports); bump `_meta.json`; PR body carries the spec.md §7 deploy order.

### Package map

| WP   | satisfies                                              | provenBy       | dependsOn | Wave |
| ---- | ------------------------------------------------------ | -------------- | --------- | ---- |
| WP1  | R1.1–R1.4, R2.1, R2.7, R2.8, R3a.1, R3a.7, R3b.1, R8.1 | T1, T2, T3     | —         | 1    |
| WP2  | R3a.1–R3a.6, R3b.2, R3b.7, R7.1, R8.5                  | T4, T5, T6, T7 | WP1       | 2    |
| WP3a | R2.2, R2.3, R2.6                                       | T8, T9         | WP1       | 2    |
| WP3b | R1.8, R2.4, R2.5, R2.7, R8.2                           | T10            | WP1       | 2    |
| WP4  | R1.5, R1.6, R1.9, R3b.6, R7.2, R7.4                    | T14, T15       | WP1       | 2    |
| WP3c | R1.7, R2.5, R2.8, R4.1, R4.2, R7.6                     | T11, T12, T13  | WP2       | 3    |
| WP5a | R3b.3, R3b.5, R3b.9                                    | T16, T17       | WP2       | 3    |
| WP5b | R3b.3, R3b.5                                           | T17            | WP2       | 3    |
| WP5c | R3b.3, R3b.4, R3b.9                                    | T17            | WP2       | 3    |
| WP7  | R2.5, R4.1, R4.3, R4.5                                 | T19, T20       | WP1, WP3c | 4    |
| WP11 | R4.4, R4.6, R4.8                                       | T22            | WP1, WP3c | 4    |
| WP8  | R4.3, R4.5, R7.7                                       | (T19/T20/T23)  | WP7       | 5    |
| WP9  | R2.5, R2.8                                             | T21            | WP7       | 5    |
| WP12 | R4.4, R4.6                                             | (T22 + manual) | WP11      | 5    |
| WP10 | R2.2, R2.5, R2.6, R2.8, R3b.8, R4.3, R4.5, R7.7        | T23            | WP8, WP9  | 6    |
| WP13 | R3b.1, R8.4                                            | (review)       | WP1–WP12  | 7    |

Cross-check: every `R#` in spec.md appears in some package's `satisfies:` above, except R4.7
(cut, correction C1/C7), R8.3 (reasoning pinned by T5, no dedicated package), and the admin-form
half of R2.4 (Backoffice lane, see Scope boundary). Every `T#` in test-plan.md appears in some
package's `provenBy:` above (T18 is an existing regression-watch spec, unchanged, run in `final`
without a dedicated owning package; T24 is manual, owned by the build-lane session per Open
question — see Verification commands below).

---

## Acceptance criteria

1. `R1.1`/`R8.1` — the migration directory contains exactly one file, its SQL body is
   `ALTER TYPE "TenantPlan" ADD VALUE 'LITE';` and nothing else; `npm run lint:migrations` passes.
2. `R1.2`–`R1.4` — `PLAN_KEYS` has 5 members in both `apps/api/src/billing/plan-catalog.constants.ts`
   and `packages/types/api/enums.ts`; `enum-parity.spec.ts` is green; plan-rank order is
   `LITE < STARTER < GROWTH < SCALE < ENTERPRISE`.
3. `R1.5`/`R1.6`/`R7.2`/`R7.4` — `db:publish:catalog:v12` publishes a superset of v11 for the four
   existing plans plus a LITE row; re-running it is a no-op; a mismatched stale DRAFT is refused.
4. `R1.7` — a LITE tenant's Stripe checkout line item reads `RouteFlow Lite — monthly` /
   `unit_amount 9900` (or `— annual` / `99000`), never the STARTER fallback.
5. `R1.8` — admin create-tenant on a plan absent from the published catalog is refused before any
   write (no `$transaction`, no welcome email).
6. `R2.1`–`R2.3`/`R2.6` — `GET /billing/plans` never includes LITE for any caller;
   `subscribe`/`upgrade`/`downgrade` refuse LITE as a target with the exact ux-spec copy;
   `upgrade` LITE→STARTER+ succeeds.
7. `R2.4`/`R2.7` — admin create-tenant and admin plan-change accept `"LITE"`; a LITE tenant
   without an explicit `trialLengthDays` gets a 0-day trial and the "Complete payment" welcome copy.
8. `R2.5`/`R2.8` — Settings → Billing shows "Lite" as the plan name, `$99/mo`, and a "Complete
   payment" CTA calling the new tenant checkout endpoint whenever the tenant is non-ACTIVE and
   invite-only.
9. `R3a.1`–`R3a.7` — `ALWAYS_ENFORCED_PLAN_KEYS = {"LITE"}` is the only plan denied the dark-flag
   courtesy, in both `PlanFlagGuard` and `AddonGuard`'s every-key-dark path, and the courtesy
   still never denies an existing plan even when entitlement resolution fails.
10. `R3b.1`–`R3b.9` — `estimates`, `recurring-invoices`, `credit-notes`, `suppliers`, `messages`
    controllers are class-gated on their five new flags; the 7 customers-portal handlers are
    gated on `addon.buyer_portal`; `notifications.controller` is untouched; every gated
    controller's module imports `EntitlementsModule`/`BillingModule`.
11. `R4.1`–`R4.8` — `GET /billing/subscription` carries an additive `flags`/`paymentRequired`;
    the web sidebar and mobile tabs hide gated entries by the three-valued rule (hidden while
    loading, shown on fetch failure, filtered once resolved); a deep link to a denied route
    renders "Not on your plan", never a raw 403; no client file outside `packages/types`
    hardcodes the literal `"LITE"`.
12. `R7.1`/`R7.6`/`R7.7` — every existing tenant's guard decisions and `GET /billing/subscription`
    payload are unchanged except for the additive `flags`/`paymentRequired` fields; CUSTOMER/DRIVER
    nav and existing addon gates are untouched.
13. **Negative (deploy day):** creating zero LITE tenants and publishing v12 produces no observable
    change for any existing tenant — proven by T14 (superset), T7.1 (before/after matrix), and
    T24 (compose `local:validate`/`local:validate:features` green).
14. **Deploy day:** the migration applies cleanly to a database with live tenants on every other
    plan value; the drift gate (`local:drift`, then the prod equivalent) reports exit 0 after the
    migration and after the code deploy.

---

## Verification commands

**Scale/profile:** `scale: 'major'`, `profile: 'standard'` (HIGH-risk tasks present), `mode:
'feature'`, `workdir: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-lite-L2'`, `baselineSha:
'bc24582d'`. Before launch: `cd apps/api && npx prisma generate` (fresh-worktree client trap,
L-151). `formatCommand: 'npx prettier --write'` scoped to touched paths only — the bare root
`npm run format` is banned in this lane.

Per round (cheap, runs after every implementation wave):

```bash
cd apps/api && npx tsc --noEmit
cd apps/api && npm run lint
cd apps/api && npx jest src/billing src/platform-admin/platform-admin.service.spec.ts src/common/enum-parity.spec.ts src/common/plan-flag-guard-module-import.spec.ts src/common/addon-guard-module-import.spec.ts src/common/app-module-compile.spec.ts src/estimates src/recurring-invoices src/credit-notes src/suppliers src/messages src/customers --maxWorkers=2 --passWithNoTests --reporters=default
cd packages/types && npx tsc --noEmit
cd apps/web && npx tsc --noEmit
cd apps/web && npm run lint
cd apps/web && npx jest lib/plan-gated-nav.test.ts lib/api/plan-flags.test.tsx "app/(dashboard)/settings/billing" --passWithNoTests --reporters=default
cd apps/mobile && npx tsc --noEmit
cd apps/mobile && npx jest __tests__/plan-flags.test.ts __tests__/operator-tabs.test.ts --passWithNoTests --reporters=default
```

Final (runs once at the end; one API invocation — never a turbo cache replay):

```bash
npm run check-types
npm run lint
cd apps/api && npx jest --maxWorkers=2
cd apps/api && npm run test:repo-truth
cd apps/web && npx jest
cd apps/mobile && npx jest
node apps/api/scripts/split-prisma-schema.mjs --check
npm run lint:migrations
```

**Not in `final` (HOST-gated, run by the build-lane session once HOST is granted, recorded as
T24):** `npm run local:migrate`, `npm run local:seed`, `npm run local:validate`, `npm run
local:validate:features`, `npm run local:drift` (`apps/api/scripts/schema-drift.mjs`, exit 0
required), `npm run local:test:db` (T15), the compose boot healthcheck (L-113), `npm run
local:e2e:all` for T23. **House rule this session runs under: never touch compose or run a
migration without asking the lead first** — T24 is the lead's call, not the engine's.

---

## UI verification

_Flows and assertions come from test-plan.md §8, copied verbatim._

- **URL:** `http://localhost:3001` (local lane) — the deploy-signal-triggered lane runs against
  the deployed web origin, not dispatched by this plan.
- **Start command:** none for the local lane (compose already running per T24).
- **Flows:**
  1. `e2e-lite` operator dashboard load → sidebar shows only Orders/Invoices/Payments/
     Inventory-Products/Customers, none of the gated items.
  2. Direct navigation to `/estimates` → "Not on your plan" panel + "See plans" button, no error
     toast.
  3. Click "See plans" → `/choose-plan` shows no "Lite" card, shows Starter/Growth/Scale.
  4. `e2e-routeflow` operator dashboard load → sidebar label list equals the committed array.
  5. `e2e-lite` non-ACTIVE → Settings → Billing header "Lite" + "Complete payment" visible; ACTIVE
     → absent.
  6. Unauthenticated marketing `/pricing` → no "Lite" plan renders.
- **Viewports:** `desktop` for all six flows; flows 1–2 repeat at `tablet`.
- **Checks:** `console-errors`, `network-failures`, `a11y`, `design-system`.

---

## Risks & rollback

| Risk                                                                           | Likelihood                         | Blast radius                                                                                   | Mitigation / what the reviewer should watch                                                                                                                                                  |
| ------------------------------------------------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PlanFlagGuard`/`AddonGuard` change denies a dark flag for an EXISTING plan    | low                                | money/access wrong for every tenant on that plan — largest possible blast radius for this lane | T5's R3a.4 negative (dark never denies, even DB down) + T4's R7.1 before/after matrix + mutation probe #1/#2 in test-plan.md §9; reviewer re-derives the matrix by hand against v11's arrays |
| v12 publisher writes an incorrect price/cap/flag for an existing plan          | low                                | wrong billing for every tenant re-pinned to v12                                                | T14's R7.2 superset pin (byte-identical price/caps/SKUs for the four existing plans)                                                                                                         |
| A gated module forgets to import `EntitlementsModule`, crashing DI at boot     | medium (5 new controllers touched) | API fails to boot — full outage (the exact class of bug from the 2026-09-12 CRM outage, L-113) | T16 (repo-truth static check) + the compose boot healthcheck (T24, HOST-gated) — never skip T24 before merge                                                                                 |
| Self-serve refusal ordering regresses (quote/write happens before the refusal) | low                                | a LITE-targeted self-serve mutation silently succeeds, bypassing invite-only                   | T8 asserts `proration.quote`/`$transaction`/`billingEvents.emit` are never called; mutation probe #3                                                                                         |
| Client nav/lock-panel logic drifts from the server guard's decision            | low                                | cosmetic (wrong item shown/hidden) — server remains the authority, so no security impact       | T19/T20/T22 pure-logic tests + T11's R4.2 parity pin (`flags.includes(k) === allowsFlag` on the server)                                                                                      |
| Admin create-tenant race: a LITE tenant created before v12 is published        | low (deploy-order discipline)      | `createTenant` refuses (R1.8) rather than silently defaulting — no bad tenant is ever created  | T10's R1.8 negative; spec.md §7 deploy order (migrate → deploy → publish v12 → create LITE tenants)                                                                                          |

- **Rollback:** revert the diff. The migration is additive-only and is never reverted by any code
  rollback (spec.md §8) — a code revert only _widens_ what a LITE tenant can reach (falls back to
  the dark-allow courtesy), never denies an existing tenant, never mis-charges.
- **Migration reversibility:** no down path exists or is needed — `ADD VALUE` is not reversed;
  the running (old) code never reads the new value, so it tolerates the schema during rollout.
- **Feature flag / entitlement:** `ALWAYS_ENFORCED_PLAN_KEYS = {"LITE"}` is the gate; it is
  granted the moment a tenant's `Tenant.plan` (or pinned `planVersionId`) resolves to `LITE` via
  `EntitlementsService.resolve()` — the only writer of that value is admin create-tenant (WP3b)
  or an admin plan-change. `INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT` (one constant, WP1) is the kill
  switch for the payment CTA specifically — flipping it to `false` requires a redeploy, no data
  change.
- **Deploy day:** existing tenants pinned to `planVersionId` ≤ v11 see zero behavior change —
  every new gate is dark for them until an explicit future flip (F-2, out of scope); no backfill
  required for this lane.
- **Observability:** `PLAN_GATE` 403 bodies carry `flagKey`; `AddonGuard`'s `logDeny`/`would deny
(dark)` warn lines are named; `apps/api/scripts/audit-tenant-entitlements.mjs` run against prod
  post-deploy is the standing detection script (spec.md §8 Detection). A `PLAN_GATE` 403 or
  `addon gate denied` warn for any **non-LITE** tenant after deploy is a red signal.

---

## Pipeline args

_Ready to copy into the Workflow call._ **Transcription note:** each Test package (TP#) above
merges into the matching Work package's (WP#) task below as that task's `tests[]` — the engine
has ONE task graph, not a separate test/implementation id space.

```js
{
  // ---- artifacts: pass PATHS, never paste content ----
  buildPlanPath: '.claude/pipeline/2026-09-15-lite-L2-plan/build-plan.md',
  testPlanPath: '.claude/pipeline/2026-09-15-lite-L2-plan/test-plan.md',
  lessonsPath: '.claude/lessons/LESSONS.md',
  startedAt: '2026-09-15T00:00:00Z',
  runDir: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-lite-L2/.claude/pipeline/2026-09-15-lite-L2-plan',

  scale: 'major',
  mode: 'feature',
  profile: 'standard',
  workdir: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-lite-L2',
  context: 'L2 — Lite $99/mo invite-only plan: one new plan-keyed enforcement tier (ALWAYS_ENFORCED_PLAN_KEYS) alongside the existing DARK_PLAN_FLAGS courtesy, five newly-enforced flags, a v12 catalog publish, and web+mobile nav hiding / locked-panel handling.',
  baselineSha: 'bc24582d',
  scriptsDir: 'C:/Users/nakram/.claude/skills/dev-pipeline/scripts',

  // ---- the task graph (ONE array; no separate test/implementation id space) ----
  tasks: [
    {
      id: 'WP1', title: 'enum + migration + PLAN_KEYS + plan vocabulary + shared billing types',
      type: 'feature',
      files: [
        'apps/api/prisma/schema/tenancy.prisma',
        'apps/api/prisma/migrations/20260915000000_tenant_plan_lite/migration.sql',
        'apps/api/src/billing/plan-catalog.constants.ts',
        'packages/types/api/enums.ts',
        'packages/types/api/billing.ts',
        'packages/types/index.ts',
      ],
      tests: [
        'apps/api/src/billing/plan-catalog.constants.spec.ts',
        'apps/api/src/common/enum-parity.spec.ts',
      ],
      brief: `Satisfies R1.1-R1.4, R2.1, R2.7, R2.8, R3a.1, R3a.7, R3b.1, R8.1; provenBy T1, T2, T3.
Add LITE to the Prisma enum (tenancy.prisma, after SCALE) + this exact migration (additive-only):
  ALTER TYPE "TenantPlan" ADD VALUE 'LITE';
Run \`npx prisma generate\` in apps/api BEFORE anything else (stale client fails typecheck).
Constants file (plan-catalog.constants.ts) — exact code:
  export const PLAN_KEYS = ["LITE","STARTER","GROWTH","SCALE","ENTERPRISE"] as const;
  // planRank: LITE=0..ENTERPRISE=4 (order pin, not indices — R1.4). Update the doc comment.
  export type TenantPlanEnumValue = "STARTER"|"TEAM"|"BUSINESS"|"PROFESSIONAL"|"ENTERPRISE"|"GROWTH"|"SCALE"|"LITE";
  // SELECTABLE_TENANT_PLANS: append "LITE". planKeyFromEnum/planKeyToEnum: add the "LITE" case.
  export const INVITE_ONLY_PLAN_KEYS: readonly PlanKey[] = ["LITE"] as const;
  export const isInviteOnlyPlanKey = (k: string|null|undefined) => k != null && (INVITE_ONLY_PLAN_KEYS as readonly string[]).includes(k);
  export const ALWAYS_ENFORCED_PLAN_KEYS: ReadonlySet<PlanKey> = new Set<PlanKey>(["LITE"]); // must stay subset of INVITE_ONLY_PLAN_KEYS (R3a.7)
  export const isAlwaysEnforcedPlan = (k: string|null|undefined) => k != null && (ALWAYS_ENFORCED_PLAN_KEYS as ReadonlySet<string>).has(k);
  export const INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT = true; // Q1 lever
  export const inviteOnlyCheckoutAllowed = (k, lever = INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT) => !isInviteOnlyPlanKey(k) || lever;
  export const INVITE_ONLY_PLAN_TRIAL_DAYS = 0; // Q3 lever
  export const LITE_PLAN_DISPLAY_NAME = "Lite"; // Q4 — no UI hardcodes the word
FLAG_KEYS gains flag.estimates, flag.recurring_invoices, flag.credit_notes, flag.suppliers, flag.messaging (16→21).
Shared: packages/types/api/enums.ts PLAN_KEYS same literal (REG-743-F4 parity). New packages/types/api/billing.ts
exports FLAG_KEYS (same 21 strings), FlagKey, SubscriptionView<TDate=string> (the 14 fields at
apps/web/lib/api/billing.ts:52-70 with dates as TDate|null, plus flags:string[], paymentRequired:boolean).
packages/types/index.ts adds export * from "./api/billing". Do NOT touch
apps/web/app/(platform-admin)/admin/tenants/new/page.tsx or its test — Backoffice lane owns it.`,
      dependsOn: [],
      risk: 'HIGH',
    },
    {
      id: 'WP2', title: 'plan-flag policy + PlanFlagGuard + EntitlementsService.isAlwaysEnforcedTenant + AddonGuard',
      type: 'feature',
      files: [
        'apps/api/src/billing/plan-flag-policy.ts',
        'apps/api/src/billing/plan-flag.guard.ts',
        'apps/api/src/billing/entitlements.service.ts',
        'apps/api/src/billing/addon.guard.ts',
      ],
      tests: [
        'apps/api/src/billing/plan-flag-policy.spec.ts',
        'apps/api/src/billing/plan-flag.guard.spec.ts',
        'apps/api/src/billing/addon.guard.spec.ts',
        'apps/api/src/billing/entitlements.service.spec.ts',
      ],
      brief: `Satisfies R3a.1-R3a.6, R3b.2, R3b.7, R7.1, R8.5; provenBy T4, T5, T6, T7.
New plan-flag-policy.ts (exact code):
  import { isAlwaysEnforcedPlan } from "./plan-catalog.constants";
  export const DARK_PLAN_FLAGS: ReadonlySet<string> = new Set([
    "flag.analytics","flag.ap_bills","flag.import_integrations","flag.forecasting",
    "flag.pricing_tiers","flag.reports","flag.returns",
    "flag.estimates","flag.recurring_invoices","flag.credit_notes","flag.suppliers",
    "flag.messaging","addon.buyer_portal",
  ]);
  export const isPlanFlagEnforcementOn = (env = process.env) => (env.PLAN_FLAG_ENFORCEMENT ?? "off") === "on";
  export const isDarkFlag = (flagKey, env = process.env) => DARK_PLAN_FLAGS.has(flagKey) && !isPlanFlagEnforcementOn(env);
  export function allowsFlag(ent: {planKey:string; flags:readonly string[]}, flagKey: string, env = process.env): boolean {
    if (isDarkFlag(flagKey, env) && !isAlwaysEnforcedPlan(ent.planKey)) return true;
    return ent.flags.includes(flagKey);
  }
plan-flag.guard.ts keeps: export { DARK_PLAN_FLAGS } from "./plan-flag-policy" (CLAUDE.md pointer).
canActivate body after "if (!flagKey) return true;":
  const tenantId = request.user?.tenantId ?? null;
  if (tenantId == null) return true; // R3a.5, BEFORE the dark check
  let ent; try { ent = await this.entitlements.resolve(tenantId); }
  catch (err) { if (isDarkFlag(flagKey)) return true; // R3a.4
    this.logger.error(\`Entitlement resolution failed for tenant \${tenantId}\`, err); throw new ForbiddenException({code:"PLAN_GATE_UNAVAILABLE", message:"Entitlements are temporarily unavailable. Please retry."}); }
  if (allowsFlag(ent, flagKey)) return true;
  const upgrade = await this.catalog.upgradeTargetForFlag(flagKey).catch(() => ({planKey:null,planMonthlyPrice:null,addonSku:null,addonMonthlyPrice:null}));
  throw new ForbiddenException(buildPlanGateBody(flagKey, upgrade));
EntitlementsService new method:
  async isAlwaysEnforcedTenant(tenantId): Promise<boolean> { try { return isAlwaysEnforcedPlan((await this.resolve(tenantId)).planKey); } catch { return false; } }
AddonGuard: 3rd ctor param entitlements: EntitlementsService; the every-key-dark block (addon.guard.ts:72-76) becomes:
  if (keys.every(k => addonGateState(k) === "dark") && !(await this.entitlements.isAlwaysEnforcedTenant(tenantId))) { warn(...would deny (dark)...); return true; }
  (an always-enforced tenant falls through to the existing deny + logDeny — R3a.3, R8.5)
Fixture note: mocks gain resolve()/3rd ctor arg — collaborator-contract change, not a behavioral one (L-132); existing assertions stay byte-identical.`,
      dependsOn: ['WP1'],
      risk: 'HIGH',
    },
    {
      id: 'WP3a', title: 'self-serve refusal + public-catalog filter',
      type: 'feature',
      files: [
        'apps/api/src/billing/subscription-mutation.service.ts',
        'apps/api/src/billing/plan-catalog.service.ts',
      ],
      tests: [
        'apps/api/src/billing/subscription-mutation.service.spec.ts',
        'apps/api/src/billing/plan-catalog.service.spec.ts',
      ],
      brief: `Satisfies R2.2, R2.3, R2.6; provenBy T8, T9.
plan-catalog.service.ts: getPublicCatalog().plans gains .filter((d) => !isInviteOnlyPlanKey(d.planKey))
before .map (mirror of the addons filter at plan-catalog.service.ts:127).
subscription-mutation.service.ts — exact code, inserted after the isCustom check in subscribe() (:179)
and upgrade() (:628), and after the planRank(targetPlanKey) < 0 check in downgrade() (:721), BEFORE any quote/read/write:
  if (isInviteOnlyPlanKey(input.planKey /* planKey | targetPlanKey */)) {
    throw new BadRequestException(\`Plan "\${input.planKey}" is available by invitation only — contact us.\`);
  }
R2.6: upgrade(t,"STARTER") from a LITE ACTIVE tenant must still pass the rank check and reach the write — LITE ranks lowest, so this is the upsell path, not a new refusal.`,
      dependsOn: ['WP1'],
      risk: 'HIGH',
    },
    {
      id: 'WP3b', title: 'admin create-tenant: catalog refusal, 0-day trial, welcome copy, checkout URLs',
      type: 'feature',
      files: ['apps/api/src/platform-admin/platform-admin.service.ts'],
      tests: ['apps/api/src/platform-admin/platform-admin.service.spec.ts'],
      brief: `Satisfies R1.8, R2.4, R2.5, R2.7, R8.2; provenBy T10.
Insert before tempPassword (:231), exact code:
  const planKey = plan ?? "STARTER";
  const version = await this.planCatalogService.getPublishedVersion();
  if (!version || !findPlanDefinition(version.definitions, planKey)) {
    throw new BadRequestException(\`Plan "\${planKey}" is not in the published plan catalog — publish it before creating tenants on it.\`);
  } // R1.8: never the silent STARTER fallback in compute()
  const trialDays = dto.trialLengthDays ?? (isInviteOnlyPlanKey(planKey) ? INVITE_ONLY_PLAN_TRIAL_DAYS : TRIAL_LENGTH_DAYS);
  // email (:333): trialDays === 0 ? "<p>Complete payment to activate your account.</p>" : existing line
  // checkout link (:306-311): only when inviteOnlyCheckoutAllowed(planKey); pass
  // { successUrl: \`\${FRONTEND_URL}/settings/billing?checkout=success\`, cancelUrl: \`\${FRONTEND_URL}/settings/billing?checkout=cancelled\` }
updatePlan keeps its existing NotFoundException on a missing definition (already a refusal, no change);
R8.2: updatePlan(liteTenant,{plan:"STARTER"}) must call entitlementsService.invalidate(id).`,
      dependsOn: ['WP1'],
      risk: 'HIGH',
    },
    {
      id: 'WP4', title: 'v12 catalog publisher (+ v11 pure extraction, scripts, local:seed)',
      type: 'feature',
      files: [
        'apps/api/prisma/plan-catalog-v11.definitions.ts',
        'apps/api/prisma/publish-plan-catalog-v11.ts',
        'apps/api/prisma/plan-catalog-v12.definitions.ts',
        'apps/api/prisma/publish-plan-catalog-v12.ts',
        'apps/api/package.json',
        'package.json',
      ],
      tests: [
        'apps/api/src/billing/plan-catalog-v12.spec.ts',
        'apps/api/src/billing/publish-plan-catalog-v12.db.spec.ts',
      ],
      brief: `Satisfies R1.5, R1.6, R1.9, R3b.6, R7.2, R7.4; provenBy T14, T15.
Extract v11's DefinitionSeed/AddonSeed types, the six *_FLAGS arrays, DEFINITIONS, ADDON_SEEDS into
plan-catalog-v11.definitions.ts (exports V11_DEFINITIONS, V11_ADDON_SEEDS, DefinitionSeed, AddonSeed);
v11 imports them — no other change (non-behavioral edit, R7.2 allows it).
plan-catalog-v12.definitions.ts — exact code:
  export const LITE_FEATURE_FLAGS: string[] = []; // Q2 flip = add keys here in a v13 publisher
  export const LITE_DEFINITION: DefinitionSeed = {
    planKey: "LITE", name: LITE_PLAN_DISPLAY_NAME, monthlyPrice: 99, isCustom: false,
    customersIncluded: 100, seatsIncluded: 3, // = STARTER's v11 values (owner may lower)
    routesConcurrent: 0, scansIncluded: 0, msgsIncluded: 0, featureFlags: LITE_FEATURE_FLAGS, sortOrder: 0,
  }; // annualPrice(99) === 990
NEW_PLAN_FLAGS (5 keys); V12_DEFINITIONS = LITE (sortOrder 0) + v11's four with
featureFlags: [...new Set([...d.featureFlags, ...NEW_PLAN_FLAGS])], sortOrder: d.sortOrder+1;
V12_ADDON_SEEDS = V11_ADDON_SEEDS; buildV12Rows(published|null).
publish-plan-catalog-v12.ts exports async function publishV12(prisma): Promise<{action:"published"|"noop"; version:number}>
— v11's flow (find PUBLISHED → idempotency below → resume/refuse DRAFT → createMany → $transaction SUPERSEDED+PUBLISHED,
notes: "v12: add LITE (invite-only) + enforce estimates/recurring_invoices/credit_notes/suppliers/messaging flags, drafted from v<n>").
Idempotency (v11:310-318 shape):
  const alreadyPublished = published ? published.definitions.some(d => d.planKey === "LITE") : false;
  if (alreadyPublished) { console.log(\`already published: v\${published.version} already has a LITE definition — nothing to do.\`); return {action:"noop", version:published.version}; }
DRAFT resume/refuse (v11:327-337): ours iff it has a LITE def AND addonSkus set-equals V12_ADDON_SEEDS; else throw
"A DRAFT plan version (v\${draft.version}) already exists and doesn't match the v12 catalog this script publishes. …re-run."
Pool/PrismaClient built inside main(); main() runs only under if (require.main === module) — a spec can import it.
Scripts: apps/api/package.json "db:publish:catalog:v12": "ts-node -r tsconfig-paths/register prisma/publish-plan-catalog-v12.ts";
root local:seed appends " && npm --prefix apps/api run db:publish:catalog:v12". Never edit v11's rows.`,
      dependsOn: ['WP1'],
      risk: 'HIGH',
    },
    {
      id: 'WP3c', title: 'subscription view (flags, paymentRequired) + tenant checkout endpoint',
      type: 'feature',
      files: [
        'apps/api/src/billing/subscription.service.ts',
        'apps/api/src/billing/settings-billing.controller.ts',
      ],
      tests: [
        'apps/api/src/billing/subscription.service.spec.ts',
        'apps/api/src/billing/settings-billing.controller.spec.ts',
        'apps/api/src/billing/platform-pricing.service.spec.ts',
      ],
      brief: `Satisfies R1.7, R2.5, R2.8, R2.9, R4.1, R4.2, R7.6; provenBy T11, T12, T13.
subscription.service.ts, beside "planKey: ent.planKey" — exact code:
  flags: Array.from(new Set([...FLAG_KEYS.filter((k) => allowsFlag(ent, k)), ...ent.flags])),
  paymentRequired: isInviteOnlyPlanKey(ent.planKey) && ent.status !== "ACTIVE" && INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT,
SettingsBillingController constructor gains "private readonly billing: BillingService" as the 4th
parameter. New endpoint — exact code, DELIBERATELY no request-body param (R2.9, lead condition 2):
this is what makes the invite-only guarantee structural rather than a runtime check — do not add
a planKey/target-plan body param to this method, ever.
  @Post("subscription/checkout") @HttpCode(HttpStatus.OK) @Roles(UserRole.TENANT_ADMIN)
  createCheckout(@CurrentUser() user: AuthUser) {
    const base = process.env.FRONTEND_URL ?? "http://localhost:3001";
    return this.billing.createCheckoutSession(this.tenantIdOf(user), {
      successUrl: \`\${base}/settings/billing?checkout=success\`,
      cancelUrl: \`\${base}/settings/billing?checkout=cancelled\`,
    });
  }
platform-pricing.service.ts: checkoutPriceData must resolve the LITE catalog row by planKey (name
"RouteFlow Lite — monthly"/"— annual", unit_amount 9900/99000) — not fall through to the STARTER
row, which is also $99 (R1.7's discriminating case).`,
      dependsOn: ['WP2'],
      risk: 'HIGH',
    },
    {
      id: 'WP5a', title: 'gate wiring: estimates + recurring-invoices',
      type: 'feature',
      files: [
        'apps/api/src/estimates/estimates.controller.ts',
        'apps/api/src/recurring-invoices/recurring-invoices.controller.ts',
        'apps/api/src/recurring-invoices/recurring-invoices.module.ts',
      ],
      tests: [
        'apps/api/src/common/plan-flag-guard-module-import.spec.ts',
        'apps/api/src/estimates/estimates.plan-gate.spec.ts',
        'apps/api/src/recurring-invoices/recurring-invoices.plan-gate.spec.ts',
      ],
      brief: `Satisfies R3b.3, R3b.5, R3b.9; provenBy T16, T17.
Class-level @UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard) + @RequirePlanFlag("flag.estimates")
on estimates.controller.ts; @RequirePlanFlag("flag.recurring_invoices") on recurring-invoices.controller.ts.
recurring-invoices.module.ts adds EntitlementsModule ("../billing/entitlements.module") to imports
(estimates.module.ts already has it, correction C2 — BillingModule re-exports EntitlementsModule).`,
      dependsOn: ['WP2'],
      risk: 'HIGH',
    },
    {
      id: 'WP5b', title: 'gate wiring: credit-notes + suppliers',
      type: 'feature',
      files: [
        'apps/api/src/credit-notes/credit-notes.controller.ts',
        'apps/api/src/credit-notes/credit-notes.module.ts',
        'apps/api/src/suppliers/suppliers.controller.ts',
        'apps/api/src/suppliers/suppliers.module.ts',
      ],
      tests: [
        'apps/api/src/credit-notes/credit-notes.plan-gate.spec.ts',
        'apps/api/src/suppliers/suppliers.plan-gate.spec.ts',
      ],
      brief: `Satisfies R3b.3, R3b.5; provenBy T17.
credit-notes.controller.ts: class-level @UseGuards(JwtAuthGuard, PlanFlagGuard) + @RequirePlanFlag("flag.credit_notes")
— its per-handler RolesGuard stays (not moved to class level).
suppliers.controller.ts: class-level @UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard) + @RequirePlanFlag("flag.suppliers").
Both modules add EntitlementsModule ("../billing/entitlements.module") to imports.`,
      dependsOn: ['WP2'],
      risk: 'HIGH',
    },
    {
      id: 'WP5c', title: 'gate wiring: messages + customers portal handlers',
      type: 'feature',
      files: [
        'apps/api/src/messages/messages.controller.ts',
        'apps/api/src/messages/messages.module.ts',
        'apps/api/src/customers/customers.controller.ts',
      ],
      tests: [
        'apps/api/src/messages/messages.plan-gate.spec.ts',
        'apps/api/src/customers/customers.portal-plan-gate.spec.ts',
      ],
      brief: `Satisfies R3b.3, R3b.4, R3b.9; provenBy T17.
messages.controller.ts: class-level @UseGuards(JwtAuthGuard, PlanFlagGuard) + @RequirePlanFlag("flag.messaging");
messages.module.ts adds EntitlementsModule to imports. notifications.controller.ts is UNTOUCHED
(R3b.3 negative — operator device push/token, not customer transport, per correction C3).
customers.controller.ts: handler-level @UseGuards(PlanFlagGuard) @RequirePlanFlag("addon.buyer_portal")
on the 7 portal handlers (:108 pending-portal-approvals, :356 portal-invite, :366 portal-resend,
:372 portal-disconnect, :378 portal-status, :384 portal-approve, :390 portal-decline), pattern of
:234-235. customers.module.ts already imports EntitlementsModule (correction C2) — no module change needed there.
findAll and every non-portal handler carry no plan-flag metadata.`,
      dependsOn: ['WP2'],
      risk: 'HIGH',
    },
    {
      id: 'WP7', title: 'web: shared type import, usePlanFlag, useCreateCheckout, nav map + route matcher',
      type: 'feature',
      files: [
        'apps/web/lib/api/billing.ts',
        'apps/web/lib/api/plan-flags.ts',
        'apps/web/lib/plan-gated-nav.ts',
      ],
      tests: [
        'apps/web/lib/plan-gated-nav.test.ts',
        'apps/web/lib/api/plan-flags.test.tsx',
      ],
      brief: `Satisfies R2.5, R4.1, R4.3, R4.5; provenBy T19, T20.
billing.ts: replace the local SubscriptionView with
  import type { SubscriptionView } from "@routeflow/types"; export type { SubscriptionView };
add useCreateCheckout() = useMutation<{checkoutUrl:string}>() posting /billing/subscription/checkout,
onSuccess: (r) => window.location.assign(r.checkoutUrl).
plan-flags.ts: usePlanFlag(key, opts?: {enabled?: boolean}) -> {enabled, resolved, failed} from
useSubscription({staleTime: 60_000, ...opts}) (resolved=q.isSuccess, failed=q.isError,
enabled=q.data?.flags?.includes(key) ?? false).
plan-gated-nav.ts — exact code (only hrefs that exist in OPERATOR_NAV, layout.tsx:90-153):
  export const PLAN_GATED_NAV: Readonly<Record<string, FlagKey>> = {
    "/returns": "flag.returns", "/suppliers": "flag.suppliers", "/vendor-bills": "flag.ap_bills",
    "/estimates": "flag.estimates", "/credit-notes": "flag.credit_notes",
    "/finance/reports": "flag.reports", "/analytics": "flag.analytics",
  };
  export type PlanFlagState = { enabled: boolean; resolved: boolean; failed: boolean };
  export const planFlagVisible = (s: PlanFlagState) => (s.resolved ? s.enabled : s.failed);
  export function matchPlanGatedRoute(pathname: string): FlagKey | null {
    for (const [prefix, key] of Object.entries(PLAN_GATED_NAV))
      if (pathname === prefix || pathname.startsWith(prefix + "/")) return key;
    return null;
  }
/sales-agents, /finance/commissions, /dispatch|/routes|/deliveries|/drivers stay on their addon hooks (R7.7).`,
      dependsOn: ['WP1', 'WP3c'],
    },
    {
      id: 'WP8', title: 'web: sidebar hiding + RouteGuard LockedPage',
      type: 'feature',
      files: ['apps/web/app/(dashboard)/layout.tsx'],
      tests: [],
      brief: `Satisfies R4.3, R4.5, R7.7; provenBy T19/T20 (pure logic) + T23 (e2e).
In DashboardShell (layout.tsx:1057) reuse the existing useSubscription({staleTime:60_000, enabled:isStaff})
result at :1078 (do not add a query) to derive planState; filter navStructure leaves whose
href is in PLAN_GATED_NAV by planFlagVisible(...) (no skeleton — omission is the loading state);
a group left with zero children is dropped (Dispatch-group precedent, layout.tsx:195-210).
RouteGuard (:298): const key = matchPlanGatedRoute(pathname); when key && planState.resolved &&
!planState.flags.includes(key), render <LockedPage gate={{code:"PLAN_GATE", flag:key,
message: "This feature isn't included in the " + planName + " plan.", upgrade:{planKey:null,
planMonthlyPrice:null, addonSku:null, addonMonthlyPrice:null}}}> with secondary line "Want it?
Contact us to upgrade." under the CTA; while unresolved or failed, render the page as today (the
existing PlanGateNotice toast covers a server 403). CUSTOMER/DRIVER branches untouched.`,
      dependsOn: ['WP7'],
    },
    {
      id: 'WP9', title: 'web: Settings → Billing "Complete payment"',
      type: 'feature',
      files: ['apps/web/app/(dashboard)/settings/billing/page.tsx'],
      tests: ['apps/web/app/(dashboard)/settings/billing/billing-page.test.tsx'],
      brief: `Satisfies R2.5, R2.8; provenBy T21.
Beside the plan header (page.tsx:214): when s.paymentRequired render
  <Button loading={checkout.isPending} onClick={() => checkout.mutate()}>Complete payment</Button>
with the price line "Lite · $99/mo" composed from s.planName / money(s.monthlyPrice) — never the literal.
No other change.`,
      dependsOn: ['WP7'],
    },
    {
      id: 'WP10', title: 'web e2e spec + Playwright project',
      type: 'feature',
      files: ['apps/web/playwright.config.ts'],
      tests: ['apps/web/e2e/47-lite-plan-gate.spec.ts'],
      brief: `Satisfies R2.2, R2.5, R2.6, R2.8, R3b.8, R4.3, R4.5, R7.7; provenBy T23.
Copy ux-spec.md's six Playwright verification flows verbatim (sidebar set for e2e-lite; /estimates
deep link => heading "Not on your plan" + button "See plans", no error toast; /choose-plan has no
Lite card; e2e-routeflow sidebar equals the committed label array; Settings->Billing header "Lite"
+ "Complete payment" when non-ACTIVE; marketing /pricing has no Lite). test.skip when
PLAYWRIGHT_LITE_TENANT_SLUG is unset (fixture policy — see Open questions §1). Project
"lite-plan-gate" (testMatch: /47-lite-plan-gate\\.spec\\.ts/, dependencies: ["setup"], operator
storage state) — NOT in the local Playwright allow-list.`,
      dependsOn: ['WP8', 'WP9'],
    },
    {
      id: 'WP11', title: 'mobile: useSubscription/usePlanFlag, pure helpers, PlanLockedScreen',
      type: 'feature',
      files: [
        'apps/mobile/lib/api/billing.ts',
        'apps/mobile/lib/plan-flags.ts',
        'apps/mobile/components/PlanLockedScreen.tsx',
      ],
      tests: ['apps/mobile/__tests__/plan-flags.test.ts'],
      brief: `Satisfies R4.4, R4.6, R4.8; provenBy T22.
lib/api/billing.ts: useSubscription() = useQuery<SubscriptionView>({queryKey:["tenant", tenantSlug,
"subscription"], queryFn: GET /billing/subscription, staleTime:60_000, retry:2, enabled:isAuthenticated})
(pattern: lib/api/addons.ts's useDeveloperMode); usePlanFlag(key) -> {enabled, resolved, failed}.
lib/plan-flags.ts — exact code (sections = first non-group segment, as operator-tabs.ts):
  export const PLAN_GATED_SECTIONS: Readonly<Record<string, FlagKey>> = {
    estimates: "flag.estimates", "recurring-invoices": "flag.recurring_invoices", "credit-notes": "flag.credit_notes",
    returns: "flag.returns", suppliers: "flag.suppliers", "vendor-bills": "flag.ap_bills",
    analytics: "flag.analytics", reports: "flag.reports", messages: "flag.messaging",
  };
  export function planLockedSection(segments: readonly string[], s: {flags: readonly string[]; resolved: boolean; failed: boolean}): FlagKey | null {
    const section = segments.slice(segments.indexOf("(operator)") + 1).find((x) => !x.startsWith("("));
    const key = section ? PLAN_GATED_SECTIONS[section] : undefined;
    if (!key || !s.resolved || s.failed) return null; // unknown => fail OPEN (web/addon parity)
    return s.flags.includes(key) ? null : key;
  }
expenses, finance, purchase-orders, statements are NOT gated — not added to the map.
PlanLockedScreen({planName, onBack}): structural clone of app/(auth)/operator-blocked.tsx —
lock-closed-outline, title "Not on your plan", message "This feature isn't included in the
{planName} plan.", secondary "Manage your plan on the web dashboard.", MobileButton
variant="secondary" size="lg" "Go back" -> router.back().`,
      dependsOn: ['WP1', 'WP3c'],
    },
    {
      id: 'WP12', title: 'mobile: section lock in the operator layout + More rows',
      type: 'feature',
      files: [
        'apps/mobile/app/(operator)/_layout.tsx',
        'apps/mobile/app/(operator)/(tabs)/more.tsx',
      ],
      tests: [],
      brief: `Satisfies R4.4, R4.6; provenBy T22 + manual Expo check (see test-plan.md §11 note — no
dedicated T# for the manual half, raised not decided).
(operator)/_layout.tsx: after the existing addon "need" block,
  const lockedKey = planLockedSection(segments, planState);
  if (lockedKey) return <PlanLockedScreen planName={sub.data?.planName ?? "current"} />;
(render, not redirect). more.tsx: wrap each row whose target section is in PLAN_GATED_SECTIONS in
planFlagVisible(usePlanFlag(key)). Tabs untouched (visibleOperatorTabs unchanged — no tab is plan-gated).
Verification (Playwright ruling, 2026-09-15): mobile has NO ui-verify task in this plan — Jest
(this WP's tests[] + WP11's T22 suite) plus a manual Expo design review by the lead/owner is the
full verification for PlanLockedScreen and the More-row hiding; never claim Playwright coverage
for a native mobile surface.`,
      dependsOn: ['WP11'],
    },
    {
      id: 'WP14', title: 'checkout webhook: planKey + MRR-ledger fix (pre-existing, own commit)',
      type: 'feature',
      files: ['apps/api/src/billing/billing.service.ts'],
      tests: ['apps/api/src/billing/billing.service.spec.ts'],
      brief: `Satisfies R9.1-R9.4 (pre-existing defect, lead condition 3, 2026-09-15); provenBy T26, T27 (T26 also carries the R9.4 negative companion, not independently red-gated).
OWN COMMIT, separate from the rest of L2 — this is a live production bug unrelated to LITE, but
Lite's self-checkout depends on it (an admin-created LITE tenant's first checkout must actually
record planKey LITE or it never enters the MRR ledger).

Root cause (verified against master): onCheckoutCompleted's upsert (billing.service.ts ~562-580)
create branch reads "session.metadata?.plan" (undefined — checkout stamps "metadata.planKey" at
:291) so currentPlan silently defaults to STARTER; NEITHER branch writes the "planKey" STRING
column at all (schema comment: "the new source of truth"). ensureStripeCustomer (:199-204)
pre-creates the row with a CORRECT currentPlan from tenant.plan before Stripe's webhook can even
fire, so in practice the upsert always hits UPDATE, not CREATE (StripeService.createCheckoutSession
has zero callers anywhere — BillingService's is the only live path). The real, live defect: planKey
stays permanently null after every Stripe checkout, so emitPayingDelta (:97, "if (sub.planKey ==
null) return") never fires and billing-cron's "planKey: { not: null }" filters exclude these
tenants from the MRR ledger and planKey-driven crons forever.

Exact fix — in BOTH the create and update branches of the upsert (~562-580), add:
  const resolvedPlanKey = session.metadata?.planKey ?? session.metadata?.plan ?? null;
  // present-only: never overwrite an existing non-null planKey with null (idempotent replay,
  // and never regress a row some OTHER path already correctly populated).
before the upsert call. In the "create" data object:
  currentPlan: resolvedPlanKey ? planKeyToEnum(resolvedPlanKey) : ((session.metadata?.plan as TenantPlan) ?? "STARTER"),
  planKey: resolvedPlanKey,
  basePriceSnapshot: resolvedBasePrice, // see below — null when pricing can't resolve
In the "update" data object, add (it currently sets neither field):
  ...(resolvedPlanKey ? { planKey: resolvedPlanKey } : {}),
  ...(resolvedPlanKey && resolvedBasePrice != null ? { basePriceSnapshot: resolvedBasePrice } : {}),
Resolve resolvedBasePrice the SAME way subscription-mutation.service.ts's subscribe()/upgrade()
already do (basePriceSnapshot: def.monthlyPrice, lines 303/313/678) — but reuse the ALREADY-INJECTED
this.pricing (PlatformPricingService), which has the exact right method for this: resolveCatalogPricing(tenantId)
already resolves planKey as "tenant.subscription?.planKey ?? tenant.plan" (platform-pricing.service.ts:90) —
i.e. it already falls back to tenant.plan, the SAME field ensureStripeCustomer used to correctly seed
currentPlan — so it resolves correctly for a Lite tenant even before planKey is written. It can throw
BadRequestException (isCustom plan, no price set) — a webhook handler must never throw uncaught (Stripe
retries forever), so wrap it:
  let resolvedBasePrice: number | null = null;
  try {
    resolvedBasePrice = (await this.pricing.resolveCatalogPricing(tenantId)).monthly;
  } catch (err) {
    this.logger.warn(\`checkout.session.completed: could not resolve catalog price for tenant \${tenantId} (\${(err as Error).message}) — planKey recorded, basePriceSnapshot left unset\`);
  }

IDEMPOTENCY (no new mechanism needed — this is the important design point, don't add one):
transitionAndEmit's existing conditional updateMany (billing.service.ts:132-152) is the ONLY
idempotency key, already correct for this fix. onCheckoutCompleted calls transitionAndEmit(tenantId,
upserted, {status:{not:"ACTIVE"}}, "ACTIVE", 1, SUBSCRIPTION_RESUMED, ...) using "upserted" — the
JUST-upserted row — as the "sub" argument INTO emitPayingDelta. Once this fix writes planKey +
basePriceSnapshot onto that same upserted row BEFORE transitionAndEmit runs (it already does, no
reordering needed — verify the upsert precedes the transitionAndEmit call), emitPayingDelta picks
them up automatically and emits exactly once, gated by the SAME CAS ("count===1") that already
prevents the paired invoice.payment_succeeded webhook (onPaymentSucceeded, :693-698, calls
transitionAndEmit the identical way) from double-emitting on a race or replay. Do not add a second
idempotency mechanism — prove the existing CAS covers this case (T27).

NEGATIVE (R9.4): a row where metadata carries neither planKey nor the legacy plan key must be left
completely unchanged — resolvedPlanKey stays null, the spread adds nothing, no regression for
today's legacy-Stripe cohort (the exact cohort the "planKey is null" comments already describe).

No backfill of existing rows in this PR (lead's explicit instruction) — this only fixes the write
path going forward.`,
      dependsOn: ['WP1'],
      risk: 'HIGH',
    },
    {
      id: 'WP13', title: 'docs + code map (same PR)',
      type: 'docs',
      files: [
        'docs/design-package/project/specs/pricing-plans.md',
        '.claude/code-map/api/feature-modules-4.md',
        '.claude/code-map/web/api-hooks.md',
        '.claude/code-map/web/app-shell-lib.md',
        '.claude/code-map/mobile/app-shell-lib.md',
        '.claude/code-map/packages.md',
        '.claude/code-map/_meta.json',
        '.claude/code-map/CHANGELOG.md',
      ],
      tests: [],
      brief: `Satisfies R3b.1 (docs half), R8.4; provenBy review only.
Append the five keys (flag.estimates, flag.recurring_invoices, flag.credit_notes, flag.suppliers,
flag.messaging) to pricing-plans.md:64-67 (correction C9 — this is the actual docs target, not
docs/product/billing-plans.md). Map entries for every new/changed file in WP1-WP12 (purpose,
exports/signatures, cross-refs); bump _meta.json; PR body carries the spec.md §7 deploy order
((1) prod migration, (2) merge/deploy, (3) publish v12 before the first LITE tenant, (4) HQ creates LITE tenants);
list every ui-verify screenshot path (UV1/UV2/UV3 below) in the PR body too — never commit the images themselves.`,
      dependsOn: ['WP1', 'WP2', 'WP3a', 'WP3b', 'WP3c', 'WP4', 'WP5a', 'WP5b', 'WP5c', 'WP7', 'WP8', 'WP9', 'WP10', 'WP11', 'WP12', 'WP14'],
    },
    {
      id: 'UV1', title: 'ui-verify: pricing visibility + billing plan header (web)',
      type: 'ui-verify',
      files: [],
      tests: [],
      dependsOn: ['WP3a', 'WP9'],
      url: 'http://localhost:3001',
      startCommand: 'curl -sf http://localhost:3000/api/v1/health > /dev/null',
      flows: [
        'marketing /pricing as an unauthenticated visitor — confirm no Lite card renders (STARTER/PRO/CUSTOM only, layout unchanged)',
        'Settings → Billing on a LITE, non-ACTIVE tenant — header reads "Lite · $99/mo" and shows the "Complete payment" button; click it and capture the loading state (button disabled, spinner) before the Stripe redirect fires',
        'Settings → Billing on a STARTER tenant (ACTIVE) — confirm unchanged: no "Complete payment" button, no Lite copy anywhere',
      ],
      viewports: [1440, 768, 390],
      checks: ['console-errors', 'network-failures', 'design-system'],
      brief: `Playwright proof for R2.2, R2.5, R2.8 against the LOCAL COMPOSE STACK on an approved
e2e-* LITE test tenant (WP10's Open Question 1 names the fixture). This task does NOT start
compose and does NOT create the tenant — both must already exist before this task's agent runs
(the build-lane session gets HOST + seeds the tenant first, per the standing host/compose
handshake); if either is missing, STOP and report — never run local:up/local:seed/a migration from
inside this task. Screenshot every flow at all three viewports, in every state that applies
(loading skeleton while the subscription query is in flight, then populated, then the button's own
loading state after click — omit a state only if the flow genuinely has none). Side-by-side: crop
the /pricing screenshot next to the SAME page's existing STARTER card to prove no new visual
language (same card component, spacing, type scale); crop the "Complete payment" button next to
the SAME Settings → Billing page's existing "Cancel subscription" button for CTA style parity.
Screenshots go under local-assets/ (gitignored — never commit them); list every path in the PR
body. Do not touch apps/web/app/(platform-admin)/admin/tenants/new/page.tsx or its test — LITE
visibility on the admin create-tenant screen is Backoffice-owned, out of scope for this lane.`,
    },
    {
      id: 'UV2', title: 'ui-verify: gated-feature upsell/denied state (web)',
      type: 'ui-verify',
      files: [],
      tests: [],
      dependsOn: ['WP7', 'WP8'],
      url: 'http://localhost:3001',
      startCommand: 'curl -sf http://localhost:3000/api/v1/health > /dev/null',
      flows: [
        'LITE tenant, sidebar — confirm plan-gated items (Estimates, Recurring invoices, Credit notes, Suppliers, Messages) are absent, non-gated items unaffected (empty state = the omission itself)',
        'LITE tenant, direct URL nav to /estimates — LockedPage renders: lock icon, "This feature isn\'t included in the Lite plan." message, "Want it? Contact us to upgrade." secondary line, no console error, no 403 toast',
        'LITE tenant, subscription query mid-flight (throttle the network tab or capture first paint) — confirm the page renders as today during the loading window, no flash of locked content',
        'LITE tenant, subscription query forced to fail (block the endpoint) — confirm fail-open: page renders as today, not locked',
      ],
      viewports: [1440, 768, 390],
      checks: ['console-errors', 'network-failures', 'a11y', 'design-system'],
      brief: `Playwright proof for R4.3, R4.5, R7.7 against the LOCAL COMPOSE STACK (same
preconditions as UV1 — do not start compose or create tenants from this task). This is the
upsell/denied state a LITE tenant sees on a gated screen that the lead's ruling calls out by name.
Side-by-side: LockedPage is a REUSED existing component (WP8's brief — no new component) —
screenshot it here next to an existing AddonGuard-denied screen that already ships LockedPage today
(any addon-gated route on a tenant lacking that addon) to prove the plan-gate variant is
pixel-identical apart from copy. a11y check: the lock icon has an accessible name, the CTA is
keyboard-reachable. Screenshots to local-assets/ (gitignored, never committed), paths listed in
the PR body.`,
    },
    {
      id: 'UV3', title: 'ui-verify: self-serve checkout flow driven end-to-end (web)',
      type: 'ui-verify',
      files: [],
      tests: [],
      dependsOn: ['WP9', 'WP3c'],
      url: 'http://localhost:3001',
      startCommand: 'curl -sf http://localhost:3000/api/v1/health > /dev/null',
      flows: [
        'LITE tenant, non-ACTIVE, on Settings → Billing — click "Complete payment"; Playwright must actually drive this click, not stub it: confirm POST /billing/subscription/checkout fires, the button enters its loading state, and the page follows the returned checkoutUrl redirect (the Stripe test-mode checkout page loads — capture that landing page too, it is the proof the endpoint returns a real session)',
        'repeat with the network request to /billing/subscription/checkout forced to fail — confirm an error state renders (toast or inline), the button returns to enabled, no unhandled rejection in the console',
      ],
      viewports: [1440, 768, 390],
      checks: ['console-errors', 'network-failures', 'design-system'],
      brief: `Playwright proof for R2.5, R2.8, R2.9 against the LOCAL COMPOSE STACK (same
preconditions as UV1/UV2 — Stripe test-mode keys already live in docker-compose.yml's api
environment; never add or change a secret from this task). This is the "checkout flow actually
driven" proof the lead's ruling requires — a stubbed-network screenshot of the button alone does
not satisfy it; the click must really reach BillingService.createCheckoutSession and really
redirect. R2.9 (structural, not UI-visible): use read_network_requests to confirm the POST body
carries no planKey/targetPlan field — the endpoint takes none, by design (WP3c) — this is what
makes the invite-only guarantee structural rather than a runtime check. Side-by-side vs the
existing "Cancel subscription" button's loading/error states on the same page. Screenshots to
local-assets/ (gitignored, never committed), paths listed in the PR body.`,
    },
  ],

  // ---- gates: every command must already exist in this repo ----
  verifyCommands: {
    perRound: [
      'cd apps/api && npx tsc --noEmit',
      'cd apps/api && npm run lint',
      'cd apps/api && npx jest src/billing src/platform-admin/platform-admin.service.spec.ts src/common/enum-parity.spec.ts src/common/plan-flag-guard-module-import.spec.ts src/common/addon-guard-module-import.spec.ts src/common/app-module-compile.spec.ts src/estimates src/recurring-invoices src/credit-notes src/suppliers src/messages src/customers --maxWorkers=2 --passWithNoTests --reporters=default',
      'cd packages/types && npx tsc --noEmit',
      'cd apps/web && npx tsc --noEmit',
      'cd apps/web && npm run lint',
      'cd apps/web && npx jest lib/plan-gated-nav.test.ts lib/api/plan-flags.test.tsx "app/(dashboard)/settings/billing" --passWithNoTests --reporters=default',
      'cd apps/mobile && npx tsc --noEmit',
      'cd apps/mobile && npx jest __tests__/plan-flags.test.ts __tests__/operator-tabs.test.ts --passWithNoTests --reporters=default',
    ],
    final: [
      'npm run check-types',
      'npm run lint',
      'cd apps/api && npx jest --maxWorkers=2',
      'cd apps/api && npm run test:repo-truth',
      'cd apps/web && npx jest',
      'cd apps/mobile && npx jest',
      'node apps/api/scripts/split-prisma-schema.mjs --check',
      'npm run lint:migrations',
    ],
    // NOT in final — HOST-gated, run by the build-lane session once HOST is granted, recorded as T24:
    // npm run local:migrate, npm run local:seed, npm run local:validate, npm run local:validate:features,
    // npm run local:drift (apps/api/scripts/schema-drift.mjs, exit 0 required), npm run local:test:db (T15),
    // the compose boot healthcheck (L-113), npm run local:e2e:all (T23). Never touch compose or run a
    // migration without asking the lead first — T24 is the lead's call, not the engine's.
  },

  formatCommand: 'npx prettier --write',
}
```

---

## UI verification (lead ruling, routeflow-c4, 2026-09-15)

Relayed cross-session, folded in during E9 recovery — not re-decided here, transcribed as given:

- **Playwright for every web UI surface this lane touches**, run against the LOCAL COMPOSE STACK
  on an approved test tenant — never against a stub or a component in isolation. Three tasks added:
  `UV1` (pricing/plan visibility), `UV2` (the gated-feature upsell/denied state), `UV3` (the
  self-serve checkout flow actually driven, not stubbed).
- **Screenshots at 1440 / 768 / 390 px**, every state a surface can be in (empty, loading, error,
  populated) — never just the happy path.
- **The upsell/denied state a LITE tenant sees on a gated screen** is explicitly named — `UV2`.
- **A side-by-side comparison against a neighboring EXISTING RouteFlow screen** on every ui-verify
  task, to prove the design system is unchanged: same colours, fonts, components, no new visual
  language. Each `UV#` brief names its comparison screen.
- **Screenshots under `local-assets/`** (gitignored) — **never committed** — with every path listed
  in the PR body (WP13 now carries this instruction too).
- **An independent visual review runs on the screenshots before merge** — routeflow-c4's call, not
  this lane's; the ui-verify tasks produce the evidence, they don't self-certify.
- **Native mobile (WP11, WP12) gets Jest + a design review, not Playwright** — stated explicitly in
  WP12's brief so this is never claimed as Playwright-covered.
- Admin create-tenant LITE visibility stays Backoffice-owned — no `UV#` task touches
  `apps/web/app/(platform-admin)/admin/tenants/new/page.tsx` or its test; `UV1` says so directly.

## Open questions (raised, not builder-decided)

_Verbatim from [s4-s5-ruling.md](./s4-s5-ruling.md) §5 — not re-decided here._

1. **`e2e-lite` fixture (T23):** creating a LITE tenant in prod via the admin API is a
   SUPER_ADMIN write during e2e. Options: (a) the owner creates `e2e-lite` once by hand after
   v12 publishes and the spec reads `PLAYWRIGHT_LITE_TENANT_SLUG`; (b) restrict project
   `lite-plan-gate` to the local lane against `e2e-lite` seeded by `e2e-seed.js`. The ruling
   author leans (a); WP10 is written to skip when the env var is unset.
2. **A2 — LITE caps** = STARTER's (`seatsIncluded 3`, `customersIncluded 100`) — one constant in
   the LITE_DEFINITION hard line if the owner wants lower.
3. **F-4 — SUPERSEDED, now IN scope as WP14 (2026-09-15):** the original diagnosis above
   ("every Stripe-checkout tenant gets currentPlan: STARTER") was corrected after deeper tracing
   with the lead: `ensureStripeCustomer` pre-creates the subscription row with the CORRECT
   `currentPlan` (from `tenant.plan`) before Stripe's webhook can fire, so `currentPlan` is
   already right in practice. The REAL, live defect is that the `planKey` STRING column
   ("the new source of truth") is never written by either upsert branch — `emitPayingDelta`
   short-circuits on it being null, and billing-cron's `planKey:{not:null}` filter excludes
   these tenants forever, so a checking-out tenant never enters the MRR ledger. Lead ruled this
   not deferrable (L2's own R2.5 self-checkout depends on it) — see WP14, its own commit,
   R9.1-R9.4, T26/T27.
4. **F-5 (pre-existing):** the default `success_url` `/billing/success` has no web route. This
   lane passes explicit URLs on both paths it sells (WP3b, WP3c); the admin `POST
/billing/checkout` default is left for a bug.
5. **sortOrder:** ruled LITE `0`, the four existing rows `+1` (R7.2 pins prices/caps/flags/SKUs,
   not sortOrder); say if v11's numbers must be preserved (then LITE = `-1`).
6. **R4.5's 403 fallback:** when the client answer is unknown (loading/failed) a server
   PLAN_GATE 403 renders the existing `PlanGateNotice` toast (friendly, with upgrade hint —
   `api-client.ts:114-163`), not `LockedPage`; rendering the panel from a query error would touch
   every gated page. Deviation from ux-spec, satisfies U2 ("never a raw 403").
7. **R4.7 cut** (correction C7). **`DARK_PLAN_FLAGS` file move** (WP2's re-export from
   `plan-flag.guard.ts` keeps CLAUDE.md's pointer true; the close-out commit updates the pointer
   — never mid-session).
8. **Lessons:** no `fix:` here, but WP13 may add one entry if the run surfaces a transferable
   rule (candidates: "API never value-imports `@routeflow/types` — the spec author must know
   it", "a shipped script that runs `main()` at import cannot be unit-tested; split data from
   runner").

**Additionally raised by this transcription (not in the ruling's own §5, flagged here rather than
decided):** the ruling assigns WP12's manual Expo verification no explicit `T#` and no flow/
assertion/viewport (it says only "T22 + manual Expo" in the task graph's tests column and "manual
(Expo)" in spec.md's R4.6 verification column) — see test-plan.md §11's closing note. This is
noted, not resolved, here.

---

## Corrections found during S4/S5 (source-verified)

_Verbatim from [s4-s5-ruling.md](./s4-s5-ruling.md) §0 — source beats spec; not re-decided here._

- **C1 · `@routeflow/types` is type-only for the API.**
  `apps/api/src/common/no-runtime-workspace-imports.spec.ts` fails any value import (raw `.ts`,
  crashes `node dist/main.js`). R4.1's "FLAG_KEYS re-exported by `plan-catalog.constants.ts`" is
  therefore wrong: `FLAG_KEYS` stays a **mirror** in the API (REG-743-F1 pattern) and gains a
  set-equal pin in `enum-parity.spec.ts`; `packages/types/api/billing.ts` (new) carries the
  shared `FLAG_KEYS`/`FlagKey` + `SubscriptionView<TDate = string>`; the API annotates
  `getSubscription(): Promise<SubscriptionView<Date>>` via `import type` (erased, allowed).
- **C2 · `PlanFlagGuard` is provided/exported by `EntitlementsModule`**
  (`apps/api/src/billing/entitlements.module.ts`), not `BillingModule` (which re-exports
  EntitlementsModule). R3b.5 reads: a module gaining `PlanFlagGuard` imports `EntitlementsModule`
  (or `BillingModule`). `estimates.module.ts` and `customers.module.ts` already do;
  `recurring-invoices`, `credit-notes`, `suppliers`, `messages` do not.
- **C3 · `messages` is the operator↔driver run-chat (A6 resolved by reading
  `messages.service.ts`), not customer SMS/email.** Gating it under `flag.messaging` stands (a
  LITE tenant has no dispatch, hence no run chat); `notifications.controller` stays ungated. Key
  unchanged.
- **C4 · The tenant cannot call `POST /billing/checkout`** — `BillingController` is
  `@UseGuards(JwtAuthGuard, SuperAdminGuard)`. R2.5 needs a tenant-facing `POST
/billing/subscription/checkout` on `SettingsBillingController` (`@Roles(TENANT_ADMIN)`), and
  the web hook targets it. The lever `INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT` stays server-side:
  the response carries `paymentRequired: boolean` and the client renders off that one field
  (L-130, R4.8) — the ux-spec's client-side `isInviteOnlyPlanKey` read is dropped; no
  `INVITE_ONLY_PLAN_KEYS` mirror in `packages/types`.
- **C5 · R1.8's hole is real today:** `entitlements.service.ts` `compute()` resolves
  `subscription.planKey ?? planKeyFromEnum(tenant.plan)` and `planKeyFromEnum` defaults to
  `STARTER`; `createTenant` never consults the catalog. WP1 fixes the mapper, WP3b adds the
  refusal.
- **C6 · A1 confirmed:** `onCheckoutCompleted` (`billing.service.ts:582`) does
  `transitionAndEmit(..., { status: { not: "ACTIVE" } }, "ACTIVE")` — READ_ONLY(trial_expired)
  activates on checkout; covered by the existing `onCheckoutCompleted (non-ACTIVE → ACTIVE)`
  block in `billing.service.spec.ts:337`. No new webhook code.
- **C7 · A5 refuted** (`grep entitlements|EntitlementClaims apps/web/lib` is empty) → **R4.7 is
  cut.** A4 confirmed (`bookkeeping.controller.ts:221-222` finance-dashboard ungated). A8:
  `expireTrials` is `EVERY_HOUR`.
- **C8 · v11 publisher runs `main()` unconditionally at import** and builds its `Pool` at module
  scope — a spec can't import it. WP4 extracts v11's seed data into a pure module
  (non-behavioral edit the spec R7.2 already allows) and writes v12 as pure definitions + an
  import-safe runner.
- **C9 · Docs target:** the "Feature-flag keys" section lives at
  `docs/design-package/project/specs/pricing-plans.md:62`, not
  `docs/product/billing-plans.md`.
