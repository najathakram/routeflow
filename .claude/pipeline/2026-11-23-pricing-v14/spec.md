# Spec: pricing v14, feature-based plans (Phases 2 and 3)

Status: **PROPOSED, for the Full architect panel.** SA-1254 (2026-11-24, Quick panel) ruled the fold
of SA-1204 into this programme, the plan keys, the conditions V1-V12, the tier and the PR order. This
spec follows that ruling. The code shape of Phases 2-3 gets a **Full** panel on this spec before any
Phase 2 code. Nothing here is built, and nothing starts before the 2026-11-28 demo.
Date 2026-11-24 · base `d977b00d4b` · Tier 1 (billing) for every code PR: two Opus PASSes at the exact
merging sha on review board #4456. Docs-only PRs are Tier 2. Plan: [plan.md](plan.md).

Owner sources: the owner's deck of 2026-11-23, the corrections of 2026-11-24, and the owner's answers to
SA-1254's four questions (all in `local-assets/`, never committed). The decisions with dates:
[`docs/product/billing-plans.md`](../../../docs/product/billing-plans.md), "Pricing v14". Why:
[ADR 0005](../../../docs/adr/0005-feature-based-plans.md). Facts about today's code:
[`docs/product/claims-register.md`](../../../docs/product/claims-register.md).

## 1. Why

Today's plans (v13) differ only by customers included, and every plan has every feature. The owner
decided on feature-based plans: Essentials $99, Growth $199 and Pro $349, with no customer or user
limit. Prices then follow features, and a price can rise when a named feature ships
(`docs/product/pricing-roadmap.md`).

If we ship nothing, the public page keeps selling customer tiers, and no feature can move a price.
The "every plan includes" promise also stays kept by a kill switch rather than by the catalog (claims
register, section B; the owner's reading of the production value is pending).

Success signal: a v14 catalog is published, and the ladder spec is green on it. A new account can buy
Essentials, Growth or Pro and pays before the plan goes active. Every paying v13 account sees no change
in features or price for 12 months from the v14 publish day.

## 2. What exists (at `d977b00d4b`)

| Thing | Where | Note |
| --- | --- | --- |
| Catalog on sale, v13 | `apps/api/prisma/plan-catalog-v13.definitions.ts:30` | v12 with LITE gaining `flag.returns` |
| Plan rows: STARTER $99 / 100, GROWTH $249 / 250, SCALE $499 / 500, ENTERPRISE custom | `apps/api/prisma/plan-catalog-v11.definitions.ts:90-136` | Carried forward unchanged into v13 |
| LITE $99, 100 customers, `seatsIncluded: 3` | `apps/api/prisma/plan-catalog-v12.definitions.ts:31-43` | Invite-only. Always enforced (`apps/api/src/billing/plan-catalog.constants.ts:39`) |
| Add-on SKUs: REGULATED_ITEMS $39, FORECASTING $19 (both `includedAtPlan: "SCALE"`), CUSTOMER_PACK_100 $50, MSRP $0, SALES_AGENTS $0 | `plan-catalog-v11.definitions.ts:149-208` | |
| Enum `TenantPlan { STARTER TEAM BUSINESS PROFESSIONAL ENTERPRISE GROWTH SCALE LITE CORE ALL_IN }` | `apps/api/prisma/schema/tenancy.prisma:22-33` | CORE and ALL_IN from #4401, applied in production, never written (SA-1254 F1-F2) |
| `PLAN_KEYS` order pin and `planRank` | `plan-catalog.constants.ts:21`, `:157-184` | `isAddonIncludedAtPlan` reads `have >= need` on that rank (F3) |
| `planKeyToEnum`: GROWTH→TEAM, SCALE→BUSINESS, unknown throws | `plan-catalog.constants.ts:462-481` | Live $249 Growth rows hold TEAM; CORE and ALL_IN throw (F4) |
| `planKeyFromEnum` has no CORE or ALL_IN case, default STARTER | `plan-catalog.constants.ts:362-386`; `platform-pricing.service.ts:107` | A new key without an enum value reads back as STARTER (F5) |
| Add-on quote falls back to the published SKU when the pinned version lacks it | `apps/api/src/billing/proration.service.ts:160-162` | A pinned account could be quoted a v14 price (F6) |
| Customer errors print the raw plan key | `subscription-mutation.service.ts:510-526` | F7 |
| Plan picker copy rests on customer caps | `apps/web/app/(dashboard)/choose-plan/page.tsx:186`; `choose-plan/page.test.tsx:80-82` | "Start small. Add customers as you grow." and "Fits your usage" (F8) |
| PlanDefinition and PlanVersion rows | `apps/api/prisma/schema/platform.prisma:285-323` | PlanVersion rows are immutable (F9) |
| No protection end date on a subscription | `platform.prisma:38-87` (TenantSubscription) | F10 |
| Tenant pin to a PlanVersion | `tenancy.prisma:94` (`planVersionId`) | Flags gain forward from the published version (`plan-catalog.constants.ts:259`) |
| Add-on price pin | `platform.prisma:120` (`TenantAddon.priceSnapshot`) | |
| Yearly = ten months | `apps/api/src/billing/billing-math.ts`; `annual-price-derivation.pin.spec.ts` | |
| Gates and their states | claims register, section C | Every Growth-only gate is dark |
| Kill switch and safety lists | `apps/api/src/billing/plan-flag-policy.ts:13`, `:37` | Retirement is D-18 (issue #1823) |
| Card-first check, off | `subscription-mutation.service.ts:426`; `card-first-flag.service.ts:25` | A plan pick goes active at `:883` with no payment |
| Store portal invite and disconnect | `apps/api/src/customers/customers.controller.ts:428`, `:448` | Behind `addon.buyer_portal`; no count |
| Regulated stop block | `apps/api/src/common/regulated-delivery.ts:146-195` | Needs a signature and an age or ID check |

## 3. Binding rulings (SA-1254)

**Keys.**

- Essentials is `CORE` and Pro is `ALL_IN`, both reused from #4401. No new enum value for them.
- The new $199 Growth is **`PLUS`**: a new additive TenantPlan value and planKey `"PLUS"`, shown as
  "Growth" to new sign-ups. TEAM is vetoed (live $249 rows hold it), as is any planKey with no enum
  value (it reads back as STARTER). `GROWTH_V14` is rejected, because the version belongs in
  PlanVersion.
- `GROWTH` stays the $249 plan with its 250-customer cap, for existing accounts only. It is never for
  sale in v14.
- **Rank C1':** `[LITE, STARTER, CORE, PLUS, GROWTH, ALL_IN, SCALE, ENTERPRISE]` ($99, $99, $99, $199,
  $249, $349, $499, custom). Tie rule among the three $99 keys: a move up the array is an upgrade that
  takes effect now at $0 difference; a move down takes effect at period end.

**Carried from SA-1204:** C2 and C2b (identity maps; one JS mirror), C4 (existing payers stay pinned),
C5 (no hard-coded sign-up key), C7 (a trial started before the publish keeps what it had until it picks
a plan), B1165 (a pre-publish gate), the read-only census and the publisher `--dry-run` that stop on any
non-trial bill change, the six-step production sequence, and SA-1204's private item, which blocks the
first paid add-on gate. **Retired:** SA-1204 C3, C6, C9-C12 and C17 (the modules model) and its PR-2..PR-6
plan.

**Conditions V1-V12** bind this spec and every PR:

| Id | Condition | Requirements |
| --- | --- | --- |
| V1 | One vocabulary: CORE, PLUS and ALL_IN identity-map both ways in `normalizePlanKey`, `planKeyFromEnum`, `planKeyToEnum` and the DTO lists, with round-trip tests. The five mirrors (TS constants, the one JS mirror, `packages/types/api/enums.ts:414`, and the script copies) keep the same **order**; a parity spec goes red on drift. Bundles the drifted audit-script copy (SA-1204 A1 F7). | R2, R3 |
| V2 | A new key is admin- or self-selectable only while the published version holds its row. | R2 |
| V3 | Every v14 add-on restates `includedAtPlan`; none is copied from v13. A matrix test covers each v14 add-on against each of the 8 keys and fails if an inclusion set is not upward-closed in C1'. | R7 |
| V4 | An account pinned before v14 is never quoted or billed a v14 add-on code its version lacks (F6). Commissions free today stays free, and filings stays $39, for the protection period. | R15 |
| V5 | Delivery's scheduled $49 is a ladder-check constant beside the $0 price in the v14 definitions, never a second price billing reads. The move to $49 is a later catalog version after the 6-month notice. | R6, R8 |
| V6 | v14 carries the legacy rows at v13 prices, not for sale; every unpinned payer is re-pinned before the publish; the census and dry run stop on any non-trial bill change; the publish waits until the web PR is deployed. | R1, R15 |
| V7 | One display-name helper. No customer text, error (F7), banner, email or Stripe product name prints a raw key; a test scans the customer copy. The PLUS Stripe product is created with its final name. | R3 |
| V8 | A pinned account always sees a "Your plan" card with its own price and protection date. Wording follows the effect ("Moves to Growth $199 on <date>"), never a bare "downgrade"; "Keep current plan" is the one-step undo. The cap-based picker copy is retired (F8). Admin labels tell the two Growths apart; CORE and ALL_IN read Essentials and Pro. | R3, R12 |
| V9 | A per-tenant protection end date and its notice date are stored before any text promises them (F10). Review and notice jobs are dry-run by default and skip a tenant with a price override. The 90-day notice is email plus an in-app banner, with owner-approved text. | R15, R16 |
| V10 | GROWTH→PLUS removes no users or caps, takes effect at period end, and lists what stops. | R12, R15 |
| V11 | New `@RequirePlanFlag` flags go in `DARK_PLAN_FLAGS`; new `@RequireAddon` keys go in `addon-gate-registry.ts` as `dark`. A flip is a separate diff after the owner's blast-radius report. | R4 |
| V12 | Money math lives in `@routeflow/pricing`: one catalog value per price, every monetary write rounded. | R6, R8, R13 |

**Owner answers to SA-1254 (2026-11-24):**

- Q2, the clock start: "One date: v14 publish day". The 12 months start for everyone on the day v14 is
  published.
- Q3, the founding lock: "Keep 24 months". The first 50 founding accounts keep the 24-month lock.
- Q4, old Growth moving itself: "Yes, at renewal". During the 12 months an old $249 Growth account may
  move itself to the $199 Growth at renewal (V10 applies).
- Q1, old Growth's name: "No one uses growth. So can change". **Open item**: the architect is
  re-ruling it, and it depends on a read-only production census of accounts on `GROWTH`. Until it is
  ruled, R3 holds: a pinned old-Growth account never sees the $199 plan as its own plan.

## 4. What to build (requirements)

Phase 2, in SA-1254's order: schema, ladder, catalog, gates, billing, web, publish, site, docs.

- **R1. New catalog version v14.** Add `plan-catalog-v14.definitions.ts` and `publish-plan-catalog-v14.ts`,
  following v13. Never amend v13 or earlier. The publisher refuses if the published version is not v13
  (the same guard as `diffPublishedAgainstV12`, `plan-catalog-v13.definitions.ts:140`). It has a
  `--dry-run` that stops on any non-trial bill change (V6). v14 carries STARTER, GROWTH, SCALE and LITE
  rows at v13 prices, not for sale, so that pinned accounts resolve.
- **R2. Plan keys.** `PLUS` is a new additive TenantPlan value, in the schema PR with an
  `enum-parity.spec.ts` row. CORE, PLUS and ALL_IN identity-map both ways (V1), and none is selectable
  before its row is published (V2).
- **R3. Display names.** One display-name helper (V7). A pinned `GROWTH` account sees its own plan ($249,
  250 customers) on a "Your plan" card with its protection date (V8), never the $199 plan as its own.
  Its plan name waits on Q1.
- **R4. Flags.** Map the split onto existing flags first:
  - Essentials gets `flag.returns`, `flag.credit_notes`, `flag.suppliers`, `flag.reports`,
    `flag.pricing_tiers` and `flag.credit_limits`, plus a store-ordering flag with a cap of 25.
  - Growth adds `flag.estimates`, `flag.recurring_invoices`, `flag.messaging`, `flag.ap_bills`,
    `flag.analytics` and `addon.ocr`.
  - New flags only where none fits. All ship dark (V11). SA-1204's private item is closed before the
    first paid add-on gate.
- **R5. Caps in the data.** `customersIncluded`, `seatsIncluded`, `scansIncluded`, `routesConcurrent`
  and `msgsIncluded` are null on CORE, PLUS and ALL_IN. The 25-store allowance is a new cap field, not
  `customersIncluded`.
- **R6. Add-on SKUs** for v14 (each restates `includedAtPlan`, V3):
  - Every store online: $79 on Essentials, included in Growth and Pro.
  - `REGULATED_ITEMS` at $79 for new accounts.
  - `SALES_AGENTS` at $29 for new accounts.
  - `FORECASTING` stays at $19.
  - Delivery at $0, with the scheduled $49 as a ladder-check constant beside it (V5).
  - An AI scan pack that exists but is not sold, offered on Growth and Pro only.
  - `CUSTOMER_PACK_100` is not sold to new accounts.
  - A recurring add-on paid yearly costs ten months' price. A mid-year add-on is prorated by the
    existing proration service.
- **R7. Ladder and inclusion.** C1' with the tie rule. Pro includes filings, delivery, commissions and
  forecasting through `includedAtPlan`, checked by the V3 matrix. Guided move-in is a one-time service,
  included only for Pro paid yearly.
- **R8. Ladder spec** in `apps/api/src/billing/` reads the v14 definitions and fails when:
  - any recurring add-on costs as much as the plan step above a plan it is sold on;
  - Pro is not below Growth plus the add-ons Pro includes, with delivery at its scheduled $49 (V5);
  - Growth minus (Essentials plus the store add-on) is outside $1 to $25.

  It is red-first on each wrong value.
- **R9. Store-ordering allowance.**
  - A store counts once it is approved for ordering, and stops counting when its access is removed.
  - The 26th approval is blocked, and the first 25 keep working.
  - The block shows both ways forward with prices from the catalog.
  - A plan change never cuts off a store that is already ordering without the moving-down confirm (R12).
- **R10. Customer caps** leave the v14 plans. A fair-use sentence goes in the terms draft for legal
  review. No enforcement.
- **R11. Trial.**
  - A new trial is 14 days on Pro, with no card. A trial started before the publish keeps what it had
    until it picks a plan (C7).
  - At the end, the account picks a plan. Picking a lower plan keeps all data, and the features above
    that plan become read-only. Picking nothing makes the account read-only, with data kept.
- **R12. Moving down.** The confirm step lists every feature that stops, names store ordering with the
  number of stores affected, and states that data stays. The wording follows the effect, and "Keep
  current plan" is the one-step undo (V8). GROWTH→PLUS follows V10.
- **R13. Upgrade nudge.** When plan plus add-ons costs as much as or more than the next plan, say so
  with both numbers; otherwise say nothing. The arithmetic goes through `@routeflow/pricing` (V12).
- **R14. Card checkout first.** Payment comes before a self-serve plan goes active (claims register A12).
  Nothing in v14 is sold self-serve until this is live.
- **R15. Existing accounts.**
  - Each stays pinned to its version and add-on prices (C4). A pinned account is never quoted a v14
    add-on code its version lacks (V4).
  - The protection end date and its notice date are stored per tenant (V9). The 12 months start on the
    v14 publish day for everyone (Q2); the dates are written at publish by a dry-run-first script.
  - A read-only census script, dry-run by default, lists every paying account with its pinned version,
    its protection end date and what it would pay under v14. Every unpinned payer is re-pinned before
    the publish (V6). The same census answers Q1's production count of `GROWTH` accounts.
  - Review and notice jobs are dry-run by default and skip a tenant with a price override (V9).
  - An old Growth account may move itself to PLUS at renewal (Q4, V10).
- **R16. Founding accounts.** A per-account marker carries the 24-month lock (Q3) and the free move-in.
  There is none today.
- **R17. LITE to Essentials.**
  - LITE is retired for new accounts.
  - Its accounts move to Essentials at the same $99 by re-pinning to v14 `CORE` (an upgrade at $0 under
    the tie rule). LITE is not redefined.
  - No LITE account loses a flag: the census in R15 proves it.
  - This folds in roadmap F-12 and F-13.
- **R18. Plan screens (web).** V7 and V8: the "Your plan" card, effect wording, no raw keys, the
  cap-based picker copy retired, and admin labels that tell the two Growths apart.
- **R19. Pricing page.** The public page moves to v14 only when v14 is on sale, and only after the site
  rebrand lands. The static pin test moves its `ON_SALE_VERSION` in the same PR. The new site's pricing
  is one line with no table.

Phase 3: missing features, in order. Each gets its own spec and ruling; none rides the Phase 2 PRs.

- **R20. Drivers complete a regulated stop.** Scope why the block exists: a signature and an age or ID
  check (`regulated-delivery.ts:86-93`). Then scope a web capture for both. This must ship before Pro
  is sold to tobacco wholesalers with vans. Until then, every place Pro is described to them says so.
- **R21. Guided move-in** becomes a bookable one-time service (builds on F-11).
- **R22. Pro extras** (own mailbox F-10, statement matching, margin warnings, priority support) are
  documented in `pricing-roadmap.md`. None goes on a public page before its register row is `live`.
- **R23. Small sale helpers** (QuickBooks-ready CSV, credit limits on new orders with an override, a
  store invite kit, the demo tenant refresh F-14, a review prompt built switched off) are scoped one
  paragraph each. Only what the owner picks is built.

## 5. Out of scope

- The rename. No new brand name in any file.
- F-18 and F-20 themselves; they get scoping notes only (`pricing-roadmap.md`).
- Flipping any gate from dark to enforced.
- Any change to a published PlanVersion row.
- Anything before the 2026-11-28 demo.

## 6. Tests that prove it

SA-1254's case table, plus the requirements it does not cover.

| Case | Test | Expected after Phase 2 | At `d977b00d4b` |
| --- | --- | --- | --- |
| T1 | `planKeyFromEnum("CORE")`, `("PLUS")`, `("ALL_IN")` | identity | "STARTER" (F5) |
| T2 | `planKeyToEnum("CORE")`, `("PLUS")`, `("ALL_IN")` | identity | throws (F4) |
| T3 | `planKeyToEnum("GROWTH")` | "TEAM", unchanged | "TEAM" |
| T4 | rank STARTER→CORE and LITE→CORE | upgrade, effective now, $0 | -1 for CORE: observe and report |
| T5 | GROWTH→PLUS | effective at period end; no users or caps removed | n/a |
| T6 | a pinned old-Growth account quoted commissions after publish | $0 (its own version) | the published SKU via the fallback (F6) |
| T7 | a pinned old-Growth account quoted regulated items | $39 | $39 |
| T8 | ladder rule 2 with delivery at $49 | $375 > $349, green | n/a |
| T9 | the v14 inclusion matrix (each add-on × 8 keys) | upward-closed | n/a |
| T10 | an unpinned payer at publish | re-pinned before it; dry run shows 0 non-trial changes | observe and report |
| T11 | customer copy scan for raw keys | 0 | 2 (F7) |
| T12 | the choose-plan header and "Fits your usage" | retired | present (F8) |
| T13 | the mirrors' order parity (5 places) | equal | the audit copy has drifted: red |
| T14 | the pilot business under a review or notice job | skipped (override) | n/a |
| R1 | `plan-catalog-v14.spec.ts`: v14 rows deep-equal the definitions; the publisher refuses on a non-v13 base | red on a v13 row edited in place | n/a |
| R4 | registry census: every new flag is in `DARK_PLAN_FLAGS`, every new add-on key is `dark` | red on a new gate shipped enforced | n/a |
| R5 | v14 caps are null on CORE, PLUS and ALL_IN | red on a v14 plan with a customer cap | n/a |
| R8 | the ladder spec, three checks | red on delivery at $0 in check 2, and on Growth at $230 | n/a |
| R9 | the 26th approval is refused; a removed store frees a slot | red when the 26th approval passes | n/a |
| R13 | nudge fires at $356 against $349 and stays silent at $278 | red on a nudge at $278 | n/a |
| R14 | a self-serve pick without a payment stays not active | red on ACTIVE before payment | ACTIVE at `:883` |
| R15 | the census is read-only and lists the protection end date | red on any write | n/a |
| R17 | every LITE account's v14 flags are a superset of its v13 flags | red on a LITE account losing a flag | n/a |
| R19 | `site-pricing-catalog.static.test.ts` (Phase 1) follows `ON_SALE_VERSION` | red when the page shows a price the catalog on sale does not sell | pinned to 13 |

Fix-revert probes (binding on the PRs that carry them):

| Probe | Revert | Goes red |
| --- | --- | --- |
| P1 | drop PLUS from `planKeyFromEnum` | T1 |
| P2 | copy a v13 `includedAtPlan: "SCALE"` into a v14 add-on | T9 (Pro billed for it) |
| P3 | restore the published-SKU fallback for pinned accounts | T6 |
| P4 | store delivery as $0 only | T8 |
| P5 | print the raw key in the invite-only error | T11 |
| P6 | make PLUS selectable before its row is published | V2's test |

## Design Gate (Full) — pricing-v14 Phases 2-3 · 2026-11-24 · base d977b00d4b

### G1 Fit
- Program / train: pricing v14 (owner 2026-11-23, corrections 2026-11-24); SA-1254 folds SA-1204 into it; folds F-12 and F-13.
- Exists today: `apps/api/prisma/plan-catalog-v13.definitions.ts:30`, `apps/api/src/billing/feature-registry.ts:153`, `apps/api/src/billing/plan-flag-policy.ts:13`, `apps/api/src/billing/plan-catalog.constants.ts:21`, `:157-184`, `:362-386`, `:462-481`, `apps/api/src/billing/proration.service.ts:160-162`, `apps/api/prisma/schema/tenancy.prisma:22-33`, `:94`, `apps/api/prisma/schema/platform.prisma:38-87`, `:120`, `:285-323`.
- Decision: extend the plans-as-data catalog with a new version on the existing PlanVersion, PLAN_KEYS and add-on inclusion seams; reuse #4401's two enum values plus one new value (`PLUS`); no parallel plan system.
- Facts: v13 carries v11's plan rows (`plan-catalog-v13.definitions.ts:30`, `plan-catalog-v12.definitions.ts:62-69`); CORE and ALL_IN exist and are unused (`tenancy.prisma:31-32`); `planKeyToEnum` maps GROWTH to TEAM and throws on CORE and ALL_IN (`plan-catalog.constants.ts:462-481`); seats are never enforced (`apps/api/src/billing/entitlements.service.ts:279`); card-first is off (`subscription-mutation.service.ts:426`); `PLAN_FLAG_ENFORCEMENT` was deleted in production on 2026-09-17 per bug record B473, and the owner's reading of the production value is pending.

### Area sweep
| Source | Query run | Open ids in this area | Fixed here (own commit + red test) | Deferred (row + reason) |
| --- | --- | --- | --- | --- |
| Bug registry | `grep '"register":"open"' .claude/campaign/bugs.jsonl \| grep -iE 'plan-catalog\|plan flag\|plan-flag\|entitlement\|addon\|add-on\|pricing page\|billing'` (95 hits) | B217, B327, B410, B446, B474, B552, B554, B1165 and others in the 95 | none (spec only) | the Full panel assigns each to a Phase 2 PR or a row; B1165 is the pre-publish gate in the publish PR; B554 (self-serve enableAddon has no requires check) goes with R6 |
| Tracker issues | `gh issue list --state open --limit 200 --search "plan catalog OR pricing OR plan flag"` (47) | #1823 (D-18), #1378 (F-12), #1676 (B474), #2708, #1928 | none | #1823 stays open until a plan-flag registry lands (CLAUDE.md); #2708 goes with R4 |
| SA rulings | SA-1204 C1-C19 and A1; SA-1254 F1-F10, V1-V12 | SA-1204 A1 F7 (drifted audit-script plan map, board W-1288) | none (spec only) | bundled into the ladder PR under V1 |
| ACTION-ITEMS | `grep -n -iE 'plan flag\|pricing\|billing' .claude/handoffs/ACTION-ITEMS.md` (file not present at this base) | none | none | n/a, file absent |
| Review nits | `ls local-assets/specs/ \| grep -iE 'pric\|billing\|plan'` (no hits) | none | none | none |
- Chunk: billing only; 19 Phase 2 requirements in the nine SA-1254 steps (plan.md), each code PR at or under 400 added non-test lines.

### G2 Variation map
| Axis | How it differs there (one line) | Mark | Seam in this change (SEAM NOW only) |
| --- | --- | --- | --- |
| Wholesaler / distributor | the main buyer; Essentials, store ordering and filings decide the plan | BUILD NOW | - |
| Jobber | small reseller, likely Essentials plus one add-on; the ladder rule protects it | BUILD NOW | - |
| Retail POS counter | counter sales free on every plan; no plan gate | n/a, counter is a capability, not a plan feature | - |
| Delivery / route | delivery free in early access, scheduled $49 later | SEAM NOW | the scheduled $49 is a ladder-check constant beside the $0 price (V5) |
| Mixed | same as wholesaler; no plan difference | n/a, no plan rule differs for mixed accounts | - |
| Super admin | pins, custom prices, founding marker, protection dates, two Growths labelled apart | SEAM NOW | per-tenant protection end and notice dates (V9) and the founding marker, read by the census |
| Single store / 1 user | no user limit; zero-config defaults | BUILD NOW | - |
| Small team | no user limit | BUILD NOW | - |
| Multi-branch / multi-warehouse | not in the product; F-20 would add a $49 add-on | LATER | - |
| High volume | no customer cap; fair-use line only | LATER | - |
| Legacy accounts (Starter, Growth, Scale, LITE) | pinned for 12 months from the publish day; LITE re-pins to CORE; old Growth may move to PLUS at renewal | BUILD NOW | - |
- Surfaces & roles: web operator billing page and plan picker; mobile mirrors web; store portal is untouched except the store-count block at approval; super admin sees pins, protection dates, the founding marker and the two Growths labelled apart.
- Capability read: entitlements from the pinned PlanVersion plus flags-gain-forward, never the `plan` enum (`tenancy.prisma:92-94`).
- Inclusion seam: the V3 matrix now; an inclusion-set model LATER, only if a future plan is not upward-closed.
- Dark launch: every new flag in `DARK_PLAN_FLAGS`, every new add-on key `dark`; the owner flips each in a separate diff after the blast-radius report; removed with D-18.

### G3 Replace-later
| Planned program touching this area | Would it replace or rework this? | Answer |
| --- | --- | --- |
| D-18 retire the dark-flag safety lists (#1823) | yes, it removes `DARK_PLAN_FLAGS` | no conflict: new flags join the list and leave with it |
| F-18 QuickBooks sync, F-20 multi-warehouse | each adds a $49 add-on and moves Pro to $449 | seam: one catalog value per price plus the ladder spec, so a move is a new version and one line |
| The rename and site rebrand | display names and the site change | no conflict: names come from one display-name helper (V7); the site pricing step waits for the rebrand |
| SA-1204 PR-2..PR-6 | superseded by SA-1254 | not built; re-specified here |
- Interim: the pricing page stays on v13 until v14 is on sale; the static pin test holds it there. The single inclusion threshold has a test (V3) that fails the day it stops being enough.

### G4 Class, not instance
- Class: (1) every public price and plan fact comes from the catalog on sale; (2) a plan key is never read back as another plan (V1); (3) a pinned account is never billed at a new price (V4).
- Inventory: (1) `prices.js` plus every `data-plan`/`data-addon` span in `apps/web/public/site/*.html` (pricing 26, home 19, product 6 at the base sha); (2) the five key mirrors (T13); (3) the proration fallback at `proration.service.ts:160-162` (F6).
- One helper: `apps/web/public/site/js/prices.js` on the site; `plan-catalog-v14.definitions.ts` and the identity maps in `plan-catalog.constants.ts` in the API; one display-name helper (V7).
- Pin: `site-pricing-catalog.static.test.ts` (Phase 1), the ladder spec (R8), the T1-T3 round-trip and T13 order parity specs, and T6.
- Red-first: ladder check 2 with delivery at $0 is red ($326 < $349), at $49 green ($375 > $349); the page pin is red when `prices.js` says Growth $199 while v13 is on sale; P1-P6 above.

### G5 Data & time
- Schema: additive only, one migration in one sitting (backup, `prod-migrate.mjs`, drift 0): the `PLUS` TenantPlan value, the per-tenant protection end and notice dates (V9), the founding marker, and the store-ordering cap column on PlanDefinition. No backfill at migrate time.
- Snapshot vs live: the tenant pins its PlanVersion and `TenantAddon.priceSnapshot`; flags gain forward; prices never gain forward; the proration fallback (F6) is closed for pinned accounts (V4).
- Authority & time: the server derives caps and inclusion from the pinned version. The protection dates are written at publish by a dry-run-first script, starting on the v14 publish day for everyone (Q2); founding accounts get 24 months (Q3).
- Old shape → new: v13 accounts stay pinned; every unpinned payer is re-pinned before the publish; LITE accounts re-pin to `CORE` after the census proves no flag is lost; old Growth keeps `GROWTH`; no dual-read is needed because keys differ.
- Money: `@routeflow/pricing` (`roundMoney`) for every price and nudge sum; yearly through `annualPrice` (V12).

### G6 Scale
- Queries: the store count is one indexed count per tenant at approval time; the census and re-pin are one batched, paged pass over tenants.
- Limits: 25 stores on Essentials, one catalog field; no other cap; a handful of catalog rows.
- UI at 10 and 10,000: the moving-down confirm shows a count and a paged list of affected stores, never a fetch-all.

### G7 UX lens
- Flow: one primary action per state. At the 26th store, "Add every store online, $79" or "Move to Growth, $199". The nudge appears only when the numbers say so. A pinned account sees a "Your plan" card with its own price and protection date; wording follows the effect, and "Keep current plan" is the one-step undo (V8).
- Feature parity: no paying account loses a screen during its protection; the billing page keeps every current row; no raw keys on any customer surface (V7).
- Placement sign-off: apple-ux agrees because the block appears where the store is approved, not later; apple-design agrees because no motion or layout change is planned.

### G8 Change-friendliness
- Config over code: prices, caps and inclusion are catalog rows; gates are registry rows; display names come from one helper.
- Shared contract: plan keys in `packages/types/api/enums.ts`, pinned by `apps/api/src/common/enum-parity.spec.ts`, and the order parity spec over the five mirrors (V1).
- Flags: each new flag leaves `DARK_PLAN_FLAGS` when its enforcement diff lands, and the list goes with D-18.
- Code map: `.claude/code-map/` billing area names the v14 catalog, the ladder spec and the inclusion matrix.
- Future requirement → expected diff size:
  - Pro moves to $449 when F-18 and F-20 are live → S (a new catalog version with one changed value)
  - Delivery's early access ends → S (a new catalog version at $49; the constant already exists)
  - A new add-on → S (one SKU row, its `includedAtPlan`, and one registry row)
  - Old Growth's name after Q1 is ruled → XS (one display-name entry)

### G9 Cost & stop
- Quick fix: editing `prices.js` to show the new plans would be faster, but it would sell plans the catalog does not have; the catalog-first shape is right.
- YAGNI: per-seat pricing, usage metering for scans and a customer-count fair-use enforcer were cut.
- Cost: nine steps after the demo, each code PR at or under 400 added non-test lines, Tier 1 for code.
- Stop rule: any non-trial bill change in the census or dry run means no publish, and it returns to the architect.
- Review-round signal: n/a, no review rounds yet.

### G10 Owner questions
- SA-1254 Q2, Q3 and Q4 are answered (section 3).
- Open, recommended first: Q1, old Growth's plan name after v14. The architect is re-ruling it after the production census of `GROWTH` accounts.
- When does early access for delivery end (starts the 6-month notice)?
- Trial end with no pick: read-only (recommended) or drop to Essentials?
