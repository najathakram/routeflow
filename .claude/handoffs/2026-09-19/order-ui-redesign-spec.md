# Order line-item presentation + post-creation flow — redesign spec

Status: **spec only, no code written**. All file:line citations verified against
`origin/master` at commit `6f49cbf5` (2026-09-18, fetched fresh for this doc) via
`git show origin/master:<path>` — not the local checkout, which lags `origin/master` per
this repo's standing lesson about stale local trees. Where a claim is design/opinion rather
than a verified fact, it is marked **PROPOSED**; verified facts are marked **VERIFIED**.

This spec was written in parallel with
`local-assets/handoff/2026-09-18/scanner-redesign-spec.md` (barcode scan-to-order redesign).
That spec independently arrived at the same structural conclusion this one requires —
extract a shared `LineItemRow` out of `CreateOrderModal.tsx` — and already specifies its
props for the **editable** (create/scan) case. This spec does not re-litigate that; it
**extends** that component's contract to also serve the **read-only** order-detail case, so
RouteFlow ends up with one row component, not two. See §4.

---

## 0. What the three screenshots actually show

| Screenshot | Surface | File(s) rendering it |
|---|---|---|
| iPhone Safari, ORD-00058 | `apps/web/app/(dashboard)/orders/[id]/page.tsx` — the **same** responsive Next.js page desktop uses, viewed at phone width. Not a separate mobile template. | `apps/web/app/(dashboard)/orders/[id]/page.tsx:3010-3131` (the `<table>`) |
| Android, ORD-00198, dark theme, "Home/Dispatch/Orders/Warehouse/More" tabs | The **native Expo operator app** (`apps/mobile`), not a browser view of the web app — confirmed by the RN-only imports (`View`/`Text`/`Pressable`) and by the exact copy match ("Edit items" lowercase, `Ionicons`) | `apps/mobile/app/(operator)/(tabs)/orders/[id].tsx:619-722` |
| Zoho INV-000520 | Third-party benchmark, no RouteFlow code | — |

**This confirms the task brief's suspicion directly: there is no single "order line-item
UI" today — there are two independently hand-built implementations (a desktop-oriented HTML
`<table>` on web, a native card list in the RN app) that evolved without ever sharing a
component or even a copy/casing convention ("Edit Items" vs "Edit items").** Fixing this
requires (a) one shared component for every **web** surface (order detail, create/edit
order, scan — see §4) and (b) a written row-anatomy contract (this doc) that the **RN** app
is separately, deliberately kept in sync with, since RN cannot import a DOM/React web
component. §7 covers how parity is enforced across the two runtimes without pretending they
can share code.

**Why the iPhone table wraps to 9 lines, verified:** the row is a plain `<table>`
(`page.tsx:3010`) with no `min-width`/`whitespace-nowrap` on any cell and no
`table-layout: fixed`. The container has `overflow-x-auto` (`page.tsx:3009`), but that only
engages if the table's *natural* width exceeds the container — since every cell's text can
wrap (default `white-space: normal`), the browser satisfies the width constraint by wrapping
the Product cell's text instead, which is why there's no horizontal scroll bar and instead a
9-line product name. The column header "Unit Price" wraps to "Unit / Price" for the identical
reason (`page.tsx:3015`, no `whitespace-nowrap` on the `<th>`).

---

## 1. Bug report: unit-label casing ("1 Box" / "1 Vape" / "1 box") — reporting only, not fixing here

**Root cause: bad/unnormalized stored data, not a display computation bug**, though the
display layer also does nothing to normalize it on the way out.

- `Product.unit` is declared as a bare, unconstrained string:
  `apps/api/prisma/schema/catalog.prisma:40` — `unit String` (required, no enum, no CHECK
  constraint, no case normalization).
- Every write path accepts it as free text with no transform:
  - `apps/api/src/products/dto/create-product.dto.ts:39` — `@IsString() unit: string;`
    (only a string-type check, no `@Transform` to trim/lower-case, no allow-list).
  - `apps/api/src/products/dto/import-products.dto.ts:17` — same, for bulk CSV import (the
    likeliest source of "Box" vs "box" vs "Vape" appearing in one order: several products
    were typed or imported by different people/sessions with different casing habits).
- The one place RouteFlow *does* have a canonical, case-normalized unit vocabulary is
  `formatQtySplit` in `packages/pricing/src/pricing.ts:765-781`, which always renders the
  box/boxes noun lowercase (`"box"`/`"boxes"`, hardcoded) and only defers to a caller-supplied
  `unitLabel` for the *loose-piece* noun. But `formatQtySplit` only runs when a line has a
  stored `boxes`/`pieces` split. When it doesn't, the RN operator screen falls through to a
  second, independent code path that prints the **raw** `product.unit` field verbatim:

  ```ts
  // apps/mobile/app/(operator)/(tabs)/orders/[id].tsx:644-647
  const qtyLine =
    li.boxes != null || li.pieces != null
      ? formatQtySplit({ qty: li.qty, boxes: li.boxes, pieces: li.pieces })
      : `${li.qty} ${li.product?.unit ?? "ea"}`;
  ```

  This is exactly what the Android screenshot shows: "1 Box", "1 Vape", "1 box" are three
  *different, real* `Product.unit` values from three different catalog rows, printed
  unmodified. It is not a formatting bug in this line — the line does exactly what a raw
  string interpolation does. The bug is upstream: nothing ever normalized what got typed
  into `Product.unit` at creation/import time, and nothing downstream re-normalizes it for
  display either.
- **This is not RN-only.** The same raw-`unit` pattern is pervasive on web too, so any tenant
  with inconsistent `unit` casing will see it there as well, just not in the two screenshots
  provided:
  - `apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx:1290` (`{p.unit}` in
    the product-search dropdown), `:1326` (variant dropdown), `:1492,1516,1528,1539,1547`
    (the line-item row's "/ {li.unit}" price suffix).
  - `apps/mobile/app/(customer)/(tabs)/catalog.tsx:351` (buyer catalog tile: `/ {product.unit}`).
  - `apps/mobile/app/(customer)/orders/cart.tsx:165` (buyer cart: `/ ${item.unit}`).

**Recommendation (file as its own bug, not fixed by this spec):** normalize `Product.unit`
at the write boundary — either constrain it to an allow-list (mirroring how
`packages/types/api/enums.ts` pins other enums) or, at minimum, trim + title-case it in
`create-product.dto.ts`/`import-products.dto.ts` via a `@Transform`, plus a one-time backfill
migration that title-cases existing rows. A display-only fix (e.g., `.toLowerCase()` at every
render site) would band-aid the *symptom* users see today but leaves the underlying data
free-text and would still let a next product read differently-cased again next time an
operator types "vape" vs "Vape". Root-cause the write path.

---

## 2. Related finding: the "indistinguishable variant" bug has an existing fix that just isn't applied on read — reporting only

While tracing the name-truncation problem, a second real, verifiable gap surfaced that
directly explains *why* two Foger Pod flavors can be indistinguishable, and it changes what
"fix truncation" should mean (§3).

- RouteFlow already has a canonical name-composition helper,
  `apps/web/lib/product-display.ts:32-70` (`displayProductName`), whose own doc comment
  states its purpose: *"Compose the display name for a Product the way users want to see it
  on invoices, orders, line items, and any other customer-facing surface."* Since PR #44, a
  true catalog **variant** stores only its own flavor in `Product.name` (e.g.
  `"Strawberry Banana"`) — the parent's name is deliberately NOT baked in
  (`product-display.ts:5-11`) — so anything that reads `product.name` raw for a variant gets
  a bare, contextless flavor string, and `displayProductName` exists specifically to
  reattach `"<Parent> - <Variant>"` (constant separator `PRODUCT_NAME_SEPARATOR = " - "`,
  `product-display.ts:29`).
- `displayProductName` is called at line-**add** time in nine web surfaces (verified via
  `git grep -l displayProductName`): `CreateOrderModal.tsx:485`, both invoice create/edit
  pages, `AssignProductsModal`, `BatchItemReviewModal`, `InlineCreateProductModal`,
  `ProductCreateModal`, `ScanInvoiceModal`, `SearchableProductPicker`.
- It is **never called** on any order-detail **read** path:
  `apps/web/app/(dashboard)/orders/[id]/page.tsx:3041` reads
  `li.product?.name ?? li.name ?? "Custom item"` raw, and the RN screen's equivalent
  (`apps/mobile/app/(operator)/(tabs)/orders/[id].tsx:662`) does the same:
  `li.product?.name ?? li.name ?? "Item"`.
- Compounding this, the composed name is **never persisted**: `CreateOrderModal`'s submit
  payload for a catalog line (`CreateOrderModal.tsx:912-927`) sends only
  `{ productId, qty, ... }` — no `name` field — so the nicely composed
  `"Foger Pod - Strawberry Banana"` the operator saw while building the order is discarded
  the moment the order is saved. Every later read re-derives the name from the live
  `product` relation, raw.
- Net effect for a tenant that actually uses the parent/variant catalog feature: the
  order-detail table, the RN app, and (unverified but structurally identical — same raw
  `li.product?.name` pattern) invoices/PDFs can all show a bare, unprefixed variant name
  post-creation, even though the create flow showed the correct composed name.
- **This is a distinct, separately-fileable bug** ("composed product name lost after order
  creation") from the unit-label bug above. It's flagged here, not fixed, because it changes
  the shape of §3's row-anatomy fix: **the row must call `displayProductName` (or a
  server-side equivalent) at *every* read site, not just at add-time** — otherwise a row
  redesign would still show a bare, orphaned variant name for any tenant using the
  parent/variant feature, no matter how well the truncation is designed.

  *Caveat:* the six "Foger Pod - ..." names in the Android screenshot are more likely six
  **flat, standalone** products (no `parentProductId`) — a tenant that typed the whole
  descriptive string into one product's `name` field rather than using the parent/variant
  split — because if they *were* true variants, `product.name` alone (per the PR #44 rule)
  would show only the bare flavor ("Strawberry Banana"), not the full "Foger Pod - Strawberry
  Banana - ...". Both realities exist in the wild simultaneously (tenants that adopted
  parent/variant, and tenants that didn't), so §3's fix must work for **both**: the
  composed-name gap above for variant-linked catalogs, and a name that is simply one long
  flat string for everyone else.

---

## 3. Row anatomy at 390px

### 3.1 The core problem restated

Two failure modes, one row:
1. **Web (iPhone table):** an unbounded name wraps to as many lines as it takes (9, in the
   screenshot) — nothing is truncated, but one item eats the screen and qty/price/total end
   up stranded far below the name they belong to.
2. **RN (Android card):** `numberOfLines={1}` (`operator-order-id.tsx:661`) hard-truncates
   at the **tail** with an ellipsis, which is exactly where the flavor/variant/pack-size
   lives in this catalog's naming convention (`"Foger Pod - Strawberry Banana - 5ct"`) — so
   the one thing a picker/packer needs to tell two SKUs apart is the first thing lost.

The brief is explicit that a naive fix — "just clamp to 2 lines" — doesn't solve this: a
2-line clamp still shows the **head** of the string and truncates the tail, so
`"Foger Pod - Strawberry Banana - 5ct"` and `"Foger Pod - Strawberry B-Burst - 5ct"` still
collide if the shared "Foger Pod - Strawberry B" prefix alone fills two lines at 390px in a
dense list font. Clamping more forgivingly (3-4 lines) fixes it for *this* example but
reopens the original "one item eats the screen" problem for the genuinely 9-line-worthy name
in the iPhone screenshot.

### 3.2 PROPOSED fix: split the name into an always-visible anchor + a clampable stem, never the reverse

Rather than clamping the name as one opaque string, split it into two visually distinct
zones using the separator convention the catalog **already uses**
(`PRODUCT_NAME_SEPARATOR = " - "`, `product-display.ts:29`) and that `displayProductName`
already established as canonical for parent+variant composition:

- **Stem** — everything before the *last* `" - "` segment (or, for a true catalog variant,
  everything from `displayProductName`'s parent-name portion) — this is the part that,
  historically, is shared across a family of near-duplicate SKUs ("Foger Pod", "FLYTE
  DIAMOND INFUSED PREROLL 1.25GM"). Rendered with `line-clamp-2` (Tailwind 3.4's built-in
  utility, already used elsewhere: `apps/web/app/(dashboard)/products/page.tsx:213`,
  `suppliers/page.tsx:432`, `buyer/portal/.../ProductTile.tsx:197` — no new dependency).
- **Anchor** — the *last* `" - "`-delimited segment (or the variant part from
  `displayProductName`) — this is where "Berry Blast Sativa - 20CT" / "Strawberry Banana" /
  "Strawberry B-Burst" lives. Rendered on its **own line**, full weight, **never clamped,
  never truncated** (`white-space: normal`, `overflow-wrap: anywhere` as a defensive
  backstop against a single pathological unbroken token). This is the segment a picker is
  actually differentiating on, so it is the one thing the row guarantees stays legible.
- If the name has no `" - "` delimiter at all (a genuinely flat name with no internal
  structure) and is not a catalog variant, there is nothing to split — fall back to
  `line-clamp-3` on the whole string. This is strictly better than today's two failure modes
  (1-line hard truncation on RN, unbounded wrap on web) even in the worst case, and it is the
  same "graceful degradation to a plain clamp" the brief allows for by saying "propose
  something better," not "solve it losslessly for every possible name."

**Row height:** fixed to accommodate stem (max 2 lines) + anchor (max 2 lines, wrapping
allowed since it's never truncated, just never *cut*) + secondary metadata line (qty/price,
§3.3) = a **predictable maximum of 5 text lines**, most rows far shorter. This bounds the
worst case (was: unbounded on web, silently lossy on RN) without pretending every name fits
in a fixed 2-line box.

**PROPOSED, explicitly marked speculative:** this stem/anchor split is a heuristic on the
`" - "` convention already visible in real catalog data (§2) — it is not a guaranteed-correct
parse (a product name that legitimately contains `" - "` mid-phrase, e.g. a hyphenated
descriptor with spaces around it by coincidence, would split at the wrong point). It degrades
safely (falls back to a plain clamp) rather than failing loudly, and it is *only* applied as
a **display** heuristic — it must never be used to derive or store data, only to decide where
to put a line break. The `displayProductName`-composed case (true catalog variants) is not
speculative — it's already the canonical split, just not called at read time (§2).

### 3.3 Full row layout, read-only variant, 390px

```
┌───────────────────────────────────────────────────────┐
│ ┌────┐  FLYTE DIAMOND INFUSED PREROLL 1.25GM      ⋮   │  ← thumbnail 40×40,
│ │IMG │  BERRY BLAST SATIVA - 20CT                      │    stem line-clamp-2,
│ └────┘  SKU 6971824063523                              │    anchor never-clamp,
│         8 × $65.00                          $520.00     │    SKU always visible
│         ● Out for delivery                              │
└───────────────────────────────────────────────────────┘
```

- **Thumbnail** (new — §5.2): 40×40px rounded, `object-position` from the stored focal point
  (`apps/web/lib/image-focal.ts:47-49`, `focalToObjectPosition`) so a product photographed
  off-center still crops sensibly at this small size. Falls back to the existing
  `Package` icon tile (`page.tsx:3031-3033`) when `imageKeys` is empty — never a broken-image
  icon, never layout shift (reserve the 40×40 box either way).
- **SKU**, own line, small/muted, monospace-ish — matches Zoho's row (`SKU: 6971824063523`)
  and gives a picker/packer a second, unambiguous identifier beneath the name whenever the
  name split (§3.2) still leaves any doubt.
- **Qty · unit price**, plain-language, one line: `"8 × $65.00"` for a non-boxed line,
  `"2 boxes + 3 pcs · $30.00 / box of 12"` for a boxed line (this exact phrasing already
  exists — `formatQtySplit`, `pricing.ts:765-781`, plus the box-of-N suffix already composed
  in `operator-order-id.tsx:671-672` — reuse verbatim, don't reinvent).
- **Line total**, right-aligned, own visual weight (bold), same row as qty/price on wider
  viewports (768px+) or its own line at 390px if the qty/price string is already long enough
  to make same-row cramped (test at 390px with the longest realistic boxed-qty string).
- **Status pill** — reuses the *existing derivation logic* already written for the operator
  order-detail page (`page.tsx:1689-1702`, `displayLineStatus`) — a real line-level outcome
  (CANCELLED/DELIVERED/PARTIAL) wins; otherwise derive PARTIAL/DELIVERED from `deliveredQty`
  vs `qty` when no explicit line status exists yet; otherwise fall back to the order's own
  terminal state. This logic is already written and tested — the row component should import
  it, not duplicate it.
- **⋮ overflow** (editable variant only) — replaces the always-visible remove/note icon pair
  crammed into the row today (`CreateOrderModal.tsx:1727-1745`); see §3.4.

### 3.4 Read-only vs editable — what changes

| Zone | Read-only (order detail) | Editable (create/edit/scan) |
|---|---|---|
| Thumbnail, name (stem+anchor), SKU | identical | identical |
| Qty/price line | plain text | qty stepper / case-unit toggle (`CreateOrderModal.tsx:1613-1693`, unchanged) |
| Line total | plain text | live-computed via `computeLineSubtotal` (unchanged) |
| Status pill | shown | shown (still useful mid-edit — an already-delivered line being edited should say so) |
| Margin/floor | **hidden** (operator-facing cost data has no reason to render on a read view nobody is repricing from) | `MarginHint`, unchanged (`CreateOrderModal.tsx:1586-1599`) |
| Actions | none (read-only) | note toggle + remove, or swipe-to-delete on the scan screen (per scanner spec §3) |
| New: delivered/remaining (§5.3) | shown when `deliveredQty` differs from `qty` and order isn't DRAFT/PENDING | hidden (nothing has shipped yet) |

### 3.5 Header mockup, 390px

Zoho's pinned header (§0 benchmark) is worth adopting nearly as-is — RouteFlow already has
the numbers (`order.subtotal`/`order.total`, `order.lineItems.length`), they're just not
pinned or counted anywhere on the order-detail page today.

```
┌───────────────────────────────────────────────────────┐
│ ORD-00058              ● Out for delivery              │
│ $645.00 · 3 items                                       │
├───────────────────────────────────────────────────────┤
│ [ row ]                                                 │
│ [ row ]                                                 │
│ [ row ]                                                 │
│ ▾ Show 4 more items                                     │  ← collapses beyond N (§5.1)
├───────────────────────────────────────────────────────┤
│ Subtotal                                    $600.00     │
│ Tax                                          $45.00     │
│ Total                                       $645.00     │
└───────────────────────────────────────────────────────┘
```

At 390px this header sits directly under the existing order-number/status block
(`page.tsx:2440-2452`) — it does not replace it, it adds the pinned total+count line Zoho has
and RouteFlow doesn't.

---

## 4. What we add that Zoho has

| Zoho feature | RouteFlow gap today | Fix |
|---|---|---|
| Pinned total + item count in the header | `order.lineItems.length` and `order.total` are computed but never surfaced together above the list (`page.tsx:2422-2425` computes `summaryLineItems` for a different purpose) | §3.5 header |
| SKU on every row | **Not available on the order read path at all** — `orders.service.ts`'s line-item selects only ever request `{ id, name, unit }` off `product` (verified at 6 call sites: `orders.service.ts:411,648,1233,1548,1864`, plus `:323,1029,1362` for narrower internal selects). SKU **is** already fetched for the product-*search* picker (`CreateOrderModal.tsx:1280-1282` renders `p.sku`) — it just never gets carried onto the order or its line items. | Add `sku: true, unitSku: true` to those selects; add `sku`/`unitSku` to the frontend `OrderItem.product` type (`apps/web/lib/api/orders.ts:126-133`, currently `{id,name,unit,unitsPerBox,averageCost,category}`). Small, additive backend change — no schema migration needed, the column already exists (`catalog.prisma:35-37`). |
| Thumbnail per row | Product images already exist and are already resolved to presigned URLs **in the product list/search endpoint** (`apps/api/src/products/products.service.ts:337-341`: `thumbnailUrl` attached to every row, `apps/web/lib/api/products.ts:116` typed on the frontend) — but (a) `CreateOrderModal` never reads `p.thumbnailUrl` when building a line, and (b) the order-detail read path doesn't join `imageKeys` at all. | Two small additive changes: (1) `addLineItem` (`CreateOrderModal.tsx:477-504`) carries `thumbnailUrl` from the picked product onto the new `LineItem`; (2) the order-detail selects add `imageKeys: true` and resolve `imageKeys[0]` the same way `products.service.ts:340` already does (a shared helper, not duplicated logic — see §4 for where this plugs into the row component's props). |
| Plain-language qty ("1.0 box X $52.50") | Partially present — `formatQtySplit` (`pricing.ts:765-781`) already produces "2 boxes + 3 pcs" — just needs to be the row's canonical qty string everywhere (today the web order-detail table and the RN app each format it slightly differently: compare `page.tsx:3057-3061` vs `operator-order-id.tsx:644-647`). | One shared formatting call inside the shared row (§6), not two hand-rolled ones. |
| Collapsing long lists ("Show more items") | Every line renders unconditionally (`page.tsx:3021`, `.map()` with no slicing) | §5.1 |

---

## 5. What we add that Zoho does NOT have — "beat Zoho"

Zoho is an accounting tool: it knows what was billed. RouteFlow is a wholesale **delivery**
operation: it also knows what was *promised*, what actually left the warehouse, and whether
the price on the line is safe to sell at. The schema already carries most of this — it's
mostly unsurfaced, not unbuilt.

### 5.1 List collapsing for long orders — PROPOSED, low-risk

Beyond ~6 lines, collapse behind "Show N more items" (Zoho's own pattern, §0). Not
speculative in mechanism (`useState` + `.slice`), speculative only in the exact threshold —
recommend matching Zoho's implicit choice (it showed 3 before collapsing a 21-item order) but
tune per real order-size distribution if available.

### 5.2 Thumbnail + SKU

Covered in §4 — listed again here because collectively, thumbnail + SKU + the row split in
§3.2 are what make two near-identical SKUs distinguishable at a glance, which is the actual
underlying ask ("beat Zoho" isn't a checklist item, it's "a picker can tell these apart
without opening each line").

### 5.3 Delivered-vs-ordered quantity, per line — VERIFIED data already exists, not speculative

This is the strongest "beat Zoho" candidate because **the plumbing already exists and is
already used elsewhere** — it's purely a surfacing gap on the operator-facing view:

- `OrderItem.deliveredQty` and `OrderItem.invoicedQty` are real, populated columns
  (`apps/api/prisma/schema/sales.prisma:769-773`), advanced by the route `completeStop` flow.
- The frontend type already has it: `apps/web/lib/api/orders.ts:166` (`deliveredQty?: number`).
- The **buyer portal** already renders it as a delivered/remaining pair of columns, gated by
  `showDeliveryProgress`: `apps/web/app/buyer/portal/[seller]/orders/[id]/page.tsx:914-926`.
- The **operator** order-detail page already *derives* a per-line status from it
  (`page.tsx:1689-1702`, `displayLineStatus`) but only uses that derivation to color a status
  pill — it never shows the actual numbers.
- `packages/pricing/src/pricing.ts:164-175` (`prorateLineSubtotal`) already computes "what
  does `deliveredQty` of `orderQty` cost" correctly (accounting for BOGO free units) — this is
  the exact function needed to show a dollar-accurate "$416 of $520 delivered" on a
  short-picked line, and it's already the reference oracle invoices use, so the row's number
  will always agree with what actually gets billed.

**PROPOSED UI:** when `deliveredQty` is set and less than `qty` (and the order is past
DRAFT/PENDING), show a compact secondary line under the qty/price row:
`"6 of 8 delivered"` with the status pill already reading PARTIAL from the existing
derivation. This is not new business logic — it's exposing three fields and one existing
pure function that are all already correct and already used by a sibling surface (the buyer
portal). Reuse `prorateLineSubtotal` for the dollar figure if the design calls for one;
plain qty (as the buyer portal does today) is simpler and may be sufficient — leave the
dollar figure as a fast-follow, not a blocker.

### 5.4 Per-line margin/floor state surviving into the editable row — VERIFIED, not new

Already fully built (`MarginHint`, `apps/web/components/MarginHint.tsx:120-232`) and already
required by the brief to "survive into any editable row" — it does, unchanged, in the
editable variant (§3.4). Listed here because it's a genuine Zoho-can't-do-this feature
(Zoho has no concept of a cost floor) that RouteFlow already has and must not regress.

### 5.5 Short-pick indication — PROPOSED, marked speculative beyond what §5.3 already covers

§5.3's delivered/remaining split already *is* short-pick indication in numeric form. A
richer treatment (e.g., a driver-entered reason code for why 6 of 8 shipped — "2 damaged,"
"2 out of stock") would need a new field (`DeliveryMutation.note`/`driverNote` already exist
at `sales.prisma` — `DeliveryMutation` model — and could carry this) and a UI to surface it
on the line. **This part is genuinely speculative** — flagged as a fast-follow idea, not
specified further here, since it would need its own investigation into whether
`DeliveryMutation` rows are reliably created with a reason today (unverified in this pass).

### 5.6 Delivery notes and returns on the line — PROPOSED, marked speculative

`OrderItem.notes` already renders per-line (`page.tsx:3043-3045`, `operator-order-id.tsx:681-685`)
— this already exists, not a gap. A dedicated **returns** affordance per line (vs. the
existing order-level `returns` module, `apps/api/src/returns`) was not investigated deeply
enough in this pass to spec concretely — flagging as a genuine idea worth its own
scoping pass rather than guessing at a `ReturnItem` UI here, since `ReturnItem` already
exists as a model (`sales.prisma` FK list includes `returnItems ReturnItem[]` on Product) and
deserves its own read of `apps/api/src/returns` before committing to a row-level design.

---

## 6. One shared row component

### 6.1 Converging with the scanner-redesign-spec

`local-assets/handoff/2026-09-18/scanner-redesign-spec.md` §4.1 already specifies extracting
`apps/web/components/LineItemRow.tsx` out of `CreateOrderModal.tsx`'s ~295-line inline `<li>`
(`CreateOrderModal.tsx:1456-1748`), with a `LineItemRowProps` interface built around
callback props (`onQtyDelta`, `onSetBoxes`, `onSetDiscountedPrice`, etc.) precisely so that a
future consumer (their scan screen; this spec's order-detail view) needs no changes to the
row's *internals*, only to what it's given. **This spec adopts that extraction as the single
source of truth for the row component's location and editable-mode props — it does not
propose a second, competing `LineItemRow`.**

What this spec adds on top of the scanner spec's §4.1 interface is a **read-only mode**:

```tsx
export interface LineItemRowProps {
  // ... every field from scanner-redesign-spec.md §4.1, unchanged ...

  /**
   * Read-only mode (order-detail view). When true, every callback prop above
   * is optional/ignored, qty and price render as plain text (not inputs), the
   * remove/note/⋮ affordances are hidden, and MarginHint is not rendered
   * (§3.4 — cost data has no reason to appear on a view nobody is repricing
   * from). New fields below become relevant.
   */
  readOnly?: boolean;

  // ── New fields, additive — the editable variant simply never sets these ──

  /** Resolved via focalToObjectPosition (image-focal.ts:48) from imageKeys[0]. */
  thumbnailUrl?: string | null;
  sku?: string | null;
  /** Pre-composed by the caller via displayProductName (§2) — the row never
   *  re-derives this itself, so read and edit paths can't drift again. */
  displayName: string;
  /** Drives §3.2's stem/anchor split — the row, not the caller, decides where
   *  to break; callers just pass the full composed name. */
  lineStatus?: BadgeStatus;      // from displayLineStatus (page.tsx:1689-1702)
  deliveredQty?: number | null;  // §5.3
  highlighted?: boolean;         // already in the scanner spec's §4.1 list — shared, not new
}
```

**Why extend rather than fork:** the alternative — a separate `OrderLineItemRow` for
read-only display — is exactly the "fourth variant" the brief warns against. Every prop
above is additive and optional; `CreateOrderModal`'s and the scan screen's existing call
sites (per the scanner spec) pass none of them and get identical behavior to what that spec
already defines. Only the order-detail page becomes a *new* caller, passing `readOnly: true`
plus the new fields.

### 6.2 Variants, summarized

| Variant | `readOnly` | Editable controls | Consumer |
|---|---|---|---|
| Read-only | `true` | none | `apps/web/app/(dashboard)/orders/[id]/page.tsx` (replaces `:3021-3131`'s inline `<tr>`) |
| Editable — modal | `false`/unset | full (qty stepper/case-unit toggle, price, note, remove) | `CreateOrderModal.tsx` (replaces `:1456-1748`'s inline `<li>`, per scanner spec W1) |
| Editable — scan | `false`/unset, `highlighted` used | same as modal, plus swipe-to-delete | `ScanOrderScreen.tsx` (new, per scanner spec §4.3) |

### 6.3 File path and migration order

New/changed files, in dependency order:

1. **`apps/web/lib/product-display.ts`** — no change needed; already correct (§2). Just
   needs to be *called* from more places (below).
2. **`apps/api/src/orders/orders.service.ts`** — widen the six line-item `product` selects
   (§4's SKU/thumbnail table) to include `sku`, `unitSku`, `imageKeys`, `variantName`,
   `parentProductId`, and `parent: { select: { name: true } }`. Compose
   `displayProductName`-equivalent server-side (or leave composition to the client and just
   ship the raw fields — client-side composition via the existing helper is simpler and
   avoids a second implementation of the same logic in NestJS; **recommend client-side**,
   since `apps/api` has no existing equivalent of `product-display.ts` and duplicating it
   server-side is a second mirror to keep in sync for no real benefit — the web client
   already has every field it needs to call `displayProductName` itself once the select is
   widened).
3. **`apps/web/lib/api/orders.ts`** — widen `OrderItem.product`'s type (`:126-133`) to match.
4. **`apps/web/components/LineItemRow.tsx`** — the scanner spec's W1 extraction, done first
   regardless of this spec (it's already scheduled as *their* blocking prerequisite);
   this spec's read-only additions (§6.1) land as a fast-follow diff to the same file once
   W1 lands, not a parallel component.
5. **`apps/web/app/(dashboard)/orders/[id]/page.tsx`** — replace the `<table>`
   (`:3009-3131`) with a card list using `<LineItemRow readOnly ... />`, plus the pinned
   header (§3.5). This is the largest visual change in the whole spec (table → card list) —
   see §8 for why that's the right call rather than trying to make an HTML `<table>`
   responsive.
6. **RN app** (`apps/mobile/app/(operator)/(tabs)/orders/[id].tsx:619-722`) — cannot import
   the web component; gets the **same row-anatomy decisions** (§3) hand-mirrored into its
   existing RN `<View>`/`<Text>` structure, per this repo's standing "mobile mirrors web"
   convention (`CLAUDE.md` Conventions: "Mobile mirrors web: reuse the same API
   endpoints/DTOs/flows; only the UI differs"). See §7 for how this is verified without
   shared code.

**Nothing regresses because:** steps 2-3 are additive (new optional fields, existing fields
untouched); step 4 is already scoped and tested by the scanner spec's own W1 acceptance
criteria (`CreateOrderModal.test.tsx` must pass unmodified); step 5 is the only behavior
change to the read-only view, and it's covered by new Playwright coverage (§9) before it
ships, not after.

---

## 7. Parity across web and the RN operator app

**Why they differ today:** no shared component (RN can't import a Next.js/DOM component —
different renderers entirely), and evidently no shared *spec* either — the two
implementations were built independently and drifted (different qty-string formatting
between `page.tsx:3057-3061` and `operator-order-id.tsx:644-647`; different button copy,
"Edit Items" vs "Edit items"; different truncation strategy, unbounded wrap vs
`numberOfLines={1}`).

**How this is eliminated without pretending code can be shared:**
1. This document (§3) becomes the single row-anatomy contract for *both* runtimes — the stem
   /anchor name split, the SKU line, the qty phrasing (`formatQtySplit`'s existing output,
   which is a pure string both runtimes can call — `packages/pricing` is already imported by
   `apps/mobile` per this repo's money-discipline rule), the status-pill derivation logic
   (`displayLineStatus`, currently web-only — port it as a pure function, same signature, into
   a shared mobile util, since it has zero DOM/React Native dependency, exactly like
   `formatQtySplit` already is shared).
2. Copy strings (button labels, empty states) get pinned in **one** place each runtime reads
   from — not literally shared (React Native and Next.js don't share an i18n layer today),
   but audited for exact-match wording as part of this work's Playwright + manual RN
   verification (§9), the same way the scanner spec treats iOS Safari's untestable-in-CI
   camera behavior as a named manual gate rather than an implied "someone probably checked."
3. **What is NOT proposed:** a cross-platform component library (React Native Web, a shared
   design-system package rendering to both). That is a large, separate architectural bet
   this spec does not make a case for — the smaller fix (one written contract, both runtimes
   independently conform to it, verified by parallel Playwright/manual checks) closes the
   *visible* gap (inconsistent copy, inconsistent truncation, inconsistent qty phrasing)
   without a rewrite.

---

## 8. Post-creation flow

### 8.1 What happens today — VERIFIED

`CreateOrderModal.tsx`'s `submitOrder` (`:898-991`) on success (`:950-967`):
```ts
onSuccess: (created: any) => {
  if (mergeChoice === "merge") { toast({ title: `Merged into order ${created?.orderNumber ?? ...}`, variant: "success" }); }
  else if (asDraft) { toast({ title: "Order saved as draft", variant: "success" }); }
  else { toast({ title: "Order created", variant: "success" }); }
  if (activeDraftId) deleteDraft.mutate(activeDraftId);
  setMergePrompt(null);
  onClose();   // ← closes the modal. No navigation. No link to the new order.
}
```
`useCreateOrder` (`apps/web/lib/api/orders.ts:245-275`) does invalidate the `["orders"]`
query on success (`:275`), so the orders **list** behind the modal refetches and the new
order should appear — but there is no scroll-to, no highlight, and (bigger gap) **no path
from the success toast to the order itself.** The operator has to visually find the new row
in a list that may have just re-sorted/re-paginated under them.

### 8.2 PROPOSED fix — small, uses infra that already exists

`ToastData` already supports an action button
(`packages/ui/src/web/Toast.tsx:12-15`: `ToastAction { label: string; onClick: () => void }`,
used today for an "Undo" affordance per its own comment) — this is not new component work:

```ts
toast({
  title: "Order created",
  variant: "success",
  action: { label: "View Order", onClick: () => router.push(`/orders/${created.id}`) },
});
```

Applies to all three success branches (create, draft, merge — "View Order" for create/draft,
arguably "View Merged Order" for the merge case since the id differs from what the operator
was building). This is the single highest-value, lowest-risk fix in this whole spec: it
directly answers "where does the user land" (answer: **nowhere, today**) with "one click from
the confirmation, if they want it" — without forcing a navigation on operators who are
rapid-firing multiple order creations in a row and want to stay on the list (a forced
`router.push` on every create would be actively worse for that workflow — verified nothing
in the current code suggests operators create one order and stop; the modal's Minimize/draft
machinery, §8.3, is built entirely around *not* losing your place mid-multi-order session, so
an unconditional redirect would fight that existing design intent). **Toast action, not
forced navigation, is the fix.**

### 8.3 Minimize / Save as Draft — VERIFIED, no changes needed here

`handleMinimize` (`:760-769`) and `handleDismiss` (`:797-812`) already give clear,
distinct outcomes ("Draft parked" vs "Order saved as draft" vs a failure toast that
deliberately keeps the modal open so work isn't lost, `:806-811`) — this machinery is sound
and out of scope for this spec beyond §8.2's toast-action addition, which applies uniformly
to it.

### 8.4 Order-detail action-bar hierarchy — the iPhone screenshot's real problem

**VERIFIED current state** (`page.tsx:2478-2814`, per-status action blocks): every status
block renders its buttons with the **same** `size="sm"` and near-identical visual weight —
compare the CONFIRMED block (`:2650-2691`): `Out for Delivery` (primary), `Unconfirm`
(secondary), `Cancel Order` (danger), `Delete this order` (ghost, via
`renderDeleteOrderAction`) — four buttons, four different *intents* (advance, reverse,
destroy-with-recovery, destroy-permanently), rendered with only `variant` color distinguishing
them and otherwise identical size/spacing/stacking. On a 390px viewport these wrap onto
several lines with no visual grouping (`flex flex-wrap items-center gap-2`, `:2478`) — which
is exactly what the iPhone screenshot shows: Edit Items / Mark as Delivered / Return to
Confirmed / Cancel Order / Delete order, five controls, visually equal weight, one of which
permanently destroys the order.

**Assessment: the hierarchy is wrong, and it's wrong in a way that's inconsistent with the
code's own intent.** The code already treats delete as more dangerous than the rest — it's
gated behind a two-tap inline confirm (`renderDeleteOrderAction`, `:2358-2394`) and hidden
entirely once an order is operationally closed or has a posted invoice (`:2355-2357`) — the
*safety mechanism* already reflects "this is the most dangerous button here." The *visual
design* does not reflect that at all; it's a `variant="ghost"` button (the *lowest*-emphasis
variant in the design system) sitting in the same flex row as everything else, which if
anything visually *under*-states it rather than over-states it — but critically, it's
adjacent to a `variant="danger"` Cancel Order button that looks nearly as strong as it, so
the two destructive-ish actions blur together instead of being clearly staged
(reversible-destructive vs permanent-destructive).

**PROPOSED restructure** (no change to the underlying gating logic in §8.4's second
paragraph — those guards are correct and stay exactly as-is):
```
┌─────────────────────────────────────────────┐
│  [ Mark as Delivered ]   (primary, prominent) │
│  [ Edit Items ]  [ Return to Confirmed ]      │  ← secondary tier, grouped
├─────────────────────────────────────────────┤
│  Cancel Order              Delete order       │  ← danger tier, own row,
│  (danger, but reversible    (ghost+danger     │    visually separated by a
│   — order lives on as       text, two-tap     │    rule/spacing from the
│   CANCELLED, can Reopen)    confirm, unrecov- │    working actions above
│                              erable)           │
└─────────────────────────────────────────────┘
```
- Primary action (advance the order: Confirm/Out for Delivery/Mark Delivered depending on
  status) gets the only filled/solid button.
- Reversible actions (Edit, Unconfirm, Return to Confirmed) sit together as a visually
  distinct secondary group.
- Both destructive actions move to their own visually separated row/section, **and** are
  differentiated from each other (Cancel Order is reversible via Reopen Order, per the
  DELIVERED-block comment at `:2727-2733` describing the owner's 2026-08-25 policy — Delete
  is not, per `renderDeleteOrderAction`'s own doc comment `:2339-2354`). Making that
  distinction visible (e.g., a small "can be reopened later" caption under Cancel, nothing
  extra under Delete beyond its existing two-tap confirm) directly serves the brief's ask
  that "a destructive Delete order should not sit at the same visual weight as Mark as
  Delivered" — and goes one step further by not equating Cancel and Delete with each other
  either, since the code already treats them as different severities.
- This is a **layout/visual-weight change only** — no new gating logic, no new statuses, no
  change to any `onClick` handler. Every existing safety check
  (`orderOperationallyOpen`, `hasPostedInvoice`, the two-tap confirm) stays exactly where it
  is in the code; only the JSX grouping and button `variant`/`size` change.

---

## 9. Accessibility and touch

- **44px targets:** `TAP_TARGET` already exists (`packages/ui/src/web/utils.ts:17`:
  `"min-h-[44px] min-w-[44px] inline-flex items-center justify-center"`) — apply it to every
  icon-only control in the new row (note toggle, remove, ⋮ overflow) and to the restructured
  action-bar buttons (§8.4), replacing today's bare `size="sm"` `Button`s where their
  rendered height falls under 44px at 390px (verify via Playwright bounding-box assertions,
  §10 — the scanner spec's own `08-create-order-escape.spec.ts:271-306` precedent already
  does exactly this kind of assertion for the scan button).
- **Contrast:** the stem/anchor split (§3.2) must keep both zones at the existing `text-navy`
  contrast level used elsewhere in this file — no new muted/low-contrast text for the anchor
  specifically, since it's the more important half of the name, not less.
- **No horizontal page scroll:** replacing the `<table>` (§6.3 step 5) with a card list
  structurally removes the failure mode in §0 (a table forced to fit a container by wrapping
  cell text) — a card list's items stack vertically by construction. Verify with the same
  technique `08-create-order-escape.spec.ts:302,306` already uses (`boundingBox().width`
  assertions against the 390px viewport) applied to the new row and header.
- **Screen readers:** the status pill and delivered/remaining line (§5.3) need text
  alternatives, not color/icon-only — `Badge`'s existing `label` prop already renders text
  (`page.tsx:2827`: `<Badge variant="info" label="Editing" .../>`), so this is "use the
  existing prop," not new work.

---

## 10. Work breakdown

Ordered by dependency; W-numbers are new to this spec (do not collide with the scanner
spec's own W1-W7, which this plan treats as a **prerequisite**, not something to redo).

**T1 — Backend: widen order line-item selects** (§6.3 step 2). Depends on: nothing.
Done when: `orders.service.ts`'s six line-item `product` selects include `sku`, `unitSku`,
`imageKeys`, `variantName`, `parentProductId`, `parent.name`; `OrderItem.product`'s frontend
type (§6.3 step 3) matches; existing order-detail tests (money math, statuses) pass
unchanged since these are additive fields. Est: small.

**T2 — Toast action on order creation** (§8.2). Depends on: nothing (independent of
everything else — ships alone if needed). Done when: all three `submitOrder` success
branches pass a `ToastAction`, a Playwright test clicks "View Order" and asserts the URL is
`/orders/:id`. Est: small.

**T3 — Wait for scanner-redesign-spec's W1** (`LineItemRow` extraction). Not this spec's
work item — a dependency. Nothing in T4+ starts until W1 lands.

**T4 — Extend `LineItemRow` with `readOnly` + new props** (§6.1). Depends on: T1 (needs the
new fields to exist somewhere to pass), T3. Done when: the props in §6.1 are added,
`readOnly` hides every editable affordance and `MarginHint`, and a Storybook-less manual
render (or a throwaway test page) shows both variants side by side matching §3.3's mockup.
Est: medium.

**T5 — Name composition at read time** (§2, §6.3 step 2's client-side `displayProductName`
call). Depends on: T1 (needs `parent.name`/`variantName` in the payload). Done when: a true
catalog-variant order line renders `"<Parent> - <Variant>"` on the order-detail page, matching
what it showed at create-time — a regression test seeds a variant product, creates an order
with it, and asserts the composed name survives the read round-trip (it does not today —
this is the test that currently fails and this work item makes pass). Est: small.

**T6 — Order-detail page: table → card list + pinned header** (§3.5, §6.3 step 5). Depends
on: T4, T5. Done when: `page.tsx`'s `<table>` (`:3009-3131`) is replaced by
`<LineItemRow readOnly>` rows plus the header from §3.5, the 9-line-name and
tail-truncated-variant failure modes are gone (verified against the exact two screenshot
scenarios — a name long enough to wrap 9 lines today, and two names differing only in their
last segment), and `local:e2e`'s money-math assertions for this page still pass. Est: large —
this is the visible centerpiece of the redesign.

**T7 — Action-bar restructure** (§8.4). Depends on: nothing structurally (independent of
T4-T6, could ship in parallel) but touches the same file as T6, so sequence after T6 to avoid
merge churn in one 3700-line file. Done when: the primary/secondary/danger grouping in §8.4's
mockup is live, every existing gating condition (`orderOperationallyOpen`, `hasPostedInvoice`,
two-tap confirm) is unchanged, and a Playwright test asserts Delete's button is visually
distinct (different container/`variant`) from Mark as Delivered's.

**T8 — RN app mirror** (§6.3 step 6, §7). Depends on: T6 (needs the finalized anatomy to
mirror, not a moving target). Done when: `operator-order-id.tsx`'s row matches §3's anatomy
(stem/anchor name split, SKU line, thumbnail, `formatQtySplit`-driven qty text, ported
`displayLineStatus` logic) and its `numberOfLines={1}` tail-truncation (`:661`) is replaced
by the same 2-zone strategy. Est: medium — RN has no Tailwind `line-clamp`, so the stem's
2-line clamp needs `numberOfLines={2}` on its own `<Text>` (RN's native equivalent, which
*does* clamp head-first same as web's `line-clamp`, so this ports cleanly) while the anchor
`<Text>` gets no `numberOfLines` prop at all.

**T9 — File the two reported bugs** (§1 unit-label normalization, §2 composed-name-lost).
Not implementation — administrative: add both to the bug registry per this repo's
`bug-registry` skill, cross-referencing this doc. Est: trivial, but don't skip it — that's
the actual deliverable for the "investigate and report" half of the brief.

---

## 11. Test strategy

### 11.1 Viewports and what to assert, per this repo's own established pattern

Following `apps/web/e2e/48-feature-overrides.spec.ts:247` and
`48-lite-locked-route-ux.spec.ts:37`'s existing `{390, 768, 1440}` sweep (already the house
convention per this session's own memory notes on Playwright-proof-for-all-UI):

- **390px:** the row's bounding box never exceeds the viewport width (no horizontal scroll —
  same technique as `08-create-order-escape.spec.ts:306`); the stem clamps to ≤2 lines; the
  anchor is fully visible (assert `textContent` equals the full expected variant string, not
  an ellipsis-truncated substring — this is the actual regression test for the Android
  screenshot's bug); the header's total+count line is visible without scrolling.
- **768px / 1440px:** the same row renders wider (qty/price/total may share one row instead
  of stacking, per §3.3) without visually breaking — screenshot-diffed per this session's
  standing "Playwright proof + impeccable review" rule (independent visual review before
  merge, all three widths, all states).

### 11.2 Specific regression fixtures — must exist in the seed/test data

- **A name long enough to wrap 9 lines at 390px today** (the exact FLYTE product string
  works, or a synthetic equivalent) — asserts row height stays bounded (§3.2's "predictable
  max 5 lines") instead of growing unbounded.
- **Two products whose full names differ only in their last segment** (the Foger Pod
  Strawberry Banana / Strawberry B-Burst pair, or synthetic equivalents) — asserts both
  render distinguishably (different visible anchor text), which is the literal repro for the
  reported "indistinguishable variant" bug.
- **A true catalog variant** (`parentProductId` set, `variantName` populated) ordered and
  then read back — asserts the composed `"<Parent> - <Variant>"` name, not a bare variant
  name (§2's regression test, T5).
- **Many items (≥10)** — asserts the list collapses behind "Show more" (§5.1) rather than
  rendering all rows, and that expanding shows the rest.
- **Missing product image** (`imageKeys: []`) — asserts the fallback icon tile renders with
  no broken-image flash and no layout shift versus a row that does have a thumbnail (same
  40×40 reserved box either way).
- **A line with `deliveredQty < qty`** — asserts the PARTIAL-derived status pill and the
  delivered/remaining line render, and that the numbers match `prorateLineSubtotal`'s
  output if a dollar figure is included (§5.3).
- **Unit-label reproduction, not a fix** (§1) — a Jest/Playwright test that seeds two
  products with `unit: "Box"` and `unit: "box"` and simply *documents* (via a
  `test.fixme`/explicit "known bug" annotation, not a passing assertion) that the row shows
  both, so this doesn't silently regress into "fixed" without anyone deciding to fix it — the
  bug-registry entry (T9) is the actual tracking mechanism, this is just a tripwire.

### 11.3 What Create-order/scan coverage this spec relies on rather than duplicates

Per §6.1's convergence stance, this spec does not re-specify test coverage for the editable
row's qty/price/margin controls — that's `CreateOrderModal.test.tsx` and the scanner spec's
own §9, unchanged by this work except for the `readOnly` prop's presence (which those tests
never set, so they're unaffected). This spec's own new coverage is entirely about the
read-only variant (T4/T6) and the two flows T2/T7 touch.

---

## 12. Summary of file:line citations for implementers

| Area | File:line |
|---|---|
| Web order-detail table | `apps/web/app/(dashboard)/orders/[id]/page.tsx:3009-3131` |
| Web order-detail action bar | `apps/web/app/(dashboard)/orders/[id]/page.tsx:2478-2814` |
| Web per-line status derivation | `apps/web/app/(dashboard)/orders/[id]/page.tsx:1689-1702` |
| RN operator order-detail row | `apps/mobile/app/(operator)/(tabs)/orders/[id].tsx:619-722` |
| RN unit-label bug | `apps/mobile/app/(operator)/(tabs)/orders/[id].tsx:647` |
| RN name truncation bug | `apps/mobile/app/(operator)/(tabs)/orders/[id].tsx:661` |
| CreateOrderModal row (extraction target, per scanner spec) | `apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx:1456-1748` |
| CreateOrderModal post-creation | `apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx:898-991` |
| CreateOrderModal minimize/dismiss | `apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx:760-812` |
| `Product.unit` schema | `apps/api/prisma/schema/catalog.prisma:40` |
| `Product` variant fields | `apps/api/prisma/schema/catalog.prisma:71-72` (`parentProductId`, `variantName`) |
| `create-product.dto.ts` unit field | `apps/api/src/products/dto/create-product.dto.ts:39` |
| `import-products.dto.ts` unit field | `apps/api/src/products/dto/import-products.dto.ts:17` |
| `formatQtySplit` | `packages/pricing/src/pricing.ts:765-781` |
| `computeLineSubtotal` | `packages/pricing/src/pricing.ts:112-129` |
| `normalizeBoxesPieces` | `packages/pricing/src/pricing.ts:48-79` |
| `roundMoney` | `packages/pricing/src/pricing.ts:24-32` |
| `prorateLineSubtotal` | `packages/pricing/src/pricing.ts:164-175+` |
| `displayProductName` | `apps/web/lib/product-display.ts:32-70` |
| `MarginHint` | `apps/web/components/MarginHint.tsx:120-232` |
| `TAP_TARGET` | `packages/ui/src/web/utils.ts:17` |
| Toast action support | `packages/ui/src/web/Toast.tsx:12-25` |
| `useCreateOrder` | `apps/web/lib/api/orders.ts:245-275` |
| Order line-item selects needing widening | `apps/api/src/orders/orders.service.ts:411,648,1233,1548,1864` |
| `OrderItem.product` frontend type | `apps/web/lib/api/orders.ts:126-133` |
| Product image thumbnail resolution (existing, list endpoint) | `apps/api/src/products/products.service.ts:337-341` |
| Image focal-point CSS helper | `apps/web/lib/image-focal.ts:47-49` |
| Buyer-portal delivered/remaining precedent | `apps/web/app/buyer/portal/[seller]/orders/[id]/page.tsx:914-926` |
| `OrderItem.deliveredQty`/`invoicedQty` schema | `apps/api/prisma/schema/sales.prisma:769-773` |
| `BadgeStatus` (`PARTIAL` etc.) | `packages/ui/src/web/Badge.tsx:6-38` |
