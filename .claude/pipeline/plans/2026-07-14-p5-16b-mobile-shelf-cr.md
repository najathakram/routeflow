# P5-16b — Mobile buyer Your Shelf + post-dispatch change-request (P10-BUY-4 / P10-BUY-5)

## Status

PLANNED — 2026-07-14

## Context

**Principle: MOBILE MIRRORS WEB.** The web P5-06/P5-08/P5-09/P5-10 endpoints are SHIPPED. Mobile reuses them verbatim — no migration, no new API. Only RN UI differs.

**What the API already serves (verified):**

- `GET /buyer/shelf` → `{ estimates: ShelfEstimate[], activeOrder: {id, orderNumber, itemCount, total}|null }`. `ShelfEstimate` = `ReplenishmentEstimate` + `{ imageUrl: string|null, snoozed: boolean, snoozedUntil: string|null }`. `activeOrder.total` = stored money read back — render verbatim.
- `POST /buyer/replenishment/:productId/snooze` → `{ snoozedUntil }`; `DELETE` same → `{ ok }`.
- `POST /buyer/shelf/add-all-low` → the (redacted) active `BuyerOrder|null`. **Box splits computed SERVER-side** (`shelf.service.ts#lowItems`: boxed → `{qty: boxes*unitsPerBox, boxes, pieces:0}`) — no client money math.
- `POST /buyer/orders/:id/change-requests` (`CreateChangeRequestDto`: `type` ∈ ADD_ITEM/CHANGE_QTY/REMOVE_ITEM/NOTE, optional orderItemId/productId/qty/boxes/pieces/note ≤1000). 409 codes `EDIT_WINDOW_OPEN`/`CHANGE_WINDOW_CLOSED` (change-requests.service.ts:69/78).
- `GET /buyer/orders/:id` already includes `changeRequests[]` (newest first), `editWindow {editable, editableUntil, closedReason}`, `routeRun {status, startedAt}`, per-line `status`/`deliveredQty` — the mobile `BuyerOrder` type just doesn't declare them.

**What mobile has:** `useBuyerOrders`/`useBuyerOrder` (detail key `["buyer-orders", id]`)/`useBuyerCreateOrder`/`useBuyerCancelOrder`/`useBuyerUpdateOrderItems` + P5-16a's `useBuyerReplenishment` (`["buyer-replenishment"]`, raw estimates — no snooze/imageUrl/activeOrder). **Gap:** NO shelf hooks, NO snooze/add-all-low, NO change-request hook, NO `editWindow`/`changeRequests` on the mobile `BuyerOrder`. Mobile keys are DASH-STYLE singletons (`["buyer-shelf"]`), NOT web tuples.

**MONEY GUARD (the one money-sensitive spot):** the per-row shelf Add for a boxed product MUST carry `{ boxes: round(suggestedQty/unitsPerBox), pieces: 0 }` — `suggestedQty` is a whole-box multiple of PIECES; a bare qty on the buyer create path is read as a BOX count → `unitsPerBox`× over-order/over-charge (per `shelf.service.ts#lowItems`). The split goes through `apps/mobile/lib/pricing.ts#normalizeBoxesPieces` and is Jest-locked (WP2). NEVER ad-hoc `qty*unitPrice`.

**Assumptions (flagged):**

1. `(customer)/_layout.tsx` is a bare `<Stack>` — expo-router auto-registers `shelf.tsx`; NO layout edit; entry via menu rows (WP3). Tab bar NOT touched (Shelf is a pushed stack screen like Favorites).
2. Shelf Add path = server create/merge (`useBuyerCreateOrder` POST `/buyer/orders` merges into the active order), mirroring web — does NOT touch local `cartStore` (else per-row Add and Add-all-low would land in different carts). Open-order card is the feedback surface.
3. Boxed Add sends `qty = boxes*unitsPerBox` (server-canonical `lowItems` form) — server outcome identical (recomputes qty from the split), keeps qty+split self-consistent.
4. Mobile CR modal is free-text NOTE-only (spec: "free-text reason, NO prices"). `{type:"NOTE", note}` is valid. Typed composer stays web-only; the mobile RENDERER (`describeChangeRequest`) still handles all four types (web/sellers may file them).
5. Mobile Jest = pure-logic only; `import type` from `./api/buyer` is erased (no axios/react-query pulled in — same as `catalog-tile-logic.ts`).

## Acceptance

1. Your Shelf (from More + Home quick actions): sections Running low / Due soon / Snoozed / Everything else, per-row thumbnail, cadence meta, days-left bar, suggested-qty label — NO prices on rows.
2. Per-row Add creates/merges into the active order at the suggested qty; a boxed product's payload carries `{boxes, pieces:0}` (Jest-locked: 24 pcs @ 12/box → `{qty:24, boxes:2, pieces:0}`).
3. Snooze/Unsnooze per row; snoozed rows move to Snoozed with "Snoozed until {date}".
4. Header Add-all-low (disabled when none) seeds the active order server-side; open-order card shows `orderNumber · itemCount · $total` (verbatim) → order detail.
5. On the order detail: while the edit window is open the Edit/Cancel flow is preserved (now also gated by `editWindow.editable`); once dispatched, a Request-a-change button (gate: `routeRun.status==="IN_PROGRESS"` + status PENDING/CONFIRMED/OUT_FOR_DELIVERY) opens a free-text modal (NO prices) filing a NOTE CR; 409s map to friendly copy.
6. `changeRequests[]` render as rows with chips: PENDING(orange) → Approved(green) / Declined(red, reason).
7. `npm run verify`; `shelf-logic.test.ts` locks the box-split, grouping, CR chip/describe, edit/CR gates.

## Work Packages

### WP1 — Mobile shelf + change-request hooks and types

files:

- `apps/mobile/lib/api/buyer.ts` (modify)

brief: Add ChangeRequest types, extend `BuyerOrder`, add shelf/CR hooks, one extra invalidation on `useBuyerCreateOrder`.

**1a. Insert after `BuyerProduct` and before `BuyerOrder`:**

```ts
// ─── Change requests (P5-09/10 twin — P5-16b) ─────────────────────────────────
export type ChangeRequestType = "ADD_ITEM" | "CHANGE_QTY" | "REMOVE_ITEM" | "NOTE";
export type ChangeRequestStatus = "PENDING" | "APPROVED" | "DECLINED";
export type ChangeRequestResolution = "MERGED_AT_STOP" | "NEXT_DELIVERY" | "DECLINED";

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
  requestedByName: string | null;
  requestedByRole: string | null;
  resolvedByName: string | null;
  resolvedByRole: string | null;
  resolution: ChangeRequestResolution | null;
  resolutionReason: string | null;
  nextOrderId: string | null;
  resolvedAt: string | null;
  createdAt: string;
}
```

**1b. Replace the `BuyerOrder` interface with:**

```ts
export interface BuyerOrder {
  id: string;
  orderNumber?: string;
  status: string;
  createdAt: string;
  requestedDeliveryDate?: string;
  notes?: string;
  urgent?: boolean;
  subtotal?: number;
  tax?: number;
  total?: number;
  lineItems: Array<{
    id: string;
    productId: string;
    qty: number;
    unitPrice: number;
    subtotal?: number;
    boxes?: number | null;
    pieces?: number | null;
    status?: string;
    deliveredQty?: number;
    product?: { id: string; name: string; unit?: string };
  }>;
  /** P5-09: post-dispatch change requests, newest first. */
  changeRequests?: ChangeRequest[];
  /** P5-08: server edit window — closes when the order's run dispatches. */
  editWindow?: {
    editable: boolean;
    editableUntil: string | null;
    closedReason: "DISPATCHED" | "STATUS" | null;
  };
  routeRun?: { status: string; startedAt?: string | null } | null;
}
```

**1c. Insert after `useBuyerReplenishment`, before the `// ─── Orders ───` banner:**

```ts
// ─── Your Shelf (P5-06/07 twin — P5-16b) ──────────────────────────────────────
export interface ShelfEstimate extends ReplenishmentEstimate {
  imageUrl: string | null;
  snoozed: boolean;
  snoozedUntil: string | null;
}
export interface ShelfActiveOrder {
  id: string;
  orderNumber: string | null;
  itemCount: number;
  total: number;
}
export interface ShelfResponse {
  estimates: ShelfEstimate[];
  activeOrder: ShelfActiveOrder | null;
}

export function useBuyerShelf() {
  return useQuery<ShelfResponse>({
    queryKey: ["buyer-shelf"],
    queryFn: () => buyerApiClient.get("/buyer/shelf").then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useSnoozeReplenishment() {
  const qc = useQueryClient();
  return useMutation<{ snoozedUntil: string }, Error, string>({
    mutationFn: (productId) =>
      buyerApiClient.post(`/buyer/replenishment/${productId}/snooze`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer-shelf"] });
      qc.invalidateQueries({ queryKey: ["buyer-replenishment"] });
    },
  });
}

export function useUnsnoozeReplenishment() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (productId) =>
      buyerApiClient.delete(`/buyer/replenishment/${productId}/snooze`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer-shelf"] });
      qc.invalidateQueries({ queryKey: ["buyer-replenishment"] });
    },
  });
}

/** Box splits computed SERVER-side (shelf.service lowItems) — no client money math. */
export function useAddAllLow() {
  const qc = useQueryClient();
  return useMutation<BuyerOrder | null, Error, void>({
    mutationFn: () => buyerApiClient.post("/buyer/shelf/add-all-low").then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer-shelf"] });
      qc.invalidateQueries({ queryKey: ["buyer-replenishment"] });
      qc.invalidateQueries({ queryKey: ["buyer-orders"] });
      qc.invalidateQueries({ queryKey: ["buyer-dashboard"] });
    },
  });
}
```

**1d. Replace `useBuyerCreateOrder`** — only change: add `qc.invalidateQueries({ queryKey: ["buyer-shelf"] })` to `onSuccess` (so the shelf open-order card refreshes after a per-row Add). Keep the rest of the hook identical.

**1e. Append at the END of the file:**

```ts
// ─── Post-dispatch change requests (P5-10 twin — P5-16b) ──────────────────────
export interface BuyerCreateChangeRequestInput {
  orderId: string;
  type: ChangeRequestType;
  productId?: string;
  orderItemId?: string;
  qty?: number;
  note?: string;
}

export function useBuyerCreateChangeRequest() {
  const qc = useQueryClient();
  return useMutation<ChangeRequest, Error, BuyerCreateChangeRequestInput>({
    mutationFn: ({ orderId, ...dto }) =>
      buyerApiClient.post(`/buyer/orders/${orderId}/change-requests`, dto).then((r) => r.data),
    onSuccess: () => {
      // ["buyer-orders"] prefix covers both list (["buyer-orders", params]) and
      // detail (["buyer-orders", id]) keys.
      qc.invalidateQueries({ queryKey: ["buyer-orders"] });
    },
  });
}
```

Note: mobile's order-detail key is `["buyer-orders", id]` (NOT web's `["buyer","order",id]`). Do NOT "fix" the existing `["buyer-order", orderId]` invalidation in `useBuyerUpdateOrderItems` — out of scope; the `["buyer-orders"]` prefix covers it.

### WP2 — Pure shelf/CR logic helper + Jest suite

files:

- `apps/mobile/lib/shelf-logic.ts` (new)
- `apps/mobile/__tests__/shelf-logic.test.ts` (new)

brief: Pure, RN-free (type-only imports): shelf grouping, the MONEY-guarded box-split Add payload builder, display labels, edit/CR gates, CR describe/chip helpers (mirror `apps/web/lib/change-requests.ts`).

**`apps/mobile/lib/shelf-logic.ts` — EXACT code:**

```ts
/**
 * P5-16b: Your Shelf + change-request pure logic — Jest-tested, no RN imports.
 * Mirrors the web shelf page + apps/web/lib/change-requests.ts.
 * MONEY: buildShelfAddItem is the ONE money-sensitive spot — a boxed product's
 * Add payload MUST carry {boxes, pieces:0} (a bare qty is read as a BOX count →
 * unitsPerBox× over-order/over-charge). Locked by the test.
 */
import { normalizeBoxesPieces } from "./pricing";
import type { BuyerOrder, ChangeRequest, ChangeRequestStatus, ShelfEstimate } from "./api/buyer";

export interface ShelfSections {
  low: ShelfEstimate[];
  dueSoon: ShelfEstimate[];
  snoozed: ShelfEstimate[];
  rest: ShelfEstimate[];
}

export function groupShelfEstimates(estimates: ShelfEstimate[] | undefined): ShelfSections {
  const list = estimates ?? [];
  return {
    low: list.filter((e) => e.state === "low" && !e.snoozed),
    dueSoon: list.filter((e) => e.state === "due-soon" && !e.snoozed),
    snoozed: list.filter((e) => e.snoozed),
    rest: list.filter((e) => e.state === "ok" && !e.snoozed),
  };
}

export interface ShelfAddItem {
  productId: string;
  qty: number;
  boxes?: number;
  pieces?: number;
}

export function buildShelfAddItem(
  e: Pick<ShelfEstimate, "productId" | "suggestedQty" | "unitsPerBox">,
): ShelfAddItem {
  const upb = Math.trunc(Number(e.unitsPerBox ?? 0));
  if (upb > 1) {
    const boxes = Math.max(1, Math.round(Number(e.suggestedQty) / upb));
    const norm = normalizeBoxesPieces({ boxes, pieces: 0, unitsPerBox: upb });
    return {
      productId: e.productId,
      qty: norm.qty,
      boxes: norm.boxes ?? boxes,
      pieces: norm.pieces ?? 0,
    };
  }
  return { productId: e.productId, qty: Math.max(1, Math.trunc(Number(e.suggestedQty) || 0)) };
}

export function qtyLabel(e: Pick<ShelfEstimate, "suggestedQty" | "unitsPerBox" | "unit">): string {
  if (e.unitsPerBox && e.unitsPerBox > 1) {
    const boxes = Math.max(1, Math.round(e.suggestedQty / e.unitsPerBox));
    return `${e.suggestedQty} pcs (${boxes} ${boxes === 1 ? "box" : "boxes"} of ${e.unitsPerBox})`;
  }
  return `${e.suggestedQty} ${e.unit}`;
}

export function daysLeftFraction(
  e: Pick<ShelfEstimate, "estDaysLeft" | "cadenceDays">,
): number | null {
  if (e.estDaysLeft == null || e.cadenceDays == null || e.cadenceDays <= 0) return null;
  return Math.min(1, Math.max(0, e.estDaysLeft / e.cadenceDays));
}

export function daysLeftLabel(e: Pick<ShelfEstimate, "estDaysLeft">): string {
  if (e.estDaysLeft == null) return "no pattern yet";
  if (e.estDaysLeft < 0) return `${Math.abs(e.estDaysLeft)}d overdue`;
  if (e.estDaysLeft === 0) return "due today";
  return `~${e.estDaysLeft}d left`;
}

export function orderEditable(o: Pick<BuyerOrder, "status" | "editWindow">): boolean {
  return (o.status === "PENDING" || o.status === "CONFIRMED") && (o.editWindow?.editable ?? true);
}

export function orderCancellable(o: Pick<BuyerOrder, "status" | "editWindow">): boolean {
  return (o.status === "PENDING" || o.status === "DRAFT") && (o.editWindow?.editable ?? true);
}

export function canRequestChange(o: Pick<BuyerOrder, "status" | "routeRun">): boolean {
  return (
    o.routeRun?.status === "IN_PROGRESS" &&
    ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"].includes(o.status)
  );
}

export interface ChangeRequestChipSpec {
  label: string;
  variant: "orange" | "green" | "red" | "gray";
}

export function changeRequestChip(status: ChangeRequestStatus): ChangeRequestChipSpec {
  switch (status) {
    case "PENDING":
      return { label: "Pending", variant: "orange" };
    case "APPROVED":
      return { label: "Approved", variant: "green" };
    case "DECLINED":
      return { label: "Declined", variant: "red" };
    default:
      return { label: String(status), variant: "gray" };
  }
}

interface LineForLabel {
  id: string;
  product?: { name: string } | null;
}

/** Human summary — shows NO money on purpose (price is decided server-side at approval). */
export function describeChangeRequest(
  cr: ChangeRequest,
  lineItems: LineForLabel[] | undefined,
): { title: string; detail: string | null } {
  const lineLabel = (orderItemId: string | null | undefined): string => {
    const li = (lineItems ?? []).find((l) => l.id === (orderItemId ?? ""));
    return li?.product?.name ?? "an item";
  };
  switch (cr.type) {
    case "ADD_ITEM": {
      const boxes = cr.payload.boxes;
      const split =
        boxes != null
          ? ` (${boxes} box${Number(boxes) === 1 ? "" : "es"}${cr.payload.pieces ? ` + ${cr.payload.pieces} pcs` : ""})`
          : "";
      return {
        title: `Add ${Number(cr.payload.qty ?? 0)} × ${cr.payload.productName ?? "item"}${split}`,
        detail: cr.note,
      };
    }
    case "CHANGE_QTY":
      return {
        title: `Change ${lineLabel(cr.orderItemId ?? cr.payload.orderItemId)} to qty ${Number(cr.payload.newQty ?? 0)}`,
        detail: cr.note,
      };
    case "REMOVE_ITEM":
      return {
        title: `Remove ${lineLabel(cr.orderItemId ?? cr.payload.orderItemId)}`,
        detail: cr.note,
      };
    case "NOTE":
      return { title: "Note for the driver", detail: cr.payload.text ?? cr.note };
    default:
      return { title: "Change request", detail: cr.note };
  }
}

export function describeResolution(cr: ChangeRequest): string | null {
  if (cr.status === "APPROVED") {
    return cr.resolution === "NEXT_DELIVERY"
      ? "Approved — added to the next delivery"
      : "Approved — applied to today's delivery";
  }
  if (cr.status === "DECLINED") {
    return cr.resolutionReason ? `Declined — ${cr.resolutionReason}` : "Declined";
  }
  return null;
}
```

**`apps/mobile/__tests__/shelf-logic.test.ts`** — cover: `groupShelfEstimates` (state split, snoozed beats state, undefined→empty); **`buildShelfAddItem` MONEY** — boxed 24@12→`{qty:24,boxes:2,pieces:0}`, non-multiple 20@12→2 boxes(24), small 6@12→1 box(12), non-boxed→`{qty:6}` (no boxes/pieces keys), upb 1 not boxed, **cent-parity: `computeLineSubtotal({unitPrice:30, qty:24, boxes:2, pieces:0, unitsPerBox:12}) === 60` and `item.qty*30 === 720` (documents the guarded failure mode)**; `qtyLabel`/`daysLeftFraction`(clamp+null)/`daysLeftLabel`; `orderEditable`/`orderCancellable`/`canRequestChange` gates; `changeRequestChip`; `describeChangeRequest` (ADD_ITEM box split + no `$`, CHANGE_QTY/REMOVE_ITEM via lines, NOTE prefers payload.text); `describeResolution` (pending null, approved variants, declined+reason). Import `computeLineSubtotal` from `../lib/pricing`, types from `../lib/api/buyer`. (Full test bodies as authored — the cent-parity assertion is the money anchor.)

### WP3 — Mobile Your Shelf screen + nav entry points

files:

- `apps/mobile/app/(customer)/shelf.tsx` (new)
- `apps/mobile/app/(customer)/(tabs)/more.tsx` (modify — one MenuRow)
- `apps/mobile/app/(customer)/(tabs)/home.tsx` (modify — one quick-action row)

brief: RN twin of the web shelf page — four sections, per-row Add/Snooze, header Add-all-low + open-order card. All logic from WP1 hooks + WP2 helpers; presentation only. Nav: `(customer)/_layout.tsx` is a bare `<Stack>` (auto-registers `shelf.tsx` — NO layout edit); add a "Your Shelf" MenuRow in `more.tsx` (ACCOUNT card, after Favorites, `cube-outline`) + an ActionRow in `home.tsx` quick actions → `router.push("/(customer)/shelf")`. `shelf.tsx`: NavBar "Your Shelf"; `useBuyerShelf` → `groupShelfEstimates`; open-order card (`total` verbatim → order detail); Add-all-low button (`useAddAllLow`, disabled when 0 low); four sections (Running low/Due soon/Snoozed/Everything else) each a grouped card, rows = 44×44 image (fallback cube icon) + name + cadence/days-left meta + days-left bar (low=red/due-soon=orange/ok=brand; snoozed→"Snoozed until {date}") + `qtyLabel` + Add (`createOrder.mutate({items:[buildShelfAddItem(e)]})`, single-flight `pendingAdd`) + Snooze/Unsnooze (`pendingSnooze`); NO prices; loading/error/empty + pull-to-refresh. Follow `favorites.tsx`/`more.tsx` idioms. Full RN brief as authored.

### WP4 — Order-detail change requests + edit-window gating

files:

- `apps/mobile/app/(customer)/orders/[id].tsx` (modify)

brief: Gate Edit/Cancel on `orderEditable`/`orderCancellable` (P5-08 window); add a CR list with `changeRequestChip` + `describeChangeRequest`/`describeResolution` (NO money); add a Request-a-change button (when `!canEdit && canRequestChange(order)`) opening a free-text NOTE modal (`TextInput` ≤1000, NO prices/product search) → `useBuyerCreateChangeRequest.mutate({orderId, type:"NOTE", note})`; map 409 `EDIT_WINDOW_OPEN`/`CHANGE_WINDOW_CLOSED` to friendly copy; add `OUT_FOR_DELIVERY → {variant:"brand", label:"Out for delivery"}` to `orderPill`. Preserve the existing edit/cancel flow while the window is open. No changes to `edit-items.tsx`. Full RN brief (anchors) as authored.

### WP5 — Code map

files:

- `.claude/code-map/mobile.md` (modify)

brief: Add "Where to find" rows — Your Shelf screen `app/(customer)/shelf.tsx`; shelf/CR hooks in `lib/api/buyer.ts`; shelf grouping + boxed Add payload + CR describe/chips + gates in `lib/shelf-logic.ts` (test `__tests__/shelf-logic.test.ts`); note `orders/[id].tsx` now renders CRs + a NOTE Request-a-change modal gated by editWindow/routeRun. Money note: per-row Add box split (`buildShelfAddItem`) Jest-locked; add-all-low splits server-side.

## Verify

`npm run verify` — `shelf-logic.test.ts` green, locking the boxed Add payload (24@12→`{qty:24,boxes:2,pieces:0}`), grouping, CR chip/describe, edit/CR gates.

### Critical Files

- apps/mobile/lib/api/buyer.ts
- apps/mobile/lib/shelf-logic.ts (new; depends on apps/mobile/lib/pricing.ts)
- apps/mobile/app/(customer)/shelf.tsx (new)
- apps/mobile/app/(customer)/orders/[id].tsx
- apps/web/app/buyer/portal/[seller]/shelf/page.tsx + apps/web/lib/change-requests.ts (read-only refs mirrored)
