# web — Components & shared

> Split from `.claude/code-map/web.md` (verbatim, lines 1155-1325) on 2026-09-13. See [`../INDEX.md`](../INDEX.md).

## Components & shared

- **`components/auth/` (2026-09-08, PR #663, spec 46) — shared `AuthShell` for all 15 reskinned
  auth pages** (operator `(auth)/login`, `(auth)/signup`, `(auth)/signup/check-email`,
  `(auth)/forgot-password`, `(auth)/reset-password`; buyer `buyer/login`, `buyer/register`,
  `buyer/change-password`, `buyer/invite/[token]`, `buyer/reset-password`, `buyer/forgot-password`,
  `buyer/verify-email`, `buyer/verify-merge`; top-level `change-password`, `verify-email`) — logic
  on every page is byte-identical to before, only the chrome changed.
  `AuthShell.tsx` (98 lines) — `AuthShellProps { audience: "distributor"|"retailer", kicker: string,
title: string, lead?: ReactNode, backHref?: string, backLabel?: string, logoUrl?: string|null,
logoAlt?: string, footer?: ReactNode, children: ReactNode }` (`title` is the single `h1`; this is
  NOT the mobile scanner shell — no `initialScanOpen` here). Renders one
  `<main id="main-content" className="rf-auth">` with a `.rf-auth-story` panel (`Brand tone="light"
standalone`, an `h2` kicker/heading/paragraph from `AUTH_STORY[audience]`, an aria-hidden
  order-status/AI-chip visual, a tagline) and a `.rf-auth-form` section (back link, `.rf-auth-card`
  with an optional tenant `logoUrl`, the `h1 title`, optional `lead`, `children`, then a footer slot
  that ALWAYS renders even with no `footer` prop so "Need help?" stays right-aligned). **The story
  panel's `h2` precedes the card's `h1` in DOM order** — design intent (left-to-right
  story-then-form), hidden entirely at ≤ 850px — registry B261.
  `auth-copy.ts` — `AuthAudience`, `AUTH_STORY`, `AUTH_ORBIT`, `AUTH_AI_CHIP`, `AUTH_TAGLINE`
  (verbatim fenced strings transcribed from an external redesign source, cited in the file header).
  `auth-shell.css` (336 lines) — every top-level selector is prefixed `.rf-auth` (D4; a dead
  `.rf-auth-forgot` rule was removed) so `.rf-auth .rf-btn` (0,2,0) beats Tailwind's
  `bg-accent-strong` (0,1,0) by specificity, never bundle order; `app/globals.css` and the Tailwind
  config are untouched. **#778 (2026-09-16):** gained `.rf-auth-success--danger` (`background:
#fee2e2`, the existing `bg-danger-bg` token) — a same-shape danger variant of `.rf-auth-success`
  so `signup/check-email/page.tsx`'s send-failure state never renders inside the mint success
  card (see web/routes-1.md's `(auth)/` entry). Source order after `.rf-auth-success` matters:
  both are equal-specificity plain class selectors, so applying both classes lets the later rule
  win. `index.ts` re-exports `AuthShell`, `AuthShellProps`, and all of
  `auth-copy.ts`. State-derived `h1` titles (no state string rendered twice) on
  `buyer/invite/[token]`, `verify-email` (top-level + buyer), `buyer/verify-merge`, and both
  `reset-password` pages. Buyer auth pages moved off a separate emerald link palette onto the SAME
  utility the operator `/login` "Forgot password?" link uses (`#0b6e6b`, 6.07:1). **Deferred**
  (not fixed, registry rows): B260 (`(auth)/login/page.test.tsx` module-mocks `tenant-host`/
  `tenant-provider` for the whole file instead of exercising `tenantSlugFromHostname` directly —
  unit coverage stands in via `lib/tenant-host.test.ts`), B261 (h2-before-h1 above), B262
  (operator/buyer copy asymmetries: OR/or divider, one-sided back-arrow, `/reset-password` missing
  its footer link — fenced strings, needs a copy ruling). Guards: see "Unit tests" and "E2E tests"
  below.
- **Duplicate-invoice UX in `ScanInvoiceModal.tsx` (2026-08-07):** `InvoiceGroup` gained
  `duplicate` / `duplicateCheckPending` / `allowDuplicate`. A check fires from `applyScan` for every
  invoice in a batch and again (500ms debounce, keyed by invoice id, cleared on discard + unmount)
  whenever the Supplier Invoice # or supplier changes — both of which also reset `allowDuplicate`.
  The posted `total` is the SAME `roundMoney(invoiceTotal + scannedTax)` figure `createOne` sends, so
  the server's supplier+date+total fallback can actually line up. A banner under the Supplier
  Invoice # field distinguishes **resumable** (existing bill is DRAFT — finish it) from **hard**
  (already received — a second bill would double stock), each offering "View existing bill" (new tab,
  so the modal survives) and "Create anyway". **Duplicates are SKIPPED, never batch-blocking**:
  `invoiceValidationError` is deliberately NOT the vehicle (that pre-validation loop aborts the whole
  batch) — `handleCreateAll` partitions targets, posts only the clean ones, and reports
  "Created X of Y — N skipped as duplicates". A skipped duplicate is not a failure and gets no
  `inv.error`. `createOne` also re-parses a 409 in its catch, which covers the same number appearing
  twice inside ONE batch (invoice 1 creates the bill, invoice 3 then 409s) without aborting the loop.
- **Scan archive wiring in `ScanInvoiceModal.tsx` (2026-08-09):** `POST /vendor-bills/scan-invoice`
  now answers with `scanId` and, when the uploaded BYTES hash to a scan already on file, a
  `priorScan` block (`{scanId, scannedAt, status, vendorBillId, billNumber, supplierInvoiceNumber,
total}`) — types live in `lib/api/vendor-bills.ts` as `PriorScanSummary`/`ScanArchive`, folded in
  at the modal as `ArchivedScanResult = ScanResult & ScanArchive` because `lib/api/invoice-scan.ts`
  stays a plain transport type. `PriorScanBanner` (top of the review panel, `data-testid=
"prior-scan-banner"`, plus a marker in `InvoiceNavigator` suppressed when the duplicate marker
  already says it) has two shapes: **amber** when the earlier scan is POSTED with a bill (offers
  "Open BILL-…"), **green** when a review was abandoned — that payload is the STORED extraction
  replayed with no second AI call, so the form fills in exactly as a fresh scan would. `createOne`
  stopped discarding what the OCR read: `scanId` (links bill↔scan and marks it POSTED), `subtotal`,
  and per-line `sku`/`packSize`/`lineTotal`, all as PRINTED — an operator edit to qty/unitCost does
  not rewrite them. **Split rows send NO sku/lineTotal** (the printed code and amount describe the
  whole line, not each variant) **but DO inherit `packSize`** (2026-08-12): a split divides the CASE
  count across flavors, so each part stays case-denominated — dropping it received cases as pieces.
- **Skip pre-existing invoices in `ScanInvoiceModal.tsx` (2026-08-12):** `InvoiceStatus` gained
  `"skipped"` — one status value updates every consumer (`targets`/`creatable`/`leftBehind`/
  `firstUnposted`/`hasWork`). `alreadyInSystem(inv)` is the ONE predicate for "pre-existing"
  (number/fuzzy `blockingDuplicateOf` OR a POSTED `priorScan` with a bill; expense-mode and
  `allowDuplicate` exempt) consumed by banners, navigator, skip affordances and the create-all
  partition. `skipInvoice`/`unskipInvoice` flip status (never array removal — object URLs + nav
  indices stay stable); editing supplier/invoice-number un-skips like it resets `allowDuplicate`.
  DuplicateBanner gained "Skip this invoice" (`data-testid="duplicate-skip"`), skipped panel
  (`duplicate-skipped`) offers "Undo skip", navigator shows "N already recorded · Skip them"
  (`skip-all-duplicates`). `handleCreateAll` counts `dropped` (explicit skips — DONE decisions)
  separately from `autoSkipped` (still-blocked dups left scanned); clean close =
  `failed===0 && autoSkipped===0 && leftBehind===0` — **a batch containing skipped duplicates
  now finishes**; toast reports "N skipped as already recorded". All-dups batch → confirm →
  skip-all + close. Qty cell gained a per-line pack-size input ("× N pcs", clearable) and the cost
  cell a "per case of N" hint; quick-create from a case line passes PER-PIECE `initialCost`
  (box-price `initialPrice` unchanged — the boxed contract asymmetry; `ProductCreateModal`'s cost
  hint is pack-aware). e2e: OP-17f (one dup skipped, other posts, modal closes).
- **`ScanInvoiceModal.tsx` single-scan error fidelity (2026-09-04, REG-OCR-2):** the single-scan failure toast now reads `msg || "Please check the file and try again."` — `msg` is the server's own `error?.response?.data?.message` — so a 403 `ADDON_GATE` denial (or any other server message) surfaces verbatim instead of the generic file hint; the generic copy is now a true fallback for when the server sends none. Mirrors the batch branch (`scanOne`), which already read the server message. e2e: `e2e/02-operator.spec.ts` OP-17g — mocks a 403 `ADDON_GATE` response on `**/vendor-bills/scan-invoice` and asserts the server's message is visible and the generic hint has zero matches.
- **Partial receiving on `vendor-bills/[id]/page.tsx` (2026-08-12):** `ReceiveBillModal` — per-line
  qty inputs primed to outstanding (`lineRemaining(bill,item)` mirrors the server's legacy rule:
  receivedDate set + all `qtyReceived` null = fully received), invalid/over-remaining blocks
  confirm, unlinked count noted; confirm posts `items: [{itemId, qty}]` (`useReceiveVendorBill`
  gained `items`; `ReceiveVendorBillLine` in `lib/api/vendor-bills.ts`, `VendorBillItem` gained
  `sku/packSize/lineTotal/qtyReceived`). `pendingReceiveItems` re-sends the same plan through the
  UNLINKED_ITEMS confirm retry. Receive affordance: DRAFT, paid-first-never-received (status is a
  payment blend — receipt truth is receivedDate), and PARTIAL/PAID with outstanding ("Receive
  remaining"). Items table shows "× N pcs" / "per case" / "n received" hints; the line editor
  gained a Pcs/case column (cost label flips Unit↔Case Cost) and PRESERVES sku/lineTotal through
  `handleSaveEdit` (server recreates lines on edit — anything not resent is lost); quick-create
  from a case line seeds per-piece price AND cost (no pack prefill on `InlineCreateProductModal`).
- **Date fields (2026-08-07):** `CreateOrderModal.tsx` has an optional "Order date" (`max=today`)
  beside Requested Delivery Date; `invoices/new/page.tsx` relabels its issue-date field "Sale date" in
  SALE mode and sends `orderDate` ONLY when it differs from today (so the default path stays
  byte-identical and `deliveredAt` keeps a full `now()` timestamp); `orders/[id]` and the orders list
  render `orderDate ?? createdAt`, the list marking a backdated row where the two UTC days differ.
  `invoices/[id]/page.tsx`'s RecordPaymentModal gained BOTH a "Payment date" (it previously had NO
  date at all — the server stamped now) and the optional "Money received in bank"; EditPaymentModal
  clears the latter by sending `null`; the payment-history row switched from `createdAt` to `paidAt`
  (it disagreed with every other surface and already misreported a backdated payment) and appends
  "· landed {date}". `finance/payments` gained the field, a sortable "Bank date" column, and the
  detail display; date FILTERS stay on `paidAt`. Buyer surfaces untouched — settlement is internal.
  **`orderDate` must survive the two places it used to vanish:** it is part of `OrderDraftPayload`
  (`lib/drafts.ts`) plus the `draftPayload` memo AND its dependency array, the hydration effect and the
  `lastSavedRef` autosave baseline — `handleDismiss` auto-parks on Cancel/backdrop/Escape, so a missing
  key silently discarded the date without the operator choosing to discard anything (and a stale memo
  emits no autosave PATCH at all). And when a date is set the merge prompt DISABLES "Merge into …"
  (demoted to secondary, "Create as separate" promoted to primary) because that branch merges via
  `updateOrderItems` server-side and never carries the date; the API rejects the combination anyway.
  `finance/expenses`'s CreateBillModal now parses 409s with `getDuplicateVendorBillError` and renders
  the same duplicate banner (amber resumable / danger hard, "View existing bill" + "Create anyway" →
  re-post with `allowDuplicate`) instead of swallowing the server message in a generic toast.
- `SentryInit.tsx` (2026-08-26): client component mounted in root `app/layout.tsx` — inert
  unless `NEXT_PUBLIC_SENTRY_DSN` set; dynamic-imports `@sentry/react`, tags `tenant` from the
  slug cookie.
- `tenant-provider.tsx` (branding CSS vars; **2026-08-26 branding-by-session** — slug resolves
  JWT-first via `lib/auth.ts getSessionTenantSlug()` (module-level, NOT a hook: the provider
  mounts OUTSIDE the auth context), a disagreeing `tenant-slug` cookie is REWRITTEN (self-heal
  — it also feeds the X-Tenant-Slug header), and branding re-resolves+refetches on window
  focus/visibilitychange when the resolved slug changed (multi-tab impersonation switches)
  **plus `subscribeImpersonation(recheck)` (2026-08-28)** for the same-tab case — an
  impersonation set/clear during a soft nav fires no focus/visibility event, so the sidebar logo
  and business name used to stay on the previous tenant; the slug-changed guard still means no
  refetch on an unrelated event. `refreshTokens()` in auth.ts also re-syncs the cookie. Root cause fixed: a stale cookie
  could brand one tenant's invoice letterhead with another tenant's name), `CommandPalette.tsx` (Cmd+K nav/search),
  `BarcodeScannerButton.tsx`, `DocumentLetterhead.tsx` (PDF header), `ScanInvoiceModal.tsx` (OCR),
  `BatchItemReviewModal.tsx` (`settings/batch-import` — per-line product remap + supplier link;
  the review gate for `resolveItem`, see api.md's P5 batch-queue defect-fixes note),
  `SearchableProductPicker.tsx`, `SupplierSelect.tsx`, `InlineCreate{Product,Supplier}Modal.tsx`
  (Product modal's `CreatedProduct` carries `unitsPerBox`/`parentProductId`/`variantName`/`parent`
  so `onCreated` consumers — CreateOrderModal, invoices/new — get the Boxes+Pcs editor + the
  `displayProductName` label for a just-created boxed product/variant),
  `AddressAutocomplete.tsx` (Google Maps), `UnitCombobox.tsx`, `GroupAsVariantsModal.tsx`,
  `ConfirmDialog.tsx`, `DraftDock.tsx` (parked-draft dock + scan-to-draft, Phase 2 §2; its
  `resumeHref`/`newOrderHref` and `CommandPalette`'s `createHref` MERGE the intent param onto the
  current query when already on the target route — building it from scratch discarded the
  operator's `?page=`/`?search=`, because the target page's deep-link effect strips only the intent
  params and replaces with whatever is left),
  `ArrivedStopSheet.tsx` (Phase 2 §3 at-door actions sheet: `Modal` w/ 3 nav tiles — Adjust order
  → `/orders/{orderId}` (shown only if the stop has an order), New order at door →
  `/orders?action=new`, Collect payment → `/finance/payments`; pure navigation dispatcher, no new
  API/state, closes on selection via `router.push`),
  `SortableTh.tsx`, `ReportChart.tsx` (recharts), `ReportToolbar.tsx`,
  `TenantLogo.tsx`, `PwaInstallPrompt.tsx`/`InstallAppButton.tsx`, `ServiceWorkerRegistry.tsx`,
  `AutoRedirectIfAuthed.tsx`, `inventory/StockCount{Tab,Row,BulkBar,ReviewModal}.tsx` (the per-row
  count qty is a **`DecimalInput`** — was a native `type=number` that couldn't take fractional counts
  for kg/liter units and snapped a cleared field to 0; `decimals` = 3 for decimal units else 0;
  **2026-08-26:** `beginNewSession` marks a FRESH session as already hydrated
  (`hydratedSessionRef.current = res.id` when not amending) — the session is created empty
  server-side, so letting the detail query's `lines: []` through the hydrate effect wiped the row
  the operator scanned in the same breath (the first counted line vanished on every new count;
  e2e COUNT-01 caught it). Amend sessions still hydrate — those ARE seeded server-side).
- **B499 fix (#851, 873a4ac7):** `CreateOrderModal`'s product search had no camera-scan button —
  scans now route through the same `barcodeScanHandlerRef` the typed-SKU+Enter path already used,
  so there's no duplicated add-line logic (archived/found/network-error/not-found behave
  identically for both entry methods). `BarcodeScannerButton.tsx` also gained an optional
  `onError` callback and an `isSecureContext` pre-check before opening the camera overlay, with
  classified messages for denied/absent/busy-camera — purely additive (`onError?.()`), so none of
  its other 9 call sites (14 render sites) needed to change. Specs: `CreateOrderModal.test.tsx`,
  `BarcodeScannerButton.test.tsx`, `e2e/08-create-order-escape.spec.ts`.
- **`LineItemRow.tsx` (#933, 2026-09-19, new)** — the order-line row extracted VERBATIM out of `CreateOrderModal.tsx` (which shrinks 320 lines; `CreateOrderModal.copy.static.test.ts` updated) so the planned scan-to-order screen (scanner-redesign-spec.md §4.1) can reuse it instead of forking. Exports `LineItemRowItem` (the old inline `LineItem` shape verbatim — qty/boxes/pieces, price fields incl. `priceType`, `trackedCategoryId`, `isUnlisted`, per-line `note`/`noteOpen`, UI-only `sellBy`), `LineItemRowProps` (`item`, `category`/`marginFloor`/`floorAcked`/`costRevealed`/`priceHistoryEntry` resolved by the CALLER — the row does no lookups itself — plus an unused-by-CreateOrderModal `highlighted?` reserved for the scan screen's last-scanned ring, and the `onQtyDelta`/`onSetBoxes`/`onSetPieces`/`onSetUnitQty`/`onSetSellBy`/`onSetDiscountedPrice`/`onSetToFloor`/`onAckFloor`/`onToggleCostRevealed` callback set), and the `LineItemRow` component itself. Pure presentational — no `useCustomer`/`useTrackedCategories`/pricing calls inside it; `CreateOrderModal` still owns all state and the callbacks it passes in. `packSizeConversion`, the license-guard wiring, the regulated-tag/split-preview logic, and everything else documented against `CreateOrderModal.tsx` above/below stays in that file, unmoved.
- **order-entry / catalog batch (2026-07-11):** `MoneyInput.tsx` (`MoneyInput`/`DecimalInput` — raw draft string, parse live, `toFixed` on blur only; replaced every reformat-while-typing / numeric-bound money input incl. the `PriceEditRow` echo `useEffect` + product-tier `EditableNumber`), `CategoryCombobox.tsx` (pick-or-type-new, fork of `UnitCombobox`; `GET /products/categories`), `formatQtySplit` in `lib/pricing.ts` ("2 boxes + 3 pcs" on order/invoice detail + PDF). `ScanInvoiceModal.tsx` + `vendor-bills/[id]` gained the unmatched-line banner + per-line link/create (reuse `InlineCreateProductModal` w/ `initialPrice`/`initialCost`) and STOP auto-`acknowledgeUnlinked`. `QuickRestockModal` (inventory) = `SearchableProductPicker`(+`inputRef` wedge) + `BarcodeScannerButton`. `vendor-bills/[id]` `EditLineItems` line-item product select uses `SearchableProductPicker async` (server-side search, no 500-row `useProducts` fetch) instead of a native `<select>`; `onChange(id, product)` sets `productId`/`description`/`unitCost` from `product.averageCost`, clearing sets `productId: ""` (custom item). Per-line item **note** input on `CreateOrderModal`/`orders/[id]`; per-line **cost eye** toggle (operator-only) on `CreateOrderModal`.
- **`ScanInvoiceModal.tsx` batch scan (one bill per PDF):** state = `invoices: InvoiceGroup[]` + `activeIndex`; flat names (`supplierId`, `reviewItems`, `pagePreviews`, expense fields…) are DERIVED from `invoices[activeIndex]` with plain-closure wrapper setters (NEVER memoize — stale `activeIndex` would cross-write invoices). `groupFiles`: each PDF = own invoice, all images = one invoice (pages). One `scanInvoice(files, signal)` call per group (concurrency 3, per-invoice `AbortController` + `runIdRef` stale-guard, per-invoice Retry). `InvoiceNavigator` (◀ Invoice X of N ▶ + status dots + within-batch dup-invoice# warn) switches preview AND form. `handleCreateAll`: `isSubmittingAll` gate, ONE up-front aggregated unlinked-lines confirm (single-invoice copy must keep "aren't linked to a product" — OP-17b asserts it), per-invoice create→receive→expense with `createdBillId`/`expenseCreated` idempotency (no double-post on retry); supplier invoice # editable → bill `notes` + expense `referenceNumber`; `roundMoney` on all totals; modal stays open if failed/scanning invoices remain. Object URLs revoked on re-upload/unmount (`invoicesRef`). e2e: OP-17b (single, unchanged) + OP-17c/d/e (batch/retry/idempotency, all write-routes mocked). Partial-failure branch now resets `createFromRow` alongside `activeIndex` (was desynced — a still-open "Create product from this line" flyout could attribute the new product to the wrong invoice after `setActiveIndex` jumped); `InvoiceNavigator` + the per-row create-product button are `disabled` while `isPending` so an operator can't switch invoices or open that flyout mid-batch-create. `invoiceTotalOf` sums RAW line amounts and rounds ONCE at the end (was rounding each line then summing) — must match the server create() totalOwed computation exactly, since this value also feeds the paired both-mode Expense.amount; per-line rounding could drift a cent from the server total on a fractional qty or >2-decimal unit cost.
- **`components/brand/` (new, marketing-port #657)** — the one shared brand mark, replacing every
  per-site logo treatment (marketing nav/footer SVG, login's inline SVG, the 404 "RF" monogram,
  platform-admin's Shield icon, every legacy per-brand `<img>`). `BrandMark({size=34, className,
tone="dark"|"light"})` — plain `<img src="/brand/routeflow-mark-192.png">`, deliberately NOT
  `next/image` (guarded by `components/no-next-image.test.ts` below — `apps/web` builds
  `output:"standalone"` with no `images` config); `tone="light"` applies `brightness-0 invert` for
  dark surfaces. `BrandSignature({size, periodColor, standalone, tone})` = mark + "routeflow."
  wordmark; `standalone` opts into the marketing header's own type metrics on surfaces outside
  `.rf-marketing` (login, 404, platform-admin) so the signature is self-contained there. `Brand` =
  `BrandSignature` wrapped in a `Link href="/"`. **`TenantLogo.tsx` falls back to `BrandMark`**
  (via a `role="img" aria-label` wrapper, since `BrandMark` itself is `alt=""`/`aria-hidden`) when
  no `branding.logoUrl` is uploaded; its own `tone` prop (default `"dark"`) affects only the
  fallback mark, never a tenant's uploaded logo.
