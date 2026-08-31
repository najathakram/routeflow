# Buyer Portal & Customer Self-Service

_The retail buyer's own login, ordering surface and account view against a seller tenant._

## The problem

A wholesale distributor takes orders by WhatsApp message, phone call and a rep's notebook. Every
order is re-keyed by hand, so quantities and pack sizes get transposed, agreed prices are
forgotten between calls, and nobody can answer "what did I order last Tuesday and what do I still
owe you?" without someone digging through a paper delivery book and a separate accounting
package. Retail buyers chase the office for copies of invoices and statements, and payment
arrives as an unexplained cash drop or a check with no remittance advice. The distributor's staff
spend their day transcribing orders and re-sending documents instead of selling, and the buyer has
no way to place an order at 11pm when they actually notice the shelf is empty.

## Why it matters to a tenant

The buyer types the order once, at their own price tier, against the seller's live catalogue and
stock — so it lands as a structured `Order` with no re-keying and no price argument
(`apps/api/src/buyer/buyer-catalog.service.ts` resolves `CustomerPrice` tier overrides and the
customer's remembered agreed price server-side). Invoices, payment history, open balance and a
month-by-month statement PDF are self-serve (`GET /api/v1/buyer/invoices`, `/buyer/statement`,
`/buyer/statements/:month`), which removes the single most common inbound phone call.
Replenishment inference (`replenishment.service.ts`) turns "what do I usually buy" into a one-tap
basket, lifting order frequency without a rep visit. Where the seller has connected Stripe, the
buyer can also pay the balance themselves and the money is allocated oldest-invoice-first
automatically (`payment-requests.service.ts`).

## Core use cases

1. **Self-serve ordering against my own prices** — a connected retail buyer browses the seller's
   live catalogue at their own tier/agreed pricing, builds a basket and submits an order that
   lands in the seller's order queue as a real Order with correct boxed/piece quantities — no
   phone call, no re-keying.
2. **See what I owe and what I have** — the buyer opens their own order history, invoices, payment
   history and monthly statement without asking the seller's office for copies, and can see an
   invoice's live balance after part-payments and bounced checks.
3. **Get connected to (and stay connected to) a seller** — the seller invites a customer to the
   portal, or the buyer requests access with the email the seller has on file; the seller
   approves; the link can be suspended or severed. One buyer login can hold links to many
   sellers.

## Must have (P0)

| ID      | Capability                                                      | Status     | What it does                                                                                                                                                                                             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | --------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BUY-M1  | Buyer identity: register, sign in, recover, verify              | SHIPPED ✅ | Email/password or Google login, silent refresh, password reset, email verification, session revocation, separate from staff identity.                                                                    | `apps/api/src/buyer/buyer-auth.controller.ts` (register/login/refresh/logout/account delete/change-password/set-password/reset flows, profile, sessions). Google sign-in is on the STAFF controller, not here — `apps/api/src/auth/auth.controller.ts:200` `GET /api/v1/auth/google` ("staff or buyer portal"), web callback `apps/web/app/(auth)/auth/google/callback/page.tsx:147`. verified: the analyst's original anchor for Google sign-in (buyer-auth.controller.ts) is wrong; corrected here. Models BuyerAccount/BuyerRefreshToken/BuyerPasswordResetToken/BuyerEmailVerificationToken (schema.prisma:3014-3290). Also ships `DELETE /api/v1/buyer/auth/account` (:68) — unreachable from any UI (see BUY-N19). |
| BUY-M2  | Seller connection: invite, accept, request, approve, disconnect | SHIPPED ✅ | Seller invites by emailed token; buyer accepts. Unsolicited buyer can request a seller by slug+email — verified match links instantly, else queues for seller approval. Either side can sever the link.  | `apps/api/src/buyer/buyer.controller.ts` invite/accept/request/disconnect/list routes; operator side `apps/api/src/customers/customers.controller.ts:355-392` portal-invite/resend/disconnect/approve/decline, pending-portal-approvals. Model CustomerLink (schema.prisma:3050). Spec buyer-connect.spec.ts.                                                                                                                                                                                                                                                                                                                                                                                                            |
| BUY-M3  | Customer-priced catalogue browse & search                       | SHIPPED ✅ | Buyer sees the seller's active catalogue at their own tier/override/agreed price, stock, images, pack size; search by name/SKU/barcode; paginate/sort/filter.                                            | `apps/api/src/buyer/buyer-catalog.service.ts` getCatalog/getCatalogCounts/getProductDetail; routes on buyer.controller.ts:330-408. Spec buyer-catalog.service.spec.ts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| BUY-M4  | Cart & self-serve order placement                               | SHIPPED ✅ | Buyer builds a basket (boxes/pieces), sees a promo-aware estimate, submits; merges into an existing open order rather than creating a duplicate.                                                         | `POST /api/v1/buyer/orders` (buyer.controller.ts:457-531) → OrdersService.create / mergeAllPendingForCustomer. Cart client-side `apps/web/lib/buyer-cart.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| BUY-M5  | Order history, order detail and live status                     | SHIPPED ✅ | Buyer lists their own orders per seller and opens one for lines/prices/notes/status history; scoped so another customer's order is invisible.                                                            | buyer.controller.ts:160-176, :430-437; ownership gate orders.service.ts:413-420.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| BUY-M6  | Amend or cancel an order before it is picked                    | PARTIAL 🟡 | Buyer can cancel their own DRAFT/PENDING order (server-enforced). Item editing is meant to be restricted to the same window but is not enforced server-side.                                             | Cancel gated correctly: orders.service.ts:2145-2156. Item PATCH gate missing: computeEditWindow (orders.service.ts:447-458) treats any non-CANCELLED order as editable, and updateOrderItems' only status check is the CANCELLED check at :2549-2551 — no CUSTOMER-role branch exists. verified: confirmed exactly as analyzed by exhaustive read of orders.service.ts:2533-2610; DRAFT/PENDING restriction exists only client-side at `apps/web/app/buyer/portal/[seller]/orders/[id]/page.tsx:538-541`.                                                                                                                                                                                                                |
| BUY-M7  | Invoice list, detail and document copy                          | PARTIAL 🟡 | Buyer sees every non-DRAFT invoice, opens one for lines/payments/credits/live balance, and downloads a PDF.                                                                                              | `GET /api/v1/buyer/invoices` and `/buyer/invoices/:id` (buyer.controller.ts:178-230). PDF download only works when `Invoice.pdfUrl` was already populated by a prior seller send/generate (buyer.controller.ts:223, invoice-pdf.service.ts:193) — an invoice never emailed has no self-serve PDF path.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| BUY-M8  | Account statement — live balance and monthly PDF                | SHIPPED ✅ | Buyer sees running account position (opening/charges/payments/credits/closing) and downloads a branded monthly statement PDF.                                                                            | `apps/api/src/buyer/statement.service.ts`, `statement-pdf.service.ts`; routes `/buyer/statement`, `/buyer/statements`, `/buyer/statements/:month` (buyer.controller.ts:232-262). Spec statement.service.spec.ts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| BUY-M9  | Seller scoping and tenant isolation on every buyer call         | SHIPPED ✅ | One buyer login can hold links to several sellers; every call is bound to exactly one seller by an `X-Tenant-Slug` header and only an ACTIVE link grants access.                                         | `apps/api/src/buyer/guards/buyer-seller-context.guard.ts`, `buyer-tenant.interceptor.ts` (tenant-scoped ALS via PrismaService.forTenant()).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| BUY-M10 | Licensed / regulated catalogue visibility                       | SHIPPED ✅ | Products in licence-required categories are hidden from a buyer without a verified, unexpired authorization — everywhere (catalogue, counts, dashboard, favourites) — with a self-serve submission path. | `apps/api/src/buyer/regulated-visibility.service.ts` computeGate, shared by catalogue and dashboard services. `GET/POST /buyer/authorizations` (buyer.controller.ts:409-418, 960-981); model CustomerAuthorization (schema.prisma:3612).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| BUY-M11 | Money correctness in every buyer-facing number                  | SHIPPED ✅ | Every price, line subtotal and total shown to the buyer is produced by the shared pricing helpers (boxed proration, promotions, cent rounding), so tile, cart, order and invoice agree.                  | `apps/api/src/common/pricing.ts`, mirrored at `apps/web/lib/pricing.ts` and `apps/mobile/lib/pricing.ts`. Regression spec `apps/api/src/common/pricing.spec.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| BUY-M12 | Seller-side portal administration                               | SHIPPED ✅ | Seller sees who is connected, invites/re-invites, reviews and approves/declines inbound requests, disconnects a buyer, with a live in-app alert on new requests.                                         | `apps/api/src/customers/customers.controller.ts:107, 355-392` (all `@Roles(OPERATOR)`). Realtime via `apps/api/src/gateways/routeflow.gateway.ts` `buyer.connect.requested`/`.autolinked`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| BUY-M13 | Platform-admin buyer support console                            | SHIPPED ✅ | Platform admin can look up a buyer account, change its status, edit its links, impersonate the buyer, view its tenant customers, and run an admin-driven merge queue for duplicate accounts.             | `apps/api/src/buyer/buyer-admin.controller.ts` — `GET/PATCH platform-admin/buyer-accounts[/:id]`, `:id/status`, `:id/links`, `:id/impersonate`, `:id/tenant-customers`, plus `platform-admin/customer-links[/stats]` and `DELETE customer-links/:id`. A separate `apps/api/src/buyer/buyer-admin-merge.controller.ts` covers `platform-admin/buyer-merge-requests` (list/get/create/execute/reject). Web: `apps/web/app/(platform-admin)/admin/buyers/page.tsx`, `buyers/[id]/page.tsx` (Impersonate button, :366-370), `buyers/merge-requests/page.tsx` + `[id]/page.tsx`.                                                                                                                                              |

### Testing criteria

#### BUY-M1

- [ ] Jest (api): `POST /buyer/auth/login` with a wrong password N times sets `lockedUntil`; the correct password is still rejected until it passes. `Jest`
- [ ] Jest (api): `POST /buyer/auth/verify-email` with an already-consumed token returns 4xx and does not flip `emailVerified` a second time. `Jest`
- [ ] Jest (api): buyer-issued tokens are rejected by staff endpoints (`JwtAuthGuard`) and vice versa (`BuyerJwtAuthGuard`) — the two token families never interchange. `Jest`
- [ ] Playwright (web): registering with an existing email shows an inline error and does not create a second BuyerAccount. `Playwright`
- [ ] Jest (api): `GET /api/v1/auth/google` is the real Google entry point for the buyer portal — assert it, not any route on `buyer-auth.controller.ts`. `Jest`

#### BUY-M2

- [ ] Jest (api): `requestSeller` where the email matches but is unverified produces `PENDING_SELLER_APPROVAL`, never `ACTIVE`. `Jest`
- [ ] Jest (api): two concurrent `requestSeller` calls for the same customerId resolve to the same pending row — no raw P2002. `Jest`
- [ ] Jest (api): `GET /buyer/sellers` returns `customer:null` for INVITED and PENDING_SELLER_APPROVAL links. `Jest`
- [ ] Jest (api): after `portal-disconnect`, the old invite token 404s/409s on re-accept, never re-links. `Jest`

#### BUY-M3

- [ ] Jest (api): a tier-3 customer with a per-product tier-1 override receives that product at tier 1 and everything else at tier 3 in one listing. `Jest`
- [ ] Jest (api): the catalogue response never contains a cost/tier-table field — assert the returned key set. `Jest`
- [ ] Jest (api): `GET /buyer/products?ids=<200 ids>` returns all 200 rows, not a truncated page. `Jest`
- [ ] Jest (api): an inactive product is absent from the listing and its detail route 404s. `Jest`
- [ ] Playwright (web): typing a SKU fragment shows it in the suggestion dropdown and filters the grid on click. `Playwright`

#### BUY-M4

- [ ] Jest (api): posting items while a PENDING order exists merges into that same order id, quantities summed. `Jest`
- [ ] Jest (api): a merge preserves operator-added catalog-free lines already on the order. `Jest`
- [ ] Jest (api) money invariant: a boxed line's persisted subtotal equals `computeLineSubtotal(...)`, never `qty*unitPrice`. `Jest`
- [ ] Jest (api): `items: []` is rejected 400 and writes no Order. `Jest`
- [ ] Playwright (web): the cart is cleared only after API confirmation, not optimistically. `Playwright`

#### BUY-M5

- [ ] Jest (api): fetching another customer's order in the same tenant returns 403; a different tenant returns 404. `Jest`
- [ ] Jest (api): every returned order has upsell bases stripped (`redactUpsellForCustomer`). `Jest`
- [ ] Jest (api): no ACTIVE link for the header's seller returns 403 before any query runs. `Jest`
- [ ] Jest (api): omitting `X-Tenant-Slug` returns 400, never a default-tenant read. `Jest`

#### BUY-M6

- [ ] Jest (api): `PATCH /buyer/orders/:id/items` on a DELIVERED order with a buyer token must be rejected 4xx and change nothing. (Fails today.) `Jest`
- [ ] Jest (api): `POST /buyer/orders/:id/cancel` on a CONFIRMED order returns 403 and leaves it CONFIRMED. `Jest`
- [ ] Jest (api): a diff-shaped PATCH payload (`{id, action}`) is rejected 400 rather than replacing all lines. `Jest`
- [ ] Jest (api) money invariant: after a legitimate PENDING-order qty edit, order.total and the mirror invoice total both equal the recomputed sum. `Jest`
- [ ] Playwright (web): the Edit control is absent on an OUT_FOR_DELIVERY order; "Request a change" is offered instead. `Playwright`

#### BUY-M7

- [ ] Jest (api): `GET /buyer/invoices` with no filter never returns a DRAFT invoice. `Jest`
- [ ] Jest (api): fetching another customer's invoice returns 403 and does not stamp `viewedAt`. `Jest`
- [ ] Jest (api): an invoice never emailed (pdfUrl null) still returns a downloadable PDF from the detail route. (Fails today.) `Jest`
- [ ] Jest (api) money invariant: VOID payments are excluded from paid total, so a bounced check re-opens `balanceDue`. `Jest`
- [ ] Playwright (web): opening an invoice flips its status chip SENT→VIEWED on the seller's list. `Playwright`

#### BUY-M8

- [ ] Jest (api) money invariant: opening + charges − payments − credits + adjustments === closing to the cent. `Jest`
- [ ] Jest (api): a VOID payment is excluded from the split and boundary receivable calc. `Jest`
- [ ] Jest (api): an invalid month string returns 400 and generates no PDF. `Jest`
- [ ] Jest (api): a buyer with zero non-DRAFT invoices gets an empty months array, not a 500. `Jest`
- [ ] Manual: the generated PDF header shows the seller's branding, not RouteFlow's. `manual`

#### BUY-M9

- [ ] Jest (api): a valid buyer token with an unlinked seller's slug returns 403 across every buyer data route. `Jest`
- [ ] Jest (api): INVITED/PENDING/SUSPENDED/DISCONNECTED links all yield 403 — only ACTIVE passes. `Jest`
- [ ] Jest (api): a SUSPENDED tenant returns 403 before any tenant-scoped query executes. `Jest`
- [ ] Jest (api): a buyer linked to two sellers never receives a product row from the other tenant. `Jest`

#### BUY-M10

- [ ] Jest (api): a buyer with no authorization for a gated category sees zero of its products and gets 404 on direct fetch. `Jest`
- [ ] Jest (api): an expired VERIFIED authorization behaves like no authorization. `Jest`
- [ ] Jest (api): category-rail counts exclude gated products while still counting NULL-category products. `Jest`
- [ ] Jest (api): a favourite pointing at a now-gated product is filtered out of the favourites list. `Jest`
- [ ] Playwright (web): ordering a gated line returns 409 REGULATED_AUTH_REQUIRED with licence-page guidance. `Playwright`

#### BUY-M11

- [ ] Jest (shared): `deriveTilePrice` and the cart's priced lines agree to the cent for an identical BUY_N_GET_M line. `Jest`
- [ ] Jest (api): a free unit reduces the subtotal, never the stored unitPrice. `Jest`
- [ ] Jest (shared): loose pieces below a full box never earn a free unit. `Jest`
- [ ] Jest (web): an unpriceable cart line is excluded from the estimate, never counted as $0. `Jest`

#### BUY-M12

- [ ] Jest (api): a DRIVER or CUSTOMER token calling `portal-approve` is refused 403. `Jest`
- [ ] Jest (api): approving flips the link to ACTIVE and NULLs the invite token. `Jest`
- [ ] Jest (api): re-inviting an already-ACTIVE customer is a safe no-op/409. `Jest`
- [ ] Playwright (web): a connect request appears in the operator's notification bell without a reload. `Playwright`

#### BUY-M13

- [ ] Jest (api): impersonation issues a scoped session and is recorded in the audit trail with the acting admin's identity. `Jest`
- [ ] Jest (api): only a platform-admin role can reach any `platform-admin/buyer-accounts` or `buyer-merge-requests` route. `Jest`
- [ ] Jest (api): executing a merge request revokes the losing account's sessions and stamps `mergedIntoId`. `Jest`
- [ ] Manual: confirm the Impersonate button on `admin/buyers/[id]/page.tsx` produces a session scoped to that one buyer account. `manual`

## Nice to have (P1)

| ID      | Capability                                          | Status          | What it does                                                                                                                                                                                                              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | --------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BUY-N1  | Favourites list                                     | SHIPPED ✅      | Buyer stars repeat products; pack size carries through so a boxed favourite adds as a box.                                                                                                                                | `apps/api/src/buyer/buyer-catalog.service.ts` getFavorites/add/remove; model BuyerFavorite (schema.prisma:3334).                                                                                                                                                                                                                                                                                                                                                                                                  |
| BUY-N2  | Your Shelf — predicted replenishment with snooze    | SHIPPED ✅      | Infers cadence and days-of-cover from order history; groups Running low / Due soon / Snoozed; one-cycle snooze.                                                                                                           | `apps/api/src/buyer/replenishment.service.ts`, `shelf.service.ts`; model ReplenishmentSnooze (schema.prisma:3357).                                                                                                                                                                                                                                                                                                                                                                                                |
| BUY-N3  | One-tap "add everything I'm low on"                 | SHIPPED ✅      | Seeds the open order with every running-low item at its suggested quantity via the same merge path.                                                                                                                       | `POST /api/v1/buyer/shelf/add-all-low` (buyer.controller.ts:660-676).                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| BUY-N4  | Standing orders — view, pause and reorder on demand | PARTIAL 🟡      | Buyer sees seller-created recurring templates, can fire an immediate reorder, and — on mobile only — pause/resume. There is no create/edit, and the web portal (the golden reference) has no pause/resume control at all. | `PATCH /buyer/templates/:id` ({isActive} only) exists (buyer.controller.ts:713-778) but has no caller anywhere in `apps/web`; `apps/web/app/buyer/portal/[seller]/templates/page.tsx:68-69` renders a read-only Active/Paused Badge. Only `apps/mobile/lib/api/buyer.ts` calls the PATCH. verified: analysis's capability text overstated web parity; downgraded emphasis and evidence corrected.                                                                                                                 |
| BUY-N5  | Smart collections and category rail                 | SHIPPED ✅      | "Your usuals", Favourites, New and Deals alongside categories, each count already honouring the licence gate.                                                                                                             | `apps/api/src/buyer/buyer-catalog.service.ts` getCatalogCounts + collection branches.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| BUY-N6  | Product detail page with gallery and variants       | PARTIAL 🟡      | Full detail page on web (gallery, description, stock, price parity with tile, variants, favourite toggle). No mobile equivalent exists.                                                                                   | `apps/web/app/buyer/portal/[seller]/shop/[productId]/page.tsx`, backed by `GET /api/v1/buyer/products/:id`. No `useBuyerProduct` hook or route under `apps/mobile`.                                                                                                                                                                                                                                                                                                                                               |
| BUY-N7  | Back-in-stock alerts                                | BROKEN 🔴       | Buyer can subscribe/unsubscribe to a product; delivery on restock is dead — the alert flips to NOTIFIED whether or not anything was delivered.                                                                            | Subscribe path works: `apps/api/src/stock-alerts/stock-alert.service.ts`. Delivery dead: `sendToCustomer` requires a `DeviceToken` (notifications.service.ts:140-152) and the buyer app never registers one — `registerPushToken` in `apps/mobile/lib/auth.ts` is called only from staff login (:168, :251); `apps/mobile/lib/buyer-auth.ts` has no push registration at all. verified: confirmed on all three links of the chain, including the "still cleared" catch comment at stock-alert.service.ts:123-127. |
| BUY-N8  | Promotions visible in the storefront                | SHIPPED ✅      | Active promotions show as struck prices and deal chips; buy-N-get-M renders as a rule, not a fake unit price.                                                                                                             | `GET /api/v1/buyer/promotions` → `applyBestPromotion`; `apps/web/.../tile-pricing.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| BUY-N9  | Buyer-initiated payment — card and declared cash    | PARTIAL 🟡      | Buyer pays by card (Stripe Connect) or declares cash/check for approval; oldest-invoice-first allocation with a preview. Web-only — no mobile payment surface.                                                            | `apps/api/src/payment-requests/buyer-payments.controller.ts`, `payment-requests.service.ts` buildOldestFirstAllocation. Operator gets a realtime alert too — `emitBuyerPaymentRequest` → `buyer.payment.requested` (routeflow.gateway.ts:274) — see BUY-N20.                                                                                                                                                                                                                                                      |
| BUY-N10 | Payments, credits and how-to-pay                    | SHIPPED ✅      | Payment history with check lifecycle (deposited/cleared/bounced + NSF fee), available store credit, seller remittance instructions.                                                                                       | `GET /api/v1/buyer/payments`, `/buyer/remittance`; badge helper `apps/web/lib/check-badge.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| BUY-N11 | Post-dispatch change request                        | SHIPPED ✅      | Once on a van, buyer can no longer edit directly but files a structured add/change/remove/note request the seller approves or declines, with credit re-checked on roll-forward.                                           | `apps/api/src/orders/change-requests.service.ts`; routes on buyer.controller.ts:546-566.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| BUY-N12 | Live delivery tracking for the buyer                | PARTIAL 🟡      | Buyer sees route/driver/stop position/ETA — on mobile only. Web buyer order detail has no tracking card despite the same endpoint existing.                                                                               | `GET /api/v1/buyer/orders/:id/tracking` (orders.service.ts:4629); consumed by `apps/mobile/lib/api/buyer.ts`. `apps/web/app/buyer/portal/[seller]/orders/[id]/page.tsx` has no tracking hook. Only meaningful for tenants on a dispatch addon.                                                                                                                                                                                                                                                                    |
| BUY-N13 | Self-serve licence submission and expiry warning    | SHIPPED ✅      | Buyer submits/renews their own licence for gated categories and is warned in-app before it expires.                                                                                                                       | `GET/POST /buyer/authorizations`, `/buyer/authorizations/expiring` (buyer.controller.ts:409-418, 960-981).                                                                                                                                                                                                                                                                                                                                                                                                        |
| BUY-N14 | One login, many sellers — plus account merge        | SHIPPED ✅      | Buyer switches between linked sellers in one session; can merge two accidental logins via emailed verification.                                                                                                           | `GET /api/v1/buyer/sellers`; `apps/api/src/buyer/buyer-merge.controller.ts` + `buyer-merge.service.ts`.                                                                                                                                                                                                                                                                                                                                                                                                           |
| BUY-N15 | Buyer's own spend analytics                         | SHIPPED ✅      | 12-month spend trend, invoice breakdown, unpaid totals and recent payments at that seller.                                                                                                                                | `GET /api/v1/buyer/analytics`, `/buyer/dashboard`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| BUY-N16 | Real-time portal notifications                      | PARTIAL 🟡      | Order/invoice/delivery events reach the buyer while the portal is open and refresh affected screens; stored only in localStorage — nothing survives being signed out or moving devices.                                   | `apps/web/lib/hooks/useBuyerNotifications.ts` (STORAGE_KEY, MAX_NOTIFICATIONS 50, no server record).                                                                                                                                                                                                                                                                                                                                                                                                              |
| BUY-N17 | Mobile buyer app                                    | PARTIAL 🟡      | Catalogue, cart, orders, invoices, shelf, favourites, standing orders, licences, payment history, tracking — on a phone. Missing: product detail, make-a-payment, scan-to-cart, push registration.                        | `apps/mobile/app/(customer)/*`; session via `buyer-session-store.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| BUY-N18 | Installable buyer PWA                               | NICE ✅ SHIPPED | The web portal declares its own manifest, standalone/Apple web-app config and icon set so a buyer can add the storefront to their phone's home screen without the Expo app.                                               | `apps/web/app/buyer/layout.tsx` (manifest `/buyer-manifest.json`, `appleWebApp.capable`, `statusBarStyle`, `themeColor #047857`); `apps/web/public/buyer-manifest.json`.                                                                                                                                                                                                                                                                                                                                          |
| BUY-N19 | Buyer maintains their own contact details           | PARTIAL 🟡      | The API supports a buyer editing their own profile, but no screen calls the write endpoint — web's account page is read-only and mobile reads a different, older endpoint.                                                | `GET/PATCH /api/v1/buyer/me` (buyer.controller.ts:690-709, guarded by `UpdateBuyerProfileDto`) — zero references to `/buyer/me` in `apps/web` or `apps/mobile`. `apps/web/app/buyer/portal/[seller]/account/page.tsx` only reads `useBuyerAuth`; mobile calls `GET /buyer/profile` instead (`apps/mobile/app/(customer)/profile.tsx:6,11`). Also ships `DELETE /buyer/auth/account` with no UI consumer anywhere.                                                                                                 |
| BUY-N20 | Operator realtime alert on declared payments        | SHIPPED ✅      | The seller's staff get a live in-app alert the moment a buyer declares a cash/check payment, so approval doesn't wait for someone to check a list.                                                                        | `apps/api/src/gateways/routeflow.gateway.ts:274` `emitBuyerPaymentRequest` → `buyer.payment.requested` on `tenantRoom(tenantId,'operators')`; payload `BuyerPaymentRequestPayload` (:119).                                                                                                                                                                                                                                                                                                                        |

### Testing criteria

#### BUY-N1

- [ ] Jest (api): favouriting the same product twice returns 409 the second time and creates one row. `Jest`
- [ ] Jest (api): favourites always carry `unitsPerBox` so a boxed favourite adds as a box. `Jest`
- [ ] Jest (api): favourites are keyed on (buyerAccountId, customerId) — independent per seller. `Jest`
- [ ] Jest (api): deleting a non-existent favourite returns 404, not a silent 200. `Jest`

#### BUY-N2

- [ ] Jest (api): a 14-day cadence product yields `cadenceDays 14`; a single-order product yields no cadence. `Jest`
- [ ] Jest (api): `suggestedQty` for a boxed product is always a whole number of boxes. `Jest`
- [ ] Jest (api): snoozing sets `snoozedUntil = now + cadenceDays`, excludes from `lowItems()`, still shows under Snoozed. `Jest`
- [ ] Jest (api): a buyer with no order history gets an empty shelf, not a 500. `Jest`
- [ ] Jest (api): shelf estimates never expose a price field. `Jest`

#### BUY-N3

- [ ] Jest (api): with an existing PENDING order, add-all-low merges rather than creating a second order. `Jest`
- [ ] Jest (api): with no low items the call is a no-op and writes nothing. `Jest`
- [ ] Jest (api): a snoozed low item is not included. `Jest`
- [ ] Jest (api) money invariant: the resulting total matches the boxed-proration sum, no shortcut around it. `Jest`

#### BUY-N4

- [ ] Jest (api): reordering a template not owned by the caller returns 403 and creates no order. `Jest`
- [ ] Jest (api): `PATCH /buyer/templates/:id` with fields other than `isActive` leaves them untouched. `Jest`
- [ ] Jest (api): reordering a paused template is explicitly refused or explicitly flagged — assert the chosen behaviour. `Jest`
- [ ] Playwright (web): confirm the web portal offers no pause/resume control today (expected gap). `Playwright`
- [ ] Manual: confirm the buyer cannot create a standing order from either surface (expected gap). `manual`

#### BUY-N5

- [ ] Jest (api): with an ALL-scope active promotion, the deals count equals total visible product count. `Jest`
- [ ] Jest (api): "usuals" excludes products ordered only once. `Jest`
- [ ] Jest (api): counts and the filtered listing agree exactly. `Jest`
- [ ] Jest (api): every collection count excludes licence-gated products for an unlicensed buyer. `Jest`

#### BUY-N6

- [ ] Playwright (web): the detail page price string equals the tile price string exactly. `Playwright`
- [ ] Jest (api): a deactivated variant is absent from the detail payload. `Jest`
- [ ] Jest (api): a gated or inactive product's detail route 404s without leaking the name. `Jest`
- [ ] Manual (mobile): confirm there is no product detail screen (expected gap). `manual`

#### BUY-N7

- [ ] Jest (api): `fireForProducts` must not clear a PENDING alert when zero channels reached the buyer (fails today). `Jest`
- [ ] Jest (mobile): buyer login registers an Expo push token against the buyer session (no such call exists today). `Jest`
- [ ] Jest (api): subscribing twice is idempotent, one row. `Jest`
- [ ] Jest (api): subscribing to an inactive/non-existent product returns 404. `Jest`
- [ ] Manual: subscribe, restock, confirm a notification actually arrives on at least one channel. `manual`

#### BUY-N8

- [ ] Jest (shared pricing): a BUY_N_GET_M promo never fabricates an `originalPrice` strike. `Jest`
- [ ] Jest (shared pricing): tile and cart pick the identical winning promo when two match. `Jest`
- [ ] Jest (api): an expired promotion is absent from the buyer promotions list. `Jest`
- [ ] Jest (api): a promo price never becomes the customer's remembered agreed price. `Jest`

#### BUY-N9

- [ ] Jest (api) money invariant: preview allocation applied + excess === amount, oldest invoice first. `Jest`
- [ ] Jest (api): a card request is capped at the account balance due. `Jest`
- [ ] Jest (api) idempotency: a redelivered Stripe webhook records the payment exactly once. `Jest`
- [ ] Jest (api): cancelling an already-paid card request is refused, money never stranded. `Jest`
- [ ] Jest (api): no Stripe Connect account / `chargesEnabled` false disables card entirely. `Jest`

#### BUY-N10

- [ ] Jest (api): payments list is scoped to the caller's own invoices, newest first. `Jest`
- [ ] Jest (api): `limit=500` clamps to 100; a garbage limit falls back safely. `Jest`
- [ ] Jest (api): check status fields pass through stored values, never recomputed. `Jest`
- [ ] Jest (api): remittance config resolves per-seller for a buyer linked to two sellers. `Jest`
- [ ] Playwright (web): a bounced check renders the danger badge and re-opens the invoice balance. `Playwright`

#### BUY-N11

- [ ] Jest (api): filing on another customer's order returns 403 and writes nothing. `Jest`
- [ ] Jest (api): approving an add that would breach credit limit is rejected atomically. `Jest`
- [ ] Jest (api) money invariant: an approved qty change re-syncs order and invoice totals to the same figure. `Jest`
- [ ] Jest (api): the change-request payload returned to a buyer contains no unit prices. `Jest`

#### BUY-N12

- [ ] Jest (api): fetching another customer's tracking returns 403, not stop/driver data. `Jest`
- [ ] Jest (api): an order not yet on a run returns a well-formed empty payload, not a 500. `Jest`
- [ ] Playwright (web): confirm the web buyer order detail has no tracking section today (expected gap). `Playwright`
- [ ] Jest (api): the tracking payload never exposes another customer's stop details. `Jest`

#### BUY-N13

- [ ] Jest (api): a buyer submission always lands PENDING_REVIEW; the DTO rejects a status field. `Jest`
- [ ] Jest (api): submitting for a non-gated category returns 400/404, no orphan row. `Jest`
- [ ] Jest (api): expiring-list buckets by days remaining and flags already-expired rows. `Jest`
- [ ] Playwright (web): an expiring licence shows in the notification bell without reload. `Playwright`

#### BUY-N14

- [ ] Jest (api): a failed verification email rolls back the merge request rather than claiming success. `Jest`
- [ ] Jest (api): a completed merge stamps `mergedIntoId` and revokes the losing account's tokens. `Jest`
- [ ] Jest (api): the unique constraint prevents two accounts on one customerId. `Jest`
- [ ] Playwright (web): switching sellers changes the active `X-Tenant-Slug` and the cart does not bleed across sellers. `Playwright`

#### BUY-N15

- [ ] Jest (api): the spend series always has 12 buckets including zero months, excludes CANCELLED/DRAFT. `Jest`
- [ ] Jest (api): dashboard and analytics unpaid totals agree for the same fixture. `Jest`
- [ ] Jest (api): all dashboard rails apply the same regulated visibility gate as the catalogue. `Jest`
- [ ] Jest (api): a brand-new buyer gets zeroed stats, not nulls that crash the client. `Jest`

#### BUY-N16

- [ ] Playwright (web): an operator marking an invoice paid updates the buyer's balance/badge live, no reload. `Playwright`
- [ ] Jest (web): the notification store caps at 50 and survives a reload in the same browser. `Jest`
- [ ] Manual: raise an event while signed out, sign in — confirm it is NOT recoverable (expected gap today). `manual`
- [ ] Jest (api): the socket handshake rejects a revoked buyer token. `Jest`

#### BUY-N17

- [ ] Jest (mobile): cart boxed/piece normalisation matches `apps/web/lib/pricing.ts` on a shared fixture table. `Jest`
- [ ] Manual (mobile): reordering from a past order seeds the same quantities, skipping now-inactive products. `manual`
- [ ] Manual (mobile): confirm product detail, make-a-payment and scan-to-cart are all absent (expected gaps). `manual`
- [ ] Manual (mobile): a signed-out buyer is redirected to login, never an empty shell. `manual`

#### BUY-N18

- [ ] Manual: install the buyer portal to a phone home screen via the manifest and confirm it launches standalone. `manual`
- [ ] Playwright (web): the manifest and icons resolve with 200 and correct content-type. `Playwright`

#### BUY-N19

- [ ] Jest (api): `PATCH /buyer/me` persists only the fields `UpdateBuyerProfileDto` allows. `Jest`
- [ ] Playwright (web): confirm no control on the account page currently calls `PATCH /buyer/me` (expected gap). `Playwright`
- [ ] Manual (mobile): confirm mobile's profile screen reads `/buyer/profile`, not `/buyer/me` (expected inconsistency). `manual`
- [ ] Manual: confirm no UI surface reaches `DELETE /buyer/auth/account` (expected gap). `manual`

#### BUY-N20

- [ ] Jest (api): declaring a cash/check payment emits exactly one `buyer.payment.requested` event to the seller's operator room. `Jest`
- [ ] Playwright (web): an operator sees the declared payment appear live without reloading the payment-requests list. `Playwright`

## Advanced / future (P2)

| ID      | Capability                                                                | Status     | What it does                                                                                                                                                                                       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BUY-A1  | Truly branded storefront (seller logo, colours, own domain)               | PARTIAL 🟡 | Seller branding is returned by the API and used on the seller picker, invite page and statement PDF, but the portal chrome itself hard-codes RouteFlow branding and there is no per-seller domain. | `apps/web/app/buyer/portal/layout.tsx:246-253` hard-codes `/logo-buyer.svg` and "RouteFlow / Buyer Portal"; `primaryColor` has no consumer anywhere under `apps/web/app/buyer/portal/`.                                                                                                                                                                                                                                                                                                                              |
| BUY-A2  | Multiple people per buying account, with roles                            | MISSING ⬜ | A store with an owner, manager and clerk should each have their own login against one customer account, optionally with an approval threshold.                                                     | `CustomerLink.customerId` is `String @unique` (schema.prisma:3053) — one BuyerAccount per Customer, enforced at the DB. No role/approval field exists.                                                                                                                                                                                                                                                                                                                                                               |
| BUY-A3  | Returns / shortage claim from the portal                                  | MISSING ⬜ | Buyer should raise a damage/shortage claim themselves with photos and get a credit note.                                                                                                           | Staff-side returns engine exists (`apps/api/src/returns/returns.controller.ts`) but there is no `/buyer/returns` route, hook, or page anywhere on the buyer surface.                                                                                                                                                                                                                                                                                                                                                 |
| BUY-A4  | Voice search in the catalogue, in English & Spanish                       | MISSING ⬜ | Marketing advertises spoken search; neither the feature nor any localisation of the buyer portal exists.                                                                                           | Marketing claims it at `apps/web/app/(marketing)/product/page.tsx:151` and `components/audience-split.tsx:172`; no SpeechRecognition/voice code anywhere under `apps/`. verified: the buyer portal also has no localisation at all — `apps/web/lib/i18n/index.tsx:44` explicitly skips locale reconciliation on `/buyer` paths, and no `.tsx` under `apps/web/app/buyer` imports `useI18n`/`useTranslation` — so both halves of the marketed claim ("English & Spanish") are unimplemented, not just the microphone. |
| BUY-A5  | Ship-to selection for multi-location buyers                               | MISSING ⬜ | A buyer running several stores should pick which one an order ships to at checkout.                                                                                                                | `Order` has no address field (schema.prisma:1272-1331); `BuyerCreateOrderDto` accepts no addressId. A `CustomerAddress` model exists but the buyer cart never references it.                                                                                                                                                                                                                                                                                                                                         |
| BUY-A6  | Buyer PO number / order reference                                         | MISSING ⬜ | Chain retailers need their own PO number on the order and resulting invoice for three-way matching.                                                                                                | No `poNumber`/`customerReference` field on `Order`; the only `poNumber` in the schema is on the seller's own PurchaseOrder model (schema.prisma:2217).                                                                                                                                                                                                                                                                                                                                                               |
| BUY-A7  | Order rules: minimum value, cut-off times, delivery-day calendar          | MISSING ⬜ | Distributors on fixed route days want the portal to enforce a minimum drop value and communicate the next cut-off/delivery day.                                                                    | No such reference anywhere in `orders.service.ts` or the DTO; the cart takes a free-form date input (`apps/web/app/buyer/portal/[seller]/cart/page.tsx:44,502`).                                                                                                                                                                                                                                                                                                                                                     |
| BUY-A8  | Credit limit enforced at self-serve checkout                              | PARTIAL 🟡 | A buyer over their credit limit should be blocked from placing a brand-new order without the seller's say-so. The guard exists for edits and change-request approvals but not for order creation.  | `assertWithinCreditLimit` (orders.service.ts:3957) is called at :3460 (`updateOrderItems`), :4041 and :4464 — never inside `create()` (1444-2039). `POST /api/v1/buyer/orders` routes to `create()` whenever the buyer has no active order (buyer.controller.ts:523). verified: confirmed by exhaustive grep of every credit reference in orders.service.ts.                                                                                                                                                         |
| BUY-A9  | Server-side cart that follows the buyer across devices                    | MISSING ⬜ | A basket started on the shop-floor phone should finish on the office PC.                                                                                                                           | Cart lives only in `apps/web/lib/buyer-cart.ts` localStorage, keyed per browser; mobile keeps a separate cart. No cart model in the schema, no `/buyer/cart` route.                                                                                                                                                                                                                                                                                                                                                  |
| BUY-A10 | Transactional email to the buyer (order confirmation, receipt, statement) | MISSING ⬜ | A web-only buyer placing an order at 11pm should get something in writing.                                                                                                                         | Order-confirmation is push-only (`orders.service.ts:2337,2360` → `sendToCustomer`), which is itself undeliverable (see BUY-N7). No order-confirmation email path exists in `apps/api/src`.                                                                                                                                                                                                                                                                                                                           |
| BUY-A11 | Seller discovery — opt-in storefront directory                            | MISSING ⬜ | A retailer who hears about a distributor should be able to find and request them without already knowing the exact slug.                                                                           | `RequestSellerDto` requires an exact `sellerSlug`; no tenant search/list endpoint exists on the buyer surface.                                                                                                                                                                                                                                                                                                                                                                                                       |
| BUY-A12 | Scan-to-cart on the buyer's phone                                         | MISSING ⬜ | Buyer scans a shelf barcode and it lands in the basket, mirroring the operator app's scanning.                                                                                                     | No camera/scanner/barcode code anywhere under `apps/mobile/app/(customer)/`, though the catalogue API already supports barcode search.                                                                                                                                                                                                                                                                                                                                                                               |
| BUY-A13 | Machine-to-machine ordering (buyer API / punchout / EDI)                  | MISSING ⬜ | Chain/ERP-driven buyers want to submit orders from their own system rather than the web form.                                                                                                      | The buyer API is session-token only (`BuyerJwtAuthGuard` + short-lived refresh token); no API key, scoped machine credential, webhook subscription, or EDI/punchout module exists.                                                                                                                                                                                                                                                                                                                                   |

### Testing criteria

#### BUY-A1

- [ ] Playwright (web): with `logoKey`/`primaryColor` set, the portal header renders that branding and the accent derives from it (fails today). `Playwright`
- [ ] Playwright (web): switching sellers swaps header branding within the session. `Playwright`
- [ ] Jest (web): a seller with no logo falls back to neutral chrome, no broken image. `Jest`
- [ ] Manual: confirm there is no per-seller buyer hostname today (expected gap). `manual`

#### BUY-A2

- [ ] Jest (api): two BuyerAccounts hold ACTIVE links to the same customer and both see the same orders/invoices (fails today). `Jest`
- [ ] Jest (api): an order above the approval threshold sits PENDING_APPROVAL until an approver releases it. `Jest`
- [ ] Jest (api): revoking a sub-user's token does not affect the other users' sessions. `Jest`
- [ ] Jest (api): the audit trail records which buyer user placed each order. `Jest`

#### BUY-A3

- [ ] Jest (api): a buyer-raised return is scoped to the caller's customerId and rejects quantities above what was delivered. `Jest`
- [ ] Jest (api) stock invariant: an approved/received return records a movement and stock still reconciles. `Jest`
- [ ] Jest (api) money invariant: the resulting credit note never exceeds the invoice total. `Jest`
- [ ] Jest (api): concurrent submissions for the same lines cannot both pass the cumulative-quantity check. `Jest`

#### BUY-A4

- [ ] Playwright (web): the shop search exposes a microphone control (fails today — none exists). `Playwright`
- [ ] Manual (mobile): dictating a product name fills the search query. `manual`
- [ ] Regression: no marketing page claims a capability with zero implementation references. `manual`
- [ ] Accessibility: the control degrades silently on browsers without SpeechRecognition. `manual`

#### BUY-A5

- [ ] Jest (api): an `addressId` belonging to the caller's customer persists on the order and the stop resolves to it. `Jest`
- [ ] Jest (api): an `addressId` belonging to another customer is rejected 403. `Jest`
- [ ] Jest (api): omitting `addressId` falls back to the default address unchanged. `Jest`
- [ ] Playwright (web): a buyer with two addresses must pick one before Place Order is enabled. `Playwright`

#### BUY-A6

- [ ] Jest (api): a submitted `poNumber` persists on the Order and copies to every resulting Invoice. `Jest`
- [ ] Jest (api): order and invoice lists can be filtered by `poNumber`. `Jest`
- [ ] Jest (api): `poNumber` is length-capped and sanitised like other free-text fields. `Jest`
- [ ] Manual: the invoice PDF renders the buyer's PO reference in the header. `manual`

#### BUY-A7

- [ ] Jest (api): a basket below the configured minimum is rejected with a specific code; at the minimum it is accepted. `Jest`
- [ ] Jest (api): a delivery date outside the configured route days is rejected or snapped forward explicitly. `Jest`
- [ ] Jest (api): an order after cut-off is dated to the following run. `Jest`
- [ ] Playwright (web): the cart shows the next delivery date and time remaining to cut-off. `Playwright`

#### BUY-A8

- [ ] Jest (api): a customer at their credit limit posting a brand-new order via `POST /buyer/orders` is rejected 4xx with no Order row persisted (fails today). `Jest`
- [ ] Jest (api): a null `creditLimit` skips the check on every path. `Jest`
- [ ] Jest (api): exposure is computed once and never double-counted against a mirror invoice. `Jest`
- [ ] Jest (api): the flag/kill-switch combination behaves as documented in both directions. `Jest`

#### BUY-A9

- [ ] Jest (api): items added on device A appear in the cart on device B for the same buyer+seller. `Jest`
- [ ] Jest (api): the cart is keyed per (buyerAccountId, tenantId) — invisible across sellers. `Jest`
- [ ] Jest (api): concurrent updates from two devices converge deterministically, no silently dropped line. `Jest`
- [ ] Jest (api): a failed order submission leaves the cart intact; a successful one clears it idempotently. `Jest`

#### BUY-A10

- [ ] Jest (api): placing an order sends exactly one confirmation email to the buyer's verified address, with an honestly-inspected delivery result. `Jest`
- [ ] Jest (api): a sentinel/internal email address is skipped rather than attempted. `Jest`
- [ ] Jest (api): a failed email send never blocks or rolls back the order. `Jest`
- [ ] Jest (api): a buyer's per-type opt-out is honoured on the next send. `Jest`

#### BUY-A11

- [ ] Jest (api): directory search returns only opted-in tenants, never every tenant. `Jest`
- [ ] Jest (api): the directory never reveals whether an email is a customer of a listed seller. `Jest`
- [ ] Jest (api): requesting from the directory follows the same identity-proof rules as the slug path. `Jest`
- [ ] Jest (api): the directory endpoint is rate-limited at least as tightly as the existing request route. `Jest`

#### BUY-A12

- [ ] Manual (mobile): scanning a barcode adds the product at its pack default. `manual`
- [ ] Jest (api): an unmatched barcode returns an empty result, never a 500. `Jest`
- [ ] Jest (api): a barcode for a gated product the buyer can't see behaves exactly like "not found". `Jest`
- [ ] Manual (mobile): repeated scans increment quantity rather than duplicating lines. `manual`

#### BUY-A13

- [ ] Jest (api): a scoped machine credential can create orders for exactly one (buyer, seller) pair. `Jest`
- [ ] Jest (api) idempotency: replaying the same idempotency key returns the original order, no duplicate. `Jest`
- [ ] Jest (api): revoking a machine credential fails the next call immediately. `Jest`
- [ ] Jest (api): machine-path rate limits and payload caps are at least as strict as the interactive path. `Jest`

## How this varies by tenant

| Variation                                                                                  | Mechanism                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whether the buyer portal is available at all                                               | **NOT ENFORCED** — the `addon.buyer_portal` flag and `BUYER_PORTAL` SKU exist in `plan-catalog.constants.ts` but nothing gates any buyer route on it; every tenant with a customer can invite them. `publish-plan-catalog-v11.ts:14` retires the SKU noting it "gates nothing". |
| Whether buyers can pay by card in the portal                                               | Per-tenant Stripe Connect link — `TenantStripeConnect.chargesEnabled`, read via `StripeConnectService.chargeableAccount()`. No Connect account means the card button is absent; declared cash still works.                                                                      |
| Whether the portal enforces credit limits                                                  | `flag.credit_limits`, resolved by `isCreditLimitCheckEnabled()` with a kill switch, both defaulting ON. Coverage hole: governs edit/change-request paths only, not new-order creation (BUY-A8).                                                                                 |
| Whether the buyer sees delivery tracking, and whether ad-hoc trips exist                   | Per-tenant addons `RECURRING_ROUTES_ADDON` / `ORDER_DELIVERY_ADDON`, enforced server-side by `@RequireAddon`. The tracking endpoint itself is ungated but returns nothing meaningful without a route run.                                                                       |
| Which categories are hidden from a buyer until licensed                                    | Per-tenant `TrackedCategory.requiresLicense` plus per-customer `CustomerAuthorization` (status + expiry), resolved by `RegulatedVisibilityService`. Also gated commercially by the `REGULATED_ITEMS` addon.                                                                     |
| What a given buyer pays for the same product                                               | Per-customer `pricingTier`, per-product `CustomerPrice` overrides, and the customer's remembered agreed price. Promotions are tenant-level and CUSTOMER-scope only.                                                                                                             |
| How the seller tells buyers to pay                                                         | `SystemConfig` key `remittance.config`, edited by the seller, surfaced buyer-visible by design at `GET /buyer/remittance`.                                                                                                                                                      |
| Seller identity shown to the buyer                                                         | `TenantConfig.businessName`/`logoKey`/`primaryColor`. **PARTIALLY WIRED** — the portal shell itself ignores them and hard-codes RouteFlow branding (see BUY-A1).                                                                                                                |
| How many portal buyers a tenant can have                                                   | Indirect only — the `CUSTOMERS` meter and `CUSTOMER_PACK_100` addon cap customer records, and one customer maps to exactly one portal login. There is no separate portal-seat meter.                                                                                            |
| Whether buyers receive transactional email from the seller's own mailbox or from RouteFlow | Per-tenant SMTP (`email.*`, BYO-SMTP first) or a verified sending domain, falling back to the platform identity. Currently reaches buyers only for invites, connect requests and invoice sends — never order confirmations (BUY-A10).                                           |
| Whether the buyer sees deal chips and struck prices                                        | Per-tenant `Promotion` rows (scope ALL/CATEGORY/PRODUCTS), surfaced via `GET /buyer/promotions` and `applyBestPromotion`. Customer-scope only.                                                                                                                                  |
| Minimum order value, delivery cut-off times, route-day calendars                           | **NOT CONFIGURABLE** — no such setting exists anywhere; the cart accepts any basket and any free-form date.                                                                                                                                                                     |

## Gaps for a great UX

| Severity | Gap                                                                                                                                                                                                                                                 | Impact                                                                                                                                                                                                                                        | Suggested direction                                                                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | A buyer can place a brand-new order regardless of their credit limit — the guard is wired into edits and change-request approvals but never into order creation, which is the path `POST /buyer/orders` takes whenever the buyer has no open order. | A customer already past their limit self-serves more goods every cycle; the seller only discovers it at invoicing, after the stock has shipped. This is the largest money-risk hole in the domain.                                            | Call `assertWithinCreditLimit` inside `OrdersService.create()` right after totals are computed, in the same transaction, exactly as `updateOrderItems` already does. Pin with a spec asserting a 0.01-over-limit new order is rejected. |
| CRITICAL | `PATCH /buyer/orders/:id/items` is not status-gated for buyers — `computeEditWindow` treats every non-CANCELLED order as editable, so a buyer token can amend a DELIVERED, invoiced order and the linked invoice re-syncs to match.                 | A buyer could reduce quantities on goods already delivered and watch their invoice shrink; only the web UI hides the button today, and a hand-crafted request bypasses it entirely.                                                           | Add a role-aware gate in `updateOrderItems`: when the caller is a CUSTOMER, refuse any order not in DRAFT/PENDING, mirroring the existing buyer-cancel rule.                                                                            |
| CRITICAL | Every push notification aimed at a portal buyer is undeliverable, and `StockAlertService.fireForProducts` marks the alert delivered regardless.                                                                                                     | "Notify me when back in stock", order confirmations, change-request decisions and standing-order runs all appear to work and reach nobody; the back-in-stock feature is actively worse than absent because the request is silently destroyed. | Register the Expo push token on buyer login/refresh against a buyer-scoped device-token store; make `fireForProducts` leave the alert PENDING when zero channels were reached; add an email fallback.                                   |
| HIGH     | A buyer cannot download an invoice PDF unless the seller happened to email it first — the endpoint only generates on demand when `pdfUrl` is already populated.                                                                                     | The most common self-serve request — "send me a copy of that invoice" — fails silently for every invoice handed over on paper at the door, which is most of them in a delivery business.                                                      | Drop the `pdfUrl` precondition and always call `getOrGenerate` for a non-DRAFT invoice the buyer owns, the way the statement endpoint already does.                                                                                     |
| HIGH     | The portal is not the seller's storefront — the shell is hard-coded RouteFlow branding and `primaryColor` has no consumer anywhere in the buyer portal.                                                                                             | The distributor is paying for a customer-facing channel that advertises someone else's brand to their own retailers, undermining the "your own ordering portal" pitch.                                                                        | Drive the portal shell from the active seller's tenant config (logo, accent colour with a safe fallback), then follow with a per-seller hostname mirroring the operator login's subdomain branding.                                     |
| HIGH     | One customer account equals exactly one portal login, with no roles and no approval threshold.                                                                                                                                                      | Real retail buyers are two or three people who end up sharing one password — no audit of who ordered what, no way to revoke a departed clerk, no owner approval on a large drop.                                                              | Move to a join model (BuyerAccount ↔ Customer many-to-many with a role column), stamp the acting buyer id on each order, add an optional approval threshold. Plan the migration before the buyer base grows.                            |
| HIGH     | There is no returns or shortage-claim path for buyers despite a complete staff-side returns engine.                                                                                                                                                 | Every damaged case or short pallet still arrives as a phone call and a photo — exactly the manual loop the portal exists to remove — and the credit-note trail starts outside the system.                                                     | Expose a buyer-scoped return submission that creates a PENDING return against delivered quantities with photo uploads, reusing the returns engine end to end; keep approval and refund staff-only.                                      |
| MEDIUM   | The buyer never sees a real tax figure or total before committing — the cart shows "Tax: Calculated at checkout" with the estimate equal to the subtotal — and no order-confirmation follows.                                                       | For a tax-inclusive or excise-heavy catalogue the committed number can be materially below the invoice, eroding trust and generating "why is this more" calls.                                                                                | Return a server-computed tax/total preview from a dry-run pricing endpoint reusing the same fold the order write uses; render it on the cart; send a confirmation email carrying the same figures.                                      |
| MEDIUM   | The cart lives only in browser localStorage, separately on mobile, so a basket cannot move between devices and is lost when site data clears.                                                                                                       | A buyer who builds a large basket on the shop floor and finishes at the office starts again, quietly capping how large a self-serve order gets.                                                                                               | Persist the cart server-side per (buyerAccountId, tenantId) with last-write-wins per line; keep localStorage as an offline cache that reconciles on reconnect.                                                                          |
| MEDIUM   | Buyer notifications exist only in the open browser tab, capped at 50 entries in localStorage, with no server-side record.                                                                                                                           | Anything raised while the buyer is signed out — order confirmed, invoice issued, licence expiring — is gone; the bell is decorative for anyone who doesn't live in the portal.                                                                | Persist buyer-facing events as rows scoped to (buyerAccountId, tenantId) with read state; serve them from a `/buyer/notifications` endpoint the socket merely invalidates.                                                              |
| MEDIUM   | Web/mobile parity is inverted in several places: tracking and reorder-from-past-order are mobile-only; make-a-payment, product detail, category counts and full profile editing are web-only.                                                       | Neither surface is complete, so the seller can't tell buyers "use whichever you prefer" — and it breaks the house rule that web is the golden reference.                                                                                      | Add a tracking card and reorder action to web order detail; add product detail and the payment panel to mobile; reconcile `/buyer/me` vs `/buyer/profile` on mobile.                                                                    |
| MEDIUM   | No ship-to selection, no PO/reference field, no minimum-order value, no delivery cut-off calendar.                                                                                                                                                  | Multi-store and chain buyers can't use the portal without side-channel instructions; route-day distributors get orders requested for days they don't deliver.                                                                                 | Add `addressId` to Order with a checkout picker, a `poNumber` string carried onto the invoice, a tenant minimum-order setting, and a delivery-schedule model driving the date picker.                                                   |
| MEDIUM   | Buyers can only view and pause seller-created standing orders (and pause only on mobile) — they can't create one or edit its lines/schedule.                                                                                                        | The recurring-revenue feature depends entirely on the seller doing setup work, so it never gets used at scale.                                                                                                                                | Allow creating a template from an existing order, plus line/quantity edits on the buyer's own template, keeping schedule activation subject to seller approval if desired. Bring pause/resume to web first.                             |
| MEDIUM   | Marketing advertises "Voice search in English & Spanish" for the buyer app; no speech code and no localisation of any kind exists anywhere in the buyer portal.                                                                                     | A prospect can be sold on a feature — and a language — that isn't there, surfacing as a credibility problem in the first week of onboarding.                                                                                                  | Build it (Web Speech API on web, native recognition on mobile, feeding the existing search) and add real i18n to `/buyer`, or remove the claim from the marketing pages until it ships.                                                 |
| MEDIUM   | E2E coverage for the portal stops at authentication and navigation — no automated test adds a product to the cart or places an order.                                                                                                               | The highest-value path in the domain has no automated proof; every checkout regression ships undetected until a buyer hits it.                                                                                                                | Add a Playwright journey on the e2e-routeflow tenant that adds a boxed and a loose product, asserts the estimate, places the order, asserts the order total, then cancels it to stay repeatable.                                        |
| LOW      | `getSellers` issues one `tenantConfig.findFirst` per link inside a `Promise.all`, on every portal page load.                                                                                                                                        | Harmless for a buyer with two sellers, linearly worse for a multi-seller buyer, sitting on the hot path of first paint.                                                                                                                       | Replace with a single `findMany` over the collected tenant ids and a Map lookup.                                                                                                                                                        |
| LOW      | There is no seller discovery — a buyer must already know the seller's exact slug to request access.                                                                                                                                                 | Self-serve onboarding effectively requires the seller to send an invite first, so the portal can't grow through buyers finding their own suppliers.                                                                                           | Add an opt-in seller directory with search, keeping the existing identity-proof rules and rate limits so it never becomes a customer-enumeration oracle.                                                                                |

## Cross-domain handoffs

- **Customers → Buyer Portal**: `CustomerLink` is created/approved from the customer record
  (portal-invite/approve/decline/disconnect, pending-approvals). `Customer.pricingTier`,
  `CustomerPrice`, `creditLimit`, `isTaxExempt` and addresses are seller-controlled inputs the
  portal reads and must never let the buyer write (`UpdateBuyerProfileDto` on `PATCH /buyer/me`).
- **Products & Inventory → Buyer Portal**: `BuyerCatalogService` wraps `ProductsService`, so
  activation, pack size, images, merch flags, stock and `lowStockThreshold` flow straight to the
  buyer. Inventory's stock-increase paths call `StockAlertService.fireForProducts` after commit —
  the restock handoff.
- **Buyer Portal → Orders**: `POST /buyer/orders` and the item PATCH call
  `OrdersService.create`/`updateOrderItems`/`mergeAllPendingForCustomer` with a CUSTOMER
  pseudo-user; cancel calls `changeStatus`. Everything downstream — invoice reconciliation, stock
  settlement, regulated ledger, sales-agent commissions — fires from that one write.
- **Orders → Invoices → Buyer Portal**: buyer-generated invoices come back through
  `GET /buyer/invoices`; a buyer's read stamps `viewedAt` (SENT→VIEWED), feeding the seller's AR
  ageing. Post-delivery buyer edits re-sync finalized invoices in place — why BUY-M6's missing
  status gate is a money issue, not just a UX one.
- **Payments / Stripe Connect ↔ Buyer Portal**: `POST /buyer/payments/{card,cash}` creates a
  `BuyerPaymentRequest`; the Connect webhook or an operator's approval settles it through
  `recordStandalonePayment`, allocating oldest-invoice-first. The money reappears to the buyer via
  `GET /buyer/payments` and the statement. The operator gets a live alert on declared payments via
  `buyer.payment.requested` (BUY-N20).
- **Credit notes & returns → Buyer Portal**: `CreditNote` remainders drive `availableCredit` on
  the statement. The Returns engine is the missing inbound edge — buyer-raised returns would enter
  `ReturnsService` and emit credit notes back into this same statement (BUY-A3).
- **Regulated / compliance ↔ Buyer Portal**: `TrackedCategory.requiresLicense` plus
  `CustomerAuthorization` drive `RegulatedVisibilityService` (browse-time hiding) and the
  checkout-time 409 `REGULATED_AUTH_REQUIRED`. Buyer licence submissions land in the seller's
  compliance review queue.
- **Routes / Deliveries → Buyer Portal**: `GET /buyer/orders/:id/tracking` reads
  `RouteRun`/`RouteRunStop`, so buyer-visible ETAs only exist for tenants on a dispatch addon.
  Change requests resolved MERGED_AT_STOP write back into the driver's stop.
- **Notifications & Email → Buyer Portal**: `NotificationsService.sendToCustomer` (push, broken —
  BUY-N7) and `EmailService` (invites, connect requests, merge verification) are the outbound
  channels; `RouteFlowGateway` emits `buyer.connect.requested`/`.autolinked` to the operator room
  and `buyer.payment.requested` on declared payments, plus order/invoice events to the buyer
  socket.
- **Billing & entitlements → Buyer Portal**: `EntitlementsService` resolves `flag.credit_limits`
  and the dispatch addons. `addon.buyer_portal` / the `BUYER_PORTAL` SKU is defined but consumed
  nowhere — the intended commercial gate is missing.
- **Platform admin → Buyer Portal**: `buyer-admin.controller.ts` and
  `buyer-admin-merge.controller.ts` are the support path for fixing a buyer's email, status, links
  or duplicate accounts, including impersonation — an email change there must invalidate that
  account's verification tokens and sessions.

## What we could not verify

- No tests were run and no server was started for this pass — the two CRITICAL findings (credit
  limit absent from `OrdersService.create()`; buyer item-edit not status-gated) are read from
  control flow and confirmed by source inspection only; each has a Jest spec above written to
  prove or disprove it before anyone commits to a fix.
- The push-notification break (BUY-N7) is inferred from three facts: `sendToCustomer` requires a
  `DeviceToken` for `Customer.userId`; `apps/mobile/lib/buyer-auth.ts` never registers one;
  `registerPushToken` is called only from the staff login. A customer whose `User` also signs into
  the staff app could still have a token, so "undeliverable for portal-only buyers" is the safe
  reading, not "undeliverable for everyone."
- Production was not queried, so we cannot say how many tenants actually have buyers connected,
  how many have Stripe Connect enabled, or how often invoices in practice carry a `pdfUrl` —
  which decides how badly BUY-M7 bites in the field.
- Not every one of the roughly 40 buyer web/mobile screens was opened end to end; the parity
  claims (no web tracking card, no web reorder/pause, no mobile product detail, no mobile
  payment, no scan-to-cart) rest on hook/route inventories plus targeted greps — strong but not
  exhaustive.
- `Customer.userId` is `String @unique` and non-nullable per schema, so the CUSTOMER-role
  ownership gates are treated as sound rather than broken here — but if any import path ever
  produced a `Customer` without a `User`, order fetch and cancel would 403 for that buyer, and
  that is worth a production count.
- The bug register's summary line was read but not cross-referenced entry by entry against
  B01–B187, so some findings above may duplicate existing register entries.
