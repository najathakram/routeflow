# RouteFlow use cases

_Every use case the code on `master` supports today, by the person who does it._

Read at `origin/master` `6296a86f0b` (2026-11-23). Code wins over every other source, the code map
included. A row here is a claim that a screen and an endpoint exist for it; anything that could not be
proven from the code is left out or named under [What this doc could not verify](#what-this-doc-could-not-verify).

## How this doc is maintained

- **Who updates it.** Every feature or fix PR that changes what a user can do updates the matching UC
  rows in its **docs-only bookkeeping follow-up PR**, the same PR that carries the code map and the
  lessons. The code PR itself does not edit this file.
- **New use cases get the next id** in their actor's series (`UC-OFF-41` after `UC-OFF-40`). Ids are
  never reused or renumbered; a removed use case keeps its row with status `REMOVED` and the PR that
  removed it.
- **Status changes** (a gate flipped from dark to enforced, a `developer_mode` screen released) change
  the status cell and name the PR.
- **Planned items** move from [Not yet built / planned](#not-yet-built--planned) to an actor table only
  when the code ships, with a new UC id.
- **No client data.** No live client, tenant slug, product, order or invoice number, ever. Examples use
  `acme`.
- The capability model in this folder ([README.md](README.md) and its domain files) is a separate,
  point-in-time audit of problems and gaps. This file is the list of what users can do now.

## Contents

- [How to read a row](#how-to-read-a-row)
- [Counts](#counts)
- [1. Business owner / admin](#1-business-owner--admin-uc-adm)
- [2. Office staff](#2-office-staff-uc-off)
- [3. Warehouse and inventory](#3-warehouse-and-inventory-uc-wh)
- [4. Counter (POS) staff](#4-counter-pos-staff-uc-pos)
- [5. Driver](#5-driver-uc-drv)
- [6. Buyer (customer portal)](#6-buyer-customer-portal-uc-buy)
- [7. Super admin (platform)](#7-super-admin-platform-uc-plt)
- [Server capabilities with no screen on master](#server-capabilities-with-no-screen-on-master)
- [Not yet built / planned](#not-yet-built--planned)
- [What this doc could not verify](#what-this-doc-could-not-verify)

## How to read a row

**Roles.** The API knows five roles (`apps/api/prisma/schema/tenancy.prisma` `enum UserRole`):
`TENANT_ADMIN` (business owner / admin), `OPERATOR` (all staff: office, warehouse, counter), `DRIVER`,
`SUPER_ADMIN` (platform), and buyers, who sign in to the buyer portal with their own account. A
`TENANT_ADMIN` can do everything an `OPERATOR` can (`apps/api/src/auth/guards/roles.guard.ts`). An
operator or admin with `canActAsDriver` can also do driver work.

**Permission groups.** An admin can switch groups off per operator: `ORDERS`, `DISPATCH`, `CUSTOMERS`,
`CATALOG`, `PRICING`, `REGULATED`, `FINANCE`, `NOTIFICATIONS`, `REPORTS`, `BAD_DEBT` (`BAD_DEBT` is off
by default). Which group opens which endpoint is pinned in
`apps/api/src/auth/permissions/permission-map.pinned.ts`. Single actions (edit a line price, void a sale,
use the till, edit after an invoice is final, override a selling restriction, date a sale) are in
`packages/types/api/staff-capabilities.ts`.

**Where it lives.** Web paths are under `apps/web/app/`, API paths under `apps/api/src/`, mobile paths
under `apps/mobile/app/`. Every mobile build profile sets `EXPO_PUBLIC_WEB_SHELL=on`
(`apps/mobile/eas.json`), so in the app, **admins, staff and buyers use the same web screens inside the
app shell** (`apps/mobile/app/(shell)/web.tsx`). The native operator and customer screens run only in a
build with the shell off; this doc does not list them as a separate surface. Drivers get the native
driver app (see section 5 for its gate).

**Status.**

| Status                       | Means                                                                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIVE`                       | On master and reachable. No plan or add-on gate in the way. Roles, permission groups and business settings still apply.                                                                                           |
| `LIVE, gated <key>`          | Reachable only for a business whose plan, add-on or a Platform Admin grant carries the key. The gate is enforced.                                                                                                 |
| `DARK-OPEN <key>`            | The gate ships dark and does not depend on any server switch: every business except a `LITE` one or one with a DENY override is served (see below).                                                               |
| `DARK-SWITCH <key>`          | A dark plan flag whose answer depends on the server's `PLAN_FLAG_ENFORCEMENT` switch. Its production value is unknown (see below).                                                                                |
| `DARK-HIDDEN developer_mode` | The screens exist but only a business with the internal `developer_mode` switch sees them. Off by default; RouteFlow staff turn it on. The native driver gate fails open when the read does not land (section 5). |
| `PLANNED`                    | Named as planned on the roadmap or in the feature registry; not built. Only in the planned section.                                                                                                               |

How a dark gate decides:

- **`DARK-OPEN`, add-on gates** in state `dark` (`email.connected_mailbox`, `crm_gohighlevel`, `ocr`):
  the request is served and one "would deny" line is logged, unless the business is on an
  always-enforced plan (`LITE`) or holds a DENY override (`apps/api/src/billing/addon-access.ts:48-51`,
  `feature-registry.ts:1504`).
- **`DARK-OPEN`, pre-pin plan flags** (`flag.estimates`, `flag.recurring_invoices`, `flag.credit_notes`,
  `flag.suppliers`, `flag.messaging`): served to every non-`LITE` business whatever the switch says,
  until the plan catalog is re-pinned with them (`plan-flag-policy.ts:37-43`, `:51`, `:63`).
- **`DARK-SWITCH`, the other eight `DARK_PLAN_FLAGS`** (`flag.analytics`, `flag.ap_bills`,
  `flag.import_integrations`, `flag.forecasting`, `flag.pricing_tiers`, `flag.reports`, `flag.returns`,
  `addon.buyer_portal`; `plan-flag-policy.ts:14-20`, `:26`): served to every non-`LITE` business **only
  while `PLAN_FLAG_ENFORCEMENT` is not `on`** (`:46-47`, `:51`, `:63`). With it `on`, only a plan that
  carries the flag (or a GRANT override) gets the feature. The repo does not hold the production value;
  a comment at `plan-flag-policy.ts:30` records production switching it on on 2026-09-17. So this doc
  cannot say every business has a `DARK-SWITCH` feature in production today.
- The web menu hides a plan-gated page the plan does not carry (`apps/web/lib/plan-gated-nav.ts`).
- The API's delivery gates accept any of `recurring_routes`, `order_delivery` or `developer_mode`
  (`apps/api/src/routes/routes.controller.ts:53`). The web menu reads only the first two
  (`apps/web/lib/api/addons.ts` `useRoutesAccess`, `useDeliveryAccess`).

**Money rules that apply everywhere.** Line, tax and total math is `@routeflow/pricing`
(`packages/pricing`): `computeLineSubtotal` for boxed lines, `normalizeBoxesPieces`, `roundMoney` on every
monetary write. Products can be sold by piece, box, case or pallet; a boxed line is never re-priced as
`qty * unitPrice`.

## Counts

| Actor                   | Use cases |    LIVE | DARK-OPEN | DARK-SWITCH | DARK-HIDDEN |
| ----------------------- | --------: | ------: | --------: | ----------: | ----------: |
| Business owner / admin  |        24 |      19 |         2 |           3 |           0 |
| Office staff            |        40 |      33 |         3 |           4 |           0 |
| Warehouse and inventory |        17 |      14 |         1 |           2 |           0 |
| Counter (POS) staff     |         6 |       6 |         0 |           0 |           0 |
| Driver                  |        12 |       4 |         0 |           0 |           8 |
| Buyer (customer portal) |        15 |      15 |         0 |           0 |           0 |
| Super admin (platform)  |        14 |      14 |         0 |           0 |           0 |
| **Total**               |   **128** | **105** |     **6** |       **9** |       **8** |

Planned: 9 items. Server capabilities with no screen: 8 items (not counted as use cases).

## 1. Business owner / admin (UC-ADM)

Actor: `TENANT_ADMIN`. Most settings live under **Settings** (`apps/web/app/(dashboard)/settings/page.tsx`,
groups in `_components/settings-groups.ts`).

| Id        | Use case                                                   | Status                                 |
| --------- | ---------------------------------------------------------- | -------------------------------------- |
| UC-ADM-1  | Sign up a new business                                     | LIVE                                   |
| UC-ADM-2  | Follow the getting-started checklist and sign off set-up   | LIVE                                   |
| UC-ADM-3  | Choose, change or cancel the RouteFlow plan                | LIVE                                   |
| UC-ADM-4  | Pay a RouteFlow bill that is due                           | LIVE                                   |
| UC-ADM-5  | Add staff and set what each one may do                     | LIVE                                   |
| UC-ADM-6  | Set the business profile, logo and menu layout             | LIVE                                   |
| UC-ADM-7  | Choose how orders go out (delivery, carrier, pickup)       | LIVE                                   |
| UC-ADM-8  | Set invoice numbering, layout, terms and how customers pay | LIVE                                   |
| UC-ADM-9  | Connect a card-payment account                             | LIVE                                   |
| UC-ADM-10 | Set up email sending (SMTP or a sending domain)            | LIVE                                   |
| UC-ADM-11 | Send email from the business's own mailbox                 | DARK-OPEN `email.connected_mailbox`    |
| UC-ADM-12 | Turn customer notifications on or off and edit their text  | LIVE                                   |
| UC-ADM-13 | Name price tiers and set margin and costing rules          | LIVE                                   |
| UC-ADM-14 | Rename or archive unit names                               | LIVE, gated `flag.units_settings_v1`   |
| UC-ADM-15 | Manage product categories                                  | LIVE                                   |
| UC-ADM-16 | Set out-of-stock and oversell rules                        | LIVE                                   |
| UC-ADM-17 | Switch on selling restrictions and the address policy      | LIVE                                   |
| UC-ADM-18 | Import data from files                                     | LIVE                                   |
| UC-ADM-19 | Move over from another system in one guided import         | DARK-SWITCH `flag.import_integrations` |
| UC-ADM-20 | Sync with GoHighLevel CRM                                  | DARK-OPEN `crm_gohighlevel`            |
| UC-ADM-21 | See the analytics dashboard                                | DARK-SWITCH `flag.analytics`           |
| UC-ADM-22 | Look up one product's sales insights                       | DARK-SWITCH `flag.analytics`           |
| UC-ADM-23 | Pay sales agents commission                                | LIVE, gated `flag.sales_agents`        |
| UC-ADM-24 | Get the mobile app                                         | LIVE                                   |

### UC-ADM-1 Sign up a new business

- **Goal:** Make a RouteFlow account for my business so I can start using it.
- **Steps:** enter business and admin details, check the username and web address are free; confirm the
  email; sign in.
- **Rules:** the business starts on a trial (`TenantStatus.TRIAL`); a resend of the confirmation email
  is offered.
- **Where:** web `(auth)/signup`, `(auth)/signup/check-email`, `verify-email`; api
  `tenants/public-tenants.controller.ts`.
- **Status:** LIVE.

### UC-ADM-2 Follow the getting-started checklist and sign off set-up

- **Goal:** See what is left to set up and say when my business is ready.
- **Steps:** open Getting started; work through the open steps; the admin signs off.
- **Rules:** any staff member can read the checklist; only the admin signs off.
- **Where:** web `(dashboard)/getting-started`, `(dashboard)/dashboard`; api
  `onboarding/onboarding-tenant.controller.ts`.
- **Status:** LIVE.

### UC-ADM-3 Choose, change or cancel the RouteFlow plan

- **Goal:** Pick the plan I pay RouteFlow for and change it later.
- **Steps:** open Choose plan or Settings → Billing; see a price quote and proration preview; subscribe,
  upgrade, downgrade, cancel or resume; manage the card in the hosted billing portal; turn self-serve
  add-ons on or off; export billing history.
- **Rules:** writes are admin-only; a failed quote leaves no stale preview (`choose-plan/page.tsx`).
- **Where:** web `(dashboard)/choose-plan`, `(dashboard)/settings/billing`; api
  `billing/settings-billing.controller.ts`, `billing/plan-catalog.controller.ts`.
- **Status:** LIVE.

### UC-ADM-4 Pay a RouteFlow bill that is due

- **Goal:** Pay an open RouteFlow bill so my account stays active.
- **Steps:** Settings → Billing status shows what is due; the admin pays it.
- **Rules:** staff can see the status; only the admin pays.
- **Where:** web `(dashboard)/settings` (Billing status, Pay bill); api
  `billing/payment-due.controller.ts`, `billing/billing-status.controller.ts`.
- **Status:** LIVE.

### UC-ADM-5 Add staff and set what each one may do

- **Goal:** Give my team logins and decide who can do what.
- **Steps:** Settings → User management; add an operator; switch permission groups off per person; make
  someone an admin or allow them to drive; reset a password, unlock or deactivate an account.
- **Rules:** admin-only; the last admin is protected (`users/admin-account-protection.ts`);
  `BAD_DEBT` is off for new operators.
- **Where:** web `(dashboard)/settings`; api `users/users.controller.ts`,
  `auth/permissions/`.
- **Status:** LIVE.

### UC-ADM-6 Set the business profile, logo and menu layout

- **Goal:** Make RouteFlow show my business name, logo and the menu my team uses.
- **Steps:** edit the business profile and timezone; upload a logo; save a sidebar layout.
- **Rules:** admin-only.
- **Where:** web `(dashboard)/settings` (Business profile); api `tenants/tenants.controller.ts`
  (branding, logo), `system-config/settings.controller.ts` (`updateNavLayout`).
- **Status:** LIVE.

### UC-ADM-7 Choose how orders go out

- **Goal:** Tell RouteFlow whether we deliver ourselves, ship by carrier, let customers pick up, or a mix.
- **Steps:** Settings → Orders & delivery; pick own delivery, ship by carrier, both, or in store; preview
  what changes; save. A first-run question asks it once.
- **Rules:** admin-only writes. The answer drives which screens show: the counter (section 4), dispatch
  and routes, and shipments (`feature-registry.ts` rows `fulfilment_model`, `routes_dispatch`,
  `counter_sales`).
- **Where:** web `(dashboard)/settings/_components/FulfillmentSettingsTab.tsx`; api
  `settings-fulfilment/settings-fulfilment.controller.ts`.
- **Status:** LIVE.

### UC-ADM-8 Set invoice numbering, layout, terms and how customers pay

- **Goal:** Make my invoices look and number the way my business needs.
- **Steps:** set invoice numbering and prefix (with preview); pick a layout; set default terms; write
  the "how customers pay you" remittance text.
- **Rules:** numbering and remittance are admin-only; invoice settings need `FINANCE`.
- **Where:** web `(dashboard)/settings` (Invoicing, How customers pay you); api
  `import/numbering.controller.ts`, `system-config/settings.controller.ts`.
- **Status:** LIVE.

### UC-ADM-9 Connect a card-payment account

- **Goal:** Let my customers pay invoices by card online.
- **Steps:** Settings → Card payments; connect the Stripe account; disconnect later if needed.
- **Rules:** admin-only; buyer card payments (UC-BUY-7) run on this connected account.
- **Where:** web `(dashboard)/settings/_components/StripeConnectCard.tsx`; api
  `stripe-connect/stripe-connect.controller.ts`.
- **Status:** LIVE.

### UC-ADM-10 Set up email sending

- **Goal:** Send invoices and statements from my business's email address.
- **Steps:** enter SMTP settings and test them, or add a sending domain, verify its DNS and set the
  "from" address.
- **Rules:** admin-only.
- **Where:** web `(dashboard)/settings/_components/SendingDomainCard.tsx`; api
  `system-config/settings.controller.ts`, `tenants/tenants.controller.ts` (email config).
- **Status:** LIVE.

### UC-ADM-11 Send email from the business's own mailbox

- **Goal:** Send RouteFlow email through my own Google or Microsoft mailbox.
- **Steps:** connect Google or Microsoft; confirm the mailbox; disconnect later.
- **Rules:** admin-only.
- **Where:** web `(dashboard)/settings/_components/MailboxCard.tsx`; api `email/mailbox/mailbox.controller.ts`.
- **Status:** DARK-OPEN `email.connected_mailbox`.

### UC-ADM-12 Turn customer notifications on or off and edit their text

- **Goal:** Decide which messages my customers get and what they say.
- **Steps:** Settings → Notifications; switch rules on or off per event and channel; edit and preview a
  template; check the delivery log and health; set which staff get order emails.
- **Rules:** only email is actually delivered: the other channels (SMS, WhatsApp) have no transport and
  are skipped as `NO_TRANSPORT` (`messaging/providers/stub.provider.ts`). Edits are admin-only; the
  log needs `NOTIFICATIONS`.
- **Where:** web `(dashboard)/settings/_components/NotificationsSettingsTab.tsx`; api
  `messaging/messaging.controller.ts`.
- **Status:** LIVE.

### UC-ADM-13 Name price tiers and set margin and costing rules

- **Goal:** Give my price levels names and set how cost and margin are worked out.
- **Steps:** rename tier labels; set the margin settings; set costing.
- **Rules:** admin-only writes.
- **Where:** web `(dashboard)/settings` (Pricing tier names, Costing); api
  `system-config/settings.controller.ts`.
- **Status:** LIVE.

### UC-ADM-14 Rename or archive unit names

- **Goal:** Call my selling units what my business calls them (case, pack, carton).
- **Steps:** Settings → Units; add, rename or archive a unit name.
- **Rules:** a rename updates every product that uses that name.
- **Where:** web `(dashboard)/settings/units`; api `units/units.controller.ts`.
- **Status:** LIVE, gated `flag.units_settings_v1`.

### UC-ADM-15 Manage product categories

- **Goal:** Group my products into categories.
- **Steps:** add or edit categories.
- **Rules:** create and edit are admin-only; regulated labels need `REGULATED`.
- **Where:** web `(dashboard)/settings/product-categories`; api
  `product-categories/product-categories.controller.ts`.
- **Status:** LIVE.

### UC-ADM-16 Set out-of-stock and oversell rules

- **Goal:** Decide whether customers can order more than I have in stock.
- **Steps:** set out-of-stock ordering and backorder visibility; set the buyer oversell policy; switch the
  low-stock digest on.
- **Rules:** admin-only writes.
- **Where:** web `(dashboard)/settings/_components/BuyerOversellCard.tsx`, `LowStockDigestToggle.tsx`; api
  `settings-inventory/settings-inventory.controller.ts`, `policy/policy.controller.ts`.
- **Status:** LIVE.

### UC-ADM-17 Switch on selling restrictions and the address policy

- **Goal:** Make sure restricted products are only sold where the law allows.
- **Steps:** run the readiness check; switch restrictions on; set the address policy.
- **Rules:** the switch and policy are admin-only. Day-to-day rules are UC-OFF-38.
- **Where:** web `(dashboard)/settings/restrictions`; api
  `restrictions-settings/restrictions-settings.controller.ts`.
- **Status:** LIVE.

### UC-ADM-18 Import data from files

- **Goal:** Bring my customers, products, stock and history into RouteFlow from spreadsheets.
- **Steps:** Settings → Import; upload contacts, products, inventory, invoices, payments, expenses or
  suppliers; check the result; roll back an expense batch; clean up imported test data.
- **Rules:** admin-only.
- **Where:** web `(dashboard)/settings/import`; api `import/import.controller.ts`,
  `customers/customers.controller.ts` (`cleanupPreview`, `cleanupImported`).
- **Status:** LIVE.

### UC-ADM-19 Move over from another system in one guided import

- **Goal:** Copy my data from my old system in one go and undo it if it is wrong.
- **Steps:** Settings → Migration; create a migration; stage it; confirm; undo if needed.
- **Rules:** admin-only.
- **Where:** web `(dashboard)/settings/migration`; api `import/migration.controller.ts`.
- **Status:** DARK-SWITCH `flag.import_integrations` (gate `import/migration.controller.ts:26`; `plan-flag-policy.ts:16`; served to every non-`LITE` business only while `PLAN_FLAG_ENFORCEMENT` is not `on`).

### UC-ADM-20 Sync with GoHighLevel CRM

- **Goal:** Keep my sales pipeline and contacts in step with GoHighLevel.
- **Steps:** connect and test; pick pipelines; sync; retry or dismiss a failed handoff; import existing
  contacts after a preview.
- **Rules:** connection changes are admin-only; sync work needs `CUSTOMERS`.
- **Where:** web `(dashboard)/settings/_components/GoHighLevelSettingsTab.tsx`; api `crm/crm.controller.ts`.
- **Status:** DARK-OPEN `crm_gohighlevel`.

### UC-ADM-21 See the analytics dashboard

- **Goal:** See which products, customers, routes and drivers make the money.
- **Steps:** open Analytics; read revenue, top products and customers, routes, drivers, turnover, dead
  stock, margin alerts, days sales outstanding, sales by category, gross margin, average order value,
  price and cost history.
- **Rules:** needs `REPORTS` (cost history also `PRICING`).
- **Where:** web `(dashboard)/analytics`; api `analytics/analytics.controller.ts`.
- **Status:** DARK-SWITCH `flag.analytics` (gate `analytics/analytics.controller.ts:17`; `plan-flag-policy.ts:14`; served to every non-`LITE` business only while `PLAN_FLAG_ENFORCEMENT` is not `on`).

### UC-ADM-22 Look up one product's sales insights

- **Goal:** Scan or search one product and see how it sells.
- **Steps:** open Product insights; scan a barcode or type a name; read sales and demand; export CSV.
- **Rules:** products only; needs `REPORTS`.
- **Where:** web `(dashboard)/insights`, `(dashboard)/insights/products/[id]`; api
  `sales-facts/product-insights.controller.ts`.
- **Status:** DARK-SWITCH `flag.analytics` (gate `sales-facts/product-insights.controller.ts:59`; `plan-flag-policy.ts:14`; served to every non-`LITE` business only while `PLAN_FLAG_ENFORCEMENT` is not `on`).

### UC-ADM-23 Pay sales agents commission

- **Goal:** Track which agent brought which customer and pay them fairly.
- **Steps:** add agents; set commission rates (per agent or per customer); assign customers; review
  accruals; generate, approve or void a commission statement; record a payout.
- **Rules:** needs `FINANCE`.
- **Where:** web `(dashboard)/sales-agents`, `(dashboard)/sales-agents/[id]`,
  `(dashboard)/finance/commissions`, `(dashboard)/finance/commissions/[id]`; api
  `sales-agents/sales-agents.controller.ts`, `sales-agents/commission-statements.controller.ts`.
- **Status:** LIVE, gated `flag.sales_agents`.

### UC-ADM-24 Get the mobile app

- **Goal:** Find the right app store link for my phone.
- **Steps:** open Get the app; follow the link.
- **Where:** web `(dashboard)/get-the-app`; api `app-links/app-links.controller.ts`.
- **Status:** LIVE.

## 2. Office staff (UC-OFF)

Actor: `OPERATOR` (and `TENANT_ADMIN`). The group needed is named in each row.

| Id        | Use case                                          | Status                                             |
| --------- | ------------------------------------------------- | -------------------------------------------------- |
| UC-OFF-1  | Sign in, reset a password, change email           | LIVE                                               |
| UC-OFF-2  | Take an order for a customer                      | LIVE                                               |
| UC-OFF-3  | Find an order and move it through its stages      | LIVE                                               |
| UC-OFF-4  | Change the lines on an order                      | LIVE                                               |
| UC-OFF-5  | Answer a change request from a buyer or driver    | LIVE                                               |
| UC-OFF-6  | Cancel, reopen or delete an order                 | LIVE                                               |
| UC-OFF-7  | Save an unfinished order and come back to it      | LIVE                                               |
| UC-OFF-8  | Set up a standing order for a customer            | LIVE                                               |
| UC-OFF-9  | Quote a customer with an estimate                 | DARK-OPEN `flag.estimates`                         |
| UC-OFF-10 | Handle a customer return                          | DARK-SWITCH `flag.returns`                         |
| UC-OFF-11 | Take a return while entering a new order          | LIVE, gated `orders_inline_returns`                |
| UC-OFF-12 | Ship orders by carrier and print packing slips    | LIVE                                               |
| UC-OFF-13 | Send a receipt for an order                       | LIVE                                               |
| UC-OFF-14 | Add and look after customers                      | LIVE                                               |
| UC-OFF-15 | Send a customer their statement                   | LIVE                                               |
| UC-OFF-16 | Take a deposit and use it later                   | LIVE                                               |
| UC-OFF-17 | Give one customer their own prices                | DARK-SWITCH `flag.pricing_tiers`                   |
| UC-OFF-18 | Invite a customer to the buyer portal             | DARK-SWITCH `addon.buyer_portal`                   |
| UC-OFF-19 | Make an invoice                                   | LIVE                                               |
| UC-OFF-20 | Send an invoice or a reminder                     | LIVE                                               |
| UC-OFF-21 | Record a payment                                  | LIVE                                               |
| UC-OFF-22 | Correct, void or write off an invoice             | LIVE                                               |
| UC-OFF-23 | Give a customer credit with a credit note         | DARK-OPEN `flag.credit_notes`                      |
| UC-OFF-24 | Bill a customer on a schedule                     | DARK-OPEN `flag.recurring_invoices`                |
| UC-OFF-25 | Approve a payment a buyer sent                    | LIVE                                               |
| UC-OFF-26 | Record expenses and receipts                      | LIVE                                               |
| UC-OFF-27 | See the money at a glance                         | LIVE                                               |
| UC-OFF-28 | Run a finance report                              | DARK-SWITCH `flag.reports`                         |
| UC-OFF-29 | Build a recurring delivery route                  | LIVE, gated `recurring_routes`                     |
| UC-OFF-30 | Put today's stops in the best order               | LIVE, gated `recurring_routes`                     |
| UC-OFF-31 | Send a route out with a driver                    | LIVE, gated `recurring_routes`                     |
| UC-OFF-32 | Send a one-off delivery                           | LIVE, gated `order_delivery`                       |
| UC-OFF-33 | See all of today's runs on one board              | LIVE, gated `recurring_routes` or `order_delivery` |
| UC-OFF-34 | Add and manage drivers                            | LIVE, gated `recurring_routes` or `order_delivery` |
| UC-OFF-35 | Settle a driver's run                             | LIVE, gated `recurring_routes` or `order_delivery` |
| UC-OFF-36 | Set route defaults                                | LIVE                                               |
| UC-OFF-37 | Check and renew customer licences                 | LIVE                                               |
| UC-OFF-38 | Keep restricted products from the wrong customers | LIVE                                               |
| UC-OFF-39 | Track regulated sales and prepare filings         | LIVE, gated `tobacco_dealer`                       |
| UC-OFF-40 | Set up regulated sections                         | LIVE                                               |

### UC-OFF-1 Sign in, reset a password, change email

- **Goal:** Get into RouteFlow safely, and back in if I forget my password.
- **Steps:** sign in with username and password or Google; pick a role if I have more than one; reset a
  forgotten password by email; confirm an email change; see and end my other sessions.
- **Rules:** a locked or inactive account is refused (`auth/login-eligibility.ts`). The same sign-in
  serves admins, warehouse, counter staff and drivers.
- **Where:** web `(auth)/login`, `(auth)/choose-role`, `(auth)/forgot-password`, `(auth)/reset-password`,
  `confirm-email-change`, `change-password`; api `auth/auth.controller.ts`.
- **Status:** LIVE.

### UC-OFF-2 Take an order for a customer

- **Goal:** Write down what a customer wants so we can send it to them.
- **Steps:** New order; pick the customer (if they already have an open order, choose to merge into it
  or start a separate one); add products by search or scan, in pieces, boxes or cases; see stock and the
  customer's last price; choose delivery, shipping or pickup; optionally date the sale; save.
- **Rules:** needs `ORDERS`. Prices come from the customer's price layer and the money rules above.
  Editing a line price needs `PRICING` (`EDIT_LINE_PRICE`); dating a sale is `SET_ORDER_DATE`. A
  restricted product shows a warning that staff may override with a reason
  (`OVERRIDE_SELLING_RESTRICTION`). An order edit that would push a customer over their credit limit
  is blocked (`orders.service.ts` `assertWithinCreditLimit`). With `PLAN_FLAG_ENFORCEMENT` off the check
  runs for every business; with it `on`, only for plans carrying `flag.credit_limits`
  (`billing/feature-registry.ts:977-994`). Merges are serialized per customer (`common/db-locks.ts` `withAdvisoryLock`).
- **Where:** web `(dashboard)/orders/new`, `(dashboard)/orders` (`_components/CreateOrderModal.tsx`); api
  `orders/orders.controller.ts`, `customers/customer-order-suggestions.controller.ts`,
  `customers/customer-price-layer.controller.ts`.
- **Status:** LIVE. The accumulating scan screen inside it is `DARK-HIDDEN developer_mode`
  (`apps/web/lib/api/addons.ts` `useScanV2`).

### UC-OFF-3 Find an order and move it through its stages

- **Goal:** See where every order is and move it on.
- **Steps:** search and filter Orders; open one; move it through draft, pending, confirmed, out for
  delivery, delivered (or partly delivered, refused, cancelled); mark it urgent; clear a review flag;
  see delivery tracking.
- **Rules:** needs `ORDERS`. Stages are `enum OrderStatus` (`prisma/schema/sales.prisma`).
- **Where:** web `(dashboard)/orders`, `(dashboard)/orders/[id]`; api `orders/orders.controller.ts`.
- **Status:** LIVE. The card-list order detail is `DARK-HIDDEN developer_mode` (`useOrderUiV2`).

### UC-OFF-4 Change the lines on an order

- **Goal:** Fix what the customer is getting before it goes out.
- **Steps:** open the order; add, remove or change lines; reorder lines; save.
- **Rules:** needs `ORDERS`; editing after the invoice is final needs `FINANCE` (`EDIT_AFTER_FINAL`). An
  order's draft invoice follows the order; a partial invoice is never re-billed
  (`invoices/invoices.service.ts` `reconcileOrderDraftInvoice`).
- **Where:** web `(dashboard)/orders/[id]`; api `orders/orders.controller.ts` (`updateOrderItems`,
  `reorderLines`).
- **Status:** LIVE.

### UC-OFF-5 Answer a change request from a buyer or driver

- **Goal:** Say yes or no when someone asks to change an order.
- **Steps:** open the order's change requests; approve or reject each.
- **Rules:** needs `ORDERS`; a driver may resolve at the stop (UC-DRV-8).
- **Where:** web `(dashboard)/orders/[id]`; api `orders/orders.controller.ts` (`listChangeRequests`,
  `resolveChangeRequest`).
- **Status:** LIVE.

### UC-OFF-6 Cancel, reopen or delete an order

- **Goal:** Take back an order that should not go out, or bring one back.
- **Steps:** see what cancelling will touch; cancel; reopen a cancelled or delivered order; delete one or
  many.
- **Rules:** needs `ORDERS`; delete is staff or admin.
- **Where:** web `(dashboard)/orders`, `(dashboard)/orders/[id]`; api `orders/orders.controller.ts`
  (`cancelImpact`, `reopenOrder`, `remove`, `bulkDelete`).
- **Status:** LIVE.

### UC-OFF-7 Save an unfinished order and come back to it

- **Goal:** Stop halfway through an order without losing it.
- **Steps:** leave the order builder or the counter; resume the saved draft later.
- **Rules:** staff and drivers may keep drafts (`ORDERS`).
- **Where:** web `(dashboard)/orders/_components/use-unsent-order-resume.ts`; api `drafts/drafts.controller.ts`.
- **Status:** LIVE.

### UC-OFF-8 Set up a standing order for a customer

- **Goal:** Save a list a customer orders again and again, and turn it into an order in one tap.
- **Steps:** on the customer, create a template; add items; generate an order from it.
- **Rules:** needs `ORDERS`; a suspended item can be lifted back in.
- **Where:** web `(dashboard)/customers/[id]`; api `order-templates/order-templates.controller.ts`.
- **Status:** LIVE.

### UC-OFF-9 Quote a customer with an estimate

- **Goal:** Tell a customer the price before they decide.
- **Steps:** create an estimate; send it; mark it accepted or declined; convert it to an order or an
  invoice; void it.
- **Rules:** needs `ORDERS`. Stages are `enum EstimateStatus`.
- **Where:** web `(dashboard)/estimates`, `(dashboard)/estimates/[id]`; api `estimates/estimates.controller.ts`.
- **Status:** DARK-OPEN `flag.estimates`.

### UC-OFF-10 Handle a customer return

- **Goal:** Take goods back and give the customer their money or credit.
- **Steps:** open a return; approve or reject; mark in transit; receive it (restock); refund or credit.
  Resolve parked restocks the system could not classify.
- **Rules:** needs `ORDERS` (refund also `FINANCE`). Stages are `enum ReturnStatus`.
- **Where:** web `(dashboard)/returns`, `(dashboard)/returns/[id]`; api `returns/returns.controller.ts`.
- **Status:** DARK-SWITCH `flag.returns` (gate `returns/returns.controller.ts:64`; `plan-flag-policy.ts:20`; served to every non-`LITE` business only while `PLAN_FLAG_ENFORCEMENT` is not `on`).

### UC-OFF-11 Take a return while entering a new order

- **Goal:** Credit a return in the same place I write the customer's new order.
- **Steps:** in the order builder add a return line; see the quote; capture; approve; refund or give
  store credit; or cancel.
- **Rules:** granted by default to every business whose plan has `flag.returns`; the business sets price
  source, sold window, over-return policy, driver credit cap, and whether a reason or photo is required
  (`feature-registry.ts` row `orders_inline_returns`).
- **Where:** web `(dashboard)/orders/_components/CreateOrderModal.tsx`; api `returns/returns.controller.ts`
  (`quoteInline` and siblings).
- **Status:** LIVE, gated `orders_inline_returns`.

### UC-OFF-12 Ship orders by carrier and print packing slips

- **Goal:** Send orders by carrier and keep their tracking numbers.
- **Steps:** open Shipments; ship one or several orders at once; add tracking; print packing slips; switch
  an order between delivery and shipping.
- **Rules:** needs `ORDERS` or `DISPATCH`.
- **Where:** web `(dashboard)/shipments`; api `orders/orders.controller.ts` (`batchShip`, `packingSlips`,
  `updateShipment`, `updateFulfillPath`).
- **Status:** LIVE.

### UC-OFF-13 Send a receipt for an order

- **Goal:** Email a customer a receipt for what they bought.
- **Steps:** on the order, send a receipt.
- **Rules:** needs `ORDERS` or `FINANCE`.
- **Where:** api `documents/receipt.controller.ts`; web order and counter screens.
- **Status:** LIVE.

### UC-OFF-14 Add and look after customers

- **Goal:** Keep every customer's details, people and papers in one place.
- **Steps:** add a customer; edit addresses (with address lookup), contacts, tags, comments, documents and
  tax documents; change status; merge two duplicates; export CSV; geocode addresses; delete and
  restore.
- **Rules:** needs `CUSTOMERS`; deleting every customer is admin-only.
- **Where:** web `(dashboard)/customers`, `(dashboard)/customers/[id]`; api
  `customers/customers.controller.ts`, `tenants/public-places.controller.ts`.
- **Status:** LIVE.

### UC-OFF-15 Send a customer their statement

- **Goal:** Show a customer what they bought, paid and still owe.
- **Steps:** open the customer; pick a month or the account statement; download the PDF or email it.
- **Rules:** needs `CUSTOMERS` or `FINANCE`.
- **Where:** web `(dashboard)/customers/[id]`; api `customers/customers.controller.ts` (`getAccountStatement`,
  `getAccountStatementPdf`, `sendAccountStatementEmail`).
- **Status:** LIVE.

### UC-OFF-16 Take a deposit and use it later

- **Goal:** Keep money a customer paid ahead and use it on a later invoice.
- **Steps:** record an advance payment; apply it to an invoice.
- **Rules:** needs `FINANCE`.
- **Where:** web `(dashboard)/customers/[id]`; api `customers/customers.controller.ts`
  (`createAdvancePayment`, `applyAdvancePayment`).
- **Status:** LIVE.

### UC-OFF-17 Give one customer their own prices

- **Goal:** Charge a customer the price we agreed with them.
- **Steps:** on the customer, set a price per product (or per unit on the price grid, UC-WH-3).
- **Rules:** writes need `PRICING`; the customer's own price overrides the catalog price.
- **Where:** web `(dashboard)/customers/[id]`; api `customers/customers.controller.ts`
  (`upsertCustomerPrice`), `customers/customer-unit-prices.controller.ts`.
- **Status:** DARK-SWITCH `flag.pricing_tiers` (gate `customers/customers.controller.ts:303,312,325`; `plan-flag-policy.ts:18`; served to every non-`LITE` business only while `PLAN_FLAG_ENFORCEMENT` is not `on`) (per-unit customer prices: LIVE, gated `flag.units_prices_v2`).

### UC-OFF-18 Invite a customer to the buyer portal

- **Goal:** Let a customer order and pay online by themselves.
- **Steps:** send or resend a portal invite; see whether they joined; approve or decline a buyer who asked
  to connect; disconnect them.
- **Rules:** needs `CUSTOMERS`.
- **Where:** web `(dashboard)/customers/[id]`, `(dashboard)/customers`; api `customers/customers.controller.ts`
  (`sendPortalInvite` and siblings).
- **Status:** DARK-SWITCH `addon.buyer_portal` (gate `customers/customers.controller.ts:123,431-475`; `plan-flag-policy.ts:26`; served to every non-`LITE` business only while `PLAN_FLAG_ENFORCEMENT` is not `on`).

### UC-OFF-19 Make an invoice

- **Goal:** Bill a customer for what they got.
- **Steps:** New invoice, or make one from an order (whole or part); add lines; set terms; save.
- **Rules:** needs `FINANCE` (from an order also `ORDERS`). Stages are `enum InvoiceStatus`.
- **Where:** web `(dashboard)/invoices/new`, `(dashboard)/invoices/[id]`, `(dashboard)/invoices/[id]/edit`;
  api `invoices/invoices.controller.ts`.
- **Status:** LIVE.

### UC-OFF-20 Send an invoice or a reminder

- **Goal:** Get the invoice to the customer and remind them when it is late.
- **Steps:** download the PDF; email it; send a reminder.
- **Rules:** needs `FINANCE`.
- **Where:** web `(dashboard)/invoices/[id]`; api `invoices/invoices.controller.ts` (`sendEmail`,
  `sendReminder`, `getPdf`).
- **Status:** LIVE.

### UC-OFF-21 Record a payment

- **Goal:** Write down money a customer paid us.
- **Steps:** on an invoice or in Payments, record cash, check, card, ACH, Zelle, credit note or deposit;
  attach a photo of the check; set a check's status; edit, void or delete a payment; export payments.
- **Rules:** needs `FINANCE`. Methods are `PAYMENT_METHOD_VALUES` (`packages/types/api/enums.ts`).
- **Where:** web `(dashboard)/finance/payments`, `(dashboard)/finance/payments/[id]`,
  `(dashboard)/invoices/[id]`; api `invoices/invoices.controller.ts`, `invoices/payment-key-status.controller.ts`.
- **Status:** LIVE.

### UC-OFF-22 Correct, void or write off an invoice

- **Goal:** Fix a wrong invoice or stop chasing money we will never get.
- **Steps:** revert to draft; apply a price adjustment; void or unvoid; write off what is left; delete.
- **Rules:** needs `FINANCE`.
- **Where:** web `(dashboard)/invoices/[id]`; api `invoices/invoices.controller.ts`.
- **Status:** LIVE.

### UC-OFF-23 Give a customer credit with a credit note

- **Goal:** Give money back as credit the customer can use on invoices.
- **Steps:** create a credit note; apply it to invoices or unapply it; void (with a preview, or with a
  reversal) or reissue; exclude it from auto-apply.
- **Rules:** needs `FINANCE`.
- **Where:** web `(dashboard)/credit-notes`, `(dashboard)/credit-notes/[id]`; api
  `credit-notes/credit-notes.controller.ts`.
- **Status:** DARK-OPEN `flag.credit_notes`.

### UC-OFF-24 Bill a customer on a schedule

- **Goal:** Send the same invoice every week or month without typing it again.
- **Steps:** create a recurring invoice; edit; pause or start it; run it now.
- **Rules:** needs `FINANCE`.
- **Where:** web `(dashboard)/invoices/recurring`, `(dashboard)/invoices/recurring/new`,
  `(dashboard)/invoices/recurring/[id]/edit`; api `recurring-invoices/recurring-invoices.controller.ts`.
- **Status:** DARK-OPEN `flag.recurring_invoices`.

### UC-OFF-25 Approve a payment a buyer sent

- **Goal:** Check a payment a buyer made in the portal and accept it.
- **Steps:** open Payment requests; preview how it will be spread over invoices; approve or reject.
- **Rules:** needs `FINANCE`. A buyer payment settles the invoice the buyer chose first, then the oldest.
- **Where:** web `(dashboard)/finance/payment-requests`; api `payment-requests/payment-requests.controller.ts`.
- **Status:** LIVE.

### UC-OFF-26 Record expenses and receipts

- **Goal:** Keep track of what the business spends.
- **Steps:** add expenses one by one or in bulk; attach a receipt; read the lines off a scanned receipt;
  set categories and mileage rates; mark paid.
- **Rules:** needs `FINANCE`. Scanning is `DARK-OPEN ocr` (included on every plan, capped by the AI
  usage cap).
- **Where:** web `(dashboard)/vendor-bills` (expenses tab; `finance/expenses` redirects there),
  `(dashboard)/bookkeeping/[transactionId]`; api `bookkeeping/bookkeeping.controller.ts`.
- **Status:** LIVE.

### UC-OFF-27 See the money at a glance

- **Goal:** See sales, money owed and money in on one page.
- **Steps:** open Finance overview.
- **Rules:** needs `REPORTS` or `FINANCE`; sales are accrual net of credit notes.
- **Where:** web `(dashboard)/finance/dashboard`, `(dashboard)/dashboard`; api
  `bookkeeping/bookkeeping.controller.ts` (`getFinanceDashboard`).
- **Status:** LIVE.

### UC-OFF-28 Run a finance report

- **Goal:** Answer a money question with a report.
- **Steps:** open Reports; pick profit and loss, aging, cash flow, sales by customer, item or driver,
  customer balances, invoice details, bad debts, payments received, time to get paid, expenses, refunds,
  estimates or the ledger.
- **Rules:** needs `REPORTS`.
- **Where:** web `(dashboard)/finance/reports` (`bookkeeping` and `finance/customers` redirect there);
  api `bookkeeping/bookkeeping.controller.ts`.
- **Status:** DARK-SWITCH `flag.reports` (gate `bookkeeping/bookkeeping.controller.ts:207-377`; `plan-flag-policy.ts:19`; served to every non-`LITE` business only while `PLAN_FLAG_ENFORCEMENT` is not `on`).

### UC-OFF-29 Build a recurring delivery route

- **Goal:** Plan the stops a driver visits on the same days every week.
- **Steps:** create a route; add customers as stops; drag to reorder; edit or delete.
- **Rules:** needs `DISPATCH`. The API accepts any of `recurring_routes`, `order_delivery` or
  `developer_mode`; the web menu shows Routes only with `recurring_routes`.
- **Where:** web `(dashboard)/routes`, `(dashboard)/routes/create`, `(dashboard)/routes/templates/[id]`; api
  `routes/routes.controller.ts`.
- **Status:** LIVE, gated `recurring_routes`.

### UC-OFF-30 Put today's stops in the best order

- **Goal:** Let RouteFlow suggest the shortest order to visit the stops.
- **Steps:** analyse a route or run; optimise; compare variants; apply one.
- **Rules:** needs `DISPATCH`.
- **Where:** web `(dashboard)/routes/[id]`, `(dashboard)/routes/templates/[id]`; api
  `route-optimization/route-optimization.controller.ts`.
- **Status:** LIVE, gated `recurring_routes`.

### UC-OFF-31 Send a route out with a driver

- **Goal:** Turn a route into today's run with a driver and the right orders.
- **Steps:** create a run; assign a driver; reorder stops; print the packing list; open the stops in
  Google Maps; follow progress; delete a run.
- **Rules:** needs `DISPATCH`.
- **Where:** web `(dashboard)/routes/[id]`, `(dashboard)/routes/[id]/dispatch`; api `routes/routes.controller.ts`.
- **Status:** LIVE, gated `recurring_routes`.

### UC-OFF-32 Send a one-off delivery

- **Goal:** Deliver orders that are not on a regular route.
- **Steps:** Order delivery → New; check which orders can go; pick them; create the trip; it becomes a run.
- **Rules:** needs `DISPATCH`; every ad hoc delivery is sent once.
- **Where:** web `(dashboard)/deliveries`, `(dashboard)/deliveries/new` (`routes/trips` redirects there);
  api `trips/trips.controller.ts`.
- **Status:** LIVE, gated `order_delivery`.

### UC-OFF-33 See all of today's runs on one board

- **Goal:** See every run of the day and how far each has got.
- **Steps:** open Dispatch.
- **Rules:** the Dispatch menu shows when the business has either delivery add-on. A live map of every
  driver (`flag.dispatch_live`) is not built; see Planned.
- **Where:** web `(dashboard)/dispatch`; api `routes/routes.controller.ts`.
- **Status:** LIVE, gated `recurring_routes` or `order_delivery`.

### UC-OFF-34 Add and manage drivers

- **Goal:** Keep a list of my drivers and see how they do.
- **Steps:** add a driver; edit; change status; see history and metrics; remove.
- **Rules:** needs `DISPATCH`.
- **Where:** web `(dashboard)/drivers`, `(dashboard)/drivers/[id]`; api `drivers/drivers.controller.ts`.
- **Status:** LIVE, gated `recurring_routes` or `order_delivery`.

### UC-OFF-35 Settle a driver's run

- **Goal:** Check the cash and checks a driver brings back match what they collected.
- **Steps:** open the finished run; count; enter a reason if it differs by more than a cent; settle.
- **Rules:** needs `DISPATCH`. The office and the driver read the same run figure
  (`routes/my-runs/run-lifecycle.ts` `driverRunFooter`).
- **Where:** web `(dashboard)/routes/[id]`; api `routes/routes.controller.ts` (`settleRun`).
- **Status:** LIVE, gated `recurring_routes` or `order_delivery`.

### UC-OFF-36 Set route defaults

- **Goal:** Set how new routes and runs behave by default.
- **Steps:** Settings → Route defaults; save.
- **Rules:** needs `DISPATCH`.
- **Where:** web `(dashboard)/settings/_components/RouteDefaultsCard.tsx`; api
  `system-config/settings.controller.ts` (`updateRouteSettings`).
- **Status:** LIVE.

### UC-OFF-37 Check and renew customer licences

- **Goal:** Keep each customer's licence on file and up to date.
- **Steps:** add a licence; approve or reject one a buyer uploaded; renew; add an override; see which
  expire soon.
- **Rules:** needs `REGULATED`.
- **Where:** web `(dashboard)/customers/[id]`; api `authorizations/authorizations.controller.ts`.
- **Status:** LIVE.

### UC-OFF-38 Keep restricted products from the wrong customers

- **Goal:** Stop selling products a customer is not allowed to buy where they are.
- **Steps:** create rules (one or many); see which products and customers a rule holds; preview and commit
  an edit; lift a rule; set a state on customers who have none (with undo).
- **Rules:** writes need `REGULATED`; the business switch is UC-ADM-17.
- **Where:** web `(dashboard)/settings/restrictions`, `(dashboard)/settings/restrictions/rules`,
  `(dashboard)/settings/restrictions/rules/[id]`; api `selling-restrictions-admin/`,
  `restrictions-settings/unknown-state-customers.controller.ts`.
- **Status:** LIVE.

### UC-OFF-39 Track regulated sales and prepare filings

- **Goal:** Keep the record the law asks for on regulated products and file it on time.
- **Steps:** open Regulated items; read a section's ledger, inventory, purchases, sales and monthly view;
  preview and download reports (CSV); prepare a filing and download it (CSV or PDF); resolve parked
  reversals; the admin locks a filing for an ended period.
- **Rules:** needs `REGULATED`; locking needs the admin and a reason and cannot be undone.
- **Where:** web `(dashboard)/compliance`, `(dashboard)/compliance/[categoryId]` (`tobacco` redirects there);
  api `regulated/regulated.controller.ts`, `tobacco/tobacco.controller.ts`.
- **Status:** LIVE, gated `tobacco_dealer`.

### UC-OFF-40 Set up regulated sections

- **Goal:** Mark which product groups are regulated.
- **Steps:** Settings → Regulated sections; add or edit sections and sub-sections; assign products.
- **Rules:** needs `REGULATED`; categorisation is free on every plan.
- **Where:** web `(dashboard)/settings/_components/RegulatedSettingsTab.tsx`; api
  `tracked-categories/tracked-categories.controller.ts`.
- **Status:** LIVE.

## 3. Warehouse and inventory (UC-WH)

Actor: `OPERATOR` with `CATALOG` (prices: `PRICING`).

| Id       | Use case                                    | Status                             |
| -------- | ------------------------------------------- | ---------------------------------- |
| UC-WH-1  | Add and edit products                       | LIVE                               |
| UC-WH-2  | Sell a product by case, box or piece        | LIVE, gated `flag.units_v1`        |
| UC-WH-3  | Set a price for every unit and tier         | LIVE, gated `flag.units_prices_v2` |
| UC-WH-4  | Show a suggested retail price               | LIVE, gated `flag.msrp`            |
| UC-WH-5  | Choose which products buyers see            | LIVE                               |
| UC-WH-6  | Run a promotion                             | LIVE                               |
| UC-WH-7  | See stock and every movement                | LIVE                               |
| UC-WH-8  | Adjust stock or record a purchase           | LIVE                               |
| UC-WH-9  | Count stock                                 | LIVE                               |
| UC-WH-10 | Set cost and see stock value                | LIVE                               |
| UC-WH-11 | Order from a supplier with a purchase order | LIVE                               |
| UC-WH-12 | Keep a supplier list                        | DARK-OPEN `flag.suppliers`         |
| UC-WH-13 | Enter and pay supplier bills                | DARK-SWITCH `flag.ap_bills`        |
| UC-WH-14 | Check a supplier statement                  | LIVE                               |
| UC-WH-15 | Import a stack of purchase invoices         | LIVE                               |
| UC-WH-16 | Get told when to reorder                    | DARK-SWITCH `flag.forecasting`     |
| UC-WH-17 | Look up a product by barcode                | LIVE                               |

### UC-WH-1 Add and edit products

- **Goal:** Keep my catalogue right: names, barcodes, pictures, categories.
- **Steps:** add a product (or a family with variants, checking the SKU is free); edit; upload images;
  move products under a parent; delete one or many; export CSV.
- **Rules:** needs `CATALOG`; clearing the whole catalogue is admin-only.
- **Where:** web `(dashboard)/products`, `(dashboard)/products/[id]` (`products/create` redirects to the list);
  api `products/products.controller.ts`, `products/product-families.controller.ts`.
- **Status:** LIVE.

### UC-WH-2 Sell a product by case, box or piece

- **Goal:** Sell the same product in different sizes, each with its own price.
- **Steps:** on the product, add units and how many pieces each holds; edit or remove.
- **Rules:** needs `CATALOG`; boxed lines follow the money rules above.
- **Where:** web `(dashboard)/products/[id]/ProductUnitsCard.tsx`; api `products/product-units.controller.ts`.
- **Status:** LIVE, gated `flag.units_v1`.

### UC-WH-3 Set a price for every unit and tier

- **Goal:** Fill in one price grid for each size and each price level.
- **Steps:** open the product's price grid; edit; save; undo the last save.
- **Rules:** writes need `PRICING`.
- **Where:** web `(dashboard)/products/[id]`; api `products/product-pricing.controller.ts`.
- **Status:** LIVE, gated `flag.units_prices_v2`.

### UC-WH-4 Show a suggested retail price

- **Goal:** Print the maker's suggested shelf price for my customers.
- **Steps:** set MSRP on a product or in bulk.
- **Rules:** needs `PRICING`.
- **Where:** web `(dashboard)/products`; api `products/products.controller.ts` (`bulkSetMsrp`).
- **Status:** LIVE, gated `flag.msrp`.

### UC-WH-5 Choose which products buyers see

- **Goal:** Hide products I do not want buyers to order online.
- **Steps:** set portal visibility on one product or many.
- **Rules:** admin-only.
- **Where:** web `(dashboard)/products`; api `products/product-portal-visibility.controller.ts`.
- **Status:** LIVE.

### UC-WH-6 Run a promotion

- **Goal:** Put products on a deal for a while.
- **Steps:** create a promotion with dates and a rule; switch it on or off; edit; delete.
- **Rules:** needs `PRICING`. A promoted price never goes below $0.00. The business can switch
  promotions off; past orders keep what they were charged (`feature-registry.ts` row `promotions`).
- **Where:** web `(dashboard)/promotions`; api `promotions/promotions.controller.ts`.
- **Status:** LIVE.

### UC-WH-7 See stock and every movement

- **Goal:** Know how much I have and why it changed.
- **Steps:** open Inventory; read on-hand per product; open Movements; filter; export CSV.
- **Rules:** reading stock is open to staff and drivers; movements need `CATALOG`.
- **Where:** web `(dashboard)/inventory`, `(dashboard)/inventory/movements`; api `inventory/inventory.controller.ts`.
- **Status:** LIVE.

### UC-WH-8 Adjust stock or record a purchase

- **Goal:** Correct the stock number or add goods that came in.
- **Steps:** record an adjustment with a reason, or a purchase with its cost; spread a family's stock over
  its variants.
- **Rules:** needs `CATALOG`.
- **Where:** web `(dashboard)/inventory`; api `inventory/inventory.controller.ts` (`recordAdjustment`,
  `recordPurchase`, `assignToVariants`).
- **Status:** LIVE.

### UC-WH-9 Count stock

- **Goal:** Count the shelves and make the system match.
- **Steps:** start a count session; enter counted lines; watch progress; commit or discard.
- **Rules:** needs `CATALOG`.
- **Where:** web `(dashboard)/inventory/stock-counts`, `(dashboard)/inventory/stock-counts/[id]`; api
  `inventory/inventory.controller.ts`.
- **Status:** LIVE.

### UC-WH-10 Set cost and see stock value

- **Goal:** Know what my stock cost and what it is worth.
- **Steps:** set a product's cost basis (one or in bulk); read the valuation; the admin recomputes costs
  from history.
- **Rules:** cost needs `PRICING`; valuation `PRICING` or `REPORTS`; recompute is admin-only.
- **Where:** web `(dashboard)/inventory`, `(dashboard)/products/[id]`; api `inventory/inventory.controller.ts`.
- **Status:** LIVE.

### UC-WH-11 Order from a supplier with a purchase order

- **Goal:** Ask a supplier for goods and check them in when they arrive.
- **Steps:** create a PO; edit; send; receive all or part; close.
- **Rules:** needs `CATALOG`; core on every plan. Stages are `enum PurchaseOrderStatus`.
- **Where:** web `(dashboard)/purchase-orders`, `(dashboard)/purchase-orders/[id]`; api
  `inventory/inventory.controller.ts` (`createPO` and siblings).
- **Status:** LIVE.

### UC-WH-12 Keep a supplier list

- **Goal:** Keep my suppliers' details for buying and bills.
- **Steps:** add, edit, deactivate or delete a supplier.
- **Rules:** needs `CATALOG`.
- **Where:** web `(dashboard)/suppliers`, `(dashboard)/suppliers/[id]`; api `suppliers/suppliers.controller.ts`.
- **Status:** DARK-OPEN `flag.suppliers`.

### UC-WH-13 Enter and pay supplier bills

- **Goal:** Keep track of what I owe suppliers and pay it.
- **Steps:** create a bill, or scan one and let RouteFlow read its lines (checks for duplicates, remembers
  product matches); receive it into stock; record payments, or move a payment to credit; see a supplier's
  statement; void, revert or delete.
- **Rules:** needs `FINANCE`. Scanning is also `DARK-OPEN ocr`.
- **Where:** web `(dashboard)/vendor-bills`, `(dashboard)/vendor-bills/[id]` (`purchases` redirects there);
  api `vendor-bills/vendor-bills.controller.ts`.
- **Status:** DARK-SWITCH `flag.ap_bills` (gate `vendor-bills/vendor-bills.controller.ts:42`; `plan-flag-policy.ts:15`; served to every non-`LITE` business only while `PLAN_FLAG_ENFORCEMENT` is not `on`).

### UC-WH-14 Check a supplier statement

- **Goal:** Make sure a supplier's statement matches my records.
- **Steps:** upload or photograph the statement; review the matched grid; apply it.
- **Rules:** needs `FINANCE`; not plan-gated. Reading the statement is `DARK-OPEN ocr`.
- **Where:** web `(dashboard)/finance/statements`; api `supplier-statements/supplier-statements.controller.ts`.
- **Status:** LIVE.

### UC-WH-15 Import a stack of purchase invoices

- **Goal:** Load many supplier invoices at once and match their products.
- **Steps:** Settings → Batch invoice import; upload or scan; fix each line (create a variant, a new
  product, or match an existing one); post the batch.
- **Rules:** needs `CATALOG`. Scanning is `DARK-OPEN ocr`.
- **Where:** web `(dashboard)/settings/batch-import`; api `import/batch.controller.ts`,
  `import/resolution.controller.ts`.
- **Status:** LIVE.

### UC-WH-16 Get told when to reorder

- **Goal:** See which products will run out and set when to reorder.
- **Steps:** Inventory → Forecasting; read the forecast; set a reorder point.
- **Rules:** needs `CATALOG`.
- **Where:** web `(dashboard)/inventory` (Forecasting tab); api `inventory/inventory.controller.ts`
  (`getForecasting`, `setReorderPoint`).
- **Status:** DARK-SWITCH `flag.forecasting` (gate `inventory/inventory.controller.ts:283,290`; `plan-flag-policy.ts:17`; served to every non-`LITE` business only while `PLAN_FLAG_ENFORCEMENT` is not `on`).

### UC-WH-17 Look up a product by barcode

- **Goal:** Scan a barcode and find the product.
- **Steps:** scan or type the code anywhere a product is picked.
- **Rules:** open to staff and drivers.
- **Where:** api `products/products.controller.ts` (`findByBarcode`); web order, counter and insights screens.
- **Status:** LIVE.

## 4. Counter (POS) staff (UC-POS)

Actor: `OPERATOR` with `ORDERS` (`USE_POS_MODE`). The counter shows when the business's fulfilment answer
has a counter (`capabilities.fulfilment.counter` `optional` or `always`, read by `useCounterSaleGate` in
`apps/web/lib/api/counter-sale.ts`; set in UC-ADM-7). Settings → Counter holds quick keys and day close.

| Id       | Use case                             | Status |
| -------- | ------------------------------------ | ------ |
| UC-POS-1 | Ring up a sale at the counter        | LIVE   |
| UC-POS-2 | Park a sale and pick it up again     | LIVE   |
| UC-POS-3 | Void a counter sale                  | LIVE   |
| UC-POS-4 | Count the cash drawer                | LIVE   |
| UC-POS-5 | Close the day and print the Z report | LIVE   |
| UC-POS-6 | Hand over a pickup order             | LIVE   |

### UC-POS-1 Ring up a sale at the counter

- **Goal:** Sell to someone standing at the counter, fast.
- **Steps:** open Counter; tap quick keys or scan; take cash, card, check or put it on account; finish;
  see today's sales.
- **Rules:** a retry with the same key never double-charges (`byKey`); a store that also ships can offer
  shipping instead. Money rules above apply.
- **Where:** web `(dashboard)/orders/counter-sale` (`orders/_components/CounterSaleScreen.tsx`); api
  `orders/counter-sale/counter-sale.controller.ts`.
- **Status:** LIVE.

### UC-POS-2 Park a sale and pick it up again

- **Goal:** Put a sale aside to serve the next person, then finish it.
- **Steps:** park; list parked sales; resume or discard.
- **Where:** api `orders/counter-sale/counter-park.controller.ts`; web counter screen.
- **Status:** LIVE.

### UC-POS-3 Void a counter sale

- **Goal:** Undo a sale that was rung up by mistake.
- **Steps:** open the sale; void it.
- **Rules:** `VOID_SALE` (`ORDERS`).
- **Where:** api `orders/counter-sale/counter-sale-void.controller.ts`; web counter screen.
- **Status:** LIVE.

### UC-POS-4 Count the cash drawer

- **Goal:** Write down what is in the drawer.
- **Steps:** read the drawer; record a count; an admin corrects a wrong entry.
- **Rules:** correction is admin-only.
- **Where:** api `orders/counter-sale/drawer/counter-drawer.controller.ts`; web counter screen.
- **Status:** LIVE.

### UC-POS-5 Close the day and print the Z report

- **Goal:** End the day with totals that add up.
- **Steps:** see the close state; close the day; open the Z report; reopen a closed day if needed.
- **Rules:** needs `ORDERS` or `FINANCE`.
- **Where:** api `orders/counter-sale/day-close/day-close.controller.ts`; web counter screen and Settings →
  Day close & Z report.
- **Status:** LIVE.

### UC-POS-6 Hand over a pickup order

- **Goal:** Get an order ready for pickup and give it to the customer.
- **Steps:** mark the order ready; when the customer comes, complete the pickup.
- **Rules:** ready needs `ORDERS` or `DISPATCH`; complete needs `ORDERS`.
- **Where:** api `orders/ready-for-pickup.controller.ts`, `orders/counter-sale/pickup-complete.controller.ts`;
  web `(dashboard)/orders/[id]`.
- **Status:** LIVE.

## 5. Driver (UC-DRV)

Actor: `DRIVER`, or staff with `canActAsDriver` ("My Routes" in the Dispatch menu). Two surfaces:

- **Web "Today's route"** (`(dashboard)/routes/my-runs`), on any phone browser. The web menu shows it to
  a business with `recurring_routes` or `order_delivery`; the API behind it (`routes.controller.ts:53`,
  `getMyRuns` at `:164`) also admits `developer_mode`. It records deliveries and settles the run; it never
  takes money.
- **The native driver app** (`apps/mobile/app/(driver)/`). Once the `developer_mode` read has landed and
  says off, the app's root gate sends a pure driver to a "Desktop Only" screen
  (`apps/mobile/app/_layout.tsx:255-269`, `(auth)/operator-blocked.tsx:14`). The gate fails open: when the
  read does not land (offline, timeout, server error), the driver is let through ("Block only on a
  positively-read flag", `_layout.tsx:257-262`). So every native-only flow below is
  `DARK-HIDDEN developer_mode`. It is hidden whenever the business is read as not having the switch, not
  in every case.

| Id        | Use case                                  | Status                                                                                |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| UC-DRV-1  | See today's route on the web              | LIVE, gated `recurring_routes` or `order_delivery` (API also admits `developer_mode`) |
| UC-DRV-2  | Mark a stop delivered, refused or skipped | LIVE, gated `recurring_routes` or `order_delivery` (API also admits `developer_mode`) |
| UC-DRV-3  | Get directions to a stop                  | LIVE, gated `recurring_routes` or `order_delivery` (API also admits `developer_mode`) |
| UC-DRV-4  | Settle my run at the end                  | LIVE, gated `recurring_routes` or `order_delivery` (API also admits `developer_mode`) |
| UC-DRV-5  | Run my route in the driver app            | DARK-HIDDEN `developer_mode`                                                          |
| UC-DRV-6  | Collect payment at the door               | DARK-HIDDEN `developer_mode`                                                          |
| UC-DRV-7  | Capture a signature or photo as proof     | DARK-HIDDEN `developer_mode`                                                          |
| UC-DRV-8  | Change an order at the door               | DARK-HIDDEN `developer_mode`                                                          |
| UC-DRV-9  | Take a return at the stop                 | DARK-HIDDEN `developer_mode`                                                          |
| UC-DRV-10 | Split an order's invoice at the stop      | DARK-HIDDEN `developer_mode`                                                          |
| UC-DRV-11 | Take a new order on the road              | DARK-HIDDEN `developer_mode`                                                          |
| UC-DRV-12 | Leave a note on a stop                    | DARK-HIDDEN `developer_mode`                                                          |

### UC-DRV-1 See today's route on the web

- **Goal:** Know where I am going today and in what order.
- **Steps:** sign in; open Today's route; see the run, its stops and what is left to deliver.
- **Rules:** a driver sees only their own runs (`getMyRuns`).
- **Where:** web `(dashboard)/routes/my-runs`; api `routes/routes.controller.ts`.
- **Status:** LIVE, gated `recurring_routes` or `order_delivery` (API also admits `developer_mode`).

### UC-DRV-2 Mark a stop delivered, refused or skipped

- **Goal:** Tell the office what happened at each stop.
- **Steps:** open the stop; change a quantity for a short delivery; tap Delivered, Refused or Skip; Undo
  while the run is open.
- **Rules:** a skipped stop's orders go back to the office when the run ends; a wholly refused order reads
  Refused. No payment is taken here.
- **Where:** web `(dashboard)/routes/my-runs/StopSheet.tsx`; api `routes/routes.controller.ts`
  (`completeStop`, `reopenStop`).
- **Status:** LIVE, gated `recurring_routes` or `order_delivery` (API also admits `developer_mode`).

### UC-DRV-3 Get directions to a stop

- **Goal:** Open my maps app to drive to the customer.
- **Steps:** tap Navigate on a stop.
- **Where:** web `(dashboard)/routes/my-runs/StopSheet.tsx`; native `(driver)/map.tsx`.
- **Status:** LIVE, gated `recurring_routes` or `order_delivery` (API also admits `developer_mode`) (the native map is `DARK-HIDDEN developer_mode`).

### UC-DRV-4 Settle my run at the end

- **Goal:** Hand in the cash and checks I collected and finish the run.
- **Steps:** when no stop is left, tap Settle your run; count; give a reason if it is off by more than a
  cent; finish. A run with nothing to settle just finishes.
- **Rules:** reads the run's money figure, not the `driver_payments` add-on, so cash already taken can
  still be settled.
- **Where:** web `(dashboard)/routes/my-runs/RunSettleFooter.tsx`; native `(driver)/route/settlement.tsx`;
  api `routes/routes.controller.ts` (`settleRun`).
- **Status:** LIVE, gated `recurring_routes` or `order_delivery` (API also admits `developer_mode`).

### UC-DRV-5 Run my route in the driver app

- **Goal:** Do my whole route from a phone app, even with a weak signal.
- **Steps:** sign in; open Route; work stop by stop; see the map; the app posts my location in the
  background.
- **Where:** native `(driver)/route/index.tsx`, `(driver)/map.tsx`, `(driver)/orders.tsx`; api
  `routes/routes.controller.ts`, `drivers/drivers.controller.ts` (`postLocation`).
- **Status:** DARK-HIDDEN `developer_mode`.

### UC-DRV-6 Collect payment at the door

- **Goal:** Take the customer's money when I deliver.
- **Steps:** at the stop, review what was delivered (short-pick); record cash or check; complete the stop
  with the payment; attach a photo of the check.
- **Rules:** also needs the `driver_payments` add-on (enforced, granted by Platform Admin).
- **Where:** native `(driver)/route/stop/[stopId]/short-pick.tsx`, `payment.tsx`; api
  `routes/routes.controller.ts` (`completeWithPayment`), `invoices/invoices.controller.ts` (`uploadPaymentImage`).
- **Status:** DARK-HIDDEN `developer_mode`.

### UC-DRV-7 Capture a signature or photo as proof

- **Goal:** Prove the delivery happened.
- **Steps:** at the stop, take a signature or a photo; it is attached to the stop.
- **Where:** native `(driver)/route/stop/[stopId]/signature.tsx`, `photo.tsx`; api
  `routes/routes.controller.ts` (`attachPodArtifact`, `getStopPod`).
- **Status:** DARK-HIDDEN `developer_mode`.

### UC-DRV-8 Change an order at the door

- **Goal:** Fix quantities when the customer wants less or more.
- **Steps:** Adjust order or Edit items; change, remove or scan to add; save.
- **Rules:** each change is a change request approved at the stop; the server sets the price, the
  screen shows an estimate.
- **Where:** native `(driver)/route/stop/[stopId]/adjust.tsx`, `edit-items.tsx`; api
  `orders/orders.controller.ts` (change requests, `updateOrderItems`).
- **Status:** DARK-HIDDEN `developer_mode`.

### UC-DRV-9 Take a return at the stop

- **Goal:** Take goods back from the customer while I am there.
- **Steps:** open Return; pick lines and quantities; capture.
- **Rules:** uses the return gates (`flag.returns`, `orders_inline_returns`) and the driver credit cap.
- **Where:** native `(driver)/route/stop/[stopId]/return/index.tsx`; api `returns/returns.controller.ts`.
- **Status:** DARK-HIDDEN `developer_mode`.

### UC-DRV-10 Split an order's invoice at the stop

- **Goal:** Bill only part of an order now.
- **Steps:** pick the order; split; return to the stop.
- **Where:** native `(driver)/route/stop/[stopId]/split-invoice.tsx`; api `invoices/invoices.controller.ts`
  (`createPartialFromOrder`).
- **Status:** DARK-HIDDEN `developer_mode`.

### UC-DRV-11 Take a new order on the road

- **Goal:** Write an order for a customer I am visiting, or any customer.
- **Steps:** from a stop (linked to the run) or from the empty route screen; pick products; save.
- **Where:** native `(driver)/route/stop/[stopId]/new-order.tsx`, `(driver)/driver-new-order.tsx`; api
  `orders/orders.controller.ts`.
- **Status:** DARK-HIDDEN `developer_mode`.

### UC-DRV-12 Leave a note on a stop

- **Goal:** Tell the office something about a stop.
- **Steps:** open Note on the stop; write; save.
- **Where:** native `(driver)/route/stop/[stopId]/note.tsx`; api `routes/routes.controller.ts`.
- **Status:** DARK-HIDDEN `developer_mode`.

Not use cases: the native Cash tab and Messages screen show an honest "not live yet" empty state
(`(driver)/cash.tsx`, `components/MessagesScreen.tsx`).

## 6. Buyer (customer portal) (UC-BUY)

Actor: a buyer account (its own sign-in, separate from staff). One buyer can buy from several sellers;
each seller's portal is `buyer/portal/[seller]`. On staff endpoints the portal is `addon.buyer_portal`
(DARK-SWITCH); a seller's paused state is the one thing a buyer learns (`acceptingOrders`,
`buyer/buyer-capabilities.controller.ts`).

| Id        | Use case                                          | Status |
| --------- | ------------------------------------------------- | ------ |
| UC-BUY-1  | Make a buyer account and sign in                  | LIVE   |
| UC-BUY-2  | Connect to a seller                               | LIVE   |
| UC-BUY-3  | Browse a seller's products                        | LIVE   |
| UC-BUY-4  | Put products in a cart and order                  | LIVE   |
| UC-BUY-5  | Follow, change or cancel my order                 | LIVE   |
| UC-BUY-6  | See my invoices and statements                    | LIVE   |
| UC-BUY-7  | Pay online by card or tell the seller I paid cash | LIVE   |
| UC-BUY-8  | Reorder from a saved list                         | LIVE   |
| UC-BUY-9  | Keep favourite products                           | LIVE   |
| UC-BUY-10 | Restock my shelf from what runs low               | LIVE   |
| UC-BUY-11 | Get told when a product is back                   | LIVE   |
| UC-BUY-12 | Upload my licence                                 | LIVE   |
| UC-BUY-13 | Look after my account                             | LIVE   |
| UC-BUY-14 | Merge two buyer accounts                          | LIVE   |
| UC-BUY-15 | See my dashboard and deals                        | LIVE   |

### UC-BUY-1 Make a buyer account and sign in

- **Goal:** Get my own login to order from my suppliers.
- **Steps:** register; confirm the email (resend if needed); sign in with password or Google; reset a
  forgotten password.
- **Where:** web `buyer/register`, `buyer/verify-email`, `buyer/login`, `buyer/forgot-password`,
  `buyer/reset-password`; api `buyer/buyer-auth.controller.ts`.
- **Status:** LIVE.

### UC-BUY-2 Connect to a seller

- **Goal:** Link my account to a business I buy from.
- **Steps:** open an invite link and accept, or ask a seller to connect; pick a seller; disconnect later.
- **Rules:** a request waits for the seller's approval (UC-OFF-18).
- **Where:** web `buyer/invite/[token]`, `buyer/portal`; api `buyer/buyer.controller.ts` (`acceptInvite`,
  `requestSeller`, `disconnectFromSeller`).
- **Status:** LIVE.

### UC-BUY-3 Browse a seller's products

- **Goal:** Find what I want to buy.
- **Steps:** open Shop; filter by category; search; open a product.
- **Rules:** shows only products the seller made visible (UC-WH-5) at my prices.
- **Where:** web `buyer/portal/[seller]/shop`, `buyer/portal/[seller]/shop/[productId]`; api
  `buyer/buyer.controller.ts`.
- **Status:** LIVE.

### UC-BUY-4 Put products in a cart and order

- **Goal:** Send my order to the seller.
- **Steps:** add to cart; see the quoted total; place the order.
- **Rules:** the server prices the quote; selling restrictions and portal limits apply; a paused seller
  does not take orders.
- **Where:** web `buyer/portal/[seller]/cart`; api `buyer/buyer-quote.controller.ts`,
  `buyer/buyer.controller.ts` (`createOrder`).
- **Status:** LIVE.

### UC-BUY-5 Follow, change or cancel my order

- **Goal:** See where my order is and fix it if I need to.
- **Steps:** open Orders; follow tracking; edit items or reorder lines while allowed; ask for a change;
  cancel.
- **Where:** web `buyer/portal/[seller]/orders`, `buyer/portal/[seller]/orders/[id]`; api
  `buyer/buyer.controller.ts`.
- **Status:** LIVE.

### UC-BUY-6 See my invoices and statements

- **Goal:** See what I owe and download my papers.
- **Steps:** open Invoices or Finances; open an invoice; download a monthly or account statement PDF; see
  payments and remittance details.
- **Where:** web `buyer/portal/[seller]/invoices`, `buyer/portal/[seller]/invoices/[id]`,
  `buyer/portal/[seller]/finances`; api `buyer/buyer.controller.ts`.
- **Status:** LIVE.

### UC-BUY-7 Pay online by card or tell the seller I paid cash

- **Goal:** Pay my bill without phoning anyone.
- **Steps:** open Payments; pick the invoice; preview; pay by card, or declare a cash payment; cancel a
  pending one.
- **Rules:** card runs on the seller's connected account (UC-ADM-9); a cash declaration waits for the
  seller (UC-OFF-25); money goes to the chosen invoice first, then the oldest.
- **Where:** web `buyer/portal/[seller]/payments`; api `payment-requests/buyer-payments.controller.ts`.
- **Status:** LIVE.

### UC-BUY-8 Reorder from a saved list

- **Goal:** Order my usual list again in one go.
- **Steps:** open Templates; edit a template; reorder from it; see standing orders.
- **Where:** web `buyer/portal/[seller]/templates`; api `buyer/buyer.controller.ts` (`getTemplates`,
  `reorderFromTemplate`, `getStandingOrders`).
- **Status:** LIVE.

### UC-BUY-9 Keep favourite products

- **Goal:** Find the products I buy most, fast.
- **Steps:** add or remove a favourite; open Favorites.
- **Where:** web `buyer/portal/[seller]/favorites`; api `buyer/buyer.controller.ts`.
- **Status:** LIVE.

### UC-BUY-10 Restock my shelf from what runs low

- **Goal:** See what I am running out of and add it to my order.
- **Steps:** open Shelf; snooze or unsnooze an item; add all low items.
- **Where:** web `buyer/portal/[seller]/shelf`; api `buyer/buyer.controller.ts` (`getShelf`,
  `getReplenishment`, `addAllLow`).
- **Status:** LIVE.

### UC-BUY-11 Get told when a product is back

- **Goal:** Hear when an out-of-stock product can be ordered again.
- **Steps:** subscribe on the product; unsubscribe later.
- **Where:** web `buyer/portal/[seller]/shop/[productId]`; api `buyer/buyer.controller.ts`
  (`subscribeStockAlert`), `stock-alerts/`.
- **Status:** LIVE.

### UC-BUY-12 Upload my licence

- **Goal:** Send the seller my licence so I can buy restricted products.
- **Steps:** open Licenses; upload; see which expire soon.
- **Where:** web `buyer/portal/[seller]/licenses`; api `buyer/buyer.controller.ts` (`submitAuthorization`).
- **Status:** LIVE.

### UC-BUY-13 Look after my account

- **Goal:** Keep my details and login safe.
- **Steps:** edit profile; change password; see and end sessions; delete my account.
- **Where:** web `buyer/portal/[seller]/account`, `buyer/portal/settings`, `buyer/change-password`; api
  `buyer/buyer-auth.controller.ts`.
- **Status:** LIVE.

### UC-BUY-14 Merge two buyer accounts

- **Goal:** Join two logins that are really the same business.
- **Steps:** start a merge; confirm from the email link.
- **Rules:** Platform Admin can also review merge requests (UC-PLT-10).
- **Where:** web `buyer/verify-merge`; api `buyer/buyer-merge.controller.ts`.
- **Status:** LIVE.

### UC-BUY-15 See my dashboard and deals

- **Goal:** See my recent buying and the seller's current deals.
- **Steps:** open Dashboard.
- **Where:** web `buyer/portal/[seller]/dashboard`; api `buyer/buyer.controller.ts` (`getDashboard`,
  `getAnalytics`, `getPromotions`).
- **Status:** LIVE.

## 7. Super admin (platform) (UC-PLT)

Actor: `SUPER_ADMIN`. Screens under `apps/web/app/(platform-admin)/admin/`; most endpoints in
`apps/api/src/platform-admin/platform-admin.controller.ts`. No mobile surface (the app blocks this role).

| Id        | Use case                                        | Status |
| --------- | ----------------------------------------------- | ------ |
| UC-PLT-1  | Sign in to Platform Admin                       | LIVE   |
| UC-PLT-2  | See how the platform is doing                   | LIVE   |
| UC-PLT-3  | Create a business                               | LIVE   |
| UC-PLT-4  | Change a business's status, plan or trial       | LIVE   |
| UC-PLT-5  | Decide which features a business gets           | LIVE   |
| UC-PLT-6  | Turn add-ons on, off or free                    | LIVE   |
| UC-PLT-7  | Sign in as a business to help them              | LIVE   |
| UC-PLT-8  | Set a business's price and collect what it owes | LIVE   |
| UC-PLT-9  | Edit plans and their prices                     | LIVE   |
| UC-PLT-10 | Look after buyer accounts                       | LIVE   |
| UC-PLT-11 | Read the audit log                              | LIVE   |
| UC-PLT-12 | Set up AI and watch its cost                    | LIVE   |
| UC-PLT-13 | Set app links and automatic locks               | LIVE   |
| UC-PLT-14 | Look after my admin profile                     | LIVE   |

### UC-PLT-1 Sign in to Platform Admin

- **Goal:** Get into the platform console.
- **Steps:** open Admin login; sign in with password or Google.
- **Where:** web `(auth)/admin-login` (`admin/login` redirects), `(auth)/platform/auth/callback`; api
  `auth/platform-google-auth.controller.ts`.
- **Status:** LIVE.

### UC-PLT-2 See how the platform is doing

- **Goal:** See how many businesses we have and how they grow.
- **Steps:** open Dashboard; read stats and growth.
- **Where:** web `(platform-admin)/admin/dashboard`; api `platform-admin.controller.ts` (`getStats`,
  `getGrowthStats`).
- **Status:** LIVE.

### UC-PLT-3 Create a business

- **Goal:** Set up a new business on RouteFlow by hand.
- **Steps:** New tenant; enter details, plan and free add-ons; create the first admin.
- **Where:** web `(platform-admin)/admin/tenants/new`; api `platform-admin.controller.ts` (`createTenant`,
  `createTenantAdmin`).
- **Status:** LIVE.

### UC-PLT-4 Change a business's status, plan or trial

- **Goal:** Keep each business on the right plan and state.
- **Steps:** open the tenant; change status (trial, active, read-only, suspended, cancelled), plan or
  class; extend a trial; start a manual subscription; reset the admin's password; delete.
- **Where:** web `(platform-admin)/admin/tenants`, `(platform-admin)/admin/tenants/[id]`; api
  `platform-admin.controller.ts`.
- **Status:** LIVE.

### UC-PLT-5 Decide which features a business gets

- **Goal:** See and set exactly what one business can use.
- **Steps:** open the tenant's feature console; read the registry and the effective features; preview,
  apply and undo changes; grant or deny with an override; apply a business profile or capabilities;
  restore a config snapshot; switch the entitlements mode.
- **Rules:** every grantable key is a row in `apps/api/src/billing/feature-registry.ts`.
- **Where:** web `(platform-admin)/admin/tenants/[id]/_features/FeatureConsole.tsx`; api
  `platform-admin.controller.ts`, `billing/feature-config.controller.ts`.
- **Status:** LIVE.

### UC-PLT-6 Turn add-ons on, off or free

- **Goal:** Give a business an add-on, take it away, or stop charging for it.
- **Steps:** on the tenant, enable, comp, uncomp or disable an add-on.
- **Rules:** a new add-on gate ships dark and is enforced only after the blast-radius report
  (`apps/api/scripts/report-addon-gate-blast-radius.mjs`).
- **Where:** web `(platform-admin)/admin/tenants/[id]`; api `platform-admin.controller.ts`.
- **Status:** LIVE.

### UC-PLT-7 Sign in as a business to help them

- **Goal:** See exactly what a business sees to fix their problem.
- **Steps:** on the tenant, impersonate; work as their admin; leave.
- **Rules:** the session carries `TENANT_ADMIN`; its write operations are logged for audit.
- **Where:** web `(platform-admin)/admin/tenants/[id]`, `handoff`; api `platform-admin.controller.ts`
  (`impersonate`).
- **Status:** LIVE.

### UC-PLT-8 Set a business's price and collect what it owes

- **Goal:** Charge each business the right amount and catch up missed payments.
- **Steps:** set a tenant price override; see the impact; read the catch-up plan (a dry run); open a hosted
  payment page for it; open the tenant's billing portal.
- **Where:** web `(platform-admin)/admin/tenants/[id]/_components/TenantPricingCard.tsx`; api
  `platform-admin.controller.ts`, `platform-admin/catchup-admin.controller.ts`.
- **Status:** LIVE.

### UC-PLT-9 Edit plans and their prices

- **Goal:** Change what each plan includes and costs.
- **Steps:** open Plans; create a draft version; edit the definition and SKUs; publish or discard; see
  billing overview and MRR.
- **Where:** web `(platform-admin)/admin/plans`, `(platform-admin)/admin/billing`; api
  `billing/plan-admin.controller.ts`, `billing/billing.controller.ts`.
- **Status:** LIVE.

### UC-PLT-10 Look after buyer accounts

- **Goal:** Fix buyer logins and their links to businesses.
- **Steps:** open Buyers; search; change status; edit; add or remove a link to a business; sign in as a
  buyer; review and run or reject merge requests.
- **Where:** web `(platform-admin)/admin/buyers`, `(platform-admin)/admin/buyers/[id]`,
  `(platform-admin)/admin/buyers/merge-requests`, `(platform-admin)/admin/buyers/merge-requests/[id]`; api
  `buyer/buyer-admin.controller.ts`, `buyer/buyer-admin-merge.controller.ts`.
- **Status:** LIVE.

### UC-PLT-11 Read the audit log

- **Goal:** See who did what and when.
- **Steps:** open Audit logs; filter by facets.
- **Where:** web `(platform-admin)/admin/audit-logs`; api `platform-admin.controller.ts` (`getAuditLogs`).
- **Status:** LIVE.

### UC-PLT-12 Set up AI and watch its cost

- **Goal:** Run the AI scanner and keep its cost in check.
- **Steps:** Settings; set the AI config and test it; read usage, overall and by business. A
  per-business AI cap endpoint (`setTenantAiCap`) has no screen.
- **Where:** web `(platform-admin)/admin/settings` (`AiUsageByBusinessCard.tsx`); api
  `platform-admin.controller.ts`, `platform-admin/ai-usage-admin.controller.ts`.
- **Status:** LIVE.

### UC-PLT-13 Set app links and automatic locks

- **Goal:** Point the apps at the right store pages and set when accounts lock themselves.
- **Steps:** edit app links; preview and set auto locks.
- **Where:** web `(platform-admin)/admin/settings`, `(platform-admin)/_components/AutoLocksCard.tsx`; api
  `platform-admin.controller.ts`, `platform-admin/auto-locks-admin.controller.ts`.
- **Status:** LIVE.

### UC-PLT-14 Look after my admin profile

- **Goal:** Keep my own admin login details right.
- **Steps:** open Profile; edit.
- **Where:** web `(platform-admin)/admin/profile`.
- **Status:** LIVE.

## Server capabilities with no screen on master

These endpoints are on master but no web or app screen calls them. They are not counted as use cases.

| Capability                                                                                           | Who           | Where (api)                                                                                    | Gate                    |
| ---------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------- | ----------------------- |
| Onboarding cases: steps, auto-checks, intake link, file review                                       | Super admin   | `onboarding/onboarding.controller.ts`                                                          | none                    |
| Public onboarding intake form and demo booking                                                       | Prospect      | `onboarding/public-onboarding.controller.ts`, `demo-booking/public-demo-booking.controller.ts` | none                    |
| RouteFlow's own invoices to businesses (issue, send, mark paid, void)                                | Super admin   | `platform-admin/rf-invoices.controller.ts`                                                     | none                    |
| Entitlement sweep page                                                                               | Super admin   | `platform-admin/entitlement-sweep.controller.ts`                                               | none                    |
| Driver and dispatcher message threads                                                                | Staff, driver | `messages/messages.controller.ts`                                                              | `flag.messaging` (dark) |
| Customer message threads and one-off sends                                                           | Staff         | `messaging/messaging.controller.ts` (`send`, `listThreads`)                                    | none                    |
| Mixed packs: set up a recipe that sells a fixed mix as one product (orders show its component lines) | Staff         | `products/recipes.controller.ts`                                                               | none                    |
| Clear all financial data                                                                             | Admin         | `system-config/settings.controller.ts` (`clearFinancialData`)                                  | none                    |

## Not yet built / planned

Named as planned in `.claude/roadmap/features.jsonl` (status `planned`) or as "Not available yet" in
`apps/api/src/billing/feature-registry.ts`. None of these is a feature today.

| Id        | Item                                                      | Source                        | What the code has today                                                             |
| --------- | --------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| PLANNED-1 | Live dispatch board of every route and driver on the road | registry `flag.dispatch_live` | the day board, UC-OFF-33                                                            |
| PLANNED-2 | Single sign-on and API-key access for a business          | registry `flag.api_sso`       | nothing                                                                             |
| PLANNED-3 | Delivery notifications by SMS with a tracking link        | roadmap F-17                  | email notifications only (UC-ADM-12); SMS has no transport                          |
| PLANNED-4 | QuickBooks Online sync                                    | roadmap F-18                  | a connector stub for one-off import only (`import/connectors/source-connectors.ts`) |
| PLANNED-5 | Guided mobile picking                                     | roadmap F-19                  | an empty "not wired yet" screen (`apps/mobile/app/(operator)/pick.tsx`)             |
| PLANNED-6 | More than one warehouse, and transfers between them       | roadmap F-20                  | no location, branch or warehouse model                                              |
| PLANNED-7 | Manufacturer-format filings and purchase-time excise tax  | roadmap F-21                  | filings and excise at time of sale (UC-OFF-39)                                      |
| PLANNED-8 | Orders taken at the customer's location                   | roadmap F-24                  | not checked beyond the order screens                                                |
| PLANNED-9 | Fewer taps at a cash stop in the driver app               | roadmap F-26                  | the native stop flow, UC-DRV-6 (`DARK-HIDDEN`)                                      |

## What this doc could not verify

- **The production value of `PLAN_FLAG_ENFORCEMENT`.** It decides whether the `DARK_PLAN_FLAGS` rows
  are enforced for non-`LITE` plans, and it is not in the repo. A comment in
  `apps/api/src/billing/plan-flag-policy.ts:30` records that production switched it on on 2026-09-17. If
  so, the nine `DARK-SWITCH` rows (eight plan flags) and the credit-limit check in UC-OFF-2 are enforced
  there for every non-`LITE` business whose plan does not carry the flag. The six `DARK-OPEN` rows do not
  depend on it.
- **Per-business grants.** Which businesses hold which add-on or override lives in the database, not
  in code.
- **The ops board.** The Plane boards (OPS, ROAD) are not readable from the repo; the planned list uses
  the in-repo roadmap and registry only.
- **The staff-app CUSTOMER role.** `nav-config.ts` still has a menu for a `CUSTOMER` login inside the
  staff web app (My Orders, Returns, Invoices); this doc treats the buyer portal as the buyer surface.
- **Native screens with the shell off.** The native operator and customer screens are not described
  one by one; store builds run the web shell.
