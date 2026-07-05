# POS, Cost Accounting & Roles — Implementation Spec

> Wiring spec for cost transparency, pausable drafts, at-the-door order actions, and blended
> roles. Design: `unified/pos-flow.html` + the cost/margin hints and Minimize button in
> `unified/order-builder.html`. Applies to web AND mobile (see `mobile-new-features.md` §E).

## 1. Cost accounting (know the real cost, always)

- **Costing method** is a tenant setting: `WEIGHTED_AVERAGE` (default) | `FIFO` | `LAST_COST`.
  - WAC: every posted vendor bill re-averages: `wac = (onhand_qty*wac + recv_qty*unit_cost) / (onhand_qty + recv_qty)`.
  - FIFO: receipts create lots; sales consume oldest lots; line cost = consumed-lot cost.
  - LAST_COST: cost = most recent bill's unit cost.
- **Snapshot on sale**: every sold line stores `cost_at_sale` + `cost_method` + margin. Historic
  lines are never rewritten by later bills or method changes.
- **Live surfacing (the negotiation floor):**
  - Sale builder (web + mobile): under each price input show `cost $X.XX · margin %` recomputed
    as the operator types. Below-cost or below-floor → red state + "Set to floor $Y" one-tap fix +
    "Sell anyway" (logged). Floors: `default_margin_floor` per tenant, overridable per category.
  - Tapping the cost opens the cost history (bills/lots behind the number) — same data as
    product detail → Cost History.
  - Customer detail → Price Memory gains a margin column (their price vs cost now).
- Margin analytics/reports state the method used; changing method is effective-dated.

## 2. Minimize & resume drafts

- Any builder (order / invoice / PO) gets **Minimize** — parks the draft into a persistent
  bottom-left **draft dock** visible on every screen (web) / a collapsed bar above the tab bar
  (mobile). Multiple drafts allowed.
- Drafts autosave per keystroke (`sale_drafts`: payload, customer, device, updated_at), sync
  across devices, survive offline, and restore scroll + focus on resume.
- While a draft is minimized, scanning a barcode anywhere prompts **"Add to draft — {customer}?"**
  (one tap) vs "Start new".
- Docked drafts expire never; deleting requires confirm. Badge shows count when >2 collapse.

## 3. At-the-door actions (driver or admin at point of sale)

- On an arrived stop, one sheet offers everything, ≤2 taps deep:
  - **Adjust existing order**: qty steppers per line, swipe-delete, scan-to-add (price memory
    applies). Total recalculates live. **Save & capture POD** = one tap → invoice regenerates
    from delivered lines (regulated split rules still apply), buyer instantly gets the updated
    copy, edits land on the order timeline (`edited at delivery — {user}`).
  - **New order at door**: opens the builder pre-set to this customer; delivering it merges into
    this stop's POD + invoice flow.
  - **Collect payment**: Record Payment prefilled with the stop's balance (cash/check quick
    modes); posts to AR immediately (or queues offline).
- Guards (credit limit, regulated license, short stock) fire inline with their existing
  one-modal patterns — never a second screen.

## 4. Roles: admin-as-driver, one-person businesses

- **Role = permissions; mode = layout.** `canActAsDriver` on any user adds them to rosters and
  runs. A **Drive mode** toggle (avatar menu, one tap) swaps to the field layout (today's run
  first, big targets, scanner shortcut) without logout, permission change, or draft loss.
- **Driver capability set** (non-admin): create/edit orders & invoices, record payments, returns,
  receive stock, create vendor bills, at-door edits, customer create — i.e. all *work*.
  **Admin-only**: user management, pricing rules & floors, costing method, settings, tracked
  categories, exports, hard deletes, billing.
- **One-person business**: a single TENANT_ADMIN with `canActAsDriver` — dashboard shows both
  office KPIs and "your run today"; no second account needed. Route assignment allows self.
- **Admin tracking**: Live Dispatch shows every run including the admin's own; runs started in
  Drive mode emit the same realtime events (stop status, POD, payments) — nothing special-cased.

## Acceptance
- [ ] Cost method configurable; WAC math correct on receipt; per-line `cost_at_sale` snapshots.
- [ ] Builder shows live cost/margin per line; floor warning with one-tap fix; overrides logged.
- [ ] Minimize/resume works across screens, devices, offline; scan-to-draft prompt works.
- [ ] At-door adjust → save & POD ≤2 taps; invoice regenerates correctly incl. regulated split.
- [ ] Drive mode toggles in one tap; driver capability set enforced server-side; admin sees own
      run in Live Dispatch.
