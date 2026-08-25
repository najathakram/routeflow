import { computeLineSubtotal } from "./pricing";
import type { SaleDraft } from "./api/drafts";

/**
 * Minimize & resume drafts (pos-cost-roles-spec §2) — mobile mirror of
 * apps/web/lib/drafts.ts. PURE: no react-query/api-client/react-native imports,
 * so this runs in the plain node Jest env (see the `import type` below — erased
 * at compile time, never pulls `../api-client` into this module at runtime).
 *
 * The order builder (`ProductPickView`, decisions doc §PR-3.5) serializes its
 * full state into `SaleDraft.payload` so a parked draft restores exactly — on
 * the SAME device or the other one, because `OrderDraftPayload`/`DraftLineItem`
 * are byte-identical to web's. Unlisted (ad-hoc, non-catalog) lines are NOT a
 * separate array in the payload: they map into this same `DraftLineItem` shape
 * with `isUnlisted: true`, exactly like web's `CreateOrderModal` already does —
 * that shared shape is what makes a mobile-parked draft resume on web and back.
 *
 * Every money value below is either carried through unchanged (boxes/pieces/
 * unitPrice as parked) or recomputed via `computeLineSubtotal` (see
 * `draftSummary`) — never a raw `qty * unitPrice`, which over-charges boxed
 * lines (see apps/mobile/lib/pricing.ts header).
 */

/** One line item as parked in a draft — mirrors web's `DraftLineItem` field-for-field. */
export interface DraftLineItem {
  tempId: string;
  productId: string;
  productName: string;
  unit: string;
  listPrice: number;
  specialPrice?: number;
  discountedPrice?: number;
  unitPrice: number;
  priceType: "STANDARD" | "SPECIAL" | "DISCOUNTED" | "MANUAL";
  qty: number;
  unitsPerBox?: number;
  boxes?: number;
  pieces?: number;
  unitCost?: number;
  category?: string;
  isUnlisted?: boolean;
  /** Optional per-line note — carried onto the invoice line (buyer-visible). */
  note?: string;
}

export interface DraftCustomer {
  id: string;
  businessName: string;
  contactName?: string;
  pricingTier?: number;
}

/** Full order-builder state parked in a draft — mirrors web's `OrderDraftPayload`. */
export interface OrderDraftPayload {
  customer: DraftCustomer | null;
  lineItems: DraftLineItem[];
  orderDiscount: string;
  shippingFee: string;
  requestedDeliveryDate: string;
  /** Business date of the order (yyyy-mm-dd). Blank = the API stamps today. */
  orderDate: string;
  notes: string;
  urgent: boolean;
  /** tempIds the operator chose "Sell anyway" on (below-floor acks). */
  floorAcked: string[];
  /**
   * ADDITIVE (mobile origin, PR-3): credit notes selected to apply on submit.
   * Optional so a draft parked before this field existed (or by web, which
   * doesn't read it) still round-trips — `undefined` means none selected.
   * `fromOrderDraftPayload` normalizes this back to `[]`. Mirrored (type-only,
   * unread) onto web's `OrderDraftPayload` so the shapes stay identical.
   */
  selectedCreditIds?: string[];
  /**
   * ADDITIVE (ad-hoc trips / fulfillment): the order's fulfillment mode as the
   * operator left it. Optional so a draft parked BEFORE this field existed
   * still resumes — missing ⇒ `fromOrderDraftPayload` normalizes to ROUTE.
   * Always written going forward, matching web's parked payload (which carries
   * the same key via `DraftPayloadWithFulfillPath` in `CreateOrderModal`), so a
   * draft parked on one device resumes with the same mode on the other.
   */
  fulfillPath?: "ROUTE" | "SHIP";
}

// ─── Builder-state shape (the pure boundary WP3's ProductPickView writes to) ──

/**
 * One catalog line as the builder holds it, already resolved against the live
 * product + the operator's price-override/box-split state — i.e. everything
 * `DraftLineItem` needs except `tempId`/`isUnlisted` (both derived below).
 * `productId` doubles as the stable `tempId` so `floorAcked` entries survive
 * a park/resume round-trip untouched.
 */
export interface DraftCatalogLine {
  productId: string;
  productName: string;
  unit: string;
  listPrice: number;
  specialPrice?: number;
  discountedPrice?: number;
  unitPrice: number;
  priceType: DraftLineItem["priceType"];
  qty: number;
  unitsPerBox?: number;
  boxes?: number;
  pieces?: number;
  unitCost?: number;
  category?: string;
  note?: string;
}

/** An ad-hoc, non-catalog line — mirrors the builder's local `UnlistedLine` state. */
export interface DraftUnlistedLine {
  id: string;
  name: string;
  unitPrice: number;
  qty: number;
  note?: string;
}

/**
 * The order-builder's full parkable state. Lives inside `ProductPickView`
 * (decisions doc §PR-3.5 — it owns `items`, `unlisted`, `floorAcked`,
 * `orderNotes`, `orderUrgent`, `deliveryDate`, `orderDate`, `discountRaw`,
 * `shippingFeeRaw`, `selectedCreditIds`, `fulfillPath`); field names mirror
 * those builder state variables 1:1 so `toOrderDraftPayload`/
 * `fromOrderDraftPayload` are near-trivial glue at the call site.
 */
export interface DraftBuilderState {
  customer: DraftCustomer | null;
  items: DraftCatalogLine[];
  unlisted: DraftUnlistedLine[];
  floorAcked: string[];
  orderNotes: string;
  orderUrgent: boolean;
  deliveryDate: string;
  orderDate: string;
  discountRaw: string;
  shippingFeeRaw: string;
  selectedCreditIds: string[];
  /** ROUTE (delivery route) or SHIP (carrier) — see `OrderDraftPayload`. */
  fulfillPath: "ROUTE" | "SHIP";
}

/**
 * Builder state → wire payload. Catalog lines get `tempId = productId`
 * (keeps `floorAcked` stable across a park/resume). Unlisted lines fold into
 * the SAME `lineItems` array with `isUnlisted: true`, `productId: ""`,
 * `tempId: <local id>` — mirroring web's `addUnlistedItem` exactly, which is
 * what makes them resume correctly on either device. No value here is
 * recomputed (no `qty * unitPrice`) — every field is carried through as the
 * builder already resolved it.
 */
export function toOrderDraftPayload(state: DraftBuilderState): OrderDraftPayload {
  const catalogItems: DraftLineItem[] = state.items.map((li) => ({
    tempId: li.productId,
    productId: li.productId,
    productName: li.productName,
    unit: li.unit,
    listPrice: li.listPrice,
    specialPrice: li.specialPrice,
    discountedPrice: li.discountedPrice,
    unitPrice: li.unitPrice,
    priceType: li.priceType,
    qty: li.qty,
    unitsPerBox: li.unitsPerBox,
    boxes: li.boxes,
    pieces: li.pieces,
    unitCost: li.unitCost,
    category: li.category,
    note: li.note,
  }));
  const unlistedItems: DraftLineItem[] = state.unlisted.map((u) => ({
    tempId: u.id,
    productId: "", // no catalog id — mirrors web's addUnlistedItem
    productName: u.name,
    unit: "each",
    listPrice: u.unitPrice,
    unitPrice: u.unitPrice,
    priceType: "STANDARD" as const,
    qty: u.qty,
    isUnlisted: true,
    note: u.note,
  }));
  return {
    customer: state.customer,
    lineItems: [...catalogItems, ...unlistedItems],
    orderDiscount: state.discountRaw,
    shippingFee: state.shippingFeeRaw,
    requestedDeliveryDate: state.deliveryDate,
    orderDate: state.orderDate,
    notes: state.orderNotes,
    urgent: state.orderUrgent,
    floorAcked: [...state.floorAcked],
    ...(state.selectedCreditIds.length ? { selectedCreditIds: [...state.selectedCreditIds] } : {}),
    fulfillPath: state.fulfillPath,
  };
}

/**
 * Wire payload → builder state. Splits `lineItems` back into catalog vs.
 * unlisted by `isUnlisted` (there is no separate array on the wire). Defensive
 * against a payload from BEFORE `selectedCreditIds` existed, or from web
 * (which never writes it): missing ⇒ `[]`.
 */
export function fromOrderDraftPayload(payload: OrderDraftPayload): DraftBuilderState {
  const items: DraftCatalogLine[] = [];
  const unlisted: DraftUnlistedLine[] = [];
  for (const li of payload.lineItems ?? []) {
    if (li.isUnlisted) {
      unlisted.push({
        id: li.tempId,
        name: li.productName,
        unitPrice: li.unitPrice,
        qty: li.qty,
        note: li.note,
      });
    } else {
      items.push({
        productId: li.productId,
        productName: li.productName,
        unit: li.unit,
        listPrice: li.listPrice,
        specialPrice: li.specialPrice,
        discountedPrice: li.discountedPrice,
        unitPrice: li.unitPrice,
        priceType: li.priceType,
        qty: li.qty,
        unitsPerBox: li.unitsPerBox,
        boxes: li.boxes,
        pieces: li.pieces,
        unitCost: li.unitCost,
        category: li.category,
        note: li.note,
      });
    }
  }
  return {
    customer: payload.customer,
    items,
    unlisted,
    floorAcked: [...(payload.floorAcked ?? [])],
    orderNotes: payload.notes,
    orderUrgent: payload.urgent,
    deliveryDate: payload.requestedDeliveryDate,
    orderDate: payload.orderDate,
    discountRaw: payload.orderDiscount,
    shippingFeeRaw: payload.shippingFee,
    selectedCreditIds: [...(payload.selectedCreditIds ?? [])],
    // Anything other than an explicit "SHIP" (including a pre-fulfillPath
    // payload, where the key is simply absent) resumes as ROUTE — the column
    // default, and the mode every existing draft was composed under.
    fulfillPath: payload.fulfillPath === "SHIP" ? "SHIP" : "ROUTE",
  };
}

/**
 * Nothing worth parking until a customer is picked AND at least one line
 * exists (catalog or unlisted) — a customer-only draft is noise (decisions
 * doc §PR-3.5). Deliberately AND, not OR: differs from web's `canMinimize`
 * (`!!selectedCustomer || lineItems.length > 0`) by design for mobile.
 */
export function draftParkable(state: DraftBuilderState): boolean {
  return !!state.customer && (state.items.length > 0 || state.unlisted.length > 0);
}

/**
 * A short, human label for the device a draft was last touched on. RN has no
 * `navigator.userAgent` (web's source of truth), so the caller passes
 * `Platform.OS` instead of this module importing `react-native` — keeps this
 * file RN-import-free and safe for the plain node Jest env.
 */
export function draftDeviceLabel(platformOS: string): string {
  if (platformOS === "ios") return "iOS app";
  if (platformOS === "android") return "Android app";
  return "Mobile web";
}

/** "just now" / "3 min ago" / "2 h ago" / "5 d ago" for the strip subtitle. */
export function parkedAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(diff) || diff < 45) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}

/** Best-effort read of the parked line items from an arbitrary payload. */
function payloadLineItems(payload: unknown): DraftLineItem[] {
  const items = (payload as OrderDraftPayload | undefined)?.lineItems;
  return Array.isArray(items) ? items : [];
}

/**
 * Strip display fields for a draft: a title, item count, and running subtotal
 * — computed with the shared money helper (`computeLineSubtotal`, boxed
 * proration) so it matches the builder exactly, never a raw `qty * unitPrice`.
 */
export function draftSummary(draft: SaleDraft): {
  title: string;
  itemCount: number;
  total: number;
} {
  const items = payloadLineItems(draft.payload);
  const total = items.reduce(
    (sum, li) =>
      sum +
      computeLineSubtotal({
        unitPrice: li.unitPrice,
        qty: li.qty,
        boxes: li.boxes ?? null,
        pieces: li.pieces ?? null,
        unitsPerBox: li.unitsPerBox ?? null,
      }),
    0,
  );
  const kindLabel = draft.kind === "INVOICE" ? "Invoice" : "Order";
  const who = draft.customerName?.trim();
  const title = draft.title?.trim() || (who ? `${kindLabel}, ${who}` : `${kindLabel} draft`);
  return { title, itemCount: items.length, total };
}
