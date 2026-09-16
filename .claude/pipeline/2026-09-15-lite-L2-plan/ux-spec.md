# UX Spec: Lite plan — "Not on your plan" and nav hiding (reuse-only)

> Authored by Fable 5.1 on 2026-09-15 · Status: DRAFT · Stage S3.
> Stands alone with [spec.md](./spec.md) (R# cited per section) and the repo design-system cache
> `.claude/pipeline/design-system.md` (cited, not repeated). **No new pattern is designed here**;
> every surface reuses an existing component or mirrors an existing hook. One small new mobile
> component is justified in the compliance table.

## Job to be done

- **Who:** a Lite-plan operator (web dashboard or Expo app, tablet), daily. Secondarily HQ paying attention that existing tenants see no change.
- **Job:** "Show me only what I bought; if I wander somewhere else, tell me plainly it's not on my plan and how to get it."
- **Why now:** discovery §1/§4. **Half-built danger:** nav hidden but deep links 403 raw (the exact thing R4 forbids), or a flash of gated items on load.

## Entry points & exits

- **Nav (web sidebar / mobile tabs + More):** gated entries absent → no entry point exists for a denied feature.
- **Deep link / bookmark / back-button** to a gated route (`/estimates`, `/recurring-invoices`, `/credit-notes`, `/returns`, `/suppliers`, `/vendor-bills`, `/messages`, `/analytics`, `/reports`, `/bookkeeping/*`, `/import`, `/sales-agents`, portal/network pages; mobile route groups of the same names) → locked panel (web `LockedPage`; mobile `PlanLockedScreen`).
- **Server PLAN_GATE 403** on a page the client thought allowed (unresolved/failed fetch) → same locked panel via `parsePlanGate` (`apps/web/lib/plan-gate`).
- **Exits:** "See plans" → `/choose-plan` (STARTER+ only — R2.6); mobile "Go back" → `router.back()`; Settings → Billing "Complete payment" → Stripe-hosted checkout → returns to Settings → Billing.

## Screen inventory

| Screen                          | Route                                                             | Purpose                                                     | User         | R#         |
| ------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- | ------------ | ---------- |
| Web sidebar                     | `(dashboard)/layout.tsx` `OPERATOR_NAV`                           | hide gated groups/leaves                                    | operator     | R4.3, R7.7 |
| Web locked panel                | any gated route, via `RouteGuard`                                 | "Not on your plan" + upsell CTA                             | operator     | R4.5       |
| Settings → Billing header       | `(dashboard)/settings/billing`                                    | plan name "Lite", price, "Complete payment" when non-ACTIVE | tenant admin | R2.5, R2.8 |
| choose-plan / marketing pricing | `(dashboard)/choose-plan`, marketing `/pricing`                   | unchanged; LITE never rendered                              | any          | R2.2, R2.6 |
| Mobile tabs + More              | `(operator)/(tabs)/_layout.tsx`, `OperatorTabBar.tsx`, `more.tsx` | hide gated tabs/rows                                        | operator     | R4.4       |
| Mobile locked screen            | gated route-group `_layout.tsx`                                   | "Not on your plan"                                          | operator     | R4.6       |

## Per-screen anatomy

### Web sidebar

- **Regions:** unchanged. Only the _set_ of rendered entries changes.
- **Rule (three-valued, mirrors `addons.ts` + `OperatorTabBar.tsx:40-44`):** `usePlanFlag(key)` → `{enabled, resolved, failed}`. Render iff `resolved ? enabled : failed`. Loading ⇒ hidden (no flash of a soon-to-vanish item); fetch failed ⇒ shown (server remains the authority; an existing tenant is never stranded by a transient 5xx — the deliberate asymmetry: **client fails OPEN, server guard fails CLOSED** (CP §5, `plan-flag.guard.ts:74-84`). This is intentional, not a bug.)
- **Groups:** a group whose every child is gated hides with its children (the Dispatch-group precedent, `layout.tsx:195-210`).
- **No new tokens or components.**

### Web locked panel (`LockedPage`, `_components/gates/PlanGates.tsx:14-53`)

- **Regions:** ghosted page body (`opacity-40 blur-[1px]`, `aria-hidden`) + centered `Card` (`max-w-md`), lock icon tile, `h3` title, one-line message, one `Button`.
- **Hierarchy:** title → message → CTA. **Primary action:** "See plans" (computed by `LockedPage` when `upgrade` is null). **Destructive:** none.
- **Synthetic gate body** for the client-side case: `{ code: "PLAN_GATE", flagKey, message: <copy below>, upgrade: null }` — same shape `parsePlanGate` accepts, so one component serves both the pre-empted and the 403 paths.

### Settings → Billing header

- Existing header shows `planName`/`monthlyPrice` from `useSubscription` — no change except the copy source (R2.8). **New:** when `status !== "ACTIVE"` and `isInviteOnlyPlanKey(planKey)` (client reads only `planKey` + the `INVITE_ONLY_PLAN_KEYS` mirror from `@routeflow/types` — a set-membership, not plan logic), one `Button` "Complete payment" → `useCreateCheckout()` → redirect to the returned URL. `loading` prop while in flight (design-system: `Button loading` → `Loader2` + `aria-busy`). Global mutation error toast (`providers.tsx:16-40`) covers failure.

### Mobile tabs + More

- Same three-valued rule through a pure helper (extend `visibleOperatorTabs(...)`'s shape) so it is jest-testable (mobile tests are pure-logic only, CP §8).

### Mobile locked screen (`PlanLockedScreen`, **new**)

- Structural clone of `apps/mobile/app/(auth)/operator-blocked.tsx` (SafeAreaView → centered column, 64 px Ionicons `lock-closed-outline`, title, message, one `MobileButton variant="secondary" size="lg"`). Colors from `packages/ui/src/tokens.ts` — no literals except those `operator-blocked.tsx` already uses.
- Rendered by a gated route group's `_layout.tsx` in place of its `<Stack>` when `resolved && !enabled`.

## State set (per surface — `n/a` reasoned)

| State                              | Sidebar / tabs                                   | Locked panel / screen                                         | Settings → Billing CTA                                                                    |
| ---------------------------------- | ------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Default                            | entries by flag                                  | n/a (only shown when denied)                                  | CTA iff non-ACTIVE + invite-only                                                          |
| Empty                              | n/a — static config                              | n/a                                                           | n/a                                                                                       |
| Loading                            | gated entries hidden; ungated render immediately | page renders normally (fail-open); no spinner added           | CTA absent until `useSubscription` succeeds; existing page skeleton                       |
| Partial                            | n/a                                              | n/a                                                           | n/a                                                                                       |
| Error                              | gated entries **shown**                          | page renders; a server 403 → panel                            | CTA absent; existing error path                                                           |
| Unauthorized (denied)              | entry absent                                     | panel: title + message + CTA                                  | n/a                                                                                       |
| Offline                            | same as Error                                    | same as Error                                                 | CTA disabled by the mutation's own failure toast                                          |
| Too much data / Stale / Concurrent | n/a — no records                                 | n/a                                                           | n/a (single record; `useSubscription` refetches on plan change via existing invalidation) |
| Success                            | —                                                | after upgrade: `useSubscription` invalidates → entries appear | redirect to Stripe                                                                        |

## Interaction & validation

- No forms, no field validation. **Double-submit:** "Complete payment" uses `Button loading={mutation.isPending}` (disables itself). **Optimistic:** none — every read is pessimistic; nav only changes after the server answers. **Failure classes:** network/5xx → the global toast (`MutationCache.onError`); a PLAN_GATE 403 is not an error to toast — it renders the panel (`parsePlanGate` first, toast only if not a gate).

## UI copy (verbatim)

| Element                          | Copy                                                        | Notes                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Locked title (web + mobile)      | `Not on your plan`                                          | `LockedPage` default title (line 40) — reused, not restated                                                                             |
| Locked message (web + mobile)    | `This feature isn't included in the {planName} plan.`       | `{planName}` from `useSubscription().planName` ("Lite"); never the literal                                                              |
| Locked CTA (web)                 | `See plans`                                                 | computed by `LockedPage` when `upgrade` is null; leads to STARTER+ (the upsell)                                                         |
| Locked secondary line (web)      | `Want it? Contact us to upgrade.`                           | LAUNCH R4's "contact us"; plain `text-sm text-slate-500` under the CTA, no link target invented — HQ's contact path is the existing one |
| Locked CTA (mobile)              | `Go back`                                                   | `MobileButton variant="secondary"`; billing is web-only, so no "See plans" on mobile                                                    |
| Locked secondary line (mobile)   | `Manage your plan on the web dashboard.`                    |                                                                                                                                         |
| Billing CTA                      | `Complete payment`                                          | one `Button`, primary; price line beneath uses the existing header format `Lite · $99/mo`                                               |
| Welcome email (0-day trial)      | `Complete payment to activate your account.`                | replaces "Your trial expires in 0 days." branch (R2.7)                                                                                  |
| Self-serve refusal (API)         | `Plan "LITE" is available by invitation only — contact us.` | `BadRequestException` message (R2.3)                                                                                                    |
| Read-only banner (could, R-copy) | `Payment required to activate your Lite plan.`              | only when `readOnlyReason === "trial_expired"` and the plan is invite-only; otherwise the existing copy                                 |

## Responsive behavior

| Breakpoint    | Change                                                                                                    | Hidden / reflowed                                            |
| ------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| all (web)     | none new — `LockedPage` is already fluid (`max-w-md`, `p-6`); the sidebar's existing collapse rules apply | design-system.md lists no custom breakpoints; stock Tailwind |
| mobile (Expo) | `PlanLockedScreen` centers in the safe area at any size (operator-blocked precedent)                      | tabs hide by the helper; no layout change                    |

## Accessibility

- **Focus order:** locked panel — title (`h3`) → CTA button; the ghosted body is `aria-hidden` and `pointer-events-none` (existing). Mobile — title, message, button.
- **Labels:** the CTA's visible label is its accessible name. No icon-only controls.
- **Contrast / target size:** repo baseline (design-system.md §A11y); `Button` `md` h-[34px] / `MobileButton size="lg"` — existing sizes.
- **Keyboard:** the whole flow is reachable: sidebar links → page → panel → CTA link.
- **Announcements:** none new (no live-region convention exists in the repo; the panel is a navigation-level replacement, announced by its heading).

## Motion

| Element  | Animates | Duration | Reduced-motion |
| -------- | -------- | -------- | -------------- |
| none new | —        | —        | —              |

The panel appears without transition (existing `LockedPage`). No skeletons are added for the entitlement read: the loading rule is _omission_, not a placeholder, so nothing shifts.

## Design-system compliance

| Token / component                                        | Used for                | Source                                        | New?                   | Justification                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ----------------------- | --------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LockedPage` (`Card`, `Button`, `Lock`/`Sparkles` icons) | web locked panel        | `_components/gates/PlanGates.tsx`             | no                     | —                                                                                                                                                                                                                                                                                                                                                                     |
| `Button` (`loading`)                                     | Complete payment        | `packages/ui/src/web/Button.tsx`              | no                     | —                                                                                                                                                                                                                                                                                                                                                                     |
| `text-sm text-slate-500`                                 | secondary lines         | as used in `LockedPage:41`                    | no                     | —                                                                                                                                                                                                                                                                                                                                                                     |
| `MobileButton`, `Ionicons`, `SafeAreaView`               | mobile locked screen    | `operator-blocked.tsx`                        | no                     | —                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/ui/src/tokens.ts` colors                       | mobile locked screen    | design-system.md "RN token mirror"            | no                     | —                                                                                                                                                                                                                                                                                                                                                                     |
| `PlanLockedScreen` component                             | mobile deep-link denial | `apps/mobile/components/PlanLockedScreen.tsx` | **yes**                | grep of `apps/mobile` for "Not on your plan" / LockedPage / PlanGate found nothing; the only full-screen blocked state is `operator-blocked.tsx` ("Desktop Only" — a different message with the same anatomy). Cloning its structure with new copy is the smallest addition; a generic prop-driven `BlockedScreen` refactor is out of scope (touches an auth screen). |
| `usePlanFlag` hooks (web + mobile)                       | nav hiding              | mirror of `lib/api/addons.ts`                 | **yes** (hook, not UI) | required by R4.3/R4.4; no UI token involved                                                                                                                                                                                                                                                                                                                           |

## Playwright verification flows (carried into test-plan §8)

Fixture: an `e2e-lite` tenant (approved `e2e-*` slug) created via the admin API on plan LITE after v12 is published; `e2e-routeflow` (STARTER-class) as the control. Desktop viewport unless noted.

1. Given `e2e-lite` operator logs in, when the dashboard loads, then the sidebar contains Orders, Invoices, Payments, Inventory/Products, Customers and none of Estimates / Recurring invoices / Credit notes / Returns / Suppliers / Vendor bills / Messages / Analytics / Reports / Imports / Sales agents / Dispatch — proves R4.3, state: default (denied).
2. Given the same session, when navigating directly to `/estimates`, then a panel with heading "Not on your plan" and a "See plans" button is visible and no error toast appears — proves R4.5, state: unauthorized.
3. Given the same session, when clicking "See plans", then `/choose-plan` shows no card named "Lite" and shows Starter/Growth/Scale — proves R2.2/R2.6.
4. Given `e2e-routeflow` operator logs in, when the dashboard loads, then the rendered sidebar label list equals the committed expected list (no snapshot; an explicit array) — proves R4.3/R7.7, state: default (allowed).
5. Given `e2e-lite` is non-ACTIVE, when opening Settings → Billing, then the header reads "Lite" and a "Complete payment" button is visible; when ACTIVE, it is absent — proves R2.5/R2.8.
6. Given the unauthenticated marketing pricing page, then no plan named "Lite" renders — proves R2.2.
7. (mobile — jest, pure-logic) `visibleOperatorTabs`-style helper: `{resolved:false, failed:false}` hides gated tabs; `{resolved:false, failed:true}` shows them; `{resolved:true, enabled:false}` hides — proves R4.4's three-valued rule. Tablet viewport for flows 1–2 as a second pass (`tablet` preset).
