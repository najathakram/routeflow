# Billing self-serve: trial cancel (TRIAL-1) + read-only visibility (RO-1) — S0–S3 digest

Lane from routeflow-fb 2026-09-13 (K-HUB comparison): two self-inflicted revenue wounds. Scope
here: S0 confirm · S2 design · S3 red tests. **STOP before the fix round** (lead ruling: no
second PR in flight during the W18 train; #710's bookkeeping takes priority). Ids unfiled —
neutral tags `TRIAL-1` / `RO-1` until routeflow-0d mints after W18. Money carve-out: billing code →
Opus refute-first review mandatory when built. Branch `fix/trial-cancel-readonly` off master
`2d353752`, worktree `rf-billing-trial`. Evidence pack (read-only, file:line quoted):
`local scratch billing-trial-pack.md` (18.8 KB) — key facts restated below.

## S0 — confirmed in code

- `tenants.service.ts:85-140` `register()` and `platform-admin.service.ts:212-252` `createTenant()`
  write `Tenant{status:"TRIAL", plan:"STARTER", trialEndsAt}` + `TenantConfig` + `ExpenseCategory[]`
  - admin `User` in one `$transaction` — **no `TenantSubscription` row** (all four writers of that
    row are subscribe / Stripe webhook / customer-cap grace / platform-admin actions).
- `subscription-mutation.service.ts:749-752` `cancel()`: `findUnique({ where: { tenantId } })` →
  `NotFoundException("No subscription to cancel.")` when null; `resume()` identical (:782-798). The
  only `cancel()` test always supplies a row; `tenants.service.spec.ts` does not exist.
- Trial-ness lives on `Tenant.status === "TRIAL"` + `trialEndsAt`; `TenantSubscription` has no
  status column and no trial field except `trialConvertedAt`.
- `READ_ONLY` is `Tenant.status` (`TenantStatus` enum), written only by `billing-cron.service.ts`
  `expireTrials()` (`readOnlyReason: "trial_expired"`) and `applyScheduledCancellations()`
  (`"subscription_cancelled"`); enforced by `TenantStatusGuard.assertAllowed()` (403
  `{ code: "READ_ONLY" }`, GET/HEAD/OPTIONS + `/auth/*` + billing subscribe/subscription exempt).
- The web receives the raw enum in `GET /billing/subscription` `status` (`entitlements.service.ts:226`)
  and renders it only as `<Badge label={s.status} />`; `TrialBanner` exists for the pre-expiry case
  only; `git grep READ_ONLY -- apps/web apps/mobile packages` is empty; a blocked write surfaces as
  the generic `MutationCache.onError` toast (`providers.tsx:16-39`), no persistent banner, no CTA.
- **Interaction:** an expired trial (READ_ONLY) has `status !== "TRIAL"`, so the Cancel button
  renders (`billing/page.tsx:223-236`) and its click hits the same 404 → raw toast "No subscription to
  cancel."

## S2 — design (Fable ruling)

### TRIAL-1 — "cancel" for a tenant without a subscription row means _end the trial now_

- `cancel()` when no row: read `Tenant{status, trialEndsAt}`; `TRIAL` → `tenant.update({ status:
"READ_ONLY", readOnlyReason: "trial_cancelled", trialEndsAt: now })`, emit the billing event
  (new constant `TRIAL_CANCELLED` beside `TRIAL_EXPIRED` if the mutation service already emits
  events; else skip), invalidate the entitlements + tenant-status caches exactly as
  `expireTrials()` does (only if those services are already injected — no `billing.module.ts`
  change; a TTL-stale guard read is acceptable and documented otherwise), resolve
  `{ cancelled: "trial" }`; `READ_ONLY` → resolve `{ cancelled: "already_read_only" }`, no write;
  any other status without a row → the existing 404 (a genuine anomaly, e.g. an ACTIVE tenant whose
  row is missing). `resume()` unchanged (a cancelled trial is restored by subscribing).
- NOT done, deliberately: creating a `TenantSubscription` row at `register()`/`createTenant()`
  (would change `EntitlementsService.resolve()`'s no-row fallback for every new tenant — a separate
  decision) and any backfill (data repair → DECIDE-30 (a) FAIL).
- **Lead ruling (fb, 2026-09-13): the no-row state is TEMPORARY.** The platform back-office Phase 0
  plan (`docs/superpowers/plans/2026-09-12-backoffice-phase-0-truth.md`, fb's, not started) carries
  a subscription-reconciliation script that creates the missing rows under owner sign-off on a
  dry-run diff (the same absence splits MRR into $499-vs-$0 on the admin dashboard). The target
  convention — every tenant carries a `TenantSubscription` row — is reached by that reconciliation,
  never by changing `register()` under a bug fix. Therefore the fix keys on **`Tenant.status`, not
  on row presence**, and is idempotent in both worlds: TRIAL → end the trial now (tenant →
  READ_ONLY/`trial_cancelled`; if a row exists, also `cancelAtPeriodEnd: true` so the row agrees);
  READ_ONLY without a row → no-op success, READ_ONLY with a row → the existing schedule path;
  any other status without a row → the existing 404 — **revisit when Phase 0 reconciliation lands:
  that case should become unreachable, not stay a 404 forever.** No new code path may assume
  no-row is the steady state.
- Invariants: no schema change; no new endpoint (same `POST /billing/subscription/cancel`,
  TENANT_ADMIN); one-armed transition untouched for ACTIVE tenants WITH a row.

### RO-1 — the read-only state is visible and actionable

- API: `GET /billing/subscription` gains `readOnlyReason: string | null` (from the tenant row;
  `entitlements.resolve()` carries it or `SubscriptionService` reads it) — additive DTO field.
- Web `settings/billing/page.tsx`: `ReadOnlyBanner` (mirror of `TrialBanner`) when
  `status === "READ_ONLY"`: heading "Your workspace is read-only"; body by reason —
  `trial_expired` "Your trial ended. Exports still work; subscribe to restore full access." /
  `subscription_cancelled` "Your subscription ended. …" / `trial_cancelled` "You ended your trial. …";
  CTA "Choose a plan" → `/choose-plan`. Cancel hidden when READ_ONLY; during TRIAL an **"End trial"**
  button (confirm dialog: "Your workspace becomes read-only now; exports still work") calls the same
  cancel mutation; ACTIVE keeps Cancel.
- Dashboard-wide: a persistent read-only banner in the dashboard shell if it has a banner slot
  (T3 manual row); `providers.tsx` gets `READ_ONLY` in `HANDLED_CODES` so the blocked-write toast
  carries a "Choose a plan" action instead of the bare guard message (T3 manual row).

## S3 — red tests (committed on this branch)

| Tag     | Test                                                                 | File                                    | Red today                        |
| ------- | -------------------------------------------------------------------- | --------------------------------------- | -------------------------------- |
| TRIAL-1 | cancel() on a trial tenant with no row ends the trial into READ_ONLY | `subscription-mutation.service.spec.ts` | 404 "No subscription to cancel." |
| TRIAL-1 | cancel() on a read-only tenant with no row is an idempotent success  | same                                    | 404                              |
| TRIAL-1 | cancel() on an ACTIVE tenant with no row still 404s (guard)          | same                                    | green (guard)                    |
| TRIAL-1 | cancel() with a row still schedules cancelAtPeriodEnd (guard)        | same                                    | green (guard)                    |
| RO-1    | subscription view carries readOnlyReason                             | `subscription.service.spec.ts`          | field undefined                  |
| RO-1    | read-only tenant sees the banner + Choose-a-plan link, no Cancel     | `billing-page.test.tsx` (web)           | no banner text                   |
| RO-1    | trial tenant sees End trial                                          | same                                    | no button                        |
| RO-1    | active tenant still sees Cancel (guard)                              | same                                    | green (guard)                    |

### Design-fit facts from S3 (reduce the build)

- `SubscriptionMutationService` already injects `entitlements: EntitlementsService` and
  `tenantStatus: TenantStatusGuard` (`subscription-mutation.service.ts:132-140`) — the cache
  invalidation in TRIAL-1 needs no `billing.module.ts` change (no L-115 boot proof needed).
- `apps/web/app/(dashboard)/layout.tsx:1399` renders `<ImpersonationBanner />` above `<Header>` —
  the slot for the dashboard-wide read-only banner (T3 manual row).
- `SubscriptionView` (`apps/web/lib/api/billing.ts:52-66`) has no `readOnlyReason` yet — the fix
  adds the field to the shared view type alongside the API DTO.
- `subscription.service.spec.ts` already exists (inline mocks, no shared `make()`); the RO-1 api
  test appends to its `getSubscription` describe.

## DECIDE-30 conditions at build time

(a) no data repair — PASS by design · (b) no migration — PASS · (c) Opus refute-first review —
REQUIRED (billing = money carve-out) · (d) REG red on the wrong value — the rows above.

## Manual verification (T3, at build time)

| Tag     | Check                                                                                      | Expected                                                                                |
| ------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| RO-1    | dashboard shell banner for a READ_ONLY tenant; blocked-write toast carries "Choose a plan" | persistent banner on every dashboard page; toast action navigates to `/choose-plan`     |
| TRIAL-1 | "End trial" from the billing page on a `test`-tenant trial                                 | confirm dialog → workspace read-only, exports work, banner shows "You ended your trial" |

## TO FILE (after W18, by routeflow-0d)

- TRIAL-1 (high): a trial tenant cannot cancel — no subscription row, `cancel()` 404s; expired
  trials show Cancel and get the raw 404 toast.
- RO-1 (high): READ_ONLY is invisible in the web app — no banner, no CTA, no handled toast.
- (Not a TO FILE — lead decision, Phase 0:) the register/subscribe row convention is settled by the
  back-office Phase 0 reconciliation plan above; only TRIAL-1 and RO-1 are filed.

## Lead rulings 2026-09-13 (fb)

1. Never push a red-tests-only branch (a merge-train accident); committed locally satisfies the
   no-uncommitted-work rule. 2. Proceed to the fix round now — Opus refutation mandatory (money
   carve-out), fix, then HOLD before the push; the PR opens only after #710 merges and its
   bookkeeping follow-up lands. 3. Correct in both worlds (row / no row), see S2. 4. Row convention
   = Phase 0, not a registry item.
