import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
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
} from "../../../../../lib/pricing";
import { editedLineFreeUnits } from "../../../../../lib/invoice-totals";
import { freeUnitsLabel } from "../../../../../lib/buyer-cart-logic";
import { incrementLine, incrementLinePiece, setLineUnits } from "../../../../../lib/sale-line";
import { buildSubstituteLine } from "../../../../../lib/substitute-line";
import { findExactScanMatch, looksLikeScanCode, scanUnitKind } from "../../../../../lib/wedge-scan";
import type { ScanOutcome } from "../../../../../lib/scan-loop";
import { useMarginConfig, floorForCategory } from "../../../../../lib/api/margin";
import {
  buildOrderItemDiff,
  type DiffCatalogLine,
  type DiffUnlistedLine,
  type OriginalLine,
} from "../../../../../lib/order-item-diff";
import { sanitizeIntInput } from "../../../../../lib/qty";
import { QTY_INPUT_WIDTH } from "../../../../../lib/row-layout";
import { resolveProductByCode } from "../../../../../lib/barcode-resolve";
import { BarcodeScanner } from "../../../../../components/BarcodeScanner";
import { ProductPickerSheet } from "../../../../../components/ProductPickerSheet";
import { InlineCreateProductSheet } from "../../../../../components/InlineCreateProductSheet";
import { makeScanHandler, runWedgeSubmit } from "../../../../../lib/scan-ladder";
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

/**
 * One row of the in-progress edit. `qty` is total pieces (server's source of
 * truth). For products with `unitsPerBox > 1` operators may also set
 * `boxes`/`pieces` and the server recomputes qty + uses BOX-price proration
 * (see apps/api/src/orders/orders.service.ts:594).
 */
type DraftItem = {
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
type UnlistedDraft = {
  id: string;
  name: string;
  unitPrice: number;
  qty: number;
  /** Per-line note (buyer-visible) — must round-trip through the save. */
  notes?: string;
  /** Original DB line id for an existing unlisted line; undefined = new. */
  lineId?: string;
};

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
 * BUY_N_GET_M free units for THIS draft row, rescaled to the qty now on screen
 * (shared helper, same rule as the invoice edit form and the server's
 * `rescaleBogoFreeUnits` fallback). A pending SUBSTITUTION earns nothing — the
 * snapshot belongs to the product being replaced, and undoing it restores them.
 */
function draftFreeUnits(item: DraftItem): number {
  if (item.substituteProductId) return 0;
  return editedLineFreeUnits({
    promoFreeUnits: item.promoFreeUnits,
    promoBaseUnits: item.promoBaseUnits,
    boxes: item.boxes ?? null,
    qty: item.qty,
  });
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
  const customerId = (order as any)?.customerId as string | undefined;
  // Remembered per-customer prices — pre-fill a newly added line's price so a
  // prior discount carries forward (operator can still change it).
  const { data: priceHistory } = useCustomerPriceHistory(customerId);
  // Customer tier pricing (mirrors NewOrderScreen): a newly added line prices
  // off the customer's effective tier, not the raw list price.
  const { data: customerDetail } = useCustomer(customerId ?? "");
  const { data: customerPrices } = useCustomerPrices(customerId ?? "");
  const customerTier = customerDetail?.pricingTier ?? 1;
  const cpMap = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const cp of customerPrices ?? []) m.set(cp.productId, cp.pricingTier);
    return m;
  }, [customerPrices]);
  const userRole = useAuthStore((s) => s.user?.role);
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

  useEffect(() => {
    if (!order) return;
    const next: Record<string, DraftItem> = {};
    const nextUnlisted: UnlistedDraft[] = [];
    for (const li of order.lineItems) {
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
    setDraft(next);
    setUnlisted(nextUnlisted);
    // Apply-credit: pre-check whatever the order already carries, and reset
    // the touched flag — resets alongside the draft whenever the order reloads.
    setSelectedCreditIds(
      ((order as any)?.orderCreditNotes ?? []).map((oc: any) => oc.creditNoteId),
    );
    setCreditsTouched(false);
    setJustCreatedCredits([]);
  }, [order]);

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

  // ── Save ─────────────────────────────────────────────────────────────────

  const save = () => {
    if (!id) return;
    // Build an incremental diff (replaceAll:false) so untouched lines keep their
    // ids, invoiced qty, and override history — the old full-replace clobbered them.
    // `notes` (per-line, buyer-visible) is threaded through the diff so editing a
    // note is picked up as a change and never silently wiped.
    const catalog: DiffCatalogLine[] = Object.values(draft).map((i) => ({
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
    const unlistedLines: DiffUnlistedLine[] = unlisted.map((u) => ({
      lineId: u.lineId,
      name: u.name,
      qty: u.qty,
      unitPrice: u.unitPrice,
      notes: u.notes,
    }));
    const originals: OriginalLine[] = (order?.lineItems ?? [])
      .filter((li: any) => li.status !== "CANCELLED")
      .map((li: any) => ({
        id: li.id,
        productId: li.productId ?? null,
        qty: toNumber(li.qty),
        unitPrice: toNumber(li.unitPrice),
        name: li.name ?? null,
        notes: (li as any).notes ?? null,
      }));

    // buildOrderItemDiff auto-DELETEs any original line absent from the surviving
    // catalog/unlisted lines — covering removals via the qty stepper (zeroing),
    // not just the trash button — so `pendingDeletes` here is just the explicit
    // trash-button set.
    const items = buildOrderItemDiff({
      catalog,
      unlisted: unlistedLines,
      originals,
      pendingDeletes,
      pendingCancels: [],
    });

    if (items.length === 0 && !creditsTouched) {
      // Nothing changed — mirror web: just leave the editor, don't error.
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

  if (isLoading || !order) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Edit items"
          leading={<NavBackButton onPress={() => router.back()} />}
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
        inlineTitle="Edit items"
        leading={<NavBackButton label={order.orderNumber} onPress={() => router.back()} />}
      />

      {priceEditItem ? (
        <PriceOverrideModal
          item={priceEditItem}
          onSave={(newPrice, reason) => {
            setDraft((d) => ({
              ...d,
              [priceEditItem.productId]: {
                ...priceEditItem,
                unitPrice: newPrice,
                overrideReason: reason || undefined,
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
          // Add-and-stay (scans + wedge input): the picker stays open so N
          // items scan with zero taps — closes web's long-standing edit-screen
          // divergence. Not offered in substitute mode (one pick by contract).
          onPickAndStay={substituteFor ? undefined : (p, kind) => addPickedToDraft(p, kind)}
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
            }
            setShowPicker(false);
          }}
          onClose={() => {
            setShowPicker(false);
            setSubstituteFor(null);
          }}
        />
      ) : (
        <>
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
                                Expires {new Date(cn.expiresAt).toLocaleDateString()}
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
                    canEditPrice={!isDriver && order.status !== "CANCELLED"}
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
              <Pressable style={styles.addBtn} onPress={() => setShowPicker(true)}>
                <Ionicons name="add-circle-outline" size={18} color={ios.brand} />
                <Text style={styles.addBtnText}>Add product</Text>
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
        </>
      )}
    </SafeAreaView>
  );
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
  onPressPrice,
  onPressSubstitute,
  onRemove,
}: {
  item: DraftItem;
  canSplitBoxes: boolean;
  /** Price / discount editing is offered while the order is editable (DRAFT/PENDING/CONFIRMED). */
  canEditPrice: boolean;
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
  onPressPrice: () => void;
  onPressSubstitute: () => void;
  onRemove: () => void;
}) {
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
  const floorPrice =
    hasCost && marginClass != null
      ? priceForMarginFloor(pieceCost!, marginFloor, item.unitsPerBox)
      : null;
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

      {/* Actions */}
      <View style={styles.cardActions}>
        <Pressable style={styles.actionChip} onPress={onPressSubstitute} hitSlop={4}>
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
}: {
  item: DraftItem;
  onSave: (newPrice: number, reason: string) => void;
  onCancel: () => void;
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
  const valid = newPrice > 0;

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

          <Text style={styles.modalFieldLabel}>Reason (optional)</Text>
          <TextInput
            style={[styles.modalInput, { marginBottom: 16 }]}
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. daily market price"
            placeholderTextColor={ios.label3}
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
  onSetPrice,
  onSetQty,
  onRemove,
}: {
  line: UnlistedDraft;
  onSetName: (name: string) => void;
  onSetPrice: (value: number | null) => void;
  onSetQty: (n: number) => void;
  onRemove: () => void;
}) {
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
}) {
  const [scanOpen, setScanOpen] = useState(false);
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
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useProductSearch<{ id: string }>();
  const products = pagedProducts as unknown as Array<
    PickedProduct & { sku?: string; barcode?: string | null; unitSku?: string | null }
  >;

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
  const onScanned = makeScanHandler<PickedProduct & { unitsPerBox?: number | null }>({
    products: () => products,
    accept: (product, kind) => {
      if (onPickAndStay) {
        onPickAndStay(product, kind);
        const loose = kind === "piece" && Number(product.unitsPerBox ?? 0) > 1 ? "1 loose · " : "";
        return { feedback: { kind: "added", text: `Added ${loose}${product.name}` } };
      }
      // Substitute mode: exactly one pick, so the scanner closes behind it.
      setScanOpen(false);
      onPick(product, kind);
      return { close: true };
    },
    resolve: (c) => resolveProductByCode<PickedProduct & { unitsPerBox?: number | null }>(c),
    onAmbiguous: setPickCode,
    onCreate: canCreateProducts ? setCreateCode : undefined,
  });

  // Wedge-scanner path on the picker's search box — mirrors the builders (see
  // NewOrderScreen): Enter-as-scan + settled exact-match auto-add, digit codes
  // only, single exact match only.
  const searchScanBusy = useRef(false);
  const handleSearchSubmit = async () => {
    if (!onPickAndStay || searchScanBusy.current) return;
    searchScanBusy.current = true;
    try {
      await runWedgeSubmit({
        term: searchTerm,
        scan: onScanned,
        clearSearch: () => setSearch(""),
        showInline: showToast,
      });
    } finally {
      searchScanBusy.current = false;
    }
  };

  const lastAutoAdd = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  useEffect(() => {
    if (!onPickAndStay) return;
    const code = searchTerm.trim();
    if (!looksLikeScanCode(code) || isSearching) return;
    const { match } = findExactScanMatch(code, products);
    if (!match) return;
    const now = Date.now();
    if (lastAutoAdd.current.code === code && now - lastAutoAdd.current.at < 800) return;
    lastAutoAdd.current = { code, at: now };
    const kind = scanUnitKind(code, match);
    onPickAndStay(match, kind);
    setSearch("");
    const loose = kind === "piece" && Number(match.unitsPerBox ?? 0) > 1 ? "1 loose · " : "";
    showToast(`Added ${loose}${match.name}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, products, isSearching]);

  return (
    <>
      <NavBar inlineTitle={title} leading={<NavBackButton label="Cancel" onPress={onClose} />} />
      <SearchBar
        placeholder="Scan or search products…"
        value={search}
        onChangeText={setSearch}
        onSubmitEditing={onPickAndStay ? () => void handleSearchSubmit() : undefined}
        trailing={
          <Pressable
            onPress={() => setScanOpen(true)}
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
        ) : products.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>{isSearching ? "Searching…" : "No products match."}</Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 6, paddingBottom: 24 }}>
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
          onClose={() => setScanOpen(false)}
          continuous={!!onPickAndStay}
          // Stop decoding while a hand-off sheet is up, but keep the camera
          // mounted so dismissing it resumes scanning instantly.
          paused={pickCode !== null || createCode !== null}
        />
      ) : null}

      {/* Ambiguous scan → choose from the matches, over the paused camera. */}
      <ProductPickerSheet
        visible={pickCode !== null}
        title="Which product?"
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
