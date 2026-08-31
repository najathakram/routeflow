# Plans, Entitlements & Platform Billing

_How RouteFlow sells itself as a SaaS product — plan catalog, entitlement resolution, metering,
and the platform-admin/Stripe machinery behind it._

## The problem

Distribution businesses are not one size. A two-van operation coming off paper books needs order
entry and a delivery list; a 25-seat regional wholesaler needs commission accrual, tobacco
filings, AP scanning and forecasting. Sold as one monolithic product, the small operator pays for
modules they will never open and the large one hits a wall they cannot buy past without a phone
call and a developer. On the vendor side, the equivalent of the customer's spreadsheet is a
hand-edited feature switch: nobody can say what a given tenant is actually paying for, what they
are entitled to, or what the business's run-rate is, and every "can you turn X on for them"
becomes a deploy.

## Why it matters to a tenant

A tenant starts on Starter ($99/mo, 3 seats, 100 customers, 1 route/day per the v11 catalog) and
buys only what the business grows into — a Regulated Items pack the month it starts carrying
tobacco, a +100 customer pack when the book outgrows the tier. Going over a metered cap never
kills the day's work: the customer that breaches it still saves and a 7-day grace window opens
instead. Price rises don't apply retroactively for tenants that carry a version pin — the tenant
stays on the `PlanVersion` it subscribed on and its `basePriceSnapshot`. For RouteFlow, every
plan/addon/seat/trial transition writes one signed `BillingEvent.amountDelta` in the same
transaction as the state change, so MRR is a query rather than a spreadsheet.

## Core use cases

1. **Resolve what this tenant is allowed to do** — given a tenant, answer authoritatively and
   cheaply which plan, which feature flags, which add-ons, and what capacity on each meter, and
   enforce that answer on every request server-side regardless of what the client's token claims.
2. **Sell and collect on a recurring subscription** — let a business pick a plan, start on a
   trial, convert to paid, change tier mid-cycle with the money handled correctly, cancel, and be
   cut off gracefully when payment stops, without deleting their data.
3. **Vary one tenant without a deploy** — turn a capability on or off for a single workspace, from
   an admin screen, taking effect within seconds and leaving an audit trail.

## Must have (P0)

| ID       | Capability                                               | Status     | What it does                                                                                                                                                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------- | -------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PLAN-M1  | Versioned plan catalog stored as data                    | PARTIAL 🟡 | Plans/prices/caps/flags live as a versioned DB catalog; draft→publish never re-prices existing tenants                                                                              | `PlanVersion`/`PlanDefinition`/`AddonSku` models; `plan-catalog.service.ts`; SUPER_ADMIN routes for versions/publish. verified: the only shipped price-editing UI (`admin/plans/page.tsx` → `PATCH .../plans/:planKey/prices`) mutates the currently PUBLISHED PlanDefinition in place and fans out to unpinned tenants — price history is overwritten, not versioned; caps/flags have no editor at all                                           |
| PLAN-M2  | Per-tenant entitlement resolution                        | SHIPPED ✅ | One function resolves plan key, granted flags, active add-ons, five caps and trial end; cached 30s, invalidated on mutation, mirrored into the JWT                                  | `entitlements.service.ts` resolve/hasFlag/toClaims/compute(); JWT enrichment in `auth.service.ts`; inspector at `GET /platform-admin/tenants/:id/entitlements`                                                                                                                                                                                                                                                                                    |
| PLAN-M3  | Server-side feature gating with a structured refusal     | PARTIAL 🟡 | A gated endpoint 403s naming the missing flag and the cheapest way out; server re-resolves from DB so a forged token claim can't unlock anything                                    | `plan-flag.guard.ts` + `addon.guard.ts` + `plan-gate.ts`; live gates across analytics/vendor-bills/reports/forecasting/pricing-tiers/returns/import/credit-limits/sales-agents/msrp/dispatch/regulated/ocr. Seven flags sit in `DARK_PLAN_FLAGS`, muted unless `PLAN_FLAG_ENFORCEMENT="on"` — a global env switch, not per tenant                                                                                                                 |
| PLAN-M4  | Free trial with a defined landing                        | PARTIAL 🟡 | New workspace gets 14 days full Starter capability; on expiry it becomes read-only (reads/exports/sign-in keep working)                                                             | `tenants.service.ts` (TRIAL, +14d); `billing-cron.service.ts expireTrials()`; `tenant-status.guard.ts`; extend-trial endpoint. verified: the stated "subscribe path stays open" is false — `POST /billing/quote` is absent from the READ_ONLY allowlist and choose-plan's Subscribe button only renders once a quote returns, so an expired trial has no purchasable landing (same root cause as PLAN-M5)                                         |
| PLAN-M5  | Self-service plan selection and commit                   | BROKEN 🔴  | Tenant sees plans, gets a server-priced quote, and commits — converting a trial or reactivating a lapsed workspace                                                                  | `GET /billing/plans`, `POST /billing/quote`, `POST /billing/subscribe`; `proration.service.ts`; `choose-plan/page.tsx`. BROKEN: `tenant-status.guard.ts` allows `/billing/subscribe` and `/billing/subscription*` for READ_ONLY tenants but not the `/billing/quote` that must precede them, and choose-plan renders Subscribe only inside `{preview && !preview.isCustom}` — expired-trial tenant gets a 403 on quote and no button ever appears |
| PLAN-M6  | Change tier mid-life: upgrade, downgrade, cancel, resume | BROKEN 🔴  | Upgrade takes effect immediately with prorated charge; downgrade is scheduled for period end with seat retention; cancel is scheduled and reversible                                | API complete: `subscription-mutation.service.ts` upgrade/downgrade/cancel/resume with an optimistic concurrency guard, applied by `billing-cron.service.ts`. BROKEN at the UI: `useUpgrade`/`useDowngrade` have zero call sites — the only change-plan path is `useSubscribe`, so every plan change is charged a full non-prorated cycle and resets period dates (bug B58, Critical, open)                                                        |
| PLAN-M7  | Usage metering across the five meters                    | PARTIAL 🟡 | Seats, routes/day, AI scans, messages and customers measured per tenant with the right semantics for each                                                                           | `meter.service.ts` read/readAll/increment; cycle roll in `billing-cron.service.ts rollCycles()`; `GET /billing/usage`. PARTIAL: the SCANS meter has no production writer for billing purposes — understated in the source analysis: a parallel `AiUsageEvent` cost ledger IS written on every scan (see PLAN-N16) but never feeds the billing SCANS meter, so the advertised "20/100/300 scans per month" cap always reads 0                      |
| PLAN-M8  | Soft caps with a grace window, never a mid-flight block  | PARTIAL 🟡 | Exceeding a plan allotment never fails the work that crossed the line; a 7-day window opens to resolve it                                                                           | `GRACE_DAYS = 7`; `customers.service.ts assertCustomerCapNotExceeded()` + `maybeStartCustomerGrace()`; `billing-cron.service.ts expireGrace()`. PARTIAL: CUSTOMERS is the only meter with a cap gate — SEATS, ROUTES, SCANS and MSGS have no enforcement anywhere                                                                                                                                                                                 |
| PLAN-M9  | Platform-admin control of a single tenant                | PARTIAL 🟡 | A RouteFlow admin can see and change one workspace's commercial state: plan, status, trial, add-ons, negotiated price, and a resolved-entitlements inspector                        | Admin routes for plan/status/extend-trial/activate-subscription/addons/price-override; every action writes an AdminAudit row. verified: the entitlements inspector route exists but has zero UI callers anywhere in apps/web, and the admin plan picker is hardcoded to `["STARTER","PROFESSIONAL","ENTERPRISE"]` — GROWTH and SCALE, two of the four live v11 plans, cannot be assigned by an admin at all                                       |
| PLAN-M10 | Actually taking the money (Stripe)                       | PARTIAL 🟡 | Subscription charged through Stripe: checkout session, billing portal, webhooks keeping RouteFlow's status in step with payment reality                                             | `stripe.service.ts`, `billing.service.ts` (checkout/portal/sync/webhook handlers), `platform-pricing.service.ts`. PARTIAL: checkout and portal are SUPER_ADMIN-only; no tenant-facing payment-method, card-update or portal entry point exists in settings/billing                                                                                                                                                                                |
| PLAN-M11 | Append-only billing ledger and MRR rollup                | PARTIAL 🟡 | Every commercial transition writes one immutable, signed `BillingEvent` in the same transaction as the state change; platform MRR reconciled against the ledger sum                 | `BillingEvent` model; `billing-event.service.ts emit()`; `mrr.service.ts computeOverview()` returns both `mrr` and `ledgerMrr`. verified: the reconciliation never reaches a human — `admin/billing/page.tsx` reads only `mrr`/`momDelta`, never renders `ledgerMrr`, and the service's own comment says the two are known to drift                                                                                                               |
| PLAN-M12 | Graduated enforcement of account status                  | SHIPPED ✅ | Five workspace states enforced globally: TRIAL/ACTIVE work fully, READ_ONLY keeps reads/exports/sign-in/subscribe alive, SUSPENDED/CANCELLED hard-block; no state ever deletes data | `TenantStatus` enum; `tenant-status.guard.ts` as an APP_GUARD, 60s cached, anchored mutation allowlist, fails to last-known status on a DB blip                                                                                                                                                                                                                                                                                                   |
| PLAN-M13 | Tenant-facing entitlement read powering every nav gate   | SHIPPED ✅ | The client-side half of entitlement resolution: one endpoint every web and mobile nav/section gate calls to hide locked items                                                       | verified (missed capability): `GET /tenants/me/addons` (`tenants.controller.ts`) → `apps/web/lib/api/addons.ts` and its mobile twin (useRoutesAccess/useDeliveryAccess/useDeveloperMode); role widening pinned by a spec                                                                                                                                                                                                                          |
| PLAN-M14 | Conditional payload-dependent addon enforcement          | SHIPPED ✅ | A fourth gating shape beyond plan-flag/addon/soft-cap: guard inspects the request body and demands an add-on only when the action actually needs it                                 | verified (missed capability): `driver-payments.guard.ts` demands the `driver_payments` TenantAddon only when `payment.amount > 0`, wired into `routes.controller.ts`                                                                                                                                                                                                                                                                              |

### Testing criteria

#### PLAN-M1

- [ ] Publishing a new draft version marks the prior PUBLISHED row SUPERSEDED and touches no
      existing Tenant/TenantSubscription row `Jest`
- [ ] `createDraft()` while a draft exists throws 409, including on a concurrent-race P2002 `Jest`
- [ ] Editing a PUBLISHED/SUPERSEDED version via `updateDefinition`/`updateSku` throws 400 `Jest`
- [ ] New: `updatePlanPrices` (the only shipped editor) is asserted to mutate the published
      version in place and fan out to unpinned tenants — track this as the acceptance test for
      migrating the UI onto draft/publish `Jest`

#### PLAN-M2

- [ ] A tenant on a legacy plan-key row resolves via `findPlanDefinition` normalization, never
      falling back to STARTER caps `Jest`
- [ ] An active TenantAddon whose SKU is absent from both catalogs grants zero flags and logs a
      warning without throwing `Jest`
- [ ] Caps are additive across add-ons; a null included value stays unlimited regardless `Jest`
- [ ] `invalidate(tenantId)` forces a re-query even inside the 30s TTL `Jest`
- [ ] `resolve(tenantA)` never returns a TenantAddon row belonging to tenantB `Jest`

#### PLAN-M3

- [ ] With `PLAN_FLAG_ENFORCEMENT` unset, a dark-flagged endpoint is reachable without the flag;
      set to "on", it 403s with `code: "PLAN_GATE"` `Jest`
- [ ] A JWT claiming a flag the database denies does not unlock the guard — it must call
      `EntitlementsService.hasFlag`, never read `req.user`'s claims `Jest`
- [ ] Entitlement resolution throwing returns 403 `PLAN_GATE_UNAVAILABLE`, never a 500 or an
      allow `Jest`
- [ ] A `tenantId === null` (SUPER_ADMIN) request passes every plan-flag and addon gate `Jest`
- [ ] A 403 for a multi-key `@RequireAddon` names only the public key, never an internal one
      `Jest`

#### PLAN-M4

- [ ] A TRIAL tenant past `trialEndsAt` becomes READ_ONLY (not SUSPENDED), emits one
      `trial.expired` event, and invalidates both entitlement and status caches `Jest`
- [ ] READ_ONLY tenant: GET requests and `/billing/export` and `/billing/subscribe` are allowed;
      POST `/customers` is refused with `code: "READ_ONLY"` `Jest`
- [ ] `extendTrial` resets `trialEndsAt`, forces TRIAL, invalidates the status cache, writes an
      admin audit row `Jest`
- [ ] Acceptance test for the fix: a forced-READ_ONLY tenant on `/choose-plan` gets a 200 from
      `POST /billing/quote` and sees a Subscribe button `Playwright`

#### PLAN-M5

- [ ] Acceptance test: forced-READ_ONLY tenant, `POST /billing/quote` returns 200 and a
      "Subscribe to <plan>" button renders — fails today `Playwright`
- [ ] `subscribe()` on TRIAL writes `trialConvertedAt`, sets ACTIVE, emits one `trial.converted`
      plus one `plan.changed` with the correct `amountDelta` `Jest`
- [ ] `subscribe()` naming a SKU outside `SELF_SERVICE_ADDON_SKUS` throws 403, writes nothing
      `Jest`
- [ ] Money invariant: `dueToday`/`subtotalMonthly` are cent-rounded sums of quote lines; ANNUAL
      prices each line at monthly × 10 `Jest`
- [ ] `quote()` with an unknown planKey/SKU or a duplicate SKU throws 400 and prices nothing
      `Jest`

#### PLAN-M6

- [ ] Changing plan tier on `/settings/billing` issues `POST /billing/subscription` (upgrade) or
      `/subscription/downgrade`, never `/billing/subscribe` — fails today `Playwright`
- [ ] Two concurrent upgrades produce exactly one `plan.changed` row; the loser throws 400 and
      emits no delta `Jest`
- [ ] `upgrade()` to an equal/lower plan and `downgrade()` to an equal/higher plan both throw 400
      and write nothing `Jest`
- [ ] `applyScheduledDowngrades` deactivates only non-retained OPERATOR/DRIVER users when over
      the seat cap, never a TENANT_ADMIN, and emits one `seat.freed` event `Jest`
- [ ] `cancel()` then `resume()` before period end nets a zero `amountDelta` and leaves the
      tenant ACTIVE `Jest`

#### PLAN-M7

- [ ] `increment(tenantId,"SCANS",-5|0|NaN)` is a no-op; a Prisma failure inside increment
      resolves rather than throwing `Jest`
- [ ] Deactivating a DRIVER or soft-deleting a customer drops the relevant meter on the next
      read; a supplierOnly contact is never counted `Jest`
- [ ] `rollCycles` starts a fresh MSGS bucket at 0 while leaving the prior bucket's row intact
      `Jest`
- [ ] New: assert each of the four `@RequireAddon("ocr")` endpoints calls `meter.increment(...,
"SCANS", ...)` — fails today; acceptance test for wiring the billing meter to the
      already-working `AiUsageEvent` cost ledger `Jest`
- [ ] The `MeterUsage` upsert is keyed on `(tenantId, meter, periodStart)`; a second tenant's
      identical period never shares the row `Jest`

#### PLAN-M8

- [ ] Creating customer #101 over a 100 cap succeeds and stamps `graceStartedAt`/`graceMeter` via
      upsert `Jest`
- [ ] A create attempted 8 days after grace start while still over cap throws 403
      `PLAN_GATE`/`INLINE_RESOLVE` naming `CUSTOMER_PACK_100`, and persists no Customer row `Jest`
- [ ] `MeterService.read` throwing still allows the create (fail open) `Jest`
- [ ] `expireGrace` leaves an aged window in place while still over cap, clears it once back
      within cap `Jest`
- [ ] CSV/bulk contact import calls the same cap-assertion pair as single-create `Jest`

#### PLAN-M9

- [ ] `updatePlan` resolves against the PUBLISHED PlanVersion and writes the enum shadow via
      `planKeyToEnum` — a raw cast must fail enum validation `Jest`
- [ ] `getTenantEntitlements` returns plan/flags/addons/caps/meters and 403s for non-SUPER_ADMIN
      `Jest`
- [ ] `enableAddon` for a legacy key bridged to a SKU absent from the published catalog throws
      400 naming the SKU `Jest`
- [ ] New (acceptance): the entitlements inspector is mounted on the admin tenant page and
      renders resolved flags/add-ons/caps — fails today (zero UI callers) `Playwright`
- [ ] New (acceptance): the admin plan picker lists all four live plan keys (STARTER, GROWTH,
      SCALE, ENTERPRISE), not the stale `["STARTER","PROFESSIONAL","ENTERPRISE"]` list — fails
      today `Playwright`

#### PLAN-M10

- [ ] `checkoutPriceData` rounds to integer cents; an annualPrice of exactly 0 is honoured as a
      promo price, never re-derived `Jest`
- [ ] `resolveTenantPricing` for an isCustom plan with no override throws 400 and creates no
      session `Jest`
- [ ] `onCheckoutCompleted` for an already-ACTIVE tenant emits no duplicate delta (idempotent
      against a racing webhook) `Jest`
- [ ] `POST /billing/webhook` with a missing or invalid signature returns 400 and never processes
      the body `manual`
- [ ] `suspendOverdueTenants` suspends only on a genuine Stripe past_due/unpaid/canceled status
      and emits exactly one negative-MRR delta `Jest`

#### PLAN-M11

- [ ] `mrr === roundMoney(baseMrr + addonMrr − discountTotal)`; add-ons on a tenant with no base
      plan are excluded from `addonMrr` `Jest`
- [ ] Re-enabling an add-on at an unchanged quantity emits no event `Jest`
- [ ] The state write and its BillingEvent share one transaction — a forced event-insert failure
      must leave TenantSubscription unchanged `Jest`
- [ ] New (acceptance): `admin/billing/page.tsx` renders `|ledgerMrr − mrr|` against a threshold
      instead of discarding `ledgerMrr` — fails today `Playwright`

#### PLAN-M12

- [ ] SUSPENDED/CANCELLED tenants are refused on every method including GET; READ_ONLY only on
      mutations `Jest`
- [ ] The mutation allowlist is anchored, not substring-matched, against a path-smuggling
      attempt `Jest`
- [ ] A missing/malformed JWT passes this guard untouched `Jest`
- [ ] After `invalidate(tenantId)` a status change is visible immediately; a Prisma error reuses
      the last known status `Jest`

#### PLAN-M13

- [ ] `GET /tenants/me/addons` returns only flags/add-ons the resolver actually grants for the
      caller's tenant `Jest`
- [ ] A hiding-only nav gate reads `enabled` directly and fails open per the established rule; a
      gate that can strand a user keys off `resolved` `Jest`

#### PLAN-M14

- [ ] A driver-payment action with `amount === 0` is never gated by the addon; `amount > 0`
      without the addon 403s `Jest`
- [ ] The guard reads the request body, not a route param, so amount cannot be bypassed by
      routing `Jest`

## Nice to have (P1)

| ID       | Capability                                                         | Status     | What it does                                                                                                                          | Evidence                                                                                                                                                                                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PLAN-N1  | Usage-fit plan recommendation                                      | SHIPPED ✅ | Chooser tells the tenant which plan fits their actual usage and by how much each plan is over on each meter                           | `GET /billing/recommendation`; `subscription.service.ts getRecommendation()`; "Best fit" badge on choose-plan                                                                                                                                                                                                                                                |
| PLAN-N2  | Add-on self-service with a proration preview                       | PARTIAL 🟡 | Before enabling a paid add-on mid-cycle, the tenant sees exactly what they'll be charged                                              | `GET /billing/proration-preview`; PARTIAL: `useProrationPreview` has zero call sites — settings/billing enables first, toasts the charge after                                                                                                                                                                                                               |
| PLAN-N3  | Inline-resolve gate: buy the add-on without leaving the page       | MISSING ⬜ | A purchasable-entitlement block should be a one-click modal with the prorated price                                                   | Server returns `INLINE_RESOLVE`; `InlineResolveModal` component exists with zero call sites — every such 403 degrades to a toast or a locked page                                                                                                                                                                                                            |
| PLAN-N4  | Grace warning before the wall                                      | MISSING ⬜ | A tenant over a soft cap should be told during the 7-day window, not discover it on day 8                                             | `GraceBanner` exists with zero call sites; `GET /billing/subscription` does not expose `graceStartedAt`/`graceMeter` at all                                                                                                                                                                                                                                  |
| PLAN-N5  | Locked-page upsell for plan-only features                          | SHIPPED ✅ | A gated feature shows the real page ghosted behind an upsell card naming the plan/SKU and price                                       | `LockedPage` used on sales-agents, commissions, compliance; CTA derives from the gate's upgrade payload                                                                                                                                                                                                                                                      |
| PLAN-N6  | Annual prepay at two months free                                   | SHIPPED ✅ | Annual pricing derived one way everywhere so quote/checkout/subscription card never disagree                                          | `billing-math.ts` annualPrice/annualSaving (×10/×2); Monthly/Annual toggle on choose-plan                                                                                                                                                                                                                                                                    |
| PLAN-N7  | Grandfathered pricing                                              | PARTIAL 🟡 | Existing customers keep the deal they signed; a published price change hits new business, not everyone                                | `Tenant.planVersionId`/`TenantSubscription.planVersionId` pin; `getVersionForTenant`. verified: `updatePlanPrices` deliberately fans out to `OR: [{planVersionId: version.id}, {planVersionId: null}]` and its own comment states every Stripe-checkout tenant is unpinned — so the one shipped price-edit UI DOES re-price that entire cohort retroactively |
| PLAN-N8  | Negotiated per-tenant price                                        | SHIPPED ✅ | Sales can agree a custom fee for one workspace; that number is what Stripe charges and the tenant sees                                | `priceOverrideMonthly`/`priceOverrideAnnual`; admin price-override route; `platform-pricing.service.ts resolve()`                                                                                                                                                                                                                                            |
| PLAN-N9  | Billing data export that survives read-only                        | PARTIAL 🟡 | A trial-lapsed or cancelled tenant can still take subscription/usage/event history with them                                          | `GET /billing/export` (a GET, so READ_ONLY-permitted). PARTIAL: JSON only, not linked from settings/billing UI, `invoices` array always empty (no RfInvoice writer)                                                                                                                                                                                          |
| PLAN-N10 | Catalog authoring through draft and publish                        | PARTIAL 🟡 | Changing what plans include should be a reviewed act: draft, edit, publish as a new version                                           | API complete; PARTIAL: `admin/plans/page.tsx` uses the in-place price patch instead, and there is no UI at all for editing caps/flags/SKUs                                                                                                                                                                                                                   |
| PLAN-N11 | Public pricing page driven by the live catalog                     | MISSING ⬜ | Prices a prospect reads on the marketing site match what the product actually charges                                                 | `GET /billing/plans` exists for exactly this and is never called; `pricing-tiers.tsx` hardcodes a stale three-tier ladder against the live four-plan catalog                                                                                                                                                                                                 |
| PLAN-N12 | Downgrade with a seat-retention choice                             | PARTIAL 🟡 | When a tier drop means fewer seats than the team uses, the tenant chooses who keeps access                                            | `retainedUserIds` field and DTO exist and are honoured by the cron; PARTIAL: no UI ever sends the array, so it is always `[]` in practice                                                                                                                                                                                                                    |
| PLAN-N13 | Failed-payment recovery (dunning)                                  | PARTIAL 🟡 | A declining card starts a recovery sequence the tenant can act on before access is reduced                                            | `onPaymentFailed()` sends one best-effort email, 3-day grace, then suspends. PARTIAL: `failedPaymentCount` never increments, no retry ladder, no in-app banner, no self-service card update                                                                                                                                                                  |
| PLAN-N14 | Show the consequences before a plan change                         | MISSING ⬜ | Before committing a downgrade, the tenant sees what stops working and which caps they're over                                         | The recommendation endpoint and PlanDefinition flags already carry the raw data; nothing composes them into a confirm-step diff                                                                                                                                                                                                                              |
| PLAN-N15 | Tenant-facing invoice and receipt history                          | MISSING ⬜ | A tenant can see and download what RouteFlow has charged them, invoice by invoice                                                     | `RfInvoice` model exists and is read by the export, but has no writer anywhere; no web surface lists it                                                                                                                                                                                                                                                      |
| PLAN-N16 | Per-tenant AI cost metering and platform rollup                    | SHIPPED ✅ | A fully-working usage ledger records every AI/OCR call per tenant, by feature and token count, independent of the billing SCANS meter | verified (missed capability): `AiUsageEvent` model, written by `PlatformConfigService.recordAiUsage` (never throws) from vendor-bills/supplier-statements/bookkeeping/route-analysis call sites; rolled up at `GET /platform-admin/ai-config/usage` (calls, tokens, failures, estimated spend by feature)                                                    |
| PLAN-N17 | Platform subscription roster and billing overview                  | SHIPPED ✅ | An admin-facing summary of active/cancel-pending/trial tenant counts plus a per-tenant subscription roster                            | verified (missed capability): `GET /platform-admin/billing/overview` and `GET /billing/tenants/:tenantId`                                                                                                                                                                                                                                                    |
| PLAN-N18 | Tenant growth / signup cohort counts                               | SHIPPED ✅ | Monthly tenant-creation counts for admin charts                                                                                       | verified (missed capability): `GET /platform-admin/stats/growth?months=N`                                                                                                                                                                                                                                                                                    |
| PLAN-N19 | Admin-mirrored Stripe checkout and portal links on the tenant page | SHIPPED ✅ | A second, admin-tenant-scoped pair of checkout/portal routes alongside the general BillingController ones                             | verified (missed capability): `POST /platform-admin/tenants/:id/billing/checkout` and `/billing/portal`                                                                                                                                                                                                                                                      |
| PLAN-N20 | Support impersonation with re-snapshotted entitlements             | SHIPPED ✅ | A RouteFlow admin can impersonate a tenant and see a token stamped with that tenant's real resolved entitlement claims                | verified (missed capability): `POST /platform-admin/tenants/:id/impersonate`; `ImpersonationGuard` is an APP_GUARD; token stamped via `EntitlementsService.claimsFor` — the closest thing shipped to an entitlement-change preview                                                                                                                           |
| PLAN-N21 | Tenant lifecycle admin: config patch and soft delete               | SHIPPED ✅ | Admin can patch tenant config and soft-delete a tenant, which is what removes it from the MRR rollup                                  | verified (missed capability): `PATCH /platform-admin/tenants/:id/config`; `DELETE /platform-admin/tenants/:id`                                                                                                                                                                                                                                               |

### Testing criteria

#### PLAN-N1

- [ ] A tenant using minimal seats/routes/scans recommends the cheapest fitting plan; a tenant
      over every plan's caps recommends ENTERPRISE `Jest`
- [ ] A null cap counts as unlimited and contributes 0 to `over` `Jest`
- [ ] Because SCANS never increments into the billing meter, the recommendation is a documented
      lower bound for scan-heavy tenants `Jest`
- [ ] Exactly one plan card carries "Best fit", matching the API's `recommendedPlanKey`
      `Playwright`

#### PLAN-N2

- [ ] For an ANNUAL-cycle tenant the preview window is the current calendar month, never the
      annual period `Jest`
- [ ] `proratedToday` for a partial month is cent-rounded correctly `Jest`
- [ ] Acceptance: clicking Enable shows the prorated amount BEFORE the confirm, not a post-hoc
      toast — fails today `Playwright`
- [ ] `enableAddon`/`disableAddon` for a non-self-service SKU both 403 with the support message
      `Jest`

#### PLAN-N3

- [ ] A tenant lacking a purchasable flag sees the inline modal naming the SKU and prorated cost
      — fails today (zero call sites) `Playwright`
- [ ] Confirming issues the enable call and the panel loads without a reload `Playwright`
- [ ] A plain OPERATOR sees the modal read-only, no Enable button that would 403 `Playwright`
- [ ] `parsePlanGate` distinguishes `PLAN_GATE` from `PLAN_GATE_UNAVAILABLE` `Jest`

#### PLAN-N4

- [ ] `GET /billing/subscription` returns `graceStartedAt`/`graceMeter`/`daysRemaining` when open
      — fails today `Jest`
- [ ] A tenant one customer over cap sees the amber banner with correct remaining days
      `Playwright`
- [ ] The banner disappears once back within cap on the next fetch `Playwright`
- [ ] The client's days-remaining figure derives from the same `GRACE_DAYS` constant the server
      enforces `Jest`

#### PLAN-N5

- [ ] Locked page shows an upsell card naming the plan/SKU and price, content is
      `pointer-events:none` `Playwright`
- [ ] Hitting the API directly still 403s — the locked page is UX only `Playwright`
- [ ] CTA reads "Add <SKU>" for an addon-grantable flag, "Upgrade" otherwise `Playwright`
- [ ] `upgradeTargetForFlag` returns the cheapest granting plan, null when unseeded `Jest`

#### PLAN-N6

- [ ] `annualPrice(249) === 2490`, `annualSaving(249) === 498`, cent-rounded `Jest`
- [ ] A stored `annualPrice` of 0 is used verbatim, never replaced by 10× monthly `Jest`
- [ ] Toggling Monthly/Annual re-quotes from the server; displayed saving matches the API
      `Playwright`

#### PLAN-N7

- [ ] A tenant pinned to a prior version still resolves the prior price and contributes it to
      `baseMrr` after a catalog price rise `Jest`
- [ ] New (acceptance): a Stripe-checkout (unpinned) tenant is proven to be re-priced by
      `updatePlanPrices` — document this as the intended trade-off or fix it, but the test must
      assert the actual behaviour, not the aspirational one `Jest`
- [ ] `updatePlanPrices` skips only tenants with a non-null `priceOverrideMonthly` `Jest`

#### PLAN-N8

- [ ] With `priceOverrideMonthly` set and no annual override, `resolve` derives annual as
      monthly × 10 and reports `source: "override"` `Jest`
- [ ] An annual-only override on a plan with no catalog monthly throws 400 naming the missing fee
      `Jest`
- [ ] `GET /billing/subscription` reports the override so the tenant's card matches their Stripe
      invoice `Jest`

#### PLAN-N9

- [ ] A READ_ONLY tenant receives 200 from the export `Jest`
- [ ] The export is tenant-scoped `Jest`
- [ ] An "Export billing data" control exists in settings/billing — fails today `Playwright`
- [ ] The 500-row truncation is documented or paginated `Jest`

#### PLAN-N10

- [ ] `/admin/plans` can open a draft, edit caps/flags, publish, and the prior version shows
      SUPERSEDED — fails today `Playwright`
- [ ] `updatePlanPrices` never touches a tenant with a price override and is recorded in the
      admin audit log `Jest`
- [ ] `FLAG_KEYS`/`ADDON_SKUS`/`METER_KEYS` match the seeded catalog exactly `Jest`

#### PLAN-N11

- [ ] `/pricing` renders exactly the plans from `GET /billing/plans` — fails today `Playwright`
- [ ] Every feature bullet maps to a real `FLAG_KEYS`/`METER_KEYS` entry `Playwright`
- [ ] A catalog-fetch failure renders a graceful fallback, never stale hardcoded prices
      `Playwright`

#### PLAN-N12

- [ ] Acceptance: downgrading with excess seats presents a retention picker requiring the right
      number of selections and posts them — fails today `Playwright`
- [ ] With `retainedUserIds = []`, the cron deactivates every non-admin OPERATOR/DRIVER — assert
      this default is deliberate `Jest`
- [ ] No user row is ever deleted, only deactivated `Jest`

#### PLAN-N13

- [ ] `onPaymentFailed` increments `failedPaymentCount` — currently never moves off 0 `Jest`
- [ ] A tenant with no TENANT_ADMIN email does not throw; the webhook still returns 200 `Jest`
- [ ] An ACTIVE tenant with a failed payment sees a persistent in-app banner with a working
      "Update payment method" action — fails today `Playwright`
- [ ] Suspension requires both grace elapsed AND a live Stripe bad status; a Stripe API error
      must not suspend on a guess `Jest`

#### PLAN-N14

- [ ] Selecting a lower plan shows a confirm step listing lost flags by human name and every
      meter the tenant is over `Playwright`
- [ ] Selecting a higher plan shows gains and the prorated amount due today `Playwright`
- [ ] A flag granted by an active add-on must not appear as "lost" on a plan downgrade `Jest`

#### PLAN-N15

- [ ] A successful `invoice.payment_succeeded` webhook writes exactly one `RfInvoice` row with a
      unique `RF-YYYY-NNNN` number `Jest`
- [ ] Replaying the same Stripe event does not create a second row `Jest`
- [ ] settings/billing lists past charges with a per-row download `Playwright`
- [ ] The invoice list query is tenant-scoped; another tenant's RF number is never guessable
      `Jest`

#### PLAN-N16

- [ ] `recordAiUsage` never throws even on a DB failure — metering must not break the feature
      `Jest`
- [ ] `getAiUsage` rollup correctly buckets by feature (ocr/forecast/insight) and reports failure
      counts `Jest`
- [ ] New (acceptance): document explicitly that `AiUsageEvent` is a cost ledger only and is
      never read by the billing SCANS meter or any plan gate `Jest`

#### PLAN-N17

- [ ] `getBillingOverview` counts match a seeded fixture of active/cancel-pending/trial tenants
      `Jest`
- [ ] The roster never leaks another tenant's Stripe customer id to a non-SUPER_ADMIN caller
      `Jest`

#### PLAN-N18

- [ ] Monthly counts sum to the total tenant count across the queried window `Jest`

#### PLAN-N19

- [ ] The admin-scoped checkout/portal routes require SUPER_ADMIN and target the correct tenant
      `Jest`

#### PLAN-N20

- [ ] The impersonation token's entitlement claims match a live `resolve()` call for the target
      tenant `Jest`
- [ ] `ImpersonationGuard` blocks impersonation of a tenant by a non-SUPER_ADMIN `Jest`

#### PLAN-N21

- [ ] Soft-deleting a tenant removes it from `payingTenants`/`byPlan` on the next MRR rollup
      `Jest`
- [ ] `PATCH .../config` writes only documented config fields, no plan/billing fields via this
      path `Jest`

## Advanced / future (P2)

| ID       | Capability                                                                     | Status     | What it does                                                                                                                | Evidence                                                                                                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PLAN-A1  | Seat-based billing that actually meters seats                                  | MISSING ⬜ | Charge per active user above the plan allotment, enforced at user-create time                                               | `SEAT_EXTRA` SKU exists but was retired because no cap-check is wired; `users.service.ts` has no reference to seats or caps                                                                                                                                                              |
| PLAN-A2  | Usage-based overage billing                                                    | MISSING ⬜ | Bill measured overage (extra scans, extra messages) at a published unit rate                                                | `MeterUsage` records consumption but nothing prices it; no overage rate field, no overage line anywhere                                                                                                                                                                                  |
| PLAN-A3  | Multi-currency, tax and invoicing compliance                                   | MISSING ⬜ | Sell outside a single USD jurisdiction with proper tax handling                                                             | Currency hardcoded to "usd"; no tenant-level currency field; no tax field anywhere in the billing schema                                                                                                                                                                                 |
| PLAN-A4  | Discounts, coupons and partner deals                                           | PARTIAL 🟡 | A percentage or fixed discount with a defined duration and visible expiry                                                   | `TenantSubscription.discount` field exists and is read by MRR/churn calculations, but no endpoint or service ever writes it                                                                                                                                                              |
| PLAN-A5  | Entitlement telemetry: what gate blocked whom                                  | MISSING ⬜ | Record every plan-gate denial so RouteFlow can see which locked feature people keep reaching for                            | Guards throw `ForbiddenException` without recording anything; no denial event code exists                                                                                                                                                                                                |
| PLAN-A6  | Cohort, churn and expansion-revenue reporting                                  | PARTIAL 🟡 | New vs expansion vs contraction vs churned MRR, trial-to-paid conversion by cohort                                          | `mrr.service.ts` returns a single 30-day `momDelta`; raw material (typed, timestamped BillingEvents) exists but nothing decomposes it. Understated in scope: `GET /platform-admin/billing/overview` and `/stats/growth` already give partial cohort/roster visibility (see PLAN-N17/N18) |
| PLAN-A7  | Enterprise access controls as a sold entitlement (SSO, API keys, audit export) | MISSING ⬜ | SSO, scoped API credentials, exportable audit trail sold as the top tier's reason to exist                                  | `flag.api_sso` is explicitly documented RESERVED — no SSO implementation exists; no tenant API-key model                                                                                                                                                                                 |
| PLAN-A8  | Buyer portal as a sellable module                                              | MISSING ⬜ | Retailer-facing self-service ordering portal sold as an add-on                                                              | `addon.buyer_portal` flag and `BUYER_PORTAL` SKU mapping exist but the SKU was retired because the module is unbuilt; no route carries the flag                                                                                                                                          |
| PLAN-A9  | Cancellation flow with pause and save offers                                   | MISSING ⬜ | Cancelling asks why, offers a pause or cheaper tier, confirms consequences                                                  | The Cancel button is a single unconfirmed call with no reason capture, no offer, no pause concept in the schema                                                                                                                                                                          |
| PLAN-A10 | Preview an entitlement change before applying it                               | MISSING ⬜ | Before an admin flips an add-on or plan, show what the tenant will actually see, via the same resolver that will enforce it | No dry-run form of `EntitlementsService.compute` exists. Impersonation (PLAN-N20) is the closest shipped substitute today                                                                                                                                                                |
| PLAN-A11 | Idempotent, replayable billing webhooks                                        | PARTIAL 🟡 | Every Stripe event stored once, processed once, replayable after an outage                                                  | `handleWebhookEvent` has a clever status-transition idempotency device for two of five types, but no event id is persisted and unhandled/missed events are simply lost                                                                                                                   |
| PLAN-A12 | Self-service module marketplace in-product                                     | MISSING ⬜ | Tenant browses everything RouteFlow can do and turns paid modules on themselves                                             | `SELF_SERVICE_ADDON_SKUS` has exactly two entries; six further capabilities are platform-admin-only free-text keys with no price and no tenant-visible existence                                                                                                                         |
| PLAN-A13 | Stripe Connect disambiguated from platform billing                             | MISSING ⬜ | The tenant's own buyer-payment acceptance rail, kept clearly distinct from RouteFlow's own subscription billing             | verified (missed capability): `apps/api/src/stripe-connect/` is a separate Stripe integration for tenant buyer payments; nothing in this domain's documentation or code distinguishes which Stripe account is which, the same confusion `flag.settlement` already carries                |

### Testing criteria

#### PLAN-A1

- [ ] Creating a user at the seat cap opens a grace window (mirroring CUSTOMERS) and still
      creates the user; a create after expiry is refused naming `SEAT_EXTRA` `Jest`
- [ ] Reactivating an INACTIVE user counts against the cap the same as a new create `Jest`
- [ ] `SEAT_EXTRA` at quantity N contributes exactly `roundMoney(unitMonthly × N)` `Jest`
- [ ] Do not re-add `SEAT_EXTRA` to the catalog until the cap check ships `manual`

#### PLAN-A2

- [ ] Overage is computed from the closed `MeterUsage` bucket for the ended period only `Jest`
- [ ] Overage never double-charges the same period even if the roll-up job runs twice `Jest`
- [ ] Accrued in-cycle overage is visible in settings/billing before it bills `Playwright`

#### PLAN-A3

- [ ] A EUR tenant checks out with a EUR price line and its invoice records EUR `Jest`
- [ ] Price is defined per (plan, currency), never FX-converted at checkout time `Jest`
- [ ] Tax is a separate labelled line; total equals net + tax to the cent `Jest`

#### PLAN-A4

- [ ] A 20% discount on $249 shows 199.20 on the tenant card, Stripe charge and `baseMrr` — one
      number in three places `Jest` + `manual`
- [ ] A time-boxed discount stops applying after expiry and emits a restoring `BillingEvent`
      `Jest`
- [ ] A discount can never make a resolved price negative `Jest`

#### PLAN-A5

- [ ] Every `PLAN_GATE` 403 writes one denial row (tenant, flag, route, resolved upgrade target)
      `Jest`
- [ ] Recording is fire-and-forget; a write failure still yields the 403 `Jest`
- [ ] Denials are deduplicated per tenant per flag per minute `Jest`

#### PLAN-A6

- [ ] Σ(new + expansion + contraction + churn) over a period equals that period's `momDelta`
      exactly `Jest`
- [ ] Trial-to-paid conversion is computed from `trial.converted`/`trial.expired` events in a
      cohort window, not a live status count `Jest`
- [ ] Stripe-originated churn emits a compensating delta so `ledgerMrr` converges on `mrr` `Jest`

#### PLAN-A7

- [ ] An ENTERPRISE tenant can configure an IdP and sign in through it `manual`
- [ ] A tenant-scoped API key authenticates only that tenant's data and is revocable `Jest`
- [ ] `flag.api_sso` stops being RESERVED and is covered by a real guard spec `Jest`

#### PLAN-A8

- [ ] Every buyer-portal route 403s without `addon.buyer_portal` and serves normally with it
      `Jest`
- [ ] A GROWTH tenant gets the portal from its plan definition with no TenantAddon row needed
      `Jest`
- [ ] Do not re-add `BUYER_PORTAL` to the catalog until the module ships `manual`

#### PLAN-A9

- [ ] Cancel opens a confirmation naming the exact `periodEnd` date and stating data stays
      intact `Playwright`
- [ ] A captured cancellation reason is stored on the `subscription.canceled` event payload
      `Jest`
- [ ] A pause nets its delta to zero and does not permanently churn the MRR line `Jest`

#### PLAN-A10

- [ ] A preview endpoint returns a flags/addons/caps diff computed by the same `compute()` path
      that will enforce it — assert one implementation `Jest`
- [ ] The preview performs no writes — row counts unchanged before/after `Jest`
- [ ] Applying the change afterwards matches exactly what the preview promised `Jest`

#### PLAN-A11

- [ ] The same Stripe event id delivered twice is a no-op on the second delivery across all five
      handled types `Jest`
- [ ] An unhandled event type is stored and acknowledged 200, not silently dropped `Jest`
- [ ] A failure mid-handler rolls back both `TenantSubscription` and `Tenant.status` together
      `Jest`

#### PLAN-A12

- [ ] settings/billing lists every purchasable module with price and Active/Available state
      `Playwright`
- [ ] Admin-managed (dark) modules show "Managed by RouteFlow — contact support" rather than
      being hidden `Playwright`
- [ ] Enabling a module charges the shown prorated amount before confirm and appears without a
      re-login `Playwright`

#### PLAN-A13

- [ ] Product documentation and code comments distinguish Stripe Connect (buyer payments) from
      platform billing (Stripe) wherever both are referenced near each other `manual`
- [ ] A tenant's Stripe Connect account id is never confused with or substituted for its platform
      billing `stripeCustomerId` `Jest`

## How this varies by tenant

| Variation                                                                                                                                                 | Mechanism                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which tier a workspace is on (Starter/Growth/Scale/Enterprise)                                                                                            | `TenantSubscription.planKey` + legacy `Tenant.plan` enum shadow, resolved against `planVersionId` → PlanDefinition. Changed via subscribe/upgrade/downgrade or admin plan-patch                    |
| Which of the 16 feature flags a tenant holds by tier                                                                                                      | `PlanDefinition.featureFlags` per catalog version. Editable only by publishing a new version — or, in practice, by the in-place price patch for prices only                                        |
| Add-ons bought à la carte on top of the tier                                                                                                              | `TenantAddon.sku` → `AddonSku.grantsFlags`, unioned by `EntitlementsService.compute()`. Only CUSTOMER_PACK_100 and FORECASTING are tenant-purchasable                                              |
| Capabilities toggled per tenant with no price and no catalog row (developer mode, recurring routes, order delivery, driver payments, regulated pack, OCR) | A second, parallel free-text `TenantAddon.addonKey` namespace granted by platform-admin and enforced by `AddonGuard`/`DriverPaymentsGuard` on the raw key — separate from the SKU namespace above  |
| Capacity on seats / routes-per-day / AI scans / messages / customers                                                                                      | `PlanDefinition.{...Included}` (null = unlimited) plus additive `AddonSku.capacityPerUnit × quantity`. Only the CUSTOMERS cap is actually enforced                                                 |
| What a specific tenant pays, independent of the catalog                                                                                                   | `TenantSubscription.priceOverrideMonthly`/`priceOverrideAnnual` via the admin price-override route                                                                                                 |
| Which catalog generation a tenant is priced and gated against (grandfathering)                                                                            | `Tenant.planVersionId`/`TenantSubscription.planVersionId` pin, with a subtlety: Stripe-checkout tenants are left unpinned and are re-priced by the in-place price-patch UI along with new business |
| Billing rhythm — monthly vs annual                                                                                                                        | `TenantSubscription.cycle` + `billingInterval`, chosen at checkout                                                                                                                                 |
| Payment rail — Stripe card vs external/manual arrangement                                                                                                 | `TenantSubscription.externalPayment*` fields, set via admin activate-subscription; deliberately leaves `planKey` null so it is excluded from paying-tenant MRR                                     |
| AI usage cost tracking (separate from billing meters)                                                                                                     | `AiUsageEvent` per tenant, rolled up in the admin AI-config screen — informs RouteFlow's own vendor cost, not what the tenant is billed                                                            |
| Whether the seven newer plan gates are enforced at all                                                                                                    | **NOT CONFIGURABLE per tenant** — `PLAN_FLAG_ENFORCEMENT` env var, global, default off, scoped to `DARK_PLAN_FLAGS`                                                                                |
| Trial length                                                                                                                                              | **NOT CONFIGURABLE** — hardcoded 14 days; a longer pilot only via `extend-trial` after the fact                                                                                                    |
| Soft-cap grace window length                                                                                                                              | **NOT CONFIGURABLE** — `GRACE_DAYS = 7`, shared by cron and gate                                                                                                                                   |
| Failed-payment grace before suspension                                                                                                                    | **NOT CONFIGURABLE** — `PAYMENT_GRACE_DAYS = 3`                                                                                                                                                    |
| Annual discount depth                                                                                                                                     | **NOT CONFIGURABLE** — hardcoded to exactly ten months everywhere annual is priced                                                                                                                 |
| Which add-ons a tenant may buy themselves vs which RouteFlow must grant                                                                                   | **NOT CONFIGURABLE per tenant** — `SELF_SERVICE_ADDON_SKUS` is a hardcoded two-entry array                                                                                                         |
| Currency and tax treatment                                                                                                                                | **NOT CONFIGURABLE** — "usd" hardcoded; no tax field anywhere in the billing schema                                                                                                                |
| A per-tenant subscription discount                                                                                                                        | Field (`TenantSubscription.discount`) exists but **no code path writes it** — not configurable in practice today                                                                                   |

## Gaps for a great UX

| Severity | Gap                                                                                                                                                                                 | Impact                                                                                                                                                                                          | Suggested direction                                                                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | An expired-trial tenant cannot subscribe through the UI — `/billing/quote` is missing from the READ_ONLY allowlist and choose-plan needs a quote to show Subscribe                  | The single most commercially important conversion is a dead end; every day of it is churn                                                                                                       | Add `/billing/quote` (and `/billing/addons/:sku/enable`) to the anchored allowlist; add a Playwright case forcing READ_ONLY through the full choose-plan → subscribe path                                                    |
| CRITICAL | Every plan change goes through `subscribe()` because `useUpgrade`/`useDowngrade` have zero call sites                                                                               | An ACTIVE payer moving tiers is charged a full non-prorated cycle, their renewal date silently moves, and a downgrade takes effect instantly instead of at period end (bug B58, open)           | Branch on plan rank in `commit()`: higher → `useUpgrade`, lower → `useDowngrade`, reserve `useSubscribe` for TRIAL/READ_ONLY/CANCELLED re-entry                                                                              |
| CRITICAL | The OCR add-on may be ungrantable if the live catalog is v11, which retired `OCR_PACK_250` while four endpoints still bridge "ocr" to that SKU                                      | The AI document-scanning toggle 400s and all four scan endpoints 403 for every tenant, with no way to turn them on                                                                              | Either restore the SKU with a real cap check (wiring PLAN-M7/PLAN-N16 together) or drop the legacy-key bridge for "ocr"; add a boot-time assertion that every bridged key resolves to a SKU present in the published catalog |
| CRITICAL | The public pricing page hardcodes stale tiers/prices/limits instead of calling the catalog endpoint built for it                                                                    | Prospects are quoted prices RouteFlow doesn't charge; a signup lands on a higher price than advertised, and every catalog change silently widens the gap                                        | Render marketing tiers from `GET /billing/plans` with a static fallback; add a CI check that no monetary literal in the marketing app duplicates a catalog price                                                             |
| CRITICAL | The admin plan picker is hardcoded to a stale three-plan list and cannot assign GROWTH or SCALE, and the entitlements inspector has no UI caller at all                             | Admins cannot put a tenant on two of the four live plans, and cannot see what a tenant actually resolves to without reading the database directly                                               | Update the plan picker to the live four-plan set; mount the entitlements inspector on the admin tenant page                                                                                                                  |
| HIGH     | Four of five meters have no enforcement, and the SCANS billing meter specifically has no writer even though a working AI-cost ledger exists right next to it                        | The plan ladder's headline differentiators are decoration; a Starter tenant can run a much larger operation than the price implies, and scan-heavy tenants are systematically under-recommended | Wire `AiUsageEvent` writes to also call `meter.increment(..., "SCANS", ...)`; add the SEATS gate at user-create using the CUSTOMERS grace pattern                                                                            |
| HIGH     | `InlineResolveModal` and `GraceBanner` are built but never rendered, and grace state isn't exposed by any endpoint                                                                  | Every purchasable-entitlement denial degrades to a toast or a locked page; the grace window is invisible until it expires and a create suddenly fails, reading as a bug                         | Expose grace fields on `GET /billing/subscription`, mount `GraceBanner`, route `INLINE_RESOLVE` gates through the modal with the already-built proration-preview hook                                                        |
| HIGH     | A tenant can subscribe without ever entering a card — checkout, portal and card-update are all SUPER_ADMIN-only, and no `RfInvoice` is ever written                                 | The state machine and the money are only loosely coupled; a tenant can be marked ACTIVE with no Stripe subscription behind it, and dunning's only instruction is "contact support"              | Expose a tenant-scoped checkout/portal route; write `RfInvoice` on `invoice.payment_succeeded` so receipts can be listed                                                                                                     |
| HIGH     | Two addon namespaces overlap — `AddonGuard` matches the raw `addonKey` while `SubscriptionMutationService` writes the SKU code as the key, keyed uniquely on `(tenantId, addonKey)` | The same entitlement can exist under two rows that neither system sees, causing possible double-counted MRR or a granted-but-still-gated capability                                             | Resolve `AddonGuard` through the canonical SKU with the legacy key as an alias; add a boot assertion that no tenant holds both forms                                                                                         |
| MEDIUM   | Cancelling strips all active add-ons including admin-granted dark SKUs, with no restore path on reactivation                                                                        | A tenant who cancels and returns silently loses their compliance pack, commission engine and MSRP surfaces                                                                                      | Record deactivated dark SKUs on the cancel event for restoration, or exempt zero-priced SKUs from the sweep                                                                                                                  |
| MEDIUM   | The admin plan editor bypasses draft/publish entirely, mutating the published catalog in place with no review step                                                                  | Price history is destroyed rather than versioned, and an admin can reprice production with one click                                                                                            | Point the admin UI at the draft lifecycle; keep the in-place patch as an explicitly labelled break-glass action                                                                                                              |
| MEDIUM   | No tenant sees plan-change consequences or add-on charges before confirming                                                                                                         | Downgrades are committed blind and add-on charges land as a post-hoc toast, generating refund requests                                                                                          | Add a confirm step built from data that already exists (flag diff, recommendation over-by deltas, proration preview)                                                                                                         |
| MEDIUM   | MRR ledger drift (`ledgerMrr` vs `mrr`) is computed but never surfaced anywhere a human looks                                                                                       | The two numbers that should check each other silently disagree, so neither can be trusted for a board figure                                                                                    | Render `                                                                                                                                                                                                                     | ledgerMrr − mrr | `on the admin billing page against a threshold; close remaining`transitionAndEmit` gaps |
| MEDIUM   | Add-on disable trusts a failed Stripe call and destroys the reconciliation pointer in the same write (bug B107, open)                                                               | The entitlement is revoked while the Stripe charge survives, discoverable only by manual reconciliation                                                                                         | On a Stripe failure, fail the request or persist a `needsStripeReconciliation` flag with the retained `stripeItemId`                                                                                                         |
| MEDIUM   | Mobile has no billing surface at all, despite being the primary operator surface                                                                                                    | An operator on a phone hits a 403 with no path forward until they find a laptop                                                                                                                 | Mirror the read-only half at minimum: current plan, usage bars, and a gate screen that deep-links to the web chooser                                                                                                         |
| MEDIUM   | The plan-flag kill switch is one global env var covering seven flags for every tenant at once                                                                                       | Enforcement cannot roll out gradually; it will likely stay off indefinitely, leaving most gates decorative                                                                                      | Replace the env boolean with a per-tenant enforcement date or allowlist                                                                                                                                                      |
| LOW      | The addon-vocabulary comment block is hand-maintained prose with no test tying it to the actual decorators, and its own SKU count is already wrong                                  | The single source of truth for the domain's vocabulary drifts unchecked                                                                                                                         | Add a reflection-based spec asserting the flags carried by `@RequirePlanFlag` across controllers match the documented enforced list                                                                                          |
| LOW      | The Cancel button fires with no confirmation dialog                                                                                                                                 | A misclick schedules the end of paid access with no stated end date or explanation of read-only                                                                                                 | Add a confirmation naming the exact period-end date and stating the cancellation is reversible until then                                                                                                                    |

## Cross-domain handoffs

- **Auth → Entitlements**: `AuthService` embeds a compact entitlement snapshot in the JWT at
  login, refresh and impersonation via `EntitlementsService.claimsFor`, which swallows exceptions
  so entitlements never block a login. The claim is for client rendering only — every guard
  re-resolves from the database.
- **Entitlements → Orders**: `flag.credit_limits` gates the credit-limit check itself, not
  customer CRUD — turning the flag on must never retroactively reject in-flight orders.
- **Entitlements → Customers**: the CUSTOMERS meter is the only enforced soft cap; bulk/CSV
  import must call the same cap-assertion pair as single create rather than re-implement it.
  `flag.pricing_tiers` additionally gates the customer price-tier handlers.
- **Entitlements → Finance** (bookkeeping, vendor bills, analytics, inventory): `flag.reports`,
  `flag.ap_bills`, `flag.analytics` and `flag.forecasting` gate their respective modules — all
  inside the global `PLAN_FLAG_ENFORCEMENT` kill switch.
- **Entitlements → AI/OCR**: the four document-scanning endpoints are gated by
  `@RequireAddon("ocr")`; the SCANS billing meter has no writer even though the separate
  `AiUsageEvent` cost ledger already records every call — these two systems need to be joined.
- **Entitlements → Sales agents & commissions**: `flag.sales_agents` gates the controllers, and
  the commission engine re-checks it per write while the reconciliation cron skips unflagged
  tenants — revoking the flag stops accrual rather than corrupting existing data.
- **Entitlements → Dispatch**: routes/route-runs/drivers/route-optimization/trips are addon-gated
  on an any-of set; every web and mobile query hitting those endpoints must carry `enabled:` on
  the matching access hook or it fires requests it knows will 403.
- **Entitlements → Regulated/compliance**: `@RequireAddon("tobacco_dealer")` gates the regulated
  and tobacco controllers, bridged to the `REGULATED_ITEMS` SKU.
- **Billing ↔ Users/Seats**: the SEATS meter counts active TENANT_ADMIN/OPERATOR/DRIVER users;
  the downgrade cron deactivates non-retained OPERATOR/DRIVER to fit a new cap — the only place
  billing writes into the identity domain, and it never touches a TENANT_ADMIN.
- **Billing → Messaging**: `MessagingService` increments the MSGS meter on send — the only
  production billing-meter writer that currently exists.
- **Billing → Tenant lifecycle**: `BillingCronService`/`BillingService` write `Tenant.status` and
  must invalidate both the entitlement cache and `TenantStatusGuard`'s status cache;
  `TenantStatusGuard` is the global APP_GUARD that turns those statuses into request behaviour.
- **Billing → Email**: the failed-payment notification is best-effort — an email failure must
  never fail the webhook.
- **Billing ↔ Stripe**: catalog prices are pushed to Stripe as inline price data, never pulled.
  Five webhook types drive status and period dates; the signature-verified webhook is the only
  unauthenticated route in the module.
- **Billing ↔ Stripe Connect**: a separate Stripe integration (buyer-payment acceptance for the
  tenant's own customers) lives alongside this platform-billing Stripe account — the two must
  stay clearly distinguished in code and docs, the same confusion `flag.settlement` already
  carries.
- **Platform-admin → Billing**: plan changes, status flips, trial extensions, external
  activations, price overrides and add-on toggles must all emit the matching signed
  `BillingEvent`, or the MRR ledger drifts from the snapshot rollup; every such action also
  writes an AdminAudit row.
- **Entitlements → Web/mobile navigation**: `GET /tenants/me/addons` is read by web and mobile to
  hide nav items, tabs and command-palette actions. A gate that can strand a user must key off
  `resolved` and fail open; hiding-only gates may read `enabled` directly.

## What we could not verify

- Which `PlanVersion` is actually PUBLISHED in production. Four publish scripts exist (v8–v11),
  none runs automatically, and the choice decides whether the OCR add-on is currently grantable
  and whether the tenant-facing add-on list has 5 SKUs or 10.
- The runtime value of `PLAN_FLAG_ENFORCEMENT` on Railway — if unset (the default), seven of the
  eleven plan gates are silently allowing everything right now.
- Whether any live tenant currently holds a `TenantAddon` row for a retired SKU, or holds both a
  legacy key and its bridged SKU under the overlapping namespaces described above.
- The Stripe account state — whether tenants have real subscriptions behind their RouteFlow plan
  rows, and how far `ledgerMrr` and `mrr` actually diverge in practice.
- The full contents of `billing.module.ts`, `stripe.service.ts` and the billing `dto/` folder
  were not read in the source analysis; several "zero call sites" and "no writer" claims come
  from repo-wide greps rather than a full read, and spec files were identified by name only, so
  some test criteria above may duplicate assertions that already exist.
- B58 (Critical, open) and B107 (High, open) are quoted from the existing bug register, not
  independently re-verified end to end in this pass.
