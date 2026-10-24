## 2. Customer / Buyer Portal — (customer)

**Role(s):** Buyer / Customer (a business that purchases from one or more RouteFlow seller tenants; JWT `type: "BUYER"`). • **Entered via:** After buyer login/seller selection in `(auth)/customer-login`, the app lands on the `(customer)/(tabs)` stack. The five-tab bar (Home, Orders, Catalog, Invoices, More) is the primary entry; detail screens are pushed on top, and deep links (`routeflow://…/orders`, `/invoices`) resolve into this stack.

The buyer portal is a self-service ordering surface: a buyer browses the active seller's catalog at their negotiated (buyer-tier) prices, builds a cart, places and tracks orders, edits pending/confirmed orders, views/pays-down invoices (via shared PDF), and manages recurring "standing orders." It is scoped to **one active seller at a time** (`activeSeller`) even though a single buyer login can be linked to multiple seller tenants.

### Screens

#### Customer stack layout — `(customer)/_layout.tsx`

- **File:** `apps/mobile/app/(customer)/_layout.tsx`
- **Purpose:** Auth gate + realtime bootstrap for every buyer screen.
- **Shows:** Nothing visible — a headerless `<Stack>`.
- **Actions:** Mounts `useBuyerSocket()` (RF-002) once for the whole area so orders/invoices/dashboard stay live. Reads `{ buyer, activeSeller, isLoading }` from `useBuyerSessionStore`.
- **States:** **Role-gated / redirect** — once loading finishes, if there is no `buyer` OR no `activeSeller`, it `router.replace("/(auth)/customer-login")`. While `isLoading` it renders nothing (holds the splash). Also mirrors session-expired (401 refresh failure) and cross-tab logout into a redirect.

#### Customer tab bar — `(customer)/(tabs)/_layout.tsx`

- **File:** `apps/mobile/app/(customer)/(tabs)/_layout.tsx`
- **Purpose:** Bottom tab navigator (custom `IosTabBar`).
- **Shows:** 5 tabs with Ionicons — **Home** (`home-outline`), **Orders** (`receipt-outline`), **Catalog** (`grid-outline`), **Invoices** (`document-text-outline`), **More** (`ellipsis-horizontal`). Active tint = `ios.brand`.
- **Actions:** Tab switching only.
- **States:** Static.

#### Home / Dashboard — `(customer)/(tabs)/home`

- **File:** `apps/mobile/app/(customer)/(tabs)/home.tsx`
- **Purpose:** Daily check-in: outstanding balance, quick stats, last order, quick actions (RF-218).
- **Shows:**
  - NavBar title = `activeSeller.tenant.name` (falls back to "Home").
  - **Balance card:** "Outstanding balance" = sum of `amountDue ?? balanceDue ?? total` over unpaid invoices (`useBuyerInvoices` with `statuses: ["SENT","OVERDUE","PARTIAL"]`, limit 50). Amount turns orange when > 0. Sub-line: "N invoice(s) overdue" (count of `OVERDUE`/`isOverdue`) or "All invoices paid" when total is 0.
  - **Stats strip (3 cells):** Active orders (`stats.activeOrders`), Spend (30 d) (`stats.spend30d`), Standing orders (`stats.templateCount`).
  - **Last order card:** `#orderNumber`, formatted `createdAt`, item count (`itemCount` or summed `lineItems.qty`), a `StatusPill`, and `$total`.
  - **Quick actions card:** Browse catalog, Invoices, Standing orders (with a count badge when `templateCount > 0`).
- **Actions:**
  - "New order" (NavBar trailing) → push `/(customer)/orders/cart`.
  - Balance card → push `/(customer)/(tabs)/invoices`.
  - Last order card → push `/(customer)/orders/{id}`.
  - Quick actions → `/(customer)/(tabs)/catalog`, `/(customer)/(tabs)/invoices`, `/(customer)/standing-orders`.
  - Data via `useBuyerDashboard` → `GET /buyer/dashboard`; balance via `useBuyerInvoices` → `GET /buyer/invoices`.
- **States:** **Loading** = centered spinner (dashboard load). **Pull-to-refresh** = `RefreshControl` refetches dashboard + invoices. **Empty last order** = the LAST ORDER section is hidden. Realtime-updated (socket invalidation).

#### Orders list — `(customer)/(tabs)/orders`

- **File:** `apps/mobile/app/(customer)/(tabs)/orders.tsx`
- **Purpose:** Browse/filter the buyer's orders.
- **Shows:** NavBar title = seller name / "Orders". **Filter chips:** All, Pending, Confirmed, Out for delivery, Delivered, Cancelled. Per-order card: `#orderNumber`, date, item count (summed `lineItems.qty`), status `Pill`, and `$total` (uses `order.total`, else recomputes `qty × unitPrice`).
- **Actions:** "New" (NavBar) → `/(customer)/orders/cart`. Filter chip → refetch with `status` param (ALL = no param). Card tap → `/(customer)/orders/{id}`. Data via `useBuyerOrders` → `GET /buyer/orders?status=…&limit=30`.
- **States:** **Loading** spinner. **Empty** = "No orders yet." + "Browse catalog" button → catalog. **Pull-to-refresh**. Auto-refreshes on `order.statusChanged` socket event (no per-screen wiring).

#### Catalog — `(customer)/(tabs)/catalog`

- **File:** `apps/mobile/app/(customer)/(tabs)/catalog.tsx`
- **Purpose:** Search/browse products at buyer-tier prices and build the cart.
- **Shows:**
  - Search box (client debounce via state, `search.trim()`), a clear (✕) button.
  - Horizontal category pills (`["All", ...categories]`) from `useBuyerCategories` → `GET /buyer/products/categories`.
  - **Product card:** name (2 lines), heart favorite toggle, category, price = `buyerPrice ?? basePrice ?? price` with optional ` / unit`. Per-card add control: a `+` button when qty 0, else a `−  qty  +` stepper bound to the cart store.
  - **Floating cart bar** (when cart non-empty): item-count badge, "View cart", cart total.
- **Actions:**
  - Search / category → refetch `useBuyerProducts` → `GET /buyer/products?search=&category=&limit=100`.
  - Heart → `useToggleFavorite` → `POST /buyer/favorites/{productId}` (add) or `DELETE /buyer/favorites/{productId}` (remove); invalidates favorites + products. Favorite set from `useBuyerFavorites` → `GET /buyer/favorites`.
  - `+` → `cart.add({productId,name,unitPrice,unit})`; stepper → `cart.setQty` (client-only Zustand cart).
  - Cart bar → `/(customer)/orders/cart`.
- **States:** **Loading** spinner. **Empty** = "No products found." Category pill row hidden when no categories. Cart bar hidden when cart empty; bottom padding grows when cart present.

#### Invoices list — `(customer)/(tabs)/invoices`

- **File:** `apps/mobile/app/(customer)/(tabs)/invoices.tsx`
- **Purpose:** Browse/filter invoices.
- **Shows:** **Filter chips:** All, Unpaid, Paid, Overdue. Per-invoice card: `#invoiceNumber`, issue date, status `Pill` (PAID→green "Paid", PARTIAL→orange "Partial", SENT→orange "Unpaid", OVERDUE→red "Overdue", VOID→gray "Void"), `$total`, and a red "Due: $amountDue" line when there's a balance and not paid.
- **Actions:** Filter → `useBuyerInvoices` → `GET /buyer/invoices` (Unpaid sends `statuses=["SENT","OVERDUE"]`; Paid/Overdue send `status`). Card → `/(customer)/invoices/{id}`.
- **States:** **Loading** spinner. **Empty** = "No invoices yet." **Pull-to-refresh**. Auto-refreshes on `invoice.updated` socket event.

#### More / Account menu — `(customer)/(tabs)/more`

- **File:** `apps/mobile/app/(customer)/(tabs)/more.tsx`
- **Purpose:** Account summary, settings navigation, sign-out.
- **Shows:** Account card (avatar, `profile.businessName ?? buyer.name ?? buyer.email`, `buyer.email`, `activeSeller.tenant.name`). Stats strip: Active (`activeOrders ?? totalOrders`), Total Spend (`spendAllTime ?? totalSpend`), Unpaid (`unpaidInvoices`, orange when > 0). **ACCOUNT group:** Invoices, Standing Orders. **SETTINGS group:** Profile (subtitle = email), Change Password. Sign-out button.
- **Actions:** Rows push `/(customer)/(tabs)/invoices`, `/(customer)/standing-orders`, `/(customer)/profile`, `/(customer)/change-password`. "Sign out" → `confirm(...)` → `signOut()` (clears buyer tokens + cart) → `router.replace("/(auth)/customer-login")`. Data from `useBuyerProfile` (`GET /buyer/profile`) + `useBuyerDashboard`.
- **States:** Stats strip hidden until dashboard loads; no explicit spinner.

#### Order detail — `(customer)/orders/[id]`

- **File:** `apps/mobile/app/(customer)/orders/[id].tsx`
- **Purpose:** View a single order; cancel or edit when status allows.
- **Shows:** Header card — `#orderNumber`, long date, status `Pill`; when present, "Subtotal: $…", "GST (10%): $…", big `$total`, "Delivery: <date>" (`requestedDeliveryDate`), and `notes`. **Items** list: product name, `qty × $unitPrice / unit`, line `$total`.
- **Actions:** "Edit items" (bordered, shown only when editable) → `/(customer)/orders/{id}/edit-items`. "Cancel order" (shown only when cancellable) → `confirm(...)` → `useBuyerCancelOrder` → `POST /buyer/orders/{id}/cancel`, toast "Order cancelled", `router.back()`. Data via `useBuyerOrder` → `GET /buyer/orders/{id}`.
- **States:** **Loading** spinner (with back nav). **Error / not-found** = "Order not found" + "Back to orders" → `replace` orders tab. **Terminal-status read-only** = both action buttons hidden when status is not editable/cancellable (see rules).

#### Edit order items — `(customer)/orders/[id]/edit-items`

- **File:** `apps/mobile/app/(customer)/orders/[id]/edit-items.tsx`
- **Purpose:** Change quantities / add-remove products on a PENDING or CONFIRMED order.
- **Shows:** Editable draft rows (name, `$unitPrice / unit`, `− <numeric input> +` stepper). "Add product" toggles an inline catalog list (`useBuyerProducts` limit 200); tapping a catalog row adds/increments it. "Save changes" footer button.
- **Actions:** Steppers/`setQty` mutate a local `draft` (qty ≤ 0 removes the line). "Save changes" → `useBuyerUpdateOrderItems` → `PATCH /buyer/orders/{id}/items` with `items: [{productId, qty}]`; on success `router.back()`.
- **States:** **Loading** spinner. **Empty draft** = "No items — add from catalog below." Guard: saving with 0 items → toast "Add at least one item." **Re-confirmation notice:** if the saved order comes back `PENDING` while it was previously `CONFIRMED`, toast "Items saved — order reverted to Pending for re-confirmation." Save button disabled + "Saving…" while pending.
- **Steps:** 1) open from order detail → 2) adjust qty / add products → 3) Save → 4) toast + back (order re-fetches).

#### Cart / Checkout — `(customer)/orders/cart`

- **File:** `apps/mobile/app/(customer)/orders/cart.tsx`
- **Purpose:** Review cart, add optional delivery date + notes, place the order.
- **Shows:**
  - **Items card:** each cart item — name, `$unitPrice / unit`, `−/trash  qty  +` stepper (the `−` becomes a trash icon at qty 1), line `$total`.
  - **Details (optional):** Delivery date — quick chips "Tomorrow / +2 days / +3 days" plus a masked `YYYY-MM-DD` manual field with a formatted preview; Notes multiline field.
  - **Summary:** "N item(s)" + cart total.
  - Sticky footer: "Place order · $total".
- **Actions:** "Clear" (NavBar, shown when non-empty) → `confirm` → `cart.clear()`. Steppers → `cart.setQty`. "Place order" → `useBuyerCreateOrder` → `POST /buyer/orders` with `{ items:[{productId,qty}], notes?, requestedDeliveryDate? }`; on success `cart.clear()`, toast "Order placed", `router.replace("/(customer)/orders/{id}")`.
- **States:** **Empty** = cart icon + "Your cart is empty" + "Browse catalog". Guard: placing with 0 items → toast. Button shows "Placing order…" and dims while pending. Errors surfaced via toast from `e.response.data.message`.
- **Steps:** 1) catalog adds items → 2) open cart → 3) (optional) pick delivery date + notes → 4) Place order → 5) redirect to the new order detail.

#### Invoice detail — `(customer)/invoices/[id]`

- **File:** `apps/mobile/app/(customer)/invoices/[id].tsx`
- **Purpose:** View a single invoice, share its PDF, see payments/balance.
- **Shows:** Header — `#invoiceNumber`, "Issued: <date>", "Subtotal / GST (10%)" when present, big `$total`, "Due: <dueDate>". Status `Pill` (with an `isOverdue` override → "Overdue"). **Amount-due banner** (orange) when unpaid and `balanceDue > 0`. **Items** list: product name/description, `qty × $unitPrice / unit`, optional "− $X disc", line `$subtotal`. **Payments** list: method (e.g. "Bank transfer"), optional "Ref: …", date, `$amount`. **Summary** card: Invoice #, Status, Total, Paid (if any), Balance due (if any).
- **Actions:** "Share PDF" (shown only when `pdfUrl` present) → `sharePdf(...)`. On web it uses the Web Share API (or opens the signed PDF URL in a new tab); on native it downloads to cache and opens the native share sheet. Data via `useBuyerInvoice` → `GET /buyer/invoices/{id}`.
- **States:** **Loading** spinner. Banner/Share button/Payments/Paid rows all conditionally rendered. There is **no in-app "Pay" action** — payment happens off-app; buyers only view/share the PDF and see recorded payments. Share errors → toast.

#### Profile — `(customer)/profile`

- **File:** `apps/mobile/app/(customer)/profile.tsx`
- **Purpose:** Read-only account/business details.
- **Shows:** Rows — Business name, Email, Phone, and Address (line1, city, postcode joined) when present. Missing values render "—".
- **Actions:** Back only. Data via `useBuyerProfile` → `GET /buyer/profile`.
- **States:** **Loading** spinner. Read-only (no edit form on mobile).

#### Change Password — `(customer)/change-password`

- **File:** `apps/mobile/app/(customer)/change-password.tsx`
- **Purpose:** Change the buyer login password.
- **Shows:** Two secure fields — "Current password", "New password" (placeholder "Min 8 characters"). "Save password" button.
- **Actions:** Save → `buyerApiClient.post("/buyer/auth/change-password", { currentPassword, newPassword })`; success toast "Password changed" + back.
- **States:** Client validation — both fields required; new password < 8 chars → toast. Button shows "Saving…" + dims while in-flight; server error message surfaced via toast.

#### Standing Orders — `(customer)/standing-orders`

- **File:** `apps/mobile/app/(customer)/standing-orders.tsx`
- **Purpose:** Manage recurring order templates; trigger an immediate reorder; pause/resume auto-generation.
- **Shows:** Per-template card — name, schedule line (`daysOfWeek` abbreviations, else `frequencyLabel`/`frequency`, else "No schedule") · item count, first ~2 product names (`+N more`), "Next order: Today/Tomorrow/<weekday>/<date>" from `nextFireDate`, a "Paused" badge when `isActive === false`. Actions row: "Order now" and "Pause"/"Resume".
- **Actions:** Card tap or "Order now" → `confirm` → `useBuyerReorder` → `POST /buyer/templates/{id}/reorder`, then push the created order. "Pause"/"Resume" → `confirm` → `useBuyerUpdateTemplate` → `PATCH /buyer/templates/{id}` with `{ isActive }`. Data via `useBuyerTemplates` → `GET /buyer/templates`.
- **States:** **Loading** spinner. **Empty** = "No standing orders." "Order now" disabled while a reorder is pending or the template is paused; Pause/Resume disabled while updating.

#### Orders index redirect — `(customer)/orders/index`

- **File:** `apps/mobile/app/(customer)/orders/index.tsx`
- **Purpose:** Deep-link safety net (BUG-B1-7) — `/orders` had no bare match (only `[id]` and `cart`).
- **Shows:** Nothing.
- **Actions:** `<Redirect href="/(customer)/(tabs)/orders" />`.
- **States:** N/A.

### Key flows (end-to-end journeys through this area)

- **Browse → cart → place order:** Catalog (tap `+`/stepper → Zustand cart) → floating cart bar → Cart (optional delivery date + notes) → "Place order" (`POST /buyer/orders`) → redirect to Order detail. Decision point: empty-cart guard blocks placement.
- **Track & amend an order:** Orders list (filter) → Order detail → "Edit items" (only PENDING/CONFIRMED) → Edit-items (`PATCH /buyer/orders/{id}/items`) → back; editing a CONFIRMED order reverts it to PENDING (toast). Alternatively → "Cancel order" (`POST /buyer/orders/{id}/cancel`) when PENDING/DRAFT.
- **Reorder from a template:** Home/More/Standing-orders → Standing Orders → "Order now" (`POST /buyer/templates/{id}/reorder`) → new Order detail. Or "Pause"/"Resume" to stop/start auto-generation (`PATCH /buyer/templates/{id}`).
- **Pay-down visibility:** Home balance card → Invoices list (Unpaid filter) → Invoice detail → "Share PDF" (to pay off-app) → payments appear back in the invoice's Payments section (pushed live via `invoice.updated` socket).

### Use cases

- As a buyer, I want to see what I owe the moment I open the app so I can plan payments. (path: Home balance card → Invoices)
- As a buyer, I want to reorder my usual products quickly at my negotiated prices. (path: Catalog → Cart → Order detail, or Standing Orders → "Order now")
- As a buyer, I want to fix a quantity mistake before the order ships. (path: Orders → Order detail → Edit items)
- As a buyer, I want to cancel an order I placed by mistake. (path: Orders → Order detail → Cancel order)
- As a buyer, I want to share an invoice PDF with my accounts team. (path: Invoices → Invoice detail → Share PDF)
- As a buyer supplying multiple vendors, I want everything scoped to the seller I'm buying from right now. (path: seller selection → all tabs filtered by `X-Tenant-Slug`)
- As a buyer, I want recurring orders to auto-generate but be pausable during a shutdown. (path: Standing Orders → Pause/Resume)

### Business rules & edge cases

- **Multi-seller, one active at a time:** A buyer login can be linked to several seller tenants (`getBuyerSellers` → `GET /buyer/sellers`), but exactly one `activeSeller` is stored (`buyer-session-store` + SecureStore/localStorage). Every buyer request attaches `Authorization: Bearer <buyer JWT>` **and** `X-Tenant-Slug: <activeSeller.tenant.slug>` (from `buyerApiClient` request interceptor). Missing `buyer` or `activeSeller` → forced redirect to `/(auth)/customer-login`.
- **Buyer-tier pricing is server-resolved:** the catalog reads price as `buyerPrice ?? basePrice ?? price` — the API returns the buyer's negotiated per-customer price in `buyerPrice`; the client never computes tiers. This resolved `unitPrice` is what seeds the cart and is echoed back on the order.
- **Order status gating:**
  - Editable (Edit items shown, `PATCH /items` allowed): `PENDING` or `CONFIRMED`.
  - Cancellable (Cancel shown): `PENDING` or `DRAFT`.
  - `DELIVERED`, `IN_TRANSIT`/`OUT_FOR_DELIVERY`, `CANCELLED` → read-only (no action buttons).
- **Edit reverts confirmation:** saving item changes on a `CONFIRMED` order returns it to `PENDING` for operator re-confirmation (explicit toast). This mirrors the operator/web behavior.
- **Tax display:** subtotal/tax shown as "GST (10%)" on both order and invoice detail (AU-style), rendered only when the API supplies `subtotal` and `tax`.
- **Cash/payment:** buyers cannot pay in-app — the invoice screen is view + "Share PDF" only; recorded payments (method, reference, amount, date) are shown read-only. Balance = `balanceDue ?? amountDue`, paid = `paidAmount ?? amountPaid`. Overdue is driven by `status === "OVERDUE"` or the `isOverdue` flag.
- **Cart is client-only + ephemeral:** the cart lives in a Zustand store (`store/cartStore.ts`), not persisted server-side; it is **cleared on sign-out, on session-expiry (401 refresh failure), and on cross-tab logout**. `add` starts qty at 1; `setQty ≤ 0` removes the line.
- **Delivery date input:** integer-masked to `YYYY-MM-DD` (max 8 digits → dashes inserted); quick chips compute Tomorrow/+2/+3 days; sent as `requestedDeliveryDate` only when set. Notes optional.
- **No offline queue for buyers:** unlike the driver surface, buyer mutations are online-only (plain axios, no replay queue). The only resilience is TanStack Query caching + the shared socket that live-invalidates `buyer-orders`/`buyer-invoices`/`buyer-products`/`buyer-dashboard`/`buyer-credit-notes`.
- **Realtime freshness:** `useBuyerSocket` (hoisted in `_layout`) connects with the buyer JWT (polling→websocket upgrade, infinite reconnect) and invalidates queries on `order.statusChanged`, `invoice.updated`, `inventory.low.stock`, `creditNote.created` — so lists refresh without pull-to-refresh.
- **Array query params:** buyer list endpoints serialize repeated keys (`?statuses=SENT&statuses=OVERDUE`, `paramsSerializer indexes:null`) because the API's `ValidationPipe` (forbidNonWhitelisted) rejects bracketed `statuses[]`.
- **Auth/session:** buyer JWTs carry `type: "BUYER"`; `getStoredBuyer` rejects expired/non-buyer tokens. 401s trigger a single refresh via `POST /buyer/auth/refresh`; refresh failure clears tokens and signals the session store to redirect. Change-password requires the current password and an 8+ char new password. Google login is supported at the entry (`context: "buyer-standalone"`, no tenant slug — matched by email) but lives in `(auth)`, outside this area.

Relevant files (all absolute):

- `C:\ClaudeCode\routeflow\apps\mobile\app\(customer)\_layout.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(customer)\(tabs)\_layout.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(customer)\(tabs)\{home,orders,catalog,invoices,more}.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(customer)\{profile,change-password,standing-orders}.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(customer)\orders\{index.tsx,[id].tsx,cart.tsx,[id]\edit-items.tsx}`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(customer)\invoices\[id].tsx`
- Supporting: `C:\ClaudeCode\routeflow\apps\mobile\lib\api\buyer.ts`, `lib\buyer-auth.ts`, `lib\buyer-session-store.ts`, `store\cartStore.ts`, `hooks\useBuyerSocket.ts`, `lib\share-pdf.ts`
