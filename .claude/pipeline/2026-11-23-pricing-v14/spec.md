# Spec: pricing v14, feature-based plans (Phases 2 and 3)

Status: **PROPOSED, for the Senior Architect to rule on.** Nothing in this spec is built. Phase 2 starts
only after the architect re-rules SA-1204 into this programme, after the 2026-11-28 demo.
Date 2026-11-24 · base `d977b00d4b` · Tier 1 (billing): architect ruling first, then two Opus PASSes at the
exact sha on review board #4456. Plan: [plan.md](plan.md).

Owner sources: the owner's deck of 2026-11-23 and the corrections of 2026-11-24 (both in `local-assets/`,
never committed). The decisions with dates: [`docs/product/billing-plans.md`](../../../docs/product/billing-plans.md),
"Pricing v14". Why: [ADR 0005](../../../docs/adr/0005-feature-based-plans.md). Facts about today's code:
[`docs/product/claims-register.md`](../../../docs/product/claims-register.md).

## 1. Why

Today's plans (v13) differ only by customers included, and every plan has every feature. The owner
decided on feature-based plans: Essentials $99, Growth $199 and Pro $349, with no customer or user
limit. Prices then follow features, and a price can rise when a named feature ships
(`docs/product/pricing-roadmap.md`).

If we ship nothing, the public page keeps selling customer tiers, and no feature can move a price.
The "every plan includes" promise also stays kept by a kill switch rather than by the catalog (claims
register, section B).

Success signal: a v14 catalog is published, and the ladder spec is green on it. A new account can buy
Essentials, Growth or Pro and pays before the plan goes active. Every paying v13 account sees no change
in features or price for 12 months.

## 2. What exists (at `d977b00d4b`)

| Thing | Where | Note |
| --- | --- | --- |
| Catalog on sale, v13 | `apps/api/prisma/plan-catalog-v13.definitions.ts:30` | v12 with LITE gaining `flag.returns` |
| Plan rows: STARTER $99 / 100, GROWTH $249 / 250, SCALE $499 / 500, ENTERPRISE custom | `apps/api/prisma/plan-catalog-v11.definitions.ts:90-136` | Carried forward unchanged into v13 |
| LITE $99, 100 customers, `seatsIncluded: 3` | `apps/api/prisma/plan-catalog-v12.definitions.ts:31-43` | Invite-only. Always enforced (`apps/api/src/billing/plan-catalog.constants.ts:39`) |
| Add-on SKUs: REGULATED_ITEMS $39, FORECASTING $19, CUSTOMER_PACK_100 $50, MSRP $0, SALES_AGENTS $0 | `plan-catalog-v11.definitions.ts:149-208` | |
| Enum values CORE and ALL_IN, unused | `apps/api/prisma/schema/tenancy.prisma:31-32`; `packages/types/api/enums.ts:747-748` | PR #4401, applied in production 2026-11-21 |
| Tenant pin to a PlanVersion | `apps/api/prisma/schema/tenancy.prisma:94` (`planVersionId`) | Flags gain forward from the published version (`plan-catalog.constants.ts:259`) |
| Add-on price pin | `apps/api/prisma/schema/platform.prisma:120` (`TenantAddon.priceSnapshot`) | |
| Add-on inclusion by plan rank | `plan-catalog.constants.ts:173` (`includedAtPlan`, "at AND ABOVE") | One rank ladder for all plan keys |
| Yearly = ten months | `apps/api/src/billing/billing-math.ts`; `annual-price-derivation.pin.spec.ts` | |
| Gates and their states | claims register, section C | Every Growth-only gate is dark |
| Kill switch and safety lists | `apps/api/src/billing/plan-flag-policy.ts:13`, `:37` | Retirement is D-18 (issue #1823) |
| Card-first check, off | `apps/api/src/billing/subscription-mutation.service.ts:426`; `card-first-flag.service.ts:25` | A plan pick goes active at `:883` with no payment |
| Store portal invite and disconnect | `apps/api/src/customers/customers.controller.ts:428`, `:448` | Behind `addon.buyer_portal`; no count |
| Regulated stop block | `apps/api/src/common/regulated-delivery.ts:146-195` | Needs a signature and an age or ID check |

## 3. What to build (requirements)

Phase 2: catalog and billing.

- **R1. New catalog version v14.** Add `plan-catalog-v14.definitions.ts` and `publish-plan-catalog-v14.ts`,
  following v13. Never amend v13 or earlier. The publisher refuses if the published version is not
  v13 (the same guard as `diffPublishedAgainstV12`, `plan-catalog-v13.definitions.ts:140`).
- **R2. Plan keys.** Essentials is `CORE`, and Pro is `ALL_IN`. The new $199 Growth gets a new key, for
  example `GROWTH_V14` (the architect names it). It is never `GROWTH`. Each key needs an additive
  migration and an `enum-parity.spec.ts` row. v14 keeps STARTER, GROWTH and SCALE rows so that pinned
  accounts resolve, but marks them not for sale.
- **R3. Old Growth never sees new Growth as its own plan.** The plan picker, the billing page and every
  email show a pinned `GROWTH` account its own plan ($249, 250 customers) under a name that cannot be
  taken for the $199 plan. A test pins this: a `GROWTH` account's billing page never shows $199 as its
  current plan.
- **R4. Flags.** Map the split onto existing flags first:
  - Essentials gets `flag.returns`, `flag.credit_notes`, `flag.suppliers`, `flag.reports`,
    `flag.pricing_tiers` and `flag.credit_limits`, plus a store-ordering flag with a cap of 25.
  - Growth adds `flag.estimates`, `flag.recurring_invoices`, `flag.messaging`, `flag.ap_bills`,
    `flag.analytics` and `addon.ocr`.
  - New flags only where none fits.
  - Every new flag ships in `DARK_PLAN_FLAGS`, and every new `@RequireAddon` key ships `dark` in
    `feature-registry.ts`.
  - Enforcement is a separate diff, after the owner runs `report-addon-gate-blast-radius.mjs` against
    production.
- **R5. Caps in the data.**
  - `customersIncluded` is null on all three plans.
  - `seatsIncluded` is null.
  - `scansIncluded` is null, so scans are unmetered at launch.
  - `routesConcurrent` is null.
  - `msgsIncluded` is null.
  - The 25-store allowance is a new cap field, not `customersIncluded`.
- **R6. Add-on SKUs.**
  - Every store online: $79 on Essentials, included in Growth and Pro.
  - `REGULATED_ITEMS` at $79 for new accounts.
  - `SALES_AGENTS` at $29 for new accounts.
  - `FORECASTING` stays at $19.
  - A delivery SKU at $0 that stores its scheduled $49 price and the notice date next to it.
  - An AI scan pack that exists but is not sold, offered on Growth and Pro only.
  - Stop selling `CUSTOMER_PACK_100` to new accounts.
  - A recurring add-on paid yearly costs ten months' price.
  - The spec for R6 says how a mid-year add-on is prorated, using the existing proration service.
- **R7. Pro includes** filings, delivery, commissions and forecasting through the inclusion mechanism.
  The rank ladder needs the three new keys placed: Essentials below Growth below Pro, and the old
  keys where they sit today. Guided move-in is a one-time service, included only for Pro paid yearly.
- **R8. Ladder spec** in `apps/api/src/billing/` reads the v14 definitions and fails when:
  - any recurring add-on costs as much as the plan step above a plan it is sold on;
  - Pro is not below Growth plus the add-ons Pro includes, with delivery at its scheduled price;
  - Growth minus (Essentials plus the store add-on) is outside $1 to $25.

  It is red-first on each wrong value.
- **R9. Store-ordering allowance.**
  - A store counts once it is approved for ordering, and stops counting when its access is removed.
  - The 26th approval is blocked, and the first 25 keep working.
  - The block shows both ways forward with prices from the catalog.
  - A plan change never cuts off a store that is already ordering without the downgrade confirmation (R12).
- **R10. Customer caps** leave the v14 plans. A fair-use sentence goes in the terms draft for legal
  review. No enforcement.
- **R11. Trial.**
  - The trial is 14 days on Pro, with no card.
  - At the end, the account picks a plan.
  - Picking a lower plan keeps all data, and the features above that plan become read-only.
  - Picking nothing makes the account read-only, with data kept.
- **R12. Moving down.**
  - The confirm step lists every feature that stops.
  - It names store ordering with the number of stores affected.
  - It states that data stays.
- **R13. Upgrade nudge.**
  - When plan plus add-ons costs as much as or more than the next plan, say so with both numbers.
  - Otherwise say nothing.
  - The arithmetic goes through `@routeflow/pricing`.
- **R14. Card checkout first.** Payment comes before a self-serve plan goes active (claims register A12).
  Nothing in v14 is sold self-serve until this is live.
- **R15. Existing accounts.**
  - Each stays pinned to its version and add-on prices.
  - A read-only report script, dry-run by default, lists every paying account with: its pinned
    version, the end date of its 12-month protection, and what it would pay under v14.
  - The protection end date needs a home. Today there is none.
- **R16. Founding accounts.** A per-account marker carries the 24-month lock and the free move-in.
  There is none today.
- **R17. LITE to Essentials.**
  - LITE is retired for new accounts.
  - Its accounts move to Essentials at the same $99 by re-pinning to v14 `CORE`. LITE is not
    redefined.
  - No LITE account loses a flag: the census in R15 proves it.
  - This folds in roadmap F-12 and F-13.
- **R18. Pricing page.** The public page moves to v14 only when v14 is on sale. The static pin test
  moves its `ON_SALE_VERSION` in the same PR. The new site's pricing is one line with no table.

Phase 3: missing features, in order.

- **R19. Drivers complete a regulated stop.** Scope why the block exists: a signature and an age or ID
  check (`regulated-delivery.ts:86-93`). Then scope a web capture for both. This must ship before Pro
  is sold to tobacco wholesalers with vans. Until then, every place Pro is described to them says so.
- **R20. Guided move-in** becomes a bookable one-time service (builds on F-11).
- **R21. Pro extras** (own mailbox F-10, statement matching, margin warnings, priority support) are
  documented in `pricing-roadmap.md`. None goes on a public page before its register row is `live`.
- **R22. Small sale helpers** (QuickBooks-ready CSV, credit limits on new orders with an override, a
  store invite kit, the demo tenant refresh F-14, a review prompt built switched off) are scoped one
  paragraph each. Only what the owner picks is built.

## 4. Out of scope

- The rename. No new brand name in any file.
- F-18 and F-20 themselves; they get scoping notes only (`pricing-roadmap.md`).
- Flipping any gate from dark to enforced.
- Any change to a published PlanVersion row.

## 5. Tests that prove it

| Req | Test | Red on |
| --- | --- | --- |
| R1 | `plan-catalog-v14.spec.ts`: v14 rows deep-equal the definitions; the publisher refuses on a non-v13 base | a v13 row edited in place |
| R2, R3 | enum parity row; billing page test for a pinned `GROWTH` account | $199 shown as the old Growth account's plan |
| R4 | registry census: every new flag is in `DARK_PLAN_FLAGS`, every new add-on key is `dark` | a new gate shipped enforced |
| R5 | v14 caps are null where the copy says "no limit" | a v14 plan with a customer cap |
| R8 | the ladder spec, three checks | delivery at $0 in check 2; Growth at $230 |
| R9 | the 26th approval is refused; a removed store frees a slot | the 26th approval passes |
| R13 | nudge fires at $356 against $349 and stays silent at $278 | a nudge at $278 |
| R14 | a self-serve pick without a payment stays not active | ACTIVE before payment |
| R15 | the report is read-only and lists the protection end date | any write |
| R17 | every LITE account's v14 flags are a superset of its v13 flags | a LITE account losing a flag |
| R18 | `site-pricing-catalog.static.test.ts` (Phase 1) follows `ON_SALE_VERSION` | the page shows a price the catalog on sale does not sell |

## Design Gate (Full) — pricing-v14 Phases 2-3 · 2026-11-24 · base d977b00d4b

### G1 Fit
- Program / train: pricing v14 (owner 2026-11-23, corrections 2026-11-24); re-rules SA-1204; folds F-12 and F-13.
- Exists today: `apps/api/prisma/plan-catalog-v13.definitions.ts:30`, `apps/api/src/billing/feature-registry.ts:153`, `apps/api/src/billing/plan-flag-policy.ts:13`, `apps/api/src/billing/plan-catalog.constants.ts:173`, `apps/api/prisma/schema/tenancy.prisma:94`, `apps/api/prisma/schema/platform.prisma:120`.
- Decision: extend the plans-as-data catalog with a new version; the one source of truth is the published PlanVersion plus `feature-registry.ts`; no parallel plan system.
- Facts: v13 carries v11's plan rows (`plan-catalog-v13.definitions.ts:30`, `plan-catalog-v12.definitions.ts:62-69`); CORE and ALL_IN exist and are unused (`tenancy.prisma:31-32`); seats are never enforced (`apps/api/src/billing/entitlements.service.ts:279`); card-first is off (`subscription-mutation.service.ts:426`); `PLAN_FLAG_ENFORCEMENT` was deleted in production on 2026-09-17 (bug record B473).

### Area sweep
| Source | Query run | Open ids in this area | Fixed here (own commit + red test) | Deferred (row + reason) |
| --- | --- | --- | --- | --- |
| Bug registry | `grep '"register":"open"' .claude/campaign/bugs.jsonl \| grep -iE 'plan-catalog\|plan flag\|plan-flag\|entitlement\|addon\|add-on\|pricing page\|billing'` (95 hits) | B217, B327, B410, B446, B474, B552, B554 and others in the 95 | none (spec only) | the architect assigns each to a Phase 2 PR or a row at ruling; B554 (self-serve enableAddon has no requires check) belongs with R6 |
| Tracker issues | `gh issue list --state open --limit 200 --search "plan catalog OR pricing OR plan flag"` (47) | #1823 (D-18), #1378 (F-12), #1676 (B474), #2708, #1928 | none | #1823 stays open until a plan-flag registry lands (CLAUDE.md); #2708 goes with R4 |
| ACTION-ITEMS | `grep -n -iE 'plan flag\|pricing\|billing' .claude/handoffs/ACTION-ITEMS.md` (file not present at this base) | none | none | n/a, file absent |
| Review nits | `ls local-assets/specs/ \| grep -iE 'pric\|billing\|plan'` (no hits) | none | none | none |
- Chunk: billing only; about 18 requirements; split into the PRs in plan.md by sub-area (catalog, gates, caps, checkout, nudge, migration report).

### G2 Variation map
| Axis | How it differs there (one line) | Mark | Seam in this change (SEAM NOW only) |
| --- | --- | --- | --- |
| Wholesaler / distributor | the main buyer; store ordering and filings decide the plan | BUILD NOW | - |
| Jobber | small reseller, likely Essentials plus one add-on; the ladder rule protects it | BUILD NOW | - |
| Retail POS counter | counter sales free on every plan; no plan gate | n/a, counter is a capability, not a plan feature | - |
| Delivery / route | delivery free in early access, scheduled $49 later | SEAM NOW | delivery SKU stores scheduled price and notice date beside the $0 price |
| Mixed | same as wholesaler; no plan difference | n/a, no plan rule differs for mixed accounts | - |
| Super admin | pins, custom prices, founding marker, protection end dates, comps | SEAM NOW | per-account protection end and founding marker fields read by the report |
| Single store / 1 user | no user limit; zero-config defaults | BUILD NOW | - |
| Small team | no user limit | BUILD NOW | - |
| Multi-branch / multi-warehouse | not in the product; F-20 would add a $49 add-on | LATER | - |
| High volume | no customer cap; fair-use line only | LATER | - |
- Surfaces & roles: web operator billing page and plan picker; mobile mirrors web; store portal is untouched except the store-count block at approval; super admin sees pins, protection dates and the founding marker.
- Capability read: entitlements from the pinned PlanVersion plus flags-gain-forward, never the `plan` enum (`tenancy.prisma:92-94`).
- Dark launch: every new flag in `DARK_PLAN_FLAGS`, every new add-on key `dark`; the owner flips each in a separate diff after the blast-radius report; removed with D-18.

### G3 Replace-later
| Planned program touching this area | Would it replace or rework this? | Answer |
| --- | --- | --- |
| D-18 retire the dark-flag safety lists (#1823) | yes, it removes `DARK_PLAN_FLAGS` | no conflict: new flags join the list and leave with it |
| F-18 QuickBooks sync, F-20 multi-warehouse | each adds a $49 add-on and moves Pro to $449 | seam: one catalog value per price plus the ladder spec, so a move is a new version and one line |
| The rename | display names change | no conflict: names are catalog data |
- Interim: the pricing page stays on v13 until v14 is on sale; the static pin test holds it there.

### G4 Class, not instance
- Class: every public price and plan fact must come from the catalog on sale.
- Inventory: `prices.js` plus every `data-plan`/`data-addon` span in `apps/web/public/site/*.html` (pricing 26, home 19, product 6 at the base sha).
- One helper: `apps/web/public/site/js/prices.js` on the site; `plan-catalog-v14.definitions.ts` in the API.
- Pin: `site-pricing-catalog.static.test.ts` (Phase 1) and the ladder spec (R8); neither has a fail-open default.
- Red-first: ladder check 2 with delivery at $0 is red ($326 < $349), at $49 green ($375 > $349); the page pin is red when `prices.js` says Growth $199 while v13 is on sale.

### G5 Data & time
- Schema: additive only. One enum value for the new Growth key; a store-ordering cap column on PlanDefinition; per-tenant protection end and founding marker; a scheduled-price and notice-date pair on AddonSku. All go in one sitting folder, with a fresh backup and `prod-migrate.mjs`.
- Snapshot vs live: the tenant pins its PlanVersion and `TenantAddon.priceSnapshot`; flags gain forward; prices never gain forward.
- Authority & time: the server derives caps and inclusion from the pinned version; a scheduled add-on price applies only after its notice date and only for accounts not under protection.
- Old shape → new: v13 accounts stay pinned; LITE accounts re-pin to `CORE` after the census proves no flag is lost; old Growth keeps `GROWTH`; dual-read is not needed because keys differ.
- Money: `@routeflow/pricing` (`roundMoney`) for every price and nudge sum; yearly through `annualPrice`.

### G6 Scale
- Queries: the store count is one indexed count per tenant at approval time; the report script pages tenants.
- Limits: 25 stores on Essentials, one catalog field; no other cap.
- UI at 10 and 10,000: the downgrade confirm shows a count and a paged list of affected stores, never a fetch-all.

### G7 UX lens
- Flow: one primary action per state: at the 26th store, "Add every store online, $79" or "Move to Growth, $199"; the nudge appears only when the numbers say so.
- Feature parity: no paying account loses a screen during its protection; the billing page keeps every current row.
- Placement sign-off: apple-ux agrees because the block appears where the store is approved, not later; apple-design agrees because no motion or layout change is planned.

### G8 Change-friendliness
- Config over code: prices, caps and inclusion are catalog rows; gates are registry rows.
- Shared contract: new plan keys in `packages/types/api/enums.ts`, pinned by `apps/api/src/common/enum-parity.spec.ts`.
- Flags: each new flag leaves `DARK_PLAN_FLAGS` when its enforcement diff lands, and the list goes with D-18.
- Code map: `.claude/code-map/` billing area names the v14 catalog and the ladder spec.
- Future requirement → expected diff size:
  - Pro moves to $449 when F-18 and F-20 are live → S (a new catalog version with one changed value)
  - Delivery's early access ends → XS (the scheduled price already stored)
  - A new add-on → S (one SKU row and one registry row)

### G9 Cost & stop
- Quick fix: editing `prices.js` to show the new plans would be faster, but it would sell plans the catalog does not have; the catalog-first shape is right.
- YAGNI: per-seat pricing, usage metering for scans and a customer-count fair-use enforcer were cut.
- Review-round signal: n/a, no review rounds yet.

### G10 Owner questions
- Recommended first: the internal key for the new Growth (`GROWTH_V14`), or let the architect name it.
- When does early access for delivery end (starts the 6-month notice)?
- Trial end with no pick: read-only (recommended) or drop to Essentials?
