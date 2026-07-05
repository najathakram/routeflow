# 11. Buyer B2B Portal — `/buyer/portal/*`

**Role(s):** Buyer (a business that purchases from one or more RouteFlow seller tenants; buyer JWT
in the isolated `BUYER_KEYS` namespace — never the operator `OP_KEYS`).  •  **Entered via:** After
buyer login/register/invite-accept in `(auth)` (see [`01-auth-and-entry.md`](01-auth-and-entry.md)
for `/buyer/login`, `/buyer/register`, `/buyer/invite/[token]`, `/buyer/verify-merge`,
`/buyer/change-password`, and the `/buyer` entry redirect). The authenticated shell is the
dark-emerald left sidebar in `buyer/portal/layout.tsx`; deep links (`/buyer/portal/<slug>/…`)
resolve into it behind the `useBuyerAuth` guard.

The buyer portal is the **web analog of the mobile customer stack**
([`../mobile-inventory/02-customer.md`](../mobile-inventory/02-customer.md)) — same endpoints, same
DTOs, richer desktop UI (left sidebar instead of bottom tabs, tables, pagination, Recharts, grid/list
toggles, inline edit). A buyer browses the **active seller's** catalog at negotiated (buyer-tier)
prices, builds a per-seller cart, places/tracks/edits orders, views + downloads invoice PDFs, sees
finances/AR, and reorders from seller-defined **standing orders**. A single buyer login can be
linked to **multiple sellers**, but the whole portal is scoped to **one active seller at a time**.

> This file covers only the **authenticated portal** (`buyer/layout.tsx`, `buyer/portal/**`). Login,
> register, invite, verify-merge, change-password, and the `/buyer` entry are in `01-auth-and-entry.md`.

---

## Shell / layout

### Buyer metadata layout — `buyer/layout.tsx`

- **File:** `apps/web/app/buyer/layout.tsx`
- **Purpose:** Metadata + PWA shell only (passthrough `{children}`).
- **Shows:** Nothing visible. Sets viewport `themeColor #047857`, title template `"%s · RouteFlow"`,
  `manifest: /buyer-manifest.json`, apple-web-app capable, icons `/logo-buyer.svg` — the buyer PWA is
  a distinct installable app from the operator dashboard.
- **Actions / States:** None.

### Portal shell — `buyer/portal/layout.tsx`

- **File:** `apps/web/app/buyer/portal/layout.tsx` (`BuyerPortalLayout`)
- **Purpose:** Auth guard + the dark-emerald sidebar chrome wrapping every portal page.
- **Shows:**
  - **Sidebar** (`w-64`, `bg-gradient-to-b from-buyer-900 to-buyer-800`): header with
    `/logo-buyer.svg` + "RouteFlow / Buyer Portal", and a **notification bell**.
  - **Notification bell:** `useBuyerNotifications` — `unreadCount` red badge; opening the popover
    fires `markAllRead()`. Popover lists up to 20 notifications (title, description, time) with a
    **Clear all**; empty = "No notifications".
  - **Settings** link (`/buyer/portal/settings`) at the top of the nav.
  - **"Your Sellers"** — collapsible dropdown (`ChevronDown` rotates). **Collapsed** shows the active
    seller's name in a highlighted pill. **Expanded** lists every linked seller as a `SellerItem`
    (2-letter avatar, `tenant.name`, `customer.businessName`, `ChevronRight` on the active one) plus a
    **Manage Sellers** link (`/buyer/portal`). Empty expanded state = dashed box "No sellers linked yet".
  - **Per-seller nav** (only when an `activeSeller` is set), section-titled with the seller name:
    **Dashboard · Shop · Favorites · Orders · Invoices · Finances · Standing Orders · Account**
    (icons: LayoutDashboard, Store, Heart, ShoppingCart, FileText, TrendingUp, Repeat, User). The
    **Shop** row carries a cart-count badge (`cartItemCount` from `useBuyerCart`, `bg-buyer-400`).
  - **Footer:** buyer name + email card, and a **Sign Out** button (`logout()`).
  - **Global floating cart button** (`fixed bottom-6 right-6`): shown on every page when
    `cartItemCount > 0` and the path is not `/cart`; routes to the active seller's `/cart`.
- **Actions:** Click a seller → `setActiveSeller(seller)` + `router.push(.../<slug>/dashboard)`.
  Nav links `router.push`. Sign out → `logout()` (clears buyer tokens, `window.location = /buyer/login`).
- **States:**
  - **Loading** = full-screen centered `Loader2` (buyer-500) while `isLoading`.
  - **Unauthenticated** = `useEffect` redirects to `/buyer/login?redirect=<encoded current path>` and
    renders `null` (so login can bounce back). Guard reads only `BUYER_KEYS` — never operator tokens
    (RF-220 / NEW-m2-1 token isolation).
  - **No active seller** = per-seller nav + floating cart hidden; only Settings + "Your Sellers" show.
  - Content wrapped in `BuyerPortalErrorBoundary`.

---

## Screens

### Seller directory / portal landing — `/buyer/portal`

- **File:** `apps/web/app/buyer/portal/page.tsx` (`BuyerPortalPage` → `BuyerPortalInner`)
- **Purpose:** Manage seller connections and pick the active seller. This is "Manage Sellers".
- **Shows:**
  - Header "Your Sellers" + "Select a seller to view your orders and invoices." with **Refresh** and
    **Connect Seller** buttons.
  - **Seller list** — one `SellerCard` per linked seller: logo (`{apiUrl}/uploads/{tenant.logoKey}`
    or a `Building2` fallback), `tenant.name`, `customer.businessName`, a status `Badge`
    (`linkStatus` → ACTIVE=success, PENDING/PENDING_SELLER_APPROVAL=warning,
    SUSPENDED/DISCONNECTED=danger), and a hover arrow.
  - **Connect Seller modal** — form (`connectSchema` via zod): **Seller Company Code** (slug,
    lowercased/trimmed) + **Your Email at This Seller** (email). Submits
    `requestSellerConnection(slug, email, token)` → `POST /buyer/sellers/request`. Success state =
    "Request sent!" ("seller will review and approve"). Errors surfaced inline from
    `err.response.data.message`.
  - **Linked banner** — when `?linked=true` in the URL, a green success banner ("You are now
    connected to {name}. Welcome!") auto-dismisses after 5 s and strips the query param.
- **Actions:** Card click → `setActiveSeller` + `router.push(.../<slug>/orders)`. **Refresh** →
  `refreshSellers()` (`GET /buyer/sellers`). **Connect Seller** → open modal.
- **States:**
  - **Loading** = centered spinner.
  - **Empty (no sellers)** = dashed card, `Building2` icon, "No sellers connected yet" + primary
    **Connect to a Seller** CTA + an "Got an invite link?" hint (check email → click link →
    connected instantly). This is the `01-auth` invite flow's landing target.

### Global buyer settings — `/buyer/portal/settings`

- **File:** `apps/web/app/buyer/portal/settings/page.tsx`
- **Purpose:** Account-level (not seller-scoped) settings — currently only **Merge Accounts**.
- **Shows:** "Account Settings" + a **Merge Accounts** card: explains merging two RouteFlow accounts
  (current account `{buyer.email}` is kept, the other is absorbed, its seller connections transfer).
  Form: other account **email** (required) + optional **notes**.
- **Actions:** Submit → `POST /buyer/auth/merge-request` (bare `fetch`, Bearer from `buyerToken`) with
  `{ secondaryEmail, notes? }`. Success card shows the returned message + "Submit another request".
- **States:** **Loading** = "Sending…" + spinner, button disabled. **Error** = danger banner.
  ⚠️ *Inconsistency:* this page uses `NEXT_PUBLIC_API_URL` without the `/api/v1` prefix and reads a
  legacy `buyerToken` key (not `BUYER_KEYS.accessToken` via `buyerApiClient`) — divergent from every
  other portal page. Flag for the redesign / follow-up.

### Seller root redirect — `/buyer/portal/[seller]`

- **File:** `apps/web/app/buyer/portal/[seller]/page.tsx`
- **Purpose:** Bare-slug safety net — `router.replace(.../<seller>/dashboard)` so deep links and the
  back button don't 404. Renders `null`.

### Per-seller dashboard — `/buyer/portal/[seller]/dashboard`

- **File:** `apps/web/app/buyer/portal/[seller]/dashboard/page.tsx`
- **Purpose:** The buyer's home for the active seller — KPIs, standing orders, reorder shortcuts,
  discovery, spend summary.
- **Shows:**
  - Welcome header ("Welcome back, {customer.businessName}" · "Your dashboard at {tenant.name}").
  - **4 stat cards:** Active Orders, This Month (`spend30d`), Pending Deliveries, Standing Orders
    (`templateCount`).
  - **Standing Orders panel** (only when ≥1 active template): each shows name, `daysOfWeek` chips,
    item count, a next-delivery label ("Today/Tomorrow/This <weekday>/No schedule"), and a **Reorder**
    button (`useBuyerReorder` → `POST /buyer/templates/{id}/reorder`). "Manage" → `/templates`.
  - **Frequently Ordered** (with a 30d/90d/All-time toggle driving `useBuyerDashboard(window)`) — up
    to 6 product tiles (focal-point 4:5 image via `objectPositionForUrl`, name, `buyerPrice`, **Add**
    → `cart.addItem`).
  - **Recent Orders** — rows (orderNumber, date · itemCount, status `Badge`, `total`) → order detail.
  - **New from {seller}**, **Featured by {seller}** (amber), **Suggested for You** (with category
    chip) — horizontal-scroll discovery carousels, each with per-tile **Add**.
  - **Spending Summary** — Last 30 / 90 / All-time (`spend30d/spend90d/spendAllTime`).
  - **PwaInstallPrompt** (only when cart empty); a **Browse Products** + conditional **View Cart** CTA.
- **Actions:** Add-to-cart tiles; navigate to shop/orders/cart/templates; reorder-from-template.
  Data: `useBuyerDashboard` → `GET /buyer/dashboard?frequentWindow=`, `useBuyerTemplates` →
  `GET /buyer/templates`.
- **States:** **Loading** = spinner. **Error** = danger banner "Failed to load dashboard data."
  Redirects to `/buyer/portal` if no `activeSeller`. Discovery sections are each hidden when empty.

### Shop / catalog — `/buyer/portal/[seller]/shop`

- **File:** `apps/web/app/buyer/portal/[seller]/shop/page.tsx`
- **Purpose:** Browse the active seller's products at buyer-tier prices and build the cart.
- **Shows:**
  - Header "Shop — Browse products from {tenant.name}".
  - **Search** (debounced 300 ms; "name, SKU, or barcode", clearable), **Sort** select (Name A-Z /
    Z-A / Price Low-High / High-Low), **grid/list view toggle**.
  - **Category pills** (`["", ...categories]`, "All" first) from `useBuyerCategories`.
  - **Results count** ("Showing X to Y of N products").
  - **Grid `ProductCard`:** 4:5 focal image, favorite **heart** toggle, category chip, "Featured"
    badge, name, SKU, `buyerPrice` + "per {unit} (N/box)", and either an **Add** button or a
    `QtyStepper` (X-remove + −/number/+; number input commits on blur/Enter).
  - **List view:** table (Product/Category/SKU/Price/Actions) with heart + Add/stepper per row.
  - **Sticky cart bar** (bottom) when cart non-empty: item + product counts + **View Cart**.
  - **Pagination** (prev/next, "Page X of Y") when `totalPages > 1`; `limit = 20`.
- **Actions:** Search/sort/category/page → `useBuyerProducts({search,category,page,limit,sort})` →
  `GET /buyer/products`. Heart → `useBuyerAddFavorite`/`useBuyerRemoveFavorite`
  (`POST`/`DELETE /buyer/favorites/{productId}`). Add → `cart.addItem` (boxed products seed
  `qty = unitsPerBox`, `boxes:1`, `pieces:0`).
- **States:** **Loading** = spinner. **Error** = danger card. **Empty** = "No products found"
  ("Try adjusting your search or filters" vs "No products available from this seller yet") with a
  **Clear all filters** link when filtered. Category pill row hidden when no categories.

### Favorites — `/buyer/portal/[seller]/favorites`

- **File:** `apps/web/app/buyer/portal/[seller]/favorites/page.tsx`
- **Purpose:** Saved products for quick re-add.
- **Shows:** Header "Favorites — Your saved products from {tenant.name}"; grid of `FavoriteCard`
  (image, filled-heart remove button, category chip, name, SKU, `buyerPrice`/unit, Add or −/qty/+
  stepper). Data: `useBuyerFavorites` → `GET /buyer/favorites`.
- **Actions:** Remove favorite → `useBuyerRemoveFavorite` (per-card `isRemoving`). Add / adjust qty →
  cart.
- **States:** **Loading** = spinner. **Error** = danger card. **Empty** = "No favorites yet"
  ("tap the heart icon on products") + **Browse Products** CTA. Redirects if no active seller.

### Cart / checkout — `/buyer/portal/[seller]/cart`

- **File:** `apps/web/app/buyer/portal/[seller]/cart/page.tsx`
- **Purpose:** Review/edit the per-seller cart, set options, place the order (or merge into an open one).
- **Shows:**
  - Back-to-shop link, "Cart".
  - **Active-order merge banner** when an open order exists (`useBuyerActiveOrder` →
    `GET /buyer/orders/active`): "Items will be added to your existing order #…" with a **Create new
    order instead** toggle (and its inverse "Add to existing order instead").
  - **Items table** (Product / Qty / Price / Subtotal / remove-trash). Boxed items get a
    **boxes + pieces** dual input (`= {qty} {unit}` helper); simple items get a −/number/+ stepper.
    Subtotals via `computeLineSubtotal` (boxed proration — money discipline). Prices resolved fresh
    from `useBuyerProducts` into a `priceMap` (not stored in the cart).
  - **Order Options:** Requested Delivery Date (`<input type=date>`), Order Notes, **Mark as urgent**
    checkbox.
  - **Order Summary:** Subtotal (N items), "Tax — Calculated at checkout", Estimated Total.
  - Primary button label = **"Add to existing order"** when merging, else **"Place Order"**.
- **Actions:** Steppers/inputs → cart mutations. Place → `useBuyerCreateOrder` → `POST /buyer/orders`
  with `{ items:[{productId,qty,boxes?,pieces?}], notes?, urgent, requestedDeliveryDate?,
  status:"PENDING", forceNew }`. Cart is **cleared only after** confirmed success (avoids data loss).
  Merge → navigate to the existing order; else → success panel.
- **States:** **Loading (auth)** = spinner. **Success panel** = "Order Placed!" + order number, with
  **View Order** / **Continue Shopping**. **Empty** = "Your cart is empty" + Browse Products.
  **Error** = danger banner from `err.response.data.message`. Button `loading` while pending.

### Orders list — `/buyer/portal/[seller]/orders`

- **File:** `apps/web/app/buyer/portal/[seller]/orders/page.tsx`
- **Purpose:** Browse/filter the buyer's orders with this seller.
- **Shows:** Header (business name at tenant). **Status filter chips:** All, Active (PENDING),
  Confirmed, Out for Delivery, Delivered, Cancelled. **Table:** Order # (or id-slice), Date, Items
  (`itemCount`), status `Badge`, Total (`totalAmount ?? total`). Pagination (`limit 20`).
- **Actions:** Filter chip → refetch `useBuyerOrders({page,limit,status})` → `GET /buyer/orders`. Row
  click → order detail. Slug-mismatch or no-seller → redirect to `/buyer/portal`.
- **States:** **Loading** = spinner. **Error** = danger banner. **Empty** = "No orders yet — Orders
  from this seller will appear here."

### Order detail — `/buyer/portal/[seller]/orders/[id]`

- **File:** `apps/web/app/buyer/portal/[seller]/orders/[id]/page.tsx`
- **Purpose:** View one order; edit items or cancel when status allows; track delivery.
- **Shows:**
  - Header (orderNumber, "Placed {date}" · "Delivery requested {date}", status `Badge`).
  - **Status timeline** (`OrderTimeline`): Pending → Confirmed → Out for Delivery → Partial Delivery →
    Delivered; a dedicated red **Cancelled** node when cancelled.
  - **Summary cards:** Subtotal, Tax, Discount (`-$…` when `discountAmount>0`), **Total** (bold).
  - **Urgent** banner and **Order Notes** card when present.
  - **Line items table:** product name + unit, a `priceType` chip ("Discounted"/"Special" when not
    STANDARD), Qty (+ "N boxes + M pcs" sub-line), Unit Price with **strikethrough `originalPrice`**
    when discounted (line-discount convention), Subtotal. When delivering
    (OUT_FOR_DELIVERY/PARTIALLY_DELIVERED/DELIVERED) extra **Delivered / Remaining** columns appear;
    CANCELLED lines render struck-through/dimmed.
  - **Edit mode** (in-place): remove-line trash, −/number/+ qty steppers, and an **inline product
    search** (`GET /buyer/products?search=&limit=6`, min 2 chars, filters out already-added) to add
    lines. Save = `useBuyerUpdateOrderItems` → `PATCH /buyer/orders/{id}/items` `{items:[{productId,qty}]}`.
  - **Cancel Order** button + confirmation `Modal`.
- **Actions:** Edit Items (shown when editable) → enter edit → Save/Cancel. Cancel Order → modal →
  `useBuyerCancelOrder` → `POST /buyer/orders/{id}/cancel`. Data: `useBuyerOrder` → `GET /buyer/orders/{id}`.
- **States:** **Loading** = spinner. **Error/not-found** = "Failed to load order." Action errors →
  inline danger banner. **Read-only** when status not DRAFT/PENDING (Edit + Cancel hidden).

### Invoices list — `/buyer/portal/[seller]/invoices`

- **File:** `apps/web/app/buyer/portal/[seller]/invoices/page.tsx`
- **Purpose:** Browse invoices for the active seller.
- **Shows:** Header. **Table:** Invoice # (or id-slice), Date, Due Date, status `Badge`
  (PAID=success; PENDING/SENT/PARTIALLY_PAID=warning; OVERDUE/CANCELLED/VOID=danger), Amount
  (`totalAmount ?? amount`), Balance (`balanceDue ?? balance`). Pagination (`limit 20`).
  Fetched directly via `buyerApiClient.get("/buyer/invoices", {params:{page,limit}})` (local state,
  **not** a TanStack hook — divergent from the rest).
- **Actions:** Row click → invoice detail. Slug-mismatch / no-seller → redirect.
- **States:** **Loading** = spinner. **Error** = danger banner. **Empty** = "No invoices yet."
  ⚠️ *No status filter here* (mobile has All/Unpaid/Paid/Overdue chips) — flag for redesign parity.

### Invoice detail — `/buyer/portal/[seller]/invoices/[id]`

- **File:** `apps/web/app/buyer/portal/[seller]/invoices/[id]/page.tsx`
- **Purpose:** View one invoice, download its PDF, see payment history/balance.
- **Shows:** Header (invoiceNumber, "Issued {issueDate} · Due {dueDate}", status `Badge`, **PDF**
  button when `pdfUrl`). **Summary cards:** Subtotal, Tax (`taxAmount`), Total, **Balance Due**
  (`total − Σpayments`; Clock vs CheckCircle icon). **Items table** (Description, Qty, Unit Price,
  Subtotal). **Payment History** (Date, Method, Amount) when payments exist. **Notes** + **Terms** cards.
- **Actions:** **PDF** → `handleDownloadPdf` uses `fetchPdfBlob(pdfUrl, buyerApiClient)` (same-origin
  → JWT-attached client; external presigned R2 → bare axios) → blob download. A plain
  `<a href={pdfUrl}>` would 401 in prod because top-level nav drops the Bearer token.
  Data: `useBuyerInvoice` → `GET /buyer/invoices/{id}`.
- **States:** **Loading** = spinner. **Error** = danger banner. PDF button shows a spinner + toast on
  failure (401 → "refresh and try again"). **No in-app "Pay"** — buyers download the PDF and pay
  off-app; recorded payments appear read-only (mirrors mobile).

### Finances — `/buyer/portal/[seller]/finances`

- **File:** `apps/web/app/buyer/portal/[seller]/finances/page.tsx`
- **Purpose:** Spend analytics + AR overview for the active seller.
- **Shows:** Header. **4 stat cards:** Total Spend (all-time), Total Orders (+ avg order value),
  Outstanding (`unpaidInvoiceTotal` + unpaid count), Paid Invoices (+ overdue count). **Monthly Spend
  bar chart** (Recharts, last 12 months, custom tooltip). **Invoice Status** breakdown bars
  (Paid/Unpaid/Overdue with %). **Recent Payments** list (invoice #, date · method, amount).
  Data: `useBuyerAnalytics` → `GET /buyer/analytics`.
- **Actions:** View only.
- **States:** **Loading** = spinner. **Error** = danger banner "Failed to load financial data."
  Empty chart = "No spend data yet"; empty payments = "No payments recorded yet."

### Standing orders (templates) — `/buyer/portal/[seller]/templates`

- **File:** `apps/web/app/buyer/portal/[seller]/templates/page.tsx`
- **Purpose:** View seller-defined recurring templates and one-click reorder.
- **Shows:** Header ("Recurring order templates set up by {tenant.name}"). Each `TemplateRow`:
  expand chevron, name, Active/Paused `Badge`, schedule (`formatSchedule` → "Every day"/"Weekdays"/day
  list/"No schedule"), item count, "Next: {date}" (`nextFireDate`), **Reorder Now** button. Expanding
  reveals notes + an items table (Product / Unit / Qty / Notes). Summary footer ("N active · M paused"
  + total items). Data: `useBuyerTemplates` → `GET /buyer/templates`.
- **Actions:** **Reorder Now** → `useBuyerReorder` → `POST /buyer/templates/{id}/reorder`; success
  banner links to `/orders`.
- **States:** **Loading** = spinner. **Error** = danger card. **Empty** = "No standing orders — Your
  seller hasn't set up any recurring order templates for you yet." Success/error inline banners.
  ⚠️ *Read-only vs mobile:* web has **no create/edit/delete/pause-resume** here — only reorder.
  Templates are seller-authored; the prompt's "create/edit/delete" is a mobile/operator capability,
  not present on this web page. Flag for redesign.

### Seller-specific account — `/buyer/portal/[seller]/account`

- **File:** `apps/web/app/buyer/portal/[seller]/account/page.tsx`
- **Purpose:** Buyer profile + the current seller connection + security.
- **Shows:** **Your Profile** card (Full Name, Email — read-only). **Seller Connection** card (Seller,
  Your Business, Business Email if present, Connection Status `Badge`) + **Switch Seller** button.
  **Security** card → **Change Password** link (`/buyer/change-password`, in `01-auth`).
- **Actions:** **Switch Seller** → `clearActiveSeller()` + `router.push("/buyer/portal")`. Change
  Password → auth area.
- **States:** **Loading** = spinner. Slug-mismatch / no-seller → redirect. No billing/delivery-address
  or tobacco-license fields render here (data isn't exposed to the buyer web account page today).

---

## Key flows

- **Link a seller → shop → cart → place order:** `/buyer/portal` → **Connect Seller** (or open an
  invite link from `01-auth`) → seller appears (PENDING → ACTIVE after seller approval) → pick it
  (`setActiveSeller`) → **Shop** (search/filter, Add to cart) → **Cart** (options: delivery date,
  notes, urgent) → **Place Order** (`POST /buyer/orders`) → success panel / order detail. Decision
  point: if an open order exists, the cart offers **merge vs new** (`forceNew` / `activeOrder`).
- **Reorder from history / standing order:** Dashboard/Standing-Orders → **Reorder Now**
  (`POST /buyer/templates/{id}/reorder`) → new order in `/orders`. (No manual "reorder this past
  order" button on order detail; discovery carousels + Frequently Ordered fill the quick-re-add gap.)
- **Track & amend:** Orders list (filter) → Order detail → timeline; **Edit Items**
  (`PATCH /buyer/orders/{id}/items`, only DRAFT/PENDING) or **Cancel Order**
  (`POST /buyer/orders/{id}/cancel`, DRAFT/PENDING).
- **View & pay an invoice:** Finances / Invoices list → Invoice detail → **PDF** download → pay
  off-app → recorded payments show in Payment History (pushed live via `invoice.updated` socket
  notification).
- **Switch sellers:** Sidebar "Your Sellers" dropdown or Account → Switch Seller → back to
  `/buyer/portal`; the cart, orders, invoices, finances all re-scope to the new active seller.

## Use cases

- As a buyer, I want to connect to my supplier by company code (or an invite link) and start ordering.
- As a buyer, I want to reorder my usual products fast at my negotiated prices (Frequently Ordered,
  discovery carousels, standing-order Reorder Now).
- As a buyer, I want to fix a quantity/line before the order is confirmed (Edit Items on PENDING).
- As a buyer, I want to cancel an order placed by mistake.
- As a buyer, I want to download an invoice PDF for my accounts team and see what's been paid.
- As a buyer, I want a spend/AR overview so I know what I owe (Finances).
- As a buyer supplying several vendors, I want everything scoped to the seller I'm buying from now.
- As a buyer with two logins, I want to merge them (Settings → Merge Accounts).

## Business rules & edge cases

- **Multi-seller, one active at a time:** `getBuyerSellers` → `GET /buyer/sellers` returns
  `BuyerSeller[]` (`linkId`, `linkStatus`, `tenant{id,slug,name,logoKey,primaryColor}`,
  `customer{id,businessName,email}`). Exactly one `activeSeller` is persisted
  (`storeActiveSeller`/`getStoredActiveSeller` under `BUYER_KEYS.activeSeller`). All `[seller]` pages
  guard `activeSeller.tenant.slug === params.seller`, else redirect to `/buyer/portal`.
- **Buyer-token isolation (RF-220 / NEW-m2-1):** `buyerApiClient` reads **only** `BUYER_KEYS.*`
  (`rf:buyer:accessToken/refreshToken/activeSeller`) — never the operator `rf:op:*` keys — so a browser
  with both an operator and a buyer session open never bleeds tokens. 401 → single refresh via
  `POST /buyer/auth/refresh` through a shared refresh queue; refresh failure clears buyer keys and
  hard-redirects to `/buyer/login`. (⚠️ the **settings** page still uses a legacy `buyerToken` key +
  no `/api/v1` prefix — inconsistent, flag it.)
- **Tenant scoping:** every buyer request also attaches `X-Tenant-Slug: <activeSeller.tenant.slug>`
  (request interceptor) so the API resolves the right seller tenant.
- **Buyer-tier pricing is server-resolved:** catalog/dashboard read `buyerPrice` (the buyer's
  negotiated per-customer price). The client never computes tiers; the cart stores **no prices** and
  resolves them fresh from `useBuyerProducts` into a `priceMap` at checkout.
- **Per-seller, client-only cart:** `useBuyerCart` keys localStorage by
  `buyerCart_<buyerId>_<sellerSlug>` — carts never cross sellers. Same-tab sync via a `cart-updated`
  CustomEvent; cross-tab via the native `storage` event. Boxed products carry `unitsPerBox/boxes/pieces`;
  `qty ≤ 0` removes the line. Not persisted server-side; cleared on order success. Sidebar Shop badge
  + floating cart button + sticky shop bar all read the same store.
- **Money discipline:** cart subtotals use `computeLineSubtotal` (boxed proration) from
  `lib/pricing.ts`; order-detail line subtotals come from the API (`li.subtotal`). Discount lines use
  the override convention (net `unitPrice` + strikethrough `originalPrice`; never re-derive discount).
- **Order status gating:** editable + cancellable only when `DRAFT` or `PENDING`. Editing does not
  auto-revert confirmation on web (the web page only allows edits while still PENDING/DRAFT; the
  mobile "edit a CONFIRMED order → reverts to PENDING" path is not exposed here). Delivery progress
  columns appear for OUT_FOR_DELIVERY/PARTIALLY_DELIVERED/DELIVERED.
- **Order merge:** placing a cart while an active (open) order exists offers merge-into-existing vs
  force-new (`forceNew`); default is merge.
- **Invoices are view + PDF only** (no in-app pay); balance = `total − Σpayments`. PDF fetched as an
  auth blob to survive the JWT-protected uploads endpoint. Invoice list here lacks the mobile status
  filters.
- **Standing orders are seller-authored & read-only on web** — buyer can only Reorder Now (mobile can
  pause/resume; neither web nor mobile buyer *creates* templates).
- **Realtime (notifications only):** `useBuyerNotifications` opens a socket with the buyer JWT and
  pushes toasts/bell entries on `order.statusChanged`, `invoice.updated`, `creditNote.created`,
  `route.stop.completed`; notifications persist in `rf_buyer_notifications` localStorage (max 50).
  Unlike mobile there is **no blanket TanStack query invalidation** wired to the socket here — lists
  refresh on navigation/refetch, not push.
- **Seller connection lifecycle:** requests land as PENDING / PENDING_SELLER_APPROVAL (warning), become
  ACTIVE on seller approval (success), or SUSPENDED/DISCONNECTED (danger). `?linked=true` shows the
  one-time success banner on `/buyer/portal`.

## Relevant files (all absolute)

- Shell: `C:\ClaudeCode\routeflow\apps\web\app\buyer\layout.tsx`,
  `C:\ClaudeCode\routeflow\apps\web\app\buyer\portal\layout.tsx`,
  `C:\ClaudeCode\routeflow\apps\web\app\buyer\portal\error-boundary.tsx`
- Landing/settings: `C:\ClaudeCode\routeflow\apps\web\app\buyer\portal\page.tsx`,
  `...\buyer\portal\settings\page.tsx`
- Per-seller: `C:\ClaudeCode\routeflow\apps\web\app\buyer\portal\[seller]\page.tsx`,
  `...\[seller]\dashboard\page.tsx`, `...\[seller]\shop\page.tsx`, `...\[seller]\favorites\page.tsx`,
  `...\[seller]\cart\page.tsx`, `...\[seller]\orders\page.tsx`, `...\[seller]\orders\[id]\page.tsx`,
  `...\[seller]\invoices\page.tsx`, `...\[seller]\invoices\[id]\page.tsx`,
  `...\[seller]\finances\page.tsx`, `...\[seller]\templates\page.tsx`, `...\[seller]\account\page.tsx`
- Supporting: `C:\ClaudeCode\routeflow\apps\web\lib\buyer-auth-context.tsx`,
  `...\lib\buyer-auth.ts`, `...\lib\buyer-api-client.ts`, `...\lib\buyer-cart.ts`,
  `...\lib\auth-keys.ts` (`BUYER_KEYS`), `...\lib\api\buyer.ts` (all `useBuyer*` hooks),
  `...\lib\hooks\useBuyerNotifications.ts`, `...\lib\image-focal.ts` (`objectPositionForUrl`),
  `...\lib\pricing.ts` (`computeLineSubtotal`), `...\lib\fetch-pdf-blob.ts`,
  `...\components\PwaInstallPrompt.tsx`
- Tests: `C:\ClaudeCode\routeflow\apps\web\e2e\04-buyer-portal.spec.ts` (BY-01…13),
  `...\e2e\03-customer.spec.ts`
- Cross-links: `01-auth-and-entry.md` (buyer login/register/invite/verify-merge/change-password),
  `../mobile-inventory/02-customer.md` (mobile analog).

---

## 💡 Faster ways (redesign suggestions — not current behavior)

- **Quick-reorder from a past order:** add a "Reorder" button on order-list rows and order detail that
  seeds the cart from that order's lines (today only seller-authored templates + discovery carousels
  offer fast re-add).
- **Buyer-created standing orders / saved carts:** let the buyer save the current cart as a named
  template and set a cadence, rather than depending on the seller to author templates. Pair with
  pause/resume (web currently has neither create nor pause).
- **One-tap standing order confirm:** surface the next scheduled standing order on the dashboard with a
  single "Confirm this week's order" that skips the cart.
- **Guided seller-linking:** a short wizard (code → verify email → confirm) with autocomplete on known
  seller slugs and a clearer PENDING→ACTIVE status timeline, replacing the free-text code modal.
- **Invoice status filters + in-portal pay:** add All/Unpaid/Paid/Overdue chips to the web invoice list
  (parity with mobile) and, if a payment gateway is added, an in-portal "Pay now".
- **Socket-driven live lists:** wire the buyer socket to TanStack invalidation (as mobile does) so
  orders/invoices refresh without a manual navigation.
- **Reconcile the Settings page:** move it onto `buyerApiClient` / `BUYER_KEYS` and the `/api/v1`
  prefix so it stops using the legacy `buyerToken` key.
