import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, SearchBar } from "@routeflow/ui/mobile/ios";
import { useAdminOrder } from "../../../../../lib/api/admin";
import {
  useCreditNotes,
  useCreateCreditNote,
  type CreditNote,
} from "../../../../../lib/api/credit-notes";
import { useCustomerPriceHistory, useUpdateOrderItems } from "../../../../../lib/api/orders";
import { useCustomer, useCustomerPrices } from "../../../../../lib/api/customers";
import { useProductSearch } from "../../../../../lib/use-product-search";
import { showToast } from "../../../../../lib/toast";
import { confirm } from "../../../../../lib/confirm";
import {
  classifyMargin,
  computeLineSubtotal,
  computeMarginFraction,
  effectiveQty,
  getTierPrice,
  perUnitPrice,
  priceForMarginFloor,
  roundMoney,
} from "@routeflow/pricing";
import { freeUnitsLabel } from "../../../../../lib/buyer-cart-logic";
import { incrementLine, incrementLinePiece, setLineUnits } from "../../../../../lib/sale-line";
import { buildSubstituteLine } from "../../../../../lib/substitute-line";
import { findExactScanMatch, looksLikeScanCode, scanUnitKind } from "../../../../../lib/wedge-scan";
import type { ScanOutcome } from "../../../../../lib/scan-loop";
import { useMarginConfig, floorForCategory } from "../../../../../lib/api/margin";
import {
  draftFreeUnits,
  draftTrayRows,
  deserializeEditItemsSnapshot,
  editItemsSnapshotKey,
  hasUnsavedWork,
  isSnapshotStale,
  makeEditItemsSnapshot,
  orderOriginals,
  pickerTrayExpandedHeight,
  serializeEditItemsSnapshot,
  shouldRehydrateFromOrder,
  snapshotBaseline,
  stagedDiffItems,
  EDIT_ITEMS_AUTOSAVE_DEBOUNCE_MS,
  PICKER_TRAY_HANDLE_HEIGHT,
  type DraftItem,
  type BaselineOrderLike,
  type EditItemsSnapshot,
  type StagedEdit,
  type UnlistedDraft,
} from "../../../../../lib/edit-items-draft";
import {
  bumpScanOrder,
  nextFlash,
  type ScanFlash,
  type TrayRow,
} from "../../../../../lib/scan-tray";
import { ScanTray } from "../../../../../components/ScanTray";
import { createScanAcceptGuard } from "../../../../../lib/scan-accept-guard";
import { sanitizeIntInput } from "../../../../../lib/qty";
import { QTY_INPUT_WIDTH } from "../../../../../lib/row-layout";
import { resolveProductByCode } from "../../../../../lib/barcode-resolve";
import { applyPriceOverride } from "../../../../../lib/price-override";
import { BarcodeScanner } from "../../../../../components/BarcodeScanner";
import { BarcodeFab } from "../../../../../components/BarcodeFab";
import { scanFabHidden } from "../../../../../lib/scan-fab-visibility";
import { ProductPickerSheet } from "../../../../../components/ProductPickerSheet";
import { InlineCreateProductSheet } from "../../../../../components/InlineCreateProductSheet";
import { InlineToast, useInlineToast } from "../../../../../components/InlineToast";
import { makeScanHandler, runWedgeSubmit } from "../../../../../lib/scan-ladder";
import { createScanAttempt, createWedgeSubmitHandler } from "../../../../../lib/wedge-submit";
// Shared with NewOrderScreen — edit-items' old local copy had a borderless
// fill3 track; the canonical version uses bgElev + hairline (QtyStepper pill).
import { SellByToggle } from "../../../../../components/SellByToggle";
import { MoneyTextInput } from "../../../../../components/MoneyTextInput";
import { LicenseGuardModal } from "../../../../../components/LicenseGuardModal";
import { CreditLimitGuardModal } from "../../../../../components/CreditLimitGuardModal";
import {
  parseRegulatedAuthError,
  type BlockedCategory,
} from "../../../../../lib/api/authorizations";
import {
  parseCreditLimitError,
  type CreditLimitExceededInfo,
} from "../../../../../lib/credit-limit-error";
import { useAuthStore } from "../../../../../lib/auth-store";
import { fmtCalendarDate } from "../../../../../lib/format-date";

function newLocalId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Server lines -> the editor's staged shape. Extracted from the hydration
 * effect so the restore banner's "Discard changes" can rebuild EXACTLY the
 * state a fresh load would produce, instead of a second, drifting mapping.
 */
function hydrateFromOrder(order: { lineItems?: readonly any[] } | null | undefined): {
  draft: Record<string, DraftItem>;
  unlisted: UnlistedDraft[];
} {
  const next: Record<string, DraftItem> = {};
  const nextUnlisted: UnlistedDraft[] = [];
  for (const li of order?.lineItems ?? []) {
    // Unlisted line (no productId): carry it through the replace-all save so
    // it isn't lost. `name` holds the free-text label.
    // Skip already-cancelled lines (they aren't editable and shouldn't diff).
    if ((li as any).status === "CANCELLED") continue;
    if (!li.productId) {
      nextUnlisted.push({
        id: li.id ?? newLocalId(),
        lineId: li.id ?? undefined,
        name: li.name ?? "Unlisted item",
        unitPrice: toNumber(li.unitPrice),
        qty: toNumber(li.qty),
        notes: (li as any).notes ?? undefined,
      });
      continue;
    }
    const product = (li as any).product ?? {};
    const catalogPrice = toNumber(product.pricePerUnit ?? li.unitPrice);
    const upbRaw = product.unitsPerBox;
    const unitsPerBox = upbRaw == null ? null : Number(upbRaw);
    next[li.productId] = {
      productId: li.productId,
      qty: toNumber(li.qty),
      boxes: li.boxes ?? undefined,
      pieces: li.pieces ?? undefined,
      unitsPerBox,
      unitPrice: toNumber(li.unitPrice),
      catalogPrice,
      name: product.name ?? "Item",
      unit: product.unit,
      overrideReason: li.overrideReason ?? undefined,
      notes: (li as any).notes ?? undefined,
      lineId: li.id ?? undefined,
      // Preserve the stored denomination so a qty-only edit doesn't invent a split.
      boxSplit: li.boxes != null || li.pieces != null,
      // NEW (P10-POS-1): read via the existing `any`-cast `product` ref above —
      // the server already returns these on the order's embedded product, only
      // AdminOrder's TS type doesn't declare them yet (out of scope here).
      averageCost: product.averageCost ?? null,
      category: product.category ?? null,
      // BUY_N_GET_M: the snapshot plus the selling-unit count it was earned
      // at, so a qty edit rescales it exactly like the server does on save.
      promoFreeUnits: li.promoFreeUnits ?? null,
      promoBaseUnits: li.promoFreeUnits
        ? Math.trunc(Number(li.boxes != null ? li.boxes : li.qty) || 0)
        : null,
    };
  }
  return { draft: next, unlisted: nextUnlisted };
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
  const pricingReady =
    !customerId || ((!customerPending || customerFailed) && (!pricesPending || pricesFailed));
  const cpMap = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const cp of customerPrices ?? []) m.set(cp.productId, cp.pricingTier);
    return m;
  }, [customerPrices]);
  const effectiveTierFor = (productId: string) => cpMap.get(productId) ?? customerTier ?? 1;
  /** SPECIAL (tier!==1) lines are the customer's permanent price — never overridable
   *  (the create surface's own rule, components/NewOrderScreen.tsx:627). Mobile's
   *  editor contradicted mobile's builder until this landed; the api-side gate is
   *  still the owner's call, so this is a CLIENT gate only (RULINGS R2/R9). */
  const isSpecialFor = (productId: string) => effectiveTierFor(productId) !== 1;
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
  // session-local, keyed by lineId ?? productId.
  const [floorAcked, setFloorAcked] = useState<Set<string>>(new Set());

  const [draft, setDraft] = useState<Record<string, DraftItem>>({});
  // New + existing ad-hoc lines (productId null). Kept separate from `draft`
  // (which is keyed by productId) and diffed on save so they aren't dropped.
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
  const [priceEditItem, setPriceEditItem] = useState<DraftItem | null>(null);
  const [licenseBlock, setLicenseBlock] = useState<BlockedCategory[] | null>(null);
  const [creditBlock, setCreditBlock] = useState<CreditLimitExceededInfo | null>(null);
  const updateMut = useUpdateOrderItems();

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
  // Rows to show: the customer's open credits, PLUS any credit already
  // applied to this order even if it's no longer ISSUED (e.g. fully consumed)
  // — otherwise a previously-applied credit would vanish from the list
  // instead of showing checked — PLUS any credit just created this session.
  const creditRows = useMemo(() => {
    const rows = new Map<
      string,
      {
        id: string;
        creditNoteNumber: string;
        reason?: string;
        amount: number;
        amountUsed?: number;
        expiresAt?: string | null;
      }
    >();
    for (const cn of openCredits?.data ?? []) {
      rows.set(cn.id, {
        id: cn.id,
        creditNoteNumber: cn.creditNoteNumber,
        reason: cn.reason,
        amount: cn.amount,
        amountUsed: cn.amountUsed,
        expiresAt: cn.expiresAt,
      });
    }
    for (const oc of (order as any)?.orderCreditNotes ?? []) {
      if (!rows.has(oc.creditNoteId) && oc.creditNote) {
        rows.set(oc.creditNoteId, {
          id: oc.creditNoteId,
          creditNoteNumber: oc.creditNote.creditNoteNumber,
          reason: oc.creditNote.reason ?? undefined,
          amount: toNumber(oc.creditNote.amount),
          amountUsed:
            oc.creditNote.amountUsed != null ? toNumber(oc.creditNote.amountUsed) : undefined,
          expiresAt: oc.creditNote.expiresAt ?? null,
        });
      }
    }
    for (const cn of justCreatedCredits) {
      if (!rows.has(cn.id)) {
        rows.set(cn.id, {
          id: cn.id,
          creditNoteNumber: cn.creditNoteNumber,
          reason: cn.reason,
          amount: cn.amount,
          amountUsed: cn.amountUsed,
          expiresAt: cn.expiresAt,
        });
      }
    }
    return Array.from(rows.values());
  }, [openCredits, order, justCreatedCredits]);

  const tierPriceFor = (p: { id: string } & Parameters<typeof getTierPrice>[0]) =>
    getTierPrice(p, cpMap.get(p.id) ?? customerTier ?? 1);

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
  }, [order, id]);

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
  }, [order, baselineOrder, restored, restoreState]);

  // Live total mirrors the server math (BOX-price proration when split).
  const total = useMemo(() => {
    let t = 0;
    for (const it of Object.values(draft)) {
      const qty = effectiveQty(it, it.unitsPerBox);
      if (qty <= 0) continue;
      t += computeLineSubtotal({
        unitPrice: it.unitPrice,
        qty,
        boxes: it.boxes ?? null,
        pieces: it.pieces ?? null,
        unitsPerBox: it.unitsPerBox ?? null,
        // BUY_N_GET_M: free whole units come off before pricing, exactly like
        // the server — otherwise the preview bills an agreed 12-boxes-2-free
        // line at full price and disagrees with what the save writes back.
        freeUnits: draftFreeUnits(it),
      });
    }
    for (const u of unlisted) {
      if (u.qty <= 0) continue;
      t += computeLineSubtotal({ unitPrice: u.unitPrice, qty: u.qty });
    }
    return t;
  }, [draft, unlisted]);

  const itemCount =
    Object.values(draft).filter((it) => effectiveQty(it, it.unitsPerBox) > 0).length +
    unlisted.filter((u) => u.qty > 0).length;

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
    setDraft((d) => {
      const cur = d[id];
      if (!cur) return d;
      const q = Math.max(0, Math.floor(qty));
      const next = { ...d };
      if (q === 0) delete next[id];
      // Plain qty path — clear boxes/pieces so the server treats it as flat.
      else next[id] = { ...cur, qty: q, boxes: undefined, pieces: undefined, boxSplit: false };
      return next;
    });

  const setBoxes = (id: string, boxes: number) =>
    setDraft((d) => {
      const cur = d[id];
      if (!cur) return d;
      const upb = Number(cur.unitsPerBox ?? 0);
      const b = Math.max(0, Math.floor(boxes));
      const pcs = cur.pieces ?? 0;
      const qty = b * upb + pcs;
      const next = { ...d };
      if (qty === 0) delete next[id];
      else next[id] = { ...cur, boxes: b, pieces: pcs, qty, boxSplit: true };
      return next;
    });

  const setPieces = (id: string, pieces: number) =>
    setDraft((d) => {
      const cur = d[id];
      if (!cur) return d;
      const upb = Number(cur.unitsPerBox ?? 0);
      const pcs = Math.max(0, Math.floor(pieces));
      const b = cur.boxes ?? 0;
      const qty = b * upb + pcs;
      const next = { ...d };
      if (qty === 0) delete next[id];
      else next[id] = { ...cur, boxes: b, pieces: pcs, qty, boxSplit: true };
      return next;
    });

  /** Unit mode: the operator types a TOTAL unit count; normalize it back into
   *  cases + loose (7 units of a 6-pack -> 1 case + 1 loose) via setLineUnits. */
  const setUnits = (id: string, units: number) =>
    setDraft((d) => {
      const cur = d[id];
      if (!cur) return d;
      const upb = Number(cur.unitsPerBox ?? 0);
      const line = setLineUnits(cur, units, upb);
      const next = { ...d };
      if (!line) delete next[id];
      else next[id] = { ...line, boxSplit: true };
      return next;
    });

  const setSellBy = (id: string, sellBy: "case" | "unit") =>
    setDraft((d) => (d[id] ? { ...d, [id]: { ...d[id], sellBy } } : d));

  // "Set to floor" one-tap fix (P10-POS-1) — same price-write path as the
  // price-override modal, minus the reason (the ack itself is the record).
  const setLinePrice = (id: string, unitPrice: number) =>
    setDraft((d) => {
      const cur = d[id];
      if (!cur) return d;
      return { ...d, [id]: { ...cur, unitPrice } };
    });

  const setLineNote = (id: string, notes: string) =>
    setDraft((d) => (d[id] ? { ...d, [id]: { ...d[id], notes } } : d));

  const incQty = (id: string) => {
    const cur = draft[id];
    if (!cur) return;
    const upb = Number(cur.unitsPerBox ?? 0);
    if (upb > 1) setBoxes(id, (cur.boxes ?? 0) + 1);
    else setQty(id, (cur.qty ?? 0) + 1);
  };

  /**
   * Add a picked/scanned product to the draft. `kind === "piece"` is a
   * PIECE-barcode (unitSku) hit: one LOOSE piece instead of a box, rolling
   * into a box at unitsPerBox — the same semantics as the sale builders.
   * Shared by tap-pick (closes the picker) and add-and-stay (scans/wedge).
   */
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
      unitsPerBox?: number | null;
    },
    kind: "case" | "piece" = "case",
  ) => {
    const catalogPrice = tierPriceFor(p);
    const listPrice = toNumber(p.pricePerUnit);
    const isSpecial = (cpMap.get(p.id) ?? customerTier ?? 1) !== 1;
    const upbRaw = p.unitsPerBox;
    const unitsPerBox = upbRaw == null ? null : Number(upbRaw);
    setDraft((d) => {
      const existing = d[p.id];
      const upb = Number(existing?.unitsPerBox ?? unitsPerBox ?? 0);
      const boxed = upb > 1;
      if (existing) {
        if (boxed) {
          const line =
            kind === "piece"
              ? incrementLinePiece(existing, true, upb)
              : incrementLine(existing, true, upb);
          return { ...d, [p.id]: { ...line, boxSplit: true } };
        }
        return { ...d, [p.id]: { ...existing, qty: (existing.qty ?? 0) + 1 } };
      }
      // Fresh add: conditionally pre-fill the remembered price — only a
      // genuine discount (below tier) or upsell (above list), never over
      // a SPECIAL tier price. Else start at the tier price.
      const hist = priceHistory?.[p.id];
      const startPrice =
        !isSpecial && hist != null && (hist.lastPrice < catalogPrice || hist.lastPrice > listPrice)
          ? hist.lastPrice
          : catalogPrice;
      const base = {
        productId: p.id,
        unitsPerBox,
        unitPrice: startPrice,
        catalogPrice,
        name: p.name,
        unit: p.unit,
      };
      if (boxed) {
        // 1 box for a case scan/tap; 1 LOOSE piece for a piece-code scan.
        return kind === "piece"
          ? { ...d, [p.id]: { ...base, qty: 1, boxes: 0, pieces: 1, boxSplit: true } }
          : { ...d, [p.id]: { ...base, qty: upb, boxes: 1, pieces: 0, boxSplit: true } };
      }
      return { ...d, [p.id]: { ...base, qty: 1 } };
    });
  };

  const decQty = (id: string) => {
    const cur = draft[id];
    if (!cur) return;
    const upb = Number(cur.unitsPerBox ?? 0);
    if (upb > 1) setBoxes(id, Math.max(0, (cur.boxes ?? 0) - 1));
    else setQty(id, Math.max(0, (cur.qty ?? 0) - 1));
  };

  const removeLine = (id: string) =>
    setDraft((d) => {
      const cur = d[id];
      // An existing (already-saved) line must be explicitly DELETE'd in the diff
      // — otherwise the incremental merge would leave it untouched on the order.
      if (cur?.lineId)
        setPendingDeletes((prev) => (prev.includes(cur.lineId!) ? prev : [...prev, cur.lineId!]));
      const next = { ...d };
      delete next[id];
      return next;
    });

  // ── The picker's pull-out drawer ──────────────────────────────────────────
  // Rows come from the ONE tray derivation the sale builders use
  // (lib/scan-tray.ts via draftTrayRows); the drawer's item count and total
  // are the footer's own `itemCount`/`total`, never a second money derivation.
  const trayRows = useMemo(
    () => draftTrayRows({ draft, unlisted, scanOrder }),
    [draft, unlisted, scanOrder],
  );
  // ScanTray memoizes its rows on callback identity (components/ScanTray.tsx),
  // so these four have to be referentially stable — a "latest deps" ref keeps
  // them stable while still dispatching against the current draft.
  const trayDepsRef = useRef({
    unlisted,
    setUnits,
    incQty,
    decQty,
    removeLine,
    setUnlistedQty,
    removeUnlisted,
  });
  trayDepsRef.current = {
    unlisted,
    setUnits,
    incQty,
    decQty,
    removeLine,
    setUnlistedQty,
    removeUnlisted,
  };
  const unlistedRow = (id: string) => trayDepsRef.current.unlisted.find((u) => u.id === id);
  // ScanTray hands a TOTAL UNIT count (ScanTray.tsx), which is exactly what
  // `setUnits` normalises back into cases + loose.
  const onTrayChangeQty = useCallback((id: string, units: number) => {
    const d = trayDepsRef.current;
    if (unlistedRow(id)) d.setUnlistedQty(id, units);
    else d.setUnits(id, units);
  }, []);
  const onTrayIncrement = useCallback((id: string) => {
    const d = trayDepsRef.current;
    const u = unlistedRow(id);
    if (u) d.setUnlistedQty(id, u.qty + 1);
    else d.incQty(id);
  }, []);
  const onTrayDecrement = useCallback((id: string) => {
    const d = trayDepsRef.current;
    const u = unlistedRow(id);
    if (u) d.setUnlistedQty(id, u.qty - 1);
    else d.decQty(id);
  }, []);
  const onTrayRemove = useCallback((id: string) => {
    const d = trayDepsRef.current;
    if (unlistedRow(id)) d.removeUnlisted(id);
    else d.removeLine(id);
  }, []);

  // ── Save ─────────────────────────────────────────────────────────────────

  const save = () => {
    if (!id) return;
    // Build an incremental diff (replaceAll:false) so untouched lines keep their
    // ids, invoiced qty, and override history — the old full-replace clobbered them.
    // `notes` (per-line, buyer-visible) is threaded through the diff so editing a
    // note is picked up as a change and never silently wiped.
    // buildOrderItemDiff auto-DELETEs any original line absent from the surviving
    // catalog/unlisted lines — covering removals via the qty stepper (zeroing),
    // not just the trash button — so `pendingDeletes` here is just the explicit
    // trash-button set. The whole mapping lives in lib/edit-items-draft.ts so
    // the dirty check and this payload are ONE derivation.
    const items = stagedDiffItems({ draft, unlisted, pendingDeletes }, originals);

    if (items.length === 0 && !creditsTouched) {
      // Nothing changed — mirror web: just leave the editor, don't error.
      savedRef.current = true;
      void clearSnapshot();
      leaveEditor();
      return;
    }
    updateMut.mutate(
      {
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
      },
      {
        onSuccess: () => {
          showToast("Items updated");
          // A saved edit must never be offered for restore again — the latch
          // also stops the unmount/beforeRemove flush re-writing it behind us.
          savedRef.current = true;
          void clearSnapshot();
          // Land on the orders LIST after a successful save instead of
          // popping back to the order detail. The user reported "Back" not
          // taking them to all orders after submit; explicit navigation
          // sidesteps any unstable back-stack state when the screen was
          // reached via deep link or a fresh tab switch. (Driver → back to stop.)
          leaveEditor();
        },
        onError: (e: any) => {
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
          showToast(e?.response?.data?.message ?? e?.message ?? "Try again.");
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
          item={priceEditItem}
          isSpecial={isSpecialFor(priceEditItem.productId)}
          onSave={(price, reason) => {
            // B263 D2: rounding + lineTotal recompute now live in the shared
            // helper (money discipline) — never write the raw typed price.
            const updated = applyPriceOverride(priceEditItem, {
              unitPrice: price,
              reason: reason || undefined,
            });
            setDraft((d) => ({
              ...d,
              [priceEditItem.productId]: {
                ...priceEditItem,
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
          initialScanOpen={pickerScanIntent}
          // Add-and-stay (scans + wedge input): the picker stays open so N
          // items scan with zero taps — closes web's long-standing edit-screen
          // divergence. Not offered in substitute mode (one pick by contract).
          onPickAndStay={
            substituteFor
              ? undefined
              : (p, kind) => {
                  addPickedToDraft(p, kind);
                  setLastScannedId(p.id);
                  setScanOrder((o) => bumpScanOrder(o, p.id));
                  setTrayFlash((f) => nextFlash(f, p.id));
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
          lastAddedAcked={
            lastAddedLine ? floorAcked.has(lastAddedLine.lineId ?? lastAddedLine.productId) : false
          }
          // Finding B263-H: the same floor-FRACTION call the list row's own
          // `marginFloor` prop uses (`:983`) — lets the strip classify
          // `lastAdded` with the row's exact derivation, not a hand-rolled one.
          marginFloor={floorForCategory(marginConfig, lastAddedLine?.category)}
          // The list row's Set-to-floor writer, verbatim (`setLinePrice`) —
          // one price-write path for both surfaces.
          onSetToFloor={(item, price) => setLinePrice(item.productId, price)}
          onEditPrice={(item, price, reason) => {
            setDraft((d) => {
              const cur = d[item.productId];
              if (!cur) return d;
              return {
                ...d,
                [item.productId]: { ...cur, unitPrice: price, overrideReason: reason },
              };
            });
          }}
          onScanSessionStart={() => setLastScannedId(null)}
          // RULINGS R5: the camera CLOSING does not undo the add, so this no
          // longer clears `lastScannedId` — the price affordance has to survive
          // an add made with the camera shut (a wedge scanner, a typed code).
          // Only the row flash, which belongs to the camera session, is cleared.
          onScanSessionEnd={() => setTrayFlash(null)}
          onPick={(p, kind) => {
            if (substituteFor) {
              const tierPrice = tierPriceFor(p);
              const listPrice = toNumber(p.pricePerUnit);
              setDraft((d) => {
                const next = { ...d };
                const old = next[substituteFor];
                delete next[substituteFor];
                // Re-denominates the inherited piece count against the
                // SUBSTITUTE's box size and keeps its LIST price as the line's
                // base, so the box split and the customer's tier price both
                // reach the server (lib/substitute-line.ts).
                next[p.id] = buildSubstituteLine({
                  previous: old,
                  product: { id: p.id, name: p.name, unit: p.unit, unitsPerBox: p.unitsPerBox },
                  tierPrice,
                  listPrice,
                });
                return next;
              });
              setSubstituteFor(null);
            } else {
              addPickedToDraft(p, kind);
              setScanOrder((o) => bumpScanOrder(o, p.id));
              setTrayFlash((f) => nextFlash(f, p.id));
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
                Object.values(draft).map((it) => (
                  <DraftItemCard
                    key={it.productId}
                    item={it}
                    canSplitBoxes={canSplitBoxes}
                    canEditPrice={canEditPriceFor(it.productId)}
                    pricingReady={pricingReady}
                    marginFloor={floorForCategory(marginConfig, it.category)}
                    acked={floorAcked.has(it.lineId ?? it.productId)}
                    onSetToFloor={(price) => setLinePrice(it.productId, price)}
                    onSellAnyway={() =>
                      setFloorAcked((prev) => new Set(prev).add(it.lineId ?? it.productId))
                    }
                    onIncQty={() => incQty(it.productId)}
                    onDecQty={() => decQty(it.productId)}
                    onSetQty={(n) => setQty(it.productId, n)}
                    onSetBoxes={(n) => setBoxes(it.productId, n)}
                    onSetPieces={(n) => setPieces(it.productId, n)}
                    onSetUnits={(n) => setUnits(it.productId, n)}
                    onSetSellBy={(v) => setSellBy(it.productId, v)}
                    onSetNote={(notes) => setLineNote(it.productId, notes)}
                    onPressPrice={() => setPriceEditItem(it)}
                    onPressSubstitute={() => {
                      setSubstituteFor(it.productId);
                      setShowPicker(true);
                    }}
                    onRemove={() =>
                      confirm("Remove item?", it.name, () => removeLine(it.productId), {
                        confirmText: "Remove",
                        destructive: true,
                      })
                    }
                  />
                ))
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
            </View>
            <Pressable
              style={[styles.saveBtn, updateMut.isPending && styles.saveBtnDisabled]}
              onPress={save}
              disabled={updateMut.isPending}
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

/**
 * B263 (review round) — the ONE margin-floor derivation both price-edit
 * surfaces read: the list row's below-floor guard and the picker's
 * last-added strip. Same helper, same arguments (`averageCost` per piece,
 * the line's category floor, `unitsPerBox`), so a price the row flags is
 * flagged identically on the scan surface. Null when the product has no
 * known cost — no cost, no floor, no ack.
 */
function marginFloorPrice(item: DraftItem, marginFloor: number): number | null {
  const pieceCost = item.averageCost != null ? toNumber(item.averageCost) : null;
  if (pieceCost == null || !Number.isFinite(pieceCost)) return null;
  const marginFrac = computeMarginFraction(item.unitPrice, pieceCost, item.unitsPerBox);
  if (classifyMargin(marginFrac, marginFloor) == null) return null;
  return priceForMarginFloor(pieceCost, marginFloor, item.unitsPerBox);
}

// ─── Per-row card ────────────────────────────────────────────────────────────

/**
 * Draft line as a card with three zones:
 *   ┌─────────────────────────────────────────────┐
 *   │ Name                            $line total │  ← header
 *   │ $unit · per box of N · SKU                  │  ← meta
 *   ├─────────────────────────────────────────────┤
 *   │ Boxes  [- 2 +]    Loose pieces  [- 3 +]     │  ← editor (boxed)
 *   │   or                                        │
 *   │ Qty    [- 4 +]                              │  ← editor (loose)
 *   ├─────────────────────────────────────────────┤
 *   │ [Sub]  [Override]  [trash]                  │  ← actions
 *   └─────────────────────────────────────────────┘
 *
 * The previous design crammed everything into one row + tiny trash + tiny
 * stepper, which the user called out as ugly and missing the box/piece
 * controls. This stacked layout gives each function room to breathe.
 */
function DraftItemCard({
  item,
  canSplitBoxes,
  canEditPrice,
  pricingReady,
  marginFloor,
  acked,
  onSetToFloor,
  onSellAnyway,
  onIncQty,
  onDecQty,
  onSetQty,
  onSetBoxes,
  onSetPieces,
  onSetUnits,
  onSetSellBy,
  onSetNote,
  onPressPrice,
  onPressSubstitute,
  onRemove,
}: {
  item: DraftItem;
  canSplitBoxes: boolean;
  /** Price / discount editing is offered while the order is editable (DRAFT/PENDING/CONFIRMED). */
  canEditPrice: boolean;
  /** B62 (REG-B62): false while the customer/customer-price queries are in
   *  flight — gates Substitute, which prices (and SENDS) the replacement line
   *  off the tier that isn't known yet. */
  pricingReady: boolean;
  /** Category margin floor (fraction) for the live cost/margin hint. */
  marginFloor: number;
  /** Whether this line was already acked as "sell anyway" below the floor. */
  acked: boolean;
  onSetToFloor: (price: number) => void;
  onSellAnyway: () => void;
  onIncQty: () => void;
  onDecQty: () => void;
  onSetQty: (n: number) => void;
  onSetBoxes: (n: number) => void;
  onSetPieces: (n: number) => void;
  /** Unit mode: total unit count, routed through setLineUnits. */
  onSetUnits: (n: number) => void;
  onSetSellBy: (sellBy: "case" | "unit") => void;
  onSetNote: (notes: string) => void;
  onPressPrice: () => void;
  onPressSubstitute: () => void;
  onRemove: () => void;
}) {
  const [noteOpen, setNoteOpen] = useState(Boolean(item.notes?.trim()));
  const isOverridden = item.unitPrice !== item.catalogPrice;
  const isUpsell = item.unitPrice > item.catalogPrice;
  // Green for an upsell (sold above catalog), orange for a discount.
  const overrideColor = isUpsell ? ios.system.greenInk : ios.system.orangeInk;
  const upb = Number(item.unitsPerBox ?? 0);
  const isBoxed = upb > 1 && canSplitBoxes;
  const sellBy = item.sellBy ?? "case";
  const qty = effectiveQty(item, item.unitsPerBox);
  const freeUnits = draftFreeUnits(item);
  const freeLabel = freeUnitsLabel(freeUnits);
  const lineTotal = computeLineSubtotal({
    unitPrice: item.unitPrice,
    qty,
    boxes: item.boxes ?? null,
    pieces: item.pieces ?? null,
    unitsPerBox: item.unitsPerBox ?? null,
    freeUnits,
  });

  // Live cost/margin hint (P10-POS-1) — hides entirely when cost is unknown
  // (product never sold yet). Mirrors NewOrderScreen's CartRow.
  const pieceCost = item.averageCost != null ? toNumber(item.averageCost) : null;
  const hasCost = pieceCost != null && Number.isFinite(pieceCost);
  const marginFrac = hasCost
    ? computeMarginFraction(item.unitPrice, pieceCost, item.unitsPerBox)
    : null;
  const marginClass = classifyMargin(marginFrac, marginFloor);
  // Same derivation the picker's last-added strip reads (one helper, two
  // surfaces) — unchanged behaviour: `classifyMargin` is null exactly when
  // the cost is unknown, which is exactly when `hasCost` is false.
  const floorPrice = marginFloorPrice(item, marginFloor);
  const below = marginClass === "belowCost" || marginClass === "belowFloor";
  // Display-only per-unit hint on the case price — never fed back into math.
  const perUnitHint = isBoxed ? perUnitPrice(item.unitPrice, upb) : null;

  return (
    <View style={styles.card}>
      {/* Header: name + line total */}
      <View style={styles.cardHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.cardName} numberOfLines={2}>
            {item.name}
          </Text>
          {/* Meta line: unit price + box hint + override badge.
              Editable (tappable) on DRAFT/PENDING/CONFIRMED; read-only otherwise. */}
          <View style={styles.cardMetaRow}>
            {canEditPrice ? (
              <Pressable onPress={onPressPrice} style={styles.priceTap} hitSlop={6}>
                {isOverridden && !isUpsell ? (
                  <Text style={styles.priceStrike}>${item.catalogPrice.toFixed(2)}</Text>
                ) : null}
                <Text
                  style={[styles.cardMeta, isOverridden && { color: overrideColor }]}
                  numberOfLines={2}
                >
                  ${item.unitPrice.toFixed(2)}
                  {isBoxed ? ` / box of ${upb}` : item.unit ? ` / ${item.unit}` : ""}
                  {perUnitHint != null ? ` · ≈ $${perUnitHint.toFixed(2)}/unit` : ""}
                </Text>
                {isUpsell ? (
                  <Text style={{ color: ios.system.greenInk, fontSize: 11, fontWeight: "600" }}>
                    Upsell
                  </Text>
                ) : null}
                <Ionicons
                  name="pencil-outline"
                  size={11}
                  color={isOverridden ? overrideColor : ios.label3}
                />
              </Pressable>
            ) : (
              <View style={styles.priceTap}>
                {isOverridden && !isUpsell ? (
                  <Text style={styles.priceStrike}>${item.catalogPrice.toFixed(2)}</Text>
                ) : null}
                <Text
                  style={[styles.cardMeta, isOverridden && { color: overrideColor }]}
                  numberOfLines={2}
                >
                  ${item.unitPrice.toFixed(2)}
                  {isBoxed ? ` / box of ${upb}` : item.unit ? ` / ${item.unit}` : ""}
                  {perUnitHint != null ? ` · ≈ $${perUnitHint.toFixed(2)}/unit` : ""}
                </Text>
                {isUpsell ? (
                  <Text style={{ color: ios.system.greenInk, fontSize: 11, fontWeight: "600" }}>
                    Upsell
                  </Text>
                ) : null}
              </View>
            )}
          </View>
          {/* BUY_N_GET_M: name the free units, or the reduced line total reads
              as a pricing error (mirrors web's order/invoice line rows). */}
          {freeLabel ? <Text style={styles.freeLabel}>{freeLabel}</Text> : null}
        </View>
        <Text style={styles.cardTotal}>${lineTotal.toFixed(2)}</Text>
      </View>

      {/* Live margin hint (pos-cost-roles-spec §1) — margin on the current
          unit price vs. the product's cost. */}
      {marginFrac != null ? (
        <Text
          style={[
            styles.marginHint,
            marginClass === "belowCost" || marginClass === "belowFloor"
              ? { color: ios.system.red }
              : marginClass === "warn"
                ? { color: ios.system.orange }
                : { color: ios.label2 },
          ]}
        >
          {marginClass === "belowCost"
            ? `Below cost (${Math.round(marginFrac * 100)}%)`
            : marginClass === "belowFloor"
              ? `Below floor · ${Math.round(marginFrac * 100)}% margin`
              : `${Math.round(marginFrac * 100)}% margin`}
        </Text>
      ) : null}

      {/* Below-floor one-tap fix + ack — only while price editing is allowed. */}
      {canEditPrice && below && !acked && floorPrice != null ? (
        <View style={{ flexDirection: "row", gap: 10, marginTop: -4 }}>
          <Pressable onPress={() => onSetToFloor(floorPrice!)} style={styles.floorFixBtn}>
            <Text style={styles.floorFixBtnText}>Set to floor ${floorPrice.toFixed(2)}</Text>
          </Pressable>
          <Pressable onPress={onSellAnyway} hitSlop={6}>
            <Text style={styles.sellAnywayText}>Sell anyway</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Editor — a Cases/Units segmented control switches entry mode. Cases
          mode dials Boxes and Loose units independently; Units mode is a
          single uncapped total-unit stepper routed through setLineUnits. */}
      {isBoxed ? (
        <View style={{ gap: 8 }}>
          <SellByToggle value={sellBy} onChange={onSetSellBy} />
          {sellBy === "unit" ? (
            <StepperRow
              label={`Total ${item.unit ? `${item.unit}s` : "units"}`}
              value={qty}
              onChange={onSetUnits}
              hint={`${upb} per case`}
            />
          ) : (
            <>
              <StepperRow label="Cases" value={item.boxes ?? 0} onChange={onSetBoxes} />
              <StepperRow
                label={`Loose ${item.unit ?? "units"}`}
                value={item.pieces ?? 0}
                onChange={onSetPieces}
                max={upb - 1}
                hint={`${upb} per case`}
              />
            </>
          )}
        </View>
      ) : (
        <StepperRow
          label={`Qty${item.unit ? ` (${item.unit})` : ""}`}
          value={item.qty}
          onChange={onSetQty}
          onIncrement={onIncQty}
          onDecrement={onDecQty}
        />
      )}

      {/* Flavor / note (R5.2) */}
      {noteOpen || item.notes?.trim() ? (
        <TextInput
          value={item.notes ?? ""}
          onChangeText={onSetNote}
          placeholder="Flavor or note for this item (prints on invoice)"
          placeholderTextColor={ios.label3}
          maxLength={500}
          returnKeyType="done"
          style={styles.cartNoteInput}
        />
      ) : (
        <Pressable onPress={() => setNoteOpen(true)} hitSlop={6} style={styles.cartNoteAdd}>
          <Ionicons name="create-outline" size={14} color={ios.brand} />
          <Text style={styles.cartNoteAddText}>Add flavor / note</Text>
        </Pressable>
      )}

      {/* Actions */}
      <View style={styles.cardActions}>
        <Pressable
          style={[styles.actionChip, !pricingReady && styles.actionChipDisabled]}
          onPress={onPressSubstitute}
          disabled={!pricingReady}
          hitSlop={4}
        >
          <Ionicons name="swap-horizontal-outline" size={14} color={ios.brand} />
          <Text style={styles.actionChipText}>Substitute</Text>
        </Pressable>
        {canEditPrice ? (
          <Pressable
            style={[styles.actionChip, isOverridden && styles.actionChipActive]}
            onPress={onPressPrice}
            hitSlop={4}
          >
            <Ionicons
              name="pricetag-outline"
              size={14}
              color={isOverridden ? ios.system.orangeInk : ios.brand}
            />
            <Text style={[styles.actionChipText, isOverridden && { color: ios.system.orangeInk }]}>
              {isOverridden ? "Price overridden" : "Override price"}
            </Text>
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }} />
        <Pressable style={styles.deleteBtn} onPress={onRemove} hitSlop={6}>
          <Ionicons name="trash-outline" size={16} color={ios.system.redInk} />
        </Pressable>
      </View>
    </View>
  );
}

// ─── Reusable stepper row (Boxes/Pieces/Qty) ─────────────────────────────────

function StepperRow({
  label,
  value,
  onChange,
  onIncrement,
  onDecrement,
  max,
  hint,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  onIncrement?: () => void;
  onDecrement?: () => void;
  max?: number;
  hint?: string;
}) {
  // Local draft so the user can clear the input without it snapping back to 0.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const dec = () => {
    if (onDecrement) onDecrement();
    else onChange(Math.max(0, value - 1));
  };
  const inc = () => {
    if (onIncrement) onIncrement();
    else {
      const next = max != null ? Math.min(max, value + 1) : value + 1;
      onChange(next);
    }
  };

  return (
    <View style={styles.stepperRow}>
      <View style={{ flex: 1 }}>
        {/* Clamped: unclamped, a squeezed column renders the label one letter
            per line on react-native-web. See lib/row-layout.ts. */}
        <Text style={styles.stepperLabel} numberOfLines={1}>
          {label}
        </Text>
        {hint ? (
          <Text style={styles.stepperHint} numberOfLines={1}>
            {hint}
          </Text>
        ) : null}
      </View>
      <View style={styles.stepper}>
        <Pressable style={styles.stepBtn} onPress={dec} hitSlop={6}>
          <Text style={styles.stepText}>−</Text>
        </Pressable>
        <TextInput
          style={styles.qtyInput}
          value={draft}
          onChangeText={(txt) => {
            // Integer-only: strip non-digits + leading zeros live (no "05", no
            // decimals even when Android shows a decimal key); allow empty mid-edit.
            const clean = sanitizeIntInput(txt);
            setDraft(clean);
            if (clean === "") return;
            const n = parseInt(clean, 10);
            if (Number.isFinite(n)) {
              const clamped = max != null ? Math.min(max, n) : n;
              onChange(clamped);
            }
          }}
          onBlur={() => {
            if (draft === "") onChange(0);
            setDraft(String(value));
          }}
          keyboardType="number-pad"
          returnKeyType="done"
          maxLength={5}
          selectTextOnFocus
        />
        <Pressable style={styles.stepBtn} onPress={inc} hitSlop={6}>
          <Text style={styles.stepText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─── Price override modal ────────────────────────────────────────────────────

function PriceOverrideModal({
  item,
  onSave,
  onCancel,
  isSpecial = false,
}: {
  item: DraftItem;
  onSave: (newPrice: number, reason: string) => void;
  onCancel: () => void;
  /** B465: this customer's documented contract price for the product — a
   *  reason is REQUIRED to override it here, never optional like a plain
   *  line. `canEditPriceFor` already hides this modal's own trigger for a
   *  SPECIAL line today; this is defense-in-depth for any path that reaches
   *  it, mirroring the server's own refusal and the web reference. */
  isSpecial?: boolean;
}) {
  const [priceText, setPriceText] = useState(item.unitPrice.toFixed(2));
  // "$ off / unit" is a lens over (catalogPrice - newPrice); the two inputs stay in sync.
  const [offText, setOffText] = useState(
    item.unitPrice < item.catalogPrice
      ? roundMoney(item.catalogPrice - item.unitPrice).toFixed(2)
      : "",
  );
  const [reason, setReason] = useState(item.overrideReason ?? "");
  const newPrice = toNumber(priceText);
  const reasonMissing = isSpecial && reason.trim() === "";
  const valid = newPrice > 0 && !reasonMissing;

  const onChangePrice = (raw: string) => {
    setPriceText(raw);
    const parsed = parseFloat(raw);
    if (raw.trim() === "" || isNaN(parsed)) {
      setOffText("");
      return;
    }
    setOffText(parsed < item.catalogPrice ? roundMoney(item.catalogPrice - parsed).toFixed(2) : "");
  };

  const onChangeOff = (raw: string) => {
    setOffText(raw);
    const off = parseFloat(raw);
    if (raw.trim() === "" || isNaN(off) || off <= 0) {
      setPriceText(item.catalogPrice.toFixed(2));
      return;
    }
    setPriceText(roundMoney(Math.max(0, item.catalogPrice - off)).toFixed(2));
  };

  return (
    <Modal transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.modalOverlay} onPress={onCancel}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.modalTitle}>Override price</Text>
          <Text style={styles.modalSub}>{item.name}</Text>
          <Text style={styles.modalLabel}>List price: ${item.catalogPrice.toFixed(2)}</Text>

          <Text style={styles.modalFieldLabel}>New unit price</Text>
          <TextInput
            style={styles.modalInput}
            value={priceText}
            onChangeText={onChangePrice}
            keyboardType="decimal-pad"
            selectTextOnFocus
            autoFocus
            placeholder="0.00"
            placeholderTextColor={ios.label3}
          />

          <Text style={styles.modalFieldLabel}>Amount off / unit</Text>
          <TextInput
            style={styles.modalInput}
            value={offText}
            onChangeText={onChangeOff}
            keyboardType="decimal-pad"
            selectTextOnFocus
            placeholder="0.00"
            placeholderTextColor={ios.label3}
          />

          <Text style={styles.modalFieldLabel}>
            {isSpecial ? "Reason (required)" : "Reason (optional)"}
          </Text>
          <TextInput
            style={[
              styles.modalInput,
              { marginBottom: 16 },
              reasonMissing ? styles.modalInputError : null,
            ]}
            value={reason}
            onChangeText={setReason}
            placeholder={isSpecial ? "e.g. manager approved" : "e.g. daily market price"}
            placeholderTextColor={reasonMissing ? ios.system.red : ios.label3}
          />

          <View style={styles.modalBtns}>
            <Pressable style={styles.modalBtnGhost} onPress={onCancel}>
              <Text style={styles.modalBtnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.modalBtnFill, !valid && styles.modalBtnDisabled]}
              onPress={() => valid && onSave(newPrice, reason)}
              disabled={!valid}
            >
              <Text style={styles.modalBtnFillText}>Apply</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── Unlisted draft card ─────────────────────────────────────────────────────

/**
 * Card for an ad-hoc (unlisted) line: editable free-text name + price + qty,
 * a "Custom" tag, and no product image (it isn't in the catalog).
 */
function UnlistedDraftCard({
  line,
  onSetName,
  onSetNote,
  onSetPrice,
  onSetQty,
  onRemove,
}: {
  line: UnlistedDraft;
  onSetName: (name: string) => void;
  onSetNote: (notes: string) => void;
  onSetPrice: (value: number | null) => void;
  onSetQty: (n: number) => void;
  onRemove: () => void;
}) {
  const [noteOpen, setNoteOpen] = useState(Boolean(line.notes?.trim()));
  const lineTotal = computeLineSubtotal({ unitPrice: line.unitPrice, qty: line.qty });
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.unlistedTagRow}>
            <View style={styles.customTag}>
              <Text style={styles.customTagText}>Custom</Text>
            </View>
          </View>
          <TextInput
            style={styles.unlistedNameInput}
            value={line.name}
            onChangeText={onSetName}
            placeholder="Item name"
            placeholderTextColor={ios.label3}
          />
          <View style={styles.unlistedPriceRow}>
            <Text style={styles.cardMeta}>$</Text>
            <MoneyTextInput
              style={styles.unlistedPriceInput}
              value={line.unitPrice || null}
              onChangeValue={onSetPrice}
              placeholder="0.00"
              placeholderTextColor={ios.label3}
            />
            <Text style={styles.cardMeta}>/ unit</Text>
          </View>
        </View>
        <Text style={styles.cardTotal}>${lineTotal.toFixed(2)}</Text>
      </View>

      <StepperRow
        label="Qty"
        value={line.qty}
        onChange={onSetQty}
        onIncrement={() => onSetQty(line.qty + 1)}
        onDecrement={() => onSetQty(Math.max(0, line.qty - 1))}
      />

      {/* Flavor / note (R5.3) */}
      {noteOpen || line.notes?.trim() ? (
        <TextInput
          value={line.notes ?? ""}
          onChangeText={onSetNote}
          placeholder="Flavor or note for this item (prints on invoice)"
          placeholderTextColor={ios.label3}
          maxLength={500}
          returnKeyType="done"
          style={styles.cartNoteInput}
        />
      ) : (
        <Pressable onPress={() => setNoteOpen(true)} hitSlop={6} style={styles.cartNoteAdd}>
          <Ionicons name="create-outline" size={14} color={ios.brand} />
          <Text style={styles.cartNoteAddText}>Add flavor / note</Text>
        </Pressable>
      )}

      <View style={styles.cardActions}>
        <View style={{ flex: 1 }} />
        <Pressable style={styles.deleteBtn} onPress={onRemove} hitSlop={6}>
          <Ionicons name="trash-outline" size={16} color={ios.system.redInk} />
        </Pressable>
      </View>
    </View>
  );
}

// ─── Unlisted item modal ─────────────────────────────────────────────────────

function UnlistedItemModal({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (name: string, unitPrice: number, qty: number) => void;
}) {
  const [name, setName] = useState("");
  const [priceText, setPriceText] = useState("");
  const [qtyText, setQtyText] = useState("1");

  useEffect(() => {
    if (open) {
      setName("");
      setPriceText("");
      setQtyText("1");
    }
  }, [open]);

  const price = parseFloat(priceText);
  const qty = parseInt(qtyText || "0", 10);
  const valid = name.trim() !== "" && Number.isFinite(price) && price > 0 && qty > 0;

  if (!open) return null;

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.modalTitle}>Add unlisted item</Text>
          <Text style={styles.modalSub}>A one-off line that isn't in your catalog.</Text>

          <Text style={styles.modalFieldLabel}>Item name</Text>
          <TextInput
            style={styles.modalInput}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Delivery surcharge"
            placeholderTextColor={ios.label3}
            autoFocus
          />

          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.modalFieldLabel}>Unit price</Text>
              <TextInput
                style={styles.modalInput}
                value={priceText}
                onChangeText={setPriceText}
                placeholder="0.00"
                placeholderTextColor={ios.label3}
                keyboardType="decimal-pad"
                selectTextOnFocus
              />
            </View>
            <View style={{ width: 96 }}>
              <Text style={styles.modalFieldLabel}>Qty</Text>
              <TextInput
                style={styles.modalInput}
                value={qtyText}
                onChangeText={(t) => setQtyText(sanitizeIntInput(t))}
                placeholder="1"
                placeholderTextColor={ios.label3}
                keyboardType="number-pad"
                maxLength={5}
                selectTextOnFocus
              />
            </View>
          </View>

          <View style={styles.modalBtns}>
            <Pressable style={styles.modalBtnGhost} onPress={onClose}>
              <Text style={styles.modalBtnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.modalBtnFill, !valid && styles.modalBtnDisabled]}
              onPress={() => valid && onAdd(name.trim(), price, qty)}
              disabled={!valid}
            >
              <Text style={styles.modalBtnFillText}>Add to order</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── Inline "New credit note" create modal ───────────────────────────────────

/**
 * Compact inline credit-note create sheet, opened from the Apply-credit
 * section when the operator needs one that doesn't exist yet — a standalone
 * credit for this order's customer (no invoice link).
 */
function CreateCreditNoteModal({
  open,
  customerId,
  onClose,
  onCreated,
}: {
  open: boolean;
  customerId: string;
  onClose: () => void;
  onCreated: (created: CreditNote) => void;
}) {
  const createMut = useCreateCreditNote();
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setAmount(null);
      setReason("");
      setError(null);
    }
  }, [open]);

  const valid = amount != null && amount > 0 && reason.trim() !== "";

  const submit = () => {
    if (!valid) return;
    setError(null);
    createMut.mutate(
      { customerId, amount: amount!, reason: reason.trim() },
      {
        onSuccess: (created) => onCreated(created),
        onError: (e: unknown) => {
          const err = e as { response?: { data?: { message?: string } }; message?: string };
          setError(err?.response?.data?.message ?? err?.message ?? "Couldn't create credit note.");
        },
      },
    );
  };

  if (!open) return null;

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.modalTitle}>New credit note</Text>
          <Text style={styles.modalSub}>A standalone store credit for this customer.</Text>

          {error ? (
            <Text style={{ color: ios.system.redInk, fontSize: 12, marginBottom: 8 }}>{error}</Text>
          ) : null}

          <Text style={styles.modalFieldLabel}>Amount</Text>
          <MoneyTextInput
            style={styles.modalInput}
            value={amount}
            onChangeValue={setAmount}
            placeholder="0.00"
            placeholderTextColor={ios.label3}
            autoFocus
          />

          <Text style={styles.modalFieldLabel}>Reason</Text>
          <TextInput
            style={styles.modalInput}
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. Damaged goods"
            placeholderTextColor={ios.label3}
          />

          <View style={styles.modalBtns}>
            <Pressable style={styles.modalBtnGhost} onPress={onClose}>
              <Text style={styles.modalBtnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[
                styles.modalBtnFill,
                (!valid || createMut.isPending) && styles.modalBtnDisabled,
              ]}
              onPress={submit}
              disabled={!valid || createMut.isPending}
            >
              <Text style={styles.modalBtnFillText}>
                {createMut.isPending ? "Creating…" : "Create"}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── Product picker ──────────────────────────────────────────────────────────

interface PickedProduct {
  id: string;
  name: string;
  pricePerUnit: number | string;
  priceTier2?: number | string | null;
  priceTier3?: number | string | null;
  priceTier4?: number | string | null;
  priceTier5?: number | string | null;
  unit?: string;
  unitsPerBox?: number | null;
}

function ProductPicker({
  title = "Add product",
  onPick,
  onPickAndStay,
  onClose,
  canCreateProducts = false,
  initialScanOpen,
  lastAdded,
  lastAddedFloor,
  lastAddedAcked = false,
  marginFloor,
  onEditPrice,
  onSetToFloor,
  canEditPrice = false,
  isSpecialTierFor,
  onScanSessionStart,
  onScanSessionEnd,
  trayRows,
  trayFlash,
  trayItemCount,
  trayTotal,
  onTrayChangeQty,
  onTrayIncrement,
  onTrayDecrement,
  onTrayRemove,
}: {
  title?: string;
  /** Single pick — the caller closes the picker (tap rows, substitutions). */
  onPick: (p: PickedProduct, kind?: "case" | "piece") => void;
  /**
   * Add WITHOUT closing — scans and wedge input use this so N items go in
   * with zero taps (closes the long-standing divergence from web's edit
   * screen, which re-focuses its scan input after every add). Absent in
   * substitute mode, where the contract is exactly one pick.
   */
  onPickAndStay?: (p: PickedProduct, kind: "case" | "piece") => void;
  onClose: () => void;
  /** Staff may create a product from a miss; drivers get a plain "not found". */
  canCreateProducts?: boolean;
  /** B246: mount already scanning — the line-list scan FAB's entry point. */
  initialScanOpen?: boolean;
  /**
   * B263 D3: the parent's draft line for the most recent scan-add, so the
   * picker can show a "last added" strip with an inline price edit without
   * leaving the scan surface. Null before any scan-add this picker session,
   * and in substitute mode (no `onPickAndStay`).
   */
  lastAdded?: DraftItem | null;
  /**
   * `lastAdded`'s margin floor, derived by the parent with the SAME helper
   * (`marginFloorPrice`) and arguments the line list's below-floor guard
   * uses. Null when the product has no known cost — then there is no floor
   * and the strip shows no below-floor affordance.
   */
  lastAddedFloor?: number | null;
  /**
   * Whether the operator already tapped "Sell anyway" on `lastAdded` in the
   * line list. `floorAcked` keeps exactly ONE writer (that tap): the strip
   * reads the ack, never stamps it.
   */
  lastAddedAcked?: boolean;
  /**
   * `lastAdded`'s category margin floor FRACTION (e.g. 0.15) — the same
   * `floorForCategory(marginConfig, category)` call the list row's own
   * `marginFloor` prop is built from (`:983`). Lets the strip classify
   * `lastAdded` with the EXACT same two calls the row uses
   * (`computeMarginFraction` -> `classifyMargin`), so "below cost" vs
   * "below floor" can never read differently on the two surfaces for the
   * same line (finding B263-H).
   */
  marginFloor: number;
  /**
   * Applies an already-computed price override (rounded, `overrideReason`
   * set) to `lastAdded` in the parent's draft — the same `setDraft` write the
   * list branch uses.
   */
  onEditPrice: (item: DraftItem, unitPrice: number, overrideReason: string | undefined) => void;
  /**
   * The list row's one-tap "Set to floor" writer, threaded verbatim, so the
   * strip's fix writes the price through exactly the same path.
   */
  onSetToFloor: (item: DraftItem, unitPrice: number) => void;
  /**
   * The list branch's PER-LINE price gate for `lastAdded`, threaded verbatim
   * (`canEditPriceFor(lastAddedLine.productId)`): a price override from the
   * picker is reachable exactly when that line's price chip is — never for a
   * DRIVER, never outside the order's edit window, never on a SPECIAL-tier
   * line (RULINGS R2/R9). Defaults to false.
   */
  canEditPrice?: boolean;
  /**
   * B465: the list branch's `isSpecialFor`, threaded verbatim so the picker's
   * own `PriceOverrideModal` requires a reason on a SPECIAL-tier line exactly
   * like the list branch's modal does — defense-in-depth for any path that
   * reaches it, since `canEditPrice` above already excludes SPECIAL lines
   * from the picker's price-edit affordance entirely. Absent in a caller that
   * has no tier context; treated as "not special" (never requires a reason).
   */
  isSpecialTierFor?: (productId: string) => boolean;
  /** A camera session is opening — the parent clears its "last scan-added" line. */
  onScanSessionStart?: () => void;
  /** A camera session ended. Does NOT clear the last-added line (RULINGS R5). */
  onScanSessionEnd?: () => void;
  /**
   * The pull-out drawer: everything added so far, newest-scanned first, from
   * the parent's ONE tray derivation (`draftTrayRows`). The drawer renders
   * money it is handed; it never derives any.
   */
  trayRows: TrayRow[];
  trayFlash: ScanFlash | null;
  /** The footer's own count/total — never a second derivation for the drawer. */
  trayItemCount: number;
  trayTotal: number;
  /** ScanTray hands a TOTAL UNIT count (components/ScanTray.tsx). */
  onTrayChangeQty: (id: string, units: number) => void;
  onTrayIncrement: (id: string) => void;
  onTrayDecrement: (id: string) => void;
  onTrayRemove: (id: string) => void;
}) {
  const [scanOpen, setScanOpen] = useState(initialScanOpen ?? false);
  // The drawer's own open/closed state and the window it must not cover.
  const [trayExpanded, setTrayExpanded] = useState(false);
  const win = useWindowDimensions();
  // Drag the handle to open/close, in the BarcodeFab shape (core RN
  // PanResponder — do NOT wire react-native-gesture-handler for this).
  // `onStartShouldSetPanResponder: false` lets a plain tap reach the Pressable.
  const trayPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 8,
      onPanResponderRelease: (_, g) => setTrayExpanded(g.dy < 0),
    }),
  ).current;
  // Owner ask (2026-09-14): the catalogue loads only when the operator asks —
  // a term, a wedge-scanned code, or a deliberate "Browse catalogue" tap.
  // Latches on for the life of the picker; Cancel is the exit.
  const [browsing, setBrowsing] = useState(false);
  // B263 D3: the just-scanned line open for a price edit, stacked over the
  // scanner. The camera stays mounted but paused (`active={!pickerPriceEditItem}`)
  // — the same "keep it mounted" contract `paused` already uses below.
  const [pickerPriceEditItem, setPickerPriceEditItem] = useState<DraftItem | null>(null);
  // This picker is a scan BURST surface (wedge auto-add + miss sinks below all
  // go through `showToast`), so it owns an `<InlineToast>`: mounting it
  // registers this screen as the iOS toast host (lib/toast-host.ts), which is
  // what keeps a burst from firing one blocking `Alert` per scan on iOS
  // (REG-B151). `show` stays unused — the sinks call `showToast`, which routes
  // here on iOS and to ToastAndroid on Android.
  const { toast: scanToast, dismiss: dismissScanToast } = useInlineToast();
  // Codes handed off to a sheet stacked OVER the paused camera, so choosing or
  // creating costs one tap and scanning resumes — instead of the old dead end
  // that closed the scanner and dumped a toast.
  const [pickCode, setPickCode] = useState<string | null>(null);
  const [createCode, setCreateCode] = useState<string | null>(null);
  // Debounced + paged, replacing the `limit: 0` fetch-all. See
  // lib/use-product-search.ts.
  const {
    search,
    setSearch,
    searchTerm,
    products: pagedProducts,
    isLoading,
    isSearching,
    isPlaceholder,
    idle,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useProductSearch<{ id: string }>({ browsing });
  const products = pagedProducts as unknown as Array<
    PickedProduct & { sku?: string; barcode?: string | null; unitSku?: string | null }
  >;
  // The CURRENT search term, readable from an async scan path. `setSearch("")`
  // only takes effect on the next render, so a submit dispatched in between
  // would still read the stale term and re-scan it; `clearSearch` writes the
  // ref SYNCHRONOUSLY, which is what makes runWedgeSubmit no-op there.
  const searchTermRef = useRef("");
  searchTermRef.current = searchTerm;
  const clearSearch = () => {
    searchTermRef.current = "";
    setSearch("");
  };

  /**
   * Scan handler. With `onPickAndStay` the scanner runs CONTINUOUS (items add
   * while the camera stays up — the in-overlay banner is the confirmation);
   * substitute mode stays single-shot ("return one product").
   *
   * Runs the SHARED ladder (lib/scan-ladder), which is what brings this editor
   * up to the builders: a local fast-path over the rows already loaded, a
   * picker on an ambiguous hit, and create-on-miss. Previously an ambiguous
   * code closed the scanner and seeded the search box, and a miss offered
   * nothing at all.
   */
  // F30: one physical scan, one add. The camera/ladder path and the settled
  // search effect below both resolve the SAME code independently; this claim
  // is what links them (lib/scan-accept-guard.ts) so neither double-adds nor
  // reports a false "No product for X" for a line that is already on the order.
  const scanGuardRef =
    useRef(createScanAcceptGuard<PickedProduct & { unitsPerBox?: number | null }>());
  const onScanned = makeScanHandler<PickedProduct & { unitsPerBox?: number | null }>({
    products: () => products,
    acceptGuard: scanGuardRef.current,
    accept: (product, kind) => {
      if (onPickAndStay) {
        onPickAndStay(product, kind);
        // The code that produced this add is spent: drop it so the settled
        // effect can't re-fire on it and the next scan starts from an empty
        // box. Gated on `looksLikeScanCode` so a typed product NAME (and the
        // filtered list the operator is reading) survives — the same rule
        // createWedgeSubmitHandler applies at wedge-submit.ts:77.
        if (looksLikeScanCode(searchTermRef.current)) clearSearch();
        const loose = kind === "piece" && Number(product.unitsPerBox ?? 0) > 1 ? "1 loose · " : "";
        return { feedback: { kind: "added", text: `Added ${loose}${product.name}` } };
      }
      // Substitute mode: exactly one pick, so the scanner closes behind it.
      setScanOpen(false);
      onPick(product, kind);
      return { close: true };
    },
    // Forward the ladder's abort signal — without it a lookup that blows the
    // scan deadline keeps running and still adds the line (F30 / R2).
    resolve: (c, signal) =>
      resolveProductByCode<PickedProduct & { unitsPerBox?: number | null }>(c, signal),
    onAmbiguous: setPickCode,
    onCreate: canCreateProducts ? setCreateCode : undefined,
  });

  // Wedge-scanner path on the picker's search box — mirrors the builders (see
  // NewOrderScreen): Enter-as-scan + settled exact-match auto-add, digit codes
  // only, single exact match only.
  // Wedge-submit: the search field is cleared SYNCHRONOUSLY on every SCAN
  // submit (never on a typed name) — mirrors NewOrderScreen (see its comment)
  // — and a burst arriving mid-resolve
  // is buffered, never dropped, never concatenated (REG-B193). The handler's
  // busy/queue state has to survive re-renders, so it's built ONCE via a ref; a
  // "latest deps" ref keeps it pointed at the current onScanned/searchTerm
  // closures instead of the ones captured on the render that built it.
  const wedgeDepsRef = useRef<{ scan: (code: string) => Promise<void>; clearSearch: () => void }>({
    scan: async () => undefined,
    clearSearch: () => undefined,
  });
  wedgeDepsRef.current = {
    scan: (code) =>
      runWedgeSubmit({
        term: code,
        scan: onScanned,
        clearSearch,
        showInline: showToast,
      }),
    clearSearch,
  };
  const wedgeSubmitRef = useRef(
    createWedgeSubmitHandler({
      scan: (code) => wedgeDepsRef.current.scan(code),
      clearSearch: () => wedgeDepsRef.current.clearSearch(),
    }),
  );
  const handleSearchSubmit = () => {
    if (!onPickAndStay) return Promise.resolve();
    // The REF, never the render-scope term: a burst's second Enter arrives
    // before the clear has re-rendered, and the stale term would be re-scanned.
    return wedgeSubmitRef.current(searchTermRef.current);
  };

  // Settled exact-match auto-add (no-terminator scanners): a per-scan ATTEMPT
  // — not a time window — decides whether a settle may fire (REG-B201); see
  // NewOrderScreen's comment for why a window can't tell "already added" from
  // "a background refetch re-settled", and why the attempt has to END when the
  // field clears (otherwise a deliberate re-scan of the same item is eaten).
  const autoAddAttemptRef = useRef(createScanAttempt());
  useEffect(() => {
    if (!onPickAndStay) return;
    const code = searchTerm.trim();
    if (!looksLikeScanCode(code)) {
      autoAddAttemptRef.current.end();
      return;
    }
    if (isSearching) return;
    const { match } = findExactScanMatch(code, products);
    if (!match) return;
    if (!autoAddAttemptRef.current.shouldAutoAdd(code)) return;
    const kind = scanUnitKind(code, match);
    // Consume the attempt FIRST (above), then offer: a match parked on an open
    // ladder claim must not re-park on a later settle. `offer` returns false
    // when it was parked — the ladder redeems it if and only if it ends
    // unresolved, so this code adds exactly once (lib/scan-accept-guard.ts).
    if (!scanGuardRef.current.offer(code, match, kind)) return;
    onPickAndStay(match, kind);
    clearSearch();
    const loose = kind === "piece" && Number(match.unitsPerBox ?? 0) > 1 ? "1 loose · " : "";
    showToast(`Added ${loose}${match.name}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, products, isSearching]);

  // Finding B263-H: the strip's own margin classification, using the EXACT
  // same primitives as the list row's `marginClass` (`DraftItemCard`,
  // `computeMarginFraction` -> `classifyMargin` around `:1198-1201`), fed
  // `lastAdded`'s already-rounded `unitPrice` and the parent's `marginFloor`
  // (same `floorForCategory` call the row itself is built from). Never a
  // price-only comparison — two independent derivations of "which state is
  // this line in" is exactly how the strip's label drifted from the row's.
  const lastAddedPieceCost =
    lastAdded?.averageCost != null ? toNumber(lastAdded.averageCost) : null;
  const marginFrac =
    lastAdded && lastAddedPieceCost != null
      ? computeMarginFraction(lastAdded.unitPrice, lastAddedPieceCost, lastAdded.unitsPerBox)
      : null;
  const marginClass = classifyMargin(marginFrac, marginFloor);

  return (
    <>
      <NavBar inlineTitle={title} leading={<NavBackButton label="Cancel" onPress={onClose} />} />
      <SearchBar
        placeholder="Scan or search products…"
        value={search}
        onChangeText={setSearch}
        // A hardware WEDGE scanner types into whatever currently holds focus,
        // so without this the picker opens with nothing focused and the first
        // wedge scan is dropped on the floor. Gated to the add-and-stay
        // surface: substitute mode (no `onPickAndStay`) is a one-pick browse,
        // and a camera-first mount (`initialScanOpen`, the B246 scan FAB) must
        // not pop the keyboard over the viewfinder.
        autoFocus={!!onPickAndStay && !initialScanOpen}
        onSubmitEditing={onPickAndStay ? () => void handleSearchSubmit() : undefined}
        trailing={
          <Pressable
            onPress={() => {
              onScanSessionStart?.();
              setScanOpen(true);
            }}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Scan a barcode"
          >
            <Ionicons name="barcode-outline" size={20} color={ios.brand} />
          </Pressable>
        }
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={200}
        onScroll={({ nativeEvent: e }) => {
          // Page in as the operator nears the bottom. `isPlaceholder` guards
          // against paging a stale query key while the next search lands.
          const nearBottom =
            e.layoutMeasurement.height + e.contentOffset.y >= e.contentSize.height - 400;
          if (!nearBottom || isPlaceholder || !hasNextPage || isFetchingNextPage) return;
          fetchNextPage();
        }}
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : idle ? (
          // Nothing has been asked for yet — so this is NOT "no products
          // match", which would be a lie about a catalogue that was never
          // queried. The Browse tap is the deliberate way into the full list.
          <View style={styles.center}>
            <Text style={styles.empty}>Scan or search to add items.</Text>
            <Pressable
              onPress={() => setBrowsing(true)}
              style={styles.browseBtn}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Browse the full catalogue"
            >
              <Text style={styles.browseBtnText}>Browse catalogue</Text>
            </Pressable>
          </View>
        ) : products.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>{isSearching ? "Searching…" : "No products match."}</Text>
          </View>
        ) : (
          <View
            style={{
              paddingHorizontal: 16,
              gap: 6,
              // Clear the collapsed drawer handle so the last row stays tappable.
              paddingBottom: 24 + PICKER_TRAY_HANDLE_HEIGHT,
            }}
          >
            {products.map((p) => {
              const upb = Number(p.unitsPerBox ?? 0);
              return (
                <Pressable key={p.id} style={styles.pickRow} onPress={() => onPick(p)}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.cardName} numberOfLines={1}>
                      {p.name}
                    </Text>
                    <Text style={styles.cardMeta} numberOfLines={2}>
                      {p.sku ? `SKU ${p.sku} · ` : ""}${toNumber(p.pricePerUnit).toFixed(2)}
                      {upb > 1 ? ` / box of ${upb}` : p.unit ? ` / ${p.unit}` : ""}
                    </Text>
                  </View>
                  <Ionicons name="add-circle" size={22} color={ios.brand} />
                </Pressable>
              );
            })}
          </View>
        )}
        {isFetchingNextPage ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : null}
      </ScrollView>

      {/* Inline full-screen swap, not a Modal — absoluteFill covers the screen. */}
      {scanOpen ? (
        <BarcodeScanner
          onScanned={onScanned}
          onClose={() => {
            setScanOpen(false);
            onScanSessionEnd?.();
          }}
          continuous={!!onPickAndStay}
          // Stop decoding while a hand-off sheet is up, but keep the camera
          // mounted so dismissing it resumes scanning instantly.
          paused={pickCode !== null || createCode !== null}
          // B263 D1/D3: pause the decode loop (camera stays mounted) while
          // the price-edit sheet below is stacked over it.
          active={!pickerPriceEditItem}
        />
      ) : null}

      {/* B263 D3: the last-added line, with an inline price edit that never
          leaves the picker or tears the camera down.

          RULINGS R5: the guard is `lastAdded` ALONE — `scanOpen` is the camera
          -session flag, but `lastScannedId` is set by EVERY add-and-stay path,
          including a hardware wedge typing into the search box and a typed code
          plus Enter, neither of which ever opens the camera. Gating on
          `scanOpen` is exactly what made the price affordance unreachable after
          those adds. `!trayExpanded` only keeps it from being buried under the
          open drawer, which shows the same line and its price anyway. */}
      {lastAdded && !trayExpanded ? (
        <View style={styles.pickerLastAdded} pointerEvents="box-none">
          <View style={styles.pickerLastAddedRow}>
            <Text style={styles.pickerLastAddedText} numberOfLines={1}>
              Added {lastAdded.name} · ${lastAdded.unitPrice.toFixed(2)}
            </Text>
            {canEditPrice ? (
              <Pressable
                onPress={() => setPickerPriceEditItem(lastAdded)}
                style={styles.pickerLastAddedBtn}
                hitSlop={8}
                accessibilityRole="button"
              >
                <Text style={styles.pickerLastAddedBtnText}>Edit price</Text>
              </Pressable>
            ) : null}
          </View>
          {/* Review round: a below-floor price is flagged on THIS surface too
              — same guard as the line row. No ack control here: acknowledging
              stays a line-list tap, so `floorAcked` keeps exactly one writer.
              Finding B263-H: the label ALSO reads `marginClass` (same
              `classifyMargin` call the row uses) so "Below cost" vs "Below
              floor" can't disagree with the row for the same line.
              B280: this gate used to be `needsMarginAck` — a SEPARATE,
              cent-rounded price comparison against `lastAddedFloor`
              (`priceForMarginFloor`'s rounded output) — while the row's own
              gate (`below`, DraftItemCard) and this same strip's label above
              both classify by the EXACT fraction (`classifyMargin`). At the
              half-cent boundary the two bases disagree, so the strip could
              flag/not-flag a line the row disagreed with. Gate on
              `marginClass` (the exact-fraction classification already
              computed above for the label) instead — one basis, both
              surfaces, never disagree. */}
          {canEditPrice &&
          lastAddedFloor != null &&
          !lastAddedAcked &&
          (marginClass === "belowCost" || marginClass === "belowFloor") ? (
            <View style={styles.pickerLastAddedRow}>
              <Text style={styles.pickerLastAddedBelow}>
                {marginClass === "belowCost"
                  ? `Below cost (${Math.round(marginFrac! * 100)}%)`
                  : `Below floor · ${Math.round(marginFrac! * 100)}% margin`}
              </Text>
              <Pressable
                onPress={() => onSetToFloor(lastAdded, lastAddedFloor)}
                style={styles.pickerLastAddedBtn}
                hitSlop={8}
                accessibilityRole="button"
              >
                <Text style={styles.pickerLastAddedBtnText}>
                  Set to floor ${lastAddedFloor.toFixed(2)}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}

      {canEditPrice && pickerPriceEditItem ? (
        <PriceOverrideModal
          item={pickerPriceEditItem}
          isSpecial={isSpecialTierFor ? isSpecialTierFor(pickerPriceEditItem.productId) : false}
          onSave={(price, reason) => {
            // Same money path as the list branch (B263 D2): round + recompute
            // through the shared helper, never write the raw typed price.
            const updated = applyPriceOverride(pickerPriceEditItem, {
              unitPrice: price,
              reason: reason || undefined,
            });
            onEditPrice(pickerPriceEditItem, updated.unitPrice, updated.overrideReason);
            setPickerPriceEditItem(null);
          }}
          onCancel={() => setPickerPriceEditItem(null)}
        />
      ) : null}

      {/* After the camera so scan feedback layers OVER it, never behind. */}
      <InlineToast toast={scanToast} onDismiss={dismissScanToast} bottom={48} />

      {/* Ambiguous scan → choose from the matches, over the paused camera. */}
      <ProductPickerSheet
        visible={pickCode !== null}
        title="Which product?"
        activeOnly
        initialSearch={pickCode ?? undefined}
        onClose={() => setPickCode(null)}
        onSelect={(prod) => {
          setPickCode(null);
          const picked = prod as unknown as PickedProduct & { unitsPerBox?: number | null };
          if (onPickAndStay) onPickAndStay(picked, "case");
          else {
            setScanOpen(false);
            onPick(picked, "case");
          }
        }}
      />

      {/* Miss → create it inline and drop it straight on the order. */}
      <InlineCreateProductSheet
        visible={createCode !== null}
        initialCode={createCode ?? undefined}
        onClose={() => setCreateCode(null)}
        onCreated={(prod) => {
          setCreateCode(null);
          const picked = prod as unknown as PickedProduct & { unitsPerBox?: number | null };
          if (onPickAndStay) onPickAndStay(picked, "case");
          else {
            setScanOpen(false);
            onPick(picked, "case");
          }
        }}
      />

      {/* The pull-out drawer of everything added. LAST child of the fragment,
          so it paints over the camera (which is a plain absoluteFill overlay)
          and under the two sheets above (which portal through <Modal/>). Its
          expanded height is derived from BarcodeScanner's own viewfinder
          geometry, so it can never cover the window the operator scans into. */}
      <View
        style={[
          styles.pickerTray,
          { height: trayExpanded ? pickerTrayExpandedHeight(win) : PICKER_TRAY_HANDLE_HEIGHT },
        ]}
      >
        <Pressable
          style={styles.pickerTrayHandle}
          onPress={() => setTrayExpanded((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={trayExpanded ? "Hide added items" : "Show added items"}
          {...trayPan.panHandlers}
        >
          <View style={styles.pickerTrayGrabber} />
          <Text style={styles.pickerTraySummary} numberOfLines={1}>
            {trayItemCount} item{trayItemCount === 1 ? "" : "s"} · ${trayTotal.toFixed(2)}
          </Text>
          <Ionicons
            name={trayExpanded ? "chevron-down" : "chevron-up"}
            size={18}
            color={ios.label2}
          />
        </Pressable>
        {trayExpanded ? (
          <ScanTray
            rows={trayRows}
            flash={trayFlash}
            onChangeQty={onTrayChangeQty}
            onIncrement={onTrayIncrement}
            onDecrement={onTrayDecrement}
            onRemove={onTrayRemove}
            ListEmptyComponent={
              <Text style={styles.empty}>Nothing added yet — scan or tap a product.</Text>
            }
          />
        ) : null}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },

  // ── Card ───────────────────────────────────────────────────────────────────
  card: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
    gap: 12,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  cardName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  cardMetaRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 },
  cardMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
  priceTap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  priceStrike: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    textDecorationLine: "line-through",
  },
  cardTotal: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },

  // ── Margin hint (P10-POS-1) ───────────────────────────────────────────────
  marginHint: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  freeLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
    marginTop: 2,
  },
  floorFixBtn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.system.red,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  floorFixBtnText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.redInk,
  },
  sellAnywayText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    textDecorationLine: "underline",
  },

  // ── Stepper row ───────────────────────────────────────────────────────────
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  stepperLabel: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label,
  },
  stepperHint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    marginTop: 1,
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ios.fill3,
    borderRadius: 10,
    padding: 3,
  },
  stepBtn: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  stepText: { color: ios.brand, fontSize: 18 },
  qtyInput: {
    // Definite width, not minWidth — see lib/row-layout.ts. This is a
    // hand-rolled copy of QtyStepper; it needs the same bound.
    width: QTY_INPUT_WIDTH.edit,
    flexShrink: 0,
    paddingHorizontal: 4,
    textAlign: "center",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    paddingVertical: 2,
  },

  // ── Card actions ──────────────────────────────────────────────────────────
  cardActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  actionChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: ios.brandWash,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  actionChipActive: {
    backgroundColor: ios.system.orangeWash,
  },
  actionChipDisabled: { opacity: 0.5 },
  actionChipText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
  },
  deleteBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.system.redWash,
    borderRadius: 8,
  },

  // ── Per-line note (R5.2/R5.3, mirrors NewOrderScreen's cartNote*) ────────
  cartNoteAdd: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
  },
  cartNoteAddText: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.brand },
  cartNoteInput: {
    backgroundColor: ios.fill3,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    marginBottom: 6,
  },

  // ── Add product CTA ───────────────────────────────────────────────────────
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 4,
  },
  addBtnDisabled: { opacity: 0.5 },
  addBtnText: { color: ios.brand, fontSize: 15, fontFamily: "Inter_600SemiBold" },
  addUnlistedBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    paddingVertical: 14,
  },

  // ── Unlisted draft card ──────────────────────────────────────────────────
  unlistedTagRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  customTag: {
    backgroundColor: ios.system.orangeWash,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  customTagText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.orangeInk,
    letterSpacing: 0.2,
  },
  unlistedNameInput: {
    backgroundColor: ios.fill3,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  unlistedPriceRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 8 },
  unlistedPriceInput: {
    minWidth: 70,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.brand,
    borderRadius: 8,
    textAlign: "right",
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
    fontVariant: ["tabular-nums"],
  },

  // ── Product picker rows ───────────────────────────────────────────────────
  pickRow: {
    backgroundColor: ios.bgElev,
    borderRadius: 10,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  // ── Picker idle state (lazy catalogue) ────────────────────────────────────
  browseBtn: {
    marginTop: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.brand,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  browseBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },

  // ── Picker pull-out drawer ────────────────────────────────────────────────
  pickerTray: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: ios.bgElev,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    overflow: "hidden",
  },
  pickerTrayHandle: {
    height: PICKER_TRAY_HANDLE_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
  },
  pickerTrayGrabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: ios.fill3,
  },
  pickerTraySummary: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },

  // ── Restore banner (staged-edit autosave) ─────────────────────────────────
  restoreBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: ios.bgElev,
  },
  restoreText: { flex: 1, fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  restoreAction: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.brand },

  // ── Picker "last added" strip (B263 D3) ─────────────────────────────────────
  pickerLastAdded: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: 96,
    gap: 8,
    backgroundColor: "rgba(0,0,0,0.72)",
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  pickerLastAddedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  pickerLastAddedBelow: {
    flex: 1,
    color: ios.system.red,
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  pickerLastAddedText: {
    flex: 1,
    color: "#fff",
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  pickerLastAddedBtn: {
    minHeight: 32,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
  pickerLastAddedBtnText: {
    color: "#fff",
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },

  // ── Footer ────────────────────────────────────────────────────────────────
  footer: {
    padding: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: ios.bgElev,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  footerEyebrow: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.4,
  },
  footerTotal: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  saveBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },

  // ── Price override modal ──────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 20,
    padding: 20,
    width: "100%",
    maxWidth: 380,
  },
  modalTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
    marginBottom: 2,
  },
  modalSub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginBottom: 8,
  },
  modalLabel: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginBottom: 14,
  },
  modalFieldLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    marginBottom: 6,
  },
  modalInput: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    marginBottom: 12,
  },
  // B465: a SPECIAL-tier override's reason field reads as required, not
  // optional — a thin red ring, mirroring the web reference's danger styling.
  modalInputError: {
    borderWidth: 1,
    borderColor: ios.system.red,
  },
  modalBtns: { flexDirection: "row", gap: 10 },
  modalBtnGhost: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: ios.fill3,
  },
  modalBtnGhostText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  modalBtnFill: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: ios.brand,
  },
  modalBtnDisabled: { opacity: 0.4 },
  modalBtnFillText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },

  // ── Apply credit (mirrors NewOrderScreen) ─────────────────────────────────
  optionsWrap: { marginHorizontal: 16, marginTop: 10 },
  optionsHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
  optionsTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  optionsSummary: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  optionsBody: {
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 12,
    gap: 12,
    marginBottom: 4,
  },
  optionRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  optionLabel: { flex: 1, fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  newCreditText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: ios.brand },
});

// Default export = the operator route (reads the [id] param). The named export
// above is reused by the driver route (R1e).
export default EditOrderItemsScreen;
