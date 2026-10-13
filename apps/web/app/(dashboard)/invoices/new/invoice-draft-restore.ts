import { getTierPrice } from "@routeflow/pricing";
import type { InvoiceDraftLine, InvoiceDraftSnapshot } from "@/lib/invoice-draft-storage";
import { catalogPricing } from "./invoice-catalog-price";

/**
 * ROW 447: a stored draft names a customer and products by id. Ids are never trusted: before a restore keeps them the
 * page asks the server whether each one still exists. ONLY a definite 404 / 410 removes something; a network failure
 * keeps the draft as stored (the save path re-validates everything anyway).
 */
export interface RestoreCheck {
  snapshot: InvoiceDraftSnapshot;
  /** Lines left out because their product no longer exists. */
  droppedLines: number;
  /** The customer no longer exists and was cleared. */
  customerCleared: boolean;
  /** Lines (not typed by the user) whose price was re-resolved to a different value than the stored one. */
  pricesUpdated: number;
}

type Get = (url: string) => Promise<{ data?: unknown }>;

/** 403 counts as gone too: a row this user may no longer see is not one to bill. */
const isGone = (err: unknown): boolean => {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return status === 403 || status === 404 || status === 410;
};

/**
 * A row that still answers 200 but is soft-deleted, archived or inactive is gone as well:
 * `deletedAt` / `archivedAt` set, or `isActive === false` (the Product and Customer flag).
 */
export function isRetiredRow(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return !!d.deletedAt || !!d.archivedAt || d.isActive === false;
}

const settledGone = (r: PromiseSettledResult<{ data?: unknown } | null>): boolean =>
  r.status === "rejected" ? isGone(r.reason) : isRetiredRow(r.value?.data);

/**
 * Re-price one catalog line exactly as adding the product fresh would (`catalogPricing`). The stored `unitPrice` survives
 * ONLY when the user typed it (`priceEdited`): anything else is a catalog price that may be days old.
 * A product payload with no usable price cannot be re-resolved, so that line is kept as stored (and not counted).
 */
export function repriceLine(
  stored: InvoiceDraftLine,
  product: any,
  o: { customerTier: number; customerPrice?: number; lineTier: number },
): { line: InvoiceDraftLine; updated: boolean } {
  if (!product || !Number.isFinite(parseFloat(String(product.pricePerUnit)))) {
    return { line: stored, updated: false };
  }
  const fresh = catalogPricing(product, o);
  const typed = stored.priceEdited === true;
  // A unit-level line (units_v1) has no ladder to rebuild from here: it returns to its pack, at the pack's own count.
  const unitLevel = !!stored.unitLabel || !!stored.packBase;
  const base: InvoiceDraftLine = { ...stored };
  if (unitLevel && !typed) {
    const pack = stored.packBase;
    delete base.unitLabel;
    delete base.packBase;
    base.qty = pack?.qty ?? 1;
    if (pack?.unitsPerBox !== undefined) base.unitsPerBox = pack.unitsPerBox;
    if (pack?.boxes !== undefined) base.boxes = pack.boxes;
    else delete base.boxes;
    if (pack?.pieces !== undefined) base.pieces = pack.pieces;
    else delete base.pieces;
    if (pack?.sellBy) base.sellBy = pack.sellBy;
  }
  const line: InvoiceDraftLine = {
    ...base,
    unit: typeof product.unit === "string" && product.unit ? product.unit : (base.unit ?? "each"),
    listPrice: fresh.listPrice,
    pricing: fresh.pricing,
    ...(product.averageCost ? { avgCost: parseFloat(String(product.averageCost)) } : {}),
    ...(typeof product.category === "string" ? { category: product.category } : {}),
  };
  if (!typed) {
    line.unitPrice = fresh.effectivePrice;
    line.priceType = fresh.isSpecial ? "SPECIAL" : "STANDARD";
    line.isSpecialPrice = fresh.isSpecial || undefined;
    line.regularPrice = fresh.isSpecial ? fresh.listPrice : undefined;
    delete line.priceEdited;
  }
  if (line.isSpecialPrice === undefined) delete line.isSpecialPrice;
  if (line.regularPrice === undefined) delete line.regularPrice;
  const updated = !typed && line.unitPrice !== stored.unitPrice;
  return { line, updated };
}

export async function checkDraftReferences(
  snapshot: InvoiceDraftSnapshot,
  get: Get,
): Promise<RestoreCheck> {
  const productIds = [
    ...new Set(snapshot.lines.map((l) => l.productId).filter(Boolean)),
  ] as string[];
  const [customerRes, ...productRes] = await Promise.allSettled([
    snapshot.customer
      ? get(`/customers/${encodeURIComponent(snapshot.customer.id)}`)
      : Promise.resolve(null),
    ...productIds.map((id) => get(`/products/${encodeURIComponent(id)}`)),
  ]);
  const gone = new Set(productIds.filter((_, i) => settledGone(productRes[i])));
  const customerCleared = !!snapshot.customer && settledGone(customerRes);
  let customer = customerCleared ? null : snapshot.customer;
  // A live customer row refreshes the fields the form reads (name, tier, default terms).
  if (customer && customerRes.status === "fulfilled") {
    const d = (customerRes.value as { data?: Record<string, unknown> } | null)?.data;
    if (d && d.id === customer.id && typeof d.businessName === "string") {
      customer = {
        id: customer.id,
        businessName: d.businessName,
        ...(typeof d.pricingTier === "number" ? { pricingTier: d.pricingTier } : {}),
        ...(typeof d.defaultPaymentTerms === "string"
          ? { defaultPaymentTerms: d.defaultPaymentTerms }
          : {}),
      };
    }
  }
  const customerTier = customer?.pricingTier ?? 1;

  // The customer's per-product price rows, resolved through their tier like the page's own `priceMap`.
  const customerPrice: Record<string, number> = {};
  const lineTier: Record<string, number> = {};
  if (customer) {
    try {
      const res = await get(`/customers/${encodeURIComponent(customer.id)}/prices`);
      const rows = Array.isArray(res?.data) ? (res.data as Array<Record<string, unknown>>) : [];
      for (const cp of rows) {
        const pid = cp.productId;
        if (typeof pid !== "string") continue;
        const tier = typeof cp.pricingTier === "number" ? cp.pricingTier : customerTier;
        lineTier[pid] = tier;
        if (cp.product && typeof cp.product === "object") {
          const price = getTierPrice(cp.product, tier);
          if (Number.isFinite(price)) customerPrice[pid] = price;
        }
      }
    } catch {
      /* no per-customer rows: the tier ladder prices the lines */
    }
  }

  const productById = new Map<string, unknown>();
  productIds.forEach((id, i) => {
    const r = productRes[i];
    if (r.status === "fulfilled") productById.set(id, r.value?.data);
  });
  let pricesUpdated = 0;
  const lines: InvoiceDraftLine[] = [];
  for (const l of snapshot.lines) {
    if (l.productId && gone.has(l.productId)) continue;
    if (!l.productId || !productById.has(l.productId)) {
      lines.push(l); // free-text line, or the product could not be checked (network)
      continue;
    }
    const r = repriceLine(l, productById.get(l.productId), {
      customerTier,
      customerPrice: customerPrice[l.productId],
      lineTier: lineTier[l.productId] ?? customerTier,
    });
    if (r.updated) pricesUpdated += 1;
    lines.push(r.line);
  }
  return {
    snapshot: { ...snapshot, customer, lines },
    droppedLines: snapshot.lines.length - lines.length,
    customerCleared,
    pricesUpdated,
  };
}
