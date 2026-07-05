# 06 · Operator — People (Customers & Drivers)

**Role(s):** Operator / Tenant Admin (tenant-scoped). All data is implicitly tenant-filtered via the
JWT (`tenantId`/`role`). CUSTOMER/DRIVER logins never reach these routes. • **Entered via:** dashboard
left-nav **Customers** and **Drivers**, plus cross-links from Orders, Invoices, Routes, and the
Dispatch board.

This area is the operator's people CRM: customer accounts (identity, addresses, per-customer tier
pricing, AR/statement, documents, buyer-portal linkage) and the driver roster (login + vehicle +
route-run performance). Web is the golden reference; mobile mirrors these same endpoints (see
[`../mobile-inventory/06-op-people.md`](../mobile-inventory/06-op-people.md)). Unlike mobile, web has
no live fleet map, no supplier tab in this section (suppliers live in `07-op-warehouse`), and no
messaging screen — but it adds CSV import/export, bulk merge/delete, tabbed customer detail, contact
persons, comments, document uploads, and an income chart.

---

## Screens

### Customers list — `/customers`
- **File:** `apps/web/app/(dashboard)/customers/page.tsx`
- **Purpose:** Searchable, filterable, paginated customer table with bulk ops, CSV import/export, and
  an inline pending-buyer-portal-approval banner.
- **Shows:**
  - `PageHeader` "Customers" with action cluster: **Import**, **Export**, **Select** (toggles bulk
    mode), **New Customer** (opens `CustomerFormModal`).
  - **Pending Buyer Portal Connections** amber banner (collapsible) when `usePendingPortalApprovals()`
    returns rows — each row shows `contactName · businessName`, the requesting buyer account email
    (`buyerAccount.email`), and **Approve** (`useApprovePortalFromList`) + **View** (→ detail) buttons.
  - Toolbar: search box (name/business/phone, debounced 300ms via `useDebounce`), **Status** select
    (All / Active / Inactive / Suspended), **Type** select (All / Business / Individual), **Tags**
    select (present only when tenant has tags via `useCustomerTags`), and an **Unassigned only** toggle
    chip (client-side filter: customers with no route assignment from `useCustomerRouteAssignments`).
  - `Table` columns: **Name** (`contactName`, sortable), **Business Name** (sortable), **Email**,
    **Phone**, **Receivables** (red when `>0`, sortable), **Credits** (green when `>0`), **Tags** (first
    2 colored chips + `+N`), **Status** `Badge`, and a hover **actions** cell (Edit ✎ / Deactivate–
    Activate toggle / View 👁).
  - Pagination footer: "Showing X–Y of N customers", **Per page** select (10/20/50/100), numbered pager
    (up to 7 buttons) with Previous/Next.
- **Actions:**
  - Row click → `/customers/{id}` (or toggles selection in select-mode).
  - Edit ✎ → opens `CustomerFormModal` in `edit` mode (inline, no navigation).
  - Toggle status: **Deactivate** opens a confirmation `Modal` (`useUpdateCustomerStatus` →
    `INACTIVE`); **Activate** is immediate (no confirm) → `ACTIVE`.
  - **New Customer** → `CustomerFormModal` `add` mode.
  - **Import** → `ImportCustomersModal`: drag-drop / browse a `.csv`, `POST /import/contacts`
    (multipart, 300s timeout), result summary "N created · N updated · N skipped". Copy names Zoho as
    the export source ("Zoho Invoices → Contacts → ⋮ → Export Contacts (CSV)").
  - **Export** → `useExportCustomers({})` (CSV download).
  - **Select** → bulk mode: header + per-row checkboxes (indeterminate state). Action bar shows "N
    selected", **Deselect all**, **Merge** (only when exactly 2 selected → `useMergeCustomers({primaryId,
    secondaryId})`), **Delete N** (`useBatchDeleteCustomers`, reports partial failures).
  - Data: `useCustomers({search,status,page,limit,tag,customerType,sortBy,sortDir})`. Status filter is
    also mirrored to the URL (`?status=`).
- **States:** loading (5 pulse skeleton rows); error banner ("Failed to load customers…"); three distinct
  `EmptyState`s — "No unassigned customers" (with "Show all"), "No matching customers" (with "Clear
  filters"), and first-run "No customers yet" (with "Add customer"). Bulk delete/merge show button
  spinners + success/error toasts.

### Create customer (redirect) — `/customers/create`
- **File:** `apps/web/app/(dashboard)/customers/create/page.tsx`
- **Purpose:** **RF-203 guard.** There is no standalone create page; this server component
  `redirect("/customers?action=new")` so the URL resolves and the create modal opens immediately (no
  15-second spinner from a doomed `[id]` fetch). *Note: the current list page opens the add modal via the
  header button/empty-state, not by reading `?action=new` — the redirect lands on the list either way.*

### Add / Edit customer form — `CustomerFormModal`
- **File:** `apps/web/app/(dashboard)/customers/_components/CustomerFormModal.tsx` (used by the list add
  button, list row edit, and the detail-page Edit button).
- **Purpose:** Single modal for both creating and editing a customer.
- **Shows / fields** (react-hook-form + zod, `noValidate`, scrollable `max-h-[60vh]`):
  - **Customer Type** toggle — 🏢 Business / 👤 Individual (drives which name fields + validation apply).
  - **Business Info** (business type): **Business Name** (required), **Contact Name** (required).
    **Personal Info** (individual type): **Salutation** select, **First Name** (required), **Last Name**
    (required) — individual name fields collapse into `businessName`/`contactName`/`displayName` = the
    joined full name on submit.
  - **Contact Details:** **Phone (optional)** (min 7 chars if present), **Mobile (optional)**, **Email
    (optional)** (must be a valid email if present).
  - **Account:** **Currency** (USD/EUR/GBP/CAD, default USD), **Credit Limit (optional)** (number),
    **Tax ID (optional)**, **Tax Exempt** checkbox.
  - **Primary Delivery Address** (required in `add`, optional in `edit`): BILLING/SHIPPING type toggle,
    **Street** via `AddressAutocomplete`, **City**, **State** (defaults to `"TX"` if blank on submit),
    **ZIP Code**. Address fields are validated manually (inline "Required") only in add mode.
  - **Notes (optional)** textarea.
- **Actions:** **Create Customer** → `useCreateCustomer` (`add`); **Save Changes** → `useUpdateCustomer`
  (`edit`); Cancel closes. Success toast + close.
- **States:** API-error banner at top; submit button spinner (`isPending`); zod field errors inline; add
  mode blocks submit until street/city/zip filled.
- **Optional-email handling (KEY):** email is optional. On add, if no email is entered a **username is
  derived** from the email local-part when present, else from the business/contact name, sanitized
  (`[^a-z0-9]` stripped, lowercased, ≤24 chars, fallback `"customer"`) + `_<base36 timestamp>` suffix —
  guaranteeing uniqueness without an email. The seeded email field in `edit` **never surfaces the
  `@placeholder.local` sentinel**: `buildDefaultValues` only shows `user.email` when it does **not** end
  with `@placeholder.local`, else leaves the field blank.

### Customer detail — `/customers/[id]`
- **File:** `apps/web/app/(dashboard)/customers/[id]/page.tsx` (~3,440 lines; the heaviest screen in the
  operator app).
- **Purpose:** Full customer workspace — identity, orders, addresses, standing orders, invoices, billing
  & statement, tier overrides, comments, documents, tags, buyer-portal management, and delete.
- **Header:** back link → `/customers`; `businessName` (h1) + Business/Individual pill; `contactName`
  subline; status `Badge`; **Edit** (opens `CustomerFormModal`).
- **Tabs** (Radix `Tabs`):
  - **Profile** — **Customer Details** card (Display Name, Email, Mobile, Phone, **Account Email**
    (`user.email`), Customer Since, Currency); **Tax Exempt Documents** sub-section (only when
    `isTaxExempt` — camera/photo upload, thumbnail grid, lightbox, operator-only delete); **Pricing Tier**
    selector (1–5, operator-editable inline → `useUpdateCustomer({pricingTier})`); **Credit Limit** usage
    bar (`receivables / creditLimit`, colored by % used); **Tags** card (colored chips with remove-X +
    "Add Tag" dropdown → `useAssignCustomerTag`/`useRemoveCustomerTag`); **Income & Expenses (Last 6
    Months)** bar chart (`useCustomerIncomeChart`, recharts); **Contact Persons** card (add/edit/delete
    via `ContactPersonModal`, primary badge); **Delivery Time Window** card (Any-time 24/7 checkbox or
    Start/End `time` inputs saved on blur → feeds route optimizer); **Assigned Routes** card (list +
    **Assign to Route** → `AssignRouteModal` → `useAddStopToRoute`); **Account Status** card (ACTIVE /
    INACTIVE / SUSPENDED cycle buttons; when SUSPENDED reveals **Delete Customer**); **Buyer Portal** card
    (status pill + invite/resend/approve/disconnect actions — see rules).
  - **Orders** — order-history table (Order #, Status badge, Date) with a status filter
    (`useCustomerOrders`).
  - **Addresses** — addresses grouped by type (BILLING/SHIPPING/DELIVERY) with default-star/Primary badge;
    **Add Address** → `AddAddressModal` (label, type, `AddressAutocomplete` street, city/state/zip) →
    `useAddCustomerAddress`.
  - **Standing Orders** — recurring order templates (`useOrderTemplates`): generate/pause/delete +
    `StandingOrderModal`.
  - **Invoices** — customer invoices (`useInvoices({customerId})`) with All/Outstanding/Paid/Void filter;
    rich status rendering (Paid/Void/Written-Off/Draft/Overdue-by-Nd/Partial/Due-Today…); rows link to
    `/invoices/{id}`.
  - **Billing** — **Open Balance** card (`statement.outstandingAmount`, red/green), **Advance Balance**
    card (`statement.advanceBalance` + **Record Advance Payment** → `useCreateAdvancePayment`), advance-
    payment list, and a print-ready **Statement of Accounts** (Opening/Invoiced/Received/Balance-Due
    summary grid + per-transaction ledger with running balance; **Print** → `window.print()`).
  - **Special Prices** — per-product **tier overrides** table (Product, SKU, List Price, Override Tier
    badge, Tier Price via `getTierPrice`, Notes, edit/delete). Add/Edit modal: product search
    (name/SKU, top 20), tier select (1–5, each showing that product's price at that tier), live "Price
    at Tier N" hint, optional notes. `useUpsertCustomerPrice`/`useDeleteCustomerPrice`.
  - **Comments** — free-text internal notes (`useCustomerComments`, add/delete, relative timestamps).
  - **Documents** — upload images/PDFs typed (Tax Exempt Cert / Resale Cert / W-9 / Signed Agreement /
    Other), thumbnail grid, in-modal viewer (image zoom / PDF iframe / download). `useCustomerDocuments`.
- **Actions (cross-cutting):** Edit, status change, delete (guarded — see rules), assign-to-route,
  add-address, tag assign/remove, tier override upsert, portal invite lifecycle, advance payment,
  document/tax-doc upload.
- **Data:** `useCustomer(id)`, `useCustomerOrders`, `useCustomerRoutes`, `useCustomerStatement`,
  `useCustomerAdvancePayments`, `useInvoices`, `useContactPersons`, `useCustomerTags`,
  `useCustomerPrices`, `useCustomerComments`, `useCustomerDocuments`, `useCustomerTaxDocuments`,
  `useCustomerIncomeChart`, `usePortalStatus`.
- **States:** loading spinner; delete confirm dialog; per-mutation button spinners + toasts; empty states
  per tab ("No transactions on record", "No tier overrides set", "No addresses on file", etc.).

### Drivers list — `/drivers`
- **File:** `apps/web/app/(dashboard)/drivers/page.tsx`
- **Purpose:** Driver roster with search, status chip filters, bulk delete, and add/edit modals.
- **Shows:**
  - `PageHeader` "Drivers" with **Select** (bulk mode toggle) + **New Driver**.
  - **Summary chips** (clickable filters): **All (N)** / **Active (N)** / **Inactive (N)** — filter is
    client-side; a chip re-click clears it.
  - Search box (name / phone / plate / username, client-side) + "Clear filters".
  - `Table` columns: **Name** (`contactName` + `@username` subline), **Phone**, **Vehicle**
    (`vehicleMake · vehicleModel · vehicleColour · vehiclePlate`, joined), **Status** `Badge`
    (ACTIVE→green, else INACTIVE — `ON_LEAVE` is not a rendered variant), hover **actions** (View 👁 /
    Edit ✎ / Delete 🗑).
  - Bulk action bar (select mode): "N selected", **Deselect all**, **Delete N** (parallel
    `useDeleteDriver` calls).
- **Actions:** row → `/drivers/{id}`; **New Driver** → `AddDriverModal`; Edit → `EditDriverModal`; Delete
  → inline confirm dialog ("Drivers with active route runs cannot be deleted"). Data: `useDrivers()`
  (fetched in full, filtered client-side).
- **States:** error banner; loading ("Loading drivers…"); search-empty (with clear); first-run
  `EmptyState` "No drivers yet" (with "Add a driver").

### Add driver — `AddDriverModal`
- **File:** `apps/web/app/(dashboard)/drivers/_components/AddDriverModal.tsx`
- **Purpose:** Create a driver login + vehicle record; reveal the server temp-password.
- **Shows / fields:** Full Name (required), Email (required, valid email), Phone (optional, min 7),
  Username (required, ≥3, `^[a-z0-9_]+$`), Vehicle Make / Model / Colour / Plate (all optional).
  Username **auto-suggests** from the name (first-initial + last-name) until the operator edits it.
- **Actions:** **Create Driver** → `useCreateDriver` → on success the modal swaps to a **success view**
  showing the generated **temporary password** in a `<code>` block with a copy-to-clipboard button and
  the note "They will be prompted to change it on first login." Done closes + resets.
- **States:** API-error banner; submit spinner; zod field errors; success/temp-password view.

### Edit driver — `EditDriverModal`
- **File:** `apps/web/app/(dashboard)/drivers/_components/EditDriverModal.tsx` (used by list + detail).
- **Purpose:** Edit driver profile.
- **Shows / fields:** **Full Name**, Phone, Vehicle Make / Model / Colour / Plate. (Email + username are
  **not** editable — identity/login is fixed after creation; unlike mobile, the name **is** editable
  here.)
- **Actions:** **Save Changes** → `useUpdateDriver`; toast "Driver updated". Re-seeds when the target
  driver changes.

### Driver detail — `/drivers/[id]`
- **File:** `apps/web/app/(dashboard)/drivers/[id]/page.tsx`
- **Purpose:** Read view of one driver: profile, route-run history, performance.
- **Header:** back → `/drivers`; `contactName` + `@username`; status `Badge`; **Edit** + **Delete**.
- **Tabs:**
  - **Profile** — **Driver Information** (Phone, Vehicle label, Driver Since) + **Account Status**
    (Status badge, `user.email`, account `user.status`).
  - **Delivery History** — **Route Run History** table (Date, Route name, Stops count, Status) from
    `useDriverHistory`.
  - **Performance** — `StatCard`s: **Routes Completed** (`metrics.completedRuns`), **Total Runs**
    (`metrics.totalRuns`), **Completion Rate** (`completedRuns/totalRuns`, color-graded ≥95 green / ≥85
    warning / else danger) from `useDriverMetrics`.
- **Actions:** Edit (`EditDriverModal`), Delete (inline confirm → `useDeleteDriver` → back to list).
- **States:** loading ("Loading driver…"); not-found ("Driver not found." + Back); empty history ("No
  route runs recorded yet."); delete confirm dialog.
- **⚠️ Scope note:** the prompt anticipated live GPS location, POD status, and on-time%/distance/
  deliveries-per-day metrics on this screen — **the current code has none of those.** Performance is
  limited to run counts + completion rate; there is no current-location or POD panel here (live location
  lives on the Dispatch/Routes surfaces, POD on order/route detail). Documented as-is.

### Supporting components
- **`apps/web/components/AddressAutocomplete.tsx`** — address typeahead used by every address field here.
  Debounced 300ms, ≥3 chars, queries the **backend proxy** `GET /public/places/autocomplete?q=` (not the
  Google JS SDK directly; the API proxies the provider — currently **Mapbox**, which embeds
  `addressParts` so no details round-trip is needed; a `GET /public/places/details?placeId=` fallback
  exists). Keyboard nav (↑/↓/Enter/Esc), combobox a11y roles, outside-click close.
- **`apps/web/lib/api/customers.ts`** — all customer hooks (`useCustomers`, `useCreateCustomer`,
  `useUpdateCustomer`, `useUpdateCustomerStatus`, `useDeleteCustomer`, `useBatchDeleteCustomers`,
  `useMergeCustomers`, `useExportCustomers`, `useCustomerStatement`, `useCustomerPrices`,
  `useContactPersons`, `useCustomerTags`, portal hooks, document hooks, …).
- **`apps/web/lib/api/drivers.ts`** — `useDrivers`, `useDriver`, `useCreateDriver`, `useUpdateDriver`,
  `useDeleteDriver`, `useDriverHistory`, `useDriverMetrics`; exports the `Driver` type.

---

## Key flows

- **Add a customer with no email.** Customers → **New Customer** → `CustomerFormModal` → fill Business
  Name + Contact Name (+ required address in add mode), leave Email blank → **Create Customer**. The form
  derives a unique username from the business/contact name (`name_<ts36>`), the API mints the
  `no-email+<uuid>@placeholder.local` sentinel on `User.email`, `Customer.email` stays null. The edit form
  re-opens blank (sentinel never shown). ⚠️ **The customers-list Email column currently suppresses only
  `@imported.local`, so it leaks the `@placeholder.local` sentinel verbatim — a bug the redesign must fix**
  (see Business rules).
- **Assign a customer to a driver's route.** Customer detail → Profile → **Assign to Route** →
  `AssignRouteModal`: pick an active route, optionally a specific delivery address + stop note → **Assign**
  (`useAddStopToRoute`). The route (and thus its driver) now serves this customer; the Assigned Routes card
  refreshes. (Driver assignment to a route itself happens on the Routes surface, not here.)
- **View a customer's AR / statement.** Customer detail → **Billing** tab → Open Balance +
  Advance Balance cards → **Statement of Accounts** ledger (Invoiced / Received / Balance-Due, per-txn
  running balance) → **Print** for a PDF-style handout. Cross-check via the **Invoices** tab (filter
  Outstanding) which links each invoice to `/invoices/{id}`.
- **Onboard a driver.** Drivers → **New Driver** → fill name/email/username (auto-suggested) + optional
  vehicle → **Create Driver** → **temp-password success view** → copy + hand to the driver (forced reset on
  first login).
- **Bulk cleanup.** Customers → **Select** → tick 2 rows → **Merge** (dedupe into a primary), or tick many
  → **Delete N**.

## Use cases
- As an operator I add a cash-only walk-in customer who has no email, so I can still invoice them and take
  orders. (customers → New Customer, email blank)
- As an operator I give one customer a contract price on a single SKU without changing their default tier.
  (detail → Special Prices → tier override)
- As an operator I check a customer's outstanding balance and print a statement before extending more
  credit. (detail → Billing)
- As an operator I set a customer's accepted delivery hours so the optimizer schedules the stop correctly.
  (detail → Profile → Delivery Time Window)
- As an operator I create a driver login and hand them a temporary password so they can sign into the
  driver app. (drivers → New Driver → temp-password view)
- As an operator I merge two duplicate customer records created by a CSV import. (customers → Select 2 →
  Merge)
- As an operator I invite a customer to the self-serve buyer portal and approve their connection request.
  (detail → Profile → Buyer Portal)

## Business rules & edge cases
- **Optional-email sentinel — never surface it.** Emailless customers carry a
  `no-email+<uuid>@placeholder.local` sentinel on `User.email` (per README; `Customer.email` stays null).
  The **edit form** correctly hides it (`buildDefaultValues` blanks any `@placeholder.local`). ⚠️ **BUG in
  the current UI:** the **customers-list Email column** only checks `endsWith("@imported.local")` (see
  `apps/web/app/(dashboard)/customers/page.tsx`), so for an emailless customer it renders the raw
  `@placeholder.local` sentinel instead of "—". **The redesign MUST suppress BOTH `@placeholder.local` and
  `@imported.local` in the Email column** (matching the form's guard), honoring the app-wide "never
  surface the sentinel" rule. Username is decoupled from email: derived from name when email is absent.
- **Everything tenant-scoped** — no explicit tenant param on any list/detail call.
- **Pricing tiers are 1–5.** Customer default lives on `pricingTier` (Tier 1 = list/default). Per-product
  overrides (Special Prices tab) store a `pricingTier` per product and override the default for that SKU
  only; deleting an override reverts to the default tier. Prices are computed via `getTierPrice` from
  `apps/web/lib/pricing.ts` — the UI stores only the tier reference, never a raw amount.
- **Status model.** Customers: ACTIVE / INACTIVE / SUSPENDED. Deactivating requires a confirmation modal
  and hides the customer from route assignment + blocks their login; reactivating is immediate. **Delete
  is gated** — the destructive Delete Customer button only appears when the customer is SUSPENDED.
- **Driver status** rendered as ACTIVE (green) vs INACTIVE only; `ON_LEAVE` exists in the domain but is
  not a distinct badge/filter here. Drivers with **active route runs cannot be deleted** (API rejects;
  toast surfaces the message).
- **Driver identity is fixed after creation** — edit changes name/phone/vehicle only; email + username
  are immutable. Creation returns a one-time `tempPassword` the operator must relay; the driver is forced
  to reset it on first login.
- **Address autocomplete** goes through the authenticated API proxy (`/public/places/*`), not a client
  Google key; the provider (Mapbox) embeds parts so selection fills street/city/state/zip in one shot.
  Minimum 3 chars, 300ms debounce. State defaults to `"TX"` if the operator leaves it blank on create.
- **Buyer-portal lifecycle** (Profile card + list banner): NOT_INVITED/DISCONNECTED → **Send Invite**
  (optional override email) → INVITED (with expiry, **Resend**) → PENDING_SELLER_APPROVAL → **Approve
  Connection** → ACTIVE (shows linked buyer account); ACTIVE/INVITED/PENDING can **Disconnect**. The list
  banner surfaces pending approvals across all customers for one-click approve.
- **CSV import** is idempotent-ish: `POST /import/contacts` returns created/updated/skipped counts + error
  list; the copy is written around Zoho's contact export format.
- **Statement math** flows through `fmt`/`roundMoney`; Balance Due = outstandingAmount; Invoiced and
  Received are summed from the transaction ledger. Print uses the browser print dialog (no server PDF).
- **RF-203** — `/customers/create` is a redirect shim, not a real page, to avoid the `[id]` dynamic route
  treating "create" as an id and hanging.

## Relevant files (all absolute)
- `C:\ClaudeCode\routeflow\apps\web\app\(dashboard)\customers\page.tsx`
- `C:\ClaudeCode\routeflow\apps\web\app\(dashboard)\customers\create\page.tsx`
- `C:\ClaudeCode\routeflow\apps\web\app\(dashboard)\customers\[id]\page.tsx`
- `C:\ClaudeCode\routeflow\apps\web\app\(dashboard)\customers\_components\CustomerFormModal.tsx`
- `C:\ClaudeCode\routeflow\apps\web\app\(dashboard)\customers\[id]\StandingOrderModal.tsx`
- `C:\ClaudeCode\routeflow\apps\web\app\(dashboard)\drivers\page.tsx`
- `C:\ClaudeCode\routeflow\apps\web\app\(dashboard)\drivers\[id]\page.tsx`
- `C:\ClaudeCode\routeflow\apps\web\app\(dashboard)\drivers\_components\AddDriverModal.tsx`
- `C:\ClaudeCode\routeflow\apps\web\app\(dashboard)\drivers\_components\EditDriverModal.tsx`
- `C:\ClaudeCode\routeflow\apps\web\components\AddressAutocomplete.tsx`
- `C:\ClaudeCode\routeflow\apps\web\lib\api\customers.ts`, `…\drivers.ts`, `…\routes.ts`
- `C:\ClaudeCode\routeflow\apps\web\lib\pricing.ts` (`getTierPrice`), `…\formatting.ts` (`fmt`)
- E2E: `C:\ClaudeCode\routeflow\apps\web\e2e\02-operator.spec.ts` (OP-06 list loads, OP-07 search filters,
  OP-08 detail navigates)

---

## 💡 Faster ways (suggestions — NOT current behavior)

> These are redesign ideas, quarantined per the inventory rules. None of this is built today.

- **Inline customer create from the order builder.** Today taking an order for a brand-new customer means
  leaving the order flow, opening `CustomerFormModal`, saving, then coming back. A "＋ New customer" option
  inside the order/invoice customer picker (mini version of the form, address optional) would keep the
  operator in one flow. The `CustomerFormModal` already supports a lean payload — it could be reused inline.
- **Dedupe detection at create/import time.** Merge exists (Select 2 → Merge) but only *after* duplicates
  are created — and CSV import is the main duplicate source. Surface a "possible duplicate" hint (fuzzy
  match on business name + phone/address) in the create form and in the import result, with a one-click
  merge, instead of relying on the operator to spot two rows later.
- **Bulk tag from the list.** Tags can only be assigned one customer at a time on the detail Profile tab.
  Extend the existing bulk-select action bar with an **Add tag to N** / **Remove tag from N** action
  (alongside Merge/Delete) so operators can segment a filtered set (e.g. all "Downtown" customers) in one
  pass.
- **Unify driver identity editability.** Web edit locks email/username while mobile locks name — pick one
  rule in the redesign so the two clients behave the same (README "mobile mirrors web").
