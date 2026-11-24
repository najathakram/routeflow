# 5. Plans by feature, not by customers or users

- **Status:** Accepted (decided by the owner). Not live: the catalog on sale is still v13.
- **Date:** 2026-11-24 (decisions of 2026-11-02, 2026-11-11, 2026-11-23 and the corrections of 2026-11-24)
- **Deciders:** the owner. The Senior Architect rules on the build (Phase 2) after the 2026-11-28 demo.
- **Related:** [`docs/product/billing-plans.md`](../product/billing-plans.md) (the standing plan spec),
  [`docs/product/pricing-roadmap.md`](../product/pricing-roadmap.md),
  [`docs/product/claims-register.md`](../product/claims-register.md),
  [`.claude/pipeline/2026-11-23-pricing-v14/spec.md`](../../.claude/pipeline/2026-11-23-pricing-v14/spec.md),
  `apps/api/prisma/plan-catalog-v13.definitions.ts` (the catalog on sale today)

## Context

Today's plans (catalog v13) are Starter $99, Growth $249 and Scale $499. They differ only by how many
customers they include: 100, 250 and 500. Every plan has every feature, as the pricing page says. The
plan definitions also carry user counts (`seatsIncluded`), but nothing enforces them (B1371,
`apps/api/src/billing/entitlements.service.ts:279`).

That shape has three problems:

1. **It charges for growth, not for value.** A wholesaler pays more the moment it signs its 101st
   store, even if it uses nothing new. The buyers we talk to hear it as a penalty for growing.
2. **It cannot fund new features.** When we ship QuickBooks sync or several warehouses, nothing in a
   customer-count ladder lets the price follow the feature.
3. **It invites false claims.** With every feature on every plan, no document has to say which plan
   has what, and marketing drifted from the code. An earlier sales-copy draft made nine claims the
   product does not support.

## Options considered

| Option                             | For                                                                                                    | Against                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Keep customer tiers** (today) | No migration; simple to explain                                                                        | The three problems above; punishes growth                                                                                                                                                                   |
| **B. Per user (per seat)**         | Common in software; scales with team size                                                              | Wholesalers add drivers and counter staff seasonally; charging per login stops them adding the people who make the product useful; seats are not enforced today and enforcing them would take features away |
| **C. Feature tiers** (chosen)      | The price follows what a business does; a new feature can move a price; no limit on customers or users | Needs real gates, a migration path for paying accounts, and a test that keeps the ladder honest                                                                                                             |

## Decision

Plans differ by **what a business does**, never by how many customers it has or how many people log in.

- **Essentials $99, Growth $199, Pro $349** a month; a year costs ten months' price.
- No customer limit and no user limit on any plan. Customer caps leave the plans; a fair-use sentence
  goes in the terms after legal review.
- The difference between plans is a set of features (the table in `billing-plans.md`). The one counted
  allowance is **stores ordering online**: 25 on Essentials, every store on Growth and Pro, or every
  store with a $79 add-on on Essentials.
- **The database values are reused** (correction 2026-11-24): `CORE` is Essentials and `ALL_IN` is Pro.
  These `TenantPlan` values were added by PR #4401 and applied in production on 2026-11-21, but no
  account uses them yet. The new $199 Growth gets **its own internal plan key, `PLUS`** (SA-1254). It
  never reuses today's `GROWTH` key (today's Growth accounts, $249 and 250 customers, keep their plan)
  or `TEAM` (which live $249 Growth rows already hold).
- **Paying accounts are protected** (correction 2026-11-24): accounts on Starter, Growth and Scale keep
  every feature and their price for 12 months, from one date for everyone: the day v14 is published.
  After that comes a review with 90 days' written notice. This replaces the 2026-11-07 "grandfathered
  forever". A per-account custom price stays as it is. The first 50 founding accounts keep a 24-month
  lock (owner, 2026-11-24).
- **A price moves only when a feature ships**, only for new accounts, and only with the notice periods
  above. See `pricing-roadmap.md`.

This replaces the 2026-11-21 idea of Core $99 with $49 modules and All-in $199 (ruled as SA-1204). The
name "catalog v14" was reserved by SA-1204 and passes to this programme. SA-1254 (2026-11-24) folded
SA-1204 into it: the modules model is retired, and its engineering rules carry. A Full architect panel
on the Phase 2-3 spec rules the code shape before any build starts.

## Consequences

- **Gates become real.** Today the Growth-only features (supplier bills, analytics, estimates, repeat
  invoices, messages) have gates, but every one is dark. They ship dark in v14 too. Each moves to
  enforced only in a separate diff, after the owner runs the blast-radius report against production.
  This is the rule because an earlier plan-flag enforcement change caused a 27-hour outage (roadmap
  F-12; deferral D-18).
- **A store-count cap is new work.** No such cap exists today. It counts a store once the store is
  approved for ordering, whether or not it has ordered.
- **A ladder test guards the prices.** A spec in `apps/api/src/billing/` reads the catalog and fails
  the build if an add-on costs as much as the step to the next plan, if Pro stops being cheaper than
  Growth plus what Pro includes, or if Growth drifts more than $25 above Essentials plus the store
  add-on. Delivery is checked at its scheduled price ($49), not its early-access $0.
- **Marketing reads the catalog and the claims register.** The pricing page is pinned to the catalog
  on sale by a static test. A feature is described in public only when its register row is `live`.
- **Self-serve needs card checkout first.** A self-serve plan pick goes active with no payment today
  (claims register A12). None of the new plans is sold self-serve until payment comes first.
- **LITE goes away for new accounts.** Its accounts move to Essentials at the same $99 and gain
  features; none loses a feature or pays more.

## When to revisit

- If a large share of new accounts buy Essentials plus three or more add-ons instead of moving up, the
  plan boundaries are wrong.
- If the 25-store allowance is the only reason accounts upgrade, the store count has become a
  customer tier again under another name.
- If a feature that defines a plan cannot be gated without taking it from a paying account, the split
  needs to change before the protection period ends.
- If legal review rejects the fair-use line, "no customer limit" needs a different shape.
