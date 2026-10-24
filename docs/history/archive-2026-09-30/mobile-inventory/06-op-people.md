## 6. Operator — People: Customers, Drivers, Suppliers, Fleet, Messages

**Role(s):** Operator / dispatcher (tenant-scoped admin). All screens live under the `(operator)` route group and call the admin/tenant API surface. • **Entered via:** the operator **More** menu and home dashboard shortcuts (Contacts, Drivers, Suppliers, Fleet, Messages), plus deep links from Routes/Fleet (driver pins → `driver`) and per-customer cross-links from Orders/Invoices.

This area is the operator's people-and-partners CRM: manage customer accounts (identity, addresses, per-customer tier pricing, account standing), the driver roster and per-driver route load, purchase-order suppliers, a live fleet map, and an (as-yet unwired) messaging inbox. Everything is tenant-scoped — the JWT carries `tenantId`/`role`, so all list/detail data is implicitly filtered to the operator's tenant.

### Screens

#### Contacts (Customers / Suppliers / Map) — `/(operator)/customers`

- **File:** `apps/mobile/app/(operator)/customers/index.tsx`
- **Purpose:** Unified contacts hub with a 3-way segmented control over Customers, Suppliers, and a Map.
- **Shows:**
  - `NavBar` large title "Contacts" with a dynamic subtitle: `N customer(s)` or `N supplier(s)` depending on the active tab.
  - `SegmentedControl` items: **Customers · Suppliers · Map**.
  - `SearchBar` (placeholder "Search customers…" / "Search suppliers…").
  - **Customers tab:** rows with a brand-wash avatar (initials of `businessName`), `businessName` (1 line), and a subline joining `contactName · phone`, chevron.
  - **Suppliers tab:** rows with a purple-wash avatar (initials of supplier `name`), `name`, subline `contactName · (phone ?? email)`, chevron. Supplier search filters client-side over name/contactName/email.
  - **Map tab:** `AppMapView` of gray customer pins built from `addresses[0].lat/lng`; pin title = `businessName`, subtitle = `addresses[0].city`.
- **Actions:**
  - "Add" (nav trailing) → `/(operator)/customers/new` (Customers tab) or `/(operator)/suppliers/new` (Suppliers tab); hidden on Map tab.
  - Customer row → `/(operator)/customers/:id`.
  - Supplier row → `/(operator)/suppliers/:id/edit` (note: from this hub a supplier row jumps straight to **edit**, not the supplier detail).
  - Map pin → `/(operator)/customers/:id`.
  - Empty-state "Add customer"/"Add supplier" buttons → the respective `/new`.
  - Back → `router.back()` or `replace("/(operator)")`.
  - Data: `useAdminCustomers({ search, limit: 100 })` → `GET /customers`; `useSuppliers()` → `GET /suppliers`.
- **States:** loading (spinner); empty ("No customers yet." / "No customers match." when searching; supplier equivalents) with a primary Add button; pull-to-refresh (`RefreshControl`, refetches active tab); Map empty hint ("Customer addresses with coordinates will appear here.") when no geocoded pins.

#### New customer — `/(operator)/customers/new`

- **File:** `apps/mobile/app/(operator)/customers/new.tsx` (thin wrapper around `CustomerForm`)
- **Purpose:** Create a customer account.
- **Shows / Steps:** the shared `CustomerForm` (see below) seeded from `emptyCustomerForm()`, title "New customer".
- **Actions:** "Save" → `useCreateCustomer` → `POST /customers`; on success toast "Customer created" and `router.replace` to the new `/(operator)/customers/:id`. On error, toast surfaces `response.data.message`.
- **States:** submitting ("Saving…" label + disabled); inline validation banner from the form (business name required); dirty-guard (web beforeunload) via `FormSheet`.

#### Create customer (alias) — `/(operator)/customers/create`

- **File:** `apps/mobile/app/(operator)/customers/create.tsx` (re-exports `./new`)
- **Purpose:** RF-203 route guard — intercepts `/customers/create` so Expo Router's `[id]` dynamic segment doesn't treat "create" as a customer ID (which 404s and spins forever). Renders the New Customer form immediately, no fetch.

#### Customer detail — `/(operator)/customers/[id]`

- **File:** `apps/mobile/app/(operator)/customers/[id].tsx`
- **Purpose:** Full customer profile: identity, address, account standing (statement), account details, quick cross-links.
- **Shows:**
  - `NavBar` inline title = `businessName`, back label "Customers", trailing "Edit".
  - **Identity card:** `businessName` (large), `contactName`, tag chips from `tagAssignments[].tag.name`, and a quick-action row: **Call / Text / Email / Directions / Addresses** (each only shown when the underlying field exists).
  - **Address card** (primary = default address, else first): multi-line `line1/line2/city, state zip`, with a "Manage" link.
  - **Account standing card** (from `useCustomerStatement`): a stat grid — **Outstanding**, **Overdue** (red if > 0), **Pending orders** (amber if > 0), **Credit notes** (green, = `availableCredit`), **Advance paid** (`advanceBalance`); plus rows for **Credit limit** (if set) and **Pricing tier** (`Pill` "Tier N", gray for tier 1 else brand); "View custom prices" link.
  - **Account card:** Email, Phone, Currency, Delivery window (`deliveryWindowStart – deliveryWindowEnd`), Notes.
  - **Actions card:** "View orders", "View invoices".
  - Bottom: **Delete customer** (red).
- **Actions:**
  - "Edit" → `/(operator)/customers/:id/edit`.
  - Call → `tel:`; Text → `sms:`; Email → `mailto:`; Directions → `openInMaps({address,lat,lng,label})`.
  - "Addresses" / "Manage" → `/(operator)/customers/:id/addresses`.
  - "View custom prices" → `/(operator)/customers/:id/catalog`.
  - "View orders" → `/(operator)/orders?customerId=:id`; "View invoices" → `/(operator)/invoices?customerId=:id`.
  - Delete → `confirm(...)` → `useDeleteCustomer` → `DELETE /customers/:id`; toast "Customer deleted", `router.back()`.
  - Data: `useCustomer(id)` → `GET /customers/:id`; `useCustomerStatement(id)` → `GET /customers/:id/statement`.
- **States:** loading (spinner under a "Customer" navbar); RF-203 defensive redirect — if `id` is "create"/"new", `router.replace` to `/new`; delete confirmation dialog (destructive); delete in-flight disables the button.

#### Edit customer — `/(operator)/customers/[id]/edit`

- **File:** `apps/mobile/app/(operator)/customers/[id]/edit.tsx` (wrapper around `CustomerForm`)
- **Purpose:** Edit an existing customer.
- **Shows / Steps:** `CustomerForm` seeded via `customerFormFromValues(customer)`, title "Edit customer".
- **Actions:** "Save" → `useUpdateCustomer` → `PATCH /customers/:id`; toast "Saved", `router.back()`.
- **States:** loading spinner until `useCustomer(id)` resolves; submitting; dirty-guard.

#### Manage addresses — `/(operator)/customers/[id]/addresses`

- **File:** `apps/mobile/app/(operator)/customers/[id]/addresses.tsx`
- **Purpose:** List, add, and set the default delivery address for a customer.
- **Shows:**
  - `NavBar` "Addresses", back label = `businessName`.
  - Address cards: `line1`, optional `line2`, `city, state zip`; each shows either a **Default** badge or a **Set default** link.
  - Inline **Add address** form (toggled): Street, Line 2, City, State (auto-caps), ZIP (number-pad), Latitude/Longitude (numeric), and a "Set as default delivery address" checkbox.
- **Actions:**
  - "Set default" → `useUpdateCustomerAddress({ isDefault: true })` → `PATCH /customers/:id/addresses/:addressId`; toast "Default updated", refetch.
  - "Add address" → reveals the form; "Save" → `useAddCustomerAddress` → `POST /customers/:id/addresses`; toast "Address added", collapses form, refetch. "Cancel" hides it.
  - Data source: `useCustomer(id)` (addresses are embedded).
- **States:** loading spinner; empty ("No addresses yet."); inline form validation ("Street, city, state, and ZIP are required." / "Coordinates must be numeric."); submitting ("Saving…").
- **Steps (add flow):** 1) tap Add address → 2) fill required street/city/state/zip (+ optional line2/lat/lng) → 3) optionally check default → 4) Save (POST).

#### Tier overrides (per-customer catalog) — `/(operator)/customers/[id]/catalog`

- **File:** `apps/mobile/app/(operator)/customers/[id]/catalog.tsx`
- **Purpose:** Assign a specific pricing **tier** to individual products for this customer, overriding the customer's default tier.
- **Shows:**
  - `NavBar` "Tier overrides", back label "Customer".
  - Info hint explaining overrides; only assigned overrides are listed.
  - Override rows: product `name`, subline `sku · List $X · notes`, a **Tier N** badge, the tier price (`getTierPrice(product, tier)`), and a trash icon.
  - **Add/Edit Tier Override modal:** product picker (search by name/SKU, top-20; locked to product name when editing), a 5-button tier selector (each showing that tier's price for the selected product), a live "Price at Tier N" hint, and an optional Notes field ("e.g. Contract price").
- **Actions:**
  - Row tap → open edit modal (`existing` = that override); trash → `confirm` → `useDeleteCustomerPrice` → `DELETE /customers/:id/prices/:priceId`; toast "Override removed".
  - Modal "Save" → `useUpsertCustomerPrice({ customerId, productId, pricingTier, notes })` → upsert `/customers/:id/prices`; toast "Override added/updated"; Save disabled until a product is selected.
  - Data: `useCustomerPrices(id)` → `GET /customers/:id/prices`; `useAdminProducts({ isActive: true, limit: 200 })` → `GET /products` for the picker/prices.
- **States:** loading (spinner while prices+products load); empty card ("No tier overrides set." + "Add the first one →"); modal save in-flight ("Saving…", dimmed); remove confirmation (destructive).
- **Steps (add):** 1) Add override → 2) search & pick product → 3) tap a tier (1–5, price shown) → 4) optional note → 5) Save (upsert).

#### Drivers list — `/(operator)/drivers`

- **File:** `apps/mobile/app/(operator)/drivers/index.tsx`
- **Purpose:** Roster of tenant drivers.
- **Shows:** `NavBar` large title "Drivers", subtitle `N driver(s)`, trailing "Add". Rows: brand avatar with initials (from `user.firstName/lastName` or `username`), driver name, vehicle subline (`vehicleMake vehicleModel · vehiclePlate` or "No vehicle"), and a status `Pill` (green if `ACTIVE`, else gray; label lowercased).
- **Actions:** "Add" / empty-state "Add driver" → `/(operator)/drivers/new`; row → `/(operator)/driver?id=:id` (the operator driver-detail view). Data: `useAdminDrivers({ limit: 100 })` → `GET /drivers`.
- **States:** loading spinner; empty ("No drivers yet." + primary Add button); pull-to-refresh.

#### New driver — `/(operator)/drivers/new`

- **File:** `apps/mobile/app/(operator)/drivers/new.tsx`
- **Purpose:** Create a driver login + vehicle record.
- **Shows / Steps:** `FormSheet` "New driver" with two sections — **Identity** (Full name, Email, Username with hint "Used for login.", Phone) and **Vehicle** (Make, Model, License plate).
- **Actions:** "Create" → `useCreateDriver` → `POST /drivers`; on success shows an `alertInfo` dialog **"Driver created"** revealing the server-generated `tempPassword` ("Share this with the driver… they'll be prompted to set a new password."), then `router.back()`.
- **States:** validation ("Name, email, and username are required." shown under the name field); submitting ("Saving…"); error toast.

#### Add driver (redirect) — `/(operator)/drivers/add`

- **File:** `apps/mobile/app/(operator)/drivers/add.tsx`
- **Purpose:** RF-211 alias — `<Redirect href="/(operator)/drivers/new" />` so legacy deep-links / the More screen's `/drivers/add` resolve to the canonical form.

#### Edit driver — `/(operator)/drivers/[id]/edit`

- **File:** `apps/mobile/app/(operator)/drivers/[id]/edit.tsx`
- **Purpose:** Edit a driver's contact + vehicle (not identity/login).
- **Shows / Steps:** `FormSheet` "Edit driver" — **Contact** (Phone) and **Vehicle** (Make, Model, Color, License plate). Fields seed from `useDriver(id)` (`GET /drivers/:id`); `phone` comes from `driver.user.phone`, color from `vehicleColour`.
- **Actions:** "Save" → `useUpdateDriver` → `PATCH /drivers/:id`; toast "Saved", `router.back()`.
- **States:** loading spinner until driver loads; submitting; error toast.

#### Operator driver detail — `/(operator)/driver?id=…`

- **File:** `apps/mobile/app/(operator)/driver.tsx`
- **Purpose:** Operator's read view of one driver: identity, route load, and assigned routes. (This is the target of driver rows and Fleet pins. Note: despite the scope's "stats+payments", this screen shows route/stop stats only — there is **no payments/cash UI** here.)
- **Shows:**
  - `NavBar` inline title `Name · <active route or "No active route">`, back label "Fleet", trailing "Edit".
  - Gradient avatar (brand gradient) with initials, driver name, vehicle/status subline.
  - `InlineStats`: **Routes** (count), **Stops** (sum of `_count.stops`), **Status** (`driver.status`).
  - "Assigned routes" section: cards with route `name` and `N stop(s) · <run status>` (run status lowercased, `_`→space).
- **Actions:** "Edit" → `/(operator)/drivers/:id/edit`. Data: `useAdminDrivers()` (find by `id`) → `GET /drivers`; `useAdminRoutes({ limit: 50 })` → `GET /routes`, filtered client-side to `driverId`; active route = the one whose latest run is `IN_PROGRESS`.
- **States:** loading spinner; **not-found** ("Driver not found") when the id isn't in the list; "No routes assigned." empty within the routes section. (Route cards are informational — no per-card navigation.)

#### Fleet (live map) — `/(operator)/fleet`

- **File:** `apps/mobile/app/(operator)/fleet.tsx`
- **Purpose:** Real-time map of drivers on the road with a live-drivers bottom sheet.
- **Shows:**
  - Full-bleed `AppMapView`: **driver pins** (brand, at `latestLocation`), **remaining-stop pins** (orange if `IN_PROGRESS`, gray if `PENDING`, titled `stopNumber. customerName`), and a **polyline** per run through remaining stops (prepended with the driver's current location).
  - Top overlay chips: `N live` (green), `N driver(s) sharing GPS` (brand); a legend: "On route · N", "Home · N" (home = routes whose latest run is `COMPLETED`).
  - Bottom sheet "Live drivers": up to 6 rows — avatar initials, `name · routeName`, and progress `remaining/total stops left · Ns ago` (or "· waiting on GPS").
- **Actions:** back chevron → `router.back()`; driver pin or sheet row → `/(operator)/driver?id=:driverId` (only if `driverId` present); remaining-stop pin → `/(operator)/customers/:customerId`. Data: `useAdminRoutes({ limit: 50 })`, `useAdminDrivers()`, and live feed `useRoutesLive()` (`routes[]` with `latestLocation`, `stops[]`, `recordedAt`).
- **States:** map-empty ("No active routes right now. Live driver pins will appear when a route is in progress."); sheet-empty ("No drivers on the road right now."). Freshness is computed live from `recordedAt` (seconds-ago).

#### Suppliers list — `/(operator)/suppliers`

- **File:** `apps/mobile/app/(operator)/suppliers/index.tsx`
- **Purpose:** List purchase-order suppliers.
- **Shows:** `NavBar` large title "Suppliers", trailing "Add". Cards: supplier `name`, then `contactName`, `email`, `phone` (each shown when present), chevron.
- **Actions:** "Add" / empty CTA → `/(operator)/suppliers/new`; row → `/(operator)/suppliers/:id` (the supplier detail). Data: `useSuppliers()` → `GET /suppliers`.
- **States:** loading spinner; empty (business icon + "No suppliers yet" / "Tap Add to create your first supplier."); pull-to-refresh.

#### New supplier — `/(operator)/suppliers/new`

- **File:** `apps/mobile/app/(operator)/suppliers/new.tsx`
- **Purpose:** Create a supplier.
- **Shows / Steps:** `FormSheet` "New Supplier" — **Supplier** (Name [autofocus], Contact name optional), **Contact** (Phone optional, Email optional), **Notes** (optional multiline).
- **Actions:** "Create" → `useCreateSupplier` → `POST /suppliers`; toast "Supplier created", `router.back()`.
- **States:** validation ("Please enter a supplier name."); submitting ("Creating…"); error toast.

#### Supplier detail — `/(operator)/suppliers/[id]`

- **File:** `apps/mobile/app/(operator)/suppliers/[id].tsx`
- **Purpose:** Read-only supplier profile.
- **Shows:** `NavBar` = supplier `name`, trailing "Edit". Cards: **Name / Contact**; a **Contact** section (tappable Phone → `tel:`, Email → `mailto:`) shown only if either exists; a **Notes** section if present.
- **Actions:** "Edit" → `/(operator)/suppliers/:id/edit`. Data: `useSuppliers()` then find by `id` (no dedicated detail endpoint).
- **States:** loading spinner; **not-found** ("Supplier not found" + "Back to suppliers" → `replace("/(operator)/suppliers")`).

#### Edit supplier — `/(operator)/suppliers/[id]/edit`

- **File:** `apps/mobile/app/(operator)/suppliers/[id]/edit.tsx`
- **Purpose:** Edit a supplier.
- **Shows / Steps:** `FormSheet` "Edit Supplier" with the same sections as New (Name, Contact name, Phone, Email, Notes), seeded from `useSuppliers()` find-by-id.
- **Actions:** "Save" → `useUpdateSupplier` → `PATCH /suppliers/:id`; toast "Supplier updated", `router.back()`.
- **States:** loading spinner until the supplier resolves; validation ("Please enter a supplier name."); submitting ("Saving…").

#### Messages (inbox) — `/(operator)/messages`

- **File:** `apps/mobile/app/(operator)/messages.tsx` → re-exports the shared `components/MessagesScreen.tsx`
- **Purpose:** Placeholder dispatcher↔driver inbox.
- **Shows:** `NavBar` "Messages" (back label "More") and a full-screen `IosEmptyState`: chat icon, "Messaging is coming soon", subtitle "You'll coordinate with dispatch and other drivers from here once in-app messaging is enabled."
- **Actions:** back → `router.back()`. **No data fetch** — messaging isn't wired (no `/messages` endpoint or websocket feed).
- **States:** permanent empty state only.

#### Shared form component — `CustomerForm`

- **File:** `apps/mobile/components/CustomerForm.tsx` (used by customer `new` + `edit`)
- **Shows / real fields (in `FormSheet`):**
  - **Business:** Business name (required), Contact person, Notes (multiline).
  - **Contact:** Email (email keyboard, no autocaps), Phone (phone-pad).
  - **Billing:** Credit limit (decimal-pad), **Pricing tier** (1–5 pill selector), Currency (3-char, uppercase), **Tax exempt** switch — when on, reveals **Tax ID / exemption number**.
  - **Delivery window:** FROM (HH:MM) / TO (HH:MM) numeric fields (max 5 chars each).
- **Rules:** business name required (inline red banner "Business name is required." otherwise); optional numbers parsed via `parseOptionalNumber`; **dirty-guard** — a web `beforeunload` prompt fires if the form is dirty and not submitting (BUG-XR2-5). `FormSheet` also wires `accessibilityLabel` from each `FormField` label (BUG-XR2-2).

### Key flows (end-to-end journeys through this area)

- **Create & configure a customer:** Contacts (Customers) → "Add" → New customer (`CustomerForm`, `POST /customers`) → auto-redirect to Customer detail → "Manage" addresses → add default address (`POST /customers/:id/addresses`) → "View custom prices" → Tier overrides → add per-product tier (`upsert /customers/:id/prices`). Commit points: create, add-address, upsert-price.
- **Onboard a driver:** Drivers → "Add" → New driver (`POST /drivers`) → **temp-password alert** shown to hand off credentials → back to roster. Later: Drivers row → Operator driver detail → "Edit" → `PATCH /drivers/:id`.
- **Watch a driver on the road:** Fleet live map → tap a live driver pin or sheet row → Operator driver detail (routes + stops) → optionally Edit driver. Alternatively tap a stop pin → that customer's detail.
- **Manage a supplier:** Contacts (Suppliers) or Suppliers list → "Add" (`POST /suppliers`) or row → Supplier detail → "Edit" (`PATCH /suppliers/:id`). (From the Contacts hub, supplier rows jump directly to Edit.)
- **Review account standing → act:** Customer detail account-standing card (statement via `GET /customers/:id/statement`) → "View orders"/"View invoices" cross-links into the Orders/Invoices areas filtered by `customerId`.

### Use cases

- As an operator, I want to add a new wholesale customer with a credit limit and default pricing tier so that orders auto-price correctly. (path: customers/index → customers/new → customers/[id])
- As an operator, I want to give a specific customer a contract price on one product so that only that SKU uses a different tier. (path: customers/[id] → customers/[id]/catalog)
- As an operator, I want to see a customer's outstanding, overdue, and pending-order balances at a glance before taking a new order. (path: customers/[id] account-standing card)
- As an operator, I want to set a customer's default delivery address and add a second site so routing picks the right stop. (path: customers/[id]/addresses)
- As an operator, I want to create a driver login and hand them a temporary password so they can sign into the driver app. (path: drivers/new → temp-password alert)
- As an operator, I want to watch which drivers are live and how many stops remain so I can reassign or call ahead. (path: fleet → driver)
- As an operator, I want to keep supplier contact details current for purchase orders. (path: suppliers/index → suppliers/[id] → suppliers/[id]/edit)

### Business rules & edge cases

- **Everything is tenant-scoped** via the JWT; no explicit tenant param on these list/detail calls.
- **Pricing tiers are 1–5.** Customer-level default tier lives on `pricingTier` (Tier 1 renders a gray pill, ≥2 a brand pill). Per-product overrides in the catalog screen store a `pricingTier` per product; deleting an override reverts that product to the customer's default tier. Tier prices are computed via `getTierPrice(product, tier)` (mobile `lib/pricing.ts`) — the screens display prices but do not persist a raw amount, only the tier reference.
- **Statement semantics:** account-standing surfaces `outstandingAmount`, `overdueAmount` (red when > 0), `pendingOrdersAmount` (amber when > 0), `availableCredit` (labeled "Credit notes", green), and `advanceBalance` ("Advance paid"). All formatted to 2 decimals; non-finite/nullish coerced to `$0.00`.
- **RF-203 route guard:** `customers/create.tsx` (and a defensive redirect inside `[id].tsx` for `id === "create" | "new"`) prevents the `[id]` dynamic segment from firing a doomed `GET /customers/create` and spinning forever.
- **RF-211 redirect:** `drivers/add` → `drivers/new` for legacy/deep-link parity.
- **Driver creation returns a `tempPassword`** the operator must relay; the driver is forced to reset it on first login. Edit-driver cannot change identity/login (name/email/username) — only phone + vehicle (make/model/**colour**/plate).
- **Driver detail routing quirk:** the operator driver view is a query-param screen (`/(operator)/driver?id=`), **not** a `drivers/[id].tsx` file. It has no payments/cash-reconciliation UI — only route/stop counts and status; per-driver payments live elsewhere (driver-role/finance areas).
- **Address validation:** street/city/state/zip required; lat/lng optional but must be numeric. Setting a new default is a `PATCH … isDefault:true`; the primary address on the detail screen is the one flagged `isDefault`, else the first.
- **Supplier detail has no dedicated GET** — both detail and edit derive the record by finding `id` within the full `useSuppliers()` list; deep-linking to an unknown id yields a "Supplier not found" fallback.
- **Contacts hub inconsistency:** a supplier row in the Contacts hub opens **edit** directly, whereas the Suppliers list opens the **detail** screen first — the same entity has two entry behaviors depending on origin.
- **Messaging is intentionally unbuilt** — `MessagesScreen` is an honest empty state; there is no `/messages` endpoint or socket feed yet (the hi-fi mockup's demo threads were deliberately removed).
- **Fleet freshness/geo gating:** driver pins only appear when a run reports `latestLocation`; stop pins require `lat/lng` and a `PENDING`/`IN_PROGRESS` status; polylines need ≥2 remaining geocoded stops. "Home" count = routes whose latest run is `COMPLETED`.
- **Form dirty-guard (web):** `CustomerForm` + `FormSheet` raise a native beforeunload prompt on unsaved changes; accessibility labels propagate from `FormField` to inputs (BUG-XR2-2/5).

Relevant files (all absolute):

- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\customers\{index,new,create,[id],[id]\edit,[id]\addresses,[id]\catalog}.tsx`, `customers\_layout.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\drivers\{index,new,add,[id]\edit}.tsx`, `drivers\_layout.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\suppliers\{index,new,[id],[id]\edit}.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\{fleet,messages,driver}.tsx`
- Shared: `C:\ClaudeCode\routeflow\apps\mobile\components\{CustomerForm,FormSheet,MessagesScreen}.tsx`; API hooks in `C:\ClaudeCode\routeflow\apps\mobile\lib\api\{customers,drivers,admin,purchase-orders,routes}.ts`
