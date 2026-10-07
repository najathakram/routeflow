// #2340 prefactor: moved verbatim out of app/(operator)/(tabs)/orders/[id]/edit-items.tsx
// (size ratchet, plan #2328 R1). Behaviour-neutral — no logic changed in the move.
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, SearchBar } from "@routeflow/ui/mobile/ios";
import { useProductSearch } from "../../lib/use-product-search";
import { showToast } from "../../lib/toast";
import { classifyMargin, computeMarginFraction, type SellLevel } from "@routeflow/pricing";
import { resolveScanSellLevel } from "@routeflow/scanning";
import { marginFloorPrice } from "../../lib/margin-floor-price";
import { findExactScanMatch, levelsForScan, looksLikeScanCode } from "../../lib/wedge-scan";
import { floorForCategory } from "../../lib/api/margin";
import {
  draftTrayRows,
  pickerTrayExpandedHeight,
  PICKER_TRAY_HANDLE_HEIGHT,
  type DraftItem,
} from "../../lib/edit-items-draft";
import type { ScanFlash, TrayRow } from "../../lib/scan-tray";
import { ScanTray } from "../../components/ScanTray";
import { createScanAcceptGuard } from "../../lib/scan-accept-guard";
import { resolveProductByCode } from "../../lib/barcode-resolve";
import { applyPriceOverride } from "../../lib/price-override";
import { pickRowPrice } from "../../lib/picker-price";
import { BarcodeScanner } from "../../components/BarcodeScanner";
import { BarcodeFab } from "../../components/BarcodeFab";
import { ProductPickerSheet } from "../../components/ProductPickerSheet";
import { InlineCreateProductSheet } from "../../components/InlineCreateProductSheet";
import { InlineToast, useInlineToast } from "../../components/InlineToast";
import { makeScanHandler, runWedgeSubmit } from "../../lib/scan-ladder";
import { createScanAttempt, createWedgeSubmitHandler } from "../../lib/wedge-submit";
import { toNumber } from "../../lib/cart-line-state";
import { styles } from "./styles";
import { DraftItemCard } from "./DraftItemCard";
import { PriceOverrideModal } from "./PriceOverrideModal";

// ─── Product picker ──────────────────────────────────────────────────────────

export interface PickedProduct {
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

export function ProductPicker({
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
  priceFor,
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
  onPick: (p: PickedProduct, level?: SellLevel) => void;
  /**
   * Add WITHOUT closing — scans and wedge input use this so N items go in
   * with zero taps (closes the long-standing divergence from web's edit
   * screen, which re-focuses its scan input after every add). Absent in
   * substitute mode, where the contract is exactly one pick.
   */
  onPickAndStay?: (p: PickedProduct, level: SellLevel) => void;
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
  /**
   * B1007: the pricing function the CALLER bills a picked line with (the order editor's tier pricing), so a row shows the
   * price the line will bill, not the product's list price. Absent = the list price, as before. Display only.
   */
  priceFor?: (p: PickedProduct) => number;
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
    accept: (product, level) => {
      if (onPickAndStay) {
        onPickAndStay(product, level);
        // The code that produced this add is spent: drop it so the settled
        // effect can't re-fire on it and the next scan starts from an empty
        // box. Gated on `looksLikeScanCode` so a typed product NAME (and the
        // filtered list the operator is reading) survives — the same rule
        // createWedgeSubmitHandler applies at wedge-submit.ts:77.
        if (looksLikeScanCode(searchTermRef.current)) clearSearch();
        const loose = level === "UNIT" && Number(product.unitsPerBox ?? 0) > 1 ? "1 pc · " : "";
        return { feedback: { kind: "added", text: `Added ${loose}${product.name}` } };
      }
      // Substitute mode: exactly one pick, so the scanner closes behind it.
      setScanOpen(false);
      onPick(product, level);
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
    const level = resolveScanSellLevel(match, levelsForScan(code, match));
    // Consume the attempt FIRST (above), then offer: a match parked on an open
    // ladder claim must not re-park on a later settle. `offer` returns false
    // when it was parked — the ladder redeems it if and only if it ends
    // unresolved, so this code adds exactly once (lib/scan-accept-guard.ts).
    if (!scanGuardRef.current.offer(code, match, level)) return;
    onPickAndStay(match, level);
    clearSearch();
    const loose = level === "UNIT" && Number(match.unitsPerBox ?? 0) > 1 ? "1 pc · " : "";
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
                      {p.sku ? `SKU ${p.sku} · ` : ""}${pickRowPrice(p, priceFor).toFixed(2)}
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
          if (onPickAndStay) onPickAndStay(picked, "BOX");
          else {
            setScanOpen(false);
            onPick(picked, "BOX");
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
          if (onPickAndStay) onPickAndStay(picked, "BOX");
          else {
            setScanOpen(false);
            onPick(picked, "BOX");
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
