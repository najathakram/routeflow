# RouteFlow Mobile — Feature, Screen & Flow Reference

> **Purpose.** This is the single source of truth for **what the current, working RouteFlow
> mobile app does** — every role, screen, action, flow, state, and business rule — written to
> drive the **UI redesign of the next version**. It documents _behavior and data_, deliberately
> not visual styling (the redesign owns the visuals). When you design a new screen, find its
> entry here and preserve every action, data field, state, and rule listed.

**Snapshot:** current `master` (post PR #114 products-list-limit; includes #113 tobacco compliance,
#111 weighted-average cost). App: Expo / React Native (expo-router), ~120 screens across 5 route
groups. Web is a secondary target (react-native-web, clamped to a phone frame).

---

## How to read this document

The detail lives in nine section files (linked below). Every screen is documented with a fixed
template:

- **File** — the source route file.
- **Purpose** — one line.
- **Shows** — the real data/fields rendered (field names, KPIs, badges, statuses).
- **Actions** — every interactive control → what it does (navigation target _or_ the real hook /
  endpoint it calls, e.g. `useConfirmOrder → PATCH /orders/:id/status`).
- **States** — loading, empty, error, offline/queued, pull-to-refresh, role/permission/addon gating,
  terminal-status read-only.
- **Steps** — numbered sub-steps for any wizard/flow.
- Each area also lists **Key flows**, **Use cases**, and **Business rules & edge cases**.

---

## The four personas

| Persona                | Role group   | Who they are                                                      | Core job-to-be-done                                                               |
| ---------------------- | ------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Operator / Manager** | `(operator)` | Back-office staff at a wholesaler/distributor                     | Approve orders, dispatch routes, manage inventory & customers, invoice & collect  |
| **Driver**             | `(driver)`   | Delivery driver in the van                                        | Run today's route: navigate, deliver, capture proof + cash, handle returns        |
| **Buyer / Shop**       | `(customer)` | A retail customer (café, deli, grocer) buying from the wholesaler | Reorder stock, track deliveries, pay invoices, report problems                    |
| **Tenant Admin**       | `(tenant)`   | Business owner / org admin                                        | Operator capabilities + org-level oversight (today, dispatch, finance, warehouse) |

Two roles are **blocked** on mobile and routed to a "not supported" screen: `SUPER_ADMIN` and the
legacy `CUSTOMER` staff role (the B2B buyer portal is the supported customer surface).

---

## App-wide model every screen inherits

These cross-cutting behaviors are assumed by every section; design them once, consistently.

### Roles & routing

- One root effect (`app/_layout.tsx`) decides the route group from session state: buyer →
  `(customer)`, staff `activeRole` operator → `(operator)`, driver → `(driver)`. Dual-role staff
  (operator **and** driver) pick via a **role-picker** and can switch (`activeRole`).
- Deep links are honored (a link to `/invoices/:id` survives login via `returnTo`; shared
  operator/customer paths are remapped to the operator variant).

### Multi-tenancy & branding

- Every staff session is scoped to a **tenant slug** ("company code"), sent as `X-Tenant-Slug`.
- Per-tenant **branding** is available (`businessName`, `primaryColor`, `logoKey`) — the redesign
  should theme the accent/brand from `primaryColor`.

### Authentication

- **Staff:** company code → username/password (+ "Remember me") **or** Google OAuth. Drivers get a
  setup code. Forced password rotation (`forcePasswordChange`) pins the user to a change screen.
- **Buyer:** email/password **or** Google; a **multi-seller** account switches between suppliers
  (`activeSeller`) — "one login, all your suppliers."
- Tokens are **role-namespaced** (operator / driver / buyer buckets) with silent refresh on 401.

### Navigation shell

- Each role has a **5-tab bottom bar** (`IosTabBar`) + stacked detail screens with a top `NavBar`
  (large title on roots, inline title + back on detail). Some screens are hidden from the bar and
  reached from menus. Operator re-tap of a tab pops its stack to root.

### Offline-first (driver-critical)

- Driver mutations (deliver, cash, POD, returns) **queue when offline** and **replay on reconnect**
  with idempotency keys; an **offline banner** shows the queued count. POD photo / signature / cash
  capture must work with no connectivity.

### Realtime

- Socket.IO per role invalidates live queries: `order.created/urgent/statusChanged`,
  `route.dispatched`, `route.stop.completed`, `driver.status.updated`, `inventory.low.stock`,
  `return.created`, `invoice.updated`, `creditNote.created`. Screens update without manual refresh.

### Money discipline (never regress)

- All line/tax/total math goes through `pricing.ts` (boxed proration, **integer boxes/pieces**,
  round every monetary write). Never re-derive `qty × unitPrice` for a boxed line.
- **Price-override convention:** an override is stored as a net `unitPrice` + an `originalPrice`
  (shown struck-through) with `discount: 0` — the UI must show the strikethrough, never re-derive
  the discount.
- Cost accounting is **weighted-average**; cost-basis edits are audited.

### Key domain statuses (drive most list filters & badges)

- **Order:** `PENDING → CONFIRMED → OUT_FOR_DELIVERY → DELIVERED` (or `CANCELLED`). Editing items /
  price is allowed only on non-terminal statuses (DRAFT/PENDING/CONFIRMED); terminal = read-only.
- **Route run:** `SCHEDULED → IN_PROGRESS → COMPLETED` (or `CANCELLED`).
- **Invoice:** open / due / overdue / paid / void. **Return:** requested / approved / rejected /
  received / refunded. **Purchase order:** draft / sent / partially-received / received / closed.

### Add-ons

- **Tobacco dealer** compliance is **addon-gated** (`useHasAddon("tobacco_dealer")`) — its screens
  and KPIs only appear for tenants with the addon.

---

## Table of contents (detailed sections)

| #   | Section                                                                  | File                                     |
| --- | ------------------------------------------------------------------------ | ---------------------------------------- |
| 1   | Authentication & App Entry (role routing)                                | [01-auth.md](01-auth.md)                 |
| 2   | Customer / Buyer Portal — `(customer)`                                   | [02-customer.md](02-customer.md)         |
| 3   | Driver App — `(driver)`                                                  | [03-driver.md](03-driver.md)             |
| 4   | Operator — Home, Dispatch, Orders                                        | [04-op-orders.md](04-op-orders.md)       |
| 5   | Operator — Money: Invoices, Finance, Expenses, Vendor Bills, Analytics   | [05-op-finance.md](05-op-finance.md)     |
| 6   | Operator — People: Customers, Drivers, Suppliers, Fleet, Messages        | [06-op-people.md](06-op-people.md)       |
| 7   | Operator — Warehouse & Inventory: Products, Stock, POs, Returns, Tobacco | [07-op-inventory.md](07-op-inventory.md) |
| 8   | Operator — Routes, Route Runs, Exceptions, Settings                      | [08-op-routes.md](08-op-routes.md)       |
| 9   | Tenant Admin — `(tenant)`                                                | [09-tenant.md](09-tenant.md)             |

---

## Screen map at a glance (route inventory)

- **(auth):** sign-in, login, customer-login, company-code, role-picker, google-callback,
  forgot-password, reset-password, force-change-password, operator-blocked.
- **(customer)** tabs: home, orders, catalog, invoices, more; + profile, change-password,
  orders/[id], orders/[id]/edit-items, orders/cart, invoices/[id], standing-orders.
- **(driver)** tabs: route, map, orders, cash, driver-menu; hidden: driver-messages,
  driver-profile, driver-change-password, driver-new-order; per-stop:
  route/stop/[stopId]/{index, photo, signature, payment, note, return, new-order, split-invoice}.
- **(operator)** tabs: home, dispatch, orders, warehouse, more (+ finance hidden); stacks:
  orders/[id](+edit-items, split-invoice), invoices/{index,[id],record-payment,create,new},
  customers/{index,new,[id],edit,addresses,catalog}, drivers/{index,new,add,[id],edit},
  products/{index,new,[id],edit,set-cost,adjust-stock,scan,adjust-picker},
  routes/{index,new,[id],edit,assign-driver,add-stop,map}, route-runs/[id](+packing-list),
  purchase-orders/{index,new,[id],receive,pick-product}, vendor-bills/{index,new,[id],scan},
  returns, movements, shipments, expenses/{index,new,[id]}, suppliers/{index,new,[id],edit},
  analytics, tobacco, fleet, exceptions, pick, new-order, messages, settings, profile,
  change-password.
- **(tenant)** tabs: today, dispatch, finance, warehouse, more.
