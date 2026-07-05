# 12. Platform Admin — `(platform-admin)`

**Role(s):** `SUPER_ADMIN` (the RouteFlow platform owner) — a role **outside** the tenant RBAC
family. Super-admins are not tenant-scoped; they operate across *all* tenants, buyers, plans, and
billing. • **Entered via:** the super-admin login at `/admin-login` (documented in
[`01-auth-and-entry.md`](01-auth-and-entry.md); there are two login files, `(auth)/admin-login` and
`(auth)/admin/login` — see the README design-inconsistency catalogue). This file covers the
**authenticated panel** rooted at `/admin/*`.

**Isolation model (from the code).** The panel is a fully isolated ecosystem — its own layout
(`(platform-admin)/layout.tsx`), its own token namespace (`superAdminToken` /
`superAdminRefreshToken` in `localStorage`, **not** the operator `OP_KEYS` nor the buyer
`BUYER_KEYS`), and its own axios client (`lib/admin-api.ts` → `superAdminClient`) that talks to the
`/platform-admin/*` API surface. Nothing here rides the tenant `X-Tenant-Slug` cookie. An operator
who navigates to `/admin/dashboard` is bounced (CC-04); the guard only admits a JWT whose
`role === "SUPER_ADMIN"`.

**Visual identity.** Deliberately a *different app skin* from the rest of web: dark slate
(`bg-slate-950` / `bg-slate-900`) with an **indigo** accent and a **Shield** logo mark — versus the
navy/blue operator dashboard, teal/cream marketing, and emerald buyer portal. The redesign must
decide whether "platform admin = dark slate + indigo" stays a distinct theme or folds into one
system. Shared building blocks live in `(platform-admin)/_components/` (`AdminCard`, `AdminBadge`,
`AdminStatCard`, `AdminModal`, `AdminTabs`).

---

## Screens

### Panel shell (layout + guard) — `(platform-admin)/layout.tsx`

- **File:** `apps/web/app/(platform-admin)/layout.tsx`
- **Purpose:** The full-height two-pane shell for every `/admin/*` page: a fixed dark sidebar + a
  scrollable `<main>`. Wraps all children in a client-side `SuperAdminGuard`.
- **Shows:**
  - **Sidebar** (`w-60`, `bg-slate-900`): logo block — an indigo `Shield` tile + "RouteFlow" over
    the eyebrow "PLATFORM ADMIN". Then `NAV_ITEMS` (9 links, each an icon + label): **Dashboard**
    (`/admin/dashboard`), **Tenants** (`/admin/tenants`), **Buyers** (`/admin/buyers`), **Merge
    Requests** (`/admin/buyers/merge-requests`), **Plans & Features** (`/admin/plans`), **Billing**
    (`/admin/billing`), **Audit Logs** (`/admin/audit-logs`), **AI Settings** (`/admin/settings`),
    **My Account** (`/admin/profile`). Active item = `bg-indigo-600 text-white`; dashboard matches
    exact, others match by prefix.
  - **Footer:** a red-hover **Sign out** button.
- **Actions:** Nav links route within the panel. **Sign out** removes `superAdminToken` from
  `localStorage` and `router.push("/admin-login")`. *(Note: SA-11 e2e observes a push to the
  client route family `/admin[-/]login`; the handler here uses `/admin-login`.)*
- **States (guard):** On mount `SuperAdminGuard` reads `superAdminToken`. It `router.replace`s to
  `/admin-login` when the token is **missing**, **not parseable / not `SUPER_ADMIN`**, or
  **expired** (`payload.exp * 1000 < Date.now()`) — clearing the token in the latter two cases.
  Renders `null` until the check passes (no flash of admin content). CC-02 confirms an
  unauthenticated `/admin/dashboard` redirects to the login.
- **API client behavior (`lib/admin-api.ts`):** request interceptor attaches
  `Authorization: Bearer <superAdminToken>`. Response interceptor does a **silent refresh on 401**
  using `superAdminRefreshToken` against `POST /auth/refresh` (same queue pattern as the operator
  client); on refresh failure it clears both tokens and hard-redirects to `/admin-login`.

---

### Platform Dashboard — `/admin/dashboard`

- **File:** `apps/web/app/(platform-admin)/admin/dashboard/page.tsx`
- **Purpose:** The platform owner's at-a-glance health board across all tenants.
- **Shows:** Header "Platform Dashboard" + a **+ Create Tenant** link (→ `/admin/tenants/new`).
  Data comes from `GET /platform-admin/stats` and `GET /platform-admin/stats/growth?months=12`.
  - **4 stat cards** (`AdminStatCard`): **Total Tenants**, **Active**, **Trial**, **Total Users**
    (`stats.tenants.{total,active,trial}`, `stats.totalUsers`). *(Note: `stats.tenants.suspended`
    is in the payload type but not surfaced as a card.)*
  - **Tenant Growth (12 months)** — Recharts area chart of `{month, count}` new-tenant series.
  - **Plan Distribution** — donut/pie of `stats.planBreakdown` (`Record<plan, count>`), 5-color
    palette.
  - **Trials Expiring Soon** table — `stats.trialsExpiringSoon` (within 7 days); each row shows
    tenant name, plan badge, a computed `{N}d left` (red at ≤ 2 days), and a **View** link.
  - **At-Risk Tenants** table — `stats.atRiskTenants` with status + plan badges and **View**.
  - **Recent Tenants** table — `stats.recentTenants` (slug → detail link, name, status, plan,
    created date); "View all" → `/admin/tenants`.
- **Actions:** Create tenant; View → tenant detail; View all → tenants list.
- **States:** **Loading** — "Loading dashboard..."; **Error** — red banner with server message;
  empty variants per section ("No growth data yet", "No plan data yet", "No trials expiring within
  7 days.", "No at-risk tenants.", "No tenants yet"). SA-03 asserts a stat/card is visible.

---

### Tenants list — `/admin/tenants`

- **File:** `apps/web/app/(platform-admin)/admin/tenants/page.tsx`
- **Purpose:** The master roster of every tenant with inline lifecycle actions and bulk operations.
- **Shows:** Header "Tenants" + `{meta.total} total` + **+ Create New Tenant**. Data:
  `GET /platform-admin/tenants?page={p}&limit=200` → `{data, meta}` (200/page; filter & sort are
  **client-side** on the fetched page).
  - **Filter bar:** search (slug or business name), **status** select
    (ACTIVE / TRIAL / SUSPENDED / CANCELLED), **plan** select
    (STARTER / PROFESSIONAL / ENTERPRISE), a **Show deleted** toggle (CANCELLED tenants are hidden
    by default; the toggle shows a count), a results count, and **Clear filters**.
  - **Bulk actions bar** (appears when ≥ 1 row checked): "{n} selected", **Suspend All**,
    **Activate All**, **Change Plan**, **Clear selection**.
  - **Table** (sortable headers: slug, name, status, plan, users, createdAt): row checkbox, slug
    (mono), business name, status badge, plan badge, user count, created date, and an **Actions**
    cell — **View**, **Suspend/Reactivate**, **Impersonate**, and **Delete** (Delete only shown
    for SUSPENDED tenants). Pagination footer when `meta.pages > 1`.
- **Actions:**
  - **Suspend** → opens a confirm modal → `PATCH /platform-admin/tenants/{id}/status {status:"SUSPENDED"}`;
    **Reactivate** patches straight to `ACTIVE` (no modal).
  - **Impersonate** → `POST /platform-admin/tenants/{id}/impersonate`; stores
    `impersonationToken` + `impersonationTenantSlug` in `localStorage`, then `router.push("/dashboard")`.
  - **Delete** (SUSPENDED only) → modal requiring the operator to **type the exact slug** to enable
    the button → `DELETE /platform-admin/tenants/{id}` (permanently cancels + archives; optimistic
    row removal then refetch).
  - **Bulk** → loops the selected IDs firing per-tenant `status` / `plan` PATCHes (change-plan uses
    a plan picker in the modal), then refetches.
- **States:** loading / error banners; per-row `actionLoading` disables buttons; empty state is
  "No tenants match your filters." (filtered) or "No tenants yet. Create one" (unfiltered).
  SA-04/SA-05 assert rows render and search narrows them.

---

### Create tenant — `/admin/tenants/new`

- **File:** `apps/web/app/(platform-admin)/admin/tenants/new/page.tsx`
- **Purpose:** Provision a brand-new tenant + its first admin user in one form.
- **Shows:** "← Back to Tenants" + a single card form: **Slug** (URL identifier, lowercase),
  **Business Name**, **Admin Email**, **Admin Username**, **Admin Password** (show/hide eye toggle,
  "Min. 8 characters"), **Plan** select (STARTER / PROFESSIONAL / ENTERPRISE, default STARTER).
- **Actions:** Submit → `POST /platform-admin/tenants {slug, businessName, adminEmail,
  adminUsername, adminPassword, plan}`. On success shows a green "Tenant created successfully!"
  panel with the slug, then `router.push("/admin/tenants")` after ~2.5 s.
- **States:** submit button "Creating…" while `isLoading`; red panel on error (joins array
  validation messages). SA-06 fills the form by placeholder and asserts the new slug appears in the
  list.

---

### Tenant detail — `/admin/tenants/[id]`

- **File:** `apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx`
- **Purpose:** The full management console for one tenant — a **5-tab** surface (SA-07). Loads
  `GET /platform-admin/tenants/{id}` → `TenantDetail` (identity, subscription, counts, branding,
  address).
- **Header:** breadcrumb `Tenants / {businessName}` + status badge + plan badge.
- **Tabs (`AdminTabs`, rendered as buttons):** **Overview**, **Billing & Subscription**, **Addons &
  Features**, **Configuration**, **Audit Log**.

**Tab 1 — Overview**
- **Shows:** **Tenant Info** (ID, slug, business name, plan, status, created, `Trial Ends` with a
  color-coded days-left badge), **Usage Stats** (Users / Customers / Orders / Drivers / Routes
  counts), **Admin Account** section, **Quick Actions**, and **Recent Audit Logs** (last 5 via
  `GET /platform-admin/audit-logs?tenantId={id}&limit=5`; "View all" → `/admin/audit-logs?tenantId=`).
- **Admin Account** (`TenantAdminSection`, `GET /platform-admin/tenants/{id}/admin`): shows the
  tenant admin (username, email, status, force-password-change, created). If **no admin exists**, a
  red "cannot be impersonated" card offers **Create Admin Account** (`POST …/{id}/admin
  {username, email}`) which returns a **temporary password** shown once (share-securely note;
  forced change on next login).
- **Quick Actions:** **Suspend/Reactivate** (`toggle-status`), a plan picker + **Change Plan**
  (`PATCH …/{id}/plan {plan}`), **Impersonate** (`POST …/{id}/impersonate` — stores
  `impersonationToken` **and** `accessToken`, `impersonationTenantSlug`, sets the tenant cookie,
  then `window.location.href = "/dashboard"`), **Delete Tenant** (inline confirm →
  `DELETE …/{id}`), **Extend Trial** (days 1–365 → `POST …/{id}/extend-trial {days}`), and **Reset
  Admin Password** (`POST …/{id}/reset-admin-password` → temp password with a Copy button).
- **Impersonation edge case:** if the impersonate call errors with a message mentioning
  `tenant_admin`, the UI shows "⚠️ No admin account found… create one… then try again."

**Tab 2 — Billing & Subscription** (`BillingTab`)
- **Shows:** **Current Plan** (plan + status badges, trial days-left), **Subscription** detail from
  `tenant.subscription` (plan, period start/end, cancel-pending, and — when `externalPayment` —
  an "External Payment" chip + method label, payment ref, notes, Stripe customer ID).
- **Manual Activation** form (for payment received outside Stripe): plan, **payment method**
  (Zelle / Bank Transfer / Wire / Check / Cash / Other), **billing period** (30 / 90 / 180 / 365
  days), optional transaction ref + notes → `POST …/{id}/activate-subscription {plan, paymentMethod,
  paymentRef?, billingPeriodDays, notes?}`; sets status ACTIVE and records the payment.
- **Stripe Actions:** **Open Billing Portal** (`POST …/{id}/billing/portal` → opens `url` in a new
  tab) and **Create Checkout Session** (`POST …/{id}/billing/checkout` → shows the checkout URL).

**Tab 3 — Addons & Features** (`AddonsTab`, `GET …/{id}/addons`)
- **Shows:** a grid of 7 toggleable addon cards — `ai_scanning`, `advanced_routes`, `api_access`,
  `custom_branding`, `priority_support`, `advanced_reporting`, `tobacco_dealer` — each with a
  name/description and an on/off switch; active cards are indigo-tinted.
- **Actions:** enabling opens a confirm modal (note: "If Stripe is configured, a subscription item
  will be created") → `POST …/{id}/addons/enable {addonKey}`; disabling is immediate →
  `POST …/{id}/addons/disable {addonKey}`.

**Tab 4 — Configuration** (`ConfigTab`)
- **Shows:** **read-only** branding (Business Name, Primary Color swatch, Logo Key) + an
  **editable** Business Address & Contact form (street, city, state, zip, country, phone).
- **Actions:** Save → `PATCH …/{id}/config {addressLine1, city, state, zip, country, phone}`
  (button flips to "Saved ✓").

**Tab 5 — Audit Log** (`AuditLogTab`)
- **Shows:** a paginated (20/page) table of this tenant's audit entries
  (`GET …/audit-logs?tenantId={id}&page&limit=20`): action, entity type, entity ID (8-char),
  user (8-char), timestamp, IP.

- **States:** page-level Loading / Error (with "Back to Tenants"); per-action `actionLoading`;
  status messages surface in an indigo banner in Quick Actions.

---

### Buyers list — `/admin/buyers`

- **File:** `apps/web/app/(platform-admin)/admin/buyers/page.tsx`
- **Purpose:** Every customer-portal buyer account across the whole platform (buyers are
  cross-tenant — one buyer can be linked to many seller tenants).
- **Shows:** Header "Buyers". A 4-card stat strip from `GET /platform-admin/customer-links/stats`
  (**Total Buyers**, **Active**, **Suspended** = total − active, **Active Links**). List:
  `GET /platform-admin/buyer-accounts?page&limit=200` (client-side filter/sort). Filter: search
  (name/email) + status (ACTIVE / SUSPENDED / DELETED). Sortable table: name, email, **Verified**
  (email), status badge, **Sellers** (`_count.customerLinks`), joined date, and Actions (**Manage**,
  **Suspend/Reactivate**, **Delete**).
- **Actions:** **Manage** → buyer detail. Status changes go through native `window.confirm` then
  `PATCH /platform-admin/buyer-accounts/{id}/status {status}` (Suspend / Reactivate / Delete).
- **States:** loading / error / empty ("No buyers match your filters." | "No buyer accounts yet.").

---

### Buyer detail — `/admin/buyers/[id]`

- **File:** `apps/web/app/(platform-admin)/admin/buyers/[id]/page.tsx`
- **Purpose:** Manage one buyer — profile, status, impersonation, and the buyer's seller links.
  Loads `GET /platform-admin/buyer-accounts/{id}` → `Buyer` (with `customerLinks[]`).
- **Header:** name + status badge + "Email verified" pill; email; joined + ID. Quick-action
  buttons: **Impersonate** (ACTIVE only), **Suspend** (ACTIVE), **Reactivate** (SUSPENDED),
  **Delete** (any non-DELETED).
- **Impersonate:** `window.confirm` → `POST …/buyer-accounts/{id}/impersonate` → stores
  `buyerAccessToken` and `window.open("/buyer/portal", "_blank")` (opens the buyer portal in a new
  tab; the buyer is not notified).
- **Tab: Profile** — edit name / email / phone / mobile → `PATCH …/buyer-accounts/{id}` (changing
  email shows a "(will un-verify)" warning). "Reset changes" reloads; **Save** is disabled unless
  dirty. Below: Account Info metadata grid.
- **Tab: Seller Links (`{n}`)** — table of `customerLinks` (seller/tenant, customer record, status,
  linked date). **Disconnect** an ACTIVE link → `DELETE /platform-admin/customer-links/{linkId}`;
  **Reconnect** an inactive link → re-`POST …/{id}/links`. **Link to Seller** opens a modal:
  choose a tenant (`GET /platform-admin/tenants?limit=200`), then a customer record in that tenant
  (`GET …/{id}/tenant-customers?tenantId=`), then **Confirm Link** →
  `POST …/buyer-accounts/{id}/links {tenantId, customerId}`. The customer picker disables records
  already linked to this buyer and warns (yellow) if a record is linked to a **different** buyer —
  confirming reassigns it.
- **Actions:** status changes / delete via `PATCH …/status`; delete routes back to `/admin/buyers`.
- **States:** loading / error (with back link); alert()s on link/status failures; empty seller
  state with a "+ Link to a seller" CTA.

---

### Merge requests list — `/admin/buyers/merge-requests`

- **File:** `apps/web/app/(platform-admin)/admin/buyers/merge-requests/page.tsx`
- **Purpose:** Queue of duplicate-buyer merge requests awaiting admin review.
- **Shows:** GitMerge header + total count. Status filter (All / **Pending Verification** /
  **Pending Review** / **Completed** / **Rejected**). Table
  (`GET /platform-admin/buyer-merge-requests?page&limit=20&status`): primary account,
  secondary account, **Initiated By** (BUYER = "Buyer self-service", TENANT = "Tenant
  suggestion", SUPER_ADMIN = "Admin direct"; plus initiating-tenant name), color-coded status,
  created date, and a **Review** link → detail.
- **Actions:** filter, paginate, Review.
- **States:** spinner while loading; "No merge requests found." empty.

---

### Merge request review — `/admin/buyers/merge-requests/[id]`

- **File:** `apps/web/app/(platform-admin)/admin/buyers/merge-requests/[id]/page.tsx`
- **Purpose:** Side-by-side review of the two accounts and the merge preview, then execute or reject.
  Loads `GET /platform-admin/buyer-merge-requests/{id}` → detail incl. a computed `preview`.
- **Shows:** status pill; a meta strip (initiated-by, created / verified / completed / rejected
  timestamps); optional **Initiator notes**; two **AccountCards** — **Primary (kept)** and
  **Secondary (absorbed)** — each with email, status, whether a Google account is linked, and its
  seller connections. **Merge Preview:** **Links to transfer** (green), **Conflicting links — will
  disconnect** (yellow), plus Google-ID transfer/conflict callouts (secondary's Google ID is
  transferred if primary has none; disconnected if both have one). **Admin Notes** textarea.
- **Actions (only when `status === "PENDING_REVIEW"`):** **Execute Merge** (inline "cannot be
  undone" confirm → `POST …/{id}/execute`) or **Reject** (`POST …/{id}/reject {adminNotes}`). The
  notes field and buttons are disabled for non-reviewable statuses.
- **States:** spinner; "Merge request not found."; success/error banner after an action; refetch on
  completion.

---

### Plans & Features — `/admin/plans`

- **File:** `apps/web/app/(platform-admin)/admin/plans/page.tsx`
- **Purpose:** Static plan/pricing reference + live per-plan tenant counts. **Read-only** — this is
  a comparison matrix, not an editor (plan gating is enforced server-side; addons are toggled on
  the tenant detail page).
- **Shows:** 3 stat cards (Starter / Professional / Enterprise with `$/mo · $/yr` and live counts
  from `GET /platform-admin/stats → planBreakdown`), 3 pricing cards (Professional flagged "Most
  Popular", annual-savings %, active-tenant count), and a **Feature Comparison** matrix (13 rows:
  max users, max customers, orders/invoices, routes, returns, inventory/POs, route optimization, AI
  receipt scanning, API access, custom branding, advanced reporting, priority support, dedicated
  account manager) — check/✗/text per tier. Prices are **hardcoded** ($29/$79/$199 monthly).
- **Actions:** none (view only). SA-10 asserts the comparison renders.

---

### Billing Overview — `/admin/billing`

- **File:** `apps/web/app/(platform-admin)/admin/billing/page.tsx`
- **Purpose:** Platform revenue snapshot + all subscriptions. Loads
  `GET /platform-admin/billing/overview`.
- **Shows:** 4 stat cards — **Est. MRR** (client-computed: sum of hardcoded `PLAN_PRICES` over
  ACTIVE, non-cancel-pending subs), **Active Subscriptions**, **Cancel Pending**, **Trial
  Conversion** (`(total − trial)/total %`, sub-caption "N still in trial"). Then an **All
  Subscriptions** table: tenant (name + slug), status badge, plan badge, period end, cancel-pending,
  truncated Stripe ID, and a **View** → tenant detail.
- **Actions:** View a tenant. SA-09 asserts the page renders without crash.
- **States:** loading / error / "No subscription records found."
- **Note:** MRR/LTV/churn/forecast are **estimated client-side from plan prices**, not read from a
  Stripe revenue endpoint — the only server input is the subscription list.

---

### Audit Logs — `/admin/audit-logs`

- **File:** `apps/web/app/(platform-admin)/admin/audit-logs/page.tsx`
- **Purpose:** Platform-wide activity trail. Loads
  `GET /platform-admin/audit-logs?page&limit=50&{filters}`.
- **Shows:** a **Filters** card — Tenant ID, Action (e.g. LOGIN, CREATE), Entity Type, User ID, and
  **From / To** date pickers (all text inputs **debounced 400 ms**; page resets to 1 on change) +
  "Clear all" + total count. Table: tenant (8-char), user (8-char), action (mono), entity type,
  entity ID (8-char), timestamp, IP. Pagination footer.
- **Deep-link:** honors a `?tenantId=` query param on load (the tenant detail "View all" links here
  scoped to one tenant).
- **Actions:** filter / paginate. SA-08 asserts the table (or empty state) renders.
- **States:** loading / error / "No audit log entries found."

---

### My Account (profile) — `/admin/profile`

- **File:** `apps/web/app/(platform-admin)/admin/profile/page.tsx`
- **Purpose:** The super-admin's own account + active-session management.
- **Shows:** a Shield header, then **Active Sessions** (`GET /auth/sessions`) — one row per device
  with a device icon, device name + parsed browser, IP, signed-in / last-active (relative) and
  expiry (absolute), plus a **Revoke** button. A **Revoke all** button (with confirm) when > 1
  session.
- **Actions:** **Revoke** a session → `DELETE /auth/sessions/{id}`; **Revoke all** → revokes each
  session individually (deliberately not `/auth/logout`, to avoid nuking every device blindly).
- **States:** spinner / "Failed to load sessions." / "No active sessions found."
- **Note:** there is **no password-change form** on this page in the current code — the sidebar
  labels it "My Account"; the SA password reset/change lives elsewhere in auth. Session revocation
  is the only control here.

---

### AI Settings (platform settings) — `/admin/settings`

- **File:** `apps/web/app/(platform-admin)/admin/settings/page.tsx`
- **Purpose:** Platform-wide Claude AI configuration applied to all tenants by default. This is the
  "platform settings" surface today (the sidebar nav labels it **AI Settings**). Loads
  `GET /platform-admin/ai-config`.
- **Shows:** an **API Key Status** card (Configured / From env variable / Not configured, plus a
  masked `keyPreview`); an **Anthropic API Key** input (password with show/hide; blank = keep
  current; "Remove stored key" when sourced from DB → falls back to `ANTHROPIC_API_KEY` env); a
  **Default Model** radio list built from `config.availableModels` (tier hints: Opus = "Most
  capable", Sonnet = "Balanced", Haiku = "Fastest"); and a **Max Output Tokens** number field
  (256–32,768, default 4,096).
- **Actions:** Save → `PATCH /platform-admin/ai-config {model, maxTokens, apiKey?}` (apiKey only
  sent if the field was touched); Remove stored key → PATCH with `apiKey: ""` (confirm first).
- **States:** loading spinner; save error / "Settings saved successfully" banners.
- **Note:** despite the prompt's "feature flags / global config" framing, the only global config
  exposed here is AI (key / model / tokens). Per-tenant feature flags = the **addon toggles** on
  the tenant-detail Addons tab.

---

## Key flows (end-to-end)

- **Create + provision a tenant:** `/admin/tenants` → **+ Create New Tenant** →
  `/admin/tenants/new` → fill slug / business / admin email+username+password / plan →
  `POST /platform-admin/tenants` → success panel → auto-redirect to the list where the new slug
  appears (SA-06). The tenant's first admin user is created in the same call.
- **Impersonate a tenant + exit:** tenant list or detail → **Impersonate** →
  `POST /platform-admin/tenants/{id}/impersonate` → store `impersonationToken` +
  `impersonationTenantSlug` (detail also mirrors to `accessToken` + sets the tenant cookie) →
  land on `/dashboard`. The operator `(dashboard)/layout.tsx` renders a **red banner** "⚠️
  Impersonating **{slug}** — acting as Tenant Admin" with an **Exit impersonation** button that
  clears the tenant cookie + both impersonation keys and returns to `/admin/tenants`. The
  impersonation JWT is **read-only** — any write (e.g. `POST /orders`) returns **403** (CC-05).
- **Impersonate a buyer:** buyer detail → **Impersonate** (confirm) →
  `POST …/buyer-accounts/{id}/impersonate` → store `buyerAccessToken` → open `/buyer/portal` in a
  **new tab**.
- **Merge duplicate buyers:** Merge Requests → filter to **Pending Review** → open a request →
  review the two AccountCards + preview (links to transfer / conflicting links / Google-ID handling)
  → optionally add admin notes → **Execute Merge** (confirm, irreversible) or **Reject**. Admin can
  also proactively link/reassign a customer record from the buyer-detail Seller Links tab.
- **Change a plan:** tenant detail Overview → plan picker + **Change Plan**
  (`PATCH …/{id}/plan`), or **bulk** from the tenants list (**Change Plan** on selected rows). Plan
  counts on `/admin/plans` and `/admin/dashboard` reflect it.
- **Manually activate a paid tenant (non-Stripe):** tenant detail → **Billing** tab → Manual
  Activation → pick plan + payment method + billing period + ref/notes → **Activate Subscription**
  (sets status ACTIVE, records the external payment).

## Use cases

- As the **platform owner**, I want one board showing total/active/trial tenants, plan mix, growth,
  and at-risk/expiring trials so I know the health of the business. (`/admin/dashboard`)
- As the **platform owner**, I want to spin up a new tenant with its admin login in one form so a
  customer can start immediately. (`/admin/tenants/new`)
- As the **platform owner**, I want to step into a tenant's dashboard read-only to reproduce a
  support issue without being able to accidentally mutate their data. (Impersonate → red banner →
  Exit; writes 403.)
- As the **platform owner**, I want to suspend/reactivate/delete tenants and change their plans
  individually or in bulk so I can manage lifecycle and dunning. (`/admin/tenants`, tenant detail)
- As the **platform owner**, I want to record a Zelle/bank/check payment and activate a
  subscription outside Stripe. (tenant Billing tab → Manual Activation)
- As the **platform owner**, I want to review and merge duplicate buyer accounts, seeing exactly
  which seller links transfer or conflict, before committing an irreversible merge. (Merge Requests)
- As the **platform owner**, I want a filterable platform-wide audit trail (by tenant, action,
  entity, user, date) to investigate sensitive events. (`/admin/audit-logs`)
- As the **platform owner**, I want to set the default Claude model / key / token budget for all
  tenants. (`/admin/settings`)

## Business rules & edge cases

- **SA isolation & guard.** The panel is gated by a client guard that requires a valid,
  non-expired `superAdminToken` with `role === "SUPER_ADMIN"`; otherwise `router.replace` to the
  login. Operators are blocked from `/admin/*` (CC-04); unauthenticated hits redirect (CC-02). The
  super-admin token namespace (`superAdminToken`/`superAdminRefreshToken`) is separate from the
  operator and buyer namespaces — no cross-context bleed.
- **Read-only impersonation.** The impersonation JWT can *view* a tenant (or buyer portal) but
  **cannot write** — mutations 403 server-side (CC-05). The red operator banner + "Exit
  impersonation" is the only visible sign; exiting clears the impersonation keys and tenant cookie.
- **Tenant deletion is guarded twice.** Only **SUSPENDED** tenants show a Delete action; the list
  modal requires typing the exact slug; both entry points call `DELETE …/{id}` (a soft cancel +
  archive → status CANCELLED, surfaced via "Show deleted"), described as "cannot be undone".
- **Impersonation requires a tenant admin.** If a tenant has no admin user, impersonate fails with a
  `tenant_admin` message and the UI directs the operator to create one (Admin Account section →
  temp password, forced change on next login).
- **Audit logging of sensitive actions.** Tenant/plan/status changes, logins, impersonation, and
  suspensions land in the audit log (surfaced per-tenant on the detail Audit tab + recent-5, and
  platform-wide at `/admin/audit-logs`). IDs are shown truncated to 8 chars.
- **Merge conflict handling.** The review preview computes **links to transfer** vs **conflicting
  links (will disconnect)** and the **Google-ID** outcome (transfer if primary lacks one; disconnect
  the secondary's if both have one). Execute/Reject only enabled at `PENDING_REVIEW`; execute is
  irreversible.
- **Buyer email edit un-verifies.** Changing a buyer's email flags "(will un-verify)". Reassigning a
  customer record already linked to another buyer shows a yellow warning and moves the link on
  confirm.
- **Client-side list filter/sort with a 200-row page.** Both the tenants and buyers lists fetch
  `limit=200` and filter/sort in memory; larger platforms will page past 200 and lose cross-page
  filtering. Audit logs paginate server-side (limit 50) with debounced filters.
- **Estimated money.** Dashboard/billing MRR, plan revenue, and trial-conversion are computed
  client-side from **hardcoded** plan prices ($29/$79/$199), not a live Stripe revenue feed. Plans
  pricing + feature matrix are hardcoded constants in the page.
- **Two super-admin login files** exist (`admin-login`, `admin/login`) and Sign-out / SA-11 route
  to the `/admin[-/]login` family — a known inconsistency to reconcile in the redesign (README
  catalogue #2).

## Relevant files

- Shell + guard + API client: `apps/web/app/(platform-admin)/layout.tsx`, `apps/web/lib/admin-api.ts`
- Shared UI: `apps/web/app/(platform-admin)/_components/` (`AdminCard`, `AdminBadge`,
  `AdminStatCard`, `AdminModal`, `AdminTabs`)
- Dashboard: `apps/web/app/(platform-admin)/admin/dashboard/page.tsx`
- Tenants: `.../admin/tenants/page.tsx`, `.../tenants/new/page.tsx`, `.../tenants/[id]/page.tsx`
- Buyers: `.../admin/buyers/page.tsx`, `.../buyers/[id]/page.tsx`,
  `.../buyers/merge-requests/page.tsx`, `.../buyers/merge-requests/[id]/page.tsx`
- Plans / Billing / Audit / Profile / Settings: `.../admin/plans/page.tsx`, `.../admin/billing/page.tsx`,
  `.../admin/audit-logs/page.tsx`, `.../admin/profile/page.tsx`, `.../admin/settings/page.tsx`
- Impersonation banner (operator side): `apps/web/app/(dashboard)/layout.tsx`
- Login (separate section): `docs/web-inventory/01-auth-and-entry.md`
- E2E: `apps/web/e2e/01-super-admin.spec.ts` (SA-01…12), `apps/web/e2e/05-cross-cutting.spec.ts`
  (CC-02 unauth redirect, CC-04 operator blocked, CC-05 read-only impersonation)

---

## 💡 Faster ways

> Suggestions only — **not** current behavior. Quarantined here so the redesign can consider them
> without baking them in silently.

- **True bulk tenant actions (server-side).** Bulk suspend/activate/change-plan currently loops
  client-side one PATCH per tenant (N round-trips, partial-failure risk). A single
  `POST /platform-admin/tenants/bulk {ids, action, plan?}` would be atomic and faster, and could
  extend to bulk *impersonation-audit* export.
- **Impersonation quick-switch.** Instead of Exit → back to `/admin/tenants` → find the next tenant
  → Impersonate, keep a small recent-tenants switcher in the impersonation banner (and a
  "return to admin" that lands back on the exact tenant you left).
- **Audit-log saved filters / views.** The audit page has 6 filters but no way to save a common
  query (e.g. "all IMPERSONATE actions last 7 days"). Named saved filters + a CSV/PDF export and a
  quick "action" dropdown (populated from known action enums instead of a free-text field) would
  make investigations repeatable.
- **List filtering beyond one page.** Move tenant/buyer search + status/plan filters server-side so
  they work across the whole platform rather than the first 200 rows.
- **Real revenue instead of estimates.** Surface MRR/LTV/churn/forecast from an actual billing
  aggregation endpoint rather than summing hardcoded plan prices, so external-payment tenants and
  addons are counted.
- **Consolidate the "Settings" story.** `/admin/profile` is session-only and `/admin/settings` is
  AI-only; a unified platform-settings area (profile + password + AI + feature-flag defaults +
  global config) would remove the "My Account has no account controls" surprise.
