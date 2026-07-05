# RouteFlow Web — Inventory

**Purpose.** This is the single source of truth for **what the current, working RouteFlow web app
(`apps/web`) does** — every surface, page, action, flow, state, and business rule — written to
drive a **full UI redesign** into one consistent visual system. It documents _behavior and data_,
deliberately **not** visual styling (the redesign owns the visuals). When you design a new screen,
find its entry here and preserve every action, data field, state, and rule listed. Improvement
ideas are allowed but must be quarantined in a **💡 Faster ways** block, never silently baked in.

This mirrors the format of [`../mobile-inventory/`](../mobile-inventory/). Web differs from mobile:
no bottom tabs (left sidebars / top nav instead), no offline queue or GPS tracking, desktop
keyboard affordances (Cmd+K, `?` shortcuts), and print/PDF/CSV export.

---

## Why this redesign exists

The app grew organically and now **looks like pieces from different apps**. Confirmed at the code
level (see the [Design-inconsistency catalogue](#design-inconsistency-catalogue) below): three
unrelated hardcoded auth screens, four+ competing token systems, and two conflicting design
languages already sitting in Claude Design. The redesign unifies all of it. A naive "point Claude
Design at the repo" pass previously missed most features — this inventory is the completeness
guarantee that prevents that.

---

## Personas

| Persona                                | Role value(s)                            | Job to be done                                                                                                 |
| -------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Operator**                           | `OPERATOR`                               | Day-to-day wholesale ops: take orders, build/dispatch routes, invoice, chase AR.                               |
| **Tenant Admin**                       | `TENANT_ADMIN`                           | Everything an operator can do + settings, users, addons (e.g. tobacco), branding.                              |
| **Customer** (staff-side limited role) | `CUSTOMER`                               | A tenant login scoped to their own orders/invoices/returns only.                                               |
| **Driver**                             | `DRIVER`                                 | Sees assigned routes/runs; completes stops + POD. (Web view is thin; mobile is primary.)                       |
| **Buyer** (B2B retailer)               | buyer account (separate token namespace) | Self-serve portal: shop a seller's catalog, cart→order, view invoices/finances, standing orders. Multi-seller. |
| **Super-Admin**                        | `SUPER_ADMIN`                            | Platform owner: tenants, buyers, plans, billing, audit, impersonation.                                         |

---

## App-wide model

- **Multi-tenancy.** Everything operator-side is tenant-scoped. Tenant context rides in a
  **non-httpOnly** cookie (JS-readable — required; httpOnly silently breaks login) →
  `X-Tenant-Slug` header on the API client. Subdomain (e.g. `affa.routeflow.info`) or manual slug
  entry selects the workspace. `middleware.ts` redirects to `/login?slug=…` when missing.
- **RBAC.** JWT payload carries `tenantId` + `role`. `(dashboard)/layout.tsx` gates paths by role
  (CUSTOMER and DRIVER see a reduced nav/path set). Super-admin is fully isolated in
  `(platform-admin)`.
- **Three isolated token namespaces** (`lib/auth-keys.ts`): `OP_KEYS` (operator), `BUYER_KEYS`
  (buyer portal — isolated per RF-220), `superAdminToken`/`superAdminRefreshToken` (platform).
  Prevents cross-context bleed. Three matching API clients: `api-client.ts`, `buyer-api-client.ts`,
  `admin-api.ts`. 401 → refresh-queue-retry interceptor.
- **Impersonation.** Super-admin can impersonate a tenant (`impersonationToken` +
  `impersonationTenantSlug`); operator dashboard shows a red banner + "Exit impersonation"; the
  impersonation token is **read-only** (writes blocked — CC-05).
- **Realtime.** Socket.io → TanStack Query invalidation (`lib/hooks/useRealtimeUpdates.ts`).
  Events: `order.created`, `order.urgent.placed`, `order.statusChanged`, `route.stop.completed`,
  `driver.status.updated`, `inventory.low.stock`, `return.created`, `invoice.updated`,
  `creditNote.created`. Some fire toasts (urgent orders, low stock, driver status).
- **Money discipline.** All line/tax/total math flows through `lib/pricing.ts`
  (`computeLineSubtotal` boxed proration, `normalizeBoxesPieces`, `roundMoney`) — mirror of the API
  helper. Every displayed amount is `$X.XX`; invoice **total = subtotal + tax** (±$0.01). Locked by
  `e2e/06-critical-paths.spec.ts` (CP-01…09). Never re-derive `qty * unitPrice` for a boxed line.
- **Addon gating.** `useHasAddon("tobacco_dealer")` (`lib/api/tobacco.ts`) splices the Tobacco nav item
  in at runtime and shows tobacco badges/warnings; only OPERATOR/TENANT_ADMIN.
- **Tenant branding.** `components/tenant-provider.tsx` fetches logo + primary color and injects
  `--primary` / `--primary-rgb` CSS vars; buttons/badges use `bg-brand-500` backed by the var.
  Refreshes on settings save; non-fatal if absent.
- **Line-discount convention.** Override = net `unitPrice` + `originalPrice` (strikethrough) +
  `discount:0`; never re-derive discount from originalPrice (double-counts).
- **Optional customer email.** Emailless customers get a `no-email+<uuid>@placeholder.local`
  sentinel on `User.email`; `Customer.email` stays null; never surface the sentinel.

---

## Doc conventions

- **`/route`** = URL path; **`apps/web/app/…`** = source file.
- **`{variable}`** = server data rendered; **"Quoted"** = literal UI text; **bold** = a control.
- **`useHook()`** = data/mutation hook; **`METHOD /endpoint {body}`** = API call.
- **`Component`** = React component name; **`status: VALUE`** = enum domain value.
- **`(RF-###)` / `(CP-##)`** = tracker/spec references.
- Per screen: **File · Purpose · Shows · Actions · States · Steps (wizards only)**. Per area:
  **Key flows · Use cases · Business rules & edge cases · Relevant files · 💡 Faster ways**.

---

## Screen map at a glance

All 105 page routes + 6 layouts, grouped by ecosystem. Each maps to exactly one section file.

### Ecosystem 1 — Auth & entry → [`01-auth-and-entry.md`](01-auth-and-entry.md)

- Operator: `/login`, `/signup`, `/signup/check-email`
- Super-admin: `/admin-login` **and** `/admin/login` ⚠️ _(two files — reconcile; see catalogue)_
- OAuth callbacks: `/platform/auth/callback`, `/auth/google/callback`, `/callback`
- Buyer: `/buyer/login`, `/buyer/register`, `/buyer/invite/[token]`, `/buyer/verify-merge`,
  `/buyer` (entry), `/buyer/change-password`
- Top-level: `/change-password`, `/verify-email`, `/contact`

### Ecosystem 2 — Marketing / public → [`02-marketing-site.md`](02-marketing-site.md)

- `/`, `/product`, `/company`, `/pricing`, `/retailers`, `/wholesalers`, `/distributors`
- Layout: `(marketing)/layout.tsx` + `marketing.css` (`[data-side]` retailer/wholesaler theming)

### Ecosystem 3 — Operator dashboard

- **Shell + overview** → [`03-operator-shell.md`](03-operator-shell.md): `(dashboard)/layout.tsx`,
  `/dashboard`
- **Orders** → [`04-op-orders.md`](04-op-orders.md): `/orders`, `/orders/[id]`, `/returns`,
  `/returns/[id]`, `/invoices/new` _(scan-to-add order builder)_
- **Dispatch & routes** → [`05-op-dispatch-routes.md`](05-op-dispatch-routes.md): `/dispatch`,
  `/routes`, `/routes/create`, `/routes/[id]`, `/routes/[id]/dispatch`, `/routes/templates/[id]`,
  `/routes/my-runs`
- **People** → [`06-op-people.md`](06-op-people.md): `/customers`, `/customers/create`,
  `/customers/[id]`, `/drivers`, `/drivers/[id]`
- **Warehouse** → [`07-op-warehouse.md`](07-op-warehouse.md): `/inventory`,
  `/inventory/movements`, `/products`, `/products/create`, `/products/[id]`, `/suppliers`,
  `/suppliers/[id]`, `/vendor-bills`, `/vendor-bills/[id]`, `/purchases`
- **Finance** → [`08-op-finance.md`](08-op-finance.md): `/finance` _(index)_, `/finance/dashboard`,
  `/invoices`, `/invoices/create`, `/invoices/[id]`, `/invoices/[id]/edit`, `/invoices/recurring`,
  `/invoices/recurring/new`, `/invoices/payments`, `/credit-notes`, `/credit-notes/[id]`,
  `/estimates`, `/estimates/[id]`, `/finance/expenses`, `/finance/expenses/new`,
  `/finance/payments`, `/finance/payments/[id]`, `/finance/reports`, `/finance/customers`,
  `/bookkeeping`, `/bookkeeping/[transactionId]`, `/shipments`
  _(Note: `/invoices/new` lives in `04` as the order builder.)_
- **Analytics & tobacco** → [`09-op-analytics-tobacco.md`](09-op-analytics-tobacco.md):
  `/analytics`, `/tobacco`
- **Settings** → [`10-op-settings.md`](10-op-settings.md): `/settings`, `/settings/import`

### Ecosystem 4 — Buyer B2B portal → [`11-buyer-portal.md`](11-buyer-portal.md)

- Shell: `buyer/layout.tsx`, `buyer/portal/layout.tsx`
- `buyer/portal`, `buyer/portal/settings`, `buyer/portal/[seller]` (entry),
  `[seller]/dashboard`, `/shop`, `/favorites`, `/cart`, `/orders`, `/orders/[id]`, `/invoices`,
  `/invoices/[id]`, `/finances`, `/templates`, `/account`

### Ecosystem 5 — Platform admin → [`12-platform-admin.md`](12-platform-admin.md)

- Shell: `(platform-admin)/layout.tsx`
- `/admin/dashboard`, `/admin/tenants`, `/admin/tenants/new`, `/admin/tenants/[id]`,
  `/admin/buyers`, `/admin/buyers/[id]`, `/admin/buyers/merge-requests`,
  `/admin/buyers/merge-requests/[id]`, `/admin/plans`, `/admin/billing`, `/admin/audit-logs`,
  `/admin/profile`, `/admin/settings`

### Cross-cutting → [`13-shared-patterns.md`](13-shared-patterns.md)

Shared UX kit + component inventory + realtime events + money invariants (see file).

### Proposed unified system → [`00-design-system.md`](00-design-system.md)

Written after all sections; the approval gate before any mockup is designed.

### Claude Design master prompt → [`CLAUDE-DESIGN-PROMPT.md`](CLAUDE-DESIGN-PROMPT.md)

The copy-paste prompt + dependency list to hand to Claude Design. Inlines the complete screen
checklist + non-negotiable features so nothing is missed. Build is run by you in Claude Design.

---

## Design-inconsistency catalogue

The concrete "different apps" problems the redesign must resolve. Full resolution table lands in
`00-design-system.md`; this is the raw evidence gathered from source.

| #   | Inconsistency                                                                                                                                                                                                                 | Where                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | **Three unrelated auth screens**, all hardcoded inline styles: operator (teal/cream + Instrument Serif, split-panel), super-admin (dark slate + indigo + Shield, single card), buyer (emerald gradient + serif, split-panel). | `(auth)/login`, `(auth)/admin-login`, `buyer/login`                                       |
| 2   | **Two super-admin login files** — likely a duplicate/legacy fork.                                                                                                                                                             | `(auth)/admin/login` + `(auth)/admin-login`                                               |
| 3   | **Four+ token systems**: dashboard `globals.css` (navy/blue Tailwind), marketing `.rf-marketing` scoped CSS (teal/cream), buyer palette (`buyer-*` emerald), plus per-screen hardcoded auth colors.                           | `app/globals.css`, `(marketing)/marketing.css`, `apps/web/tailwind.config.ts`, auth pages |
| 4   | **Two conflicting design languages already in Claude Design**: "editorial teal+cream" vs "glassy SF-Pro portal".                                                                                                              | Claude Design projects (external)                                                         |
| 5   | **Two invoice-creation entry points** with different UIs: `/invoices/new` (manual scan-to-add) vs `/invoices/create` (from existing order).                                                                                   | `(dashboard)/invoices/new`, `/create`                                                     |
| 6   | **Likely-legacy / overlapping routes**: `/shipments`, `/purchases` (vs `/vendor-bills`), `/finance/customers` (vs `/finance/dashboard` AR), `/finance` index vs `/finance/dashboard`.                                         | see paths                                                                                 |
| 7   | Empty states, skeletons, and sort affordances present on some list pages, absent on others (uneven polish).                                                                                                                   | multiple list pages                                                                       |

## Redirect stubs & consolidation (discovered during traversal)

A large share of the 105 page files are **not real screens** — they are redirect stubs or thin
derived views. This sharply lowers the real design surface and is itself a cleanup opportunity.
Confirmed from source:

| Route                                    | Reality                                                                                     | Suggested resolution                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `/finance`                               | one-line redirect → `/finance/dashboard`                                                    | drop as a page                                                    |
| `/finance/customers`                     | redirect → `/finance/reports?report=customer-balance`                                       | retire; overlaps dashboard AR                                     |
| `/shipments`                             | read-only `useInvoices({shipped:true})` list, not its own entity                            | fold into invoices as a "Shipped" filter                          |
| `/bookkeeping`                           | redirect → reports ledger; `[transactionId]` is a simplified card (no true double-entry GL) | keep detail, drop redirect                                        |
| `/invoices/payments`, `/invoices/create` | redirects                                                                                   | consolidate into invoices flow                                    |
| `/purchases`                             | renders nothing → `router.replace('/finance/expenses')`                                     | dead; remove                                                      |
| `/vendor-bills`                          | redirect → `/purchases`; real list lives in `/finance/expenses` (Inventory tab)             | unify into one "Bills & Purchasing" hub with `/vendor-bills/[id]` |
| `/distributors`                          | server `redirect('/wholesalers')` + orphaned dead theming                                   | remove, keep `/wholesalers`                                       |
| `/admin/login`                           | 6-line redirect stub → `/admin-login`                                                       | delete stub; one canonical path                                   |
| `/callback`                              | strictly weaker legacy clone of `/auth/google/callback`                                     | remove                                                            |
| `/buyer`                                 | redirect → `/retailers`                                                                     | keep as entry redirect or replace                                 |
| `/customers/create`                      | RF-203 redirect (create happens via `CustomerFormModal`)                                    | keep modal, drop route                                            |

Corrected facts folded into the sections: `/finance/payments` = payments **received** (AR), not
payments-out; estimate statuses are `DRAFT/SENT/ACCEPTED/DECLINED/EXPIRED/VOID`; invoices also carry
`VIEWED`/`WRITTEN_OFF`; route runs use `SCHEDULED→IN_PROGRESS→COMPLETED|CANCELLED` (no DRAFT/PLANNED);
web POD is read-only (capture is mobile-only); operator settings has **8** tabs and no brand-color
picker (color is set super-admin-side); addon helpers live in `lib/api/tobacco.ts`.

**⚠️ Money-discipline divergence (possible bug, not just design):** `/invoices/new` (the "New sale"
order builder) computes lines as per-piece `qty*unitPrice − discount` via `POST /orders/sell`,
**bypassing** `computeLineSubtotal`'s boxed proration used everywhere else. Flag for the finance owner
independent of the redesign — see [`04-op-orders.md`](04-op-orders.md).

---

## Status

- [x] `01`–`13` section files authored & reviewed against the route list
- [x] Route-completeness check passes (every `page.tsx` documented; risky routes grep-verified)
- [x] `00-design-system.md` synthesized
- [x] **Approval gate** — unified system signed off (teal brand; appearance = Claude Design's call, applied consistently; consolidated target)
- [x] Claude Design master prompt + dependencies delivered ([`CLAUDE-DESIGN-PROMPT.md`](CLAUDE-DESIGN-PROMPT.md))
- [ ] Claude Design mockups built + verified — _run by user in Claude Design_
- [ ] Hand-off index (mockup → inventory entry → target route)
