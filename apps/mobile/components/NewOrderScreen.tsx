import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FilterChipRow, NavBackButton, NavBar, SearchBar } from "@routeflow/ui/mobile/ios";
import { unitPriceBase, type UnitOption } from "../lib/unit-options";
import {
  rememberedPricePrefill,
  toNumber,
  type LineState,
  type Product,
} from "../lib/cart-line-state";
import {
  computeOrderTotal,
  lineUnitFor,
  priceEditorPrefill,
  type UnlistedTotalLine,
} from "../lib/cart-order-total";
import { decideTrayPrice } from "../lib/staff-price-override";
import { useProductCategories } from "../lib/api/products";
import { useProductSearch } from "../lib/use-product-search";
import { mergeProductIndex } from "../lib/paged-rows";
import { useCustomer, useCustomerPrices } from "../lib/api/customers";
import {
  useCreateOrderAsDriver,
  useActiveOrderForCustomer,
  useCustomerPriceHistory,
  type CreateOrderItemInput,
} from "../lib/api/orders";
import { useCreditNotes, type CreditNote } from "../lib/api/credit-notes";
import { isCreditOpenForApply } from "../lib/credit-notes-logic";
import { showToast } from "../lib/toast";
import {
  applyUnitOption,
  isStaffRole,
  mergeResolvedDefaults,
  refusesLineEdit,
} from "../lib/default-unit-line";
import {
  anyLineLoading,
  applyAddToItems,
  editItemLine,
  refusedScanOutcome,
  reserveAdd,
  settleBeforeConfirm,
  UNITS_BLOCKED_MESSAGE,
} from "../lib/pending-unit-adapter";
import { useDefaultUnitResolver } from "../hooks/useDefaultUnitResolver";
import { classifyMutationError } from "../lib/offline-errors";
import { resolveProductByCode } from "../lib/barcode-resolve";
import { resolveScanSellLevel } from "@routeflow/scanning";
import type { SellLevel } from "@routeflow/pricing";
import { findExactScanMatch, levelsForScan, looksLikeScanCode } from "../lib/wedge-scan";
import {
  makeScanHandler,
  runWedgeSubmit,
  scanAcceptOpts,
  type ScanLadderDeps,
} from "../lib/scan-ladder";
import { createScanAttempt, createWedgeSubmitHandler } from "../lib/wedge-submit";
import { createScanAcceptGuard } from "../lib/scan-accept-guard";
import { needsUnitLabelConfirm } from "../lib/scan-unit-confirm";
// Compose "<Parent> - <Variant>" so scanned variants don't show as "Strawberry" alone.
import { displayProductName as displayName } from "../lib/product-display";
import { effectiveQty, getTierPrice, isSpecialTier, roundMoney } from "@routeflow/pricing";
import { useMarginConfig, floorForCategory } from "../lib/api/margin";
import { useTrackedCategories } from "../lib/api/tracked-categories";
import {
  groupLinesForInvoiceSplit,
  type InvoiceSplitCategory,
  type InvoiceSplitLineInput,
  type InvoiceSplitPreview,
} from "../lib/invoice-split";
import { InlineCreateProductSheet } from "./InlineCreateProductSheet";
import { ProductPickerSheet } from "./ProductPickerSheet";
import { BoxedQtyBand } from "./BoxedQtyBand";
import type { CreatedProduct } from "../lib/api/products";
import { useAuthStore } from "../lib/auth-store";
// chooseAction + alertInfo render the same dialogs cross-platform — RN's
// Alert.alert silently no-ops 3-button alerts on Expo Web (the user's
// "Confirm button frozen" report), so use these everywhere instead.
import { alertInfo, chooseAction, confirm } from "../lib/confirm";
import { InlineToast, useInlineToast } from "./InlineToast";
import { ProductRow } from "./ProductRow";
import { ScanOrderSheet } from "./ScanOrderSheet";
import {
  isUnitLine,
  setLineBoxes,
  setLinePieces,
  setLineQty,
  setLineUnits,
  stepLineQty,
} from "../lib/sale-line";
import { LicenseGuardModal } from "./LicenseGuardModal";
import { BlockedLinesModal } from "./BlockedLinesModal";
import { parseSellingRestricted } from "../lib/selling-restricted";
import type { BlockedLine } from "@routeflow/types";
import { parseRegulatedAuthError, type BlockedCategory } from "../lib/api/authorizations";
import { bumpScanOrder, nextFlash, trayRowsFrom, type ScanFlash } from "../lib/scan-tray";
import {
  NO_PENDING_SCROLL,
  requestScroll,
  stepPendingScroll,
  type PendingScrollState,
} from "../lib/pending-scroll";
import { isCatalogHeader, visibleCatalogRows, type CatalogRow } from "../lib/visible-cart";
import { unlistedAffordancePlacement } from "../lib/unlisted-affordance";
import {
  orderSubmitGate,
  resolveResumeLinePricing,
  resolveResumeLineBoxes,
  decideResumeHydrationStart,
} from "../lib/order-draft-logic";
import { hydrateParkedLine } from "../lib/resume-draft-hydration";
import { getOrderSubmitKey, resetOrderSubmitKey } from "../lib/order-submit-key";
// Parked drafts (PR-3): NewOrderScreen resolves ?resumeDraft= and hydrates
// only the customer; ProductPickView (it owns all other parkable state) binds
// the autosave hook and drives create/update/delete of the SAME draft.
import { useDraft, useCreateDraft, useUpdateDraft, useDeleteDraft } from "../lib/api/drafts";
import {
  toOrderDraftPayload,
  fromOrderDraftPayload,
  draftParkable,
  type OrderDraftPayload,
  type DraftBuilderState,
  type DraftCatalogLine,
} from "../lib/drafts-payload";
import { useDraftAutosave, type DraftRowMeta } from "../lib/use-draft-autosave";
import { useStopCartStore } from "../store/stopCartStore";
import { CartModal } from "./new-order/CartModal";
import { CreateCreditNoteSheet } from "./new-order/CreateCreditNoteSheet";
import { CustomerPickerView } from "./new-order/CustomerPickerView";
import { LinePriceModal } from "./new-order/LinePriceModal";
import { useScanPriceEdit } from "../lib/use-scan-price-edit";
import { UnlistedItemModal } from "./new-order/UnlistedItemModal";
import { styles } from "./new-order/styles";
import type { UnlistedLine } from "./new-order/types";
import { creditsPendingFromError, creditsPendingFromOrder } from "../lib/order-credits-pending";

export interface NewOrderScreenProps {
  /** When present, customer is locked (e.g. invoked from a specific stop). */
  customerId?: string;
  customerName?: string;
  /** When present, the order is linked to this run/stop on the backend. */
  runId?: string;
  stopId?: string;
  /** Label shown on the back button. */
  backLabel?: string;
  /**
   * Where to land after a successful save. The default `router.back()`
   * leaves the operator on whatever they came from (e.g. /home), but the
   * user wanted "after creating an order it should go back to all orders
   * and give the option to navigate as you need" — operator routes pass
   * a custom callback that lands on /orders explicitly. Driver flows keep
   * the default so they return to the stop.
   */
  onSaved?: (orderNumber: string) => void;
  /**
   * What to do when the back button is tapped. The default tries
   * `router.back()` and falls back to `router.replace("/home")` if the
   * back stack is empty (which is the case when the user opened this
   * URL directly — `router.back()` was a silent no-op then, the user's
   * "back is not working" report).
   */
  onBack?: () => void;
  /**
   * Resume a parked draft (DraftStrip's tap target, `?resumeDraft=<id>` on
   * the operator route). Loaded here so the customer can be seeded before
   * ProductPickView mounts; a 404 (deleted on another device) falls through
   * to a normal empty builder. Never set from the driver/stop flow.
   */
  resumeDraftId?: string;
}

function newLocalId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const productKey = (p: CatalogRow<Product>) => (isCatalogHeader(p) ? `hdr-${p.__header}` : p.id);

function RowSpacer() {
  return <View style={styles.rowSpacer} />;
}

/** Separator label between the on-this-order section and the catalogue. */
function CatalogSectionLabel({ label }: { label: string }) {
  return (
    <View style={sectionStyles.wrap}>
      <Text style={sectionStyles.text}>{label.toUpperCase()}</Text>
      <View style={sectionStyles.rule} />
    </View>
  );
}

const sectionStyles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 6,
    paddingBottom: 2,
  },
  text: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.6,
  },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: ios.separator },
});

export function NewOrderScreen({
  customerId: initialCustomerId,
  customerName: initialCustomerName,
  runId,
  stopId,
  backLabel,
  onSaved,
  onBack,
  resumeDraftId: urlResumeDraftId,
}: NewOrderScreenProps) {
  const router = useRouter();
  const [pickedCustomerId, setPickedCustomerId] = useState<string | null>(
    initialCustomerId ?? null,
  );
  const [pickedCustomerName, setPickedCustomerName] = useState<string | null>(
    initialCustomerName ?? null,
  );
  const customerLocked = !!initialCustomerId;
  // The draft this screen is bound to. Seeded from the URL on open; kept in
  // sync afterwards via onDraftBound so a later onChangeCustomer round trip
  // (ProductPickView unmounts/remounts) resumes the SAME server draft rather
  // than creating a second one.
  const [boundDraftId, setBoundDraftId] = useState<string | null>(urlResumeDraftId ?? null);
  const { data: loadedDraft, isFetching: draftLoading, error: draftError } = useDraft(boundDraftId);
  // Guards so hydration/404-handling each fire once per draft id, not on
  // every refetch (autosave keeps this query warm for the life of the screen).
  const hydratedCustomerRef = useRef<string | null>(null);
  const notFoundRef = useRef<string | null>(null);
  // Whether THIS screen instance was ever asked to resume a draft — gates the
  // full-screen spinner so it only covers the very first load, never a later
  // onChangeCustomer round trip (which must show the customer picker, not a
  // spinner, even while that same bound draft happens to be refetching).
  const resumeAttemptedRef = useRef(!!urlResumeDraftId);
  const resolvedCustomerOnceRef = useRef(!!initialCustomerId);
  useEffect(() => {
    if (pickedCustomerId) resolvedCustomerOnceRef.current = true;
  }, [pickedCustomerId]);

  // Seed the customer from the resumed draft's payload (once per draft id).
  // Strictly a RESUME concern: once this screen has resolved a customer even
  // once, tapping "Change" clears `pickedCustomerId`, and without this gate
  // the effect would immediately re-seed the bound draft's original customer
  // (the picker flashes for a frame and snaps back) — making the customer
  // un-changeable for any order that has already been parked.
  useEffect(() => {
    if (!resumeAttemptedRef.current || resolvedCustomerOnceRef.current) return;
    if (!loadedDraft || pickedCustomerId) return;
    if (hydratedCustomerRef.current === loadedDraft.id) return;
    hydratedCustomerRef.current = loadedDraft.id;
    const payload = (loadedDraft.payload ?? {}) as Partial<OrderDraftPayload>;
    if (payload.customer) {
      setPickedCustomerId(payload.customer.id);
      setPickedCustomerName(payload.customer.businessName ?? null);
    }
  }, [loadedDraft, pickedCustomerId]);

  // A deleted-elsewhere draft 404s — toast once, then fall through to a
  // normal empty builder rather than getting stuck on the spinner.
  useEffect(() => {
    if (!draftError || !boundDraftId) return;
    const status = (draftError as { response?: { status?: number } })?.response?.status;
    if (status !== 404) return;
    if (notFoundRef.current === boundDraftId) return;
    notFoundRef.current = boundDraftId;
    alertInfo("That draft is gone", "It may have already been resumed or discarded elsewhere.");
    setBoundDraftId(null);
  }, [draftError, boundDraftId]);

  // If a customer isn't selected yet, the picker takes over — product list hidden.
  const needsCustomer = !pickedCustomerId;
  // Waiting on the very first resume to resolve: neither the picker nor the
  // builder can render meaningfully yet (we don't know the customer).
  const resolvingResume =
    resumeAttemptedRef.current &&
    !resolvedCustomerOnceRef.current &&
    !pickedCustomerId &&
    draftLoading;

  /**
   * Cross-platform-safe back handler. `router.back()` is a no-op on web when
   * the user opened this URL directly (empty history stack) — the cause of
   * the "back is not working" report. Fall back to a sensible default if the
   * caller didn't supply one.
   */
  const handleBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/(operator)/(tabs)/home" as any);
    }
  };

  if (resolvingResume) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      {needsCustomer ? (
        <CustomerPickerView
          backLabel={backLabel}
          onBack={handleBack}
          onPick={(id, name) => {
            // B215/R3: no key rotation here. Submit keys are held PER CUSTOMER
            // (lib/order-submit-key.ts), matching the server's customer-scoped replay identity, so
            // picking a customer simply reads their own slot — and a switch away and back leaves
            // the first customer's still-live cart holding the key its own retry must send.
            setPickedCustomerId(id);
            setPickedCustomerName(name);
          }}
        />
      ) : (
        <ProductPickView
          customerId={pickedCustomerId!}
          customerName={pickedCustomerName}
          customerLocked={customerLocked}
          runId={runId}
          stopId={stopId}
          backLabel={backLabel}
          onBack={handleBack}
          onChangeCustomer={() => {
            setPickedCustomerId(null);
            setPickedCustomerName(null);
            // boundDraftId deliberately survives — the SAME server draft
            // carries over so the next customer's builder resumes with
            // these lines intact instead of starting a second draft.
          }}
          initialDraft={
            loadedDraft
              ? {
                  id: loadedDraft.id,
                  // `payload` is `Record<string, unknown>` on the wire — same
                  // double cast web's CreateOrderModal uses to read it back.
                  payload: (loadedDraft.payload ?? {}) as unknown as OrderDraftPayload,
                }
              : null
          }
          onDraftBound={setBoundDraftId}
          onSaved={(orderNumber: string) => {
            showToast(`Order ${orderNumber} saved`);
            if (onSaved) onSaved(orderNumber);
            else if (router.canGoBack()) router.back();
            else router.replace("/(operator)/(tabs)/orders" as any);
          }}
        />
      )}
    </SafeAreaView>
  );
}

// ─────────────────────── Customer picker ───────────────────────

function ProductPickView({
  customerId,
  customerName,
  customerLocked,
  runId,
  stopId,
  backLabel,
  onBack,
  onChangeCustomer,
  onSaved,
  initialDraft,
  onDraftBound,
}: {
  customerId: string;
  customerName: string | null;
  customerLocked: boolean;
  runId?: string;
  stopId?: string;
  backLabel?: string;
  onBack: () => void;
  onChangeCustomer: () => void;
  onSaved: (orderNumber: string) => void;
  /** One-shot seed for a resumed draft — read only by lazy useState initializers. */
  initialDraft?: { id: string; payload: OrderDraftPayload } | null;
  /** Fires when this view binds a server draft (created or resumed), and on
   * "Change customer" with the live id so the next mount reuses it. Never
   * fires with `null` just because a fresh mount has no id yet. */
  onDraftBound?: (id: string | null) => void;
}) {
  const router = useRouter();
  const userRole = useAuthStore((s) => s.user?.role);
  // Backdating an order is a books-affecting edit — staff only, never drivers.
  const isStaff = isStaffRole(userRole);
  const canCreateProducts = isStaff;
  // Cost eye: every SELLER role (drivers negotiate at the stop; the operator
  // endpoints already return cost to them). Buyers never reach this screen.
  const canSeeCost = isStaff || userRole === "DRIVER";

  // Parked drafts (PR-3): `initialDraft` is a one-shot prop — read it via
  // `fromOrderDraftPayload` exactly once (a plain ref, not useState, since we
  // need the parsed value available to several OTHER lazy initializers below)
  // so a later re-render (or an onChangeCustomer remount with a stale prop
  // reference) never re-seeds already-edited state.
  const draftSeedRef = useRef<DraftBuilderState | null>(null);
  if (draftSeedRef.current === null && initialDraft) {
    draftSeedRef.current = fromOrderDraftPayload(initialDraft.payload);
  }
  // At-door durability (hunt 2026-09-14): a route/stop order never enables the
  // server autosave engine below (`enabled: !runId && !stopId && …`), so an app
  // kill mid-sale used to lose the whole cart with nothing to resume from. The
  // local snapshot store is that resume point, and it seeds through the SAME
  // one-shot ref as a server draft — which means it also inherits the
  // hydration-safety pass (every parked productId is re-checked against the
  // live catalog before a line renders or is priced). A real server draft
  // always wins; the snapshot is only ever the fallback.
  if (draftSeedRef.current === null && !initialDraft && stopId) {
    const snapshot = useStopCartStore.getState().carts[stopId];
    if (snapshot) draftSeedRef.current = fromOrderDraftPayload(snapshot.payload);
  }
  const draftSeed = draftSeedRef.current;
  // Only a draft parked for THIS customer carries per-customer choices over.
  // "Change customer" remounts this view with the SAME draft (lines survive by
  // design), and those choices must then re-seed from the new customer.
  const draftSeedIsSameCustomer = !!draftSeed && draftSeed.customer?.id === customerId;

  const [category, setCategory] = useState("All");
  /** Scanned code with several substring matches → open a picker over the camera. */
  const [pickCode, setPickCode] = useState<string | null>(null);
  // Catalog lines start EMPTY even when resuming — the hydration-safety pass
  // below (money-critical) populates them only after cross-checking each
  // parked productId against the LIVE catalog, so a stale/removed product or
  // price can never render, let alone autosave back to the server.
  const [items, setItems] = useState<Record<string, LineState>>({});
  const itemsRef = useRef(items); // the latest committed lines, for the pending-line scan/tap decision in addOne
  itemsRef.current = items;
  // Ad-hoc (non-catalog) lines need no live-product check — DraftUnlistedLine
  // is field-for-field the same shape as this screen's UnlistedLine, so the
  // seed drops in directly.
  const [unlisted, setUnlisted] = useState<UnlistedLine[]>(() => draftSeed?.unlisted ?? []);
  const [unlistedModalOpen, setUnlistedModalOpen] = useState(false);
  // Name to prefill the unlisted-item composer with (from an empty search).
  const [unlistedPrefill, setUnlistedPrefill] = useState("");
  // Fetched once when customer is confirmed — price pre-fill is instant during scanning.
  const { data: priceHistory } = useCustomerPriceHistory(customerId);
  // Customer tier pricing (mirrors web CreateOrderModal): the effective tier is
  // the per-product CustomerPrice override, else the customer's default tier.
  // Prices shown/summed/submitted use getTierPrice(product, effectiveTier), not
  // the raw list price — so a tier-N customer sees the price the server bills.
  const { data: customerDetail } = useCustomer(customerId);
  const {
    data: customerPrices,
    isFetched: fetched,
    isError: errored,
    isFetching: fetching,
    error: pricesError,
    refetch: refetchPrices,
  } = useCustomerPrices(customerId);
  const pricesSettled = (fetched || errored) && !fetching;
  // Tenant margin config for the live cost/margin hint in the cart rows.
  const { data: marginConfig } = useMarginConfig();
  // Lines the operator explicitly acked as "sell anyway" below the margin
  // floor (pos-cost-roles-spec §1) — keyed by product id, session-local.
  // tempId === productId for catalog lines, so a parked ack round-trips.
  const [floorAcked, setFloorAcked] = useState<Set<string>>(
    () => new Set(draftSeed?.floorAcked ?? []),
  );
  // REG-4: category lookup for the invoice-split preview. Reuses the shipped
  // P10-REG-A hook — no new API surface. Called unconditionally, matching the
  // rest of this screen's hooks (tenants with no regulated categories just get []).
  const { data: splitTrackedCategories } = useTrackedCategories({ active: true });
  const splitCategoryById = useMemo(() => {
    const m = new Map<string, InvoiceSplitCategory>();
    for (const c of splitTrackedCategories ?? [])
      m.set(c.id, { id: c.id, name: c.name, invoiceTreatment: c.invoiceTreatment });
    return m;
  }, [splitTrackedCategories]);
  const customerTier = customerDetail?.pricingTier ?? 1;
  // Ad-hoc trips (plan §WP11): the customer's default fulfillment mode, which
  // seeds this order's own fulfillPath below (never constrains it).
  const customerFulfillPath = customerDetail?.fulfillPath;
  const cpMap = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const cp of customerPrices ?? []) m.set(cp.productId, cp.pricingTier);
    return m;
  }, [customerPrices]);
  const effectiveTierFor = (id: string) => cpMap.get(id) ?? customerTier ?? 1;
  /** The customer's effective per-selling-unit (box) price for a product. */
  const tierPriceFor = (p: Product) => getTierPrice(p, effectiveTierFor(p.id));
  /** SPECIAL (tier≠1) lines are the customer's permanent price — never overridable. */
  const isSpecialFor = (p: Product) => isSpecialTier(effectiveTierFor(p.id));
  const [scanOpen, setScanOpen] = useState(false);
  /** Tray line (catalog id or unlisted local id) whose price is being edited. */
  const [priceEditId, setPriceEditId] = useState<string | null>(null);
  // Newest-first ids for the scan tray + which row is flashing. Both are scan-UI
  // only: the order payload never reads them.
  const [scanOrder, setScanOrder] = useState<string[]>([]);
  const [scanFlash, setScanFlash] = useState<ScanFlash | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  // Regulated-license guard: the blocked categories from a 409, and which
  // submitOrder(mergeChoice) to replay once the license/override is captured.
  const [licenseBlock, setLicenseBlock] = useState<BlockedCategory[] | null>(null);
  const licenseRetryRef = useRef<"merge" | "separate" | undefined>(undefined);
  // Selling restrictions: the lines the API refused (409 SELLING_RESTRICTED); no override exists.
  const [restrictedBlock, setRestrictedBlock] = useState<BlockedLine[] | null>(null);
  // Order-level options (mirror web CreateOrderModal): notes, urgent flag,
  // requested delivery date (YYYY-MM-DD), and an order-level discount.
  const [orderNotes, setOrderNotes] = useState(() => draftSeed?.orderNotes ?? "");
  const [orderUrgent, setOrderUrgent] = useState(() => draftSeed?.orderUrgent ?? false);
  const [deliveryDate, setDeliveryDate] = useState(() => draftSeed?.deliveryDate ?? "");
  // Business date of the order (YYYY-MM-DD); blank = today. Staff only.
  const [orderDate, setOrderDate] = useState(() => draftSeed?.orderDate ?? "");
  const [discountRaw, setDiscountRaw] = useState(() => draftSeed?.discountRaw ?? "");
  const [shippingFeeRaw, setShippingFeeRaw] = useState(() => draftSeed?.shippingFeeRaw ?? "");
  // Ad-hoc trips (plan §WP11): ROUTE (default) or SHIP (supplier/carrier —
  // excluded from every trip/route dispatch sweep). A draft parked for this
  // customer restores the mode it was parked with; otherwise it seeds from the
  // customer's default below, once their detail loads. Either way the operator
  // can override it per order.
  const [fulfillPath, setFulfillPath] = useState<"ROUTE" | "SHIP">(() =>
    draftSeedIsSameCustomer ? (draftSeed?.fulfillPath ?? "ROUTE") : "ROUTE",
  );
  // Apply-credit selection (mobile v1: toggle only, no amount input — null
  // amount = up to the credit's remaining balance, resolved server-side).
  // A resumed id is re-validated below (once the customer's open credits
  // load) against the SAME isCreditOpenForApply predicate and silently
  // dropped if it's no longer open — never trusted blindly from the payload.
  const [selectedCreditIds, setSelectedCreditIds] = useState<string[]>(
    () => draftSeed?.selectedCreditIds ?? [],
  );
  const { data: openCredits } = useCreditNotes({
    customerId: customerId || undefined,
    status: "ISSUED",
    limit: 100,
  });
  // Inline "New credit note" create sheet + freshly-created credits, merged
  // into the rendered rows (deduped by id) so a just-minted credit shows up
  // — and can be applied — before the ["credit-notes"] refetch lands.
  const [createCreditOpen, setCreateCreditOpen] = useState(false);
  const [justCreatedCredits, setJustCreatedCredits] = useState<CreditNote[]>([]);
  const creditRows = useMemo(() => {
    const rows = new Map<string, CreditNote>();
    // ISSUED alone isn't "open": an expired or fully-consumed note stays
    // ISSUED and would just 400 the whole order create at submit.
    const now = new Date();
    for (const cn of openCredits?.data ?? []) {
      if (isCreditOpenForApply(cn, now)) rows.set(cn.id, cn);
    }
    for (const cn of justCreatedCredits) if (!rows.has(cn.id)) rows.set(cn.id, cn);
    return Array.from(rows.values());
  }, [openCredits, justCreatedCredits]);
  // Reset the selection on a GENUINE customer change (never on the initial
  // mount, which may have just seeded a resumed selection above — this ref
  // starts pinned to the mount's own customerId so the first run is a no-op).
  const mountedCustomerRef = useRef(customerId);
  useEffect(() => {
    if (mountedCustomerRef.current === customerId) return;
    mountedCustomerRef.current = customerId;
    setSelectedCreditIds([]);
    setJustCreatedCredits([]);
  }, [customerId]);
  // Seed fulfillPath from the customer's default exactly once per customer,
  // as soon as their detail loads — `fulfillSeededForRef` marks it done so a
  // later refetch of the SAME customer (e.g. window refocus) never stomps a
  // manual toggle mid-session, and a genuine customer SWITCH re-seeds. Resuming
  // a draft parked for THIS customer starts the ref pinned, so the parked
  // choice survives instead of being overwritten by the customer default;
  // carrying that draft to a DIFFERENT customer (the "Change" flow remounts
  // with the same draft) still re-seeds, matching web's CreateOrderModal.
  const fulfillSeededForRef = useRef<string | undefined>(
    draftSeedIsSameCustomer ? customerId : undefined,
  );
  useEffect(() => {
    if (fulfillSeededForRef.current === customerId) return;
    if (!customerId || customerDetail == null) return; // wait for this customer's detail
    fulfillSeededForRef.current = customerId;
    setFulfillPath(customerFulfillPath === "SHIP" ? "SHIP" : "ROUTE");
  }, [customerId, customerDetail, customerFulfillPath]);
  // Re-validate a resumed credit selection once the customer's open credits
  // have loaded (once per mount — later expiries during the session are left
  // alone so an applied credit doesn't vanish mid-edit).
  const creditsValidatedRef = useRef(false);
  useEffect(() => {
    if (creditsValidatedRef.current) return;
    if (!draftSeed || draftSeed.selectedCreditIds.length === 0) {
      creditsValidatedRef.current = true;
      return;
    }
    if (!openCredits) return; // wait for the customer's credits to load
    creditsValidatedRef.current = true;
    const now = new Date();
    const openIds = new Set(
      (openCredits.data ?? []).filter((cn) => isCreditOpenForApply(cn, now)).map((cn) => cn.id),
    );
    setSelectedCreditIds((ids) => ids.filter((id) => openIds.has(id)));
  }, [openCredits, draftSeed]);
  // Scroll the just-added row into view. The target is kept as an ID and
  // re-resolved against whatever the list renders each pass — a cached row
  // offset goes stale the moment clearing the search swaps the rendered list.
  const listRef = useRef<FlatList<CatalogRow<Product>>>(null);
  const [pendingScroll, setPendingScroll] = useState<PendingScrollState>(NO_PENDING_SCROLL);
  // Scanned/typed code with no product match → prefills the inline create sheet.
  const [createCode, setCreateCode] = useState<string | null>(null);
  const { toast, show: showInline, dismiss: dismissInline } = useInlineToast();
  /**
   * Products discovered via barcode scan that aren't in the locally-cached
   * product list (e.g. beyond the 200-item page, or filtered out by the
   * current search). Without this, scanned items wouldn't contribute to the
   * running total or appear in the cart review (see user feedback: "the
   * actual cost of the order is not updating … while scanning items").
   */
  const [scannedById, setScannedById] = useState<Record<string, Product>>({});

  // Resume hydration safety (money-critical, PR-3): a parked catalog line is
  // never trusted at face value — the product may since have been archived
  // or deleted, or its live price/packaging may have moved. While this is
  // in flight the whole builder stays behind a spinner (see the early return
  // near the bottom) so nothing unvalidated can ever render or autosave.
  const [hydrating, setHydrating] = useState<boolean>(
    () => !!draftSeed && draftSeed.items.length > 0,
  );
  // Bumped by the retry action below to re-run a hydration that failed for a non-404 reason.
  const [hydrateAttempt, setHydrateAttempt] = useState(0);
  // The alert offering that retry is dismissible (backdrop tap on web,
  // `cancelable` on native), and nothing else re-triggers the effect — so the
  // retry ALSO lives in the spinner view itself, never only in the dialog.
  const [hydrateFailed, setHydrateFailed] = useState(false);
  const retryHydrate = useCallback(() => {
    setHydrateFailed(false);
    void refetchPrices(); // SA-165: hydrateAttempt alone never re-fires the prices query
    setHydrateAttempt((n) => n + 1);
  }, [refetchPrices]);
  const hydrationStartedRef = useRef(false);
  const failHydration = useCallback(() => {
    hydrationStartedRef.current = false;
    setHydrateFailed(true);
    chooseAction(
      "Couldn't restore your order",
      "Some items couldn't be loaded. Check your connection and try again.",
      [
        { label: "Go back", style: "cancel", onPress: onBack },
        { label: "Retry", onPress: retryHydrate },
      ],
    );
  }, [onBack, retryHydrate]);
  useEffect(() => {
    if (!hydrating || hydrationStartedRef.current) return;
    const status = (pricesError as { response?: { status?: number } })?.response?.status;
    const gate = decideResumeHydrationStart(!!customerDetail, fetched, errored, fetching, status);
    if (gate !== "start") return gate === "failed" && !hydrateFailed ? failHydration() : undefined;
    hydrationStartedRef.current = true;
    const parkedLines: DraftCatalogLine[] = draftSeed?.items ?? [];
    let cancelled = false;
    (async () => {
      // Archived products are KEPT (row flags itself instead, REG-B195); only a 404 drops a
      // line. B747 (SA-085a) also fetches a unit-sold line's live ladder. See
      // lib/resume-draft-hydration.ts for the fetch/drop/abort rules.
      const results = await Promise.all(parkedLines.map((li) => hydrateParkedLine(li)));
      if (cancelled) return;
      // Money-critical: `hydrating` stays true, so autosave stays disabled until resolved.
      if (results.some((r) => r.failed)) return failHydration();
      const nextItems: Record<string, LineState> = {};
      const nextScanned: Record<string, Product> = {};
      const droppedNames: string[] = [];
      for (const { li, product, units } of results) {
        if (!product) {
          droppedNames.push(li.productName || li.productId);
          continue;
        }
        nextScanned[li.productId] = product;
        // Pack-changed re-split (W/N: never for a unit-labeled line) — order-draft-logic.ts.
        const { boxes, pieces, qty } = resolveResumeLineBoxes(li, Number(product.unitsPerBox ?? 0));
        const line: LineState = { qty };
        if (boxes != null) line.boxes = boxes;
        if (pieces != null) line.pieces = pieces;
        if (li.note) line.note = li.note;
        // B747/B755: re-resolve unit/override pricing off LIVE data, never the parked price.
        // R2: the per-product tier (effectiveTierFor), never the bare header customerTier.
        const pricing = resolveResumeLinePricing(
          li,
          product,
          units,
          effectiveTierFor(li.productId),
        );
        if (pricing.fallbackWarning) {
          // eslint-disable-next-line no-console
          console.warn(pricing.fallbackWarning);
        } else {
          if (pricing.unitLabel !== undefined) line.unitLabel = pricing.unitLabel;
          if (pricing.unitBasePrice !== undefined) line.unitBasePrice = pricing.unitBasePrice;
          // W/N: restore the piece factor CartRow's marginFactorFor needs (else falls back to 1).
          if (pricing.unitFactor !== undefined) line.unitFactor = pricing.unitFactor;
          if (pricing.unitPrice !== undefined) {
            line.unitPrice = pricing.unitPrice;
            line.priceSource = "operator";
            if (pricing.overrideReason) line.overrideReason = pricing.overrideReason;
          }
        }
        nextItems[li.productId] = line;
      }
      setItems(nextItems);
      setScannedById((prev) => ({ ...prev, ...nextScanned }));
      setHydrating(false);
      if (droppedNames.length > 0) {
        alertInfo(
          "Items removed",
          `Removed ${droppedNames.length} item(s) no longer in your catalog: ${droppedNames.join(", ")}`,
        );
      }
    })();
    return () => {
      cancelled = true;
      // SA-136b: a dep-triggered re-run (customerDetail/customerPrices below) must be able to
      // start fresh, or the top guard's hydrationStartedRef strands `hydrating` at true forever.
      hydrationStartedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrating, hydrateAttempt, customerDetail, customerPrices, pricesSettled]);

  /**
   * Debounced, server-filtered, 50-rows-at-a-time. This used to be a single
   * `useProducts({ limit: 0 })` — the fetch-all sentinel, which asks the server
   * for up to 10,000 rows and ships megabytes to a phone before the first row
   * renders ("the whole product catalogue loads"). Category filtering moved
   * server-side with it; see `productSearchParams`.
   *
   * The fetch is now GATED too (owner ask 2026-09-14): page 1 no longer loads
   * at screen mount, only once there is a term or the operator taps "Browse
   * catalogue" — `productSearchEnabled`. The screen already rendered quiet, so
   * nothing on screen changes; what stops is the request.
   */
  // Quiet by default (owner ask 2026-08-17): the builder shows what is ON the
  // order, and the full catalogue is one deliberate tap away. Accepting a scan
  // clears the search box, so without this the list snapped back to hundreds of
  // rows after every item — see visibleCatalogRows. Search still wins over both.
  // Declared HERE, not beside the list it feeds: `useProductSearch` reads it,
  // and a `const` declared below its reader is a TDZ ReferenceError.
  const [browsing, setBrowsing] = useState(false);
  const {
    search,
    setSearch,
    searchTerm,
    products,
    isLoading: productsLoading,
    isSearching,
    isPlaceholder,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useProductSearch<Product>({ category, browsing });

  // Index of everything this screen can price: the current page, plus
  // snapshots of lines added from a page that is no longer loaded.
  const productById = useMemo(
    () => mergeProductIndex<Product>(products, scannedById),
    [products, scannedById],
  );

  /**
   * Add 1 box (boxed product) or 1 piece (non-boxed) to the cart line for
   * `id`. If the product isn't yet known to the screen, the caller passes
   * the resolved Product so we can stash it for the totals/cart UI.
   * `level` is the level the scanned CODE carries (SA-580 R1/R2, from the shared resolver):
   * "UNIT" adds one LOOSE piece instead of a box, rolling over at unitsPerBox. A "+1" tap or a
   * catalog pick passes no level and adds a box, as before.
   */
  const addOne = (
    id: string,
    snap?: Product,
    level: SellLevel = "BOX",
    dflt?: boolean,
    viaRow?: boolean,
    code?: string,
  ): boolean => {
    const p = snap ?? productById.get(id);
    const upb = Number(p?.unitsPerBox ?? 0);
    const prefill = rememberedPricePrefill(
      priceHistory?.[id],
      p ? toNumber(p.pricePerUnit) : 0,
      p ? tierPriceFor(p) : 0,
      isSpecialTier(effectiveTierFor(id)),
    );
    // #2865: the add decision is the pure `applyAddToItems` (lib/pending-unit-adapter): refused while the line is pending -> false.
    const input = { id, level, dflt, viaRow, code, role: userRole, upb, prefill };
    if (!reserveAdd(itemsRef, input)) return false; // moves the ref forward: a same-render second add sees this one (B992)
    setItems((m) => applyAddToItems(m, input));
    // Retain a snapshot for EVERY added line, not just scanned ones.
    //
    // This used to be gated on `productSnapshot`, which is only passed by the
    // scan path — so a product added by TAPPING a catalog row was never
    // retained. Type a search afterwards and productById lost it, dropping the
    // line from the footer total and the cart sheet. That was already a live
    // bug with the fetch-all list; with 50-row pages it would happen to any
    // line added from page 2 onward.
    //
    // productById prefers the live page entry, so this only ever acts as a
    // fallback.
    if (p) {
      setScannedById((m) => (id in m ? m : { ...m, [id]: p }));
    }
    return true;
  };

  const upbNum = (id: string) => Number(productById.get(id)?.unitsPerBox ?? 0);
  const removeOne = (id: string) =>
    setItems((m) =>
      m[id]
        ? editItemLine(m, id, "increment", (prev) =>
            stepLineQty(prev, -1, upbNum(id) > 1, upbNum(id)),
          )
        : m,
    );

  const setBoxes = (id: string, boxes: number) =>
    setItems((m) => editItemLine(m, id, "qty", (prev) => setLineBoxes(prev, boxes, upbNum(id))));

  const setPieces = (id: string, pieces: number) =>
    setItems((m) => editItemLine(m, id, "qty", (prev) => setLinePieces(prev, pieces, upbNum(id))));

  /** Unit mode: the operator types a TOTAL unit count; normalize it back into
   *  cases + loose (7 units of a 6-pack -> 1 case + 1 loose). Price is unchanged
   *  either way because computeLineSubtotal's proration is linear. */
  const setUnits = (id: string, units: number) =>
    setItems((m) => editItemLine(m, id, "unit", (prev) => setLineUnits(prev, units, upbNum(id))));

  const setSellBy = (id: string, sellBy: "case" | "unit") =>
    setItems((m) =>
      m[id] && !refusesLineEdit(m[id], "unit") ? { ...m, [id]: { ...m[id], sellBy } } : m,
    );

  /**
   * units_v1: apply a `UnitPickerRow` choice. `qty` resets to 1 (a fresh unit assignment, never
   * expanded pieces), boxes/pieces are cleared (a unit line is a plain qty*unitPrice line).
   * `unitPrice` is left UNSET (not the option's price) so `effectiveUnitPrice`/`isOverridden`
   * fall back to `unitBasePrice` exactly like a pack line falls back to `catalogPrice` — the
   * option's own resolved price is a lookup, not an operator override, and must not be tagged as
   * one. "" (the pack option) clears both `unitLabel` and `unitBasePrice`, restoring the plain
   * pack behaviour byte for byte.
   */
  const upbOf = (id: string) => productById.get(id)?.unitsPerBox;
  const setUnitLabel = (id: string, option: UnitOption) =>
    setItems((m) => (m[id] ? { ...m, [id]: applyUnitOption(m[id], option, upbOf(id)) } : m));
  // SA-626c: a flagged line holds its default unit from the moment it is added, never only once a sheet mounts.
  const { resolveBeforeSubmit: resolveDefaultUnits, statusFor: unitStatusFor } =
    useDefaultUnitResolver(items, setItems, isStaff, (id) => productById.get(id), effectiveTierFor);
  const anyUnitLoading = anyLineLoading(items, unitStatusFor); // Confirm is disabled only while a line is LOADING (#2865)

  const setQty = (id: string, qty: number) =>
    setItems((m) => editItemLine(m, id, "qty", (prev) => setLineQty(prev, qty))); // clears boxes/pieces (plain qty path)

  const removeLine = (id: string) =>
    setItems((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });

  const setLineNote = (id: string, note: string) =>
    setItems((m) => (m[id] ? { ...m, [id]: { ...m[id], note } } : m));
  const toggleLineNote = (id: string) =>
    setItems((m) => (m[id] ? { ...m, [id]: { ...m[id], noteOpen: !m[id].noteOpen } } : m));

  // Set (or clear) a one-time price override for a line. Empty/invalid clears it
  // so the line falls back to the catalog price.
  const setLinePrice = (id: string, value: number | null, overrideReason?: string) =>
    setItems((m) => {
      const prev = m[id];
      if (!prev) return m;
      if (refusesLineEdit(prev, "price")) return m; // #2865 (SA-632 H1): a typed price would settle a pending line as cases
      if (value == null || value < 0) {
        const { unitPrice: _drop, priceSource: _dropSource, ...rest } = prev;
        delete rest.overrideReason;
        return { ...m, [id]: rest };
      }
      // B755: the ONE place an operator types a price on a catalog line — tagged "operator"
      // so a resume never mistakes it for a history pre-fill (addOne) and re-prices it away.
      // #2696(c): the reason rides with it (required on a special line — decideTrayPrice).
      const next: LineState = { ...prev, unitPrice: value, priceSource: "operator" };
      if (overrideReason) next.overrideReason = overrideReason;
      else delete next.overrideReason;
      return { ...m, [id]: next };
    });

  // ── Unlisted (ad-hoc, non-catalog) line helpers ──────────────────────────
  const addUnlisted = (name: string, unitPrice: number, qty: number) =>
    setUnlisted((u) => [...u, { id: newLocalId(), name: name.trim(), unitPrice, qty }]);
  const updateUnlistedQty = (id: string, qty: number) =>
    setUnlisted((u) =>
      qty <= 0 ? u.filter((x) => x.id !== id) : u.map((x) => (x.id === id ? { ...x, qty } : x)),
    );
  const updateUnlistedPrice = (id: string, value: number | null) =>
    setUnlisted((u) => {
      const price = value == null || value < 0 ? 0 : value;
      return u.map((x) => (x.id === id ? { ...x, unitPrice: price } : x));
    });
  const updateUnlistedNote = (id: string, note: string) =>
    setUnlisted((u) => u.map((x) => (x.id === id ? { ...x, note } : x)));
  const toggleUnlistedNote = (id: string) =>
    setUnlisted((u) => u.map((x) => (x.id === id ? { ...x, noteOpen: !x.noteOpen } : x)));
  const removeUnlisted = (id: string) => setUnlisted((u) => u.filter((x) => x.id !== id));

  /** Newest scanned line to the top of the tray, and flash it. */
  const bumpScanned = (id: string) => {
    setScanOrder((order) => bumpScanOrder(order, id));
    setScanFlash((prev) => nextFlash(prev, id));
  };

  /**
   * Land a resolved product on the order.
   *
   * Both paths flash the row and switch the catalogue behind the scanner into
   * "ON THIS ORDER" mode: in scan mode the tray is the immediate confirmation,
   * but the catalogue is what's left on screen when Done closes the sheet, so
   * it must already be showing what was captured. ScanOrderSheet still owns the
   * haptic and its own scroll-to-top.
   *
   * Note what this deliberately does NOT do: put the scanned code into the
   * search box. `search` doesn't cover Product.id, and /products/barcode/:code
   * resolves codes the text search never matches — so a SUCCESSFUL scan could
   * leave an empty list.
   */
  // Two invariants the scan paths depend on, neither of which plain state can
  // give them:
  //  1. An Enter dispatched from the render BEFORE a clear must read the
  //     CURRENT term, not the one captured in that render's closure —
  //     otherwise it re-submits the code the accept just consumed.
  //     `clearSearch` empties the ref SYNCHRONOUSLY with the field, so such a
  //     submit sees "" and `runWedgeSubmit` no-ops.
  //  2. One input event yields one add: the camera/wedge ladder and the
  //     settled-search effect below both resolve the same physical scan, so
  //     they share a claim (`lib/scan-accept-guard.ts`). Nothing here keys on
  //     a code or a clock — a deliberate re-scan still adds a second unit.
  const searchTermRef = useRef("");
  searchTermRef.current = searchTerm;
  const clearSearch = () => {
    searchTermRef.current = "";
    setSearch("");
  };
  const scanGuardRef = useRef(createScanAcceptGuard<Product>());

  const finishAccept: ScanLadderDeps<Product>["accept"] = (product, level, opts) => {
    if (!addOne(product.id, product, level, opts?.startOnDefault, false, opts?.code))
      return refusedScanOutcome(scanOpen); // a refused scan: not counted, not "Added", ONE message
    bumpScanned(product.id);
    clearSearch();
    const label =
      level === "UNIT" && Number(product.unitsPerBox ?? 0) > 1
        ? `Added 1 loose · ${displayName(product)}`
        : `Added ${displayName(product)}`;
    if (scanOpen) return; // the tray row is the confirmation
    // Only reachable from a non-sheet caller — mirrors web's scrollIntoView({block:"nearest"}).
    setPendingScroll((s) => requestScroll(s, product.id));
    return { feedback: { kind: "added", text: label } };
  };

  // units_v1 (SA-085h LOW): a PIECE-barcode hit on an already unit-sold line would add a
  // whole unit, not one loose piece — confirm rather than silently adding a large jump.
  const acceptScannedProduct: ScanLadderDeps<Product>["accept"] = (product, level, ao) => {
    const label = items[product.id]?.unitLabel;
    if (!needsUnitLabelConfirm(level, product, label)) return finishAccept(product, level, ao);
    const onYes = () => {
      const o = finishAccept(product, level, ao);
      if (o?.feedback?.kind === "added") showInline(o.feedback.text);
    };
    confirm(`Add 1 ${label}?`, `${displayName(product)} is sold by ${label}.`, onYes, {
      confirmText: `Add 1 ${label}`,
    });
  };

  // Continuous-scan handler: the scan sheet stays open between items; only the
  // create-product hand-off (and Done) closes it. The ladder itself lives in
  // lib/scan-ladder so the invoice builder and the order EDITOR run the same
  // one — see that file for why an ambiguous hit opens a picker rather than
  // silently taking matches[0], and why a miss must never close the scanner.
  const handleBarcodeScanned = makeScanHandler<Product>({
    // Every row this screen can price, not just the loaded page: with the
    // catalogue fetch gated on term-or-browse there IS no preloaded page 1, so
    // a plain `products` would drop the local fast path for lines already on
    // the order (the re-scan-for-another-case burst). `scannedById` snapshots
    // keep them resolvable with no request at all.
    products: () => Array.from(productById.values()),
    accept: acceptScannedProduct,
    // Forward the ladder's abort signal — without it a lookup that blows the
    // scan deadline keeps running and still adds the line (F30 / R2).
    resolve: (c, signal) => resolveProductByCode<Product>(c, signal),
    onAmbiguous: setPickCode,
    onCreate: canCreateProducts ? setCreateCode : undefined,
    acceptGuard: scanGuardRef.current,
  });

  /**
   * Wedge-scanner path (owner-reported by a live wholesaler): a hardware
   * scanner types the code into the SEARCH box, which used to dead-end in a
   * suggestion needing a tap + manual clear before the next scan. Two hooks
   * make a wedge scan behave exactly like a camera scan:
   *
   * 1. Enter/submit (scanners that send a terminator) → the full
   *    handleBarcodeScanned ladder. Gated on looksLikeScanCode so pressing
   *    Enter after typing a product NAME never adds anything.
   * 2. Settled exact match (scanners with NO terminator — the screenshot
   *    case): once the server-filtered rows land and exactly one product's
   *    barcode/sku/unitSku equals the typed code, auto-add it.
   *
   * Both end in acceptScannedProduct, which clears the field and keeps the
   * list still — the next scan goes straight in, zero taps.
   */
  // Wedge-submit: the search field is cleared SYNCHRONOUSLY on every SCAN
  // submit — the web CreateOrderModal invariant (CreateOrderModal.tsx:310-316);
  // submitting a typed NAME leaves it alone — and a burst arriving mid-resolve
  // is buffered, never dropped, never concatenated
  // (REG-B193). The handler's internal busy/queue state has to survive
  // re-renders, so it is built ONCE via a ref; a small "latest deps" ref keeps
  // it pointed at the current searchTerm/handleBarcodeScanned/showInline
  // closures instead of the ones captured on the render that built it.
  const wedgeDepsRef = useRef<{ scan: (code: string) => Promise<void>; clearSearch: () => void }>({
    scan: async () => undefined,
    clearSearch: () => undefined,
  });
  wedgeDepsRef.current = {
    scan: (code) =>
      runWedgeSubmit({
        term: code,
        scan: handleBarcodeScanned,
        clearSearch,
        showInline,
      }),
    clearSearch,
  };
  const wedgeSubmitRef = useRef(
    createWedgeSubmitHandler({
      scan: (code) => wedgeDepsRef.current.scan(code),
      clearSearch: () => wedgeDepsRef.current.clearSearch(),
    }),
  );
  const handleSearchSubmit = () => wedgeSubmitRef.current(searchTermRef.current);

  // Settled exact-match auto-add (no-terminator scanners): whether a settle
  // may add is decided by a per-scan ATTEMPT, not a time window (REG-B201) — a
  // window can't tell "this scan already added" from "a background refetch
  // re-settled the same code"; an attempt nonce can, no matter how late the
  // stale settle lands. The attempt ENDS the moment the field goes empty (what
  // acceptScannedProduct does), so re-scanning the SAME item for a second unit
  // starts a fresh attempt and adds again — the old 800ms window allowed that
  // and a per-code nonce would have killed it forever.
  const autoAddAttemptRef = useRef(createScanAttempt());
  useEffect(() => {
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
    // Consume the nonce FIRST (above), then offer: a match parked on an open
    // ladder claim must not re-park on a later settle of the same attempt. A
    // false answer means the ladder owns this label and will redeem the match
    // itself if its own lookup comes back empty.
    if (!scanGuardRef.current.offer(code, match, level)) return;
    const outcome = acceptScannedProduct(match, level, scanAcceptOpts(code, match));
    if (outcome?.feedback?.kind === "added") showInline(outcome.feedback.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, products, isSearching]);

  // Non-null while the inline create sheet is open; holds the scanned/typed code
  // to prefill. On success the new product is dropped straight into the cart.
  const handleInlineCreated = (product: CreatedProduct) => {
    const snapshot: Product = {
      id: product.id,
      name: product.name,
      sku: product.sku ?? null,
      barcode: product.barcode ?? null,
      unit: product.unit,
      pricePerUnit: product.pricePerUnit,
      category: product.category ?? null,
      unitsPerBox: product.unitsPerBox ?? null,
      parentProductId: product.parentProductId ?? null,
      parent: null,
    };
    addOne(product.id, snapshot);
    bumpScanned(product.id);
    setPendingScroll((s) => requestScroll(s, product.id));
    setCreateCode(null);
    showInline(`Added ${displayName(snapshot, products)}`);
  };

  // Chips come from the tenant's distinct categories, not from the loaded rows:
  // derived from a 50-row page they'd list only whatever happened to be on it.
  const { data: tenantCategories } = useProductCategories();
  const categoryChips = useMemo(
    () => [{ label: "All" }, ...(tenantCategories ?? []).map((label) => ({ label }))],
    [tenantCategories],
  );

  const visible = useMemo(
    () =>
      visibleCatalogRows<Product>({
        base: products,
        cartIds: Object.keys(items),
        lookup: (id) => productById.get(id),
        browsing,
        searchTerm,
      }),
    [products, searchTerm, items, productById, browsing],
  );
  const filtered: CatalogRow<Product>[] = visible.rows;

  // Resolve a queued scroll against the ids the list renders THIS pass. A
  // just-scanned product is often absent for a render or two while it refetches.
  useEffect(() => {
    if (!pendingScroll.targetId) return;
    const { state, scrollIndex } = stepPendingScroll(
      pendingScroll,
      // Header rows occupy indices too — map them to their (non-product) keys
      // so a product's scroll index still lands on the product.
      filtered.map((p) => productKey(p)),
    );
    if (scrollIndex == null) return;
    setPendingScroll(state);
    listRef.current?.scrollToIndex({ index: scrollIndex, viewPosition: 0.12, animated: true });
  }, [pendingScroll, filtered]);

  // Total + count — thin wrapper over the pure, unit-tested `computeOrderTotal`
  // (lib/cart-order-total.ts). Computed from items + the unified product map so scanned
  // items that aren't in the local list still contribute. Subtotal uses the shared
  // box/piece-aware formula so the footer agrees with what the server will compute on submit.
  const { total, totalItems } = useMemo(
    () => computeOrderTotal(items, productById, unlisted as UnlistedTotalLine[], effectiveTierFor),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, productById, unlisted, cpMap, customerTier],
  );

  // REG-4: live, DISPLAY-ONLY preview of how this cart will split into invoices.
  // Same iteration/inputs as the total memo above (by design — it can never
  // disagree with what's on screen). NEVER used for money: computeLineSubtotal
  // inside groupLinesForInvoiceSplit produces the same pre-tax per-line amounts
  // the total memo already sums; this just also buckets them by category. The
  // server (createSplitInvoices) is the sole source of truth for the real split.
  const invoiceSplit: InvoiceSplitPreview = useMemo(() => {
    const splitLines: InvoiceSplitLineInput[] = [];
    for (const [id, line] of Object.entries(items)) {
      const p = productById.get(id);
      if (!p) continue;
      const qty = effectiveQty(line, p.unitsPerBox);
      if (qty <= 0) continue;
      splitLines.push({
        trackedCategoryId: p.trackedCategoryId ?? null,
        unitPrice: lineUnitFor(line, p, effectiveTierFor(p.id)),
        qty,
        boxes: line.boxes ?? null,
        pieces: line.pieces ?? null,
        unitsPerBox: p.unitsPerBox ?? null,
      });
    }
    for (const u of unlisted) {
      if (u.qty <= 0) continue;
      splitLines.push({ trackedCategoryId: null, unitPrice: u.unitPrice, qty: u.qty });
    }
    return groupLinesForInvoiceSplit(splitLines, splitCategoryById);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, productById, unlisted, splitCategoryById, cpMap, customerTier]);

  // Newest-first "order so far" for the scan tray. Same inputs as the total
  // memo, so the tray and the footer cannot disagree.
  const trayRows = useMemo(
    () =>
      trayRowsFrom({
        items,
        unlisted,
        scanOrder,
        lookup: (id) => productById.get(id),
        // units_v1 (SA-085i(b)): lib's lineUnitFor directly, never the pack's tier price.
        priceFor: (p) => {
          const full = productById.get(p.id);
          return full ? lineUnitFor(items[p.id], full, effectiveTierFor(p.id)) : 0;
        },
        overridable: (p) => {
          const full = productById.get(p.id);
          return full ? !isSpecialFor(full) : true;
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, unlisted, scanOrder, productById, cpMap, customerTier],
  );

  /**
   * Both the catalog rows and the tray rows are memoized, so their callbacks
   * must keep a stable identity or every row re-renders on each scan. This ref
   * always holds the current render's closures behind that stable identity.
   */
  const rowActions = {
    add: (id: string) => addOne(id, undefined, "BOX", true, true),
    remove: removeOne,
    setQty,
    setBoxes,
    setPieces,
    setUnits,
    removeLine,
    isUnlisted: (id: string) => unlisted.some((u) => u.id === id),
    unlistedQty: (id: string) => unlisted.find((u) => u.id === id)?.qty ?? 0,
    showInline,
    updateUnlistedQty,
    removeUnlisted,
    unitsPerBox: (id: string) => Number(productById.get(id)?.unitsPerBox ?? 0),
    // units_v1 (SA-085f): a unit-sold line's qty is a COUNT — the tray must send it
    // through setQty, never setUnits (which treats the typed number as total PACK pieces).
    isUnitLine: (id: string) => isUnitLine(items[id] ?? {}),
    // Owner ask: after CHOOSING the searched item, the field clears. Only on
    // the row's first Add (not stepper increments — the settled list must not
    // swap mid-repeat-tap); the added row survives the swap back to the
    // catalogue because cart lines are pinned (withCartRows), and the pending
    // scroll brings it into view at its new position.
    pickedFromSearch: (id: string) => {
      if (!searchTerm) return;
      setSearch("");
      setPendingScroll((s) => requestScroll(s, id));
    },
  };
  const actionsRef = useRef(rowActions);
  actionsRef.current = rowActions;

  const onRowAdd = useCallback((id: string) => {
    actionsRef.current.add(id);
    actionsRef.current.pickedFromSearch(id);
  }, []);
  const onRowIncrement = useCallback((id: string) => actionsRef.current.add(id), []);
  const onRowDecrement = useCallback((id: string) => actionsRef.current.remove(id), []);
  const onRowChangeQty = useCallback(
    (id: string, n: number) => actionsRef.current.setQty(id, n),
    [],
  );
  const onRowChangeBoxes = useCallback(
    (id: string, n: number) => actionsRef.current.setBoxes(id, n),
    [],
  );
  const onRowChangePieces = useCallback(
    (id: string, n: number) => actionsRef.current.setPieces(id, n),
    [],
  );
  const openCart = useCallback(() => setCartOpen(true), []);
  const openUnlistedModal = useCallback((prefill: string) => {
    setUnlistedPrefill(prefill);
    setUnlistedModalOpen(true);
  }, []);

  // Tray steppers hand back a TOTAL unit count; a case-packed line has to go
  // through setLineUnits so the cases/loose split is re-derived from it.
  const onTrayChangeQty = useCallback((id: string, qty: number) => {
    const a = actionsRef.current;
    if (a.isUnlisted(id)) a.updateUnlistedQty(id, qty);
    else if (!a.isUnitLine(id) && a.unitsPerBox(id) > 1) a.setUnits(id, qty);
    else a.setQty(id, qty);
  }, []);
  const onTrayIncrement = useCallback((id: string) => {
    const a = actionsRef.current;
    if (a.isUnlisted(id)) a.updateUnlistedQty(id, a.unlistedQty(id) + 1);
    else a.add(id);
  }, []);
  const onTrayDecrement = useCallback((id: string) => {
    const a = actionsRef.current;
    if (a.isUnlisted(id)) a.updateUnlistedQty(id, a.unlistedQty(id) - 1);
    else a.remove(id);
  }, []);
  const onTrayRemove = useCallback((id: string) => {
    const a = actionsRef.current;
    if (a.isUnlisted(id)) a.removeUnlisted(id);
    else a.removeLine(id);
  }, []);
  // Reprice without leaving the camera (B901 sequencing lives in the hook).
  // #2696(c): a SPECIAL (tier) line too — moving off it takes a reason in LinePriceModal.
  const { onTrayEditPrice, handleScanSheetDismiss, closePriceEdit } = useScanPriceEdit({
    scanOpen,
    setScanOpen,
    setPriceEditId,
  });
  // Resolved lazily (two map lookups) rather than memoized: it is null on every
  // render but the handful where the sheet is open.
  const priceEditTarget = ((): {
    id: string;
    name: string;
    unitPrice: number;
    unlisted: boolean;
    /** #2696(c): the one-rule inputs (catalog lines only) — see decideTrayPrice. */
    rule?: { base: number; listPrice: number; isSpecial: boolean; reason?: string };
  } | null => {
    if (!priceEditId) return null;
    const u = unlisted.find((x) => x.id === priceEditId);
    if (u) return { id: u.id, name: u.name, unitPrice: u.unitPrice, unlisted: true };
    const p = productById.get(priceEditId);
    if (!p) return null;
    const line = items[priceEditId];
    return {
      id: priceEditId,
      name: displayName(p, products),
      // SA-085i(b): the override if set, else what's billed today — never the pack's price.
      unitPrice: priceEditorPrefill(line, p, effectiveTierFor(p.id)),
      unlisted: false,
      rule: {
        base: unitPriceBase(line ?? {}, tierPriceFor(p)),
        listPrice: toNumber(p.pricePerUnit),
        isSpecial: isSpecialFor(p),
        reason: line?.overrideReason,
      },
    };
  })();

  // Boxed rows have variable height, so there's no getItemLayout to make
  // scrollToIndex exact — estimate, then retry once the cells have laid out.
  const scrollRetryRef = useRef(false);
  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      listRef.current?.scrollToOffset({
        offset: Math.max(0, info.averageItemLength * info.index),
        animated: true,
      });
      if (scrollRetryRef.current) return;
      scrollRetryRef.current = true;
      requestAnimationFrame(() => {
        scrollRetryRef.current = false;
        listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.12, animated: true });
      });
    },
    [],
  );

  /**
   * An added case-packed row keeps exactly three controls: a case stepper, the
   * resulting split + line total, and a way into the cart sheet, which owns the
   * full per-line editor (price override, sell-by, loose units, note, cost).
   */
  const renderProduct = useCallback(
    ({ item: p }: { item: CatalogRow<Product> }) => {
      if (isCatalogHeader(p)) return <CatalogSectionLabel label={p.label} />;
      const line = items[p.id];
      const qty = line ? effectiveQty(line, p.unitsPerBox) : 0;
      // SA-085i: never the pack's tier price for a unit-sold line ("/Case", not "/each").
      const price = line ? lineUnitFor(line, p, effectiveTierFor(p.id)) : tierPriceFor(p);
      const band =
        line && qty > 0 && Number(p.unitsPerBox ?? 0) > 1 && !line.unitLabel ? (
          <BoxedQtyBand
            line={line}
            unitsPerBox={Number(p.unitsPerBox)}
            unit={p.unit}
            unitPrice={price}
            productName={displayName(p)}
            onChangeBoxes={(n) => onRowChangeBoxes(p.id, n)}
            onChangePieces={(n) => onRowChangePieces(p.id, n)}
            onEdit={openCart}
          />
        ) : null;

      return (
        <ProductRow
          id={p.id}
          name={displayName(p)}
          sku={p.sku}
          unit={p.unit}
          unitsPerBox={p.unitsPerBox}
          price={price}
          listPrice={toNumber(p.pricePerUnit)}
          qty={qty}
          onAdd={onRowAdd}
          onChangeQty={onRowChangeQty}
          onIncrement={onRowIncrement}
          onDecrement={onRowDecrement}
          unitLabel={line?.unitLabel}
        >
          {band}
        </ProductRow>
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      items,
      cpMap,
      customerTier,
      onRowAdd,
      onRowChangeQty,
      onRowIncrement,
      onRowDecrement,
      onRowChangeBoxes,
      onRowChangePieces,
      openCart,
    ],
  );

  // ── Parked drafts (PR-3): serialize every piece of parkable state this view
  // owns into the pure module's DraftBuilderState shape (field names mirror
  // these variables 1:1 by design — see drafts-payload.ts). Every money value
  // flows through computeLineSubtotal elsewhere (never re-derived here); this
  // memo just packages the CURRENT effective price/qty per line.
  const draftCatalogLines = useMemo<DraftCatalogLine[]>(() => {
    const lines: DraftCatalogLine[] = [];
    for (const [productId, line] of Object.entries(items)) {
      const p = productById.get(productId);
      if (!p) continue;
      const qty = effectiveQty(line, p.unitsPerBox);
      if (qty <= 0) continue;
      const special = isSpecialFor(p);
      const tierPrice = tierPriceFor(p);
      const listPrice = toNumber(p.pricePerUnit);
      // B747: a unit-sold line's comparison base is its OWN resolved price, never the pack's
      // tier price — same fix as lineUnitFor/computeOrderTotal (lib/cart-order-total.ts). Before
      // this, a parked unit line was written to the wire as a plain STANDARD/pack line (no
      // unitLabel at all), so this screen's own drafts never actually carried the field the old
      // whole-draft resume refusal keyed on — that refusal only ever fired for a draft parked by
      // a different client.
      const priceBase = unitPriceBase(line, tierPrice);
      // Mobile has no separate "permanent discount" concept — any explicit
      // override the operator set is tagged MANUAL (never DISCOUNTED), which
      // is exactly what the resume-hydration pin rule above checks for.
      // #2696(c): a special line's override parks only WITH its reason (as submit sends it).
      const hasOverride =
        (!special || !!line.overrideReason?.trim()) &&
        line.unitPrice != null &&
        line.unitPrice !== priceBase;
      lines.push({
        productId,
        productName: displayName(p),
        unit: p.unit ?? "each",
        listPrice,
        ...(special ? { specialPrice: tierPrice } : {}),
        ...(hasOverride ? { discountedPrice: line.unitPrice } : {}),
        ...(hasOverride && line.overrideReason ? { overrideReason: line.overrideReason } : {}),
        unitPrice: hasOverride ? line.unitPrice! : priceBase,
        priceType: hasOverride ? "MANUAL" : special ? "SPECIAL" : "STANDARD",
        qty,
        ...(p.unitsPerBox ? { unitsPerBox: Number(p.unitsPerBox) } : {}),
        ...(line.boxes != null ? { boxes: line.boxes } : {}),
        ...(line.pieces != null ? { pieces: line.pieces } : {}),
        ...(line.unitLabel ? { unitLabel: line.unitLabel } : {}),
        ...(hasOverride && line.priceSource ? { priceSource: line.priceSource } : {}),
        ...(p.averageCost != null
          ? { unitCost: toNumber(p.averageCost) }
          : p.standardCost != null
            ? { unitCost: toNumber(p.standardCost) }
            : {}),
        ...(p.category ? { category: p.category } : {}),
        ...(line.note?.trim() ? { note: line.note.trim() } : {}),
      });
    }
    return lines;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, productById, cpMap, customerTier]);

  const draftBuilderState = useMemo<DraftBuilderState>(
    () => ({
      customer: { id: customerId, businessName: customerName ?? "", pricingTier: customerTier },
      items: draftCatalogLines,
      unlisted,
      floorAcked: Array.from(floorAcked),
      orderNotes,
      orderUrgent,
      deliveryDate,
      orderDate,
      discountRaw,
      shippingFeeRaw,
      selectedCreditIds,
      fulfillPath,
    }),
    [
      customerId,
      customerName,
      customerTier,
      draftCatalogLines,
      unlisted,
      floorAcked,
      orderNotes,
      orderUrgent,
      deliveryDate,
      orderDate,
      discountRaw,
      shippingFeeRaw,
      selectedCreditIds,
      fulfillPath,
    ],
  );
  const draftPayload = useMemo<OrderDraftPayload>(
    () => toOrderDraftPayload(draftBuilderState),
    [draftBuilderState],
  );

  const createDraftMutation = useCreateDraft();
  const updateDraftMutation = useUpdateDraft();
  const deleteDraftMutation = useDeleteDraft();
  // The engine deps are read only once (at mount) by useDraftAutosave, so
  // these don't need to be memoized for referential stability.
  const createDraftDep = (input: DraftRowMeta & { payload: unknown }) =>
    createDraftMutation.mutateAsync({
      ...input,
      payload: input.payload as Record<string, unknown>,
    });
  const updateDraftDep = (input: { id: string; payload: unknown } & Partial<DraftRowMeta>) =>
    updateDraftMutation.mutateAsync({
      ...input,
      payload: input.payload as Record<string, unknown>,
    });
  const deleteDraftDep = (id: string) => deleteDraftMutation.mutateAsync(id);

  // A failed draft write used to be invisible at EVERY layer: `onSaveError`
  // was never passed (so the engine's one observability hook was
  // `undefined?.(err)`), and both manual flush points swallowed their
  // rejection in a literal empty catch. A 5xx, a 403 addon gate, a 404 on a
  // draft deleted from web — nothing on screen, nothing in the console, and no
  // retry unless a later edit happens to fire one. (A genuine loss of network
  // is different: api-client queues that write and replays it.)
  const [draftSaveFailed, setDraftSaveFailed] = useState(false);
  // Stable: the autosave engine reads this ONCE, at mount.
  const noteDraftSaveError = useCallback((err: unknown) => {
    setDraftSaveFailed(true);
    console.error("[NewOrderScreen] draft autosave failed:", err);
  }, []);

  // Bind point: this hook owns the create/autosave/single-flight-create
  // lifecycle; ProductPickView only reads its result and drives the
  // submit-time poison-pill + delete below. Never enabled for a route/stop
  // order: an at-door order is submitted then and there, so it parks no SERVER
  // draft — its durability is the LOCAL `stopCartStore` snapshot below, not
  // the run/stop row (which holds no cart at all). And — money-critical —
  // never enabled while a resumed session is still
  // hydrating: `items` is deliberately empty until the live-product
  // cross-check finishes (see above), so `draftPayload` would otherwise be
  // missing every catalog line and an autosave write in that window would
  // PATCH the server draft down to just the unlisted ones.
  //
  // `draftParkable` (decisions doc §PR-3.5) rides the separate `parkable`
  // flag, NOT `enabled`: it must stop the first POST, but it must not freeze
  // a draft that already exists — an operator who deletes every line and
  // walks away has to leave an emptied draft behind, not one DraftStrip still
  // offers with the items they just removed.
  const {
    flush: flushDraft,
    discard: discardDraft,
    draftId,
    getDraftId,
  } = useDraftAutosave(draftPayload, {
    enabled: !runId && !stopId && !hydrating,
    parkable: draftParkable(draftBuilderState),
    kind: "ORDER",
    customerId,
    customerName,
    title: customerName ? `Order, ${customerName}` : "Order draft",
    createDraft: createDraftDep,
    updateDraft: updateDraftDep,
    deleteDraft: deleteDraftDep,
    onSaveError: noteDraftSaveError,
    hydrate: initialDraft ? { draftId: initialDraft.id, payload: initialDraft.payload } : null,
  });
  useEffect(() => {
    // Only ever lift a REAL id upward. `draftId` is null on every mount until
    // the engine creates (or hydration seeds) one, so pushing it would clear a
    // `boundDraftId` the PREVIOUS mount just handed the parent through
    // `onDraftBound(getDraftId())` on "Change customer" — that disables
    // `useDraft`, so `initialDraft` never arrives and the first line POSTs a
    // second server draft. The parent owns clearing (it does so on the 404).
    if (draftId) onDraftBound?.(draftId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  // At-door snapshot: the local counterpart of the server autosave above, on
  // the same 900ms cadence, for the run/stop orders that engine never covers.
  // Written from the same `draftPayload` the server draft serializes, so the
  // seed at the top of this component is a plain `fromOrderDraftPayload` round
  // trip with no second shape to keep in step.
  const stopCartParkable = draftParkable(draftBuilderState);
  useEffect(() => {
    if (!stopId) return;
    const timer = setTimeout(() => {
      const store = useStopCartStore.getState();
      // Symmetric on purpose: emptying the cart must REMOVE the snapshot, or a
      // kill right after "I took those back off" would restore the lines the
      // operator just deleted. It also keeps a route's worth of visited stops
      // from each leaving a permanent empty entry behind.
      if (stopCartParkable) store.setSnapshot(stopId, draftPayload);
      else store.clear(stopId);
    }, 900);
    return () => clearTimeout(timer);
  }, [stopId, draftPayload, stopCartParkable]);
  const clearStopCartSnapshot = useCallback(() => {
    if (stopId) useStopCartStore.getState().clear(stopId);
  }, [stopId]);

  // Flush points. Never blocks the action itself — parking is best-effort and
  // an unhandled rejection must never surface as an app-level error — but it
  // is no longer SILENT: success clears the "not saved" state, failure raises
  // it and logs, through the same handler the engine's debounced path uses.
  const flushDraftQuietly = useCallback(
    () => flushDraft().then(() => setDraftSaveFailed(false), noteDraftSaveError),
    [flushDraft, noteDraftSaveError],
  );
  // Backgrounding the app is one of the loss vectors this autosave exists for,
  // and on iOS/Android it had NO trigger at all: `beforeRemove` is in-app
  // navigation and the `visibilitychange` handler below returns early off web.
  // Pattern copied verbatim from the one other autosaving screen,
  // app/(operator)/products/stock-count/[id].tsx — background flush, then
  // unmount flush.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") void flushDraftQuietly();
    });
    return () => sub.remove();
  }, [flushDraftQuietly]);
  useEffect(() => () => void flushDraftQuietly(), [flushDraftQuietly]);
  const navigation = useNavigation();
  useEffect(() => {
    const nav = navigation as unknown as {
      addListener: (event: "beforeRemove", cb: () => void) => () => void;
    };
    const unsubscribe = nav.addListener("beforeRemove", () => {
      void flushDraftQuietly();
    });
    return unsubscribe;
  }, [navigation, flushDraftQuietly]);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (typeof document === "undefined") return;
    const handler = () => {
      if (document.visibilityState === "hidden") void flushDraftQuietly();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [flushDraftQuietly]);

  /**
   * Stamp the bound draft as submitted (poison-pill) and delete it, awaited
   * with a budget so a slow delete never stalls the confirm. `discard()`
   * runs FIRST so no further autosave write can race the delete.
   */
  const finalizeBoundDraft = async () => {
    // Read the LIVE id, never the `draftId` state value: `onSuccess` closes
    // over the render that invoked submitOrder, and the draft is often created
    // by that submit's own `flush()` (confirm tapped inside the 900ms
    // debounce). The state update lands after this closure was captured, so a
    // stale read here would leave the just-created draft un-pilled and
    // undeleted — DraftStrip would then offer an already-submitted order.
    const id = getDraftId();
    if (!id) return;
    discardDraft();
    await updateDraftMutation
      .mutateAsync({
        id,
        payload: { ...draftPayload, submittedAt: new Date().toISOString() },
      })
      .catch(() => {
        // Best-effort poison pill — proceed to the delete attempt regardless.
      });
    const timeout = (ms: number) =>
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));
    const outcome = await Promise.race([
      deleteDraftMutation
        .mutateAsync(id)
        .then(() => "deleted" as const)
        .catch(() => "failed" as const),
      timeout(1500),
    ]);
    if (outcome !== "deleted") {
      // One background retry — best-effort. If both writes ultimately fail
      // (offline), the poison-pilled draft resurfaces honestly and
      // DraftStrip sweeps it the next time its list loads.
      deleteDraftMutation.mutate(id, { onError: () => {} });
    }
  };

  const createOrder = useCreateOrderAsDriver();
  // Pre-check the customer's open draft/pending order so we can ask before submitting.
  const { data: activeOrder } = useActiveOrderForCustomer(customerId);

  // A screen instance IS a cart session: mint a fresh Idempotency-Key for it
  // (F30/R8). The key then survives every FAILED attempt on this cart — a
  // timeout, an offline queue replay — so the server collapses the retry onto
  // the original order instead of creating a sibling; it is only reset once a
  // submit actually succeeds (below), because the next submit is deliberately
  // a new order.
  useEffect(() => {
    // R5 (close-out): a parked-draft RESUME re-mounts this screen for the SAME
    // cart — rotating the key there re-opens the duplicate window for a
    // timed-out-but-committed submit made before the park. Rotate only for a
    // genuinely new cart session.
    // B215/R3: scoped to THIS customer's slot — no other customer's live cart is disturbed.
    if (!initialDraft) resetOrderSubmitKey(customerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot mount decision on the resume seed
  }, []);

  // Re-entrancy latch. `createOrder.isPending` alone leaves two windows open
  // where the button still reads "Confirm": the pre-submit draft flush (a
  // whole POST/PATCH round trip before `mutate` is even called) and the
  // post-success `finalizeBoundDraft` (react-query clears isPending before
  // running this call's onSuccess). A second tap in either window would create
  // a SECOND order client-side, ahead of the server's idempotency replay.
  // The ref is what actually gates (set synchronously in the tap handler); the
  // state exists only to re-render the disabled button.
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const endSubmit = () => {
    submittingRef.current = false;
    setSubmitting(false);
  };

  const canSave = totalItems > 0 && !createOrder.isPending && !submitting;
  // "Save as draft" needs only a customer (a zero-item DRAFT is allowed server-side).
  const canSaveDraft = !!customerId && !createOrder.isPending && !submitting;

  /** Submit with a specific (or no) merge choice; `asDraft` parks it as a DRAFT. */
  const submitOrder = async (mergeChoice?: "merge" | "separate", asDraft = false) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    // Flush BEFORE mutate so a failed create still leaves an up-to-date
    // parked draft behind (nothing about this order is lost) — but NEVER let
    // it gate the order: a rejected draft write (offline queue, 404 on a draft
    // discarded from web) would otherwise abort submitOrder before `mutate`,
    // leaving Confirm a dead button with no error shown.
    await flushDraftQuietly();
    const settled = await settleBeforeConfirm(items, resolveDefaultUnits);
    if (settled.kind === "blocked") {
      showToast(UNITS_BLOCKED_MESSAGE);
      return endSubmit();
    }
    const lines = settled.lines;
    setItems((cur) => mergeResolvedDefaults(cur, items, lines)); // keeps edits made while this waited
    if (settled.kind === "stop") return endSubmit(); // #2865 case d: the retry press only settles; a second press submits
    const catalogPayload: CreateOrderItemInput[] = Object.entries(lines)
      .map(([productId, line]): CreateOrderItemInput => {
        const p = productById.get(productId);
        const qty = effectiveQty(line, p?.unitsPerBox);
        // Send a unitPrice override only when the operator set a price that
        // differs from the customer's TIER price — a one-time discount (below)
        // or upsell (above). A line sitting at the tier price sends nothing so
        // the server applies the SPECIAL/tier price authoritatively.
        // units_v1: see lib/unit-options.ts#unitPriceBase — the comparison base is the ACTIVE
        // unit's own resolved price, never the pack's `tierPriceFor`.
        const catalog = unitPriceBase(line, p ? tierPriceFor(p) : 0);
        // #2696(c): a SPECIAL line's override is sent only WITH its reason (the server refuses
        // one without); a lingering reasonless one (e.g. an old draft) is dropped, as before.
        const specialOk = p != null && (!isSpecialFor(p) || !!line.overrideReason?.trim());
        const override =
          specialOk && line.unitPrice != null && line.unitPrice !== catalog
            ? {
                unitPrice: line.unitPrice,
                ...(line.overrideReason?.trim()
                  ? { overrideReason: line.overrideReason.trim() }
                  : {}),
              }
            : {};
        const note = line.note?.trim() ? { notes: line.note.trim() } : {};
        const unitLabel = line.unitLabel?.trim() || undefined;
        const base = { productId, qty, ...(unitLabel ? { unitLabel } : {}), ...override, ...note };
        // units_v1: a unit-sold line never carries boxes/pieces (setUnitLabel clears them) — qty
        // above is already the unit COUNT, so skip the box-split branch below entirely for it.
        if (unitLabel) return base;
        // Include boxes/pieces when set so the server uses the BOX-price math
        // for proration and stores the split alongside the order line.
        if (line.boxes != null || line.pieces != null) {
          return {
            ...base,
            boxes: line.boxes ?? 0,
            pieces: line.pieces ?? 0,
          };
        }
        return base;
      })
      .filter((it) => "productId" in it && it.qty > 0);
    // Unlisted lines → `{ name, qty, unitPrice }` (no productId; never boxed).
    // No `unitPrice > 0` clause: a $0 ad-hoc line (a comped or free item the
    // operator deliberately entered) stays fully visible in the cart and still
    // counts toward ITEMS, so dropping it from the POST silently deleted a line
    // the driver would then never load. The server allows it (`@Min(0)` on
    // CreateOrderItemDto.unitPrice) and web sends it. The cart submits what it
    // shows; a line is removed by removing it, not by zeroing its price.
    const unlistedPayload: CreateOrderItemInput[] = unlisted
      .filter((u) => u.qty > 0 && u.name.trim() !== "")
      .map((u) => ({
        name: u.name.trim(),
        qty: u.qty,
        unitPrice: u.unitPrice,
        ...(u.note?.trim() ? { notes: u.note.trim() } : {}),
      }));
    const itemPayload = [...catalogPayload, ...unlistedPayload];

    const discountAmount = Math.max(0, parseFloat(discountRaw) || 0);
    const shippingFee = Math.max(0, parseFloat(shippingFeeRaw) || 0);
    const deliveryTrim = deliveryDate.trim();
    // Blank = today (the server stamps it); only staff can reach the field.
    const orderDateTrim = isStaff ? orderDate.trim() : "";
    createOrder.mutate(
      {
        customerId,
        items: itemPayload,
        routeRunId: runId,
        routeRunStopId: stopId,
        ...(asDraft ? { status: "DRAFT" as const } : {}),
        ...(orderNotes.trim() ? { notes: orderNotes.trim() } : {}),
        ...(orderUrgent ? { urgent: true } : {}),
        ...(deliveryTrim ? { requestedDeliveryDate: deliveryTrim } : {}),
        ...(orderDateTrim ? { orderDate: orderDateTrim } : {}),
        ...(discountAmount > 0 ? { discountAmount } : {}),
        ...(shippingFee > 0 ? { shippingFee } : {}),
        // ALWAYS sent, unlike the omit-when-empty options above (mirrors web's
        // `fulfillPath: data.fulfillPath || "ROUTE"`). `create()` resolves
        // `dto.fulfillPath ?? customer.fulfillPath ?? ROUTE`, so omitting it on
        // ROUTE would let a SHIP-default customer silently overwrite an explicit
        // "Delivery route" choice — and drop the order out of every trip sweep.
        fulfillPath,
        ...(mergeChoice ? { mergeChoice } : {}),
        ...(selectedCreditIds.length
          ? { appliedCreditNotes: selectedCreditIds.map((id) => ({ creditNoteId: id })) }
          : {}),
        // Sent as the Idempotency-Key header (see useCreateOrderAsDriver). The
        // SAME value on every retry/replay of this cart is the point.
        idempotencyKey: getOrderSubmitKey(customerId),
      },
      {
        onSuccess: async (order) => {
          // This cart is now a real order; anything submitted next for THIS customer is a NEW
          // order and must carry its own key (B215/R3: only this customer's slot is cleared).
          resetOrderSubmitKey(customerId);
          // The at-door cart is now a real order — drop its local snapshot so
          // re-opening the stop starts clean instead of resurrecting it.
          clearStopCartSnapshot();
          if (mergeChoice === "merge") {
            showToast(`Merged into order ${order.orderNumber}`);
          } else if (asDraft) {
            showToast("Saved as draft");
          }
          // The parked draft has become a real order (or a formal DRAFT
          // order, or was merged) — either way it's no longer needed.
          await finalizeBoundDraft();
          // B1205: a lost-response replay of a create whose credits were never applied (read-only
          // hint): same copy as web, then open the saved order.
          const hint = creditsPendingFromOrder(order);
          if (hint) {
            showToast(hint.message);
            router.replace(`/(operator)/orders/${hint.orderId}` as any);
            return;
          }
          onSaved(order.orderNumber);
        },
        onError: async (err: Error) => {
          // REG-B308: classify FIRST. A queued offline create is a pending
          // success, not a failure — it must NOT release the submit latch
          // (endSubmit) or rotate the idempotency key (resetOrderSubmitKey)
          // before finalizeBoundDraft() resolves: doing either re-arms the
          // button and mints a fresh key while the ORIGINAL queued POST still
          // carries the old one, so a double-tap in that window fires a
          // SECOND create whose retry key can no longer dedupe against the
          // one already queued. Mirror onSuccess's id-independent cleanup and
          // leave via the same navigation the cancel path uses (no order id
          // exists yet); only the fall-through error path below re-arms the
          // button with endSubmit().
          const outcome = classifyMutationError(err);
          if (outcome.kind === "queued") {
            // REG-B308: a queued create is a pending SUCCESS, so the snapshot
            // clears here too — leaving it would let the operator re-open the
            // stop, find the cart restored, and sell the same load twice while
            // the original POST is still waiting to replay.
            clearStopCartSnapshot();
            await finalizeBoundDraft();
            showToast("Offline — order queued and will sync when you reconnect");
            onBack();
            return;
          }
          // B1205: 503 ORDER_SAVED_CREDITS_PENDING - the order WAS saved, only its credits are
          // pending. Not a failed save: wind the cart down like success (never retry/resubmit) and
          // open the saved order, where the credits are applied.
          const pending = creditsPendingFromError(err);
          if (pending) {
            resetOrderSubmitKey(customerId);
            clearStopCartSnapshot();
            await finalizeBoundDraft();
            showToast(pending.message);
            router.replace(`/(operator)/orders/${pending.orderId}` as any);
            return;
          }
          // Release the latch on EVERY failure branch below — each of them
          // either replays submitOrder (merge choice, license guard) or hands
          // the operator the button back. Success deliberately stays latched:
          // that path navigates away.
          endSubmit();
          const errAny = err as unknown as {
            response?: {
              status?: number;
              data?: {
                message?: string;
                code?: string;
                activeOrder?: any;
                // B215: present on both IDEMPOTENCY_KEY_CONFLICT bodies — the order that
                // HOLDS the key.
                orderId?: string;
              };
            };
          };
          // Belt-and-braces: if the API reports 409 MERGE_CHOICE_REQUIRED (e.g. the
          // pre-check missed a race), prompt the operator now from the error response.
          const body = errAny?.response?.data;
          if (
            errAny?.response?.status === 409 &&
            body?.code === "MERGE_CHOICE_REQUIRED" &&
            body?.activeOrder
          ) {
            // Forward asDraft so a draft that races a 409 stays a draft after
            // the operator picks Merge / Create separate.
            promptMergeChoice(body.activeOrder, asDraft);
            return;
          }
          // B215/D4: this cart's Idempotency-Key is already spoken for — either it replays an
          // order whose cart differs from what's on screen now (CART_MISMATCH), or another
          // order holds it (HELD_BY_OTHER_ORDER). The operator cannot mint a new key without
          // abandoning the cart, so a bare message wedges the screen: offer the held order
          // instead. `orderId` on the body is always the order that HOLDS the key.
          //
          // B215/R2 (round 2): IDEMPOTENCY_REPLAY_NEEDS_RECONCILE is handled identically. It says
          // the key's order was already submitted and has since been dispatched, so the server
          // refuses to guess how to reconcile its invoice — the operator's next move is exactly
          // the same: open that order.
          if (
            errAny?.response?.status === 409 &&
            (body?.code === "IDEMPOTENCY_KEY_CONFLICT" ||
              body?.code === "IDEMPOTENCY_REPLAY_NEEDS_RECONCILE") &&
            body?.orderId
          ) {
            const heldOrderId = String(body.orderId);
            chooseAction(
              "This cart was already submitted",
              String(
                body?.message ??
                  "This cart's submit was already recorded against an existing order.",
              ),
              [
                { label: "Cancel", style: "cancel" },
                {
                  label: "Open order",
                  onPress: () => {
                    // Same wind-down as the success path: the cart that owned this key is
                    // finished with, so start a fresh cart session for THIS customer and retire
                    // the bound draft before navigating away.
                    resetOrderSubmitKey(customerId);
                    void finalizeBoundDraft();
                    router.replace(`/(operator)/orders/${heldOrderId}` as any);
                  },
                },
              ],
            );
            return;
          }
          const restricted = parseSellingRestricted(err);
          if (restricted) {
            setRestrictedBlock(restricted);
            return;
          }
          // Regulated-sale block: open the license guard and replay this exact
          // submit (same mergeChoice) once the license/override is captured.
          const blocked = parseRegulatedAuthError(err);
          if (blocked && blocked.length > 0) {
            licenseRetryRef.current = mergeChoice;
            setLicenseBlock(blocked);
            return;
          }
          const msg = body?.message ?? err?.message ?? "Unable to save order.";
          alertInfo("Couldn't save order", String(msg));
        },
      },
    );
  };

  const promptMergeChoice = (
    existing: {
      orderNumber: string | null;
      itemCount: number;
      total: number;
    },
    asDraft = false,
  ) => {
    chooseAction(
      "Open order exists",
      `This customer has an open order ${existing.orderNumber ?? ""} with ${existing.itemCount} item${existing.itemCount === 1 ? "" : "s"} ($${existing.total.toFixed(2)}). Merge into it or create a separate order?`,
      [
        { label: "Cancel", style: "cancel" },
        { label: "Merge", onPress: () => void submitOrder("merge", asDraft) },
        { label: "Create separate", onPress: () => void submitOrder("separate", asDraft) },
      ],
    );
  };

  const onSave = (asDraft = false) => {
    const gate = orderSubmitGate({ hasCustomer: !!customerId, itemCount: totalItems, asDraft });
    if (!gate.ok) {
      alertInfo(gate.title ?? "Can't save yet", gate.message ?? "");
      return;
    }

    // If the customer already has an active draft/pending order, ask the operator
    // explicitly — never silently merge or silently duplicate.
    if (activeOrder) {
      promptMergeChoice(activeOrder, asDraft);
      return;
    }
    void submitOrder(undefined, asDraft);
  };

  // The cart sheet's copy of this opener is unreachable until the cart has a
  // line, so the catalog list owns the only zero-item path to an ad-hoc item.
  const unlistedPlacement = unlistedAffordancePlacement({
    rowCount: filtered.length,
    // Also suppress mid-search: with keepPreviousData the rows on screen may
    // belong to the previous query, so offering 'Add "x" as an unlisted item'
    // before the real result lands would be premature.
    loading: productsLoading || isSearching,
  });
  const unlistedLabel = searchTerm
    ? `Add "${searchTerm}" as an unlisted item`
    : "Add an unlisted item";

  const handleBackWithFlush = () => {
    void flushDraftQuietly();
    onBack();
  };
  const handleChangeCustomerWithFlush = () => {
    // This flush may be the POST that CREATES the draft, and this view is
    // about to unmount — which detaches the engine's id listener, so
    // `onDraftBound` would never fire and the next customer's builder would
    // start a SECOND server draft. Lift the (live) id to the parent once the
    // flush settles; the engine outlives the unmount via this closure.
    void flushDraftQuietly().then(() => onDraftBound?.(getDraftId()));
    onChangeCustomer();
  };

  // Resume hydration in flight (money-critical, see the effect above) — the
  // whole builder stays behind a spinner rather than rendering anything
  // unvalidated. All hooks above have already run, so this early return is
  // safe. The NavBar rides along so Back is always reachable: this screen sits
  // outside the tab stack, and a failed hydrate leaves `hydrating` true, so
  // without it a dismissed retry dialog would strand the operator here.
  if (hydrating) {
    return (
      <>
        <NavBar
          inlineTitle="New order"
          leading={
            <NavBackButton
              label={backLabel ?? customerName ?? "Back"}
              onPress={handleBackWithFlush}
            />
          }
        />
        <View style={styles.hydrateState}>
          {hydrateFailed ? (
            <>
              <Text style={styles.hydrateFailTitle}>Couldn't restore your order</Text>
              <Text style={styles.hydrateFailText}>
                Some items couldn't be loaded. Check your connection and try again.
              </Text>
              <Pressable
                style={styles.hydrateRetryBtn}
                onPress={retryHydrate}
                accessibilityRole="button"
                accessibilityLabel="Retry restoring your parked order"
              >
                <Ionicons name="refresh" size={16} color={ios.brand} />
                <Text style={styles.hydrateRetryText}>Retry</Text>
              </Pressable>
            </>
          ) : (
            <>
              <ActivityIndicator color={ios.brand} />
              <Text style={styles.emptyText}>Restoring your parked order…</Text>
            </>
          )}
        </View>
      </>
    );
  }

  return (
    <>
      {/* One save trigger only — the footer Confirm. */}
      <NavBar
        inlineTitle="New order"
        leading={
          <NavBackButton
            label={backLabel ?? customerName ?? "Back"}
            onPress={handleBackWithFlush}
          />
        }
      />

      {/* Customer chip — tappable to re-pick when not locked */}
      <View style={styles.customerChipWrap}>
        <Pressable
          style={styles.customerChip}
          onPress={customerLocked ? undefined : handleChangeCustomerWithFlush}
          disabled={customerLocked}
        >
          <Ionicons name="person-outline" size={14} color={ios.brand} />
          <Text style={styles.customerChipText} numberOfLines={1}>
            {customerName ?? "Customer"}
          </Text>
          {customerLocked ? null : <Text style={styles.customerChipChange}>Change</Text>}
        </Pressable>
      </View>

      {/* Find: search + categories, pinned so they never scroll away.
          autoFocus is scoped to THIS product/search picker only — the
          customer-select SearchBar above (CustomerPickerView) does not pass
          it, since a wedge scan there should not steal focus into the wrong
          field. */}
      <SearchBar
        placeholder="Search items…"
        value={search}
        onChangeText={setSearch}
        autoFocus
        onSubmitEditing={() => void handleSearchSubmit()}
        trailing={
          <View style={styles.searchTrailing}>
            {/* keepPreviousData holds the previous rows while the next page
                lands, so without this the stale list can read as a wrong match. */}
            {isSearching ? <ActivityIndicator size="small" color={ios.gray[1]} /> : null}
            <Pressable
              onPress={() => setScanOpen(true)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Scan items"
            >
              <Ionicons name="barcode-outline" size={20} color={ios.brand} />
            </Pressable>
          </View>
        }
      />

      {visible.showCategoryChips ? (
        <View style={styles.browseBar}>
          {categoryChips.length > 1 ? (
            <View style={{ flex: 1 }}>
              <FilterChipRow chips={categoryChips} value={category} onChange={setCategory} />
            </View>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          {/* Leaving browse also drops the category, so the quiet list is the
              order itself and not a filtered slice of the catalogue. */}
          <Pressable
            onPress={() => {
              setBrowsing(false);
              setCategory("All");
            }}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Close the catalogue"
            style={styles.browseClose}
          >
            <Ionicons name="close" size={18} color={ios.label2} />
          </Pressable>
        </View>
      ) : null}

      <FlatList
        ref={listRef}
        style={styles.catalogList}
        data={filtered}
        keyExtractor={productKey}
        renderItem={renderProduct}
        extraData={items}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        // RN's own default is Android-only; forcing it on for iOS is a known
        // source of cells failing to render. (No-op on web — RNW's vendored
        // VirtualizedList never reads this prop.)
        removeClippedSubviews={Platform.OS === "android"}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        onScrollToIndexFailed={onScrollToIndexFailed}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          // `isPlaceholder` guards against fetching page N+1 of a new query key
          // on top of pages 1..N of the previous one.
          if (isPlaceholder || !hasNextPage || isFetchingNextPage) return;
          fetchNextPage();
        }}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={RowSpacer}
        ListEmptyComponent={
          // Quiet + nothing on the order yet: say how to start rather than
          // showing a bare "no products" over an intentionally hidden list.
          visible.emptyHint ? (
            <View style={styles.center}>
              <Text style={styles.emptyText}>{visible.emptyHint}</Text>
            </View>
          ) : unlistedPlacement === "empty-state" ? (
            <View style={styles.center}>
              <Text style={styles.emptyText}>
                No products{searchTerm ? " match your search" : " yet"}.
              </Text>
              <Pressable
                style={styles.emptyUnlistedBtn}
                onPress={() => openUnlistedModal(searchTerm)}
                accessibilityRole="button"
              >
                <Ionicons name="add-circle-outline" size={16} color={ios.brand} />
                <Text style={styles.emptyUnlistedText} numberOfLines={2}>
                  {unlistedLabel}
                </Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.center}>
              <ActivityIndicator color={ios.brand} />
            </View>
          )
        }
        ListFooterComponent={
          <>
            {/* The one way into the full catalogue while quiet. */}
            {visible.showBrowseButton ? (
              <Pressable
                style={styles.listUnlistedBtn}
                onPress={() => setBrowsing(true)}
                accessibilityRole="button"
                accessibilityLabel="Browse the full catalogue"
              >
                <Ionicons name="grid-outline" size={16} color={ios.brand} />
                <Text style={styles.listUnlistedText}>Browse catalogue</Text>
              </Pressable>
            ) : null}
            {unlistedPlacement === "list-footer" ? (
              <Pressable
                style={styles.listUnlistedBtn}
                onPress={() => openUnlistedModal(searchTerm)}
                accessibilityRole="button"
                accessibilityLabel={unlistedLabel}
                hitSlop={4}
              >
                <Ionicons name="add-circle-outline" size={16} color={ios.brand} />
                <Text style={styles.listUnlistedText} numberOfLines={1}>
                  {unlistedLabel}
                </Text>
              </Pressable>
            ) : null}
            {isFetchingNextPage ? (
              <View style={styles.pageSpinner}>
                <ActivityIndicator color={ios.brand} />
              </View>
            ) : null}
          </>
        }
      />

      <View style={styles.footer}>
        <View style={styles.footerRow}>
          {/* ONE entry point into review: the summary itself is the button.
              History: the bare tappable total was missed by users, so a
              separate "View / edit" button was added beside it — two controls
              for one action. The brandWash chip + chevron now carry that
              affordance alone. */}
          <Pressable
            style={[styles.footerSummaryBtn, totalItems === 0 && styles.footerSummaryBtnDisabled]}
            onPress={totalItems > 0 ? () => setCartOpen(true) : undefined}
            disabled={totalItems === 0}
            accessibilityRole="button"
            accessibilityLabel="Review order"
            accessibilityState={{ disabled: totalItems === 0 }}
            hitSlop={6}
          >
            <View style={styles.footerSummaryEyebrowRow}>
              <Text style={styles.footerEyebrow} numberOfLines={1}>
                {totalItems} ITEM{totalItems === 1 ? "" : "S"}
              </Text>
              {/* The chevron sits on the eyebrow line, not beside the 24px
                  total, so the chip's min width is governed by the total alone
                  and $99999.99 stays un-clipped at 320px. */}
              {totalItems > 0 ? <Ionicons name="chevron-up" size={12} color={ios.brand} /> : null}
            </View>
            <Text style={styles.footerTotal} numberOfLines={1}>
              ${total.toFixed(2)}
            </Text>
            {invoiceSplit.willSplit ? (
              <View style={styles.splitBadge}>
                <Ionicons name="layers-outline" size={10} color={ios.system.orangeInk} />
                <Text style={styles.splitBadgeText} numberOfLines={1}>
                  Splits × {invoiceSplit.groups.length}
                </Text>
              </View>
            ) : null}
          </Pressable>
          <Pressable
            style={[
              styles.confirmBtn,
              (!canSave || createOrder.isPending || anyUnitLoading) && styles.confirmBtnDisabled,
            ]}
            disabled={!canSave || anyUnitLoading}
            onPress={() => onSave()}
            accessibilityState={{ disabled: !canSave || anyUnitLoading, busy: anyUnitLoading }}
          >
            <Text style={styles.confirmBtnText} numberOfLines={1}>
              {createOrder.isPending || submitting ? "Saving…" : "Confirm"}
            </Text>
            <Ionicons name="arrow-forward" size={14} color="#fff" />
          </Pressable>
        </View>
        <View style={styles.footerSubRow}>
          {/* A rejected draft write used to be silent everywhere. The order
              itself is never at risk — it is right here on screen — so say
              exactly that rather than alarm an operator mid-round. */}
          {draftSaveFailed ? (
            <Text style={styles.footerNotSaved} numberOfLines={2}>
              Draft not saved — your items are safe here. Confirm to send.
            </Text>
          ) : totalItems === 0 && !createOrder.isPending ? (
            <Text style={styles.footerHint}>Add an item to confirm, or save a draft.</Text>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          {canSaveDraft || createOrder.isPending || submitting ? (
            <Pressable onPress={() => onSave(true)} disabled={!canSaveDraft} hitSlop={6}>
              <Text style={[styles.footerDraftText, !canSaveDraft && { opacity: 0.4 }]}>
                Save as draft
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <InlineToast toast={toast} onDismiss={dismissInline} bottom={112} />

      {/* Scan mode: camera over the live order. The sheet owns the scan haptics
          and the tray scroll; this screen only mutates the order. */}
      <ScanOrderSheet
        visible={scanOpen}
        // Freeze decoding, don't close: `scanOpen` is never cleared here, so
        // whether the operator creates the product or cancels, they land back
        // in a live scanner with the tray intact — nothing to restore.
        // Freeze the decode loop while the price sheet is stacked over the
        // camera too — same reason as the other two hand-offs.
        paused={createCode != null || pickCode != null || priceEditId != null}
        rows={trayRows}
        flash={scanFlash}
        totalItems={totalItems}
        total={total}
        onScanned={handleBarcodeScanned}
        onChangeQty={onTrayChangeQty}
        onIncrement={onTrayIncrement}
        onDecrement={onTrayDecrement}
        onRemove={onTrayRemove}
        onEditPrice={onTrayEditPrice}
        onDismiss={handleScanSheetDismiss}
        onReview={() => {
          setScanOpen(false);
          setCartOpen(true);
        }}
        onDone={() => setScanOpen(false)}
      />

      {/* Ambiguous scan: pick the right product without losing the camera.
          Must stay AFTER <ScanOrderSheet> for the same portal-order reason as
          the create sheet below. */}
      <ProductPickerSheet
        visible={pickCode != null}
        title="Which one?"
        activeOnly
        initialSearch={pickCode ?? undefined}
        onClose={() => setPickCode(null)}
        onSelect={(p: { id: string }) => {
          setPickCode(null);
          acceptScannedProduct(p as unknown as Product, "BOX", { startOnDefault: true });
        }}
      />

      <BlockedLinesModal lines={restrictedBlock} onClose={() => setRestrictedBlock(null)} />

      <LicenseGuardModal
        open={!!licenseBlock}
        customerId={customerId}
        blocked={licenseBlock ?? []}
        readOnly={!canCreateProducts}
        onResolved={() => {
          const mc = licenseRetryRef.current;
          setLicenseBlock(null);
          void submitOrder(mc);
        }}
        onRemoveLines={(categoryIds) => {
          setItems((prev) => {
            const next = { ...prev };
            for (const pid of Object.keys(next)) {
              const p = productById.get(pid);
              if (p?.trackedCategoryId && categoryIds.includes(p.trackedCategoryId))
                delete next[pid];
            }
            return next;
          });
          setLicenseBlock(null);
          showInline("Removed regulated line(s)");
        }}
        onClose={() => setLicenseBlock(null)}
      />

      {/* Create-on-miss: overlays the cart (never navigates away) so the
          in-progress order survives. Supports new-product OR variant-of.

          MUST STAY AFTER <ScanOrderSheet> in this JSX: on react-native-web
          sibling Modals stack by portal-div mount order and neither sets
          z-index, so rendering this earlier would hide it behind an open scan
          sheet. No lint rule can catch a reorder. */}
      <InlineCreateProductSheet
        visible={createCode != null}
        initialCode={createCode ?? undefined}
        onClose={() => setCreateCode(null)}
        onCreated={handleInlineCreated}
      />

      {/* Reprice a tray line without leaving the camera. Same portal-order
          rule as the two sheets above: it MUST stay after <ScanOrderSheet>. */}
      <LinePriceModal
        open={priceEditTarget != null}
        name={priceEditTarget?.name ?? ""}
        unitPrice={priceEditTarget?.unitPrice ?? null}
        rule={priceEditTarget?.rule}
        onClose={closePriceEdit}
        onSave={(value, reason) => {
          const target = priceEditTarget;
          closePriceEdit();
          if (!target) return;
          // Money discipline: round every monetary write. The line TOTAL is never written
          // here — the tray/footer re-derive it through computeLineSubtotal from this price.
          const price = value == null ? null : roundMoney(value);
          if (target.unlisted || !target.rule) return updateUnlistedPrice(target.id, price);
          // #2696(c): the server's rule A (decideTrayPrice → pricing's decideStaffOverride) —
          // within ½¢ of the base clears (SA-085i(b): saving the pre-fill never stores an
          // override); a special line's change carries its reason (the modal refuses without).
          const d = decideTrayPrice({ typed: price, ...target.rule, reason });
          if (d.kind === "set") setLinePrice(target.id, d.price, d.overrideReason);
          else if (d.kind === "clear") setLinePrice(target.id, null);
        }}
      />

      <CartModal
        open={cartOpen}
        items={items}
        productById={productById}
        priceHistory={priceHistory}
        tierPriceFor={tierPriceFor}
        isSpecialFor={isSpecialFor}
        tierForProductId={effectiveTierFor}
        marginFloorFor={(p) => floorForCategory(marginConfig, p.category)}
        unlisted={unlisted}
        total={total}
        totalItems={totalItems}
        invoiceSplit={invoiceSplit}
        saving={createOrder.isPending}
        onClose={() => setCartOpen(false)}
        onChangeBoxes={setBoxes}
        onChangePieces={setPieces}
        onChangeUnits={setUnits}
        onChangeSellBy={setSellBy}
        onChangeUnit={setUnitLabel}
        onChangeQty={setQty}
        onChangePrice={setLinePrice}
        onChangeNote={setLineNote}
        onToggleNote={toggleLineNote}
        showCostEye={canSeeCost}
        floorAcked={floorAcked}
        onSellAnyway={(id) => setFloorAcked((prev) => new Set(prev).add(id))}
        onIncrement={addOne}
        onDecrement={removeOne}
        onRemove={removeLine}
        onChangeUnlistedQty={updateUnlistedQty}
        onChangeUnlistedPrice={updateUnlistedPrice}
        onChangeUnlistedNote={updateUnlistedNote}
        onToggleUnlistedNote={toggleUnlistedNote}
        onRemoveUnlisted={removeUnlisted}
        onAddUnlisted={() => openUnlistedModal("")}
        onScanMore={() => {
          setCartOpen(false);
          setScanOpen(true);
        }}
        options={{
          urgent: orderUrgent,
          onToggleUrgent: () => setOrderUrgent((u) => !u),
          deliveryDate,
          onChangeDeliveryDate: setDeliveryDate,
          orderDate,
          onChangeOrderDate: setOrderDate,
          canBackdate: isStaff,
          discountRaw,
          onChangeDiscount: setDiscountRaw,
          shippingFeeRaw,
          onChangeShippingFee: setShippingFeeRaw,
          notes: orderNotes,
          onChangeNotes: setOrderNotes,
          fulfillPath,
          onChangeFulfillPath: setFulfillPath,
        }}
        credits={{
          rows: creditRows,
          selectedIds: selectedCreditIds,
          onToggle: (id) =>
            setSelectedCreditIds((ids) =>
              ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id],
            ),
          onCreateNew: () => setCreateCreditOpen(true),
        }}
        onSave={() => {
          setCartOpen(false);
          onSave();
        }}
      />

      <UnlistedItemModal
        open={unlistedModalOpen}
        initialName={unlistedPrefill}
        onClose={() => setUnlistedModalOpen(false)}
        onAdd={(name, unitPrice, qty) => {
          addUnlisted(name, unitPrice, qty);
          setUnlistedModalOpen(false);
          showInline(`Added ${name}`);
        }}
      />

      <CreateCreditNoteSheet
        visible={createCreditOpen}
        customerId={customerId}
        onClose={() => setCreateCreditOpen(false)}
        onCreated={(created) => {
          setJustCreatedCredits((prev) => [...prev, created]);
          setSelectedCreditIds((ids) => (ids.includes(created.id) ? ids : [...ids, created.id]));
          setCreateCreditOpen(false);
          showInline(`Created credit ${created.creditNoteNumber}`);
        }}
      />
    </>
  );
}

// ─────────────────────── Cart review modal ───────────────────────
