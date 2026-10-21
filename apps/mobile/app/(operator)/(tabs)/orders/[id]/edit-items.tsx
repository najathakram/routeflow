import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useAdminOrder } from "../../../../../lib/api/admin";
import { handleOrderOverpay } from "../../../../../lib/order-overpay-prompt";
import { UnitPickerRow } from "../../../../../components/UnitPickerRow";
import { OrderAppliedCredits } from "../../../../../components/OrderAppliedCredits";
import type { UnitOption } from "../../../../../lib/unit-options";
import { useCreditNotes, type CreditNote } from "../../../../../lib/api/credit-notes";
import { useCustomerPriceHistory, useUpdateOrderItems } from "../../../../../lib/api/orders";
import { useInlineReturnsAddon } from "../../../../../lib/api/addons";
import { useCustomer, useCustomerPrices } from "../../../../../lib/api/customers";
import { showToast } from "../../../../../lib/toast";
import { FAMILY_ADD_MESSAGE, isFamilyProduct } from "../../../../../lib/sellable-products";
import { confirm } from "../../../../../lib/confirm";
import { effectiveQty, type SellLevel } from "@routeflow/pricing";
import { useEditItemsTrayHandlers } from "../../../../../hooks/useEditItemsTrayHandlers";
import { PriceLayerGateNotice } from "../../../../../components/PriceLayerGateNotice";
import { draftTotal } from "../../../../../lib/edit-items-total";
import { buildCreditRows } from "../../../../../lib/edit-items-credit-rows";
import { useCustomerPriceLayer } from "../../../../../lib/api/price-layer";
import {
  lineIsSpecial,
  optionWithLayerPrice,
  packIsSpecial,
  packLinePrice,
  type PriceProduct,
} from "../../../../../lib/cart-order-total";
import { priceLayerGate, pricingReadyWithLayer } from "../../../../../lib/price-layer-gate";
import { marginFloorPrice } from "../../../../../lib/margin-floor-price";
import { isUnitLine, setLineUnits } from "../../../../../lib/sale-line";
import { buildSubstituteLine } from "../../../../../lib/substitute-line";
import { useMarginConfig, floorForCategory } from "../../../../../lib/api/margin";
import {
  draftTrayRows,
  applyBoxEdit,
  applyPieceEdit,
  applyUnitPick,
  buildPackLadder,
  deserializeEditItemsSnapshot,
  editItemsSnapshotKey,
  hasUnsavedWork,
  hydrateFromOrder,
  isSnapshotStale,
  makeEditItemsSnapshot,
  newLocalId,
  orderOriginals,
  repairBlockedLines,
  resolvePickTarget,
  resolveDraftKeyForPick,
  serializeEditItemsSnapshot,
  shouldRehydrateFromOrder,
  snapshotBaseline,
  stagedDiffItems,
  EDIT_ITEMS_AUTOSAVE_DEBOUNCE_MS,
  type DraftItem,
  type BaselineOrderLike,
  type EditItemsSnapshot,
  type StagedEdit,
  type UnlistedDraft,
} from "../../../../../lib/edit-items-draft";
import { bumpScanOrder, nextFlash, type ScanFlash } from "../../../../../lib/scan-tray";
import { ScanTray } from "../../../../../components/ScanTray";
import { applyPriceOverride } from "../../../../../lib/price-override";
import { BarcodeFab } from "../../../../../components/BarcodeFab";
import { scanFabHidden } from "../../../../../lib/scan-fab-visibility";
import { LicenseGuardModal } from "../../../../../components/LicenseGuardModal";
import { BlockedLinesModal } from "../../../../../components/BlockedLinesModal";
import { useRestrictionWarningRetry } from "../../../../../lib/use-restriction-warning-retry";
import { parseSellingRestricted } from "../../../../../lib/selling-restricted";
import type { BlockedLine } from "@routeflow/types";
import { CreditLimitGuardModal } from "../../../../../components/CreditLimitGuardModal";
import {
  parseRegulatedAuthError,
  regulatedAuthErrorCopy,
  type BlockedCategory,
} from "../../../../../lib/api/authorizations";
import {
  parseCreditLimitError,
  type CreditLimitExceededInfo,
} from "../../../../../lib/credit-limit-error";
import { useAuthStore } from "../../../../../lib/auth-store";
import { fmtCalendarDate } from "../../../../../lib/format-date";
import { useEditItemsDraft } from "../../../../../hooks/useEditItemsDraft";
import { DraftItemCard } from "../../../../../components/edit-items/DraftItemCard";
import { PriceOverrideModal } from "../../../../../components/edit-items/PriceOverrideModal";
import {
  UnlistedDraftCard,
  UnlistedItemModal,
} from "../../../../../components/edit-items/UnlistedDraft";
import { CreateCreditNoteModal } from "../../../../../components/edit-items/CreateCreditNoteModal";
import { ProductPicker } from "../../../../../components/edit-items/ProductPicker";
import { styles } from "../../../../../components/edit-items/styles";

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Order item editor. Mounted by BOTH the operator route (default export below,
 * reading the `[id]` param) and the driver route (R1e — passing `orderId` so a
 * driver can edit at a stop). The screen already reads `userRole`; driver-specific
 * behavior (list pricing, back-to-stop navigation) branches off it.
 */
export function EditOrderItemsScreen({ orderId }: { orderId?: string } = {}) {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = orderId ?? params.id ?? "";
  const { data: order, isLoading } = useAdminOrder(id);
  // The same order, narrowed to the fields the pure snapshot/diff layer reads.
  // AdminOrder declares neither `updatedAt` nor a line's `notes`/`status`, all
  // of which the server does return (orders.service.ts findOne has no top-level
  // select) — the cast is the existing `(order as any)` habit, scoped.
  const baselineOrder = order as unknown as BaselineOrderLike | undefined;
  const customerId = (order as any)?.customerId as string | undefined;
  const canRecordReturn = useInlineReturnsAddon().enabled;
  // Remembered per-customer prices — pre-fill a newly added line's price so a
  // prior discount carries forward (operator can still change it).
  const { data: priceHistory } = useCustomerPriceHistory(customerId);
  // Customer tier pricing (mirrors NewOrderScreen): a newly added line prices
  // off the customer's effective tier, not the raw list price.
  const {
    data: customerDetail,
    isPending: customerPending,
    isError: customerFailed,
  } = useCustomer(customerId ?? "");
  const {
    data: customerPrices,
    isPending: pricesPending,
    isError: pricesFailed,
  } = useCustomerPrices(customerId ?? "");
  const customerTier = customerDetail?.pricingTier ?? 1;
  // B62 (REG-B62): the tier defaults to 1 while those two queries are in flight,
  // so a line added or substituted in that window bakes the LIST price (the
  // substitute path even SENDS it). Gate the pricing-dependent controls — the
  // product picker and Substitute — until both settle, mirroring web's order
  // editor (apps/web/app/(dashboard)/orders/[id]/page.tsx).
  // NOTE: a disabled query stays `isPending` forever, so short-circuit when
  // there is no customer; an errored fetch falls back to the tier-1 degraded
  // mode rather than wedging the editor.
  // S19b slice D (SA-811a/813): billing's own customer price layer. Flag off: no request, every number is master's.
  const priceLayer = useCustomerPriceLayer(customerId);
  const layerOf = priceLayer.layerOf;
  // The layer is part of "pricing is ready": the picker, Substitute, scan and price edits stay closed until it is, so an add
  // never stores a pre-layer price (a product the layer cannot vouch for is also refused at the pick, below).
  const pricingReady =
    !customerId ||
    pricingReadyWithLayer(
      (!customerPending || customerFailed) && (!pricesPending || pricesFailed),
      priceLayer,
    );
  const cpMap = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const cp of customerPrices ?? []) m.set(cp.productId, cp.pricingTier);
    return m;
  }, [customerPrices]);
  const effectiveTierFor = (productId: string) => cpMap.get(productId) ?? customerTier ?? 1;
  /** SPECIAL (a tier other than 1) lines are the customer's permanent price — never overridable
   *  (the create surface's own rule, components/NewOrderScreen.tsx:627). Mobile's
   *  editor contradicted mobile's builder until this landed; the api-side gate is
   *  still the owner's call, so this is a CLIENT gate only (RULINGS R2/R9). */
  // S19b: a layered SPECIAL (the customer layer's pack row) is gated like a tier SPECIAL, else Save hits the server's 400.
  // No layer (flag off / no typed price) is `isSpecialTier(tier)` exactly.
  const isSpecialFor = (productId: string) =>
    packIsSpecial(effectiveTierFor(productId), layerOf(productId)) || unitLineSpecial(productId);
  /** A held unit line (a Can) is SPECIAL by ITS OWN layer row, not the pack's answer. */
  const unitLineSpecial = (productId: string) =>
    Object.values(draft).some(
      (it) =>
        it.productId === productId &&
        !!it.unitLabel &&
        !!it.packLadder &&
        lineIsSpecial(
          it,
          it.packLadder as PriceProduct,
          effectiveTierFor(productId),
          layerOf(productId),
        ) &&
        layerOf(productId) != null,
    );
  const userRole = useAuthStore((s) => s.user?.role);
  const userId = useAuthStore((s) => s.user?.id);
  // Customer accounts shouldn't reach this screen, but defend anyway —
  // box-splitting is operator/driver-only by product policy.
  const canSplitBoxes = userRole !== "CUSTOMER";
  // R1e: this screen is also mounted for DRIVERS (via the stop's edit-items route).
  // Drivers came from the stop detail, so leaving the editor pops back there; the
  // operator flow lands on the orders LIST (its historical behavior).
  const isDriver = userRole === "DRIVER";
  const leaveEditor = () => {
    if (isDriver) router.back();
    else router.replace("/(operator)/(tabs)/orders" as any);
  };
  // Tenant margin config for the live cost/margin hint (P10-POS-1).
  const { data: marginConfig } = useMarginConfig();
  // Lines explicitly acked as "sell anyway" below the margin floor —
  // session-local, keyed by the SAME draft key as `draft` itself (SA-108).
  const [floorAcked, setFloorAcked] = useState<Set<string>>(new Set());

  // B805: the stateful draft/draftRef/updateDraft trio lives in this shared
  // hook now — see its own doc comment for the SA-108/SA-108d rationale.
  const { draft, setDraft, draftRef, updateDraft } = useEditItemsDraft();
  // New + existing ad-hoc lines (productId null). Kept separate from `draft`
  // and diffed on save so they aren't dropped.
  const [unlisted, setUnlisted] = useState<UnlistedDraft[]>([]);
  // Existing line ids removed with the trash button → emitted as DELETE actions
  // in the incremental diff (the server hard-deletes only uninvoiced/undelivered
  // lines, else falls back to CANCEL — protecting invoiced money).
  const [pendingDeletes, setPendingDeletes] = useState<string[]>([]);
  const [unlistedModalOpen, setUnlistedModalOpen] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  // B246: armed by the line-list scan FAB so ProductPicker mounts with its
  // own camera already open (initialScanOpen) — reset whenever the picker
  // closes so the plain "Add product" path keeps opening cold.
  const [pickerScanIntent, setPickerScanIntent] = useState(false);
  // B263 D3: the productId of the most recent picker scan-add, so the picker
  // can offer "Edit price" over the paused camera without leaving the sheet.
  // Reset whenever the picker closes.
  const [lastScannedId, setLastScannedId] = useState<string | null>(null);
  // The picker's pull-out drawer: newest-first scan order + which row flashes.
  // Both belong to the CURRENT picker session, so both reset when it closes.
  const [scanOrder, setScanOrder] = useState<string[]>([]);
  const [trayFlash, setTrayFlash] = useState<ScanFlash | null>(null);
  const [substituteFor, setSubstituteFor] = useState<string | null>(null);
  // SA-108: carries its draft key alongside it — a new row has no lineId.
  const [priceEditItem, setPriceEditItem] = useState<{ key: string; item: DraftItem } | null>(null);
  const [licenseBlock, setLicenseBlock] = useState<BlockedCategory[] | null>(null);
  const [restrictedBlock, setRestrictedBlock] = useState<BlockedLine[] | null>(null);
  const [creditBlock, setCreditBlock] = useState<CreditLimitExceededInfo | null>(null);
  const updateMut = useUpdateOrderItems();
  const rw = useRestrictionWarningRetry(); // row 510: staff warning + override (a driver's hard block)

  // ── Apply-credit section (mirrors NewOrderScreen) ──────────────────────────
  // Driver-gated off below (drivers don't manage credits). `creditsTouched`
  // gates whether `appliedCreditNotes` is sent at all — omitted = leave the
  // server's existing intent untouched, per the API contract.
  const [selectedCreditIds, setSelectedCreditIds] = useState<string[]>([]);
  const [creditsTouched, setCreditsTouched] = useState(false);

  // ── Autosave / restore of the staged edit ─────────────────────────────────
  // The operator's staged edit is parked on this device (user- and
  // order-scoped) so leaving the editor — a back tap, a swipe, the OS
  // backgrounding the app — never costs the work. `restored` is the parsed
  // snapshot read on mount; `restoreState` makes the apply ONE-SHOT.
  const [restored, setRestored] = useState<EditItemsSnapshot | null>(null);
  const [restoreChecked, setRestoreChecked] = useState(false);
  const [restoreState, setRestoreState] = useState<"idle" | "applied" | "stale">("idle");
  const { data: openCredits } = useCreditNotes({
    customerId,
    status: "ISSUED",
    limit: 100,
  });
  // Inline "New credit note" create sheet + freshly-created credits, merged
  // into creditRows (deduped by id) so a just-minted credit shows up — and
  // can be applied — before the ["credit-notes"] refetch lands.
  const [createCreditOpen, setCreateCreditOpen] = useState(false);
  const [justCreatedCredits, setJustCreatedCredits] = useState<CreditNote[]>([]);
  // Rows to show: open credits + any already applied to this order + any just created (lib/edit-items-credit-rows.ts).
  const creditRows = useMemo(
    () => buildCreditRows(openCredits, order, justCreatedCredits),
    [openCredits, order, justCreatedCredits],
  );

  const tierPriceFor = (p: { id: string } & PriceProduct) =>
    packLinePrice(p, cpMap.get(p.id) ?? customerTier ?? 1, layerOf(p.id)).price;

  // Latched by a successful save. Read by the hydration guard below (the
  // post-save refetch IS the new truth, so it re-hydrates) and by the snapshot
  // writer: without it the unmount/beforeRemove flush fires DURING the
  // post-save navigation — while `draft` still differs from the order the
  // screen loaded — and writes the snapshot straight back after
  // `clearSnapshot` removed it, offering a saved edit for restore.
  const savedRef = useRef(false);
  // `dirty` is computed further down (it needs `originals`/`staged`, which are
  // derived from the draft this effect writes), so it is mirrored into a ref
  // on every render and read here. The effect runs after its render, so the
  // ref holds exactly "was there staged work before this refetch?".
  const dirtyRef = useRef(false);
  // Which order this screen has already hydrated. The FIRST hydration must
  // always run: on the render where `order` first arrives the draft is still
  // empty, so `dirty` is TRUE (every server line reads as a removal) and a
  // bare dirty check would leave the editor permanently blank.
  const hydratedOrderRef = useRef<string | null>(null);

  useEffect(() => {
    if (!order) return;
    // MONEY (hydration guard): a background refetch — window focus, a cache
    // invalidation, a socket push — must never overwrite a staged edit. It
    // used to: this effect re-ran `setDraft`/`setUnlisted` from the server,
    // the one-shot restore effect could not put the work back, and the
    // autosave effect then saw a clean draft and REMOVED the on-disk snapshot
    // as well. The rule itself lives in `shouldRehydrateFromOrder`.
    const orderKey = ((order as any)?.id as string | undefined) ?? id ?? null;
    if (
      !shouldRehydrateFromOrder({
        hydrated: hydratedOrderRef.current === orderKey,
        dirty: dirtyRef.current,
        justSaved: savedRef.current,
      })
    ) {
      return;
    }
    hydratedOrderRef.current = orderKey;
    const { draft: next, unlisted: nextUnlisted } = hydrateFromOrder(order);
    setDraft(next);
    setUnlisted(nextUnlisted);
    // Apply-credit: pre-check whatever the order already carries, and reset
    // the touched flag — resets alongside the draft whenever the order reloads.
    setSelectedCreditIds(
      ((order as any)?.orderCreditNotes ?? []).map((oc: any) => oc.creditNoteId),
    );
    setCreditsTouched(false);
    setJustCreatedCredits([]);
    // setDraft: stable useState setter, forwarded through useEditItemsDraft.
  }, [order, id, setDraft]);

  // The snapshot key resolves SYNCHRONOUSLY from the store (unlike
  // lib/user-scoped-storage.ts's async key, whose extra hop that module's own
  // header documents as a data-loss trap).
  const snapshotKey = editItemsSnapshotKey(id, userId);

  // Read the parked snapshot once per key. `restoreChecked` flips even when
  // there is nothing to restore — the autosave effect below must not write
  // (or REMOVE) anything until this read has answered, or a freshly hydrated
  // clean draft would delete the very snapshot we came back for.
  useEffect(() => {
    let alive = true;
    setRestored(null);
    setRestoreChecked(false);
    setRestoreState("idle");
    // B280 follow-up (PR-3): userId undefined means auth hasn't resolved yet
    // (cold open / deep link) — snapshotKey resolves to the shared `anon`
    // bucket, and reading it here could offer a PRIOR operator's leftover
    // snapshot for the instant before auth settles (the write side already
    // refuses this bucket — REG-MSCAN-A4-anon). Skip the read entirely; the
    // effect re-fires (via the `snapshotKey` dep) once userId resolves to a
    // real id and reads the correct per-user key then. `restoreChecked` still
    // flips so the autosave effect below isn't blocked forever.
    if (userId == null) {
      setRestoreChecked(true);
      return;
    }
    AsyncStorage.getItem(snapshotKey)
      .then((raw) => {
        if (!alive) return;
        setRestored(deserializeEditItemsSnapshot(raw));
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setRestoreChecked(true);
      });
    return () => {
      alive = false;
    };
  }, [snapshotKey, userId]);

  /**
   * Apply the snapshot. DECLARED AFTER the hydration effect above and sharing
   * its `[order]` dependency ON PURPOSE: React runs effects in declaration
   * order, so a background refetch re-hydrates the draft from the server and
   * this immediately puts the operator's staged edit back on top. The
   * `restoreState` guard keeps it one-shot, so it can never fight a later edit.
   */
  useEffect(() => {
    if (!order || !restored || restoreState !== "idle") return;
    if (isSnapshotStale(restored, baselineOrder)) {
      setRestoreState("stale");
      return;
    }
    setDraft(restored.draft);
    setUnlisted(restored.unlisted);
    setPendingDeletes(restored.pendingDeletes);
    setSelectedCreditIds(restored.selectedCreditIds);
    setCreditsTouched(restored.creditsTouched);
    setFloorAcked(new Set(restored.floorAcked));
    setRestoreState("applied");
  }, [order, baselineOrder, restored, restoreState, setDraft]);

  // Live total mirrors the server math (BOX-price proration when split).
  const total = useMemo(() => draftTotal(draft, unlisted), [draft, unlisted]);

  const itemCount =
    Object.values(draft).filter((it) => effectiveQty(it, it.unitsPerBox) > 0).length +
    unlisted.filter((u) => u.qty > 0).length;

  // D-5 (SA-813 M3): Save stays disabled until every staged product's price is confirmed by the layer read.
  const layerGate = priceLayerGate(
    priceLayer,
    Object.values(draft).map((it) => it.productId),
    (id) => Object.values(draft).find((it) => it.productId === id)?.name ?? id,
  );

  // ── The staged edit, as one value ─────────────────────────────────────────
  // `originals` and `staged` are the SAME inputs `save()` builds its payload
  // from (lib/edit-items-draft.ts), so "is there unsaved work?" can never
  // disagree with what Save would actually send.
  const originals = useMemo(() => orderOriginals(baselineOrder), [baselineOrder]);
  const staged: StagedEdit = useMemo(
    () => ({
      draft,
      unlisted,
      pendingDeletes,
      selectedCreditIds,
      creditsTouched,
      floorAcked: Array.from(floorAcked),
    }),
    [draft, unlisted, pendingDeletes, selectedCreditIds, creditsTouched, floorAcked],
  );
  const dirty = useMemo(() => hasUnsavedWork(staged, originals), [staged, originals]);
  // Mirror for the hydration guard above — assigned during render, so the
  // effect that runs after THIS render reads THIS render's answer.
  dirtyRef.current = dirty;

  /**
   * Write (or clear) the snapshot right now, no debounce. Best-effort by
   * contract: a failed write must never surface as an app error, and must
   * never block the navigation that triggered it.
   */
  const snapshotWriteRef = useRef<() => Promise<void>>(async () => undefined);
  snapshotWriteRef.current = async () => {
    // userId undefined means auth hasn't resolved yet (cold open / deep link)
    // — never stage under the shared `anon` bucket, where the next operator to
    // sign in on this device could be offered it (B136/B137/B140 class).
    if (!order || !id || savedRef.current || userId == null) return;
    try {
      if (!dirty) {
        await AsyncStorage.removeItem(snapshotKey);
        return;
      }
      await AsyncStorage.setItem(
        snapshotKey,
        serializeEditItemsSnapshot(
          makeEditItemsSnapshot({
            orderId: id,
            staged,
            baseline: snapshotBaseline(baselineOrder),
            orderUpdatedAt: baselineOrder?.updatedAt ?? null,
          }),
        ),
      );
    } catch {
      // Persistence is best-effort — never an app-level error.
    }
  };
  const flushSnapshot = useCallback(() => snapshotWriteRef.current().catch(() => {}), []);
  const clearSnapshot = useCallback(
    () => AsyncStorage.removeItem(snapshotKey).catch(() => {}),
    [snapshotKey],
  );

  // Debounced autosave. Held off until the restore read has answered (and
  // until a found snapshot has been applied), so the hydrated-clean first
  // render can't wipe the snapshot before it is restored.
  const snapshotReady = restoreChecked && !(restored && restoreState === "idle");
  useEffect(() => {
    if (!order || !snapshotReady) return;
    const timer = setTimeout(() => void flushSnapshot(), EDIT_ITEMS_AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [order, snapshotReady, staged, dirty, flushSnapshot]);

  // Flush points, copied from the two in-repo patterns: NewOrderScreen's
  // `beforeRemove` (Android hardware back + the iOS swipe) plus its web
  // `visibilitychange` branch, and stock-count's AppState background flush.
  const navigation = useNavigation();
  useEffect(() => {
    const nav = navigation as unknown as {
      addListener: (event: "beforeRemove", cb: () => void) => () => void;
    };
    const unsubscribe = nav.addListener("beforeRemove", () => {
      void flushSnapshot();
    });
    return unsubscribe;
  }, [navigation, flushSnapshot]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") void flushSnapshot();
    });
    return () => sub.remove();
  }, [flushSnapshot]);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (typeof document === "undefined") return;
    const handler = () => {
      if (document.visibilityState === "hidden") void flushSnapshot();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [flushSnapshot]);
  useEffect(() => () => void flushSnapshot(), [flushSnapshot]);

  // ── Unlisted line helpers ──────────────────────────────────────────────────
  const addUnlisted = (name: string, unitPrice: number, qty: number) =>
    setUnlisted((u) => [...u, { id: newLocalId(), name: name.trim(), unitPrice, qty }]);
  const setUnlistedQty = (id: string, qty: number) =>
    setUnlisted((u) =>
      qty <= 0 ? u.filter((x) => x.id !== id) : u.map((x) => (x.id === id ? { ...x, qty } : x)),
    );
  const setUnlistedPrice = (id: string, value: number | null) =>
    setUnlisted((u) => {
      const price = value == null || value < 0 ? 0 : value;
      return u.map((x) => (x.id === id ? { ...x, unitPrice: price } : x));
    });
  const setUnlistedName = (id: string, name: string) =>
    setUnlisted((u) => u.map((x) => (x.id === id ? { ...x, name } : x)));
  const setUnlistedNote = (id: string, notes: string) =>
    setUnlisted((u) => u.map((x) => (x.id === id ? { ...x, notes } : x)));
  const removeUnlisted = (id: string) => setUnlisted((u) => u.filter((x) => x.id !== id));

  // ── Per-line helpers ──────────────────────────────────────────────────────

  const setQty = (id: string, qty: number) =>
    updateDraft((d) => {
      const cur = d[id];
      if (!cur) return d;
      const q = Math.max(0, Math.floor(qty));
      const next = { ...d };
      if (q === 0) delete next[id];
      // Plain qty path — clear boxes/pieces so the server treats it as flat.
      else next[id] = { ...cur, qty: q, boxes: undefined, pieces: undefined, boxSplit: false };
      return next;
    });

  // units_v1 (SA-085i(c)): applyBoxEdit/applyPieceEdit refuse a unit split AND match master's
  // OLD non-unit math byte-for-byte — see their doc comment.
  const commitLine = (d: Record<string, DraftItem>, id: string, line: DraftItem) => {
    if (line.qty > 0) return { ...d, [id]: line };
    const next = { ...d };
    delete next[id];
    return next;
  };
  const setBoxes = (id: string, boxes: number) =>
    updateDraft((d) => {
      const cur = d[id];
      return cur ? commitLine(d, id, applyBoxEdit(cur, boxes, Number(cur.unitsPerBox ?? 0))) : d;
    });
  const setPieces = (id: string, pieces: number) =>
    updateDraft((d) => {
      const cur = d[id];
      return cur ? commitLine(d, id, applyPieceEdit(cur, pieces, Number(cur.unitsPerBox ?? 0))) : d;
    });

  /** Unit mode: the operator types a TOTAL unit count; normalize it back into
   *  cases + loose (7 units of a 6-pack -> 1 case + 1 loose) via setLineUnits. */
  const setUnits = (id: string, units: number) =>
    updateDraft((d) => {
      const cur = d[id];
      if (!cur) return d;
      const upb = Number(cur.unitsPerBox ?? 0);
      const line = setLineUnits(cur, units, upb);
      const next = { ...d };
      if (!line) delete next[id];
      else next[id] = { ...line, boxSplit: isUnitLine(cur) ? false : true };
      return next;
    });

  const setSellBy = (id: string, sellBy: "case" | "unit") =>
    updateDraft((d) => (d[id] ? { ...d, [id]: { ...d[id], sellBy } } : d));

  // units_v1: apply a `UnitPickerRow` choice — see lib/edit-items-draft.ts#applyUnitPick
  // (pack-restore tier price, the current-selling-unit-factor convention; size-ratchet extraction).
  const setUnitLabel = (id: string, option: UnitOption) =>
    updateDraft((d) => {
      const cur = d[id];
      if (!cur) return d;
      const packTierPrice = cur.packLadder
        ? tierPriceFor({ id: cur.productId, ...cur.packLadder })
        : cur.catalogPrice;
      // S19b (SA-813 M2): a unit in the customer layer takes the layer price, not the tier's (typed pack $33 -> Case $377.14).
      const layered = cur.packLadder
        ? optionWithLayerPrice(
            option,
            cur.packLadder as PriceProduct,
            effectiveTierFor(cur.productId),
            layerOf(cur.productId),
          )
        : option;
      return { ...d, [id]: applyUnitPick(cur, layered, packTierPrice) };
    });

  // "Set to floor" one-tap fix (P10-POS-1) — same price-write path as the
  // price-override modal, minus the reason (the ack itself is the record).
  const setLinePrice = (id: string, unitPrice: number) =>
    updateDraft((d) => {
      const cur = d[id];
      if (!cur) return d;
      return { ...d, [id]: { ...cur, unitPrice } };
    });

  const setLineNote = (id: string, notes: string) =>
    updateDraft((d) => (d[id] ? { ...d, [id]: { ...d[id], notes } } : d));

  // units_v1 (SA-085i(c)): a unit line steps its COUNT via setQty; a non-unit line delegates
  // to setBoxes/setQty exactly like master did.
  const incQty = (id: string) => {
    const cur = draft[id];
    if (!cur) return;
    if (cur.unitLabel) return setQty(id, (cur.qty ?? 0) + 1);
    const upb = Number(cur.unitsPerBox ?? 0);
    if (upb > 1) setBoxes(id, (cur.boxes ?? 0) + 1);
    else setQty(id, (cur.qty ?? 0) + 1);
  };

  /**
   * Add a picked/scanned product to the draft (shared by tap-pick and
   * add-and-stay). `level === "UNIT"` (from the scanned code, SA-580) rolls one loose piece into a
   * box. Returns the draft KEY (B775: never `p.id`) for callers tracking
   * "the last thing added" (the picker's price-edit affordance).
   */
  /** D-5: refuse a pick the layer cannot vouch for, saying why: checking / failed (with Retry) / too many prices. */
  const refuseUnconfirmedPick = (p: { id: string; name: string }): boolean => {
    const gate = priceLayerGate(priceLayer, [p.id], () => p.name);
    if (!gate.blocked) return false;
    if (gate.canRetry)
      confirm("Prices aren't confirmed", gate.message ?? "", () => priceLayer.refetch(), {
        confirmText: "Retry",
      });
    else showToast(gate.message ?? "");
    return true;
  };

  const addPickedToDraft = (
    p: {
      id: string;
      name: string;
      pricePerUnit: number | string;
      priceTier2?: number | string | null;
      priceTier3?: number | string | null;
      priceTier4?: number | string | null;
      priceTier5?: number | string | null;
      unit?: string;
      packLabel?: string | null;
      baseUnitLabel?: string | null;
      unitsPerBox?: number | null;
    },
    level: SellLevel = "BOX",
  ): string => {
    // D-5: never store a price the layer cannot vouch for (pending, failed, or absent from an incomplete layer).
    if (refuseUnconfirmedPick(p)) return resolveDraftKeyForPick(draftRef.current, p.id, null);
    const catalogPrice = tierPriceFor(p);
    const listPrice = toNumber(p.pricePerUnit);
    const lp = packLinePrice(p, cpMap.get(p.id) ?? customerTier ?? 1, layerOf(p.id));
    const isSpecial = lp.isSpecial || lp.layered; // R3: a layered price is the resolver's, no last-given pre-fill
    const upbRaw = p.unitsPerBox;
    const unitsPerBox = upbRaw == null ? null : Number(upbRaw);
    // Fresh-add starting price — only a genuine discount (below tier) or
    // upsell (above list), never over a SPECIAL tier price. Else the tier price.
    const hist = priceHistory?.[p.id];
    const startPrice =
      !isSpecial && hist != null && (hist.lastPrice < catalogPrice || hist.lastPrice > listPrice)
        ? hist.lastPrice
        : catalogPrice;
    // A FAMILY container is never a line (search pick or scan): no line added.
    if (isFamilyProduct(p as { kind?: "FAMILY" })) {
      showToast(FAMILY_ADD_MESSAGE);
      return resolveDraftKeyForPick(draftRef.current, p.id, null);
    }
    // Key resolution + the pure `apply(d)` updater: resolvePickTarget (lib/edit-items-draft.ts).
    const { key, existingLabel, apply } = resolvePickTarget(draftRef.current, {
      productId: p.id,
      name: p.name,
      unit: p.unit,
      unitsPerBox,
      level,
      startPrice,
      catalogPrice,
      packLadder: buildPackLadder({ ...p, unitsPerBox }),
    });
    // B805: the pick commits through updateDraft like every other writer.
    const commit = () => updateDraft(apply);
    if (level === "UNIT" && existingLabel) {
      confirm(`Add 1 ${existingLabel}?`, `${p.name} is sold by ${existingLabel}.`, commit, {
        confirmText: `Add 1 ${existingLabel}`,
      });
      return key;
    }
    commit();
    return key;
  };

  const decQty = (id: string) => {
    const cur = draft[id];
    if (!cur) return;
    if (cur.unitLabel) return setQty(id, Math.max(0, (cur.qty ?? 0) - 1));
    const upb = Number(cur.unitsPerBox ?? 0);
    if (upb > 1) setBoxes(id, Math.max(0, (cur.boxes ?? 0) - 1));
    else setQty(id, Math.max(0, (cur.qty ?? 0) - 1));
  };

  const removeLine = (id: string) => {
    // B805: the pendingDeletes append is a SIDE EFFECT, so it must run
    // OUTSIDE the pure fn handed to updateDraft (which may run twice — see
    // updateDraft's own comment). Read from draftRef.current, the same
    // synchronously-accurate mirror updateDraft itself maintains, not the
    // component-level `draft` state (which could be a render behind inside
    // a same-tick burst). If a later action in the same batch re-adds this
    // SAME lineId (a rescan, or the price modal), order-item-diff.ts's
    // `buildOrderItemDiff` drops a pendingDelete whose id survives as a live
    // catalog entry — the surviving state wins, never a DELETE alongside
    // that entry's own UPDATE.
    const cur = draftRef.current[id];
    if (cur?.lineId) {
      const lineId = cur.lineId;
      setPendingDeletes((prev) => (prev.includes(lineId) ? prev : [...prev, lineId]));
    }
    updateDraft((d) => {
      const next = { ...d };
      delete next[id];
      return next;
    });
  };

  // ── The picker's pull-out drawer ──────────────────────────────────────────
  // Rows come from the ONE tray derivation the sale builders use
  // (lib/scan-tray.ts via draftTrayRows); the drawer's item count and total
  // are the footer's own `itemCount`/`total`, never a second money derivation.
  const trayRows = useMemo(
    () => draftTrayRows({ draft, unlisted, scanOrder }),
    [draft, unlisted, scanOrder],
  );
  // ScanTray's stable handlers (hooks/useEditItemsTrayHandlers.ts).
  const { trayDepsRef, unlistedRow, onTrayIncrement, onTrayDecrement, onTrayRemove } =
    useEditItemsTrayHandlers({
      draft,
      unlisted,
      setUnits,
      setQty,
      incQty,
      decQty,
      removeLine,
      setUnlistedQty,
      removeUnlisted,
    });
  // ScanTray hands a TOTAL UNIT count (ScanTray.tsx), which is exactly what
  // `setUnits` normalises back into cases + loose — except a unit-sold line (units_v1,
  // SA-085f), whose total IS the count already, so it goes through `setQty` instead.
  const onTrayChangeQty = useCallback(
    (id: string, units: number) => {
      const d = trayDepsRef.current;
      if (unlistedRow(id)) d.setUnlistedQty(id, units);
      else if (isUnitLine(d.draft[id] ?? {})) d.setQty(id, units);
      else d.setUnits(id, units);
    },
    [trayDepsRef, unlistedRow],
  );

  // ── Save ─────────────────────────────────────────────────────────────────

  const save = () => {
    if (!id) return;
    // An incremental diff (replaceAll:false): untouched lines keep their ids, invoiced qty and override
    // history. `notes` is threaded through so a note edit is a change and never wiped. buildOrderItemDiff
    // auto-DELETEs any original line absent from the surviving lines (qty stepper to zero too), so
    // `pendingDeletes` is just the trash-button set. The mapping lives in lib/edit-items-draft.ts: the
    // dirty check and this payload are ONE derivation.
    const items = stagedDiffItems({ draft, unlisted, pendingDeletes }, originals);
    const repair = repairBlockedLines(draft, originals); // #2231: LOCKED unit line, send nothing
    if (repair.length) return showToast(`${repair.join(", ")} needs repair — not saved.`);

    if (items.length === 0 && !creditsTouched) {
      // Nothing changed — mirror web: just leave the editor, don't error.
      savedRef.current = true;
      void clearSnapshot();
      leaveEditor();
      return;
    }
    updateMut.mutate(
      rw.attach({
        orderId: id,
        items,
        replaceAll: false,
        // A credits-only edit still reaches the server: `items: []` +
        // `replaceAll: false` is a safe no-op for lines (the web fee-only
        // data-loss bug came from omitting replaceAll:false, not from an
        // empty items array). Omitted entirely when untouched, so the
        // server's existing intent survives per the API contract.
        //
        // MONEY: previously-linked credits must ROUND-TRIP their stored
        // per-credit amount (web's creditSelectionsFromOrder does the same).
        // Sending {creditNoteId} alone re-synced the intent as "up to
        // remaining" — a $50 partial silently escalated to the full credit
        // the moment anyone touched this section. Newly-selected credits
        // send no amount (up to remaining) by design.
        ...(creditsTouched
          ? {
              appliedCreditNotes: selectedCreditIds.map((cnId) => {
                const stored = ((order as any)?.orderCreditNotes ?? []).find(
                  (oc: any) => oc.creditNoteId === cnId,
                );
                return stored?.amount != null
                  ? { creditNoteId: cnId, amount: toNumber(stored.amount) }
                  : { creditNoteId: cnId };
              }),
            }
          : {}),
      }),
      {
        onSuccess: () => {
          showToast("Items updated");
          // A saved edit must never be offered for restore again — the latch
          // also stops the unmount/beforeRemove flush re-writing it behind us.
          savedRef.current = true;
          void clearSnapshot();
          // Land on the orders LIST (explicit navigation sidesteps an unstable back stack after a
          // deep link or tab switch). Driver → back to stop.
          leaveEditor();
        },
        onError: (e: any) => {
          if (rw.handle(e, save)) return; // row 510: warning + override (a driver's hard block)
          const restricted = parseSellingRestricted(e);
          if (restricted) {
            setRestrictedBlock(restricted);
            return;
          }
          // Regulated-sale block: open the guard, then replay the save on resolve.
          const blocked = parseRegulatedAuthError(e);
          if (blocked && blocked.length > 0) {
            setLicenseBlock(blocked);
            return;
          }
          // Credit-limit block: no server-side bypass exists (see lib/credit-limit-error.ts) —
          // surface it with the real numbers, never auto-retry.
          const creditInfo = parseCreditLimitError(e);
          if (creditInfo) {
            setCreditBlock(creditInfo);
            return;
          }
          const customerName = (order as any)?.customer?.businessName;
          if (handleOrderOverpay(e, { id, customerId, customerName, canRecordReturn }, router))
            return;
          showToast(
            regulatedAuthErrorCopy(e) ?? e?.response?.data?.message ?? e?.message ?? "Try again.",
          );
        },
      },
    );
  };

  /**
   * Leave. No confirm() prompt: NewOrderScreen's `beforeRemove` — the app's
   * only other navigation guard — doesn't prompt either, and with the snapshot
   * written there is nothing to lose. The toast is the receipt.
   */
  const handleBackWithSnapshot = () => {
    void flushSnapshot();
    if (dirty) showToast("Unsaved item changes kept on this device");
    router.back();
  };

  /**
   * Throw the parked edit away and go back to exactly what the server has.
   * `restoreState` leaves "idle" for good (so the one-shot apply effect can
   * never run again this mount) and `restored` is dropped, which is what
   * hides both banners.
   */
  const discardRestored = () => {
    void clearSnapshot();
    setRestoreState("stale");
    setRestored(null);
    if (!baselineOrder) return;
    const rebuilt = hydrateFromOrder(order);
    setDraft(rebuilt.draft);
    setUnlisted(rebuilt.unlisted);
    setPendingDeletes([]);
    setFloorAcked(new Set());
    setSelectedCreditIds(
      ((order as any)?.orderCreditNotes ?? []).map((oc: any) => oc.creditNoteId),
    );
    setCreditsTouched(false);
  };

  if (isLoading || !order) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Edit items"
          leading={
            <NavBackButton
              onPress={() => {
                void flushSnapshot();
                router.back();
              }}
            />
          }
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  // Web parity (apps/web/app/(dashboard)/orders/[id]/page.tsx:1765): the
  // server's own edit window decides, with the status list as the fallback —
  // NOT "any status but CANCELLED", which is what mobile used to allow.
  const orderPriceEditable =
    !isDriver &&
    (order.editWindow?.editable ??
      (order.status === "DRAFT" || order.status === "PENDING" || order.status === "CONFIRMED"));
  /**
   * Per LINE, not per order. `pricingReady` is in the AND deliberately: while
   * the customer/customer-price queries are in flight `cpMap` is empty and
   * `isSpecialFor` would answer false for a genuinely SPECIAL line — exactly
   * the window B62 was filed for.
   */
  const canEditPriceFor = (productId: string) =>
    orderPriceEditable && pricingReady && !isSpecialFor(productId);

  // B263 D3: the draft line behind the picker's "last added" strip, resolved
  // once so its margin floor and ack state are derived from the same line the
  // strip renders.
  const lastAddedLine = lastScannedId ? (draft[lastScannedId] ?? null) : null;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Edit items"
        leading={<NavBackButton label={order.orderNumber} onPress={handleBackWithSnapshot} />}
      />

      {priceEditItem ? (
        <PriceOverrideModal
          item={priceEditItem.item}
          isSpecial={isSpecialFor(priceEditItem.item.productId)}
          onSave={(price, reason) => {
            // B263 D2: rounding + lineTotal recompute now live in the shared
            // helper (money discipline) — never write the raw typed price.
            const updated = applyPriceOverride(priceEditItem.item, {
              unitPrice: price,
              reason: reason || undefined,
            });
            // SA-108: write back to priceEditItem's OWN stored key — a new
            // row has no lineId, so re-deriving one would double-CREATE it.
            const key = priceEditItem.key;
            updateDraft((d) => ({
              ...d,
              [key]: {
                ...priceEditItem.item,
                unitPrice: updated.unitPrice,
                overrideReason: updated.overrideReason,
              },
            }));
            setPriceEditItem(null);
          }}
          onCancel={() => setPriceEditItem(null)}
        />
      ) : null}

      <UnlistedItemModal
        open={unlistedModalOpen}
        onClose={() => setUnlistedModalOpen(false)}
        onAdd={(name, unitPrice, qty) => {
          addUnlisted(name, unitPrice, qty);
          setUnlistedModalOpen(false);
          showToast(`Added ${name}`);
        }}
      />

      <CreateCreditNoteModal
        open={createCreditOpen}
        customerId={customerId ?? ""}
        onClose={() => setCreateCreditOpen(false)}
        onCreated={(created) => {
          setJustCreatedCredits((prev) => [...prev, created]);
          setSelectedCreditIds((ids) => (ids.includes(created.id) ? ids : [...ids, created.id]));
          setCreditsTouched(true);
          setCreateCreditOpen(false);
          showToast(`Created credit ${created.creditNoteNumber}`);
        }}
      />

      {/* Regulated-license guard — order exists here, so overrides are ORDER-scoped.
          No remove-lines exit (lines are removed via the qty steppers above). */}
      <LicenseGuardModal
        open={!!licenseBlock}
        customerId={customerId ?? ""}
        blocked={licenseBlock ?? []}
        orderId={id}
        onResolved={() => {
          setLicenseBlock(null);
          save();
        }}
        onClose={() => setLicenseBlock(null)}
      />

      <BlockedLinesModal lines={restrictedBlock} onClose={() => setRestrictedBlock(null)} />
      {rw.modal}

      <CreditLimitGuardModal
        open={!!creditBlock}
        info={creditBlock}
        onCollectPayment={() => {
          setCreditBlock(null);
          // router.push (not replace) — the edit screen stays on the stack, so the
          // operator's in-progress draft is intact when they come back and hit
          // Save again after recording the payment. No auto-retry: this screen
          // never re-sends the exact same request it just watched fail. Drivers
          // collect payment from the stop, so just close the guard for them.
          if (!isDriver) {
            router.push(`/(operator)/invoices?customerId=${customerId ?? ""}` as any);
          }
        }}
        onCancel={() => setCreditBlock(null)}
      />

      {showPicker ? (
        <ProductPicker
          title={substituteFor ? "Substitute with…" : "Add product"}
          canCreateProducts={!isDriver}
          // The picker's `canEditPrice` gates exactly ONE line — the last-added
          // strip's "Edit price" and its modal — so it is that LINE's gate, not
          // the order's (SPECIAL-tier lock + web's edit window, RULINGS R2/R9).
          canEditPrice={lastAddedLine ? canEditPriceFor(lastAddedLine.productId) : false}
          isSpecialTierFor={isSpecialFor}
          priceFor={isDriver ? undefined : tierPriceFor}
          initialScanOpen={pickerScanIntent}
          // Add-and-stay (scans + wedge input): the picker stays open so N
          // items scan with zero taps — closes web's long-standing edit-screen
          // divergence. Not offered in substitute mode (one pick by contract).
          onPickAndStay={
            substituteFor
              ? undefined
              : (p, level) => {
                  // B775: track the draft KEY (addPickedToDraft's return), not p.id.
                  const key = addPickedToDraft(p, level);
                  setLastScannedId(key);
                  setScanOrder((o) => bumpScanOrder(o, key));
                  setTrayFlash((f) => nextFlash(f, key));
                }
          }
          trayRows={trayRows}
          trayFlash={trayFlash}
          trayItemCount={itemCount}
          trayTotal={total}
          onTrayChangeQty={onTrayChangeQty}
          onTrayIncrement={onTrayIncrement}
          onTrayDecrement={onTrayDecrement}
          onTrayRemove={onTrayRemove}
          lastAdded={lastAddedLine}
          // Review round: the strip flags a below-floor price with the SAME
          // floor and the SAME ack state the line list uses — one derivation
          // (`marginFloorPrice`), one ack set (`floorAcked`), two surfaces.
          lastAddedFloor={
            lastAddedLine
              ? marginFloorPrice(
                  lastAddedLine,
                  floorForCategory(marginConfig, lastAddedLine.category),
                )
              : null
          }
          lastAddedAcked={lastScannedId ? floorAcked.has(lastScannedId) : false}
          // Finding B263-H: the same floor-FRACTION call the list row's own
          // `marginFloor` prop uses (`:983`) — lets the strip classify
          // `lastAdded` with the row's exact derivation, not a hand-rolled one.
          marginFloor={floorForCategory(marginConfig, lastAddedLine?.category)}
          // The list row's Set-to-floor writer, verbatim — SA-108:
          // `lastScannedId` IS the draft key (addPickedToDraft's return).
          onSetToFloor={(_item, price) => {
            if (lastScannedId) setLinePrice(lastScannedId, price);
          }}
          onEditPrice={(_item, price, reason) => {
            const key = lastScannedId;
            if (!key) return;
            updateDraft((d) => {
              const cur = d[key];
              if (!cur) return d;
              return {
                ...d,
                [key]: { ...cur, unitPrice: price, overrideReason: reason },
              };
            });
          }}
          onScanSessionStart={() => setLastScannedId(null)}
          // RULINGS R5: the camera CLOSING does not undo the add, so this no
          // longer clears `lastScannedId` — the price affordance has to survive
          // an add made with the camera shut (a wedge scanner, a typed code).
          // Only the row flash, which belongs to the camera session, is cleared.
          onScanSessionEnd={() => setTrayFlash(null)}
          onPick={(p, level) => {
            if (substituteFor) {
              if (refuseUnconfirmedPick(p)) return;
              const tierPrice = tierPriceFor(p);
              const listPrice = toNumber(p.pricePerUnit);
              updateDraft((d) => {
                const next = { ...d };
                const old = next[substituteFor];
                // Re-denominates the inherited piece count against the
                // SUBSTITUTE's box size and keeps its LIST price as the line's
                // base, so the box split and the customer's tier price both
                // reach the server (lib/substitute-line.ts).
                // B775: reuse `substituteFor` itself as the key — never the
                // substitute PRODUCT's id, which could collide with another line.
                next[substituteFor] = buildSubstituteLine({
                  previous: old,
                  product: { id: p.id, name: p.name, unit: p.unit, unitsPerBox: p.unitsPerBox },
                  tierPrice,
                  listPrice,
                });
                return next;
              });
              setSubstituteFor(null);
            } else {
              // B775: track the draft KEY, not p.id — see the onPickAndStay note above.
              const key = addPickedToDraft(p, level);
              setScanOrder((o) => bumpScanOrder(o, key));
              setTrayFlash((f) => nextFlash(f, key));
            }
            setShowPicker(false);
            setPickerScanIntent(false);
            // The strip belongs to the CURRENT picker session: a row tap (or a
            // substitute pick) closes the picker, so the id a wedge/search
            // auto-add left behind must not survive into the next session.
            setLastScannedId(null);
            setScanOrder([]);
            setTrayFlash(null);
          }}
          onClose={() => {
            setShowPicker(false);
            setSubstituteFor(null);
            setPickerScanIntent(false);
            setLastScannedId(null);
            setScanOrder([]);
            setTrayFlash(null);
          }}
        />
      ) : (
        <>
          {/* Restore banner. An APPLIED snapshot is already back on screen —
              this is the receipt plus a way out. A STALE one is never applied:
              the server lines it was diffed against changed underneath it, so
              re-sending those qty/price edits would write money against a
              different baseline. */}
          {restoreState === "applied" ? (
            <View style={styles.restoreBanner}>
              <Ionicons name="refresh-outline" size={16} color={ios.brand} />
              <Text style={styles.restoreText} numberOfLines={2}>
                Restored your unsaved changes
              </Text>
              <Pressable
                onPress={() =>
                  confirm(
                    "Discard changes?",
                    "Your unsaved item changes will be removed.",
                    discardRestored,
                    { confirmText: "Discard", destructive: true },
                  )
                }
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Discard restored changes"
              >
                <Text style={styles.restoreAction}>Discard</Text>
              </Pressable>
            </View>
          ) : null}
          {restoreState === "stale" && restored ? (
            <View style={styles.restoreBanner}>
              <Ionicons name="alert-circle-outline" size={16} color={ios.system.orangeInk} />
              <Text style={styles.restoreText} numberOfLines={2}>
                This order changed since your unsaved edits
              </Text>
              <Pressable
                onPress={() =>
                  confirm(
                    "Discard changes?",
                    "Your unsaved item changes will be removed.",
                    discardRestored,
                    { confirmText: "Discard", destructive: true },
                  )
                }
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Discard unsaved changes"
              >
                <Text style={styles.restoreAction}>Discard</Text>
              </Pressable>
            </View>
          ) : null}
          <ScrollView showsVerticalScrollIndicator={false}>
            {!isDriver && order ? <OrderAppliedCredits order={order as any} /> /* #2404 */ : null}
            {/* Apply credit — mirrors NewOrderScreen. Driver-gated off: drivers
                don't manage credits. Gated on the customer alone (not credit
                COUNT) so the operator can create one right here when none
                exist yet. Toggle only (no amount input); null amount = up to
                remaining, resolved server-side. */}
            {!isDriver && customerId ? (
              <View style={styles.optionsWrap}>
                <View style={styles.optionsHeader}>
                  <Ionicons name="pricetag-outline" size={16} color={ios.brand} />
                  <Text style={styles.optionsTitle}>Apply credit</Text>
                  <View style={{ flex: 1 }}>
                    {selectedCreditIds.length > 0 ? (
                      <Text style={styles.optionsSummary} numberOfLines={1}>
                        {selectedCreditIds.length} selected
                      </Text>
                    ) : null}
                  </View>
                  <Pressable onPress={() => setCreateCreditOpen(true)} hitSlop={6}>
                    <Text style={styles.newCreditText}>+ New credit note</Text>
                  </Pressable>
                </View>
                <View style={styles.optionsBody}>
                  {creditRows.length === 0 ? (
                    <Text style={styles.optionsSummary}>No open credits for this customer.</Text>
                  ) : (
                    creditRows.map((cn) => {
                      const remaining = Math.max(0, cn.amount - (cn.amountUsed ?? 0));
                      const checked = selectedCreditIds.includes(cn.id);
                      return (
                        <Pressable
                          key={cn.id}
                          style={styles.optionRow}
                          onPress={() => {
                            setSelectedCreditIds((ids) =>
                              checked ? ids.filter((i) => i !== cn.id) : [...ids, cn.id],
                            );
                            setCreditsTouched(true);
                          }}
                        >
                          <Ionicons
                            name={checked ? "checkbox" : "square-outline"}
                            size={20}
                            color={checked ? ios.brand : ios.label2}
                          />
                          <View style={{ flex: 1 }}>
                            <Text style={styles.optionLabel} numberOfLines={1}>
                              {cn.creditNoteNumber}
                              {cn.reason ? ` · ${cn.reason}` : ""}
                            </Text>
                            {cn.expiresAt ? (
                              <Text style={styles.optionsSummary}>
                                Expires {fmtCalendarDate(cn.expiresAt)}
                              </Text>
                            ) : null}
                          </View>
                          <Text style={styles.optionLabel}>${remaining.toFixed(2)}</Text>
                        </Pressable>
                      );
                    })
                  )}
                </View>
              </View>
            ) : null}
            <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 10 }}>
              {Object.values(draft).length === 0 && unlisted.length === 0 ? (
                <Text style={styles.empty}>No items. Add one below.</Text>
              ) : (
                // SA-108 review of B775: the draft record's KEY is a line's
                // ONLY identity and is NEVER re-derived from its own fields
                // (`it.lineId ?? it.productId` reads `undefined` for a
                // not-yet-saved row — only hydrateFromOrder stamps lineId —
                // so every writer below would silently target the wrong,
                // nonexistent key, and a brand-new line could never again be
                // stepped, priced, noted, substituted or removed). Object.entries
                // hands back the TRUE key straight from iteration; no formula.
                Object.entries(draft).map(([key, it]) => {
                  return (
                    <DraftItemCard
                      key={key}
                      item={it}
                      canSplitBoxes={canSplitBoxes}
                      canEditPrice={canEditPriceFor(it.productId)}
                      pricingReady={pricingReady}
                      tier={effectiveTierFor(it.productId)}
                      pricesUnconfirmed={layerGate.blocked}
                      marginFloor={floorForCategory(marginConfig, it.category)}
                      acked={floorAcked.has(key)}
                      onSetToFloor={(price) => setLinePrice(key, price)}
                      onSellAnyway={() => setFloorAcked((prev) => new Set(prev).add(key))}
                      onIncQty={() => incQty(key)}
                      onDecQty={() => decQty(key)}
                      onSetQty={(n) => setQty(key, n)}
                      onSetBoxes={(n) => setBoxes(key, n)}
                      onSetPieces={(n) => setPieces(key, n)}
                      onSetUnits={(n) => setUnits(key, n)}
                      onSetSellBy={(v) => setSellBy(key, v)}
                      onSetUnit={(opt) => setUnitLabel(key, opt)}
                      onSetNote={(notes) => setLineNote(key, notes)}
                      onPressPrice={() => setPriceEditItem({ key, item: it })}
                      onPressSubstitute={() => {
                        setSubstituteFor(key);
                        setShowPicker(true);
                      }}
                      onRemove={() =>
                        confirm("Remove item?", it.name, () => removeLine(key), {
                          confirmText: "Remove",
                          destructive: true,
                        })
                      }
                    />
                  );
                })
              )}
              {unlisted.map((u) => (
                <UnlistedDraftCard
                  key={u.id}
                  line={u}
                  onSetName={(name) => setUnlistedName(u.id, name)}
                  onSetNote={(notes) => setUnlistedNote(u.id, notes)}
                  onSetPrice={(raw) => setUnlistedPrice(u.id, raw)}
                  onSetQty={(n) => setUnlistedQty(u.id, n)}
                  onRemove={() =>
                    confirm("Remove item?", u.name || "Unlisted item", () => removeUnlisted(u.id), {
                      confirmText: "Remove",
                      destructive: true,
                    })
                  }
                />
              ))}
              {/* B62 (REG-B62): the picker is the only way a line gets priced
                  here, so it stays shut until the customer's contract is loaded. */}
              <Pressable
                style={[styles.addBtn, !pricingReady && styles.addBtnDisabled]}
                onPress={() => setShowPicker(true)}
                disabled={!pricingReady}
              >
                {pricingReady ? (
                  <Ionicons name="add-circle-outline" size={18} color={ios.brand} />
                ) : (
                  <ActivityIndicator size="small" color={ios.brand} />
                )}
                <Text style={styles.addBtnText}>
                  {pricingReady ? "Add product" : "Loading customer pricing…"}
                </Text>
              </Pressable>
              <Pressable style={styles.addUnlistedBtn} onPress={() => setUnlistedModalOpen(true)}>
                <Ionicons name="create-outline" size={18} color={ios.brand} />
                <Text style={styles.addBtnText}>Add unlisted item</Text>
              </Pressable>
            </View>
            <View style={{ height: 16 }} />
          </ScrollView>

          <View style={styles.footer}>
            <View>
              <Text style={styles.footerEyebrow}>
                {itemCount} ITEM{itemCount === 1 ? "" : "S"}
              </Text>
              <Text style={styles.footerTotal}>${total.toFixed(2)}</Text>
              <PriceLayerGateNotice
                gate={layerGate}
                onRetry={priceLayer.refetch}
                textStyle={{ fontSize: 12, textAlign: "center" }}
              />
            </View>
            <Pressable
              style={[
                styles.saveBtn,
                (updateMut.isPending || layerGate.blocked) && styles.saveBtnDisabled,
              ]}
              onPress={save}
              disabled={updateMut.isPending || layerGate.blocked}
            >
              <Text style={styles.saveBtnText}>
                {updateMut.isPending ? "Saving…" : "Save changes"}
              </Text>
            </Pressable>
          </View>

          {/* B246: permanent scan affordance on the line list — mirrors web's
              always-present scan row (orders/[id]/page.tsx). REG-B62: stays
              hidden until pricing is ready, and while the picker or the
              price-edit modal already has the operator's attention, and while
              any other modal (unlisted item, credit note, licence /
              credit-limit guards) is up — same rule as the driver adjust
              screen. Opens the SAME picker as "Add product", pre-armed to
              scan — no second scanner, no new pricing path. */}
          <BarcodeFab
            hidden={scanFabHidden({
              pricingReady,
              pickerOpen: showPicker,
              priceModalOpen: !!priceEditItem,
              blockingModalOpen:
                unlistedModalOpen || createCreditOpen || !!licenseBlock || !!creditBlock,
            })}
            onPress={() => {
              setPickerScanIntent(true);
              setShowPicker(true);
            }}
          />
        </>
      )}
    </SafeAreaView>
  );
}

// Default export = the operator route (reads the [id] param). The named export
// above is reused by the driver route (R1e).
export default EditOrderItemsScreen;
