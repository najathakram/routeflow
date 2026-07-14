# P5-16a — Mobile buyer catalogue v2 + stock alerts (Notify-me)

## Status

PLANNED — 2026-07-14

## Context

Mobile buyer catalog (`apps/mobile/app/(customer)/(tabs)/catalog.tsx`, 488 lines) is already most of the way to catalogue v2. **Already present — do NOT rebuild:** infinite paging (`useBuyerProductsInfinite`, de-duped by id) + pull-to-refresh + search + category pills (the rail) + favorites + expiring-license bell + promo-aware floating cart bar (`priceCart`/`promoRulesFrom`); inline stepper adds (`ProductCard` add → `qtyRow` stepper, boxed-aware via `cartStore.step`); regulated locks (server hides gated products; `LockedCategoriesTile` at `catalog.tsx:307-333`); SKU/barcode search (server matches name/sku/barcode, `products.service.ts:98-104`); negotiated price (`buyerPrice` server-resolved in `buyer-catalog.service.ts`).

**Gaps this increment closes:** (1) NO stock-alert hooks in `apps/mobile/lib/api/buyer.ts` — web P5-03 hooks (`apps/web/lib/api/buyer.ts:636-675`) have no mobile twin; endpoints shipped (`GET /buyer/stock-alerts`, `POST|DELETE /buyer/products/:productId/stock-alert`, `buyer.controller.ts:880-909`). (2) NO OOS handling on the tile — Add works on OOS. (3) NO deal/new/behavioral chips, live-stock label, struck promo price. (4) NO tile image (server returns `thumbnailUrl`/`imageUrls` presigned).

**Verified facts / assumptions (flagged):**

- The tile is the **inline `ProductCard` in `catalog.tsx:221-292`** — no separate tile component file. All tile work lands in `catalog.tsx`.
- **No push-tap deep-link handler exists** (`_layout.tsx:58` has only a no-op `addNotificationReceivedListener`; NO `addNotificationResponseReceivedListener`/`useLastNotificationResponse` anywhere in `apps/mobile`). Server already sends the restock push `{type:"STOCK_ALERT", productId}` (`stock-alert.service.ts:117-122`). **Deep-link routing is a DEFERRED FOLLOW-UP** (no buyer product-detail screen on mobile) — do NOT build it here.
- Mobile has **no `BuyerProductDetail` type / no `useBuyerProduct(id)` hook** — web's `alertSubscribed` field + `["buyer","product",id]` invalidation have no mobile twin; the tile's subscribed state comes from the `stock-alerts` LIST. Omit.
- Mobile query keys are **dash-style singletons** (`["buyer-products"]`, `["buyer-favorites"]` — `useBuyerSocket.ts:115-130`), NOT web's arrays. New keys: `["buyer-stock-alerts"]`, `["buyer-replenishment"]`.
- Money: all tile prices go through `apps/mobile/lib/pricing.ts` (`applyBestPromotion` + `normalizeBoxesPieces`, byte-mirror of API `common/pricing.ts`) — never ad-hoc `qty*unitPrice`; tile price must equal `priceCart`'s net to the cent (WP3 test).
- RN core `Image` is the established remote-image idiom (`app/(operator)/products/[id].tsx`) — do NOT introduce `expo-image`.

Order: **WP1 → WP3 → WP2 → WP4 → WP5**. Verify: `npm run verify` (turbo: mobile check-types + lint + jest).

## Acceptance

- P10-BUY-2 (P5-02 twin): rich tiles — image, inline stepper (present), deal/new/behavioral chips, live-stock label, negotiated + struck promo price via `lib/pricing.ts`, regulated locks (present), SKU/barcode search (present), category rail (present).
- P10-BUY-3 (P5-03 twin): OOS tile → **Notify me** (`POST /buyer/products/:id/stock-alert`); subscribed → "Notifying ✓" outline; tap again → `DELETE`. Restock push deep-link DEFERRED.
- Boxed/promo math matches web to the cent (tile net/struck = `applyBestPromotion` over `normalizeBoxesPieces` piece counts, identical inputs to cart `priceCart`).
- New pure logic in `lib/` + Jest unit test; no RN render tests.

## Work Packages

### WP1 — Stock-alert + replenishment hooks + catalogue-v2 product fields

files:

- `apps/mobile/lib/api/buyer.ts`

brief: Widen `BuyerProduct` with the shipped v2 DTO fields; add stock-alert + replenishment hooks (reuse shipped endpoints, mobile idiom).

**1a. Replace the `BuyerProduct` interface (`apps/mobile/lib/api/buyer.ts:6-20`) with:**

```ts
export interface BuyerProduct {
  id: string;
  name: string;
  description?: string;
  category?: string;
  unit?: string;
  /** Legacy field — may be absent. Prefer buyerPrice then basePrice. */
  price?: number;
  buyerPrice?: number;
  basePrice?: number;
  imageUrl?: string;
  isFavorite?: boolean;
  /** Box packaging: when > 1 the buyerPrice/basePrice is the BOX price. */
  unitsPerBox?: number | null;
  // Catalogue v2 merch/stock fields (P5-02 DTO; optional so older cached shapes
  // still type-check). Mirrors buyer-catalog.service.ts BuyerProduct.
  sku?: string | null;
  barcode?: string | null;
  thumbnailUrl?: string | null;
  imageUrls?: string[];
  isFeatured?: boolean;
  isNew?: boolean;
  isDeal?: boolean;
  inStock?: boolean;
  stockStatus?: "IN_STOCK" | "LOW" | "OUT_OF_STOCK";
  stockLeft?: number | null;
}
```

**1b. Insert after `useToggleFavorite` (`:326`, before the `// ─── Orders ───` banner):**

```ts
// ─── Stock alerts / Notify-me (P5-03 twin — P5-16a) ───────────────────────────

export interface BuyerStockAlerts {
  productIds: string[];
}

export function useBuyerStockAlerts() {
  return useQuery<BuyerStockAlerts>({
    queryKey: ["buyer-stock-alerts"],
    queryFn: () => buyerApiClient.get("/buyer/stock-alerts").then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useSubscribeStockAlert() {
  const qc = useQueryClient();
  return useMutation<{ subscribed: true }, Error, string>({
    mutationFn: (productId) =>
      buyerApiClient.post(`/buyer/products/${productId}/stock-alert`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer-stock-alerts"] });
      qc.invalidateQueries({ queryKey: ["buyer-products"] });
    },
  });
}

export function useUnsubscribeStockAlert() {
  const qc = useQueryClient();
  return useMutation<{ subscribed: false }, Error, string>({
    mutationFn: (productId) =>
      buyerApiClient.delete(`/buyer/products/${productId}/stock-alert`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer-stock-alerts"] });
      qc.invalidateQueries({ queryKey: ["buyer-products"] });
    },
  });
}

// ─── Replenishment (P5-05 twin — behavioral tile chips) ───────────────────────

export interface ReplenishmentEstimate {
  productId: string;
  name: string;
  unit: string;
  unitsPerBox: number | null;
  imageKey: string | null;
  lastOrderedAt: string;
  orderCount: number;
  cadenceDays: number | null;
  daysSinceLast: number;
  estDaysLeft: number | null;
  typicalQty: number;
  suggestedQty: number;
  state: "low" | "due-soon" | "ok";
}

export function useBuyerReplenishment() {
  return useQuery<ReplenishmentEstimate[]>({
    queryKey: ["buyer-replenishment"],
    queryFn: () => buyerApiClient.get("/buyer/replenishment").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}
```

(No other changes; `useQuery`/`useMutation`/`useQueryClient` are imported at line 1.)

### WP3 — Pure tile-logic helper + unit test

files:

- `apps/mobile/lib/catalog-tile-logic.ts` (new)
- `apps/mobile/__tests__/catalog-tile-logic.test.ts` (new)

brief: All non-trivial tile decisions (notify-vs-add CTA, alert set, promo/struck tile price, chip priority, stock/behavior labels) as pure functions mirroring the web tile helpers; Jest-locked incl. tile↔cart cent parity.

**`apps/mobile/lib/catalog-tile-logic.ts` — EXACT content:**

```ts
/**
 * Catalogue-v2 tile logic (P5-16a) — pure, Jest-tested (no RN imports).
 * Mirrors the web shop tile helpers (tile-pricing.ts + ProductTile.tsx).
 * Money goes through lib/pricing so the tile price matches the cart — and the
 * server bill — to the cent. NEVER recompute prices ad-hoc.
 */
import {
  applyBestPromotion,
  normalizeBoxesPieces,
  type PromotionRule,
  type PromoResult,
} from "./pricing";
import type { BuyerProduct, BuyerStockAlerts, ReplenishmentEstimate } from "./api/buyer";
import type { CartItem } from "../store/cartStore";

export type TileCta = "stepper" | "notify" | "add";

/** In-cart → stepper (even if now OOS); OOS → notify; else → add. */
export function tileCta(product: Pick<BuyerProduct, "stockStatus">, inCartUnits: number): TileCta {
  if (inCartUnits > 0) return "stepper";
  if ((product.stockStatus ?? "IN_STOCK") === "OUT_OF_STOCK") return "notify";
  return "add";
}

export function alertIdSet(alerts: BuyerStockAlerts | undefined): Set<string> {
  return new Set(alerts?.productIds ?? []);
}

/**
 * Tile promo/struck price — MUST equal the cart number for the same product+qty
 * to the cent (same inputs as buyer-cart-pricing.priceCart).
 */
export function deriveTilePrice(
  product: Pick<
    BuyerProduct,
    "id" | "buyerPrice" | "basePrice" | "price" | "category" | "unitsPerBox"
  >,
  promoRules: PromotionRule[],
  cartItem: CartItem | undefined,
): PromoResult {
  const base = Number(product.buyerPrice ?? product.basePrice ?? product.price) || 0;
  const upb = Number(product.unitsPerBox ?? 0);
  const unitsPerBox = cartItem?.unitsPerBox ?? product.unitsPerBox ?? null;
  const qtyPieces = normalizeBoxesPieces({
    boxes: cartItem?.boxes ?? null,
    pieces: cartItem?.pieces ?? null,
    qty: cartItem?.qty ?? (upb > 1 ? upb : 1),
    unitsPerBox,
  }).qty;
  return applyBestPromotion(base, promoRules, {
    productId: product.id,
    category: product.category ?? null,
    qtyPieces,
  });
}

export type TileChipKind = "deal" | "new" | "low" | "featured";
export interface TileChip {
  kind: TileChipKind;
  label: string;
}

/** Priority: Deal > New > Running low > Featured. Only one renders. */
export function computeTileChip(
  product: Pick<BuyerProduct, "isDeal" | "isNew" | "isFeatured">,
  priced: PromoResult,
  estimate?: ReplenishmentEstimate,
): TileChip | null {
  if (priced.originalPrice != null || product.isDeal) {
    let label = "Deal";
    if (priced.originalPrice != null && priced.originalPrice > 0) {
      const percent = Math.round((1 - priced.unitPrice / priced.originalPrice) * 100);
      if (percent > 0) label = `Deal -${percent}%`;
    }
    return { kind: "deal", label };
  }
  if (product.isNew) return { kind: "new", label: "New" };
  if (estimate?.state === "low") return { kind: "low", label: "Running low" };
  if (product.isFeatured) return { kind: "featured", label: "Featured" };
  return null;
}

export function behaviorLabel(est?: ReplenishmentEstimate): string | null {
  if (!est || est.orderCount < 2) return null;
  const c = est.cadenceDays;
  if (c != null) {
    if (c >= 5 && c <= 9) return "You order weekly";
    if (c >= 12 && c <= 18) return "You order biweekly";
    if (c >= 25 && c <= 35) return "You order monthly";
    return `You order every ~${c} days`;
  }
  return `Bought ${est.orderCount}x`;
}

export type StockTone = "ok" | "warn" | "danger";
export interface StockLabelResult {
  label: string;
  tone: StockTone;
}

export function stockLabel(p: Pick<BuyerProduct, "stockStatus" | "stockLeft">): StockLabelResult {
  const status = p.stockStatus ?? "IN_STOCK";
  if (status === "OUT_OF_STOCK") return { label: "Out of stock", tone: "danger" };
  if (status === "LOW")
    return { label: p.stockLeft != null ? `Only ${p.stockLeft} left` : "Low stock", tone: "warn" };
  return { label: "In stock", tone: "ok" };
}
```

**`apps/mobile/__tests__/catalog-tile-logic.test.ts`** — cover: `tileCta` (OOS→notify, in-cart→stepper even if OOS, in-stock/LOW not-in-cart→add, missing→add); `alertIdSet` (undefined→empty, builds set); `deriveTilePrice` (no promo→buyerPrice no struck; fallback buyerPrice→basePrice→price; PERCENT→struck original + net box price; QTY_BREAK boxed default add qty = unitsPerBox pieces satisfies the gate but non-boxed single piece doesn't; **matches `priceCart(...).lines[0].net`/`.original` to the cent for the same cart line**); `computeTileChip` priority (Deal>New>Low>Featured, percent label, plain isDeal, null); `stockLabel`; `behaviorLabel` (cadence buckets + Bought Nx + <2 null). Import `priceCart` from `../lib/buyer-cart-pricing`, `PromotionRule` from `../lib/pricing`, `CartItem` from `../store/cartStore`. (Full test bodies as authored — implement verbatim; the cent-parity assertion is the money anchor.)

### WP2 — Catalog tile: Notify-me toggle + chips + live stock + struck price

files:

- `apps/mobile/app/(customer)/(tabs)/catalog.tsx`

brief: Wire WP1 hooks + WP3 helpers into the screen + inline `ProductCard`; RN parity with web `ProductTile`. Anchors against the 488-line file.

1. **Imports:** add `useBuyerStockAlerts`/`useSubscribeStockAlert`/`useUnsubscribeStockAlert`/`useBuyerReplenishment` + `type ReplenishmentEstimate` to the buyer import; add `import type { PromotionRule } from "../../../lib/pricing";` and `import { alertIdSet, behaviorLabel, computeTileChip, deriveTilePrice, stockLabel, tileCta } from "../../../lib/catalog-tile-logic";`.
2. **Hoist promo rules** (after `useBuyerPromotions`): `const promoRules = useMemo(() => promoRulesFrom(promotions), [promotions]);` and change `cartTotal` to `priceCart(cart, promoRules).subtotal` deps `[cart, promoRules]`.
3. **Screen state** (near favorites/expiring-auth): add `useBuyerStockAlerts` → `alertIds = useMemo(() => alertIdSet(stockAlerts), [stockAlerts])`, `subscribeAlert`/`unsubscribeAlert`, a `toggleStockAlert(productId)` (has→unsubscribe else subscribe); `useBuyerReplenishment` → `estimateByProduct = useMemo(new Map(estimates.map(e => [e.productId, e])), [estimates])`.
4. **renderItem:** pass `promoRules`, `estimate={estimateByProduct.get(item.id)}`, `isAlertSubscribed={alertIds.has(item.id)}`, `onToggleStockAlert={() => toggleStockAlert(item.id)}` to `ProductCard`.
5. **`ProductCard`** (221-292): extend props (`promoRules: PromotionRule[]; estimate?: ReplenishmentEstimate; isAlertSubscribed: boolean; onToggleStockAlert: () => void;`). After `units`: `const priced = deriveTilePrice(product, promoRules, cartItem); const chip = computeTileChip(product, priced, estimate); const behavior = behaviorLabel(estimate); const stock = stockLabel(product); const cta = tileCta(product, units);`. Render: a chip pill above the name when `chip != null`; a meta line (behavior · colored stock.label via a module-level `TONE_COLORS = { ok:"#16A34A", warn:"#B45309", danger:"#DC2626" }`); the price row shows `formatCurrency(priced.unitPrice)` + a struck `formatCurrency(priced.originalPrice)` when non-null (keep `/ {unit}`); the action slot switches on `cta` — `"stepper"`→existing qtyRow, `"add"`→existing addBtn, `"notify"`→a Notify-me Pressable (Ionicons `notifications`/`notifications-outline`; subscribed = transparent + brand border + brand "Notifying ✓"; else solid brand "Notify me"). **`add()` still sends the base selling-unit price (unchanged) — the cart applies promos itself, which is why tile and cart agree.**
6. **Styles:** add `chip`/`chip_deal|new|low|featured`/`chipText`/`metaLine`/`struckPrice`/`notifyBtn`/`notifyBtnSubscribed`/`notifyText`/`notifyTextSubscribed` (per the authored values); wrap net+struck price in a `flexDirection:"row", alignItems:"baseline", gap:6` row.

**Scoped out (already present):** inline stepper, category rail, favorites, regulated locks, SKU/barcode search (server-side), negotiated price (server-resolved).

### WP4 — Tile image (last v2 richness gap)

files:

- `apps/mobile/app/(customer)/(tabs)/catalog.tsx`

brief: Render the product image on the tile (RN core `Image`, project idiom; no dot-pager on mobile). Add `Image` to the RN import; in `ProductCard` compute `const thumb = product.imageUrls?.[0] ?? product.thumbnailUrl ?? null;` and render as the FIRST child (before `productInfo`): `<Image source={{uri:thumb}} style={styles.thumb} resizeMode="cover"/>` or a `cube-outline` placeholder. Styles `thumb: {width:56,height:56,borderRadius:10,alignSelf:"center",flexShrink:0}`, `thumbPlaceholder: {backgroundColor:ios.fill3,alignItems:"center",justifyContent:"center"}`.

### WP5 — Code-map update

files:

- `.claude/code-map/mobile.md`

brief: Add a buyer "Where to find" row for P5-16a (BuyerProduct v2 fields + stock-alert/replenishment hooks + `lib/catalog-tile-logic.ts` pure helpers [tileCta/alertIdSet/deriveTilePrice cent-parity/computeTileChip/behaviorLabel/stockLabel] + the catalog tile changes + the deferred push deep-link); append a P5-16a note to the `catalog.tsx` bullet. Bump `_meta` if the file convention requires it.

---

**Deferred follow-up (out of scope):** push-tap deep-link — add an `addNotificationResponseReceivedListener` in `_layout.tsx` routing `data.type === "STOCK_ALERT"` → `/(customer)/(tabs)/catalog`. Server push already ships.

**Verify:** `npm run verify` (mobile check-types + lint + jest; `catalog-tile-logic.test.ts` must pass).

### Critical Files

- apps/mobile/lib/api/buyer.ts
- apps/mobile/app/(customer)/(tabs)/catalog.tsx
- apps/mobile/lib/catalog-tile-logic.ts (new; mirrors web ProductTile.tsx + tile-pricing.ts)
- apps/mobile/lib/pricing.ts (money source of truth — read-only)
- apps/mobile/**tests**/catalog-tile-logic.test.ts (new)
