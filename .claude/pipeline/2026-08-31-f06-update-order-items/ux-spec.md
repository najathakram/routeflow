# UX Spec: order-edit pricing readiness gate (B62 slice of F06)

> Authored by Fable 5 on 2026-08-31. Status: APPROVED
> Serves R11 of [spec.md](./spec.md). Companion cache: `.claude/pipeline/design-system.md`
> (derived from the codebase — cite it, don't repeat it). This is a NARROW spec: one existing
> screen gains a loading-gated state on two controls. No new screens, no new components.

## Job to be done

- **Who:** operator editing an order in the web dashboard (daily, core workflow).
- **Job:** add or substitute product lines and trust the shown price is the customer's
  contracted tier price.
- **Why now:** the page auto-enters edit mode on DRAFT orders the instant the order loads,
  while the customer detail + customer-price queries are still in flight; `customerTier`
  defaults to 1 (`?? 1`, page.tsx:1551), so a line added in that window bakes the list price.
  The substitute flow is worse: it always SENDS its computed `unitPrice` to the API
  (page.tsx:1282-1314), so the wrong price persists server-side.

## Entry points & exits

Unchanged from today. This spec only gates two in-page controls; the page, its routes and its
exits are untouched.

## Screen inventory

| Screen | Route | Purpose | Requirement |
|---|---|---|---|
| Order detail/edit (existing) | `/(dashboard)/orders/[id]` | edit order lines | R11 |

## The change, precisely

Compute one boolean in the page component:

- `pricingReady` = `!order?.customerId` OR (the `useCustomer(order.customerId)` query has
  settled AND the `useCustomerPrices(order.customerId)` query has settled). "Settled" =
  success or error — an error must NOT wedge the editor shut forever; on error the page
  behaves as today (tier 1 fallback), which is the pre-existing degraded mode.
- While `!pricingReady`, the **add-product control** (the product search/add box inside
  `EditableLineItems`) and the **substitute picker trigger** are disabled.
- `pricingReady` is threaded into `EditableLineItems` as a prop; the two controls get
  `disabled` + the design system's standard disabled affordance (see design-system.md —
  reuse the exact pattern the page's own buttons already use; invent nothing).
- A small inline hint appears next to the disabled add control while loading:
  `Loading customer pricing…` — muted text style per design-system.md. No spinner overlay,
  no layout jump (reserve no extra vertical space; the hint replaces nothing).
- DRAFT auto-enter edit mode stays exactly as is — the page still opens in edit mode
  immediately; only the two pricing-dependent controls wait.

## State set (delta only — every other state on this screen is unchanged)

| State | Trigger | What's shown | Recovery |
|---|---|---|---|
| Pricing loading | order loaded, customer queries in flight | add + substitute controls disabled; hint "Loading customer pricing…" | resolves by itself (typically <1s) |
| Pricing ready | customer queries settled (success or error) | controls enabled; hint gone | — |
| No customer | `order.customerId` empty | controls enabled immediately | — |
| Pricing fetch error | customer query errored | controls enabled (today's tier-1 fallback), hint gone | pre-existing degraded mode; unchanged |

## Interaction & validation

- Disabled controls are real `disabled` attributes (not click-swallowed) so keyboard and
  screen-reader users get the native semantics; the hint is plain text adjacent to the
  control (no live-region announcements needed for a sub-second state).
- No focus stealing when controls enable.

## Accessibility

- `disabled` on the actual interactive elements; hint text has the repo's muted-foreground
  token; contrast per design-system.md baseline. No new interactive elements.

## Verification flows (feed test-plan §8 / e2e spec 24)

1. Intercept and DELAY `/customers/:id` → open a DRAFT order → editor is open but the add
   control is disabled and the hint is visible → release the intercept → control enables.
2. With pricing resolved, add a line for a tier-priced product → the shown unit price equals
   the tier price (not list).
3. Open an order with no customer (if such exist in the fixture tenant) — controls enabled
   immediately. (Drop if the fixture tenant cannot produce one; assert flow 1+2 only.)
