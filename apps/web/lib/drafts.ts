import { computeLineSubtotal } from "@/lib/pricing";
import type { SaleDraft } from "@/lib/api/drafts";

/**
 * Minimize & resume drafts (pos-cost-roles-spec §2). The order builder serializes
 * its full state into `SaleDraft.payload` so a parked draft restores exactly on
 * resume. This module owns the payload shape + the small display helpers the dock
 * and the builder share.
 */

/** One line item as parked in a draft — mirrors the builder's LineItem. */
export interface DraftLineItem {
  tempId: string;
  productId: string;
  productName: string;
  unit: string;
  listPrice: number;
  specialPrice?: number;
  discountedPrice?: number;
  unitPrice: number;
  priceType: "STANDARD" | "SPECIAL" | "DISCOUNTED";
  qty: number;
  unitsPerBox?: number;
  boxes?: number;
  pieces?: number;
  unitCost?: number;
  category?: string;
  isUnlisted?: boolean;
}

export interface DraftCustomer {
  id: string;
  businessName: string;
  contactName?: string;
  pricingTier?: number;
}

/** Full order-builder state parked in a draft. */
export interface OrderDraftPayload {
  customer: DraftCustomer | null;
  lineItems: DraftLineItem[];
  orderDiscount: string;
  requestedDeliveryDate: string;
  notes: string;
  urgent: boolean;
  /** tempIds the operator chose "Sell anyway" on (below-floor acks). */
  floorAcked: string[];
}

/** A short, human label for the device a draft was last touched on. */
export function draftDeviceLabel(): string {
  if (typeof navigator === "undefined") return "web";
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? "Mobile web" : "Desktop web";
}

/** "just now" / "3 min ago" / "2 h ago" / "5 d ago" for the dock subtitle. */
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
 * Dock display fields for a draft: a title, item count, and running subtotal
 * (computed with the shared money helper so it matches the builder exactly).
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
