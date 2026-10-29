"use client";

import * as React from "react";
import { Package, Pencil, Search, RotateCcw, Trash2, X } from "lucide-react";
import { Button, Modal, cn, TAP_TARGET, useToast } from "@routeflow/ui/web";
import { displayProductName, orderLineName } from "@/lib/product-display";
import { sellableFlat, type PickerRow } from "@/lib/product-search-groups";
import { scheduleScannerRefocus } from "@/lib/refocus-scanner";
import {
  usePatchOrderCommissionRate,
  type OrderItem,
  type ItemUpdate,
  type CustomerPriceHistory,
  type PriceType,
} from "@/lib/api/orders";
import { formatMoney } from "@/lib/format";
import { EditCasesPieces } from "./EditCasesPieces";
import { isCasesPiecesLine } from "../edit-cases-pieces";
import { EDIT_QTY_INPUT, EDIT_TAP_BELOW_LG } from "../edit-line-controls";
import { EditScanBar } from "./EditScanBar";
import { DeliveredLockedHint, DeliveredLockedQty } from "./DeliveredLineLock";
import {
  findLockedUnitLineEdit,
  LockedUnitLineBadge,
  lockedUnitLineDisplay,
  type LockedUnitLineDisplay,
  LockedUnitLineError,
  unitLineCount,
} from "./unit-line-lock";
import { useProducts } from "@/lib/api/products";
import {
  computeLineSubtotal,
  type CustomerLayerUnit,
  needsOverrideReason,
  normalizeBoxesPieces,
} from "@routeflow/pricing";
import { type SpecialLine } from "@/lib/useCustomerLinePricing";
import { useMarginConfig, floorForCategory } from "@/lib/api/margin";
import { PriceEditRow } from "../price-edit-row";
import { DecimalInput } from "@/components/MoneyInput";
import { InlineCreateProductModal } from "@/components/InlineCreateProductModal";
import { resolveProductByCode } from "@/lib/barcode-resolve";
import * as scan from "../scan-level-line";
import { storedPackBasis } from "../stored-pack-basis";
import { OrderLineUnitPicker } from "@/components/OrderLineUnitPicker";
import { derivedUnitPatch } from "@/lib/edit-line-derived-unit";
import type { UnitOption } from "@/lib/unit-options";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ApiOrderStatus =
  | "DRAFT"
  | "PENDING"
  | "CONFIRMED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  // Not (yet) rendered as its own status block below — included so the shared
  // "Delete order" gate (renderDeleteOrderAction, further down in page.tsx) can
  // compare against it without a type error; a route can leave an order
  // PARTIALLY_DELIVERED and it must be treated as no-longer-open.
  | "PARTIALLY_DELIVERED"
  | "CANCELLED";

export interface EditItemState {
  priceEdited?: boolean; // #2381: the operator typed this price (picker remounts keep it)
  /** Units P0b: the picker shows this derived base option for a pack-pieces line. Display state, never submitted. */
  derivedBase?: string;
  id: string; // real DB id for existing items; temp "new-{uuid}" for new items
  isNew?: boolean;
  /** True for a free-text, non-catalog line (no productId; { name, qty, unitPrice }). */
  isUnlisted?: boolean;
  originalProductId: string;
  originalProductName: string;
  originalQty: number;
  /** SA-388 (unit-line-lock.tsx): no derivable count; lockedSubtotal = its stored money. */
  countLocked?: boolean;
  lockedDisplay?: LockedUnitLineDisplay; // #2266
  lockedSubtotal?: number;
  /** The line's own denomination, restored when a substitution is undone (a
   *  substitute re-denominates the line against ITS case size). */
  originalUnitsPerBox?: number | null;
  originalBoxSplit?: boolean;
  /** Row 630: the named unit the line was STORED on (a unit line); absent = a stored pack line, whose own price and size price its derived Piece. */
  originalUnitLabel?: string;
  /** The line's own price, restored alongside the denomination when a
   *  substitution is undone — otherwise the original product would save at the
   *  SUBSTITUTE's price (the UPDATE branch sees `priceChanged` and sends it). */
  originalUnitPrice?: number;
  originalBasePrice?: number;
  originalOverrideReason?: string;
  /** B465 fix round 5: the reason-required baseline for THIS session, separate
   *  from originalUnitPrice (which Undo restores the line's own price from —
   *  see restoredPrice). Set to the substitute's own resolved tier price at
   *  substitution time so needsSpecialTierReason compares against a fresh
   *  starting point, not the REPLACED product's price; cleared on Undo so the
   *  comparison falls back to originalUnitPrice again. Reusing
   *  originalUnitPrice itself for this (round 4) broke Undo: restoring it to
   *  the substitute's price left Undo unable to restore the pre-substitution
   *  price, silently repricing the line. */
  reasonBaselinePrice?: number;
  productId: string;
  productName: string;
  qty: number;
  unitPrice: number;
  /** List/catalog price for this line — the strikethrough baseline and the
   * amount-off anchor. `originalPrice ?? unitPrice` when loaded from the order. */
  basePrice: number;
  /** Optional note explaining a price override (DRAFT only). */
  overrideReason?: string;
  cancelled: boolean;
  substituteProductId?: string;
  notes?: string;
  /** Product cost (per piece) + packaging + category for the live margin hint. */
  unitCost?: number | null;
  unitsPerBox?: number | null;
  category?: string | null;
  /** True when the loaded line was stored with a box/piece split (qty is in
   *  pieces). Gates boxed proration so selling-unit lines aren't misread. */
  boxSplit?: boolean;
  /** BUY_N_GET_M snapshot on the loaded line + the whole selling-unit count it
   *  was earned at. The preview MUST net these off or a BOGO line shows at full
   *  price and disagrees with both the stored subtotal and the server on save. */
  promoFreeUnits?: number | null;
  promoBaseUnits?: number | null;
  /** units_v1: the product's PACK unit label (e.g. "Box") — the `OrderLineUnitPicker`'s
   *  fallback pack-option label. Unrelated to `unitLabel` below. */
  unit?: string;
  /** units_v1, STAFF ONLY: set when this line sells by a named unit (Case, Pallet,
   *  Piece…) — `qty` is then the COUNT of that unit (never expanded pieces) and
   *  `boxSplit` is forced false (a unit line is a plain qty*unitPrice line, since
   *  unitPrice is already per-unit). Undefined = the pack, today's behavior. */
  unitLabel?: string;
  /** Needed only by `OrderLineUnitPicker` (auto-refresh-on-tier-change effect) —
   *  mirrors the server's stored `priceType`, not otherwise read on this page. */
  priceType?: PriceType;
  /** A line ADDED here starts on the product's default selling unit (OrderLineUnitPicker applies it). */
  startOnDefaultUnit?: boolean;
  /** The product's PACK label and pack size, kept when a unit pick overwrites `unit` / `unitsPerBox` (S19b: the per-line
   *  SPECIAL judgement names the real product, so a level called "Box" is not read as the pack). */
  packUnit?: string;
  packUnitsPerBox?: number | null;
}

// ─── Boxed proration helpers ──────────────────────────────────────────────────
// A boxed line's `qty` is the total piece count while `unitPrice` is the BOX
// price. Derive boxes/pieces from qty so both the preview and the save payload
// prorate as `unitPrice * (boxes + pieces / unitsPerBox)` — a plain qty*unitPrice
// over-charges boxed lines by unitsPerBox (money-discipline rule).

// `boxSplit` gates proration: only lines that were STORED with a box/piece split
// have `qty` denominated in pieces. A boxed line added via this builder without a
// split keeps `qty` in selling units (boxes) — re-deriving pieces from it would
// under-charge, so we leave those as a plain unitPrice*qty line.
function editBoxedSplit(it: { qty: number; unitsPerBox?: number | null; boxSplit?: boolean }): {
  boxes: number | null;
  pieces: number | null;
} {
  const upb = Number(it.unitsPerBox ?? 0);
  if (upb > 1 && it.boxSplit) {
    const s = normalizeBoxesPieces({ qty: it.qty, unitsPerBox: upb });
    return { boxes: s.boxes, pieces: s.pieces };
  }
  return { boxes: null, pieces: null };
}

/** DTO fragment: send boxes/pieces ONLY for boxed, box-split lines so the server prorates. */
function boxedDtoFields(it: { qty: number; unitsPerBox?: number | null; boxSplit?: boolean }): {
  boxes?: number;
  pieces?: number;
} {
  const { boxes, pieces } = editBoxedSplit(it);
  return boxes != null ? { boxes, pieces: pieces ?? 0 } : {};
}

/**
 * The substitution payload — shared by BOTH save paths (Save Draft/Save and
 * Save & Publish) so they can never drift apart again.
 *
 * Carries the box split (already re-denominated against the SUBSTITUTE's case
 * size when the product was picked, so the split the server prices is the one
 * the preview shows — a bare `qty` bills the substitute's BOX price per piece)
 * plus any operator override in EITHER direction. Mirrors mobile's
 * `buildOrderItemDiff` substitute branch exactly; the server maps below-base to
 * DISCOUNTED and above-base to MANUAL, so dropping an upsell here would silently
 * bill the substitute's list price.
 */
function substituteDtoUpdate(it: EditItemState): ItemUpdate {
  return {
    id: it.id,
    substituteProductId: it.substituteProductId,
    qty: it.qty,
    ...boxedDtoFields(it),
    ...(isPriceOverridden(it)
      ? { unitPrice: it.unitPrice, overrideReason: it.overrideReason }
      : {}),
  };
}

/** An override is any net unit price DIVERGING from the line's base — a discount
 *  below it or an operator upsell above it (same EPS test as `PriceEditRow` and
 *  mobile's `buildOrderItemDiff`; a downward-only test drops upsells). */
function isPriceOverridden(it: { unitPrice: number; basePrice: number }): boolean {
  return Math.abs(it.unitPrice - it.basePrice) > 0.0001;
}

/**
 * B465 (Opus BLOCK item 2, client half): a SPECIAL-tier line's price is this
 * customer's documented contract price — the server now REFUSES a price
 * CHANGE on one with no reason (400), so the client must never let the
 * operator reach that refusal: catalog/unlisted lines keep an optional
 * reason, a SPECIAL-tier line whose price is being CHANGED this session
 * needs one before save.
 *
 * Fix round 3 (Opus BLOCK): this must key on `unitPrice !== originalUnitPrice`
 * (this SESSION's own edit), never `isPriceOverridden` (`unitPrice !==
 * basePrice`, the tier/list reference price) — a SPECIAL line's stored price
 * is ALREADY below/above its `basePrice` by design (that's what "SPECIAL tier"
 * means), so the old check flagged every untouched SPECIAL line as needing a
 * fresh reason and blocked every save that merely touched a DIFFERENT line.
 * `originalUnitPrice` is seeded to the line's own starting price for BOTH an
 * existing line (its stored unitPrice, :1794/:1949) and a fresh add (its
 * initial resolved price, :1062) — undefined only defensively, where there is
 * no baseline to compare against and therefore nothing provably changed.
 */
export function needsSpecialTierReason(
  it: {
    unitPrice: number;
    originalUnitPrice?: number;
    /** B465 fix round 5: a substitution's own baseline, when set, wins over
     *  originalUnitPrice (Undo's restore point for the REPLACED product's
     *  price — never the comparison basis for a line that's since been
     *  substituted). See reasonBaselinePrice on EditItemState. */
    reasonBaselinePrice?: number;
    overrideReason?: string;
    isUnlisted?: boolean;
  },
  isSpecial: boolean,
): boolean {
  const baseline = it.reasonBaselinePrice ?? it.originalUnitPrice;
  if (it.isUnlisted || baseline == null) return false;
  // #2696(c) SA-558b(4): the server's own predicate with THIS act's baseline — the stored price
  // (and the reason on file, seeded into overrideReason) for an existing line, the tier price for
  // an add or a substitution; ½¢ tolerance, the server's.
  return needsOverrideReason({
    overridePrice: it.unitPrice,
    baselinePrice: baseline,
    isSpecialTier: isSpecial,
    hasReason: !!(it.overrideReason ?? "").trim(),
  });
}

/**
 * The line's own price, for the Undo handlers. Substituting rewrites unitPrice /
 * basePrice / overrideReason to the SUBSTITUTE's; without this an abandoned
 * substitution leaves the original product carrying the substitute's price, and
 * the plain UPDATE branch (which fires on `priceChanged`) saves it.
 */
function restoredPrice(it: EditItemState): Partial<EditItemState> {
  return {
    ...(it.originalUnitPrice != null ? { unitPrice: it.originalUnitPrice } : {}),
    ...(it.originalBasePrice != null ? { basePrice: it.originalBasePrice } : {}),
    overrideReason: it.originalOverrideReason,
    // B465 fix round 5: undoing a substitution must drop the substitute's own
    // reason-required baseline too — the comparison falls back to
    // originalUnitPrice (just restored above), the REPLACED product's own
    // stored price, exactly as if the substitution never happened.
    reasonBaselinePrice: undefined,
  };
}

/**
 * Build one edit-state row from a loaded order line — shared by the DRAFT auto-enter effect and
 * `enterEditMode` so the two seeding sites can never drift (A3-2).
 *
 * units_v1: a unit-aware line's COUNT lives in the server's `boxes` field (unit-line-build.ts
 * stores `boxes: count, qty: count * unitsPerBox` — `boxes` is never a physical box for these
 * lines). `qty` here is seeded to that COUNT, never the stored base-piece total, and `boxSplit`
 * is forced false so `boxedDtoFields`/`editLineSubtotal` treat it as a plain qty*unitPrice line —
 * correct, since `unitPrice` on a unit line is already PER UNIT (mirrors the existing "a boxed
 * line added without a split keeps qty in selling units" convention just above).
 */
export function buildEditItemFromLine(li: OrderItem): EditItemState {
  const isUnlisted = !li.productId;
  const label = orderLineName(li) ?? li.productId ?? "Custom item";
  const isUnitLine = li.unitLabel != null;
  // SA-388: count ONLY from unitLineCount; null = LOCKED (seeded 0, never sent — see backstop).
  const unitCount = isUnitLine ? unitLineCount(li) : null;
  const countLocked = isUnitLine && unitCount == null;
  const count = isUnitLine ? (unitCount ?? 0) : Math.round(Number(li.qty));
  return {
    id: li.id,
    isUnlisted,
    originalProductId: li.productId ?? "",
    originalProductName: label,
    originalQty: count,
    ...(countLocked
      ? {
          countLocked: true,
          lockedSubtotal: Number(li.subtotal ?? 0),
          lockedDisplay: lockedUnitLineDisplay(li),
        }
      : {}),
    productId: li.productId ?? "",
    productName: label,
    qty: count,
    unitPrice: Number(li.unitPrice),
    basePrice: Number(li.originalPrice ?? li.unitPrice),
    originalUnitPrice: Number(li.unitPrice),
    originalBasePrice: Number(li.originalPrice ?? li.unitPrice),
    originalOverrideReason: li.overrideReason ?? undefined,
    cancelled: false,
    notes: li.notes,
    overrideReason: li.overrideReason ?? undefined,
    unitCost: li.product?.averageCost != null ? Number(li.product.averageCost) : null,
    // Prefer the line's sale-time box-size snapshot over the live product.
    unitsPerBox: li.unitsPerBox ?? li.product?.unitsPerBox ?? null,
    originalUnitsPerBox: li.unitsPerBox ?? li.product?.unitsPerBox ?? null,
    category: li.product?.category ?? null,
    boxSplit: isUnitLine ? false : li.boxes != null || li.pieces != null,
    originalBoxSplit: isUnitLine ? false : li.boxes != null || li.pieces != null,
    originalUnitLabel: li.unitLabel ?? undefined,
    // BUY_N_GET_M snapshot + the whole-unit count it was earned at.
    promoFreeUnits: li.promoFreeUnits ?? null,
    // SA-378/388: unit line = unitLineCount (0 if LOCKED); PACK keeps boxes (boxes:0+pieces ⇒ 0).
    promoBaseUnits: li.promoFreeUnits
      ? Math.trunc(Number(isUnitLine ? unitCount : li.boxes != null ? li.boxes : li.qty) || 0)
      : null,
    unit: li.product?.unit ?? "",
    packUnit: li.product?.unit ?? undefined,
    // Row 620: a legacy boxed line's own sale-time size wins over the live product (a repack after the sale must not
    // re-denominate a Piece pick). A unit line's snapshot is the picked unit's factor, so it keeps the live pack.
    packUnitsPerBox: isUnitLine
      ? (li.product?.unitsPerBox ?? undefined)
      : (li.unitsPerBox ?? li.product?.unitsPerBox ?? undefined),
    unitLabel: li.unitLabel ?? undefined,
    priceType: li.priceType,
  };
}

/**
 * The line-item diff for the edit builder — the ONE payload builder both save paths use ("Save
 * Draft"/"Save Changes" and "Save & Publish"), so publishing can never bill differently from
 * saving. Deletes are added by the caller. `original` is the order's own stored lines (money-
 * critical: never re-derive this from `items`, which is this SESSION's edited copy).
 *
 * units_v1 (A3-2): a unit line's `qty` is seeded (buildEditItemFromLine) and edited as the COUNT
 * of the named unit, never expanded pieces — so its UPDATE payload sends `{ id, qty, unitLabel }`
 * with `boxes`/`pieces` omitted (boxedDtoFields already returns {} once boxSplit is false) and
 * `productId` alongside `unitLabel` so the server preloads the product/ladder for the edit (a
 * bare `{id, qty, unitLabel}` against a line the server doesn't already know is unit-aware would
 * otherwise silently discard the label — filed separately, not fixed here). `qtyChanged` compares
 * against the STORED line's own count (`unitLineCount(orig)`) for a unit line, never its
 * base-piece `qty`.
 */
export function buildItemUpdates(items: EditItemState[], original: OrderItem[]): ItemUpdate[] {
  const updates: ItemUpdate[] = [];

  for (const edited of items) {
    // A line is overridden when its net unit price diverges from the list/base
    // price in EITHER direction (discount or upsell) — see isPriceOverridden.
    const overridden = isPriceOverridden(edited);
    const newNote = edited.notes?.trim() ? { notes: edited.notes.trim() } : {};
    if (edited.isNew) {
      if (edited.isUnlisted) {
        // New unlisted (ad-hoc) line: no id, no productId — { name, qty, unitPrice }.
        updates.push({
          name: edited.productName.trim(),
          qty: edited.qty,
          unitPrice: edited.unitPrice,
          ...newNote,
        });
      } else {
        // New catalog item: no id — API will create it. Carry the override when present.
        updates.push({
          productId: edited.productId,
          qty: edited.qty,
          ...boxedDtoFields(edited),
          ...(edited.unitLabel ? { unitLabel: edited.unitLabel } : {}),
          ...(overridden
            ? { unitPrice: edited.unitPrice, overrideReason: edited.overrideReason }
            : {}),
          ...newNote,
        });
      }
      continue;
    }
    const orig = original.find((li) => li.id === edited.id);
    if (!orig) continue;

    // SA-388 backstop: a LOCKED line's edit never becomes a request (cancel is fine: no qty).
    if (!edited.cancelled && findLockedUnitLineEdit([edited], [orig])) {
      throw new LockedUnitLineError(edited.productName || "This line");
    }
    const origQty =
      orig.unitLabel != null ? (unitLineCount(orig) ?? edited.originalQty) : Number(orig.qty);
    const qtyChanged = Math.abs(edited.qty - origQty) > 0.0001;
    const priceChanged = Math.abs(edited.unitPrice - Number(orig.unitPrice)) > 0.0001;
    const nameChanged = edited.isUnlisted && edited.productName.trim() !== (orig.name ?? "").trim();
    // "" clears an existing note (the API only applies notes when defined).
    const noteChanged = (edited.notes ?? "").trim() !== ((orig.notes as string) ?? "").trim();
    const notePatch = noteChanged ? { notes: (edited.notes ?? "").trim() } : {};

    if (edited.cancelled) {
      updates.push({ id: edited.id, action: "CANCEL" });
    } else if (edited.substituteProductId) {
      updates.push(substituteDtoUpdate(edited));
    } else if (edited.isUnlisted && (qtyChanged || priceChanged || nameChanged || noteChanged)) {
      // Rename / reprice an existing unlisted line: { id, name?, qty, unitPrice? }.
      updates.push({
        id: edited.id,
        qty: edited.qty,
        ...(nameChanged ? { name: edited.productName.trim() } : {}),
        ...(priceChanged ? { unitPrice: edited.unitPrice } : {}),
        ...notePatch,
      });
    } else if (qtyChanged || priceChanged || noteChanged) {
      updates.push({
        id: edited.id,
        action: "UPDATE",
        qty: edited.qty,
        ...boxedDtoFields(edited),
        ...(edited.unitLabel ? { unitLabel: edited.unitLabel, productId: edited.productId } : {}),
        ...(priceChanged
          ? { unitPrice: edited.unitPrice, overrideReason: edited.overrideReason }
          : {}),
        ...notePatch,
      });
    }
  }
  return updates;
}

/**
 * BUY_N_GET_M free units for the edit preview, rescaled when the operator edits
 * the qty: the snapshot was earned at `promoBaseUnits` whole selling units, so a
 * shrunk line earns proportionally fewer and a grown one never earns MORE than
 * was agreed (mirrors the order engine's `rescaleBogoFreeUnits` fallback and the
 * invoice edit form). Capped at units − 1 — the buyer always pays the N in every
 * (N + M). A pending SUBSTITUTION earns nothing: the snapshot belongs to the
 * product being replaced, and undoing the substitution restores it.
 */
export function editLineFreeUnits(it: {
  qty: number;
  unitsPerBox?: number | null;
  boxSplit?: boolean;
  substituteProductId?: string;
  promoFreeUnits?: number | null;
  promoBaseUnits?: number | null;
}): number {
  if (it.substituteProductId) return 0;
  const stored = Math.max(0, Math.trunc(Number(it.promoFreeUnits ?? 0) || 0));
  if (stored <= 0) return 0;
  const { boxes } = editBoxedSplit(it);
  const units = Math.trunc(Number(boxes != null ? boxes : it.qty) || 0);
  if (units <= 0) return 0;
  const base = Math.max(0, Math.trunc(Number(it.promoBaseUnits ?? units) || 0));
  const earned = base > 0 ? Math.floor((stored * units) / base) : stored;
  return Math.min(stored, earned, units - 1);
}

/** Boxed-aware line subtotal for the edit preview (matches server pricing). */
export function editLineSubtotal(it: {
  unitPrice: number;
  qty: number;
  unitsPerBox?: number | null;
  boxSplit?: boolean;
  substituteProductId?: string;
  promoFreeUnits?: number | null;
  promoBaseUnits?: number | null;
  countLocked?: boolean;
  lockedSubtotal?: number;
}): number {
  // SA-388: a LOCKED line previews its stored money, never a qty-0 recompute (order total).
  if (it.countLocked) return it.lockedSubtotal ?? 0;
  const { boxes, pieces } = editBoxedSplit(it);
  return computeLineSubtotal({
    unitPrice: it.unitPrice,
    qty: it.qty,
    boxes,
    pieces,
    unitsPerBox: it.unitsPerBox ?? null,
    // BUY_N_GET_M: free whole units come off before pricing, exactly like the
    // server — a plain qty*unitPrice previews a BOGO line at full price.
    freeUnits: editLineFreeUnits(it),
  });
}

// ─── Commission rate override (staff + sales_agents addon only) ───────────────

export function CommissionEditModal({
  open,
  onClose,
  orderId,
  currentValue,
}: {
  open: boolean;
  onClose: () => void;
  orderId: string;
  currentValue: number | null;
}) {
  const { toast } = useToast();
  const patchCommission = usePatchOrderCommissionRate();
  const [value, setValue] = React.useState<number | null>(currentValue);

  React.useEffect(() => {
    if (open) setValue(currentValue);
  }, [open, currentValue]);

  // The server resyncs every issued invoice of the order in the same tx
  // (setCommissionRate → syncOrderInvoices) — this just refetches via the
  // hook's invalidation; it never predicts the ledger effect client-side.
  const save = (commissionRatePct: number | null) => {
    patchCommission.mutate(
      { id: orderId, commissionRatePct },
      {
        onSuccess: () => {
          toast({ title: "Commission rate updated", variant: "success" });
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Commission rate override"
      description="Percent of the goods subtotal for this order only. 0 = exempt (no commission); blank = the customer/agent default rate."
      className="max-w-sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={patchCommission.isPending}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => save(null)}
            disabled={patchCommission.isPending}
          >
            Clear override
          </Button>
          <Button size="sm" onClick={() => save(value)} loading={patchCommission.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-1">
        <label className="block text-xs font-medium text-navy/70" htmlFor="order-commission-rate">
          Commission rate %
        </label>
        <DecimalInput
          id="order-commission-rate"
          value={value}
          onChange={setValue}
          decimals={2}
          min={0}
          max={100}
          placeholder="Agent / customer default"
          className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>
    </Modal>
  );
}

// ─── Substitute product picker ────────────────────────────────────────────────

/**
 * A picker row. `unitsPerBox` comes along so the caller can re-denominate the
 * line against the SUBSTITUTE's case size (the server prices the split with it,
 * not the replaced product's), and the tier ladder so it can resolve THIS
 * customer's price for the substitute instead of billing list.
 */
interface SubstituteOption extends PickerRow {
  unit?: string;
  sku?: string;
  pricePerUnit: number;
  unitsPerBox?: number | null;
  priceTier2?: number | string | null;
  priceTier3?: number | string | null;
  priceTier4?: number | string | null;
  priceTier5?: number | string | null;
}

function SubstitutePicker({
  onSelect,
  onClose,
}: {
  onSelect: (product: SubstituteOption) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // includeVariants: a family's name finds its variants; a family is never a line (B1215 C7).
  const { data } = useProducts({
    search: debouncedSearch || undefined,
    isActive: true,
    includeVariants: true,
  });
  const options = sellableFlat<SubstituteOption>(data?.data ?? []);

  return (
    <div className="mt-2 rounded-lg border border-surface-border bg-white shadow-md">
      <div className="flex items-center gap-2 border-b border-surface-border px-3 py-2">
        <Search className="h-4 w-4 shrink-0 text-navy/30" />
        <input
          autoFocus
          className="w-full bg-transparent text-sm text-navy placeholder:text-navy/30 focus:outline-none"
          placeholder="Search products…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="max-h-48 overflow-y-auto">
        {data?.data && options.length === 0 && (
          <p className="px-3 py-2 text-sm text-navy/70">No products found.</p>
        )}
        {options.map((p: SubstituteOption) => (
          <button
            key={p.id}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-raised"
            onClick={() => {
              onSelect(p);
              onClose();
            }}
          >
            <div>
              <span className="font-medium text-navy">{displayProductName(p)}</span>
              {p.sku && <span className="ml-2 text-xs text-navy/70">{p.sku}</span>}
              {p.unit && <span className="ml-2 text-xs text-navy/70">{p.unit}</span>}
            </div>
            <span className="text-xs text-navy">{formatMoney(p.pricePerUnit)}</span>
          </button>
        ))}
      </div>
      <div className="border-t border-surface-border px-3 py-2">
        <button className="text-xs text-navy/70 hover:text-navy" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Edit mode line items ──────────────────────────────────────────────────────

export function EditableLineItems({
  items,
  onChange,
  onAdd,
  onDelete,
  canEditPrice,
  priceHistory,
  tierPriceFor,
  isSpecialTierFor,
  tierForProductId,
  layerOf,
  pricingReady,
  customer,
  orderId,
  lockedLineIds,
  focusFirstQty = false,
}: {
  /** F08: edit opened from the keyboard - focus the first quantity instead of the scan bar. */
  focusFirstQty?: boolean;
  items: EditItemState[];
  onChange: (items: EditItemState[]) => void;
  onAdd: (item: EditItemState) => void;
  /** Remove a line entirely. New (unsaved) items vanish immediately; existing ones
   *  are queued for a DELETE action on save (hard-delete if uninvoiced, else CANCEL). */
  onDelete: (id: string) => void;
  /** Per-line price + discount editing is offered on editable orders (DRAFT/PENDING/CONFIRMED). */
  canEditPrice: boolean;
  /** Remembered per-customer prices — pre-fills a scanned line's price. */
  priceHistory?: CustomerPriceHistory;
  /** This customer's contracted price for a product (per-product tier override,
   *  else the customer's tier). Mirrors mobile's `tierPriceFor`. */
  tierPriceFor: (product: SubstituteOption) => number;
  /** True when this customer's effective tier for the product is not tier 1 — a
   *  contracted price a stale remembered price must never outrank. */
  isSpecialTierFor: (product: SubstituteOption, line?: SpecialLine) => boolean;
  /** units_v1: the EFFECTIVE numeric tier (1-5) for a product — `OrderLineUnitPicker` resolves
   *  the ladder price at this tier, same source as `isSpecialTierFor`. */
  tierForProductId: (productId: string) => number;
  /** S19b: the customer's price-layer rows for a product (`useCustomerPriceLayer().layerOf`); omitted = master's ladder. */
  layerOf?: (productId: string) => readonly CustomerLayerUnit[] | null | undefined;
  /** B62 (REG-B62): false while customer/customer-price queries are in flight —
   *  gates the add-product control and the Substitute trigger so neither can
   *  bake a list price before the customer's contracted tier is known. */
  pricingReady: boolean;
  /** Whose price history the per-line popover shows. */
  customer?: { id: string; name?: string | null };
  /** The order being edited: its own lines are left out of that history (hunt2 F6). */
  orderId?: string;
  /** B1234: delivered lines of a PARTIALLY_DELIVERED order; no editing control is rendered for them. */
  lockedLineIds?: ReadonlySet<string>;
}) {
  const isLocked = (id: string) => lockedLineIds?.has(id) === true;
  const { toast } = useToast();
  // Scroll the just-scanned/added row into view so rapid scanning stays visible.
  const rowRefs = React.useRef<Map<string, HTMLDivElement>>(new Map());
  const [scrollToId, setScrollToId] = React.useState<string | null>(null);
  // Live cost/margin floor for the edit builder (pos-cost-roles-spec §1).
  const { data: marginConfig } = useMarginConfig();
  React.useEffect(() => {
    if (!scrollToId) return;
    rowRefs.current.get(scrollToId)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setScrollToId(null);
  }, [scrollToId, items]);
  const [substituteOpenId, setSubstituteOpenId] = React.useState<string | null>(null);
  const [addSearch, setAddSearch] = React.useState("");
  const [addOpen, setAddOpen] = React.useState(false);
  const [addLoading, setAddLoading] = React.useState(false);
  const [createProductOpen, setCreateProductOpen] = React.useState(false);
  const [createProductInitialSku, setCreateProductInitialSku] = React.useState("");
  // Custom (unlisted) item inline form
  const [customFormOpen, setCustomFormOpen] = React.useState(false);
  const [customName, setCustomName] = React.useState("");
  const [customPrice, setCustomPrice] = React.useState("");
  const [customQty, setCustomQty] = React.useState("1");
  const [customError, setCustomError] = React.useState("");
  const addRef = React.useRef<HTMLDivElement>(null);
  const addInputRef = React.useRef<HTMLInputElement>(null);
  const linesRef = React.useRef<HTMLDivElement>(null);
  // Digit runs that look like a scanned code query the candidate-aware
  // `scanCode` search — a suffix-less wedge scan lands here via the dropdown,
  // and the raw decode contains-misses when the camera's digit count differs
  // from the stored shape (iOS 13-digit vs 12-digit codes in numeric names).
  const addTermIsScanCode = /^\d{8,14}$/.test(addSearch.trim());
  const { data: productsData } = useProducts({
    search: addTermIsScanCode ? undefined : addSearch || undefined,
    scanCode: addTermIsScanCode ? addSearch.trim() : undefined,
    limit: 20,
    isActive: true,
    includeVariants: true,
  });
  const products: any[] = sellableFlat<any>((productsData as any)?.data ?? []);

  // Auto-focus the scan input when the component mounts (edit mode opened) so a
  // wedge scanner's keystrokes land in it straight away. B62 (REG-B62): the
  // input is `disabled` until `pricingReady`, and focus() on a disabled input
  // is a no-op — so this re-runs when pricing settles. It only claims focus
  // while nothing else holds it (ux-spec: no focus stealing when the controls
  // enable), so an operator who clicked elsewhere during the wait keeps it.
  React.useEffect(() => {
    if (!pricingReady) return;
    const t = setTimeout(() => {
      const el = addInputRef.current;
      if (!el || el.disabled) return;
      const active = document.activeElement;
      if (active && active !== document.body && active !== el) return;
      // F08: a keyboard open lands on the first quantity (a person who types straight away); mouse, touch and
      // scanners keep the scan bar (B62). preventScroll either way (F26: the page used to jump to the bottom).
      const firstQty = focusFirstQty
        ? linesRef.current?.querySelector<HTMLInputElement>("input[type=number]:not(:disabled)")
        : null;
      (firstQty ?? el).focus({ preventScroll: true });
    }, 100);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pricingReady]);

  React.useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setAddOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function addProduct(
    p: any,
    level?: scan.SellLevel,
    explicit?: scan.SellLevel,
    startOnDefaultUnit?: boolean,
  ) {
    // W-745 (#3670 review MUST-1): every add path lands here (a scan, the picker, a created product): no price is suggested
    // until the customer's prices are confirmed (a failed or pending read would price at tier 1, LIST).
    if (!pricingReady) return;
    const existing = items.find((it) => it.productId === p.id && !it.cancelled);
    const unitScan = scan.isUnitScanOnBoxed(p, level ?? "BOX");
    if (existing) {
      onChange(
        items.map((it) =>
          it.id === existing.id ? scan.bumpLineForScan(it, unitScan, explicit) : it,
        ),
      );
      setScrollToId(existing.id);
    } else {
      // This customer's contracted price is the line's BASE — pinning the base
      // to list made every tier add look like an operator override, so the
      // server stored it MANUAL instead of resolving the tier as SPECIAL.
      // Pre-fill the remembered price over it only when it is a genuine
      // discount (below the tier price) or upsell (above list) and no
      // contracted tier applies — a stale memory must never outrank a tier
      // price. Mirrors mobile's `addPickedToDraft`.
      const list = Number(p.pricePerUnit ?? 0);
      const base = tierPriceFor(p);
      const hist = priceHistory?.[p.id];
      const startPrice =
        !isSpecialTierFor(p) && hist != null && (hist.lastPrice < base || hist.lastPrice > list)
          ? hist.lastPrice
          : base;
      const newId = `new-${Date.now()}-${Math.random()}`;
      onAdd(
        scan.buildNewLine(p, {
          newId,
          startPrice,
          base,
          unitScan,
          special: isSpecialTierFor(p),
          startOnDefaultUnit,
        }),
      );
      setScrollToId(newId);
    }
    setAddSearch("");
    setAddOpen(false);
    // Refocus for next scan — two tries: first after state settles, second as fallback. Each
    // is guarded on its own (B744): never taken from a note or qty field the operator is in.
    scheduleScannerRefocus(addInputRef, [80, 200]);
  }

  // #2715 PR-1: one resolve path for the field's Enter AND the shared scanner button (camera + wedge).
  async function handleScanCode(raw: string) {
    const code = raw.trim();
    if (!code) return;
    setAddLoading(true);
    try {
      // Shared lib ladder: barcode endpoint → candidate-aware scanCode search.
      // Replaces the inline copy that swallowed 5xx/network as "not found" and
      // skipped unitSku on the exact-match check.
      const result = await resolveProductByCode(code);
      if (result.archived) {
        // F30 / R5: resolved, but retired. Don't add it, and don't offer
        // "create product" for something the catalog already has — say what it
        // is and keep the code selected for the next scan.
        toast({
          variant: "error",
          title: `${result.product?.name || "Item"} is archived — reactivate to sell`,
        });
        scheduleScannerRefocus(addInputRef, 50, { select: true });
        return;
      }
      if (!result.notFound && result.product) {
        if (result.ambiguous) {
          // Several substring hits — this surface has always offered the
          // dropdown as its picker. Keep the code visible but SELECTED, so the
          // next wedge scan (which types) overwrites it instead of appending:
          // the operator can pick a row OR just scan the next label.
          setAddOpen(true);
          scheduleScannerRefocus(addInputRef, 50, { select: true });
          return;
        }
        addProduct(
          result.product,
          ...scan.scanArgsForHit(code, result.product),
          scan.scanCodeIsShared(code, result.product),
        );
        return;
      }
      // Nothing found — open create-product modal with scanned code as SKU
      setCreateProductInitialSku(code);
      setCreateProductOpen(true);
    } catch {
      // Network / 5xx: keep the code selected for an easy rescan; don't treat
      // a transient failure as "product doesn't exist".
      scheduleScannerRefocus(addInputRef, 50, { select: true });
    } finally {
      setAddLoading(false);
    }
  }

  function update(id: string, patch: Partial<EditItemState>) {
    onChange(items.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  /**
   * units_v1 (A3-2): apply a `OrderLineUnitPicker` choice. `qty` becomes the COUNT of the chosen
   * unit (never expanded pieces — buildItemUpdates sends it straight through as `qty`), `boxSplit`
   * is forced false (a unit line is a plain qty*unitPrice line), and any pack-line override is
   * cleared (a fresh unit assignment starts at the ladder's own price, matching CreateOrderModal's
   * `applyLineUnit`). "Back to pack" (`option.kind === "pack"`) is a deliberate no-op here: this
   * row was loaded from the server with no pack-price snapshot to restore (no client pricing math
   * — reconstructing one would need the product's own ladder here, not just this line's state).
   *
   * `reasonBaselinePrice` is set to the NEW unit's own resolved price — same B465 pattern
   * substitution already uses (see `restoredPrice`/`needsSpecialTierReason`): a unit switch jumps
   * `unitPrice` from the pack's price to a differently-priced unit's, which is not an operator
   * override and must never demand a reason on its own; only a manual price typed ON TOP of this
   * new baseline (via `PriceEditRow`) should.
   */
  function setLineUnit(id: string, option: UnitOption, refresh: boolean) {
    if (!pricingReady) return; // W-745 (MUST-2): a unit change re-prices from the ladder at the customer's tier
    const current = items.find((it) => it.id === id);
    if (!current) return;
    // Units P0b / SA-728: a DERIVED Piece is the pack's pieces, and going back to the pack from it is one whole pack.
    const derived = derivedUnitPatch(current, option, refresh);
    if (derived) return update(id, derived);
    if (option.kind === "pack") return;
    update(id, {
      unitLabel: option.value,
      derivedBase: undefined,
      startOnDefaultUnit: false, // any unit choice consumes the default start
      unit: option.label,
      packUnit: current.packUnit ?? current.unit,
      packUnitsPerBox: current.packUnitsPerBox ?? current.unitsPerBox,
      unitsPerBox: option.factorToBase,
      boxSplit: false,
      qty: refresh && current.unitLabel === option.value ? current.qty : 1,
      unitPrice: option.price,
      basePrice: option.listPrice,
      overrideReason: undefined,
      reasonBaselinePrice: option.price,
      priceEdited: false, // #2381: a unit change prices from the ladder
    });
  }

  function addCustom() {
    const name = customName.trim();
    const price = parseFloat(customPrice);
    const qty = parseInt(customQty, 10);
    if (!name) {
      setCustomError("Enter an item name");
      return;
    }
    if (isNaN(price) || price < 0) {
      setCustomError("Enter a valid unit price");
      return;
    }
    if (isNaN(qty) || qty < 1) {
      setCustomError("Enter a quantity of at least 1");
      return;
    }
    const newId = `new-${Date.now()}-${Math.random()}`;
    onAdd({
      id: newId,
      isNew: true,
      isUnlisted: true,
      originalProductId: "",
      originalProductName: name,
      originalQty: qty,
      productId: "",
      productName: name,
      qty,
      unitPrice: price,
      basePrice: price,
      originalUnitPrice: price,
      originalBasePrice: price,
      cancelled: false,
    });
    setScrollToId(newId);
    setCustomFormOpen(false);
    setCustomName("");
    setCustomPrice("");
    setCustomQty("1");
    setCustomError("");
  }

  return (
    <div ref={linesRef} className="space-y-2">
      {items.map((item) => (
        <div
          key={item.id}
          ref={(el) => {
            if (el) rowRefs.current.set(item.id, el);
            else rowRefs.current.delete(item.id);
          }}
          // #2715 PR-1: the WHOLE line (row + price-edit row + note + substitute picker) is ONE
          // bordered card — the price row and the note used to be bare ml-11 siblings under it.
          className={cn(
            "rounded-lg border px-3 py-2.5 transition-colors",
            item.cancelled
              ? "border-surface-border bg-surface-raised opacity-60"
              : "border-surface-border bg-white",
          )}
        >
          <div
            className={cn(
              // REG-B521: flex-wrap so Qty/price/actions overflow to a second line under
              // pressure instead of starving the name column to its min-w-0 floor (390px,
              // a long custom item name) — the name column below gets a real minimum instead.
              "flex flex-wrap items-center gap-x-3 gap-y-2",
            )}
          >
            {/* Product icon */}
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-raised">
              <Package className="h-4 w-4 text-navy/30" />
            </div>

            {/* Product name */}
            <div className="min-w-[140px] flex-1">
              {item.substituteProductId ? (
                <div>
                  <span className="line-through text-xs text-navy/70 mr-1">
                    {item.originalProductName}
                  </span>
                  <span className="text-sm font-medium text-navy">→ {item.productName}</span>
                </div>
              ) : item.isUnlisted && !item.cancelled ? (
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={item.productName}
                    onChange={(e) => update(item.id, { productName: e.target.value })}
                    placeholder="Item name"
                    className="min-w-0 flex-1 rounded border border-surface-border bg-white px-2 py-1 text-sm font-medium text-navy max-lg:h-11 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                  <span className="shrink-0 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700 ring-1 ring-brand-200">
                    Custom
                  </span>
                </div>
              ) : (
                <span
                  className={cn("text-sm font-medium text-navy", item.cancelled && "line-through")}
                >
                  {item.productName}
                  {item.isUnlisted && (
                    <span className="ml-1.5 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700 ring-1 ring-brand-200">
                      Custom
                    </span>
                  )}
                </span>
              )}
              {item.cancelled && <span className="text-xs text-danger ml-1.5">Not available</span>}
            </div>

            {/* SA-388: a LOCKED unit line takes no qty edit; saves refuse any edit to it. */}
            {!item.cancelled && item.countLocked && (
              <LockedUnitLineBadge display={item.lockedDisplay} />
            )}

            {/* B1234: a delivered line shows its quantity as text, no input */}
            {!item.cancelled && isLocked(item.id) && <DeliveredLockedQty qty={item.qty} />}

            {/* O1 (F06): a classic boxed line gets the SAME cases + loose-pieces control as Create. */}
            {!isLocked(item.id) && isCasesPiecesLine(item) && (
              <EditCasesPieces item={item} onChange={(patch) => update(item.id, patch)} />
            )}

            {/* Qty input */}
            {!item.cancelled &&
              !item.countLocked &&
              !isCasesPiecesLine(item) &&
              !isLocked(item.id) && (
                // r4 Q28: the same field and the same word-after-the-number as a boxed line ("[2] boxes", "[3] each").
                <label className="flex items-center gap-1.5 text-xs text-navy/70">
                  <span className="sr-only">Qty</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    className={EDIT_QTY_INPUT}
                    value={item.qty}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (!isNaN(v) && v > 0)
                        update(item.id, { qty: v, startOnDefaultUnit: false });
                    }}
                  />
                  <span aria-hidden className="min-w-0 max-w-[6rem] truncate">
                    {item.unit?.trim() || "qty"}
                  </span>
                  <scan.SplitLineHint item={item} />
                </label>
              )}

            {/* units_v1 (A3-2): renders nothing unless flag.units_v1 is on AND this product has
                levels (OrderLineUnitPicker/UnitPicker self-gate) — every other tenant/product sees
                today's row byte for byte. Excluded for a substitution in progress (re-denominates
                against the SUBSTITUTE's case size instead — a separate, untouched concern). */}
            {!item.cancelled &&
              !item.isUnlisted &&
              !item.substituteProductId &&
              !item.countLocked &&
              !isLocked(item.id) && (
                <OrderLineUnitPicker
                  className="max-lg:h-11"
                  line={{
                    productId: item.productId,
                    productName: item.productName,
                    // the PACK's label and size, not the picked unit's (a pick overwrites item.unit / unitsPerBox)
                    unit: item.packUnit ?? item.unit ?? "",
                    unitsPerBox: item.packUnitsPerBox ?? item.unitsPerBox ?? undefined,
                    listPrice: item.basePrice,
                    unitPrice: item.unitPrice,
                    // PROMO (server-only, never client-set) has no picker-relevant meaning —
                    // the picker only branches on DISCOUNTED/MANUAL to skip its tier-refresh.
                    priceType:
                      item.priceType === "SPECIAL" ||
                      item.priceType === "DISCOUNTED" ||
                      item.priceType === "MANUAL"
                        ? item.priceType
                        : "STANDARD",
                    unitLabel: item.unitLabel,
                    derivedBase: item.derivedBase,
                    priceEdited: item.priceEdited,
                    ownPack: storedPackBasis(item),
                  }}
                  tier={tierForProductId(item.productId)}
                  layer={layerOf?.(item.productId)}
                  startOnDefaultUnit={item.startOnDefaultUnit}
                  disabled={!pricingReady}
                  onChange={(option, refresh) => setLineUnit(item.id, option, refresh)}
                />
              )}

            {/* BUY_N_GET_M: name the units the live total below nets off. */}
            {!item.cancelled && editLineFreeUnits(item) > 0 && (
              <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
                {editLineFreeUnits(item)} free
              </span>
            )}

            {/* Live line total */}
            {!item.cancelled && (
              <span className="money w-20 shrink-0 text-right text-sm font-semibold text-navy">
                {formatMoney(editLineSubtotal(item))}
              </span>
            )}

            {/* Action buttons (phone: the first label lines up with the card edge, not 8px in) */}
            <div className="flex items-center gap-1.5 max-sm:-ml-2">
              {item.cancelled ? (
                <button
                  className={cn(
                    "flex items-center gap-1 rounded px-2 py-1 text-xs text-brand-600 hover:bg-brand-50",
                    EDIT_TAP_BELOW_LG,
                  )}
                  onClick={() =>
                    update(item.id, {
                      cancelled: false,
                      // "Not available" only set cancelled:true, so undo just
                      // clears it — restoring product/qty/denomination/price
                      // here would discard edits made before the mis-click.
                      // Only a substituted-then-cancelled line reverts fully.
                      ...(item.substituteProductId
                        ? {
                            productId: item.originalProductId,
                            productName: item.originalProductName,
                            qty: item.originalQty,
                            unitsPerBox: item.originalUnitsPerBox ?? null,
                            boxSplit: item.originalBoxSplit ?? false,
                            ...restoredPrice(item),
                            substituteProductId: undefined,
                          }
                        : {}),
                    })
                  }
                >
                  <RotateCcw className="h-3 w-3" />
                  Undo
                </button>
              ) : isLocked(item.id) ? null : (
                <>
                  {!item.substituteProductId && !item.isUnlisted && !item.countLocked && (
                    <button
                      className={cn(
                        "rounded px-2 py-1 text-xs text-navy/70 hover:bg-surface-raised hover:text-navy disabled:opacity-50",
                        EDIT_TAP_BELOW_LG,
                      )}
                      disabled={!pricingReady}
                      onClick={() => setSubstituteOpenId((p) => (p === item.id ? null : item.id))}
                    >
                      Substitute
                    </button>
                  )}
                  {item.substituteProductId && (
                    <button
                      className={cn(
                        "flex items-center gap-1 rounded px-2 py-1 text-xs text-brand-600 hover:bg-brand-50",
                        EDIT_TAP_BELOW_LG,
                      )}
                      onClick={() =>
                        update(item.id, {
                          productId: item.originalProductId,
                          productName: item.originalProductName,
                          qty: item.originalQty,
                          // Back to the original product's own denomination —
                          // otherwise the line would keep the substitute's case
                          // size and re-price the original against it on save.
                          unitsPerBox: item.originalUnitsPerBox ?? null,
                          boxSplit: item.originalBoxSplit ?? false,
                          ...restoredPrice(item),
                          substituteProductId: undefined,
                        })
                      }
                    >
                      <RotateCcw className="h-3 w-3" />
                      Undo
                    </button>
                  )}
                  <button
                    className={cn(
                      "rounded px-2 py-1 text-xs text-navy/70 hover:bg-surface-raised hover:text-navy",
                      EDIT_TAP_BELOW_LG,
                    )}
                    onClick={() => update(item.id, { cancelled: true })}
                  >
                    Not available
                  </button>
                  <button
                    className={cn(
                      TAP_TARGET,
                      "flex items-center gap-1 rounded p-1 text-navy/30 hover:text-danger hover:bg-danger-bg transition-colors max-sm:px-2 max-sm:text-navy/70",
                    )}
                    title={`Remove ${item.productName?.trim() || "item"}`}
                    aria-label={`Remove ${item.productName?.trim() || "item"}`}
                    onClick={() => onDelete(item.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    {/* r5 F11: the word on a phone (icon-only from sm up; aria-label still names the line) */}
                    <span className="text-xs sm:sr-only">Remove</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Per-line price + discount editor — DRAFT catalog lines, or any unlisted
              line (its price is intrinsic, so always editable in edit mode). */}
          {(canEditPrice || item.isUnlisted) && !item.cancelled && !isLocked(item.id) && (
            <PriceEditRow
              basePrice={item.basePrice}
              unitPrice={item.unitPrice}
              // B465 fix round 5: a substitution's own baseline wins over the
              // REPLACED product's originalUnitPrice — same resolution as
              // needsSpecialTierReason, so the required-field styling and the
              // save-time check never disagree.
              originalUnitPrice={item.reasonBaselinePrice ?? item.originalUnitPrice}
              overrideReason={item.overrideReason}
              onPriceChange={(net) => update(item.id, { unitPrice: net, priceEdited: true })}
              onReasonChange={(reason) => update(item.id, { overrideReason: reason || undefined })}
              unitCost={item.unitCost}
              unitsPerBox={item.unitsPerBox}
              floor={floorForCategory(marginConfig, item.category)}
              isSpecial={
                !item.isUnlisted &&
                item.productId != null &&
                isSpecialTierFor({ id: item.productId } as SubstituteOption, item)
              }
              history={
                item.isUnlisted
                  ? undefined
                  : {
                      customerId: customer?.id,
                      customerName: customer?.name,
                      productId: item.productId,
                      productName: item.productName,
                      unitHint:
                        item.unitLabel ??
                        (item.unitsPerBox && item.unitsPerBox > 1 ? "case" : item.unit),
                      packHint: item.unitsPerBox ?? null,
                      excludeOrderId: orderId,
                    }
              }
            />
          )}

          {isLocked(item.id) && !item.cancelled && <DeliveredLockedHint />}

          {/* Per-line note — carried onto the invoice line (buyer-visible). */}
          {!item.cancelled && (
            <div className="mt-1 sm:ml-11">
              <textarea
                rows={2}
                maxLength={2000}
                value={item.notes ?? ""}
                onChange={(e) => update(item.id, { notes: e.target.value })}
                placeholder="Note for this line (prints on invoice)"
                className="w-full resize-y rounded border border-surface-border bg-white px-2 py-1 text-xs text-navy max-lg:min-h-11 placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
          )}

          {/* Substitute picker */}
          {substituteOpenId === item.id && (
            <SubstitutePicker
              onSelect={(p) => {
                // Re-denominate the line against the SUBSTITUTE's case size, the
                // same way mobile's buildSubstituteLine does: the ordered PIECE
                // count carries across the swap and boxes/pieces are re-derived
                // from the substitute's unitsPerBox. Keeping the replaced
                // product's split would preview one case size while the server
                // (which prices the split with the substitute's) bills another —
                // and on a loose substitute it would send boxes for a product
                // that has none.
                const upb = p.unitsPerBox == null ? null : Number(p.unitsPerBox);
                const lineUpb = Number(item.unitsPerBox ?? 0);
                // A box-split line's qty is already in pieces; a boxed line
                // without a split counts SELLING UNITS (boxes).
                const pieces = item.boxSplit || lineUpb <= 1 ? item.qty : item.qty * lineUpb;
                const split = normalizeBoxesPieces({ qty: pieces, unitsPerBox: upb });
                update(item.id, {
                  substituteProductId: p.id,
                  productId: p.id,
                  productName: displayProductName(p),
                  // The customer's contracted price for the SUBSTITUTE, over its
                  // list price as the strikethrough base — same split mobile's
                  // buildSubstituteLine stores. Pinning both to list made every
                  // substitution look un-overridden, so no unitPrice reached the
                  // server and a tier customer silently lost their price.
                  unitPrice: tierPriceFor(p),
                  // B465 fix round 5 (Opus BLOCK item 1): reset the reason-required
                  // baseline to the SUBSTITUTE's own resolved price via
                  // reasonBaselinePrice, NEVER originalUnitPrice — that field is
                  // Undo's own restore point (restoredPrice) for the REPLACED
                  // product's price, and round 4 briefly overwrote it here, which
                  // broke Undo: restoring "originalUnitPrice" after a substitute
                  // just put the substitute's own price back, so Undo silently
                  // repriced the line instead of reverting it. A substitution is a
                  // fresh reason-required starting point, not a reprice — only a
                  // price edit AFTER this substitution should trip the guard.
                  reasonBaselinePrice: tierPriceFor(p),
                  basePrice: Number(p.pricePerUnit ?? 0),
                  overrideReason: undefined,
                  qty: split.qty,
                  unitsPerBox: upb,
                  boxSplit: split.boxes != null,
                });
                setSubstituteOpenId(null);
              }}
              onClose={() => setSubstituteOpenId(null)}
            />
          )}
        </div>
      ))}

      {/* ── Add Item / Scan row ── */}
      <div ref={addRef} className="relative">
        <EditScanBar
          inputRef={addInputRef}
          value={addSearch}
          loading={addLoading}
          pricingReady={pricingReady}
          onChange={(v) => {
            setAddSearch(v);
            setAddOpen(Boolean(v));
          }}
          onFocus={() => addSearch && setAddOpen(true)}
          onEnter={() => handleScanCode(addSearch)}
          onEscape={() => {
            setAddSearch("");
            setAddOpen(false);
          }}
          onScan={(code) => {
            setAddSearch(code);
            void handleScanCode(code);
          }}
          onError={(message) => toast({ variant: "error", title: message })}
        />
        {/* r5 N09: below sm the results open ABOVE the field; below it the pinned Save bar hid all but one row. */}
        {addOpen && products.length > 0 && (
          <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-lg border border-surface-border bg-white shadow-lg max-sm:bottom-full max-sm:top-auto max-sm:mb-1 max-sm:mt-0">
            <ul className="max-h-52 overflow-y-auto py-1">
              {products.map((p: any) => (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={!pricingReady}
                    onMouseDown={() => addProduct(p, undefined, undefined, true)}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-brand-50 flex items-center justify-between gap-2 disabled:opacity-50"
                  >
                    <span className="font-medium text-navy">{displayProductName(p)}</span>
                    <span className="text-xs text-navy/70">{p.unit}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* ── Add custom (unlisted) item ── */}
      {customFormOpen ? (
        <div className="space-y-2 rounded-lg border border-dashed border-brand-300 bg-brand-50 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-navy">Custom item</span>
            <button
              type="button"
              onClick={() => {
                setCustomFormOpen(false);
                setCustomError("");
              }}
              className={cn(
                TAP_TARGET,
                "rounded p-1 text-navy/40 hover:text-danger transition-colors",
              )}
              title="Cancel"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[140px] flex-1 space-y-1">
              <label className="block text-[10px] font-medium text-navy/70">Name</label>
              <input
                type="text"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="e.g. Pallet delivery surcharge"
                className="h-9 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-brand-500"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustom();
                  }
                }}
              />
            </div>
            <div className="w-24 space-y-1">
              <label className="block text-[10px] font-medium text-navy/70">Unit price</label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={customPrice}
                onChange={(e) => setCustomPrice(e.target.value)}
                placeholder="0.00"
                className="h-9 w-full rounded border border-surface-border bg-white px-2 text-right text-sm text-navy placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-brand-500"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustom();
                  }
                }}
              />
            </div>
            <div className="w-16 space-y-1">
              <label className="block text-[10px] font-medium text-navy/70">Qty</label>
              <input
                type="number"
                min={1}
                step={1}
                value={customQty}
                onChange={(e) => setCustomQty(e.target.value)}
                className="h-9 w-full rounded border border-surface-border bg-white px-2 text-right text-sm text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustom();
                  }
                }}
              />
            </div>
            <Button type="button" size="sm" onClick={addCustom}>
              Add
            </Button>
          </div>
          {customError && <p className="text-xs text-danger">{customError}</p>}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCustomFormOpen(true)}
          className="flex items-center gap-1.5 text-sm font-medium text-brand-500 hover:text-brand-600 transition-colors"
        >
          <Pencil className="h-4 w-4" />
          Add custom item
        </button>
      )}

      <InlineCreateProductModal
        isOpen={createProductOpen}
        onClose={() => {
          setCreateProductOpen(false);
          setAddSearch("");
        }}
        onCreated={(product) => {
          addProduct({
            id: product.id,
            name: product.name,
            sku: product.sku,
            unit: product.unit,
            pricePerUnit: product.pricePerUnit,
          });
          setCreateProductOpen(false);
        }}
        initialSku={createProductInitialSku}
      />
    </div>
  );
}
