# P10-BUY leftovers — Sellers directory + order tracking (mobile buyer `(customer)` role)

## Status

PLANNED — 2026-07-14. Independent — branches from `master`; assumes the regulated + POS mobile
work (P10-REG-A/B/C, P10-POS-A) and P5-16a/b/c (catalogue v2, Your Shelf, buyer payments) are
already merged, per `git log --oneline -5` on `master` at plan time.

## Context — investigation summary

Source: `docs/design-package/PHASE-5-6-10-PLAN.md` §2D (P10 table). The six P10-BUY leftovers
named in the task, with their exact plan-doc rows:

```
| P10-BUY-1  | Your Sellers directory + Connect Seller | mobile | P5 buyer Your-Sellers + connect endpoints | M | Tap switches activeSeller → seller dashboard; connect submits pending link; suspended/pending distinct; empty-state Connect |
| P10-BUY-7  | Buyer cart guardrails + reorder price-review | mobile | P5 cart guardrails + reorder review | M | Below-MOV submits as request; cutoff countdown blocks late; reorder review lists deltas + confirm; standing order past threshold pauses + pushes |
| P10-BUY-8  | Buyer order tracking timeline | mobile | web tracking + route stop events (exists) | M | Timeline w/ timestamps; live section from Socket.IO; Reorder; map placeholder (upgradeable) |
| P10-BUY-9  | Standing orders — full template CRUD | mobile | web buyer templates (exists) — UNBLOCKED | M | Create/edit/delete template; Reorder places; Add-to-cart merges; request-a-template posts |
| P10-BUY-10 | Buyer favorites / quick-reorder | mobile | web buyer favorites (exists) — UNBLOCKED | S | Favoriting persists; quick-reorder adds all to cart in one action |
| P10-BUY-11 | Report an issue (buyer order line) | mobile | web report-issue/returns intake | S | Issue → seller Returns queue; photo required; credit status inline |
```

Per-item investigation (file:line evidence), matched against **actual shipped code**, not just
the plan doc's aspirational "(exists)" annotations — several of those turned out to describe
things that were never actually built on web either:

| #   | Item                                      | Verdict                                                                                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Favorites** (P10-BUY-10)                | **DONE — no work**                                                                                 | `apps/mobile/app/(customer)/favorites.tsx` + `useBuyerFavorites`/`useToggleFavorite` in `apps/mobile/lib/api/buyer.ts` — hearted products, add-to-cart, un-favorite. Fully shipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | **Sellers directory** (P10-BUY-1)         | **GAP → WP1**                                                                                      | Backend fully shipped: `GET /buyer/sellers`, `POST /buyer/sellers/request`, `DELETE /buyer/sellers/:sellerSlug` (`apps/api/src/buyer/buyer.controller.ts:104-139`, backed by `buyer.service.ts` `getSellers`/`requestSeller`/`disconnectSelf`). Web has a full directory (`apps/web/app/buyer/portal/page.tsx`): seller cards, status badges, Connect modal, empty state. **Mobile has none of this** — `apps/mobile/lib/buyer-auth.ts` `getBuyerSellers()`/`setActiveSeller()` are only ever called once, at login time, by `app/(auth)/customer-login.tsx:140-151` (`showSellerPicker` via `OptionPickerSheet`, lines 256-262) — a one-shot picker with no way to switch, connect, or cancel a request once inside the app.                                                                                                                                                                                                                                                             |
| 3   | **Report an issue** (P10-BUY-11)          | **DEFERRED — no backend**                                                                          | Grepped `apps/web/app/buyer` for `report`/`issue`/`dispute` — zero matches (no web UI). `apps/api/src/returns/returns.controller.ts` allows a `CUSTOMER`-role caller (`@Roles(..., UserRole.CUSTOMER)`, lines 17/23/47/83) but is guarded by `JwtAuthGuard` — the **staff/legacy** tenant-JWT system. The buyer portal's `BuyerJwtAuthGuard` issues a structurally different JWT (`type: "BUYER"`, checked in `buyer-auth.ts` `getStoredBuyer()`) that the returns controller never accepts. There is **no buyer-scoped returns/report endpoint anywhere in `buyer.controller.ts`**. `docs/design-package/project/specs/backend-wiring-index.md:14` ties "disputes" to the Buyer-portal row's own note, and `buyer-experience-spec.md:48` is explicit: _"Disputes (from Messages/order lines) become credits on approval"_ — i.e. the intended entry point is the P6 Messaging inbox (`P10-MSG-2`: _"dispute-a-line lands prefilled"_), which is unbuilt. Defer until P6 messaging ships. |
| 4   | **Order tracking** (P10-BUY-8)            | **GAP → WP2**                                                                                      | `apps/api/src/orders/orders.service.ts:3484` `getOrderTracking(orderId, user)` already computes everything needed — driver name, route name, run status, stop position, `stopsAhead`, `estimatedArrivalWindow` — but is wired **only** to the staff-JWT `apps/api/src/orders/orders.controller.ts:173-176` (`GET /orders/:id/tracking`), unreachable by the buyer app's separate JWT. `buyer.controller.ts` has no equivalent. Confirmed **neither UI has live tracking today**: mobile `apps/mobile/app/(customer)/orders/[id].tsx` renders only a status Pill + line items (no timeline, no Reorder); web `apps/web/app/buyer/portal/[seller]/orders/[id]/page.tsx`'s `OrderTimeline` (lines 102-159) is a **static** 5-step bar keyed only off `order.status` — no socket, no driver/ETA, no map. The plan doc's "(exists)" refers to the _staff-side_ endpoint's logic, which is 95% reusable — it just needs a thin buyer-scoped wrapper.                                            |
| 5   | **Cart guardrails** (P10-BUY-7)           | **DEFERRED — not built on web**                                                                    | Read both carts in full: `apps/mobile/app/(customer)/orders/cart.tsx` and `apps/web/app/buyer/portal/[seller]/cart/page.tsx`. Neither implements a minimum-order-value check, a credit-limit pre-check/warning, an explicit out-of-stock block, or a cutoff countdown. The only 409 either one special-cases is `REGULATED_AUTH_REQUIRED` (license gating, already shipped). "Mobile mirrors web" — these guardrails are a **P5 web increment that was never built**, not a shipped surface mobile can mirror. Defer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 6   | **Standing orders full CRUD** (P10-BUY-9) | **DEFERRED (the CRUD slice only)** — list/reorder/pause-resume is DONE, mobile already exceeds web | `buyer.controller.ts:666-731` exposes exactly `GET /buyer/templates` (alias `GET /buyer/standing-orders`), `POST /buyer/templates/:id/reorder`, and `PATCH /buyer/templates/:id` typed `{ isActive?: boolean }` **only** — no `POST` create, no `DELETE`, no free-field `PATCH`, no "request-a-template" route anywhere in the buyer controller. Web's own `apps/web/app/buyer/portal/[seller]/templates/page.tsx` is view + reorder **only** (empty state literally reads _"Your seller hasn't set up any recurring order templates for you yet"_ — templates are seller-authored, buyer read-only by design). Mobile's existing `apps/mobile/app/(customer)/standing-orders.tsx` already has list + reorder + **pause/resume** (`onTogglePause` → `useBuyerUpdateTemplate`), which is **more** than web ships. There is no backend and no web counterpart for create/edit/delete/request — nothing to mirror. No work.                                                                  |

**Net result: two genuine, well-scoped gaps** (sellers directory, order tracking), one already
done, three correctly deferred with no backend/web counterpart to mirror. This plan builds only
the two gaps.

## Scope

**In scope:**

- **WP1 — Buyer Sellers directory.** New mobile-only screens (`sellers.tsx` + `sellers/connect.tsx`)
  over the **already-shipped** `GET/POST/DELETE /buyer/sellers*` endpoints. Zero backend changes.
- **WP2 — Buyer order tracking + Reorder.** One new thin backend endpoint
  (`GET /buyer/orders/:id/tracking`) that reuses `OrdersService.getOrderTracking` verbatim (no new
  business logic, no new model), plus mobile UI: a live-ish tracking card on the order-detail
  screen and a "Reorder" action that recreates a past order's items via the existing
  `POST /buyer/orders`.
- **WP3 — Code map.** Surgical updates to `.claude/code-map/{mobile,api}.md` + `_meta.json`.

**Explicitly out of scope / NOT rebuilt (already shipped, confirmed above):**

- Favorites (`favorites.tsx`, `useBuyerFavorites`/`useToggleFavorite`) — untouched.
- Standing orders list/reorder/pause-resume (`standing-orders.tsx`) — untouched, already ahead of web.

**Deferred (no backend/web counterpart — see table above for the one-line reason each):**

- Report an issue (P10-BUY-11) — needs P6 Messaging's dispute-a-line entry point; no returns
  endpoint reachable by the buyer JWT today.
- Cart guardrails + reorder price-review (P10-BUY-7) — the web cart itself has none of this yet;
  wait for that P5 web increment before mirroring on mobile.
- Standing-orders full CRUD / request-a-template (rest of P10-BUY-9) — no backend surface, and
  templates are seller-authored by design on web; nothing to mirror.

**Known adjacent issue, NOT fixed here (flag only):** `app/(auth)/customer-login.tsx:78-82` and
`:119-123` auto-select a buyer's **sole** seller link regardless of status — a buyer whose only
link is `PENDING_SELLER_APPROVAL` gets signed into the app with a non-ACTIVE `activeSeller`, and
every other `BuyerSellerContextGuard`-protected call will then fail. WP1's new Sellers screen
incidentally becomes the first recovery path for that state (it can show the pending status and
let the buyer cancel/wait), but fixing the login-time auto-select itself is out of scope here.

## New / changed files

| File                                                   | Change                                                                                                                                              | WP       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `apps/mobile/lib/api/buyer.ts`                         | edit — append `useBuyerSellers`/`useRequestSeller`/`useDisconnectSeller`; insert `BuyerOrderTracking`/`useBuyerOrderTracking` after `useBuyerOrder` | WP1, WP2 |
| `apps/mobile/lib/seller-directory-logic.ts`            | new — pure status/action helpers                                                                                                                    | WP1      |
| `apps/mobile/__tests__/seller-directory-logic.test.ts` | new                                                                                                                                                 | WP1      |
| `apps/mobile/app/(customer)/sellers.tsx`               | new — directory screen                                                                                                                              | WP1      |
| `apps/mobile/app/(customer)/sellers/connect.tsx`       | new — Connect Seller form                                                                                                                           | WP1      |
| `apps/mobile/app/(customer)/(tabs)/more.tsx`           | edit — add "Your Sellers" MenuRow                                                                                                                   | WP1      |
| `apps/api/src/buyer/buyer.controller.ts`               | edit — add `GET orders/:id/tracking`                                                                                                                | WP2      |
| `apps/mobile/lib/order-tracking-logic.ts`              | new — pure reorder/timeline helpers                                                                                                                 | WP2      |
| `apps/mobile/__tests__/order-tracking-logic.test.ts`   | new                                                                                                                                                 | WP2      |
| `apps/mobile/app/(customer)/orders/[id].tsx`           | edit — tracking card + Reorder button                                                                                                               | WP2      |
| `apps/mobile/hooks/useBuyerSocket.ts`                  | edit — targeted tracking-query invalidation                                                                                                         | WP2      |
| `.claude/code-map/mobile.md`                           | edit                                                                                                                                                | WP3      |
| `.claude/code-map/api.md`                              | edit                                                                                                                                                | WP3      |
| `.claude/code-map/_meta.json`                          | edit                                                                                                                                                | WP3      |

## Acceptance

1. `npx turbo run check-types lint test --filter=./apps/mobile --filter=./apps/api` passes,
   including the two new Jest suites (pure, RN-free, `ts-jest`/node env, no network).
2. **WP1:** `sellers.tsx` lists every link from `GET /buyer/sellers` with the correct status pill
   (`ACTIVE`→green "Active", `PENDING_SELLER_APPROVAL`→orange "Pending approval",
   `INVITED`→yellow "Invited"); tapping an `ACTIVE` row switches `activeSeller`, clears the local
   cart and the entire React Query cache, and lands on Home scoped to the new tenant;
   `PENDING_SELLER_APPROVAL`/`INVITED` rows show "Cancel request" wired to
   `DELETE /buyer/sellers/:sellerSlug`; zero sellers renders an empty state with a "Connect a
   seller" CTA; `sellers/connect.tsx` posts `POST /buyer/sellers/request` and returns to the list
   on success. Zero backend changes.
3. **WP2:** `GET /buyer/orders/:id/tracking` returns the identical shape the staff endpoint
   returns, scoped to the calling buyer's own order (403 otherwise); the order-detail screen shows
   a 5-step timeline for every non-`DRAFT`/non-`CANCELLED` order, plus driver name / route name /
   "N stops ahead" / ETA window / a map placeholder once `tracking.tracking` is non-null; the
   tracking query polls every 20s while `OUT_FOR_DELIVERY`/`PARTIALLY_DELIVERED` and idles
   otherwise; `useBuyerSocket`'s `order.statusChanged` handler now also invalidates that specific
   order's tracking query by id. "Reorder" (shown once the order has left `DRAFT`/`PENDING`)
   creates a new order via `POST /buyer/orders` carrying the original's non-cancelled lines'
   `productId`/`qty`/`boxes`/`pieces` through **unchanged** — no client-side price/qty derivation,
   the server re-prices and re-runs every guard fresh.
4. Zero new Prisma models or migrations. Zero money math: tracking has no dollar fields; Reorder
   never computes or displays a price, it only carries qty/box/piece counts forward.
5. `.claude/code-map/{mobile,api}.md` + `_meta.json` reflect all of the above.

## Work Packages

### WP1 — Buyer Sellers directory (mobile-only, reuses shipped backend) — EXACT CODE

Files: `apps/mobile/lib/api/buyer.ts` (edit, append), `apps/mobile/lib/seller-directory-logic.ts`
(new), `apps/mobile/__tests__/seller-directory-logic.test.ts` (new),
`apps/mobile/app/(customer)/sellers.tsx` (new), `apps/mobile/app/(customer)/sellers/connect.tsx`
(new), `apps/mobile/app/(customer)/(tabs)/more.tsx` (edit).

**1a. `apps/mobile/lib/api/buyer.ts` — append at the very end of the file (after the existing
`useBuyerCreateChangeRequest` function, the current last block):**

```ts
// ─── Sellers directory (P10-BUY-1) ────────────────────────────────────────────
// Distinct from getBuyerSellers()/setActiveSeller() in ../buyer-auth (the one-off
// calls used at login, before any React Query cache exists) — these are the
// query-cached, in-app-switch equivalents. Same GET /buyer/sellers endpoint;
// zero backend changes anywhere in this section.

export function useBuyerSellers() {
  return useQuery<BuyerSeller[]>({
    queryKey: ["buyer-sellers"],
    queryFn: () => buyerApiClient.get("/buyer/sellers").then((r) => r.data),
  });
}

export function useRequestSeller() {
  const qc = useQueryClient();
  return useMutation<{ message?: string }, Error, { sellerSlug: string; emailAtSeller: string }>({
    mutationFn: (dto) => buyerApiClient.post("/buyer/sellers/request", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["buyer-sellers"] }),
  });
}

/** Also doubles as "cancel request" for a not-yet-approved link — same
 *  endpoint buyer.service.disconnectSelf() handles for any link status, not
 *  just ACTIVE. */
export function useDisconnectSeller() {
  const qc = useQueryClient();
  return useMutation<{ message?: string }, Error, string>({
    mutationFn: (sellerSlug) =>
      buyerApiClient.delete(`/buyer/sellers/${sellerSlug}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["buyer-sellers"] }),
  });
}
```

Also change the top import line from:

```ts
import { buyerApiClient } from "../buyer-auth";
```

to:

```ts
import { buyerApiClient, type BuyerSeller } from "../buyer-auth";
```

(`BuyerSeller` is already exported by `lib/buyer-auth.ts` — reuse it, don't redeclare.)

**1b. `apps/mobile/lib/seller-directory-logic.ts` (new, RN-free, pure):**

```ts
/**
 * Pure helpers for the buyer "Your Sellers" directory (P10-BUY-1). Status
 * classification + action-eligibility only — no network, no math.
 * buyer.service.ts getSellers() only ever returns ACTIVE / INVITED /
 * PENDING_SELLER_APPROVAL links (SUSPENDED/DISCONNECTED are filtered out
 * server-side), so those are the only statuses this needs to classify; the
 * default branch below is a defensive fallback, not a reachable case today.
 */
import type { BuyerSeller } from "./buyer-auth";

export type SellerPillVariant = "green" | "orange" | "yellow" | "gray";

export function sellerStatusPill(status: string): { variant: SellerPillVariant; label: string } {
  switch (status) {
    case "ACTIVE":
      return { variant: "green", label: "Active" };
    case "PENDING_SELLER_APPROVAL":
      return { variant: "orange", label: "Pending approval" };
    case "INVITED":
      return { variant: "yellow", label: "Invited" };
    default:
      return { variant: "gray", label: status };
  }
}

/** Only an ACTIVE link can be switched into. */
export function canOpenSeller(seller: Pick<BuyerSeller, "linkStatus">): boolean {
  return seller.linkStatus === "ACTIVE";
}

/** PENDING/INVITED links show "Cancel request" (DELETE /buyer/sellers/:slug —
 *  the same disconnect endpoint, used pre-activation to withdraw a request). */
export function canCancelRequest(seller: Pick<BuyerSeller, "linkStatus">): boolean {
  return seller.linkStatus === "PENDING_SELLER_APPROVAL" || seller.linkStatus === "INVITED";
}
```

**1c. `apps/mobile/__tests__/seller-directory-logic.test.ts` (new):**

```ts
import { sellerStatusPill, canOpenSeller, canCancelRequest } from "../lib/seller-directory-logic";

describe("sellerStatusPill", () => {
  it("maps ACTIVE to green", () => {
    expect(sellerStatusPill("ACTIVE")).toEqual({ variant: "green", label: "Active" });
  });
  it("maps PENDING_SELLER_APPROVAL to orange", () => {
    expect(sellerStatusPill("PENDING_SELLER_APPROVAL")).toEqual({
      variant: "orange",
      label: "Pending approval",
    });
  });
  it("maps INVITED to yellow", () => {
    expect(sellerStatusPill("INVITED")).toEqual({ variant: "yellow", label: "Invited" });
  });
  it("falls back to gray + the raw status for unknown values", () => {
    expect(sellerStatusPill("SUSPENDED")).toEqual({ variant: "gray", label: "SUSPENDED" });
  });
});

describe("canOpenSeller / canCancelRequest", () => {
  it("only ACTIVE can be opened", () => {
    expect(canOpenSeller({ linkStatus: "ACTIVE" })).toBe(true);
    expect(canOpenSeller({ linkStatus: "PENDING_SELLER_APPROVAL" })).toBe(false);
    expect(canOpenSeller({ linkStatus: "INVITED" })).toBe(false);
  });
  it("PENDING_SELLER_APPROVAL and INVITED can cancel; ACTIVE cannot", () => {
    expect(canCancelRequest({ linkStatus: "PENDING_SELLER_APPROVAL" })).toBe(true);
    expect(canCancelRequest({ linkStatus: "INVITED" })).toBe(true);
    expect(canCancelRequest({ linkStatus: "ACTIVE" })).toBe(false);
  });
});
```

**1d. `apps/mobile/app/(customer)/sellers.tsx` (new). Bare `<Stack>` in
`(customer)/_layout.tsx` auto-registers this — no layout edit needed (same pattern as
`shelf.tsx`/`payments.tsx`):**

```tsx
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useBuyerSellers, useDisconnectSeller } from "../../lib/api/buyer";
import {
  sellerStatusPill,
  canOpenSeller,
  canCancelRequest,
} from "../../lib/seller-directory-logic";
import { useBuyerSessionStore } from "../../lib/buyer-session-store";
import { useCartStore } from "../../store/cartStore";
import { showToast } from "../../lib/toast";
import { confirm } from "../../lib/confirm";
import type { BuyerSeller } from "../../lib/buyer-auth";

export default function SellersScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const { activeSeller, setActiveSeller } = useBuyerSessionStore();
  const { data: sellers, isLoading, refetch, isRefetching } = useBuyerSellers();
  const cancelMut = useDisconnectSeller();

  const onOpen = async (seller: BuyerSeller) => {
    if (seller.tenant.slug === activeSeller?.tenant.slug) {
      router.replace("/(customer)/(tabs)/home");
      return;
    }
    // Switching seller re-points every buyer-scoped request at a different
    // tenant (X-Tenant-Slug header). Clear the local cart (product ids are
    // seller-specific) AND the whole React Query cache — invalidate() alone
    // can still flash stale cross-tenant data during refetch; clear() drops
    // it immediately. Mirrors signOut() in buyer-session-store.ts, which
    // clears the cart for the identical reason.
    await setActiveSeller(seller);
    useCartStore.getState().clear();
    qc.clear();
    router.replace("/(customer)/(tabs)/home");
  };

  const onCancelRequest = (seller: BuyerSeller) =>
    confirm(
      "Cancel request?",
      `Withdraw your connection request to ${seller.tenant.name}?`,
      () =>
        cancelMut.mutate(seller.tenant.slug, {
          onSuccess: () => showToast("Request cancelled"),
          onError: (e: any) => showToast(e?.response?.data?.message ?? "Try again."),
        }),
      { confirmText: "Cancel request", destructive: true },
    );

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Your Sellers"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        trailing={
          <Pressable onPress={() => router.push("/(customer)/sellers/connect")} hitSlop={8}>
            <Ionicons name="add" size={24} color={ios.brand} />
          </Pressable>
        }
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
        contentContainerStyle={{ paddingBottom: 32 }}
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : !sellers || sellers.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="business-outline" size={40} color={ios.label3} />
            <Text style={styles.emptyTitle}>No sellers connected</Text>
            <Text style={styles.emptyText}>
              Connect with a seller to view your orders, invoices, and delivery updates.
            </Text>
            <Pressable
              style={styles.connectBtn}
              onPress={() => router.push("/(customer)/sellers/connect")}
            >
              <Text style={styles.connectBtnText}>Connect a seller</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.list}>
            {sellers.map((seller) => {
              const pill = sellerStatusPill(seller.linkStatus);
              const openable = canOpenSeller(seller);
              const cancellable = canCancelRequest(seller);
              const isCurrent = seller.tenant.slug === activeSeller?.tenant.slug;
              return (
                <Pressable
                  key={seller.linkId}
                  style={[styles.card, isCurrent && styles.cardCurrent]}
                  onPress={openable ? () => onOpen(seller) : undefined}
                  disabled={!openable}
                >
                  <View style={styles.cardTop}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardName} numberOfLines={1}>
                        {seller.tenant.name}
                      </Text>
                      <Text style={styles.cardSub} numberOfLines={1}>
                        as {seller.customer.businessName}
                        {isCurrent ? " · Current" : ""}
                      </Text>
                    </View>
                    <Pill variant={pill.variant} small>
                      {pill.label}
                    </Pill>
                  </View>
                  {openable ? (
                    <View style={styles.cardActionRow}>
                      <Text style={styles.openHint}>Tap to open</Text>
                      <Ionicons name="chevron-forward" size={16} color={ios.label3} />
                    </View>
                  ) : cancellable ? (
                    <Pressable
                      style={styles.cancelBtn}
                      onPress={() => onCancelRequest(seller)}
                      disabled={cancelMut.isPending}
                    >
                      <Text style={styles.cancelBtnText}>Cancel request</Text>
                    </Pressable>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        )}

        {/* "Got an invite link?" hint — mirrors web's empty-state footer copy */}
        <View style={styles.hintCard}>
          <Ionicons name="mail-outline" size={18} color={ios.label3} />
          <View style={{ flex: 1 }}>
            <Text style={styles.hintTitle}>Got an invite link?</Text>
            <Text style={styles.hintText}>
              Check your email — clicking a seller's invite connects you instantly, no approval
              wait.
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 60, alignItems: "center" },
  empty: { padding: 40, alignItems: "center", gap: 10 },
  emptyTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: ios.label, marginTop: 4 },
  emptyText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
  connectBtn: {
    backgroundColor: ios.brand,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
    marginTop: 8,
  },
  connectBtnText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  list: { paddingHorizontal: 16, gap: 10, paddingTop: 12 },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 10 },
  cardCurrent: { borderWidth: 1.5, borderColor: ios.brand },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  cardName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  cardSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  cardActionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 2,
  },
  openHint: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label3 },
  cancelBtn: { alignSelf: "flex-start" },
  cancelBtnText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.redInk },
  hintCard: {
    flexDirection: "row",
    gap: 10,
    marginHorizontal: 16,
    marginTop: 16,
    padding: 14,
    borderRadius: 12,
    backgroundColor: ios.brandWash,
  },
  hintTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label },
  hintText: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
});
```

**1e. `apps/mobile/app/(customer)/sellers/connect.tsx` (new — coexists with `sellers.tsx` as a
nested route, the same file+directory pattern already used by `orders.tsx` +
`orders/[id].tsx`/`orders/cart.tsx`):**

```tsx
import { useState } from "react";
import { useRouter } from "expo-router";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../components/FormSheet";
import { useRequestSeller } from "../../../lib/api/buyer";
import { showToast } from "../../../lib/toast";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ConnectSellerScreen() {
  const router = useRouter();
  const requestMut = useRequestSeller();
  const [sellerSlug, setSellerSlug] = useState("");
  const [emailAtSeller, setEmailAtSeller] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canSubmit = sellerSlug.trim().length > 0 && EMAIL_RE.test(emailAtSeller.trim());

  const onSubmit = () => {
    setError(null);
    requestMut.mutate(
      { sellerSlug: sellerSlug.trim().toLowerCase(), emailAtSeller: emailAtSeller.trim() },
      {
        onSuccess: () => {
          showToast("Connection request sent");
          router.back();
        },
        onError: (e: any) =>
          setError(
            e?.response?.data?.message ??
              "Could not send the connection request. Check the seller code and try again.",
          ),
      },
    );
  };

  return (
    <FormSheet
      title="Connect a Seller"
      submitLabel="Send Request"
      onSubmit={onSubmit}
      submitting={requestMut.isPending}
      submitDisabled={!canSubmit}
    >
      <FormSection>
        <FormField label="Seller company code" hint="Ask your sales rep for their RouteFlow code.">
          <FormTextInput
            value={sellerSlug}
            onChangeText={setSellerSlug}
            placeholder="e.g. acme-foods"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
          />
        </FormField>
        <FormField
          label="Your email at this seller"
          hint="Must match the email on your customer account there — this links your history and negotiated prices."
          error={error ?? undefined}
        >
          <FormTextInput
            value={emailAtSeller}
            onChangeText={setEmailAtSeller}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </FormField>
      </FormSection>
    </FormSheet>
  );
}
```

**1f. `apps/mobile/app/(customer)/(tabs)/more.tsx` — insert as the FIRST row inside the ACCOUNT
group's `<View style={styles.groupCard}>` (before the existing "Invoices" `MenuRow`):**

```tsx
<MenuRow
  icon={<Ionicons name="business-outline" size={16} color={ios.brand} />}
  iconBg={ios.brandWash}
  title="Your Sellers"
  subtitle={activeSeller?.tenant.name}
  onPress={() => router.push("/(customer)/sellers")}
/>
```

### WP2 — Buyer order tracking + Reorder (thin new backend endpoint + mobile UI) — EXACT CODE

Files: `apps/api/src/buyer/buyer.controller.ts` (edit), `apps/mobile/lib/api/buyer.ts` (edit,
different insertion point than WP1 — safe to apply in parallel), `apps/mobile/lib/order-tracking-logic.ts`
(new), `apps/mobile/__tests__/order-tracking-logic.test.ts` (new),
`apps/mobile/app/(customer)/orders/[id].tsx` (edit), `apps/mobile/hooks/useBuyerSocket.ts` (edit).

**2a. `apps/api/src/buyer/buyer.controller.ts` — insert immediately after the existing `getOrder`
method (currently lines 408-415, right before `@Post("orders")` / `createOrder`):**

```ts
@Get("orders/:id/tracking")
@UseGuards(BuyerSellerContextGuard)
@UseInterceptors(BuyerTenantInterceptor)
@ApiHeader({ name: "X-Tenant-Slug", required: true })
@ApiOperation({ summary: "Get live delivery tracking (route/stop/ETA) for an order" })
getOrderTrackingForBuyer(@Param("id") id: string, @CurrentBuyerCustomer() ctx: any) {
  // Reuses the SAME service method + ownership-check shape as the staff-side
  // GET /orders/:id/tracking (orders.controller.ts) — zero new business logic.
  // makePseudoUser(ctx) defaults role: CUSTOMER, matching getOrder() directly
  // above — NOT the role: OPERATOR workaround getTemplates() uses further
  // down. That workaround is specific to OrderTemplatesService's own
  // customerId-based lookup path; getOrderTracking()'s ownership gate is the
  // IDENTICAL userId-based check findOne() already uses for getOrder()'s own
  // ordersService.findOne(id, makePseudoUser(ctx)) call one method up, which
  // buyer order reads already rely on in production. No new risk introduced.
  return this.ordersService.getOrderTracking(id, makePseudoUser(ctx));
}
```

No new imports needed — `OrdersService` is already injected as `this.ordersService`, `UseGuards`/
`UseInterceptors`/`ApiHeader`/`Get`/`Param` are already imported at the top of the file.

**2b. `apps/mobile/lib/api/buyer.ts` — insert between `useBuyerOrder` (ends line 545) and
`useBuyerCreateOrder` (starts line 547):**

```ts
export interface BuyerOrderTracking {
  status: string;
  tracking: {
    runId: string;
    routeName: string | null;
    driverName: string | null;
    runStatus: string;
    stopNumber: number;
    stopStatus: string;
    stopsAhead: number;
    estimatedArrivalWindow: { start: string | null; end: string | null };
  } | null;
}

/** Live-ish: polls while the order can still move. There is no per-stop push
 *  to the buyer socket namespace today — only order.statusChanged is wired
 *  (useBuyerSocket.ts), which covers status transitions but not driver
 *  progress WITHIN a status (stopsAhead ticking down). Paused (no interval)
 *  once DELIVERED/CANCELLED or before dispatch. TanStack v5 function form. */
export function useBuyerOrderTracking(id: string) {
  return useQuery<BuyerOrderTracking>({
    queryKey: ["buyer-order-tracking", id],
    queryFn: () => buyerApiClient.get(`/buyer/orders/${id}/tracking`).then((r) => r.data),
    enabled: !!id,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === "OUT_FOR_DELIVERY" || s === "PARTIALLY_DELIVERED" ? 20_000 : false;
    },
  });
}
```

**2c. `apps/mobile/lib/order-tracking-logic.ts` (new, RN-free, pure):**

```ts
/**
 * Pure helpers for the buyer order-tracking card + Reorder action (P10-BUY-8).
 * No network, no price math — Reorder carries qty/box/piece counts forward
 * UNCHANGED; the server (POST /buyer/orders) re-prices and re-runs every
 * guard fresh, same as any other buyer order create.
 */
import type { BuyerOrder } from "./api/buyer";

export interface ReorderItem {
  productId: string;
  qty: number;
  boxes?: number;
  pieces?: number;
}

/** Non-cancelled, catalog-backed (productId present), positive-qty lines
 *  only. Operator-added "unlisted" lines (no productId) can exist on an
 *  order but can never be reordered through the buyer create path. */
export function buildReorderItems(order: Pick<BuyerOrder, "lineItems">): ReorderItem[] {
  return order.lineItems
    .filter((li) => li.status !== "CANCELLED" && !!li.productId && Number(li.qty) > 0)
    .map((li) => ({
      productId: li.productId,
      qty: Number(li.qty),
      ...(li.boxes != null ? { boxes: li.boxes } : {}),
      ...(li.pieces != null ? { pieces: li.pieces } : {}),
    }));
}

/** Reorder only makes sense once an order has actually been placed — DRAFT/
 *  PENDING orders are still directly editable (see the existing Edit-items
 *  action), so Reorder is hidden there to avoid two competing affordances. */
export function canReorder(order: Pick<BuyerOrder, "status">): boolean {
  return order.status !== "DRAFT" && order.status !== "PENDING";
}

/** Timeline step index for the 5-step bar (mirrors web's buyer-order-detail
 *  STATUS_STEPS). -1 for any status not in the happy path (e.g. CANCELLED —
 *  callers hide the whole tracking section for CANCELLED instead). */
const STATUS_STEPS = [
  "PENDING",
  "CONFIRMED",
  "OUT_FOR_DELIVERY",
  "PARTIALLY_DELIVERED",
  "DELIVERED",
];
export function trackingStepIndex(status: string): number {
  return STATUS_STEPS.indexOf(status);
}
```

**2d. `apps/mobile/__tests__/order-tracking-logic.test.ts` (new):**

```ts
import { buildReorderItems, canReorder, trackingStepIndex } from "../lib/order-tracking-logic";

describe("buildReorderItems", () => {
  it("drops CANCELLED lines and lines with no productId", () => {
    const order = {
      lineItems: [
        { id: "1", productId: "p1", qty: 3, status: "CONFIRMED" },
        { id: "2", productId: "p2", qty: 1, status: "CANCELLED" },
        { id: "3", productId: "", qty: 2, status: "CONFIRMED" },
      ],
    } as any;
    expect(buildReorderItems(order)).toEqual([{ productId: "p1", qty: 3 }]);
  });

  it("carries boxes/pieces through unchanged for boxed lines", () => {
    const order = {
      lineItems: [{ id: "1", productId: "p1", qty: 24, boxes: 2, pieces: 0, status: "DELIVERED" }],
    } as any;
    expect(buildReorderItems(order)).toEqual([{ productId: "p1", qty: 24, boxes: 2, pieces: 0 }]);
  });

  it("drops zero/negative-qty lines", () => {
    const order = {
      lineItems: [{ id: "1", productId: "p1", qty: 0, status: "CONFIRMED" }],
    } as any;
    expect(buildReorderItems(order)).toEqual([]);
  });
});

describe("canReorder", () => {
  it("is false for DRAFT and PENDING, true otherwise", () => {
    expect(canReorder({ status: "DRAFT" })).toBe(false);
    expect(canReorder({ status: "PENDING" })).toBe(false);
    expect(canReorder({ status: "CONFIRMED" })).toBe(true);
    expect(canReorder({ status: "DELIVERED" })).toBe(true);
    expect(canReorder({ status: "CANCELLED" })).toBe(true);
  });
});

describe("trackingStepIndex", () => {
  it("indexes the happy-path statuses in order", () => {
    expect(trackingStepIndex("PENDING")).toBe(0);
    expect(trackingStepIndex("DELIVERED")).toBe(4);
  });
  it("returns -1 for CANCELLED / unknown", () => {
    expect(trackingStepIndex("CANCELLED")).toBe(-1);
  });
});
```

**2e. `apps/mobile/hooks/useBuyerSocket.ts` — replace the `order.statusChanged` handler
(currently lines 114-117):**

```ts
socket.on("order.statusChanged", () => {
  void qc.invalidateQueries({ queryKey: ["buyer-orders"] });
  void qc.invalidateQueries({ queryKey: ["buyer-dashboard"] });
});
```

with:

```ts
socket.on("order.statusChanged", (payload?: { orderId?: string }) => {
  void qc.invalidateQueries({ queryKey: ["buyer-orders"] });
  void qc.invalidateQueries({ queryKey: ["buyer-dashboard"] });
  if (payload?.orderId) {
    void qc.invalidateQueries({ queryKey: ["buyer-order-tracking", payload.orderId] });
  }
});
```

(`OrderStatusChangedPayload` in `apps/api/src/gateways/routeflow.gateway.ts:65-71` already carries
`orderId` — no gateway change needed.)

**2f. `apps/mobile/app/(customer)/orders/[id].tsx` — edits, in order:**

Import block (currently lines 9-23) — add `useBuyerCreateOrder`/`useBuyerOrderTracking` and the
new logic import:

```tsx
import {
  useBuyerOrder,
  useBuyerCancelOrder,
  useBuyerCreateChangeRequest,
  useBuyerCreateOrder,
  useBuyerOrderTracking,
} from "../../../lib/api/buyer";
import {
  orderEditable,
  orderCancellable,
  canRequestChange,
  changeRequestChip,
  describeChangeRequest,
  describeResolution,
} from "../../../lib/shelf-logic";
import {
  buildReorderItems,
  canReorder,
  trackingStepIndex,
} from "../../../lib/order-tracking-logic";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";
```

Inside the component, right after `const createCrMut = useBuyerCreateChangeRequest();` (line 63):

```tsx
const { data: tracking } = useBuyerOrderTracking(id);
const reorderMut = useBuyerCreateOrder();
```

Right after `const canRequest = !canEdit && canRequestChange(order);` (line 110):

```tsx
const canDoReorder = order ? canReorder(order) : false;

const onReorder = () =>
  confirm(
    "Reorder this order?",
    "A new order will be created with the same items.",
    () =>
      reorderMut.mutate(
        { items: buildReorderItems(order!) },
        {
          onSuccess: (newOrder) => {
            showToast("Order created");
            router.push(`/(customer)/orders/${newOrder.id}`);
          },
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        },
      ),
    { confirmText: "Reorder" },
  );
```

Insert a new "Delivery tracking" block right after the closing `</View>` of `headerCard` (line 188) and before the `{/* Line items */}` comment (line 190):

```tsx
{
  /* Delivery tracking */
}
{
  order.status !== "DRAFT" && order.status !== "CANCELLED" ? (
    <>
      <View style={styles.sectionRow}>
        <Text style={styles.sectionTitle}>Delivery tracking</Text>
      </View>
      <View style={styles.trackingCard}>
        <View style={styles.trackingSteps}>
          {["Pending", "Confirmed", "Out for delivery", "Partial", "Delivered"].map(
            (label, idx) => {
              const stepIdx = trackingStepIndex(order.status);
              const done = stepIdx >= idx;
              return (
                <View key={label} style={styles.trackingStep}>
                  <View style={[styles.trackingDot, done && styles.trackingDotDone]} />
                  <Text style={[styles.trackingStepLabel, done && styles.trackingStepLabelDone]}>
                    {label}
                  </Text>
                </View>
              );
            },
          )}
        </View>

        {tracking?.tracking ? (
          <View style={styles.trackingLive}>
            {tracking.tracking.driverName ? (
              <Text style={styles.trackingLine}>Driver: {tracking.tracking.driverName}</Text>
            ) : null}
            {tracking.tracking.runStatus === "IN_PROGRESS" ? (
              <Text style={styles.trackingLine}>
                {tracking.tracking.stopsAhead === 0
                  ? "You're next on the route"
                  : `${tracking.tracking.stopsAhead} stop${tracking.tracking.stopsAhead === 1 ? "" : "s"} ahead of you`}
              </Text>
            ) : null}
            {tracking.tracking.estimatedArrivalWindow.start ? (
              <Text style={styles.trackingLine}>
                Estimated:{" "}
                {new Date(tracking.tracking.estimatedArrivalWindow.start).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}
                {tracking.tracking.estimatedArrivalWindow.end
                  ? ` – ${new Date(tracking.tracking.estimatedArrivalWindow.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                  : ""}
              </Text>
            ) : null}
            <View style={styles.trackingMapPlaceholder}>
              <Ionicons name="map-outline" size={20} color={ios.label3} />
              <Text style={styles.trackingMapText}>Live map coming soon</Text>
            </View>
          </View>
        ) : order.status === "CONFIRMED" ? (
          <Text style={styles.trackingLine}>Not yet on a delivery route.</Text>
        ) : null}
      </View>
    </>
  ) : null;
}
```

Add a "Reorder" button right after the existing `{canCancel ? (...) : null}` block (ends line 255):

```tsx
{
  /* Reorder — places a new order from this one's items (server re-prices) */
}
{
  canDoReorder ? (
    <View style={{ paddingHorizontal: 16, marginTop: 12 }}>
      <Pressable style={styles.editBtn} onPress={onReorder} disabled={reorderMut.isPending}>
        <Text style={styles.editBtnText}>
          {reorderMut.isPending ? "Placing order…" : "Reorder"}
        </Text>
      </Pressable>
    </View>
  ) : null;
}
```

Add to `StyleSheet.create` (anywhere in the existing style object):

```ts
trackingCard: { marginHorizontal: 16, backgroundColor: ios.bgElev, borderRadius: 12, padding: 14, gap: 12 },
trackingSteps: { flexDirection: "row", justifyContent: "space-between" },
trackingStep: { alignItems: "center", flex: 1, gap: 4 },
trackingDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: ios.fill3 },
trackingDotDone: { backgroundColor: ios.brand },
trackingStepLabel: { fontSize: 10, fontFamily: "Inter_500Medium", color: ios.label3, textAlign: "center" },
trackingStepLabelDone: { color: ios.brand },
trackingLive: { gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ios.separator, paddingTop: 10 },
trackingLine: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
trackingMapPlaceholder: { alignItems: "center", justifyContent: "center", gap: 4, paddingVertical: 16, backgroundColor: ios.fill3, borderRadius: 10, marginTop: 4 },
trackingMapText: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label3 },
```

No real map: per the P5/P6/P10 plan doc's G17 ("Static map placeholder first, upgrade to
`react-native-maps` later"), this stays a placeholder — adding `react-native-maps` would need a
native rebuild and is explicitly out of scope for this increment.

### WP3 — Code map (surgical) — BRIEF

Files: `.claude/code-map/mobile.md`, `.claude/code-map/api.md`, `.claude/code-map/_meta.json`.

Brief:

- **mobile.md** — add a new "Where to find" row **"Buyer sellers directory + order tracking
  (P10-BUY-1/8)"**: `sellers.tsx` + `sellers/connect.tsx` (list/switch/connect/cancel-request over
  the shipped `GET/POST/DELETE /buyer/sellers*`; switching clears the cart + `qc.clear()`s the
  whole query cache since caches aren't seller-namespaced) + `lib/seller-directory-logic.ts`
  (`sellerStatusPill`/`canOpenSeller`/`canCancelRequest`) + `useBuyerSellers`/`useRequestSeller`/
  `useDisconnectSeller` in `lib/api/buyer.ts`; and the order-tracking half: `useBuyerOrderTracking`
  (`GET /buyer/orders/:id/tracking` — **new**, thin buyer-scoped wrapper of the pre-existing staff
  `OrdersService.getOrderTracking`, reused verbatim, no new business logic), `lib/order-tracking-logic.ts`
  (`buildReorderItems`/`canReorder`/`trackingStepIndex`), the tracking card + Reorder button on
  `orders/[id].tsx`, and `useBuyerSocket.ts`'s `order.statusChanged` handler now also invalidating
  `["buyer-order-tracking", orderId]`.
- **api.md** — under the `### buyer/` section, append one clause to the existing bullet list
  noting: _"P10-BUY-8: `GET /buyer/orders/:id/tracking` (new) — thin wrapper reusing
  `OrdersService.getOrderTracking` verbatim (same ownership-check shape as `findOne`); no new
  model, no new business logic."_
- **\_meta.json** — bump `mappedSha` to `git rev-parse HEAD --short=8` and `generatedAt` to the
  implementation date, at the time this plan is actually executed (not the plan-authoring date).

## Verify

`npx turbo run check-types lint test --filter=./apps/mobile --filter=./apps/api` (one backend file
touched in WP2; everything else is mobile-only). Mobile cannot be device-tested per the
`preview_start`-bound-to-main-checkout limitation — gate on typecheck + lint + the two new Jest
suites + a careful read-through of WP2's `[id].tsx` diff (the one spot with non-trivial
conditional rendering).

## Critical files

- `apps/mobile/lib/api/buyer.ts` — both WPs touch this file at different, non-overlapping anchors
  (WP1 appends at EOF; WP2 inserts mid-file after `useBuyerOrder`) — safe to apply in either order
  or in parallel, but review the merged diff once both land.
- `apps/api/src/buyer/buyer.controller.ts` (WP2's only backend touch)
- `apps/mobile/app/(customer)/orders/[id].tsx` (WP2's UI)
- `apps/api/src/orders/orders.service.ts:3484` (`getOrderTracking` — read-only reference, reused
  as-is, not modified)
- `apps/web/app/buyer/portal/page.tsx` (read-only reference for WP1's copy/flow)
- `apps/web/app/buyer/portal/[seller]/orders/[id]/page.tsx` (read-only reference for WP2's
  timeline steps)
