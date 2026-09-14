/**
 * The pure half of the order-item editor (`app/(operator)/(tabs)/orders/[id]/edit-items.tsx`).
 *
 * Everything here is a derivation over the staged edit: what Save would send,
 * whether there is anything to send, the on-device snapshot that keeps the
 * operator's work across a leave, and the rows the picker's pull-out drawer
 * renders. It exists because the screen previously derived each of those
 * inline, where the mobile Jest lane (`jest.config.js` — `testEnvironment:
 * "node"`) can never reach them.
 *
 * PURITY IS A CONTRACT, not a preference: this module must NEVER import
 * `react-native` or `@react-native-async-storage/async-storage`. The screen
 * owns every `getItem`/`setItem`/`removeItem`; this module only shapes and
 * validates the payload. `__tests__/edit-items-drawer.test.ts` pins that.
 *
 * MONEY: no subtotal is derived here. `draftTrayRows` delegates to
 * `lib/scan-tray.ts#trayRowsFrom`, which is the one place a tray row's money
 * comes from (`@routeflow/pricing#computeLineSubtotal`), and it threads the
 * screen's BUY_N_GET_M netting through so the drawer, the line card and the
 * footer cannot disagree.
 */
import { roundMoney, effectiveQty } from "@routeflow/pricing";
import {
  buildOrderItemDiff,
  type DiffCatalogLine,
  type DiffUnlistedLine,
  type OriginalLine,
} from "./order-item-diff";
import { editedLineFreeUnits } from "./invoice-totals";
import { trayRowsFrom, type TrayRow } from "./scan-tray";
import type { UpdateOrderItemInput } from "./api/orders";

/**
 * One row of the in-progress edit. `qty` is total pieces (server's source of
 * truth). For products with `unitsPerBox > 1` operators may also set
 * `boxes`/`pieces` and the server recomputes qty + uses BOX-price proration
 * (see apps/api/src/orders/orders.service.ts:594).
 */
export type DraftItem = {
  productId: string;
  qty: number;
  boxes?: number;
  pieces?: number;
  unitsPerBox?: number | null;
  unitPrice: number;
  /** The customer's tier/base price — new lines send an override only if unitPrice diverges. */
  catalogPrice: number;
  name: string;
  unit?: string;
  overrideReason?: string;
  /** Per-line note (buyer-visible) — must round-trip through the save. */
  notes?: string;
  /** Original DB line id; undefined = added this session. */
  lineId?: string;
  /** The line was stored with a box split — send boxes/pieces on save only then. */
  boxSplit?: boolean;
  /** Set when this row substitutes a different product onto its original line. */
  substituteProductId?: string;
  /**
   * Per-piece average cost + category — drives the live margin hint
   * (pos-cost-roles-spec §1). Only `averageCost` is available here (the
   * order's embedded product `select` doesn't include `standardCost`, unlike
   * the separate `/products` list `NewOrderScreen` reads from) — rows with no
   * average cost yet (never sold) simply show no hint.
   */
  averageCost?: number | string | null;
  category?: string | null;
  /** UI-only qty entry mode for a case-packed line. NEVER submitted — the
   *  diff always carries {qty, boxes, pieces} and the per-case unitPrice. */
  sellBy?: "case" | "unit";
  /**
   * BUY_N_GET_M snapshot on the loaded line + the whole selling-unit count it
   * was earned at. The preview MUST net these off or a BOGO line shows at full
   * price and disagrees with both the stored subtotal and what the server
   * re-derives on save (mirrors web's order edit builder).
   */
  promoFreeUnits?: number | null;
  promoBaseUnits?: number | null;
};

/**
 * A new ad-hoc (unlisted) line being added in this edit session. Serialised as
 * `{ name, qty, unitPrice }` on save (no productId; never boxed). Existing
 * unlisted lines on the order are NOT loaded here (the replace-all edit only
 * re-sends catalog lines + any newly added unlisted lines).
 */
export type UnlistedDraft = {
  id: string;
  name: string;
  unitPrice: number;
  qty: number;
  /** Per-line note (buyer-visible) — must round-trip through the save. */
  notes?: string;
  /** Original DB line id for an existing unlisted line; undefined = new. */
  lineId?: string;
};

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * BUY_N_GET_M free units for THIS draft row, rescaled to the qty now on screen
 * (shared helper, same rule as the invoice edit form and the server's
 * `rescaleBogoFreeUnits` fallback). A pending SUBSTITUTION earns nothing — the
 * snapshot belongs to the product being replaced, and undoing it restores them.
 */
export function draftFreeUnits(
  item:
    | Pick<DraftItem, "substituteProductId" | "promoFreeUnits" | "promoBaseUnits" | "boxes" | "qty">
    | undefined,
): number {
  if (!item) return 0;
  if (item.substituteProductId) return 0;
  return editedLineFreeUnits({
    promoFreeUnits: item.promoFreeUnits,
    promoBaseUnits: item.promoBaseUnits,
    boxes: item.boxes ?? null,
    qty: item.qty,
  });
}

/** Everything the operator has staged on the editor, in one shape. */
export interface StagedEdit {
  draft: Record<string, DraftItem>;
  unlisted: readonly UnlistedDraft[];
  pendingDeletes: readonly string[];
  selectedCreditIds: readonly string[];
  creditsTouched: boolean;
  /** `lineId ?? productId` of every line acked as "sell anyway" below the floor. */
  floorAcked: readonly string[];
}

// ─── What Save sends ─────────────────────────────────────────────────────────

/** A server line as the editor reads it back (only the fields the diff uses). */
export interface BaselineLine {
  id: string;
  productId?: string | null;
  qty: number | string;
  unitPrice: number | string;
  name?: string | null;
  notes?: string | null;
  status?: string | null;
}

export interface BaselineOrderLike {
  id?: string;
  updatedAt?: string | null;
  lineItems?: readonly BaselineLine[] | null;
}

/**
 * The order's non-cancelled lines as `buildOrderItemDiff` compares against.
 * Exported so the dirty check and the save share ONE derivation — a second
 * hand-rolled comparison is how "Save changes" and "are there changes?" drift.
 */
export function orderOriginals(order: BaselineOrderLike | null | undefined): OriginalLine[] {
  return (order?.lineItems ?? [])
    .filter((li) => li.status !== "CANCELLED")
    .map((li) => ({
      id: li.id,
      productId: li.productId ?? null,
      qty: toNumber(li.qty),
      unitPrice: toNumber(li.unitPrice),
      name: li.name ?? null,
      notes: li.notes ?? null,
    }));
}

/**
 * EXACTLY the mapping the screen's `save()` used to inline: draft rows to
 * `DiffCatalogLine`, unlisted rows to `DiffUnlistedLine`, then
 * `buildOrderItemDiff` with the explicit trash set and no pending cancels.
 * `save()` now calls this, so the dirty check below can never claim a change
 * the payload doesn't carry (or miss one it does).
 */
export function stagedDiffItems(
  staged: Pick<StagedEdit, "draft" | "unlisted" | "pendingDeletes">,
  originals: OriginalLine[],
): UpdateOrderItemInput[] {
  const catalog: DiffCatalogLine[] = Object.values(staged.draft).map((i) => ({
    lineId: i.lineId,
    productId: i.productId,
    qty: effectiveQty(i, i.unitsPerBox),
    boxes: i.boxes ?? null,
    pieces: i.pieces ?? null,
    boxSplit: !!i.boxSplit,
    unitPrice: i.unitPrice,
    basePrice: i.catalogPrice,
    overrideReason: i.overrideReason,
    substituteProductId: i.substituteProductId,
    notes: i.notes,
  }));
  const unlistedLines: DiffUnlistedLine[] = staged.unlisted.map((u) => ({
    lineId: u.lineId,
    name: u.name,
    qty: u.qty,
    unitPrice: u.unitPrice,
    notes: u.notes,
  }));
  return buildOrderItemDiff({
    catalog,
    unlisted: unlistedLines,
    originals,
    pendingDeletes: [...staged.pendingDeletes],
    pendingCancels: [],
  });
}

/** True when Save would send at least one line action. */
export function hasUnsavedItemEdits(
  staged: Pick<StagedEdit, "draft" | "unlisted" | "pendingDeletes">,
  originals: OriginalLine[],
): boolean {
  return stagedDiffItems(staged, originals).length > 0;
}

/**
 * Items OR a touched credit selection — the leave/flush trigger. `save()`
 * still sends when `items.length === 0 && creditsTouched`, so a credits-only
 * edit is unsaved work too.
 */
export function hasUnsavedWork(staged: StagedEdit, originals: OriginalLine[]): boolean {
  return staged.creditsTouched || hasUnsavedItemEdits(staged, originals);
}

/**
 * Whether the editor's `[order]` hydration effect may overwrite the staged edit
 * with what the server just returned.
 *
 * The effect used to be unconditional, so ANY background refetch of the order
 * (a window focus, a cache invalidation, a socket push) re-ran `setDraft` from
 * the server and silently discarded staged work — and because the restore
 * effect is one-shot it could not put it back, while the autosave effect then
 * saw a clean draft and took its `removeItem` branch, destroying the on-disk
 * copy too. Three rules, in order:
 *
 *  - `!hydrated` — the FIRST hydration always runs. It has to: on the render
 *    where `order` first arrives the draft is still empty, so `dirty` is TRUE
 *    (every server line reads as a removal through `buildOrderItemDiff`'s
 *    dropped-line rule) and a bare dirty check would leave the editor blank.
 *  - `justSaved` — the refetch that follows a successful save IS the new truth;
 *    the staged edit is already on the server.
 *  - otherwise a refetch may only re-hydrate a CLEAN editor.
 */
export function shouldRehydrateFromOrder(input: {
  /** This order has already been hydrated into the draft once. */
  hydrated: boolean;
  /** `hasUnsavedWork` as of the render that preceded the effect. */
  dirty: boolean;
  /** A save has succeeded on this screen (the screen's `savedRef`). */
  justSaved: boolean;
}): boolean {
  if (!input.hydrated) return true;
  if (input.justSaved) return true;
  return !input.dirty;
}

// ─── The on-device snapshot ──────────────────────────────────────────────────

export const EDIT_ITEMS_SNAPSHOT_VERSION = 1;
/** Same TTL shape as `lib/list-ui-snapshot.ts`; a day-old staged edit is stale. */
export const EDIT_ITEMS_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
/** Idle debounce before a snapshot write, matching the stock-count autosave. */
export const EDIT_ITEMS_AUTOSAVE_DEBOUNCE_MS = 900;

/**
 * Fingerprint of the server lines the staged edit was diffed against: the
 * non-CANCELLED lines, sorted by id, over exactly the fields
 * `buildOrderItemDiff` measures a change on. Numbers are normalised (and the
 * price rounded) so `"8.00"` and `8` fingerprint identically.
 *
 * This is the staleness gate rather than `order.updatedAt`, which bumps on
 * order-level writes (a status change, a fulfil path) that do not invalidate
 * a staged LINE edit at all.
 */
export function snapshotBaseline(order: BaselineOrderLike | null | undefined): string {
  return (order?.lineItems ?? [])
    .filter((li) => li.status !== "CANCELLED")
    .map((li) => ({
      id: String(li.id ?? ""),
      productId: li.productId ?? "",
      qty: toNumber(li.qty),
      unitPrice: roundMoney(toNumber(li.unitPrice)),
      name: (li.name ?? "").trim(),
      notes: (li.notes ?? "").trim(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((l) => `${l.id}|${l.productId}|${l.qty}|${l.unitPrice}|${l.name}|${l.notes}`)
    .join(";");
}

export interface EditItemsSnapshot {
  v: number;
  orderId: string;
  savedAt: number;
  baseline: string;
  /** Diagnostics only — never the staleness gate (see `snapshotBaseline`). */
  orderUpdatedAt?: string | null;
  draft: Record<string, DraftItem>;
  unlisted: UnlistedDraft[];
  pendingDeletes: string[];
  selectedCreditIds: string[];
  creditsTouched: boolean;
  floorAcked: string[];
}

export function makeEditItemsSnapshot(args: {
  orderId: string;
  staged: StagedEdit;
  baseline: string;
  orderUpdatedAt?: string | null;
  now?: number;
}): EditItemsSnapshot {
  return {
    v: EDIT_ITEMS_SNAPSHOT_VERSION,
    orderId: args.orderId,
    savedAt: args.now ?? Date.now(),
    baseline: args.baseline,
    orderUpdatedAt: args.orderUpdatedAt ?? null,
    draft: args.staged.draft,
    unlisted: [...args.staged.unlisted],
    pendingDeletes: [...args.staged.pendingDeletes],
    selectedCreditIds: [...args.staged.selectedCreditIds],
    creditsTouched: args.staged.creditsTouched,
    floorAcked: [...args.staged.floorAcked],
  };
}

export function serializeEditItemsSnapshot(snapshot: EditItemsSnapshot): string {
  return JSON.stringify(snapshot);
}

/**
 * Parse a stored snapshot. NEVER throws: anything unparseable, of the wrong
 * version, or structurally wrong returns null, because a corrupt blob on disk
 * must degrade to "no restore offered", never to a crashed editor.
 */
export function deserializeEditItemsSnapshot(
  raw: string | null | undefined,
): EditItemsSnapshot | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const s = parsed as Partial<EditItemsSnapshot>;
  if (s.v !== EDIT_ITEMS_SNAPSHOT_VERSION) return null;
  if (typeof s.orderId !== "string" || !s.orderId) return null;
  if (typeof s.savedAt !== "number" || !Number.isFinite(s.savedAt)) return null;
  if (typeof s.baseline !== "string") return null;
  if (!s.draft || typeof s.draft !== "object" || Array.isArray(s.draft)) return null;
  if (!Array.isArray(s.unlisted)) return null;
  if (!Array.isArray(s.pendingDeletes)) return null;
  if (!Array.isArray(s.selectedCreditIds)) return null;
  if (!Array.isArray(s.floorAcked)) return null;
  return {
    v: s.v,
    orderId: s.orderId,
    savedAt: s.savedAt,
    baseline: s.baseline,
    orderUpdatedAt: s.orderUpdatedAt ?? null,
    draft: s.draft as Record<string, DraftItem>,
    unlisted: s.unlisted as UnlistedDraft[],
    pendingDeletes: s.pendingDeletes as string[],
    selectedCreditIds: s.selectedCreditIds as string[],
    creditsTouched: !!s.creditsTouched,
    floorAcked: s.floorAcked as string[],
  };
}

/**
 * A snapshot is stale — never auto-applied, only offered for discard — when
 * the order is unknown, the ids disagree, the TTL has run out, or the server
 * lines it was diffed against have changed underneath it.
 */
export function isSnapshotStale(
  snapshot: EditItemsSnapshot | null | undefined,
  order: BaselineOrderLike | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!snapshot) return true;
  if (snapshot.v !== EDIT_ITEMS_SNAPSHOT_VERSION) return true;
  if (!order) return true;
  if (order.id && order.id !== snapshot.orderId) return true;
  if (now - snapshot.savedAt >= EDIT_ITEMS_SNAPSHOT_TTL_MS) return true;
  return snapshotBaseline(order) !== snapshot.baseline;
}

/**
 * The storage key. User-scoped (one operator's staged edit must never surface
 * under the next login — B136/B137/B140) and ORDER-scoped (the same component
 * is mounted by the operator route and the driver stop route, and an operator
 * edits several orders per session). The `anon` fallback mirrors
 * `lib/user-scoped-storage.ts` WITHOUT importing it: that module imports
 * AsyncStorage at the top level, which this module may not.
 */
export function editItemsSnapshotKey(orderId: string, userId: string | null | undefined): string {
  return `${editItemsSnapshotUserPrefix(userId)}${orderId}`;
}

/**
 * The shared stem of every staged-edit key. Bumped with
 * {@link EDIT_ITEMS_SNAPSHOT_VERSION} whenever the stored shape changes.
 */
export const EDIT_ITEMS_SNAPSHOT_KEY_PREFIX = "rf.edit-items.v1";

/**
 * Every staged-edit key one user can own, as a prefix.
 *
 * This snapshot is a KEYSPACE, not a single blob: one key PER ORDER, so
 * sign-out cannot delete it with a `clearUserScopedStorage(NAME, userId)` call
 * the way the zustand-persisted stores do (RULINGS R1). `lib/session-teardown.ts`
 * enumerates `AsyncStorage.getAllKeys()` and removes everything under this
 * prefix instead, so one operator's staged order edit can never surface under
 * the next login on a shared device (the B136/B137/B140 class).
 *
 * Ends with the separator on purpose — `"...:u1:"` must never match a user id
 * that merely starts with `u1`.
 */
export function editItemsSnapshotUserPrefix(userId: string | null | undefined): string {
  return `${EDIT_ITEMS_SNAPSHOT_KEY_PREFIX}:${userId ?? "anon"}:`;
}

// ─── The picker's pull-out drawer ────────────────────────────────────────────

/**
 * The drawer's rows, newest-scanned first — `lib/scan-tray.ts#trayRowsFrom`
 * verbatim, so `<ScanTray/>` renders the order-edit surface with the exact
 * derivation the sale builders use.
 *
 * `overridable: () => true` is correct HERE (unlike NewOrderScreen's
 * `isSpecialFor` gate): on the EDIT surface the line's stored `unitPrice` is
 * what the order actually charges — it came back from the server on that line.
 * `freeUnitsFor` threads the screen's BUY_N_GET_M netting in, so a promo line's
 * drawer subtotal matches its card and the footer.
 */
export function draftTrayRows(input: {
  draft: Record<string, DraftItem>;
  unlisted: readonly UnlistedDraft[];
  scanOrder: readonly string[];
}): TrayRow[] {
  return trayRowsFrom({
    items: input.draft,
    unlisted: input.unlisted.map((u) => ({
      id: u.id,
      name: u.name,
      qty: u.qty,
      unitPrice: u.unitPrice,
    })),
    scanOrder: input.scanOrder,
    lookup: (id) => {
      const it = input.draft[id];
      return it ? { id, name: it.name, unitsPerBox: it.unitsPerBox ?? null } : undefined;
    },
    priceFor: (product) => input.draft[product.id]?.catalogPrice ?? 0,
    overridable: () => true,
    freeUnitsFor: (id) => draftFreeUnits(input.draft[id]),
  });
}

/** The collapsed drawer is a grab handle and nothing else. */
export const PICKER_TRAY_HANDLE_HEIGHT = 56;

/**
 * Expanded drawer height that never covers the camera's viewfinder.
 *
 * `components/BarcodeScanner.tsx` fixes that geometry: the clear window is
 * `SCREEN_WIDTH * 0.7` tall and its top dark band is
 * `(SCREEN_HEIGHT - WINDOW_SIZE) / 2 - 40`, so the viewfinder's bottom edge
 * sits at `topBand + WINDOW_SIZE` and everything below it is the camera's dark
 * hint band — which is exactly the space the drawer may take.
 */
export function pickerTrayExpandedHeight(win: { width: number; height: number }): number {
  const scanWindow = win.width * 0.7;
  const viewfinderBottom = (win.height - scanWindow) / 2 - 40 + scanWindow;
  // FLOOR, not round: at 390x844 the free band is 325.5px and `Math.round`
  // would return 326 — half a pixel of drawer over the viewfinder's edge.
  return Math.max(
    200,
    Math.min(Math.round(win.height * 0.55), Math.floor(win.height - viewfinderBottom)),
  );
}
