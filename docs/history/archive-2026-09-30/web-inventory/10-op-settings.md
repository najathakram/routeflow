# 10. Operator — Settings & Import

**Role(s):** `OPERATOR` + `TENANT_ADMIN` (both land in the same operator dashboard shell). •
**Entered via:** the sidebar **Settings** item → `/settings`, or a direct link to
`/settings/import`. • **Files:** `apps/web/app/(dashboard)/settings/page.tsx` (the tabbed
settings hub) and `apps/web/app/(dashboard)/settings/import/page.tsx` (a standalone Zoho-import
grid that mirrors the Import tab).

This is the tenant's back-office control panel: business identity, invoicing defaults, staff
accounts, data migration from Zoho, outbound email, AI key, and per-user account/security
controls. Everything is tenant-scoped; the settings blob is a single `/settings` record patched
tab-by-tab.

> **Accuracy notes vs. the redesign brief.** Three things the brief assumed are **not** in this
> page:
>
> - **No brand primary-color picker.** The settings page only uploads a **logo**. The tenant
>   `primaryColor` (which `tenant-provider.tsx` injects as `--primary`) is edited **super-admin
>   side** in `(platform-admin)/admin/tenants/[id]/page.tsx`, not here.
> - **No addon (tobacco) toggle.** `tobacco_dealer` and all other addons are enabled/disabled in
>   the same platform-admin tenant detail page (`AddonsTab`, `AVAILABLE_ADDONS`). Operators only
>   _consume_ the addon (nav item + `/tobacco` screen); they cannot toggle it.
> - **No "next invoice number" field or template picker.** Invoicing exposes a numbering
>   **prefix** + **payment-due days** + default **terms** + notes/T&C text — there is no explicit
>   sequence counter or PDF-template chooser in the UI.

---

## Screen: Settings hub — `/settings`

- **File:** `apps/web/app/(dashboard)/settings/page.tsx`
- **Purpose:** One Radix `Tabs.Root` hosting eight tabs. Page title set to "Settings" via
  `usePageTitle`. Column is width-capped (`max-w-5xl`, centered) so forms don't strand the right
  half of wide screens.
- **Tab set (in order):** **Business Profile** · **Notifications** · **User Management** ·
  **Import** · **Email** · **Invoicing** · **Integrations** · **My Account**.
- **Deep-linking:** initial tab comes from the URL query — `/settings?tab=account` opens My
  Account (`defaultTab` reads `?tab=`; default `"profile"`). Tab values: `profile`,
  `notifications`, `users`, `import`, `email`, `invoicing`, `integrations`, `account`.
- **Cross-flow toast:** on redirect back from the Google-link OAuth flow (`?linked=google`) it
  fires a "Google account connected!" success toast and strips the query param via
  `history.replaceState` (no navigation).
- **States:** each tab manages its own loading/empty/error; the shell itself has no loading state.

### Tab 1 — Business Profile (`BusinessProfileTab`)

- **Purpose:** Edit the tenant's identity, address, logo, and default tax rate.
- **Data:** reads `GET /settings` (React Query key `["settings"]`); saves via
  `PATCH /settings {…}`. Form is `react-hook-form` + `zod` (`profileSchema`), reset from
  `savedSettings` on load.
- **Shows — Card "Business Information":**
  - **Business Name** (`businessName`, required)
  - **Account Email** (`email`, valid email, required)
  - **Owner / Manager Name** (`ownerName`, required)
  - **Phone** (`phone`, min 7 chars)
  - **Customer-Facing Email** (`customerEmail`, valid email or empty) — helper "Used for invoices,
    order updates, and customer communications."
- **Shows — Card "Business Address":** an `AddressAutocomplete` **Street** field (Google Places;
  selecting a suggestion auto-fills city/state/zip), **City** (required), **State** (optional,
  placeholder "TX"), **ZIP Code** (regex `^\d{5}(-\d{4})?$`).
- **Shows — Card "Logo":** an 80×80 preview (priority: local preview → saved `branding.logoUrl`
  `object-contain` → fallback `/logo.svg`), copy "PNG, JPG, or WEBP under 5 MB. Recommended size:
  256 × 256 px.", and a **Choose File** button (accepts `image/png,image/jpeg,image/webp`).
- **Shows — Card "Tax Settings":** **Default Tax Rate** number input (0–100, step 0.01) with a
  trailing "%".
- **Actions:**
  - **Save Changes** → `PATCH /settings` → invalidates `["settings"]`, toast "Profile saved".
    Disabled while any field error exists.
  - **Choose File** → immediately shows a local `URL.createObjectURL` preview, then uploads the
    file as multipart (`logo` field) to `POST /tenants/me/config/branding/logo`. On success calls
    `refreshBranding()` (from `useTenant`) so the sidebar / login / invoice consumers update
    without a reload; toast "Logo uploaded — It will appear on new and existing invoices."
- **States:** logo button shows a spinner + "Uploading…" while `uploadLogo.isPending`; on upload
  error, drops the local preview and toasts the server message (fallback "Try a PNG, JPG, or WEBP
  under 5 MB."). SVG is **rejected server-side** (RF-076 — SVGs can embed scripts; logos are
  served inline).

### Tab 2 — Notifications (`NotificationsTab`)

- **Purpose:** Show driver push-notification status and send a test push.
- **Data:** `useNotificationsStatus()` (`GET`, returns `{ configured, deviceCount }`);
  `useSendTestNotification()` mutation.
- **Shows — Card "Push Notifications":**
  - A status row: bell icon, "Driver App Notifications", and either "{deviceCount} device(s)
    registered" + green **Active** badge, or "Push notifications are not configured" + amber
    **Not set up** badge.
  - If **not** configured: an explanatory paragraph ("Contact your system administrator to enable
    this feature.").
  - If configured: a **Notification Types** checklist — **Order Placed**, **Order Delivered**,
    **Payment Received** (all `defaultChecked`; ⚠️ display-only checkboxes, no persistence wired).
  - **Send Test Notification** button (disabled unless configured).
- **Actions:** **Send Test Notification** → `sendTest.mutate()` → toast "Test notification sent —
  Sent to {sent} of {deviceCount} device(s)."
- **States:** button `loading` while pending; disabled if not configured.

### Tab 3 — User Management (`UserManagementTab`)

- **Purpose:** List staff accounts and manage them (invite, edit role, activate/deactivate, reset
  password).
- **Data:** `useUsers()` → `GET /users` (`PaginatedResponse<AppUser>`);
  `useChangeUserStatus()` → `PATCH /users/:id/status`.
- **Shows:** a header row "{meta.total} users total" + **Add User** button, then a table:
  **Username** (mono) · **Email** · **Role** (`RoleBadge`) · **Status** (`Badge` ACTIVE/INACTIVE)
  · **Created** (localized date) · per-row action buttons.
  - **`RoleBadge`:** `TENANT_ADMIN` → **Admin** (info), `OPERATOR` → **Operator** (info),
    `DRIVER` → **Driver** (neutral).
  - **Row actions:** ✏️ **Edit user** (opens `EditUserModal`); a **toggle** button
    (`ToggleRight`/`ToggleLeft`) that flips status ACTIVE↔INACTIVE via `changeStatus.mutate`
    (green when active).
- **Add User modal (`AddUserModal`):** form (`addUserSchema`) — **Full Name**, **Role** (select:
  Driver / Operator; default Driver), **Username** (min 3, `^[a-z0-9_.]+$`; auto-derived from
  first+last name initials until the field is touched), **Email**. Submits via
  `useCreateOperator()` → `POST /users/operator {name,email,username}`. On success the modal flips
  to a **success view** showing the server-generated **temporary password** in a mono `code` block
  with a **copy** button; copy: "Share the temporary password. The user will be prompted to change
  it on first login."
- **Edit User modal (`EditUserModal`):** form (`editUserSchema`) — **Role** (Driver/Operator
  select; **shown read-only "Admin" for `TENANT_ADMIN`** with "Tenant admin role cannot be
  changed."), **Username**, **Email**. Saves via `useUpdateUser()` →
  `PATCH /users/:id {username,email,role}`. A **Reset Password** section
  (`useResetUserPassword()` → `POST /users/:id/reset-password`) reveals a new temp password +
  copy button.
- **States:** table shows "Loading users…", "No users found.", or rows. Toggle button disabled
  while `changeStatus.isPending`; failures toast "Failed to update status".
- **Roles createable here are only OPERATOR/DRIVER** — `TENANT_ADMIN` accounts exist but can't be
  created or re-roled from this UI. (`AppUser.role` also allows `CUSTOMER`, but that is not a
  createable option here.)

### Tab 4 — Import (`ImportTab`)

- **Purpose:** In-tab Zoho CSV import grid. See the **Import wizard** section below for the
  numbered steps — this tab and `/settings/import` share the same card/flow (this tab additionally
  has a bespoke `ProductsImportCard` that parses the Zoho Items CSV **client-side** and previews
  parsed rows before import).
- **Shows:** heading "Import from Zoho", a recommended-order banner ("Products → Customers →
  Inventory → Invoices → Payments → Expenses. Payments require matching invoices; Invoices require
  customers to exist first."), then a 2-column grid: `ProductsImportCard` + five `ImportCard`s
  (Customers, Inventory, Invoices, Payments, Expenses).

### Tab 5 — Email (`EmailSettingsTab`)

- **Purpose:** Configure the outbound SMTP sender used for customer emails (invoices, order
  updates).
- **Data:** `GET /settings/email` (`{ smtpHost, smtpUser, fromName, configured }` — password
  masked server-side); saves `POST /settings/email {…}`; tests `POST /settings/email/test
{toEmail}`.
- **Shows — two guided steps:**
  - **Step 1 — Choose your email provider:** two provider cards — **Gmail** (`smtp.gmail.com:587`,
    non-secure) and **GoDaddy** (`smtpout.secureserver.net:465`, secure). Selection is inferred
    from the saved `smtpHost` on load.
  - **Step 2 — Enter your credentials** (appears once a provider is picked): **Your name /
    business name** (`fromName`, sender display name), **email address** (provider-specific label
    & placeholder), **password/App Password** (masked, eye toggle; placeholder "Leave blank to
    keep current password" when already configured). A blue **help box** lists provider-specific
    steps (Gmail App Password / GoDaddy credentials) with an external link.
- **Actions:** **Save** → `POST /settings/email` (password omitted if blank so it isn't
  overwritten) → toast "Email settings saved". **Send Test Email** (only when already configured)
  → `POST /settings/email/test` → success/failure toast against the entered address.
- **States:** `isSaving`/`isTesting` button spinners; validation toasts for missing
  provider/email/password. When configured but no provider re-selected, shows a green "Email is
  configured and ready to send" banner.

### Tab 6 — Invoicing (`InvoicingTab`)

- **Purpose:** Invoice defaults applied to newly created invoices.
- **Data:** `useInvoiceSettings()` (`GET`, `{ defaultTerms }`) + `useUpdateInvoiceSettings()`
  (`PATCH`) for terms; **and** the shared `GET/PATCH /settings` blob for
  prefix/due-days/notes/T&C.
- **Shows — Card "Default Invoice Terms":** a **Payment Terms** select — Due on Receipt / Net 15 /
  Net 30 / Net 45 / Net 60 (default "Net 30"). Changing it saves **immediately** via
  `updateSettings.mutate({defaultTerms})` → toast "Invoice settings saved".
- **Shows — Card "Invoice Numbering":** **Invoice Number Prefix** (text, maxLength 10, e.g.
  "INV-", "2026-") and **Payment Due Days** (number 0–365, "0 = due on receipt"). Saved together
  by **Save Numbering** → `PATCH /settings {invoicePrefix, paymentDueDays}`.
- **Shows — Card "Invoice Defaults":** **Customer Notes** textarea (printed on every invoice under
  "Notes"; preserves line breaks) and **Terms & Conditions** textarea (printed under "Terms &
  Conditions"). Saved by **Save Defaults** → `PATCH /settings {invoiceNotes, invoiceTerms,
invoicePrefix, paymentDueDays}`.
- **States:** terms select disabled while loading/mutating; save buttons show spinners; both save
  buttons invalidate `["settings"]`.

### Tab 7 — Integrations (`AIIntegrationsTab`)

- **Purpose:** Store the operator's own **Anthropic Claude API key** for the AI invoice/document
  scanner.
- **Data:** `GET /settings/anthropic` (`{ configured, keyPreview }`); save/remove via
  `PATCH /settings/anthropic {apiKey}` (empty string removes).
- **Shows — Card "Claude AI (Invoice Scanner)":** a status row (AI badge, "Anthropic Claude", "Key
  configured · {keyPreview}" or "No API key configured", green **Active** / amber **Not
  configured** badge); explanatory copy ("Each operator uses their own API key so AI costs are
  billed directly to your Anthropic account."); an external link to
  `console.anthropic.com/settings/keys`; a masked key input (eye toggle, `sk-ant-api03-…`
  placeholder); and a numbered "How to get your API key" instruction box.
- **Actions:** **Add API Key** / **Replace Key** (reveals the input) → **Save Key**
  (`saveKey.mutate`, toast "API key saved — Claude AI scanning is now active."); **Remove Key**
  (danger, `removeKey.mutate`, toast "API key removed"). All invalidate `["settings","anthropic"]`.
- **States:** "Checking status…" while loading; save disabled unless the trimmed key is non-empty.

### Tab 8 — My Account (`MyAccountTab`)

- **Purpose:** Per-user (not tenant-wide) controls: driver-mode permit, Google sign-in linking,
  and active-session management.
- **Data:** `GET /users/me` (`{ role, googleLinked, canActAsDriver, id }`);
  `useToggleDriverPermit()` → `PATCH /users/:id/driver-permit`; sessions via `GET /auth/sessions`,
  `DELETE /auth/sessions/:id`.
- **Shows — Card "Driver Access"** (only for OPERATOR/TENANT_ADMIN): "Act as driver" toggle. When
  on, a note: "A mode switcher will appear on your dashboard. Sign out and back in after toggling
  to refresh your session."
- **Shows — Card "Google Sign-In":** a status row (Google logo, "Connected — you can sign in with
  Google" + green Connected pill, or "Not connected" + **Connect Google** button).
- **Shows — Card "Active Sessions" (`SessionsCard`):** a list of signed-in devices — device icon
  (inferred from UA: phone/laptop/monitor/globe), device name · browser, IP address, "Signed in
  {relative}" / "Active {relative}", and a per-row **Revoke** button. When >1 session, a **Sign
  out all** button (with an inline "Sign out all sessions? Yes / Cancel" confirmation).
- **Actions:**
  - **Act as driver** toggle → `toggleDriverPermit.mutateAsync(me.id)` → toast "Driver access
    enabled/disabled — Sign out and back in to apply."
  - **Connect Google** → `GET /auth/google/link` (Bearer token) → redirects to the returned OAuth
    `url`; returns to `/settings?linked=google`.
  - **Revoke** → `DELETE /auth/sessions/:id` (optimistic list filter); **Sign out all** →
    `DELETE` every session in parallel.
- **States:** session list shows a spinner while loading, "No active sessions found." when empty;
  revoke buttons show a spinner while in-flight.

---

## Screen: Import wizard — `/settings/import` (and the in-settings Import tab)

- **File:** `apps/web/app/(dashboard)/settings/import/page.tsx` (page title "Import Data"). Mirrors
  the `ImportTab` inside `/settings`.
- **Purpose:** Migrate a tenant's existing Zoho data into RouteFlow via CSV upload. Each data type
  is its own self-contained card (upload → import → results), and the cards are laid out in the
  **recommended dependency order**.
- **Shows:** header "Import from Zoho"; a **recommended-order banner** rendering six numbered
  pills — **1 Products → 2 Customers → 3 Inventory → 4 Invoices → 5 Payments → 6 Expenses** — with
  the caveat "Invoices require customers to exist first. Payments require matching invoices."; then
  a 2-column grid of six `ImportCard`s. Each card shows: a colored type icon, a step-number chip,
  the label + description, a "How to export" hint with the exact Zoho menu path, a
  drag-and-drop / click **drop zone** (`.csv` only), an **Import {label}** button, and (after
  import) a result summary + collapsible error list.
- **Six import sections** (`IMPORT_SECTIONS`), each `POST`ing multipart `file` (5-min timeout):

  | #   | Card                       | Endpoint            | Zoho export path                                                               |
  | --- | -------------------------- | ------------------- | ------------------------------------------------------------------------------ |
  | 1   | **Products (Items)**       | `/import/products`  | Zoho Inventory → Items → ≡ → Export Items → CSV                                |
  | 2   | **Customers (Contacts)**   | `/import/contacts`  | Zoho Invoices → Contacts → ⋮ → Export Contacts                                 |
  | 3   | **Inventory Stock Levels** | `/import/inventory` | Zoho Inventory → Reports → Stock Summary → Export as CSV                       |
  | 4   | **Invoices**               | `/import/invoices`  | Zoho Invoices → Invoices → ⋮ → Export Invoices                                 |
  | 5   | **Customer Payments**      | `/import/payments`  | Zoho Invoices → Customer Payments → ⋮ → Export                                 |
  | 6   | **Expenses**               | `/import/expenses`  | Zoho Expense → My Expenses → Export (auto-creates suppliers from vendor names) |

- **Steps (per card — the wizard flow):**
  1. **Read the export hint.** The card tells you the exact Zoho menu path to produce the CSV.
  2. **Upload.** Drag a `.csv` onto the drop zone or click to browse. The zone turns brand-tinted
     and shows the file name + size ("… KB · Click to change"). Non-`.csv` drops are ignored.
  3. **Import.** Click **Import {label}**; button switches to a spinner + "Importing…" (up to a
     5-minute timeout for large files). Posts the file as `multipart/form-data`.
  4. **Results.** A success toast summarizes counts. The card header shows a green
     "{updated} updated, {created} created" **or** "{imported} imported", plus an amber "{skipped}
     skipped" when applicable. Expenses additionally reports "{n} suppliers created / matched".
  5. **Review errors (optional).** If the response has `errors[]`, a collapsible "{n} errors during
     import" panel lists up to 20 rows (then "…and N more").
- **`ProductsImportCard` (Import tab only) extra step — client-side preview.** In the in-settings
  Import tab, the Products card parses the Zoho Items CSV **in the browser** (`parseZohoCsv`:
  handles quoted/multiline cells, `USD`/comma price cleanup, SKU-vs-UPC/EAN barcode heuristics,
  active/inactive status, stock, average cost, reorder point) and shows a **preview table** (Name,
  SKU, Barcode, Unit, Price, Category, Stock) with a live count ("{n} items parsed") **before**
  the operator confirms **Import {n} Items** (`useImportProducts()`). Parse errors surface inline
  ("No valid items found…" / "Failed to parse CSV.").
- **States:** per-card `loading`, per-card result, collapsible error list. Response shapes differ
  by endpoint (`{imported,skipped}`, `{updated,created,skipped}`, or invoices' `{imported (new),
updated, skipped}`) and the summary text adapts. Import failures toast the server `message` or a
  generic "Please check your file format and try again".

---

## Key flows

- **Change branding + see it apply.** Business Profile → **Choose File** → pick a PNG/JPG/WEBP →
  local preview shows instantly → `POST /tenants/me/config/branding/logo` → on success
  `refreshBranding()` re-fetches `GET /public/tenants/{slug}/branding` (cache `no-store`) →
  `tenant-provider.tsx` re-injects `--primary`/`--primary-rgb` and the new `logoUrl` → sidebar,
  login screen, and future invoice PDFs pick up the change (the API also invalidates cached
  invoice PDFs so existing invoices re-render with the new logo). **Note:** the _color_ half of
  branding is not editable here — only the logo.
- **Invite staff + set role.** User Management → **Add User** → enter name/role/username/email →
  `POST /users/operator` returns a **temporary password** → copy + share → the invitee logs in and
  is force-prompted to change it. Roles are limited to Operator/Driver; edit an existing user's
  role via the ✏️ Edit modal (`PATCH /users/:id`).
- **Bulk import customers.** `/settings/import` (or Settings → Import tab) → find the **Customers
  (Contacts)** card → follow the export hint in Zoho → drop the CSV → **Import Customers (Contacts)**
  → review the "{imported}/{skipped}" summary and any error rows. Do this **before** Invoices and
  Payments (dependency order).
- **Set invoicing defaults.** Invoicing tab → pick default **Payment Terms** (saves immediately) →
  set **prefix** + **due days** (**Save Numbering**) → fill **Notes** + **T&C** (**Save
  Defaults**) → all newly created invoices inherit these.
- **Configure email + test.** Email tab → pick Gmail/GoDaddy → enter credentials → **Save** →
  **Send Test Email** to confirm deliverability.

## Use cases

- As a **tenant admin**, I want to set my business name, logo, address, and tax rate so invoices
  and the dashboard carry my identity. (path: `/settings` → Business Profile)
- As a **tenant admin**, I want to add operators and drivers and hand them a temporary password so
  my team can log in. (path: Settings → User Management → Add User)
- As a **tenant admin**, I want to migrate my Zoho customers, products, invoices, and payments in
  the right order so my history carries over. (path: `/settings/import`)
- As an **operator**, I want to plug in my own Claude API key so document scanning bills to my
  Anthropic account. (path: Settings → Integrations)
- As an **operator**, I want to connect a Gmail/GoDaddy sender so customer emails come from my
  address. (path: Settings → Email)
- As any **user**, I want to link Google sign-in, toggle driver mode, and revoke stray sessions.
  (path: Settings → My Account)

## Business rules & edge cases

- **Branding CSS-var injection.** `tenant-provider.tsx` fetches
  `GET /public/tenants/{slug}/branding` and sets `--primary`, `--primary-foreground` (`#ffffff`),
  and `--primary-rgb` on `<html>`; default primary is `#2563eb`. Logo save calls `refresh()` so
  vars/logo update without a reload. Branding fetch failure is **non-fatal** (app works without
  it). Slug comes from the non-httpOnly `tenant-slug` cookie.
- **Logo upload constraints.** PNG/JPG/WEBP only, < 5 MB; **SVG rejected server-side** (RF-076,
  script-injection risk). Successful upload invalidates every cached invoice PDF for the tenant.
- **Invoice numbering.** UI exposes a **prefix** (maxLength 10) + **payment-due days** (0–365,
  0 = due on receipt) + a **default terms** enum — there is **no explicit next-number counter or
  template picker** in the UI; the sequence is server-managed. Notes and T&C are free text printed
  on every invoice (line breaks preserved).
- **Role assignment.** Only **Operator** and **Driver** are createable/assignable here;
  `TENANT_ADMIN` is display-only ("Tenant admin role cannot be changed.") and can't be created.
  Username must match `^[a-z0-9_.]+$`, min 3 chars, and is auto-derived from name initials until
  edited. New users get a server temp password with `forcePasswordChange`.
- **Addons / tobacco are NOT toggled here.** Enabling `tobacco_dealer` (and any addon) is a
  **super-admin** action in `(platform-admin)/admin/tenants/[id]` (`AddonsTab`). Operators only
  see the resulting nav item / `/tobacco` screen via `useHasAddon`.
- **Tax rate lives in Business Profile**, not Invoicing — it's the tenant-wide default tax % used
  by pricing math.
- **Import validation & ordering.** Only `.csv` accepted; each endpoint returns its own
  shape (`imported`/`created`/`updated`/`skipped` + `errors[]`), summarized adaptively. **Order
  matters:** Invoices need customers to exist; Payments need matching invoices; Expenses
  auto-create suppliers from vendor names. Large imports use a 5-minute client timeout. The
  in-tab Products card parses & previews client-side before committing; the standalone
  `/settings/import` Products card imports directly server-side.
- **Email password never round-trips.** Saved SMTP password is masked server-side and never
  pre-filled; leaving the field blank on save preserves the existing password.
- **Notifications checkboxes are cosmetic.** The Order Placed / Delivered / Payment Received
  toggles are `defaultChecked` display elements with no persistence wired.
- **My Account is per-user, not tenant-wide.** Driver-permit, Google-link, and session revocation
  affect only the signed-in user; driver-mode changes require sign-out/in to take effect.

## Relevant files

- `apps/web/app/(dashboard)/settings/page.tsx` — the 8-tab settings hub (all tab components).
- `apps/web/app/(dashboard)/settings/import/page.tsx` — standalone Zoho import grid.
- `apps/web/components/tenant-provider.tsx` — branding fetch + `--primary`/`--primary-rgb` CSS-var
  injection + `refresh()` used after logo save.
- `apps/web/lib/api/users.ts` — `useUsers`, `useCreateOperator` (`POST /users/operator`),
  `useUpdateUser`, `useResetUserPassword`, `useChangeUserStatus`, `useToggleDriverPermit`;
  `AppUser` type.
- `apps/web/lib/api/invoices.ts` — `useInvoiceSettings` / `useUpdateInvoiceSettings`.
- `apps/web/lib/api/products.ts` — `useImportProducts`, `ZohoImportItem` (client-side Products
  parse).
- `apps/web/lib/api/notifications.ts` — `useNotificationsStatus`, `useSendTestNotification`.
- `apps/web/components/AddressAutocomplete.tsx` — Google Places street autocomplete.
- `apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx` — where `primaryColor` and addon
  (tobacco) toggles actually live (super-admin, out of scope for operators).
- `apps/web/e2e/02-operator.spec.ts` — **OP-19** (Business Profile tab loads with pre-populated
  form) and **OP-20** (Users tab lists staff with role badges).

---

## 💡 Faster ways

_Suggestions only — do not bake into the redesign without sign-off._

- **Guided onboarding checklist.** A first-run "Set up your business" checklist (logo → address →
  tax rate → invite team → import data → connect email) with progress %, surfaced on the dashboard
  until complete. Today these are eight disconnected tabs a new tenant must discover.
- **Downloadable CSV templates per import type.** Each import card links a "How to export from
  Zoho" path but offers no template. Ship a **Download template** button (correct headers +
  sample row) so tenants not coming from Zoho, or with drifted exports, can self-serve. Pair with
  a **column-mapping step** so non-Zoho CSVs map fields instead of failing silently.
- **Unify the import surface.** There are two near-identical import UIs (the Settings **Import
  tab** with a client-side Products preview vs. `/settings/import` with a server-side Products
  import). Fold into one, keeping the preview-before-commit step for **every** type, not just
  Products.
- **Live branding preview.** Add a **primary-color picker** to Business Profile (currently only
  editable super-admin side) with a live preview of a button/badge/invoice header, so tenants can
  self-brand. Show the logo preview on a mock invoice header, not just an 80×80 chip.
- **Persist the notification-type toggles.** Wire the Order Placed / Delivered / Payment Received
  checkboxes to real per-tenant preferences (they're currently cosmetic).
- **Consistent immediate-vs-batched saving.** Invoicing mixes save-on-change (terms) with explicit
  Save buttons (numbering, defaults); Business Profile is all-or-nothing. Pick one model (ideally
  autosave with a "saved ✓" affordance) across every tab.
- **Import history / undo.** Show a log of past imports (what/when/counts) and a way to roll back a
  bad import, since imports mutate live data with only a transient toast today.
