# P10-POS-A — Mobile POS: cost/margin negotiation floor + at-the-door order adjust

> Branch from `master` (independent of the regulated work on `feat/p5-08b-edit-guards`).
> Scope = **P10-POS-1** (live cost/margin in the sale builder) + **P10-POS-3** (at-the-door
> sheet). **P10-POS-2** (minimize/draft dock) and **P10-POS-4..10** (drive mode, owner-operator
> home, credit-limit/short-pick/failed-delivery/settlement/offline-sync guardrails = "POS-B") are
> **NOT** part of this increment — do not touch them.

## 1. Source acceptance criteria (quoted)

`docs/design-package/PHASE-5-6-10-PLAN.md` §2D, "Blocked on P5/P6 web" table (the plan doc filed
these as blocked when written; investigation below shows the web prerequisites have since
shipped, so this increment is actually unblocked — see §2):

```
| P10-POS-1 | Live cost/margin in sale builder | P10 | mobile | P5 POS cost/margin surfacing | M | Margin recomputes; below-floor red + "Set to floor"; cost tap → lot/bill history; boxed lines never re-derive qty×unitPrice |
| P10-POS-3 | At-the-door sheet (arrived stop) | P10 | mobile | P5/pos at-door flow | M | At-door edits flow to POD in ≤2 taps; Collect payment prefilled; works offline |
```

`docs/design-package/project/specs/pos-cost-roles-spec.md` §1 and §3 (the underlying wiring spec,
"Applies to web AND mobile"):

```
§1 Live surfacing (the negotiation floor):
- Sale builder (web + mobile): under each price input show `cost $X.XX · margin %` recomputed
  as the operator types. Below-cost or below-floor → red state + "Set to floor $Y" one-tap fix +
  "Sell anyway" (logged). Floors: `default_margin_floor` per tenant, overridable per category.
- Tapping the cost opens the cost history (bills/lots behind the number) — same data as
  product detail → Cost History.

§3 At-the-door actions (driver or admin at point of sale):
- On an arrived stop, one sheet offers everything, ≤2 taps deep:
  - Adjust existing order: qty steppers per line, swipe-delete, scan-to-add (price memory
    applies). Total recalculates live. Save & capture POD = one tap → invoice regenerates
    from delivered lines (regulated split rules still apply), buyer instantly gets the updated
    copy, edits land on the order timeline (`edited at delivery — {user}`).
  - New order at door: opens the builder pre-set to this customer; delivering it merges into
    this stop's POD + invoice flow.
  - Collect payment: Record Payment prefilled with the stop's balance (cash/check quick
    modes); posts to AR immediately (or queues offline).
- Guards (credit limit, regulated license, short stock) fire inline with their existing
  one-modal patterns — never a second screen.
```

`docs/design-package/project/specs/mobile-new-features.md` §E ("POS, cost & roles on mobile"):

```
- Live cost/margin under every price field in the mobile sale builder; below-floor turns the
  field red with "Set to floor" one-tap chip; tapping cost opens lot/bill history sheet.
- At-the-door sheet (driver/admin on an arrived stop): qty steppers, swipe-delete,
  scan-to-add, live total, then Save & capture POD — one screen, ≤2 taps. Secondary actions:
  New order at door · Collect payment (prefilled).
```

## 2. What's already shipped — plan ONLY the delta

**Web side (the P10 dependency) is DONE**, contrary to the plan doc's "blocked" filing:

- `apps/web/components/MarginHint.tsx` — full implementation: cost/margin text, below-floor/
  below-cost red state, "Set to floor $Y" button, "Sell anyway" ack, cost-eye conceal toggle,
  tap-to-open `CostHistoryPopover` (portaled). Wired into `apps/web/app/(dashboard)/orders/
_components/CreateOrderModal.tsx:1402` and `apps/web/app/(dashboard)/orders/[id]/page.tsx:621`.
  Backed by `apps/web/lib/api/cost-history.ts` (`useCostHistory`, `GET /analytics/cost-history/
:productId`).
- `apps/web/components/ArrivedStopSheet.tsx` — thin 3-tile navigation dispatcher ("purely a
  navigation dispatcher... does not reimplement any flow" — its own doc comment), wired into
  `apps/web/app/(dashboard)/routes/[id]/page.tsx:374`. Tiles: Adjust order → `/orders/:id`,
  New order at door → `/orders?action=new`, Collect payment → `/finance/payments`.
- **P5-09 post-dispatch change-request engine is shipped and proven**: `apps/api/src/orders/
change-requests.service.ts` + `apps/api/src/orders/orders.service.ts#approveChangeRequestAtStop`
  (line 2632). `POST /orders/:id/change-requests` and `POST /orders/:id/change-requests/:crId/
resolve` both allow `@Roles(OPERATOR, CUSTOMER, DRIVER)` / `@Roles(OPERATOR, DRIVER)`
  respectively (`apps/api/src/orders/orders.controller.ts:214-245`). The resolve handler's own
  comment says it plainly: **"G6: driver-at-stop is the primary authority... office ... may
  resolve only while PENDING"** and `apps/web/app/(dashboard)/orders/[id]/page.tsx:1228`:
  _"P5-11: change-request resolution (office side; driver-at-stop is P10 mobile)."_ — the web
  team explicitly left the driver-creates/self-resolves flow for this mobile increment.
  **Web itself has NO UI to CREATE a change request** (only to resolve buyer-submitted ones) —
  so the at-door "Adjust order" screen below is genuinely new UI, not a mobile mirror of an
  existing web screen; it drives an already-shipped, already-tested API path.

**Mobile side — partial for POS-1, absent for POS-3:**

- `apps/mobile/lib/api/margin.ts` (`useMarginConfig`/`floorForCategory`) and
  `apps/mobile/lib/pricing.ts` (`costPerSellingUnit`/`computeMarginFraction`/
  `priceForMarginFloor`/`classifyMargin`) already mirror the API 1:1 — **`priceForMarginFloor` is
  defined but never called anywhere on mobile.**
- `apps/mobile/components/NewOrderScreen.tsx`'s `CartRow` (~line 1590-1777) already renders: a
  color-coded margin-percent line (unconditional, not role-gated) and a role-gated "Cost eye"
  toggle (`canSeeCost` = OPERATOR/TENANT_ADMIN/DRIVER, line 358-359) showing `$cost · margin%`.
  **Missing: the "Set to floor" one-tap fix, the "Sell anyway" ack, and cost-tap → history.**
- `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx` has **zero** cost/margin code
  (verified — no match for margin/cost anywhere in the file). This is the mobile counterpart of
  web's `orders/[id]/page.tsx` inline editor, which DOES have `MarginHint` wired
  (`page.tsx:621`). The code map's mobile.md row 46 currently (incorrectly) implies both mobile
  screens already have the hint — fix that claim as part of this increment (§5).
- No `apps/mobile/lib/api/cost-history.ts` exists at all.
- `apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx`: the items list is **read-only**
  (checkbox `View`s have no `onPress`); action block only offers Skip stop / Partial return /
  Split into invoices / Complete & collect. **No "Adjust order" and no "New order at door" tile.**
- `apps/mobile/app/(driver)/route/stop/[stopId]/new-order.tsx` **already exists and is fully
  wired** (`NewOrderScreen` pre-set to the stop's customer, `runId`/`stopId` auto-linked) but is
  **orphaned** — grep confirms nothing in the app navigates to it. Reaching it is a one-line fix.
- `apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx` **already satisfies** "Collect
  payment prefilled": `totalForStop(stop)` prefills the amount, `useCompleteWithPayment` posts
  atomically. **No changes needed here.**
- Nothing on mobile creates a `ChangeRequest`. No `apps/mobile/lib/api/change-requests.ts`.
- No swipe-gesture library is used anywhere in the app (`Swipeable`/`react-native-gesture-handler`
  Swipeable — zero real usages). "Swipe-delete" is implemented here as a tap-trash-icon row
  action, the same pattern `NewOrderScreen`'s `CartRow` already uses (`onRemove` + trash icon) —
  a deliberate, documented substitution, not a gap.
- `GET /orders/:id` (used by mobile's existing `useOrder(id)`, **no `@Roles` decorator** = any
  authenticated role including DRIVER) already returns everything the at-door screen needs:
  `lineItems[].deliveredQty/boxes/pieces/status`, `lineItems[].product.{unitsPerBox,averageCost,
category}`, and the order's own `changeRequests[]` — confirmed at `apps/api/src/orders/
orders.service.ts:218-260`. Only mobile's TS types need widening (additive, no new endpoint).
- The global axios response interceptor (`apps/mobile/lib/api-client.ts:119-159`) **already
  auto-queues any non-FormData POST/PATCH/PUT/DELETE when offline** and replays on reconnect —
  the new change-request calls get this "for free," no new offline-queue code needed. **Known,
  explicitly out-of-scope limitation:** unlike the route-completion endpoints, `POST /orders/:id/
change-requests` and its `/resolve` sibling have **no server-side idempotency-key support**
  (grep confirms `saveIdempotencyKey`/`checkIdempotency` exist only in `routes.service.ts`), so a
  queued `create` whose response is lost before the retry could, in principle, create a duplicate
  change request on reconnect. This increment does not add endpoint-side idempotency (that's an
  API change, arguably reasonable but out of scope for a "mobile pure API client" increment) —
  WP2 mitigates defensively (refetch the order's `changeRequests` before building the diff) and
  flags the residual risk explicitly rather than silently accepting it.

**Money math:** WP1's math is 100% pre-existing, already-mirrored `pricing.ts` code
(`priceForMarginFloor` is simply unused, not unwritten). WP2 never computes a persisted price on
the client — `CHANGE_QTY` keeps the line's server-stored `unitPrice` (server recomputes the
subtotal via `computeLineSubtotal`, boxed-safe — see `orders.service.ts:2770-2791`) and
`ADD_ITEM`'s `CreateChangeRequestDto` has **no `unitPrice` field at all**; the server decides the
price at approval. WP2's on-screen "live total" is therefore explicitly a **client-side estimate
only** (existing lines: persisted `unitPrice × new qty` via `computeLineSubtotal`; new scanned
lines: catalog/tier price labelled "Est.") — mirrors `apps/web/lib/change-requests.ts`'s own
documented philosophy: _"Shows NO money on purpose: the price... is decided by the server's
pricing path at approval — previewing a price here would be a second derivation that can drift."_

## 3. New/changed files

| File                                                           | WP   | Change                                                                      |
| -------------------------------------------------------------- | ---- | --------------------------------------------------------------------------- |
| `apps/mobile/lib/api/cost-history.ts`                          | WP1  | NEW — mirrors `apps/web/lib/api/cost-history.ts`                            |
| `apps/mobile/components/CostHistorySheet.tsx`                  | WP1  | NEW — bottom-sheet Modal, mirrors `components/OptionPickerSheet.tsx` chrome |
| `apps/mobile/components/NewOrderScreen.tsx`                    | WP1  | EDIT — `CartRow`/`CartModal`: Set-to-floor + Sell-anyway + cost-tap history |
| `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx` | WP1  | EDIT — add the same margin-hint block per row                               |
| `apps/mobile/__tests__/margin.test.ts`                         | WP1  | NEW — Jest coverage for `pricing.ts` margin helpers (currently untested)    |
| `apps/mobile/lib/api/change-requests.ts`                       | WP2  | NEW — types + `useCreateChangeRequest`/`useResolveChangeRequestAtStop`      |
| `apps/mobile/lib/at-door-diff.ts`                              | WP2  | NEW — pure diff builder, mirrors `lib/order-item-diff.ts` style             |
| `apps/mobile/app/(driver)/route/stop/[stopId]/adjust.tsx`      | WP2  | NEW — the at-door "Adjust order" screen                                     |
| `apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx`       | WP2  | EDIT — add "Adjust order" + "New order at door" tiles                       |
| `apps/mobile/lib/api/orders.ts`                                | WP2  | EDIT — widen `Order`/`OrderItem` types (additive)                           |
| `apps/mobile/__tests__/at-door-diff.test.ts`                   | WP2  | NEW — Jest coverage for `buildAtDoorChangeRequests`                         |
| `.claude/code-map/mobile.md`, `.claude/code-map/_meta.json`    | both | EDIT — surgical map update, see §5                                          |

WP1 and WP2 touch **disjoint file sets** (WP2 does not import from or edit `NewOrderScreen.tsx`;
`adjust.tsx` implements its own tiny stepper component rather than reusing `CartRow`'s
non-exported `CartStepperRow`) — they can be implemented and reviewed in parallel.

---

## 4. WP1 — Live cost/margin negotiation floor (P10-POS-1)

### 4.1 `apps/mobile/lib/api/cost-history.ts` (NEW)

Verbatim mirror of `apps/web/lib/api/cost-history.ts` (same endpoint, same query-key shape — this
is a per-product cache key in the existing `["products", id, ...]` family, not a new top-level
feature, so it intentionally does NOT use the dash-style singleton convention):

```ts
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";

/**
 * Cost history for a product (pos-cost-roles-spec §1) — the bills/lots behind the
 * live cost number. Backed by `GET /analytics/cost-history/:productId`, which
 * returns each PURCHASE / COST_BASIS movement with the running average after it.
 * Mirror of apps/web/lib/api/cost-history.ts.
 */
export interface CostHistoryEntry {
  date: string;
  unitCost: number;
  avgCostAfter: number | null;
  type: string; // StockMovement type — PURCHASE, COST_BASIS, etc.
}

export function useCostHistory(productId: string | null | undefined) {
  return useQuery<CostHistoryEntry[]>({
    queryKey: ["products", productId, "cost-history"],
    queryFn: () => apiClient.get(`/analytics/cost-history/${productId}`).then((r) => r.data),
    enabled: !!productId,
    staleTime: 60_000,
  });
}
```

### 4.2 `apps/mobile/components/CostHistorySheet.tsx` (NEW)

Bottom-sheet `Modal`, structurally mirrors `components/OptionPickerSheet.tsx` (backdrop +
handle + scrollable rows) rather than web's portaled hover popover (no hover on mobile):

```tsx
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  ActivityIndicator,
} from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { useCostHistory } from "../lib/api/cost-history";

function costTypeLabel(type: string): string {
  if (type === "PURCHASE") return "Bill";
  if (type === "COST_BASIS") return "Manual";
  return type.replace(/_/g, " ").toLowerCase();
}

export function CostHistorySheet({
  visible,
  productId,
  onClose,
}: {
  visible: boolean;
  productId: string | null;
  onClose: () => void;
}) {
  const { data: history = [], isLoading } = useCostHistory(visible ? productId : null);
  const recent = [...history].slice(-6).reverse(); // newest first, cap 6 — mirrors web

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={styles.title}>Cost history</Text>
        {isLoading ? (
          <ActivityIndicator color={ios.brand} style={{ marginVertical: 20 }} />
        ) : recent.length === 0 ? (
          <Text style={styles.empty}>No purchase cost history yet.</Text>
        ) : (
          <ScrollView style={{ maxHeight: 360 }} showsVerticalScrollIndicator={false}>
            {recent.map((h, i) => (
              <View key={i} style={styles.row}>
                <Text style={styles.rowDate}>
                  {new Date(h.date).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </Text>
                <Text style={styles.rowType}>{costTypeLabel(h.type)}</Text>
                <Text style={styles.rowCost}>${h.unitCost.toFixed(4)}</Text>
              </View>
            ))}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: {
    backgroundColor: ios.bgElev,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 24,
  },
  handle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: ios.gray[3],
    marginBottom: 12,
  },
  title: { fontSize: 15, fontFamily: "Inter_700Bold", color: ios.label, marginBottom: 10 },
  empty: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, paddingVertical: 16 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  rowDate: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2, width: 60 },
  rowType: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    backgroundColor: ios.fill3,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    textTransform: "uppercase",
  },
  rowCost: {
    marginLeft: "auto",
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
});
```

### 4.3 `apps/mobile/components/NewOrderScreen.tsx` (EDIT)

**a) Lift ack + history state to `CartModal`** (~line 1385-1420, alongside the existing
`open/items/productById/...` props): add two new props threaded from the top-level
`NewOrderScreen` state:

```ts
// New CartModal props
floorAcked: Set<string>;
onSellAnyway: (id: string) => void;
```

In the top-level `NewOrderScreen` component (near the other `useState` calls, ~line 376 where
`marginConfig` is already destructured), add:

```ts
const [floorAcked, setFloorAcked] = useState<Set<string>>(new Set());
```

Pass into `<CartModal ...>` (~line 1334-1360):

```tsx
floorAcked={floorAcked}
onSellAnyway={(id) => setFloorAcked((prev) => new Set(prev).add(id))}
```

**b) Thread down to each `CartRow`** in `CartModal`'s row-map (~line 1492-1510):

```tsx
acked={floorAcked.has(id)}
onSellAnyway={() => onSellAnyway(id)}
```

(add `acked`/`onSellAnyway` to `CartRow`'s prop destructure + type block, ~line 1594-1617.)

**c) In `CartRow`, replace the existing unconditional margin-hint `<Text>` block
(~line 1692-1710) with the full negotiation-floor block** — keep the existing color-coded percent
text, ADD the below-floor action row and make the cost-eye's `$cost` text (when `showCostEye &&
costVisible`) tappable to open history:

```tsx
const [historyOpen, setHistoryOpen] = useState(false);
const floorPrice =
  hasCost && marginClass != null
    ? priceForMarginFloor(pieceCost!, marginFloor, product.unitsPerBox)
    : null;
const below = marginClass === "belowCost" || marginClass === "belowFloor";

{
  /* Live margin hint (unchanged text) */
}
{
  marginFrac != null ? (
    <Text style={[styles.marginHint /* existing color logic, unchanged */]}>
      {/* existing label logic, unchanged */}
    </Text>
  ) : null;
}

{
  /* NEW: below-floor one-tap fix + ack, mirrors web MarginHint */
}
{
  below && !acked && floorPrice != null ? (
    <View style={{ flexDirection: "row", gap: 10, marginTop: 2 }}>
      <Pressable onPress={() => onChangePrice(floorPrice)} style={styles.floorFixBtn}>
        <Text style={styles.floorFixBtnText}>Set to floor ${floorPrice.toFixed(2)}</Text>
      </Pressable>
      <Pressable onPress={onSellAnyway} hitSlop={6}>
        <Text style={styles.sellAnywayText}>Sell anyway</Text>
      </Pressable>
    </View>
  ) : null;
}
```

`import { priceForMarginFloor } from "../lib/pricing";` (add to the existing pricing import at
the top of the file, alongside `classifyMargin`/`computeMarginFraction`/`costPerSellingUnit`).
Add `floorFixBtn`/`floorFixBtnText`/`sellAnywayText` styles matching the existing
`cartPriceWas`/`cartNoteAddText` visual weight (danger-red border/text for the fix chip, subdued
underline for "Sell anyway" — same visual language as web's `MarginHint`).

**d) Make the cost-eye `$cost` text tappable** (~line 1741-1746, inside the existing
`showCostEye && hasCost` block): wrap the `Cost $X.XX` `<Text>` in a `Pressable` that calls
`setHistoryOpen(true)` (only when `product.id` is a real catalog id — it always is here, unlike
unlisted lines which never render `CartRow`), and render `<CostHistorySheet visible={historyOpen}
productId={product.id} onClose={() => setHistoryOpen(false)} />` once at the bottom of `CartRow`'s
returned JSX (import `CostHistorySheet` from `"./CostHistorySheet"`).

### 4.4 `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx` (EDIT)

Add the margin hint to each editable row. Insert **after** the existing price `MoneyTextInput`
block (the one at ~line 943 area handling `li.unitPrice`/discount) and **before** the
boxes/pieces stepper, per row in the row-render function. Add imports:

```ts
import { useMarginConfig, floorForCategory } from "../../../../../lib/api/margin";
import {
  costPerSellingUnit,
  computeMarginFraction,
  priceForMarginFloor,
  classifyMargin,
} from "../../../../../lib/pricing";
```

At the top of the component, alongside `const { data: order, isLoading } = useAdminOrder(id ?? "")`:

```ts
const { data: marginConfig } = useMarginConfig();
const [floorAcked, setFloorAcked] = useState<Set<string>>(new Set());
```

Per row (row key = the draft item's `lineId ?? productId`), compute and render:

```tsx
const product = /* the row's product ref, from useAdminOrder's embedded product OR useProducts lookup */;
const pieceCost = product?.averageCost != null ? toNumber(product.averageCost) : null;
const hasCost = pieceCost != null && Number.isFinite(pieceCost);
const marginFloor = floorForCategory(marginConfig, product?.category);
const marginFrac = hasCost ? computeMarginFraction(effUnit, pieceCost, product?.unitsPerBox) : null;
const marginClass = classifyMargin(marginFrac, marginFloor);
const floorPrice = hasCost && marginClass ? priceForMarginFloor(pieceCost!, marginFloor, product?.unitsPerBox) : null;

{marginFrac != null ? (
  <Text style={[styles.marginHint, /* same red/orange/neutral logic as CartRow */]}>
    {marginClass === "belowCost" ? `Below cost (${Math.round(marginFrac * 100)}%)`
      : marginClass === "belowFloor" ? `Below floor · ${Math.round(marginFrac * 100)}% margin`
      : `${Math.round(marginFrac * 100)}% margin`}
  </Text>
) : null}
{(marginClass === "belowCost" || marginClass === "belowFloor") && !floorAcked.has(rowKey) && floorPrice != null ? (
  <View style={{ flexDirection: "row", gap: 10, marginTop: 2 }}>
    <Pressable onPress={() => setDiscountedPrice(rowKey, floorPrice) /* the row's existing price setter */}>
      <Text style={styles.floorFixBtnText}>Set to floor ${floorPrice.toFixed(2)}</Text>
    </Pressable>
    <Pressable onPress={() => setFloorAcked((p) => new Set(p).add(rowKey))}>
      <Text style={styles.sellAnywayText}>Sell anyway</Text>
    </Pressable>
  </View>
) : null}
```

**Known, deliberate divergence:** `useAdminOrder`'s embedded `product` (see `lib/api/admin.ts`)
only carries `averageCost` (server's `orders.service.ts#findOne` product `select` does not
include `standardCost`, unlike the separate `/products` list `NewOrderScreen` reads from) — so
this screen's `hasCost` gate is `averageCost != null` only, no `standardCost` fallback. Products
with no average cost yet (never sold) simply show no hint, same graceful "hides when unknown"
behavior the spec and `NewOrderScreen` already use for `unitCost == null`. Do **not** widen the
API `select` for this — it's out of scope for a mobile-only increment; note it as a tiny,
optional, additive follow-up (`orders.service.ts:247`, add `standardCost: true` next to
`averageCost: true`) if full parity is later wanted.

Also widen `AdminOrder.lineItems[].product` in `apps/mobile/lib/api/admin.ts` (~line 162-168,
additive, matches what the server already returns):

```ts
product?: {
  id?: string;
  name: string;
  unit: string;
  unitsPerBox?: number | null;
  pricePerUnit?: number | string;
  averageCost?: number | string | null; // NEW
  category?: string | null; // NEW
};
```

### 4.5 `apps/mobile/__tests__/margin.test.ts` (NEW)

Port the 5 existing API-side cases from `apps/api/src/common/pricing.spec.ts` (`describe("margin
helpers"...)`, lines 156-192) against `apps/mobile/lib/pricing.ts` — same inputs, same expected
outputs (both are hand-mirrors of the same formulas, this is a cross-mirror regression guard):

```ts
import {
  costPerSellingUnit,
  computeMarginFraction,
  priceForMarginFloor,
  classifyMargin,
} from "../lib/pricing";

describe("margin helpers (mirrors apps/api/src/common/pricing.spec.ts)", () => {
  it("costPerSellingUnit scales piece cost to the box for boxed products", () => {
    expect(costPerSellingUnit(0.58, 24)).toBeCloseTo(13.92, 5);
    expect(costPerSellingUnit(0.58, 1)).toBe(0.58);
    expect(costPerSellingUnit(0.58, null)).toBe(0.58);
  });

  it("computeMarginFraction uses box-basis cost vs box price", () => {
    const m = computeMarginFraction(21.6, 0.58, 24);
    expect(m! * 100).toBeCloseTo(35.56, 1);
  });

  it("computeMarginFraction is negative below cost and null without cost/price", () => {
    expect(computeMarginFraction(10, 8, 1)! * 100).toBeCloseTo(20, 5);
    expect(computeMarginFraction(5, 8, 1)).toBeLessThan(0);
    expect(computeMarginFraction(10, null, 1)).toBeNull();
    expect(computeMarginFraction(0, 8, 1)).toBeNull();
  });

  it("priceForMarginFloor yields exactly the floor margin (round-trip)", () => {
    const price = priceForMarginFloor(0.58, 0.2, 24);
    const m = computeMarginFraction(price, 0.58, 24)!;
    expect(m).toBeCloseTo(0.2, 2);
    expect(priceForMarginFloor(8, 0.25, 1)).toBe(10.67);
  });

  it("classifyMargin buckets below-cost / below-floor / warn / ok", () => {
    const floor = 0.15;
    expect(classifyMargin(-0.05, floor)).toBe("belowCost");
    expect(classifyMargin(0.1, floor)).toBe("belowFloor");
    expect(classifyMargin(0.17, floor)).toBe("warn");
    expect(classifyMargin(0.3, floor)).toBe("ok");
    expect(classifyMargin(null, floor)).toBeNull();
  });
});
```

### 4.6 WP1 acceptance criteria

- [ ] `NewOrderScreen` cart rows: margin recomputes live as price/qty change (pre-existing,
      unchanged); below-floor/below-cost line turns red **and shows "Set to floor $Y"** which
      one-tap-fills the price input; "Sell anyway" acks and hides the fix row for that line only.
- [ ] Tapping the revealed `$cost` text opens `CostHistorySheet` with the product's last 6
      PURCHASE/COST_BASIS movements, newest first — matches web's `CostHistoryPopover` data/order.
- [ ] `edit-items.tsx` rows show the same margin hint + Set-to-floor/Sell-anyway (new — this
      screen had none before).
- [ ] Boxed lines never re-derive `qty × unitPrice` — cost/margin math routes through
      `costPerSellingUnit`/`computeMarginFraction` exactly as before; line totals still go through
      `computeLineSubtotal`. No change to money-write paths (display-only feature).
- [ ] `npx jest --selectProjects mobile __tests__/margin.test.ts` passes.

---

## 5. WP2 — At-the-door adjust order (P10-POS-3)

### 5.1 `apps/mobile/lib/api/change-requests.ts` (NEW)

Types mirror `apps/web/lib/change-requests.ts` exactly (server contract); mutations are new
(web has none — see §2). No new query-list key is introduced (mutations only); invalidation
targets the existing `["orders", orderId]` key from `lib/api/orders.ts`.

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export type ChangeRequestType = "ADD_ITEM" | "CHANGE_QTY" | "REMOVE_ITEM" | "NOTE";
export type ChangeRequestStatus = "PENDING" | "APPROVED" | "DECLINED";
export type ChangeRequestResolution = "MERGED_AT_STOP" | "NEXT_DELIVERY" | "DECLINED";

/**
 * Post-dispatch change requests (P5-09 engine). Mirrors apps/web/lib/change-requests.ts'
 * server-contract types. Mobile adds the mutations web never needed: the driver-at-stop
 * flow CREATES a request and immediately self-resolves it (G6: "driver-at-stop is the
 * primary authority" — apps/api/src/orders/change-requests.service.ts:33-34).
 */
export interface ChangeRequest {
  id: string;
  orderId: string;
  orderItemId: string | null;
  productId: string | null;
  type: ChangeRequestType;
  status: ChangeRequestStatus;
  payload: {
    productId?: string;
    qty?: number;
    boxes?: number | null;
    pieces?: number | null;
    productName?: string;
    orderItemId?: string;
    newQty?: number;
    text?: string;
  };
  note: string | null;
  resolution: ChangeRequestResolution | null;
  resolvedAt: string | null;
  createdAt: string;
}

/** Mirrors apps/api/src/orders/dto/create-change-request.dto.ts exactly. */
export interface CreateChangeRequestInput {
  type: ChangeRequestType;
  orderItemId?: string;
  productId?: string;
  /** ADD_ITEM: qty to add. CHANGE_QTY: the NEW absolute qty (not a delta). */
  qty?: number;
  boxes?: number;
  pieces?: number;
  note?: string;
}

export function useCreateChangeRequest(orderId: string) {
  return useMutation<ChangeRequest, Error, CreateChangeRequestInput>({
    mutationFn: (dto) =>
      apiClient.post(`/orders/${orderId}/change-requests`, dto).then((r) => r.data),
  });
}

/**
 * Self-resolve at the stop. Always sends action=APPROVE_AT_STOP — this file has no UI
 * for APPROVE_NEXT_DELIVERY/DECLINE (that's the office/buyer-facing resolve flow, already
 * covered by web's P5-11; out of scope here).
 */
export function useResolveChangeRequestAtStop(orderId: string) {
  const qc = useQueryClient();
  return useMutation<ChangeRequest, Error, { crId: string }>({
    mutationFn: ({ crId }) =>
      apiClient
        .post(`/orders/${orderId}/change-requests/${crId}/resolve`, { action: "APPROVE_AT_STOP" })
        .then((r) => r.data),
    onSettled: () => qc.invalidateQueries({ queryKey: ["orders", orderId] }),
  });
}
```

### 5.2 `apps/mobile/lib/at-door-diff.ts` (NEW, pure logic)

Mirrors the structure/spirit of `lib/order-item-diff.ts` (diff original vs. edited state → a
minimal set of server-bound operations), targeting `CreateChangeRequestInput[]` instead of a
PATCH-items payload:

```ts
import type { CreateChangeRequestInput } from "./api/change-requests";

const EPS = 0.0001;

export interface AtDoorOriginalLine {
  id: string;
  qty: number;
  status: string;
  /** Lines already (partially) delivered are never adjustable — server 409s (LINE_ALREADY_DELIVERED). */
  deliveredQty?: number;
}

/** One entry per line the driver actually touched (untouched lines are simply absent). */
export interface AtDoorEditedLine {
  lineId: string;
  qty: number;
}

export interface AtDoorAddedLine {
  productId: string;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
}

/**
 * Build the minimal set of change-request creations for an at-door adjustment.
 * - Untouched original lines → nothing.
 * - Edited qty → 0 → REMOVE_ITEM.
 * - Edited qty → any other changed value → CHANGE_QTY (newQty is ABSOLUTE, not a delta).
 * - Already-delivered/cancelled originals are skipped even if present in `edited` (defensive —
 *   the adjust screen should never offer a stepper for them, this is belt-and-suspenders).
 * - New scanned products → ADD_ITEM.
 */
export function buildAtDoorChangeRequests(args: {
  originals: AtDoorOriginalLine[];
  edited: AtDoorEditedLine[];
  added: AtDoorAddedLine[];
}): CreateChangeRequestInput[] {
  const { originals, edited, added } = args;
  const byId = new Map(originals.map((o) => [o.id, o]));
  const out: CreateChangeRequestInput[] = [];

  for (const e of edited) {
    const orig = byId.get(e.lineId);
    if (!orig) continue;
    if (orig.status === "CANCELLED") continue;
    if (Number(orig.deliveredQty ?? 0) > 0) continue;
    if (Math.abs(e.qty - orig.qty) < EPS) continue; // no real change
    if (e.qty <= 0) {
      out.push({ type: "REMOVE_ITEM", orderItemId: orig.id });
    } else {
      out.push({ type: "CHANGE_QTY", orderItemId: orig.id, qty: e.qty });
    }
  }

  for (const a of added) {
    if (a.qty <= 0) continue;
    out.push({
      type: "ADD_ITEM",
      productId: a.productId,
      qty: a.qty,
      ...(a.boxes != null ? { boxes: a.boxes } : {}),
      ...(a.pieces != null ? { pieces: a.pieces } : {}),
    });
  }

  return out;
}
```

### 5.3 `apps/mobile/lib/api/orders.ts` (EDIT — widen types, additive only)

`OrderItem` (~line 6-27): add `deliveredQty` and widen `product`:

```ts
export interface OrderItem {
  id: string;
  productId: string | null;
  name?: string | null;
  product?: {
    id: string;
    name: string;
    unit: string;
    unitsPerBox?: number | null; // NEW
    averageCost?: number | string | null; // NEW
    category?: string | null; // NEW
  };
  qty: number;
  unitPrice: number;
  originalPrice?: number | null;
  priceType?: string;
  subtotal?: number;
  boxes?: number | null;
  pieces?: number | null;
  invoicedQty?: number;
  deliveredQty?: number; // NEW — gates at-door adjustability (server: LINE_ALREADY_DELIVERED)
  status: string;
}
```

`Order` (~line 38-56): add `changeRequests` and `editWindow` (both already returned by the
server, see §2):

```ts
import type { ChangeRequest } from "./change-requests"; // add import

export interface Order {
  // ...existing fields unchanged...
  changeRequests?: ChangeRequest[]; // NEW
  editWindow?: { editable: boolean; editableUntil: string | null; closedReason: string | null }; // NEW
}
```

(`useOrder(id)` itself, ~line 143-149, is unchanged — it already fetches `GET /orders/:id`.)

### 5.4 `apps/mobile/app/(driver)/route/stop/[stopId]/adjust.tsx` (NEW)

Structure mirrors the sibling `new-order.tsx`/`payment.tsx` (same param resolution: `stopId` +
optional `runId` → `useActiveRouteRun`/`useRouteRun` → find the stop → `stop.orders?.[0]`, the
same "primary order" simplification `ArrivedStopSheet` uses on web). Operates on the stop's
**primary order only** — same documented simplification as web.

Key pieces (illustrative — the pipeline should follow existing screen conventions for exact
styling/layout, e.g. `NavBar`/`ListGroup` from `@routeflow/ui/mobile/ios`):

```tsx
import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useActiveRouteRun, useRouteRun } from "../../../../../lib/api/routes";
import { useOrder } from "../../../../../lib/api/orders";
import {
  useCreateChangeRequest,
  useResolveChangeRequestAtStop,
  type CreateChangeRequestInput,
} from "../../../../../lib/api/change-requests";
import {
  buildAtDoorChangeRequests,
  type AtDoorEditedLine,
  type AtDoorAddedLine,
} from "../../../../../lib/at-door-diff";
import { computeLineSubtotal, normalizeBoxesPieces } from "../../../../../lib/pricing";
import { sanitizeIntInput, parseIntQty } from "../../../../../lib/qty";
import { resolveProductByCode } from "../../../../../lib/barcode-resolve";
import { BarcodeFab } from "../../../../../components/BarcodeFab";
import { LicenseGuardModal } from "../../../../../components/LicenseGuardModal";
import {
  parseRegulatedAuthError,
  type BlockedCategory,
} from "../../../../../lib/api/authorizations";
import { showToast } from "../../../../../lib/toast";

export default function AdjustOrderScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ stopId: string; runId?: string }>();
  const { data: activeData } = useActiveRouteRun();
  const runId = params.runId ?? activeData?.data?.[0]?.id;
  const { data: run, isLoading: runLoading } = useRouteRun(runId ?? "");
  const stop = useMemo(() => run?.stops?.find((s) => s.id === params.stopId), [run, params.stopId]);
  const orderId = stop?.orders?.[0]?.id;
  const { data: order, isLoading: orderLoading } = useOrder(orderId ?? "");

  // Adjustable = not cancelled, not already (partially) delivered.
  const adjustable = useMemo(
    () =>
      (order?.lineItems ?? []).filter(
        (li) => li.status !== "CANCELLED" && Number(li.deliveredQty ?? 0) === 0,
      ),
    [order],
  );

  const [qtyById, setQtyById] = useState<Record<string, number>>({});
  const [added, setAdded] = useState<AtDoorAddedLine[]>([]);
  const qtyFor = (li: (typeof adjustable)[number]) => qtyById[li.id] ?? li.qty;

  // Live ESTIMATE only — persisted unitPrice, never re-derived (boxed-safe via computeLineSubtotal).
  const estimatedTotal = useMemo(() => {
    let sum = 0;
    for (const li of adjustable) {
      const qty = qtyFor(li);
      if (qty <= 0) continue;
      const upb = li.product?.unitsPerBox ?? null;
      const split =
        upb && upb > 1
          ? normalizeBoxesPieces({ qty, unitsPerBox: upb })
          : { boxes: null, pieces: null };
      sum += computeLineSubtotal({
        unitPrice: li.unitPrice,
        qty,
        boxes: split.boxes,
        pieces: split.pieces,
        unitsPerBox: upb,
      });
    }
    // added lines are priced by the SERVER at approval — this is a labelled estimate only.
    return sum;
  }, [adjustable, qtyById]);

  const createCr = useCreateChangeRequest(orderId ?? "");
  const resolveCr = useResolveChangeRequestAtStop(orderId ?? "");
  const [saving, setSaving] = useState(false);
  const [licenseBlock, setLicenseBlock] = useState<BlockedCategory[] | null>(null);
  const retryRef = useRef<CreateChangeRequestInput | null>(null);

  async function submitEntry(entry: CreateChangeRequestInput): Promise<boolean> {
    try {
      const cr = await createCr.mutateAsync(entry);
      await resolveCr.mutateAsync({ crId: cr.id });
      return true;
    } catch (e: any) {
      const blocked = parseRegulatedAuthError(e);
      if (blocked) {
        retryRef.current = entry;
        setLicenseBlock(blocked);
        return false;
      }
      const code = e?.response?.data?.code;
      if (code === "CHANGE_REQUEST_ALREADY_RESOLVED") {
        showToast("That line changed elsewhere — refreshed.");
        return true; // don't block the rest of the batch on a benign race
      }
      // LINE_ALREADY_DELIVERED / STOP_ALREADY_COMPLETED / CHANGE_WINDOW_CLOSED / generic —
      // mirrors web's handleResolve: surface the server message, stop the batch.
      showToast(e?.response?.data?.message ?? e?.message ?? "Couldn't save that change.");
      return false;
    }
  }

  async function handleSave() {
    const diff = buildAtDoorChangeRequests({
      originals: adjustable.map((li) => ({
        id: li.id,
        qty: li.qty,
        status: li.status,
        deliveredQty: li.deliveredQty,
      })),
      edited: Object.entries(qtyById).map(([lineId, qty]): AtDoorEditedLine => ({ lineId, qty })),
      added,
    });
    if (diff.length === 0) {
      router.back();
      return;
    }
    setSaving(true);
    for (const entry of diff) {
      const ok = await submitEntry(entry);
      if (!ok) {
        setSaving(false);
        return;
      }
    }
    setSaving(false);
    showToast("Order updated");
    router.back();
  }

  // ... barcode scan handler: resolveProductByCode(code) → setAdded((p) => [...p, {productId, qty:1, ...}])
  // ... render: NavBar, per-line stepper rows (boxed: boxes+pieces sub-steppers via
  //     normalizeBoxesPieces seeded from li.boxes/li.pieces; non-boxed: single qty stepper;
  //     each row has a trash Pressable calling setQtyById(id, 0) — the "swipe-delete" substitute),
  //     added-rows list (name via a local product cache from the scan lookup + trash to remove
  //     from `added` before submit), estimated-total footer, BarcodeFab, Save button (disabled
  //     while saving), LicenseGuardModal wired to retryRef/onResolved re-calling submitEntry then
  //     handleSave (mirrors NewOrderScreen's licenseRetryRef pattern at NewOrderScreen.tsx:1298-1323).

  if (runLoading || orderLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Adjust order"
          leading={<NavBackButton label="Stop" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Adjust order"
        leading={<NavBackButton label="Stop" onPress={() => router.back()} />}
      />
      {/* ...rows + total + Save, per above... */}
      <LicenseGuardModal
        open={!!licenseBlock}
        customerId={(order as any)?.customer?.id ?? ""}
        blocked={licenseBlock ?? []}
        onResolved={async () => {
          const entry = retryRef.current;
          setLicenseBlock(null);
          if (entry && (await submitEntry(entry))) handleSave();
        }}
        onClose={() => setLicenseBlock(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
```

No `_layout.tsx` edit needed — `route/stop/[stopId]/_layout.tsx` is a bare `<Stack>` that
auto-registers every sibling file (same as `photo.tsx`/`signature.tsx`/`new-order.tsx`).

**Scope notes (explicit, not silent cuts):**

- "Swipe-delete" → tap-trash-icon (no gesture library in the codebase; matches
  `NewOrderScreen.CartRow`'s existing remove pattern).
- No cost/margin hint on this screen — `pos-cost-roles-spec` §3 (at-door) does not mention
  cost/margin (that's §1, WP1's "sale builder" scope); keeping this screen qty-only reduces risk
  and keeps WP1/WP2 disjoint.
- Multi-order stops use only `stop.orders[0]` (mirrors web `ArrivedStopSheet`'s `primaryOrder`).
- Offline: covered for free by the existing global interceptor; the idempotency gap noted in §2
  is accepted, not solved, here — before building the diff, `handleSave` should `refetch()` the
  order (via TanStack Query's refetch) so a change already applied by a previous, response-lost
  attempt doesn't get re-diffed and re-submitted. Add this refetch as the first line of
  `handleSave` in the actual implementation.

### 5.5 `apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx` (EDIT)

In `actionsBlock` (~line 325-356), add two tiles above the existing "Split into invoices…" /
"Complete & collect →" — reachable in exactly one tap from the stop screen (satisfies "≤2 taps
deep" together with the destination screen's own Save):

```tsx
{
  items.length > 0 ? (
    <SecondaryBtn
      label="Adjust order"
      onPress={() => router.push(`/route/stop/${stopId}/adjust`)}
    />
  ) : null;
}
<SecondaryBtn
  label="New order at door"
  onPress={() => router.push(`/route/stop/${stopId}/new-order`)}
/>;
```

Place them as a new `actionBtnRow` (or extend the existing one with "Skip stop"/"Partial return")
per the existing 2-per-row `SecondaryBtn` layout — exact placement is a layout call for the
pipeline, but both must be reachable without scrolling past the item list. "Collect payment"
needs **no new tile** — the existing green "Complete & collect →" button already is the prefilled
collect-payment action (§2); do not duplicate it.

### 5.6 `apps/mobile/__tests__/at-door-diff.test.ts` (NEW)

```ts
import { buildAtDoorChangeRequests } from "../lib/at-door-diff";

describe("buildAtDoorChangeRequests", () => {
  const originals = [
    { id: "li-1", qty: 10, status: "PENDING" },
    { id: "li-2", qty: 5, status: "PENDING" },
    { id: "li-3", qty: 4, status: "PENDING", deliveredQty: 4 }, // already delivered
    { id: "li-4", qty: 2, status: "CANCELLED" },
  ];

  it("emits CHANGE_QTY only for lines whose qty actually changed", () => {
    const out = buildAtDoorChangeRequests({
      originals,
      edited: [
        { lineId: "li-1", qty: 8 },
        { lineId: "li-2", qty: 5 },
      ], // li-2 unchanged
      added: [],
    });
    expect(out).toEqual([{ type: "CHANGE_QTY", orderItemId: "li-1", qty: 8 }]);
  });

  it("emits REMOVE_ITEM when qty is zeroed", () => {
    const out = buildAtDoorChangeRequests({
      originals,
      edited: [{ lineId: "li-1", qty: 0 }],
      added: [],
    });
    expect(out).toEqual([{ type: "REMOVE_ITEM", orderItemId: "li-1" }]);
  });

  it("never touches already-delivered or cancelled lines even if present in edited", () => {
    const out = buildAtDoorChangeRequests({
      originals,
      edited: [
        { lineId: "li-3", qty: 1 },
        { lineId: "li-4", qty: 1 },
      ],
      added: [],
    });
    expect(out).toEqual([]);
  });

  it("emits ADD_ITEM for scanned products, boxes/pieces only when present", () => {
    const out = buildAtDoorChangeRequests({
      originals: [],
      edited: [],
      added: [
        { productId: "p-1", qty: 3 },
        { productId: "p-2", qty: 26, boxes: 2, pieces: 2 },
      ],
    });
    expect(out).toEqual([
      { type: "ADD_ITEM", productId: "p-1", qty: 3 },
      { type: "ADD_ITEM", productId: "p-2", qty: 26, boxes: 2, pieces: 2 },
    ]);
  });

  it("returns [] for a no-op diff", () => {
    expect(buildAtDoorChangeRequests({ originals, edited: [], added: [] })).toEqual([]);
  });
});
```

### 5.7 WP2 acceptance criteria

- [ ] From the stop detail screen, "Adjust order" (when the stop has items), "New order at door"
      (now reachable — was orphaned), and "Complete & collect →" (existing, prefilled) are all one
      tap away — matches "≤2 taps deep."
- [ ] Adjust screen: per-line qty stepper (boxed lines get boxes+pieces sub-steppers seeded from
      the line's stored split), trash removes a line (sets qty 0 → `REMOVE_ITEM`), `BarcodeFab`
      scan adds a new pending line (`ADD_ITEM`), footer shows a live **estimated** total via
      `computeLineSubtotal` (boxed-safe, never `qty × unitPrice` directly).
- [ ] Save builds the diff via `buildAtDoorChangeRequests`, submits each entry as
      create-then-self-resolve (`APPROVE_AT_STOP`); a `REGULATED_AUTH_REQUIRED` 409 opens the
      existing `LicenseGuardModal` and retries that one entry (never a second screen — matches the
      spec's "guards fire inline... never a second screen"); other 409s toast the server message
      and stop the batch without partial silent failure.
- [ ] Already-delivered/cancelled lines are never offered a stepper (client-side gate mirrors the
      server's `LINE_ALREADY_DELIVERED` 409 so the common case never round-trips an error).
- [ ] "Collect payment" (existing `payment.tsx`) is unchanged and still prefilled with the stop
      balance.
- [ ] Offline: create/resolve calls auto-queue via the existing global interceptor; `handleSave`
      refetches the order first to avoid re-diffing an already-applied change after a reconnect.
- [ ] `npx jest --selectProjects mobile __tests__/at-door-diff.test.ts` passes.

---

## 6. Code-map updates (apply after implementation, surgical — not a regen)

`.claude/code-map/mobile.md`:

- Row 46 ("Live margin hint + order-builder tier pricing"): correct the claim that
  `edit-items.tsx` already has the live cost/margin hint (it didn't, pre-this-increment) and
  extend the row to describe the completed negotiation-floor UI (Set-to-floor, Sell-anyway ack,
  cost-tap history sheet via `lib/api/cost-history.ts` + `components/CostHistorySheet.tsx`) on
  **both** `NewOrderScreen` and `edit-items.tsx`.
- Add a new "Where to find" row: **At-the-door adjust (driver, P10-POS-3)** →
  `lib/api/change-requests.ts` (`useCreateChangeRequest`/`useResolveChangeRequestAtStop`, mirrors
  `apps/web/lib/change-requests.ts` types; web has no create UI, this is mobile-only) +
  `lib/at-door-diff.ts` (`buildAtDoorChangeRequests`, tested) + `app/(driver)/route/stop/
[stopId]/adjust.tsx` (qty steppers/remove/scan-to-add over the P5-09 change-request engine,
  self-resolved `APPROVE_AT_STOP` since "driver-at-stop is the primary authority") — reached from
  `route/stop/[stopId]/index.tsx`'s action block, alongside the now-linked (previously orphaned)
  `new-order.tsx` and the existing prefilled `payment.tsx`.
- `_meta.json`: bump `mappedSha` to the branch's `git rev-parse HEAD` and `generatedAt` after the
  PR lands.

## 7. Gate

```
npx turbo run check-types lint test --filter=./apps/mobile
```

Mobile cannot be device-tested in this environment — rely on typecheck + lint + the two new Jest
suites (§4.5, §5.6) + a careful re-read of the diff against this plan's exact code before
declaring either WP done.
