# Plan: P5-10 + P5-11 — Post-dispatch change-request UIs (web) `[money-adjacent]`

> Authored by Fable 5 on 2026-07-13. Status: DRAFT
> This file is the ONLY context the implementation and review agents receive.
> Branch: `feat/p5-10-11-change-request-ui` (already created off master @ `a850405`). Repo root: `C:\ClaudeCode\routeflow`.

## Objective

The P5-09 change-request engine (shipped in `a850405`, live) lets a buyer or driver file a `ChangeRequest` against a **dispatched** order and lets the office/driver resolve it. This increment builds the two **web** surfaces that consume it:

- **P5-10 (buyer portal):** on the buyer order-detail page of a dispatched order, a "Request a change" affordance opens a small form (add item / change qty / remove item / note) that POSTs to `/buyer/orders/:id/change-requests`; every filed request renders as a status chip — PENDING (amber) flipping to Approved (green) or Declined + reason (red).
- **P5-11 (operator dashboard):** the operator order-detail page surfaces the order's PENDING change requests with resolve controls (Approve at stop / Approve as next delivery / Decline with required reason) calling `POST /orders/:id/change-requests/:crId/resolve`, with graceful handling of the first-resolution-wins 409 race; the orders LIST badges a pending-CR count per row (one small ADDITIVE API change supplies the count).

**Mobile is OUT OF SCOPE** — the driver-at-stop resolve UI is deferred to the P10 mobile wave. Nothing under `apps/mobile` changes.

## Constraints & conventions

### The API contract (P5-09 — verified against the live code; treat as authoritative)

All paths are relative to the global prefix `/api/v1`, which both web axios clients (`apps/web/lib/api-client.ts` `apiClient`, `apps/web/lib/buyer-api-client.ts` `buyerApiClient`) already bake into their base URL — hook code uses paths like `/orders/...` exactly as the existing hooks do.

**Endpoints** (from `apps/api/src/orders/orders.controller.ts:212-245` and `apps/api/src/buyer/buyer.controller.ts:400-420`):

| Route                                            | Roles                                                       | Purpose                                                   |
| ------------------------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------- |
| `POST /orders/:id/change-requests`               | OPERATOR, CUSTOMER, DRIVER                                  | file a CR (operator surface — not used by this plan's UI) |
| `GET /orders/:id/change-requests`                | OPERATOR, CUSTOMER, DRIVER                                  | list CRs (not needed — see below)                         |
| `POST /orders/:id/change-requests/:crId/resolve` | **OPERATOR, DRIVER only** (TENANT_ADMIN satisfies OPERATOR) | resolve; **buyers cannot resolve**                        |
| `POST /buyer/orders/:id/change-requests`         | buyer JWT + `X-Tenant-Slug` (handled by `buyerApiClient`)   | buyer files a CR                                          |
| `GET /buyer/orders/:id/change-requests`          | buyer JWT                                                   | list (not needed — see below)                             |

**No dedicated GET is needed by the UI**: `OrdersService.findOne` (orders.service.ts:206-268) already includes `changeRequests: { orderBy: { createdAt: "desc" } }` (newest first) plus `routeRun: { select: { status, startedAt } }` and the computed `editWindow`, and **the buyer detail route `GET /buyer/orders/:id` calls the same `findOne`** (buyer.controller.ts:309-316) — so both order-detail payloads already carry everything. The web types just don't declare the fields yet.

**Create body** (`CreateChangeRequestDto`, apps/api/src/orders/dto/create-change-request.dto.ts): `{ type: "ADD_ITEM"|"CHANGE_QTY"|"REMOVE_ITEM"|"NOTE", orderItemId?, productId?, qty?, boxes?, pieces?, note? }`. Semantics: ADD_ITEM requires `productId`+`qty`; CHANGE_QTY requires `orderItemId`+`qty` where **`qty` is the NEW ABSOLUTE qty, not a delta**; REMOVE_ITEM requires `orderItemId`; NOTE requires `note`.

**Resolve body** (`ResolveChangeRequestDto`): `{ action: "APPROVE_AT_STOP"|"APPROVE_NEXT_DELIVERY"|"DECLINE", reason?: string }` — `reason` is **service-enforced required for DECLINE** (400 without). APPROVE_NEXT_DELIVERY is valid only for ADD_ITEM and CHANGE_QTY **increases** (else 400 `INVALID_RESOLUTION_FOR_TYPE`).

**ChangeRequest row shape** (what the API returns; from the Prisma model + `change-requests.service.ts`): `id, tenantId, orderId, orderItemId|null, productId|null, routeRunStopId|null, type, status ("PENDING"|"APPROVED"|"DECLINED"), payload (Json), note|null, requestedById/Name/Role|null, resolvedById/Name/Role|null, resolution ("MERGED_AT_STOP"|"NEXT_DELIVERY"|"DECLINED")|null, resolutionReason|null, nextOrderId|null, resolvedAt|null, createdAt, updatedAt`.

**`payload` shapes by type** (change-requests.service.ts:88-132 — note **only ADD_ITEM snapshots a product name**):

- `ADD_ITEM` -> `{ productId, qty, boxes, pieces, productName }`
- `CHANGE_QTY` -> `{ orderItemId, newQty }` (no name — the UI must label via the order's line items)
- `REMOVE_ITEM` -> `{ orderItemId }` (ditto)
- `NOTE` -> `{ text }`

**Error codes the UIs must handle** (all 409 `ConflictException` with `{ code, ... }` bodies read as `err.response.data.code`, same pattern as the existing `parseRegulatedAuthError`):

- `EDIT_WINDOW_OPEN` — create refused while the run is still `SCHEDULED` (direct edit still applies). Body message is developer-facing — the buyer UI must substitute friendly copy.
- `CHANGE_WINDOW_CLOSED` — create/approve refused when the run is no longer `IN_PROGRESS` or order status not in {PENDING, CONFIRMED, OUT_FOR_DELIVERY}.
- `CHANGE_REQUEST_ALREADY_RESOLVED` — **the G6 lost race**: a second resolve (or resolving a non-PENDING CR). Body carries NO `message`. The UI must toast a friendly line and **refetch — never auto-retry**.
- `STOP_ALREADY_COMPLETED` — at-stop approve after the driver completed/skipped the stop. No `message`.
- `LINE_ALREADY_DELIVERED` — at-stop approve of a CHANGE_QTY/REMOVE_ITEM whose line already has deliveredQty. No `message`.
- `INSUFFICIENT_STOCK`, `CREDIT_LIMIT_EXCEEDED`, `REGULATED_AUTH_REQUIRED` — approval guards re-run server-side. The first two carry human-readable `message` (the global mutation-error toast in `app/providers.tsx` surfaces them automatically); `REGULATED_AUTH_REQUIRED` is already suppressed there and must route into the existing `LicenseGuardModal` flow on the operator page.

**When can a buyer file?** Exactly the server's create gate: `order.routeRun?.status === "IN_PROGRESS"` AND `order.status in {PENDING, CONFIRMED, OUT_FOR_DELIVERY}`. The buyer order payload carries `routeRun.status` (via `findOne`), so the UI mirrors the gate directly instead of probing for a 409. `editWindow` = `{ editable, editableUntil, closedReason: "DISPATCHED"|"STATUS"|null }` (orders.service.ts:275-287) is also present and is used to close the buyer's direct-edit affordance.

### Repo rules

- **Web tests are Playwright only** (`apps/web/e2e/*.spec.ts`) — there is NO web Jest. **Do not create any `*.test.tsx`/`*.spec.tsx` under `apps/web`.** This plan adds **no new e2e spec**: the Playwright suite runs read-only against production and a CR flow requires a dispatched order + mutations; verification is typecheck + lint + the existing e2e suite still compiling.
- **Money:** show **no computed money in the change-request UIs**. The buyer request form deliberately displays no price (not even the catalog `buyerPrice` inside the modal) — an added line is priced by the server at approval through the one buyer pricing path (tier -> sticky -> promo), and any client-side preview would be a second pricing derivation that can drift from the merged result. The CR chips display qty/product/reason only. Order totals shown elsewhere on the pages remain the server-stored values already rendered. **No new `qty*unitPrice` anywhere.**
- **No new npm dependencies.** Reuse `@routeflow/ui/web` primitives (`Badge`, `Button`, `Card`, `Modal`, `useToast`) and the existing Tailwind semantic/`buyer-*` token classes already used in the touched files. `Badge` accepts `status` (its `BadgeStatus` map already contains `PENDING`->warning/amber, `APPROVED`->success/green, `DECLINED`->danger/red — use those directly) or `variant`+`label`.
- **Additive types only:** every new field on the web `Order`/`BuyerOrder` types is optional (`changeRequests?`, `_count?`, `editWindow?`, `routeRun?`) and every consumer null-guards, so the UI tolerates an older API that doesn't send them.
- **What must NOT change:** the P5-08 behavior on the operator order-detail (`canEdit` from `editWindow`, the "Out for delivery — editing closed" chip, the "Edited N×" revision chip, price editing, license-guard retry plumbing), the buyer page's existing edit/cancel flows, `completeStop`/pricing/API money paths, and all existing API routes. The ONE API file change (WP6) is a single additive `_count` include in `findAll`.
- Prettier: semicolons, double quotes, printWidth 100. Conventional Commits.
- **No DB/schema/migration work in this increment.** Never run anything against prod.

## Work packages

File lists are disjoint. **Sequencing:** WP1, WP2, WP6 have no dependencies — run first (parallel). WP3 imports WP1's shared module + WP2's hook; WP4 and WP5 import WP1's module — run after wave 1 (WP3/WP4/WP5 are mutually disjoint and parallel). WP7 last. Cross-package interfaces are fully specified below, so an implementer never needs another package's diff.

---

### WP1 — Shared CR model, operator hooks, handled-409 registration

- **files:** `apps/web/lib/change-requests.ts` (NEW), `apps/web/lib/api/orders.ts`, `apps/web/app/providers.tsx`
- **brief:** Create the one shared web module for the ChangeRequest shape + display helpers (pure — no HTTP-client imports, so both the operator and buyer surfaces can consume it without cross-client bleed). Extend the operator `Order` type additively and add the resolve mutation. Register the CR 409 codes as "handled" so the global mutation-error toast doesn't double-fire raw axios messages over the components' guided handling.
- **exact code — `apps/web/lib/change-requests.ts` (entire new file):**

```ts
/**
 * P5-10/P5-11: shared web model for post-dispatch change requests (the P5-09
 * engine). Mirrors the API's ChangeRequest row + payload shapes
 * (apps/api/src/orders/change-requests.service.ts). Pure types + formatting
 * helpers — deliberately NO HTTP-client imports so both the operator surface
 * (lib/api/orders.ts) and the buyer surface (lib/api/buyer.ts) can use it.
 */

export type ChangeRequestType = "ADD_ITEM" | "CHANGE_QTY" | "REMOVE_ITEM" | "NOTE";
export type ChangeRequestStatus = "PENDING" | "APPROVED" | "DECLINED";
export type ChangeRequestResolution = "MERGED_AT_STOP" | "NEXT_DELIVERY" | "DECLINED";
export type ChangeRequestResolveAction = "APPROVE_AT_STOP" | "APPROVE_NEXT_DELIVERY" | "DECLINE";

export interface ChangeRequest {
  id: string;
  orderId: string;
  orderItemId: string | null;
  productId: string | null;
  type: ChangeRequestType;
  status: ChangeRequestStatus;
  /**
   * Typed delta. ADD_ITEM {productId,qty,boxes,pieces,productName};
   * CHANGE_QTY {orderItemId,newQty}; REMOVE_ITEM {orderItemId}; NOTE {text}.
   * Only ADD_ITEM snapshots a product name — label the others via the order's
   * line items (post-dispatch lines are CANCELLED, never deleted, so the
   * lookup stays valid).
   */
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

/** Minimal line shape needed to label CHANGE_QTY/REMOVE_ITEM requests. */
interface LineForLabel {
  id: string;
  name?: string | null;
  product?: { name: string } | null;
}

/**
 * Human summary of a change request. Shows NO money on purpose: the price of
 * an added/changed line is decided by the server's pricing path at approval —
 * previewing a price here would be a second derivation that can drift.
 */
export function describeChangeRequest(
  cr: ChangeRequest,
  lineItems: LineForLabel[] | undefined,
): { title: string; detail: string | null } {
  const lineLabel = (orderItemId: string | null | undefined): string => {
    const li = (lineItems ?? []).find((l) => l.id === (orderItemId ?? ""));
    return li?.product?.name ?? li?.name ?? "an item";
  };
  switch (cr.type) {
    case "ADD_ITEM": {
      const boxes = cr.payload.boxes;
      const split =
        boxes != null
          ? ` (${boxes} box${Number(boxes) === 1 ? "" : "es"}${
              cr.payload.pieces ? ` + ${cr.payload.pieces} pcs` : ""
            })`
          : "";
      return {
        title: `Add ${Number(cr.payload.qty ?? 0)} × ${cr.payload.productName ?? "item"}${split}`,
        detail: cr.note,
      };
    }
    case "CHANGE_QTY":
      return {
        title: `Change ${lineLabel(cr.orderItemId ?? cr.payload.orderItemId)} to qty ${Number(
          cr.payload.newQty ?? 0,
        )}`,
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

/** Outcome line shown once a CR is resolved (null while PENDING). */
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

- **exact code — `apps/web/lib/api/orders.ts` additions.** Add at the top (after the existing imports): `import type { ChangeRequest, ChangeRequestResolveAction } from "@/lib/change-requests";` and re-export for convenience: `export type { ChangeRequest } from "@/lib/change-requests";`. Extend the `Order` interface — insert after the `editWindow?` field (line ~46), before `createdAt`:

```ts
  /** P5-09: post-dispatch change requests, newest first (absent on older API). */
  changeRequests?: ChangeRequest[];
  /** P5-11: filtered relation counts from the LIST endpoint — `changeRequests`
   *  counts PENDING requests only (absent on detail payloads / older API). */
  _count?: { changeRequests?: number };
```

Append the mutation at the end of the file:

```ts
/**
 * P5-11: resolve a PENDING change request from the dashboard (the "office").
 * The driver-at-stop mobile surface is the P10 wave. First resolution wins on
 * the server — a lost race returns 409 { code: "CHANGE_REQUEST_ALREADY_RESOLVED" };
 * callers treat that as "someone else got there first": toast + refetch, never
 * retry. onSettled invalidates on success AND error so a lost race immediately
 * pulls the winning resolution (and the merged totals) into view.
 */
export function useResolveChangeRequest() {
  const qc = useQueryClient();
  return useMutation<
    ChangeRequest,
    Error,
    { orderId: string; crId: string; action: ChangeRequestResolveAction; reason?: string }
  >({
    mutationFn: ({ orderId, crId, action, reason }) =>
      apiClient
        .post(`/orders/${orderId}/change-requests/${crId}/resolve`, { action, reason })
        .then((r) => r.data),
    onSettled: (_data, _err, { orderId }) => {
      qc.invalidateQueries({ queryKey: ["orders", orderId] });
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}
```

- **exact code — `apps/web/app/providers.tsx`:** replace the `HANDLED_CODES` line (currently line 21) with:

```ts
const HANDLED_CODES = [
  "MERGE_CHOICE_REQUIRED",
  "REGULATED_AUTH_REQUIRED",
  // P5-10/11: change-request 409s are turned into guided flows by the
  // initiating components (friendly buyer banners; operator toast +
  // refetch on the first-resolution-wins race). Their bodies carry no
  // user-facing `message`, so the generic toast would show a raw axios
  // error. CR-specific codes — nothing else throws them.
  "CHANGE_REQUEST_ALREADY_RESOLVED",
  "STOP_ALREADY_COMPLETED",
  "LINE_ALREADY_DELIVERED",
  "CHANGE_WINDOW_CLOSED",
  "EDIT_WINDOW_OPEN",
];
```

Nothing else in providers.tsx changes.

---

### WP2 — Buyer hooks + types

- **files:** `apps/web/lib/api/buyer.ts`
- **effort:** low
- **brief:** Extend `BuyerOrder` additively with the fields `findOne` already returns, and add the create-CR mutation. Import the shared type: `import type { ChangeRequest } from "@/lib/change-requests";` (path alias `@/` is standard in this file's siblings; note this file starts with `"use client"` — keep that first).
- **exact code — `BuyerOrder` additions** (inside the existing interface, after `invoices?`):

```ts
  /** P5-09: post-dispatch change requests, newest first (absent on older API). */
  changeRequests?: ChangeRequest[];
  /** P5-08: server edit window — editing closes when the order's run dispatches. */
  editWindow?: {
    editable: boolean;
    editableUntil: string | null;
    closedReason: "DISPATCHED" | "STATUS" | null;
  };
  /** Run state backing the edit window (null until the order is on a run). */
  routeRun?: { status: string; startedAt?: string | null } | null;
```

- **exact code — append in the Orders section (after `useBuyerCancelOrder`):**

```ts
export interface BuyerCreateChangeRequestInput {
  orderId: string;
  type: "ADD_ITEM" | "CHANGE_QTY" | "REMOVE_ITEM" | "NOTE";
  /** ADD_ITEM: the catalog product to add. */
  productId?: string;
  /** CHANGE_QTY / REMOVE_ITEM: the target order line. */
  orderItemId?: string;
  /** ADD_ITEM: qty to add. CHANGE_QTY: the NEW absolute qty (not a delta). */
  qty?: number;
  note?: string;
}

/**
 * P5-10: file a post-dispatch change request against an order. Only valid once
 * the order's run has dispatched — the server 409s EDIT_WINDOW_OPEN while
 * direct editing is still available and CHANGE_WINDOW_CLOSED once the run is
 * no longer active (both mapped to friendly copy by the caller).
 */
export function useBuyerCreateChangeRequest() {
  const qc = useQueryClient();
  return useMutation<ChangeRequest, Error, BuyerCreateChangeRequestInput>({
    mutationFn: ({ orderId, ...dto }) =>
      buyerApiClient.post(`/buyer/orders/${orderId}/change-requests`, dto).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["buyer", "order", vars.orderId] });
    },
  });
}
```

---

### WP3 — Buyer order-detail: "Request a change" + CR timeline chips (P5-10)

- **files:** `apps/web/app/buyer/portal/[seller]/orders/[id]/page.tsx`
- **brief:** Three additions to the existing page (642 lines; keep everything else byte-identical, including the edit/cancel flows and the boxed-aware `buyerLineAmount` preview): (a) tighten `canEdit` to honor the server edit window; (b) a "Request a change" button in the Items-card header that opens a new page-local `RequestChangeModal`; (c) a "Change requests" card rendering `order.changeRequests` as status chips. New imports: `useToast` from `@routeflow/ui/web` (extend the existing `Badge, Button, Modal` import), `MessageSquarePlus` from `lucide-react`, `useBuyerCreateChangeRequest, type BuyerOrder` from `@/lib/api/buyer`, and `describeChangeRequest, describeResolution` from `@/lib/change-requests`.
- **exact code — gating (replace the current `const canEdit = ...` line 209, keep `showDeliveryProgress`/`canCancel` as-is):**

```ts
// Buyer direct edit: DRAFT/PENDING only, AND the P5-08 server edit window
// must still be open (it closes when the run dispatches). Older API without
// editWindow falls back to the pure status check.
const canEdit =
  order &&
  (order.status === "DRAFT" || order.status === "PENDING") &&
  (order.editWindow?.editable ?? true);
// P5-10: change requests exist exactly where direct editing ended — mirror
// the server's create gate (run IN_PROGRESS + order still deliverable).
const canRequestChange =
  !!order &&
  order.routeRun?.status === "IN_PROGRESS" &&
  ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"].includes(order.status);
```

Add state next to the other `React.useState` declarations: `const [crOpen, setCrOpen] = React.useState(false);` and `const { toast } = useToast();`.

- **exact code — the affordance.** In the Items-card header, directly after the existing `{canEdit && !editMode && (...Edit Items...)}` block (line ~366-370), add a sibling:

```tsx
{
  !canEdit && canRequestChange && !editMode && (
    <Button variant="secondary" size="sm" onClick={() => setCrOpen(true)}>
      <MessageSquarePlus className="mr-1.5 h-3.5 w-3.5" /> Request a change
    </Button>
  );
}
```

- **exact code — CR chips card.** Insert immediately after the status-timeline card (the `<div className="mb-8 rounded-xl border border-surface-border bg-white p-6"><OrderTimeline …/></div>` block, line ~314-316):

```tsx
{
  /* P5-10: change requests filed after dispatch — PENDING (amber) flips to
          Approved (green) / Declined + reason (red) once resolved. */
}
{
  (order.changeRequests?.length ?? 0) > 0 && (
    <div className="mb-6 overflow-hidden rounded-xl border border-surface-border bg-white">
      <div className="border-b border-surface-border bg-surface-raised px-4 py-3">
        <h2 className="text-sm font-semibold text-navy">Change requests</h2>
      </div>
      <ul className="divide-y divide-surface-border">
        {order.changeRequests!.map((cr) => {
          const { title, detail } = describeChangeRequest(cr, order.lineItems);
          const outcome = describeResolution(cr);
          return (
            <li key={cr.id} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-navy">{title}</p>
                {detail && <p className="mt-0.5 text-xs text-navy/70">{detail}</p>}
                <p className="mt-0.5 text-[11px] text-navy/50">
                  Requested {new Date(cr.createdAt).toLocaleString()}
                </p>
                {outcome && (
                  <p
                    className={`mt-1 text-xs font-medium ${
                      cr.status === "DECLINED" ? "text-danger" : "text-success"
                    }`}
                  >
                    {outcome}
                  </p>
                )}
              </div>
              <Badge status={cr.status} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

(`Badge status` works because `PENDING`/`APPROVED`/`DECLINED` are already in the shared `BadgeStatus` map — amber warning / green success / red danger respectively.)

- **exact code — the modal.** Mount at the end of the page JSX (next to the existing cancel `Modal`): `<RequestChangeModal order={order} open={crOpen} onClose={() => setCrOpen(false)} onFiled={() => toast({ title: "Change request sent", description: "The seller will confirm it with your driver.", variant: "success" })} />`. Define the component in the same file (above the page component), transplanting this exactly — **note it deliberately shows no prices anywhere, including in the product-search results**:

```tsx
// ─── Request-a-change modal (P5-10) ───────────────────────────────────────────
// Files a post-dispatch ChangeRequest (P5-09 engine). Deliberately shows NO
// prices anywhere (not even catalog prices in the search results): an added
// line is priced by the SERVER at approval through the one buyer pricing path
// (tier -> sticky -> promo) — a client-side preview would be a second pricing
// derivation that can drift from the merged result.

type CrFormType = "ADD_ITEM" | "CHANGE_QTY" | "REMOVE_ITEM" | "NOTE";

const CR_TYPE_OPTIONS: Array<{ value: CrFormType; label: string }> = [
  { value: "ADD_ITEM", label: "Add an item" },
  { value: "CHANGE_QTY", label: "Change a quantity" },
  { value: "REMOVE_ITEM", label: "Remove an item" },
  { value: "NOTE", label: "Note for the driver" },
];

function RequestChangeModal({
  order,
  open,
  onClose,
  onFiled,
}: {
  order: BuyerOrder;
  open: boolean;
  onClose: () => void;
  onFiled: () => void;
}) {
  const createCr = useBuyerCreateChangeRequest();
  const [type, setType] = React.useState<CrFormType>("ADD_ITEM");
  const [orderItemId, setOrderItemId] = React.useState("");
  const [qty, setQty] = React.useState(1);
  const [note, setNote] = React.useState("");
  const [formError, setFormError] = React.useState<string | null>(null);
  const [product, setProduct] = React.useState<{ id: string; name: string } | null>(null);
  const [search, setSearch] = React.useState("");
  const [searchDebounced, setSearchDebounced] = React.useState("");

  React.useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const showSearch = open && type === "ADD_ITEM" && !product && searchDebounced.length >= 2;
  const { data: searchResults } = useBuyerProducts(
    showSearch ? { search: searchDebounced, limit: 6 } : { limit: 0 },
  );

  // Only active, not-yet-delivered lines can be changed/removed — the server
  // hard-blocks delivered lines at approval (409 LINE_ALREADY_DELIVERED).
  const changeableLines = order.lineItems.filter(
    (li) => li.status !== "CANCELLED" && Number(li.deliveredQty ?? 0) === 0,
  );
  const selectedLine = changeableLines.find((li) => li.id === orderItemId);

  const isValid =
    type === "ADD_ITEM"
      ? !!product && qty >= 1
      : type === "NOTE"
        ? note.trim().length > 0
        : !!selectedLine && (type === "REMOVE_ITEM" || qty >= 1);

  const resetAndClose = () => {
    setType("ADD_ITEM");
    setOrderItemId("");
    setQty(1);
    setNote("");
    setProduct(null);
    setSearch("");
    setFormError(null);
    onClose();
  };

  const handleSubmit = async () => {
    if (!isValid || createCr.isPending) return;
    setFormError(null);
    try {
      await createCr.mutateAsync({
        orderId: order.id,
        type,
        ...(type === "ADD_ITEM" ? { productId: product!.id, qty } : {}),
        ...(type === "CHANGE_QTY" ? { orderItemId, qty } : {}),
        ...(type === "REMOVE_ITEM" ? { orderItemId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onFiled();
      resetAndClose();
    } catch (err: any) {
      const code = err?.response?.data?.code;
      if (code === "EDIT_WINDOW_OPEN") {
        setFormError(
          "This order can still be edited directly — close this and use “Edit Items” instead.",
        );
      } else if (code === "CHANGE_WINDOW_CLOSED") {
        setFormError(
          "The delivery run for this order has ended — changes can no longer be requested.",
        );
      } else {
        setFormError(err?.response?.data?.message ?? "Failed to send the change request.");
      }
    }
  };

  return (
    <Modal
      open={open}
      onClose={resetAndClose}
      title="Request a change"
      description="Your order is out for delivery, so changes need the seller's confirmation."
      footer={
        <>
          <Button variant="secondary" onClick={resetAndClose}>
            Cancel
          </Button>
          <Button
            className="bg-buyer-500 hover:bg-buyer-600 focus-visible:ring-buyer-500"
            onClick={handleSubmit}
            disabled={!isValid}
            loading={createCr.isPending}
          >
            Send Request
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Type picker */}
        <div className="grid grid-cols-2 gap-2">
          {CR_TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                setType(opt.value);
                setFormError(null);
                setOrderItemId("");
                setQty(1);
                setProduct(null);
                setSearch("");
              }}
              className={`rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors ${
                type === opt.value
                  ? "border-buyer-500 bg-buyer-50 text-buyer-600"
                  : "border-surface-border bg-white text-navy/70 hover:text-navy"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* ADD_ITEM: product search (NO prices shown) + qty */}
        {type === "ADD_ITEM" && (
          <div className="space-y-2">
            {product ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-surface-border bg-surface-raised px-3 py-2">
                <span className="text-sm font-medium text-navy truncate">{product.name}</span>
                <button
                  type="button"
                  onClick={() => setProduct(null)}
                  className="text-xs font-medium text-navy/60 hover:text-navy"
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/30" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search products (name, SKU, barcode)..."
                  className="w-full rounded-lg border border-surface-border bg-white py-2 pl-10 pr-4 text-sm text-navy placeholder:text-navy/70 focus:border-buyer-300 focus:outline-none focus:ring-1 focus:ring-buyer-200"
                />
              </div>
            )}
            {showSearch && (searchResults?.data?.length ?? 0) > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-lg border border-surface-border bg-white shadow-lg">
                {searchResults!.data.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setProduct({ id: p.id, name: p.name });
                      setSearch("");
                    }}
                    className="flex w-full items-center gap-3 border-b border-surface-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-surface-raised"
                  >
                    <Plus className="h-4 w-4 flex-shrink-0 text-buyer-500" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-navy">{p.name}</p>
                      <p className="text-[11px] text-navy/70">
                        {p.sku ? `SKU: ${p.sku} · ` : ""}
                        {p.unit}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {showSearch && searchResults?.data?.length === 0 && (
              <p className="py-1 text-center text-xs text-navy/70">No products found</p>
            )}
            {product && (
              <label className="flex items-center gap-2 text-sm text-navy">
                Quantity
                <input
                  type="number"
                  min={1}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                  className="w-20 rounded border border-surface-border bg-white px-2 py-1 text-center text-sm text-navy"
                />
              </label>
            )}
          </div>
        )}

        {/* CHANGE_QTY / REMOVE_ITEM: pick a line */}
        {(type === "CHANGE_QTY" || type === "REMOVE_ITEM") && (
          <div className="space-y-2">
            {changeableLines.length === 0 ? (
              <p className="text-sm text-navy/70">No lines on this order can still be changed.</p>
            ) : (
              <select
                value={orderItemId}
                onChange={(e) => {
                  setOrderItemId(e.target.value);
                  const li = changeableLines.find((l) => l.id === e.target.value);
                  if (li && type === "CHANGE_QTY") setQty(Math.max(1, Number(li.qty)));
                }}
                className="w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:border-buyer-300 focus:outline-none"
              >
                <option value="">Select an item…</option>
                {changeableLines.map((li) => (
                  <option key={li.id} value={li.id}>
                    {li.product.name} (qty {Number(li.qty)})
                  </option>
                ))}
              </select>
            )}
            {type === "CHANGE_QTY" && selectedLine && (
              <label className="flex items-center gap-2 text-sm text-navy">
                New quantity
                <input
                  type="number"
                  min={1}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                  className="w-20 rounded border border-surface-border bg-white px-2 py-1 text-center text-sm text-navy"
                />
                <span className="text-xs text-navy/60">currently {Number(selectedLine.qty)}</span>
              </label>
            )}
          </div>
        )}

        {/* Note — required for NOTE, optional context otherwise */}
        <label className="block text-sm text-navy">
          {type === "NOTE" ? "Note" : "Note (optional)"}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder={type === "NOTE" ? "What should the driver know?" : "Anything else?"}
            className="mt-1 w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/50 focus:border-buyer-300 focus:outline-none"
          />
        </label>

        {formError && (
          <div className="flex items-center gap-2 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            {formError}
          </div>
        )}
      </div>
    </Modal>
  );
}
```

(`Search`, `Plus`, `AlertTriangle` are already imported in this file.)

---

### WP4 — Operator order-detail: pending-CR list + resolve controls (P5-11)

- **files:** `apps/web/app/(dashboard)/orders/[id]/page.tsx`
- **brief:** Add (a) an amber "N pending" chip in the header action bar next to the P5-08 chips, (b) a "Change requests" `Card` in the main column between the Line Items card and the Notes card with resolve controls on PENDING rows, and (c) the resolve handler with full 409/race handling that reuses the page's existing `guardError` license-guard plumbing. Everything else on this 2570-line page stays byte-identical — in particular the P5-08 `canEdit`/chips (lines 1323-1675), edit flow, and `LicenseGuardModal` wiring. New imports: add `useResolveChangeRequest` to the `@/lib/api/orders` import list, and add `import { describeChangeRequest, describeResolution, type ChangeRequest, type ChangeRequestResolveAction } from "@/lib/change-requests";`.
- **exact code — state + handler.** In `OrderDetailPage` (after `const createInvoiceFromOrder = ...`, line ~1219) add:

```ts
// P5-11: change-request resolution (office side; driver-at-stop is P10 mobile).
const resolveCr = useResolveChangeRequest();
const [declineTargetId, setDeclineTargetId] = React.useState<string | null>(null);
const [declineReason, setDeclineReason] = React.useState("");
```

After the `canEdit` derivation (line ~1329, i.e. after `if (isError || !order)` returns — `order` is non-null here) add:

```ts
const changeRequests = order.changeRequests ?? [];
const pendingChangeRequests = changeRequests.filter((cr) => cr.status === "PENDING");

/**
 * Resolve a change request. G6 race rule: the FIRST resolution wins and
 * locks server-side — a lost race is 409 CHANGE_REQUEST_ALREADY_RESOLVED
 * (typically the driver resolved it at the stop first). We NEVER retry a
 * lost race: toast what happened and let the hook's onSettled invalidation
 * refetch the winning state. REGULATED_AUTH_REQUIRED routes into the
 * existing license-guard modal with a retry, like every other guarded 409
 * on this page. INSUFFICIENT_STOCK / CREDIT_LIMIT_EXCEEDED carry a server
 * message and surface via the global mutation toast — no handling needed.
 */
function handleResolve(cr: ChangeRequest, action: ChangeRequestResolveAction, reason?: string) {
  const run = () =>
    resolveCr.mutate(
      { orderId: order!.id, crId: cr.id, action, reason },
      {
        onSuccess: () => {
          setDeclineTargetId(null);
          setDeclineReason("");
          toast({
            title:
              action === "DECLINE"
                ? "Change request declined"
                : action === "APPROVE_NEXT_DELIVERY"
                  ? "Approved — drafted onto the next delivery"
                  : "Approved — merged into this order",
            variant: "success",
          });
        },
        onError: (err: any) => {
          const code = err?.response?.data?.code;
          if (code === "CHANGE_REQUEST_ALREADY_RESOLVED") {
            toast({
              title: "Already resolved",
              description:
                "This request was just resolved elsewhere (likely by the driver) — showing the latest state.",
              variant: "error",
            });
            setDeclineTargetId(null);
          } else if (code === "STOP_ALREADY_COMPLETED") {
            toast({
              title: "Stop already completed",
              description:
                "Too late to change today's delivery — approve as next delivery instead.",
              variant: "error",
            });
          } else if (code === "LINE_ALREADY_DELIVERED") {
            toast({
              title: "Line already delivered",
              description: "The driver has delivered this line — it can no longer be changed.",
              variant: "error",
            });
          } else if (code === "CHANGE_WINDOW_CLOSED") {
            toast({
              title: "Delivery run no longer active",
              description: "The run has ended — this request can only be declined.",
              variant: "error",
            });
          } else {
            guardError(run)(err);
          }
        },
      },
    );
  run();
}
```

- **exact code — header chip.** Directly after the P5-08 revision-count chip block (ends line ~1675), add:

```tsx
{
  /* P5-11: pending post-dispatch change requests awaiting resolution. */
}
{
  !isEditing && pendingChangeRequests.length > 0 && (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
      {pendingChangeRequests.length} change request
      {pendingChangeRequests.length > 1 ? "s" : ""} pending
    </span>
  );
}
```

- **exact code — the card.** In the main column (`<div className="space-y-5 lg:col-span-2">`), between the Line Items card's closing `</div>` (line ~2279) and the Notes `Card`, add:

```tsx
{
  /* P5-11: post-dispatch change requests + office resolution. */
}
{
  !isEditing && changeRequests.length > 0 && (
    <Card
      title={`Change Requests${
        pendingChangeRequests.length > 0 ? ` (${pendingChangeRequests.length} pending)` : ""
      }`}
    >
      <ul className="divide-y divide-surface-border">
        {changeRequests.map((cr) => {
          const { title, detail } = describeChangeRequest(cr, order.lineItems);
          const outcome = describeResolution(cr);
          const busy = resolveCr.isPending && resolveCr.variables?.crId === cr.id;
          // Next-delivery is server-valid only for ADD_ITEM and
          // CHANGE_QTY increases — hide it otherwise (400 INVALID_RESOLUTION_FOR_TYPE).
          const currentLine = order.lineItems.find(
            (li) => li.id === (cr.orderItemId ?? cr.payload.orderItemId),
          );
          const canNextDelivery =
            cr.type === "ADD_ITEM" ||
            (cr.type === "CHANGE_QTY" &&
              Number(cr.payload.newQty ?? 0) > Number(currentLine?.qty ?? Infinity));
          return (
            <li key={cr.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-navy">{title}</p>
                  {detail && <p className="mt-0.5 text-xs text-navy/70">{detail}</p>}
                  <p className="mt-0.5 text-[11px] text-navy/50">
                    {cr.requestedByName ?? cr.requestedByRole ?? "Requester"} ·{" "}
                    {new Date(cr.createdAt).toLocaleString()}
                  </p>
                  {outcome && (
                    <p
                      className={`mt-1 text-xs font-medium ${
                        cr.status === "DECLINED" ? "text-danger" : "text-success"
                      }`}
                    >
                      {outcome}
                      {cr.resolvedByName ? ` · by ${cr.resolvedByName}` : ""}
                    </p>
                  )}
                </div>
                <Badge status={cr.status} />
              </div>
              {cr.status === "PENDING" &&
                (declineTargetId === cr.id ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={declineReason}
                      onChange={(e) => setDeclineReason(e.target.value)}
                      placeholder="Decline reason (required, shown to the requester)"
                      maxLength={1000}
                      className="h-8 min-w-[240px] flex-1 rounded border border-surface-border bg-white px-2 text-sm text-navy placeholder:text-navy/50 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={!declineReason.trim() || busy}
                      loading={busy && resolveCr.variables?.action === "DECLINE"}
                      onClick={() => handleResolve(cr, "DECLINE", declineReason.trim())}
                    >
                      Decline
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setDeclineTargetId(null);
                        setDeclineReason("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={busy}
                      loading={busy && resolveCr.variables?.action === "APPROVE_AT_STOP"}
                      onClick={() => handleResolve(cr, "APPROVE_AT_STOP")}
                    >
                      Approve at stop
                    </Button>
                    {canNextDelivery && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        loading={busy && resolveCr.variables?.action === "APPROVE_NEXT_DELIVERY"}
                        onClick={() => handleResolve(cr, "APPROVE_NEXT_DELIVERY")}
                      >
                        Approve as next delivery
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy}
                      onClick={() => {
                        setDeclineTargetId(cr.id);
                        setDeclineReason("");
                      }}
                    >
                      Decline…
                    </Button>
                  </div>
                ))}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
```

Refetch behavior: no manual refetch code is needed here — `useResolveChangeRequest`'s `onSettled` invalidates `["orders", orderId]` on success and error, and `useOrder` re-renders the page with merged totals / final CR state (this is also the lost-race recovery).

---

### WP5 — Orders list: pending-CR row badge (P5-11)

- **files:** `apps/web/app/(dashboard)/orders/page.tsx`
- **effort:** low
- **brief:** In the row renderer, replace the status cell (lines 713-715) so a compact amber pill with the pending count sits next to the status `Badge`. Reads the filtered relation count `order._count?.changeRequests` supplied by WP6; when the field is absent (older API) the pill simply never renders — no per-row fetching (a per-visible-row `GET /orders/:id/change-requests` would be an N+1 of up to 20 requests per page view against the global throttler; rejected).
- **exact code — replace the status `<td>`:**

```tsx
<td className="px-4 py-3">
  <div className="flex items-center gap-1.5">
    <Badge status={order.status} />
    {/* P5-11: pending post-dispatch change requests on this order
                            (filtered _count from the list endpoint; absent = no pill). */}
    {(order._count?.changeRequests ?? 0) > 0 && (
      <span
        title={`${order._count!.changeRequests} pending change request${
          (order._count!.changeRequests ?? 0) > 1 ? "s" : ""
        }`}
        className="inline-flex h-[21px] items-center rounded-full bg-amber-50 px-2 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200"
      >
        {order._count!.changeRequests} change
        {(order._count!.changeRequests ?? 0) > 1 ? "s" : ""}
      </span>
    )}
  </div>
</td>
```

No other change to this file (filters, saved views, CSV export, bulk actions untouched).

---

### WP6 — Additive API: PENDING-CR count on the orders list + spec

- **files:** `apps/api/src/orders/orders.service.ts`, `apps/api/src/orders/orders.service.spec.ts`
- **effort:** low
- **brief:** One additive include in `findAll` (orders.service.ts:189-201): a Prisma **filtered relation count** so each list row carries `_count.changeRequests` = the number of PENDING change requests. `ChangeRequestStatus` is already imported (line 33). **Touch nothing else in this file** — `findOne`, `updateOrderItems`, `approveChangeRequestAtStop`, `completeStop` and all guards stay byte-identical. Older/mobile clients ignore the extra `_count` key (additive).
- **exact code — the `include` in `findAll` becomes:**

```ts
        include: {
          customer: { select: { id: true, businessName: true } },
          lineItems: { include: { product: { select: { id: true, name: true, unit: true } } } },
          // P5-11: pending change-request count for the orders-list badge.
          // Filtered relation count — additive; clients that don't know
          // `_count` ignore it.
          _count: {
            select: {
              changeRequests: { where: { status: ChangeRequestStatus.PENDING } },
            },
          },
        },
```

- **exact code — spec.** Append inside the existing `describe("findAll", ...)` block in `orders.service.spec.ts` (harness already provides `prisma` from `createMockPrisma()` and `operatorPayload`; existing tests must pass unmodified):

```ts
it("includes a PENDING-filtered change-request count for the list badge (P5-11)", async () => {
  prisma.order.findMany.mockResolvedValue([]);
  prisma.order.count.mockResolvedValue(0);

  await service.findAll({ page: 1, limit: 20 }, operatorPayload);

  expect(prisma.order.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      include: expect.objectContaining({
        _count: { select: { changeRequests: { where: { status: "PENDING" } } } },
      }),
    }),
  );
});
```

---

### WP7 — Code map update

- **files:** `.claude/code-map/web.md`, `.claude/code-map/api.md`, `.claude/code-map/_meta.json`
- **effort:** low
- **brief:** Surgical edits, run after all other WPs:
  - `web.md` -> in the **Orders/fulfillment** bullet, append to the `orders/[id]/page.tsx` description: "**P5-11**: 'Change Requests' card (main column) resolves PENDING post-dispatch CRs — Approve at stop / Approve as next delivery (ADD_ITEM + CHANGE_QTY-increase only) / Decline (reason required) via `useResolveChangeRequest`; lost 409 race (`CHANGE_REQUEST_ALREADY_RESOLVED`) -> toast + refetch, never retry; `REGULATED_AUTH_REQUIRED` routes into the existing LicenseGuardModal retry; header amber 'N pending' chip." Append to `orders/page.tsx`: "amber pending-CR pill next to the status badge (reads `_count.changeRequests` from the list payload)."
  - `web.md` -> **buyer portal** section, `orders/[id]` entry: "+ **P5-10** 'Request a change' modal on dispatched orders (run IN_PROGRESS; no prices shown by design) -> `POST /buyer/orders/:id/change-requests`; CR status chips PENDING/APPROVED/DECLINED from `order.changeRequests`; buyer `canEdit` now honors `editWindow`."
  - `web.md` -> **App shell & lib** section: add "**`lib/change-requests.ts`** — shared web ChangeRequest type + `describeChangeRequest`/`describeResolution` (pure, no HTTP client; consumed by both operator and buyer order-detail). CR 409 codes added to providers.tsx HANDLED_CODES."
  - `web.md` -> **API hooks table**: `orders.ts` row += `useResolveChangeRequest`; `buyer.ts` row += `useBuyerCreateChangeRequest`.
  - `api.md` -> in the orders section's P5-09 entry, append: "P5-11: `findAll` include gained a PENDING-filtered `_count.changeRequests` (list-badge count, additive)."
  - `_meta.json` -> set `mappedSha` to the implementation commit's short SHA and `generatedAt` to the current date, matching the existing format.

## Acceptance criteria

1. `apps/web/lib/change-requests.ts` exists with the exact exports `ChangeRequestType`, `ChangeRequestStatus`, `ChangeRequestResolution`, `ChangeRequestResolveAction`, `ChangeRequest`, `describeChangeRequest`, `describeResolution`, and imports **no** HTTP client / axios / react-query.
2. `app/providers.tsx` `HANDLED_CODES` contains exactly the two original codes plus `CHANGE_REQUEST_ALREADY_RESOLVED`, `STOP_ALREADY_COMPLETED`, `LINE_ALREADY_DELIVERED`, `CHANGE_WINDOW_CLOSED`, `EDIT_WINDOW_OPEN`; nothing else in the file changed.
3. Web `Order` type gained **optional** `changeRequests?` and `_count?.changeRequests?`; `BuyerOrder` gained **optional** `changeRequests?`, `editWindow?`, `routeRun?`. No previously-required field changed — the UI compiles and renders against an older API payload lacking all of them (all consumers null-guard with `??`/`?.`).
4. `useResolveChangeRequest` POSTs `/orders/${orderId}/change-requests/${crId}/resolve` with body `{ action, reason }` and invalidates `["orders", orderId]` + `["orders"]` in `onSettled` (i.e. on success **and** error).
5. `useBuyerCreateChangeRequest` POSTs `/buyer/orders/${orderId}/change-requests` with `{ type, productId?, orderItemId?, qty?, note? }` (CHANGE_QTY sends the new **absolute** qty in `qty`) and invalidates `["buyer", "order", orderId]`.
6. Buyer order-detail: `canEdit` is now `(status DRAFT|PENDING) && (editWindow?.editable ?? true)`; the "Request a change" button renders exactly when `!canEdit && order.routeRun?.status === "IN_PROGRESS" && order.status in {PENDING, CONFIRMED, OUT_FOR_DELIVERY}` and not in edit mode. The modal validates per type (ADD_ITEM: product+qty>=1; CHANGE_QTY: line+qty>=1; REMOVE_ITEM: line; NOTE: non-empty note), offers only non-cancelled lines with `deliveredQty === 0`, and **renders no monetary value anywhere inside the modal** (grep the modal JSX: no `buyerPrice`, no `fmt(`, no `$`). 409 `EDIT_WINDOW_OPEN` and `CHANGE_WINDOW_CLOSED` show the friendly in-modal copy specified in WP3 (not the raw server message); success closes the modal, fires a success toast, and the new PENDING chip appears after the invalidation refetch.
7. Buyer order-detail renders a "Change requests" card (only when `order.changeRequests` is non-empty) listing newest-first rows with `<Badge status={cr.status} />` (PENDING amber / APPROVED green / DECLINED red), the `describeChangeRequest` title (CHANGE_QTY/REMOVE_ITEM labelled via the order's line items), and `describeResolution` outcome including the decline reason.
8. Operator order-detail: header shows the amber "N change request(s) pending" chip when pending CRs exist (and `!isEditing`); the "Change Requests" card lists all CRs with resolve buttons **only on PENDING rows**; "Approve as next delivery" is hidden for REMOVE_ITEM/NOTE and for CHANGE_QTY non-increases; Decline requires a non-empty reason (button disabled otherwise) and sends it as `reason`; a 409 `CHANGE_REQUEST_ALREADY_RESOLVED` produces the "Already resolved" toast and a refetch **with no retry**; `REGULATED_AUTH_REQUIRED` opens the existing `LicenseGuardModal` with a working retry via `guardError`; `STOP_ALREADY_COMPLETED`/`LINE_ALREADY_DELIVERED`/`CHANGE_WINDOW_CLOSED` each produce their specified toast. All P5-08 behavior (canEdit derivation, "Out for delivery — editing closed" chip, "Edited N×" chip, price editing, publish/confirm/cancel/delete flows) is unchanged in the diff.
9. Orders list: the amber pill with the pending count renders next to the status `Badge` only when `order._count?.changeRequests > 0`; rows without the field render exactly as before.
10. API: the only `apps/api` production-code change in the diff is the `_count` filtered-include in `findAll`; the new spec passes and **all pre-existing specs pass unmodified** (`npx jest orders` green).
11. No new money computation exists anywhere in the diff (no `qty * unitPrice`, no `computeLineSubtotal` calls added, no invoice/total arithmetic).
12. No new npm dependencies; no files under `apps/mobile` touched; no `*.test.tsx`/`*.spec.tsx` created under `apps/web`; no new files under `apps/web/e2e`.
13. Code map: `web.md` + `api.md` entries updated per WP7 and `_meta.json` `mappedSha`/`generatedAt` bumped.

## Verification commands

From `C:\ClaudeCode\routeflow`:

1. `cd apps/web && npx tsc --noEmit`
2. `cd apps/web && npx next lint`
3. `cd apps/api && npx jest orders.service` (findAll `_count` spec + all pre-existing orders suites)
4. `npm run verify` (root — turbo check-types + lint + test across workspaces)

No dev server, DB, or prod operation is required. Do not run Playwright against production for this change.

## Risks & rollback

1. **The resolve 409 lost-race UX (top risk).** The server's G6 lock means the office can lose to the driver at the stop. Review checklist: (a) the mutation **never retries** on `CHANGE_REQUEST_ALREADY_RESOLVED` — the only follow-up is toast + invalidation; (b) invalidation happens in `onSettled` (not just `onSuccess`) so the lost race refreshes the CR to its winning state and pulls the merged totals; (c) the raw 409 must not surface as a second, cryptic global toast — that's what the providers.tsx `HANDLED_CODES` additions are for (body has no `message`; missing this yields an "Request failed with status code 409" toast). Watch for a WP1/WP4 mismatch on code strings.
2. **No drifting price in the buyer form.** The single most reviewable money rule here: the request modal (and the CR chips) must show **no price at all** — not even the catalog `buyerPrice` already present in the search-result data. Any price preview would be a second pricing path that disagrees with the server's tier->sticky->promo merge price. If review finds a `$`/`fmt(`/`buyerPrice` render inside the modal or chips, that's a blocker.
3. **Not breaking existing order-detail behavior.** Both order-detail pages are large and load-bearing (P5-08 edit window, license guard retry refs, draft auto-edit, invoice split). The additions are strictly additive JSX blocks + new state; review should diff-check that no existing line inside the edit/save/publish/guard paths changed. The buyer `canEdit` tightening is the one deliberate behavior change: Edit Items (and Cancel Order, which derives from it) now hides once the run dispatches — this matches the server, which would 409 those actions anyway; verify the fallback `?? true` keeps old-API behavior.
4. **HANDLED_CODES suppression breadth.** The five added codes are globally suppressed from the generic mutation toast. They are CR-specific today, but if a future surface throws them without local handling, errors would be silent — the comment in providers.tsx must state this.
5. **Filtered relation count (`_count` + `where`)** is GA in Prisma 7 and the mock-based spec only asserts the call shape, not engine behavior. If runtime behaves unexpectedly (wrong counts), the fallback is an explicit `changeRequest.groupBy` batched by order ids — flag in review if anything smells off; do not silently switch approaches.
6. **Parallel-WP compile coupling.** WP3/WP4/WP5 import WP1's new module and WP2's hook; a partial landing fails `tsc` until wave 1 is in. The orchestrator should land WP1/WP2/WP6 before verifying wave 2 — the final `npm run verify` is the gate.
7. **Rollback:** revert the branch's commits. Web-only UI plus one additive API include and additive types — no migration, no data mutation, nothing to unwind server-side.

## Out of scope (explicit)

- **Mobile driver-at-stop resolve UI** — P10 mobile wave (the API is ready; `apps/mobile` untouched here).
- Realtime push of new CRs into the operator dashboard (socket invalidation) — the list/detail refresh on navigation/invalidation; P6-5 notification wiring is a later increment.
- A Playwright e2e for the CR flows (read-only-vs-production harness constraint; possible later as a mocked-route spec).

## Status

DRAFT — ready for the implement→review pipeline.
