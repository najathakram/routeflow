# Buyer shop: adjustable grid density + product detail page

**Date:** 2026-08-20 · **Scale:** standard · **Migrations:** none · **API changes:** none

## Problem (owner's words)

1. "we need to fix the grid view for the customer. they are too big. may be let them adjust the
   size?" — at `https://www.routeflow.info/buyer/portal/affa/shop` the grid caps at
   `xl:grid-cols-4` beside a 210px rail, so on a wide screen each 4:5-image card is enormous.
2. "clicking the item does not open the product page. we need a product page, and go to it when
   the item is selected" — there is NO buyer-facing product detail page. `useBuyerProduct` in
   `apps/web/lib/api/buyer.ts:196` (→ `GET /buyer/products/:id`, returns `BuyerProductDetail`
   with `imageUrls[]`, `variants[]`, `alertSubscribed`, `description`) has ZERO consumers.

## Non-goals

- NO API changes — the detail endpoint exists and is already tenant/link/license-gated.
- NO mobile app changes (web-only; mobile customer shop is a later parity pass).
- NO cart math changes — every displayed price goes through `deriveTilePrice`
  (`shop/_components/tile-pricing.ts`) for cent parity with the cart. Never `qty × unitPrice`.

## Binding contracts (all packages build against these; do not renegotiate)

- **Detail route:** `/buyer/portal/[seller]/shop/[productId]` — file
  `apps/web/app/buyer/portal/[seller]/shop/[productId]/page.tsx` (client component).
- **Density type & storage:** `type ShopDensity = "sm" | "md" | "lg"`, persisted at
  localStorage key `rf:buyer:shop:density`; view mode persisted at `rf:buyer:shop:view`
  (`"grid" | "list"`). Default density **"md"** (one notch denser than today — that IS the fix
  for "too big"; "lg" preserves today's size for buyers who want it). Hydration-safe: state
  initializes to the default and a mount-time `useEffect` reads localStorage (no SSR mismatch).
- **Grid class map** (static full strings — Tailwind cannot see interpolated classes):
  - `lg`: `grid grid-cols-2 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4` (today's)
  - `md`: `grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5`
  - `sm`: `grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7`
- **Test ids (WP3 writes the spec against these; WP1/WP2 MUST emit them):**
  `product-grid` (grid container), `product-tile` (each card), `product-tile-link`
  (the tile's navigation link), `density-toggle` (segmented control container),
  `density-sm` / `density-md` / `density-lg` (its buttons), `product-detail-page`,
  `product-detail-name`, `product-detail-price`, `product-detail-add`.

## WP1 — shop list surface: density control + navigate on select

**Files (only these):**

- `apps/web/app/buyer/portal/[seller]/shop/page.tsx`
- `apps/web/app/buyer/portal/[seller]/shop/_components/ProductTile.tsx`

1. **Density state** per the binding contract. Persist BOTH density and the existing
   `viewMode` (currently resets to "grid" every visit) to their keys on change.
2. **Toolbar control:** next to the existing Grid/List toggle (page.tsx:307-320) add a
   3-button segmented control (same border/rounded styling), visible only when
   `viewMode === "grid"`, with accessible names/titles "Compact" / "Standard" / "Large"
   (`data-testid` per contract). Active button styled like the active view-toggle button.
3. **Grid:** replace the hardcoded class at page.tsx:459 with the class-map lookup; add
   `data-testid="product-grid"`.
4. **Tile size prop:** `ProductTile` gains optional `size?: ShopDensity` (default `"lg"`).
   `"lg"`/`"md"` render exactly today's visuals; ONLY `"sm"` trims: body `p-2`, name
   `text-xs`, price `text-base`, per-unit line `text-[10px]`, hide the behavior label
   ("You order weekly"), favorite button `h-7 w-7`, Add button `px-2 py-1.5` (keep the label —
   "Add" stays tappable and readable). Keep the stock line at every size.
5. **Navigate on select:** wrap the image block and the product name in a Next `Link` to
   `/buyer/portal/${seller}/shop/${product.id}` (`data-testid="product-tile-link"` on the
   link wrapping the image; card root gets `data-testid="product-tile"`).
   - The current image-click cycles photos (ProductTile.tsx:117-119) — REMOVE that; a plain
     image click now navigates. Multi-image cycling stays on the dot pager only, whose
     buttons must `e.preventDefault()` + `e.stopPropagation()` so dots never navigate.
     Same for the favorite button (already stops propagation — add preventDefault since it
     now sits inside the Link).
   - The action row (price + Add/stepper/Notify) stays OUTSIDE any Link — no propagation
     games needed there.
6. **List view rows** (the `viewMode === "list"` branch in page.tsx): image + name become the
   same Link; action buttons untouched.
7. Add-to-cart semantics are UNCHANGED (boxed → `qty = unitsPerBox`, `boxes: 1, pieces: 0`).

## WP2 — buyer product detail page (new files only)

**Files (only these — all NEW):**

- `apps/web/app/buyer/portal/[seller]/shop/[productId]/page.tsx`
- optionally `apps/web/app/buyer/portal/[seller]/shop/[productId]/_components/*.tsx` if the
  page wants splitting (keep it to ≤2 components).

Read-only imports from siblings are expected: `../_components/tile-pricing` (deriveTilePrice),
`../_components/QtyStepper`, `@/lib/image-focal` (objectPositionForUrl), hooks from
`@/lib/api/buyer` (`useBuyerProduct`, `useBuyerPromotions`, `toPromotionRules`, favorites +
stock-alert hooks), and the SAME cart hook `shop/page.tsx` uses (read that file to mirror its
cart wiring exactly — do not invent a second cart path).

Page structure (`data-testid="product-detail-page"`):

1. **Breadcrumb/back:** "← Back to shop" link to `/buyer/portal/${seller}/shop` (router.back()
   is acceptable as an enhancement, but the href must exist for direct-URL visitors).
2. **Gallery:** main image (4:5, `objectPositionForUrl` focal, `object-cover`) + thumbnail
   strip when `imageUrls.length > 1`; Package-icon placeholder when no images.
3. **Info column:** name (`product-detail-name`), sku/barcode line (muted, only if present),
   stock status line (same copy/colors as the tile's `stockText`), price block via
   `deriveTilePrice(product, promoRules, cartItem)` (`product-detail-price`) with
   strikethrough original + "per {unit} ({unitsPerBox}/box)" exactly like the tile, the Deal/
   New/Featured chip logic reused or simplified (a Deal badge when `originalPrice != null`),
   full `description` rendered as paragraphs (`whitespace-pre-line`), favorite toggle.
4. **Action:** if in cart → `QtyStepper`; else if OOS → Notify-me (subscribe/unsubscribe via
   the existing stock-alert hooks, honoring `alertSubscribed` from the detail payload); else →
   "Add to cart" button (`product-detail-add`) with the tile's exact add semantics
   (boxed → 1 box = `unitsPerBox` qty).
5. **Variants section** (only when `variants.length > 0`): read
   `apps/api/src/buyer/buyer-catalog.service.ts` to determine whether variant ids are
   themselves catalog products a buyer can open. If yes → each variant row links to its own
   detail URL; if not → render an informational list (name, sku, price) with no links.
   State the outcome in your deviations note.
6. **States:** loading spinner (match shop's Loader2 pattern); API 404/403 → a "Product not
   available" card with the back link (do NOT leak whether it exists — the endpoint already
   handles gating); generic error card otherwise.
7. Layout: max-w container, 2-column on `md+` (gallery | info), stacked on mobile — follow the
   portal's existing spacing/typography idioms (navy text, surface-border, buyer-500 accents).

## WP3 — e2e coverage + code map

**Files (only these):**

- `apps/web/e2e/17-buyer-shop-density-detail.spec.ts` (NEW)
- `apps/web/playwright.config.ts` (add a project entry — a spec without its own project
  NEVER RUNS in this repo; mirror the `buyer` project's shape, name it `buyer-shop`)
- `.claude/code-map/web.md` + `.claude/code-map/_meta.json` (surgical entries for the density
  control, the new detail route, and the new spec)

Spec (self-contained, mirrors `04-buyer-portal.spec.ts`'s register→invite→accept dance using
`e2e/helpers/auth` so it depends on no pre-existing buyer):

1. Operator on `e2e-routeflow` creates a customer + portal invite; fresh buyer registers and
   accepts (copy the exact working flow from 04 — placeholders there are load-bearing).
2. Shop renders: `product-grid` visible, ≥1 `product-tile`.
3. Density: click `density-sm` → the grid container's class attribute contains `grid-cols-3`;
   reload → still `grid-cols-3` (persistence); click `density-lg` → contains `grid-cols-2`
   and `xl:grid-cols-4`.
4. Detail: click the first `product-tile-link` → URL matches `/shop/[^/]+$`,
   `product-detail-name` and `product-detail-price` visible.
5. Add on detail (`product-detail-add`) → cart badge shows 1. Cart is client-side localStorage
   — no server writes; end by clearing storage (this keeps the tenant-write policy intact).
6. Read-only otherwise; the invite/customer created uses `E2E-`-prefixed names per the
   test-tenant policy (assert against tenant `e2e-routeflow` only).

## Acceptance criteria

1. A buyer can pick Compact/Standard/Large; the choice survives reload and only changes
   column count + (for Compact) tile padding/type scale — no data or pricing differences.
2. Default density is Standard ("md") — denser than today's layout without any user action.
3. Clicking a tile's image or name (grid AND list view) opens
   `/buyer/portal/<seller>/shop/<productId>`; dots/favorite/Add/stepper do NOT navigate.
4. The detail page shows the SAME cent-exact price the tile and cart show (deriveTilePrice),
   including promo strikethrough, and its Add puts exactly what the tile's Add puts in the
   cart (boxed = 1 box).
5. Direct URL visits work (deep link), and gated/unknown products show "Product not
   available" without leaking existence.
6. OOS products offer Notify-me on the detail page, honoring existing subscription state.
7. `npm run verify` green; the new spec has its own Playwright project; code map updated.

## ⚠️ CONCURRENT SESSION IN THIS CHECKOUT (added mid-run)

A separate live session ("developer mode / hide dispatch") is editing this same working tree
RIGHT NOW. Its uncommitted files are OFF-LIMITS — never edit, revert, format, or "fix" them:
`apps/api/scripts/e2e-seed.js`, `apps/api/src/billing/plan-catalog.constants.ts`,
`apps/api/src/tenants/tenants.controller.ts` (+ new `tenants.controller.spec.ts`),
`apps/mobile/app/(auth)/role-picker.tsx`, `apps/mobile/app/_layout.tsx`,
`apps/mobile/components/OperatorTabBar.tsx`, `apps/mobile/lib/operator-tabs.ts`,
`apps/mobile/lib/api/addons.ts`, `apps/web/app/(dashboard)/dashboard/page.tsx`,
`apps/web/app/(dashboard)/layout.tsx`, `apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx`,
`apps/web/components/CommandPalette.tsx`, `apps/web/lib/api/addons.ts`,
`packages/types/index.ts`, `scripts/enable-developer-mode.mjs`.

If `npm run verify` fails with errors originating in THOSE files, that is the other session's
in-progress state — do NOT fix it, do NOT fail your package on it; report it under deviations
and judge your own files by whether YOUR files' diagnostics are clean.
