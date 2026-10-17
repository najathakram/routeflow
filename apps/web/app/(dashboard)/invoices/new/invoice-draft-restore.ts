import {
  customerLinePrice,
  getTierPrice,
  layerRowForLabel,
  normalizeBoxesPieces,
  type CustomerLayerUnit,
} from "@routeflow/pricing";
import type { ProductUnitLevel } from "@routeflow/types";
import { buildUnitOptions } from "@/lib/unit-options";
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
  /** Unit-level lines left out because the product no longer offers that unit: the user re-enters them. */
  unitsDropped: number;
  /** Catalog lines whose price could not be re-checked (a read failed): kept as stored, not counted as updated. */
  pricesUnchecked: number;
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
  // A variant is as retired as the parent it hangs under (when the API populated it).
  return !!d.deletedAt || !!d.archivedAt || d.isActive === false || isRetiredRow(d.parent);
}

const settledGone = (r: PromiseSettledResult<{ data?: unknown } | null>): boolean =>
  r.status === "rejected" ? isGone(r.reason) : isRetiredRow(r.value?.data);

/** What the ladder read (`/products/:id/units`) said for a product with a unit-level line. */
export type UnitLadder =
  { kind: "ok"; levels: ProductUnitLevel[] } | { kind: "gone" } | { kind: "unchecked" };

interface Resolved {
  /** null = the line cannot be kept (its unit is no longer offered). */
  line: InvoiceDraftLine | null;
  updated: boolean;
  unitDropped?: boolean;
  /** The line's price could not be re-checked (its unit ladder was unreadable). */
  unchecked?: boolean;
}

/**
 * Re-price one catalog line exactly as adding the product fresh would (`catalogPricing`). The stored `unitPrice` survives
 * ONLY when the user typed it (`priceEdited`): anything else is a catalog price that may be days old.
 * A product payload with no usable price cannot be re-resolved, so that line is kept as stored (and not counted).
 *
 * A unit-level line (units_v1) keeps its unit AND its typed count: only the unit's price is re-resolved from the fresh
 * ladder. A unit the product no longer offers drops the line (`line: null`); an unreadable ladder keeps it as stored.
 */
export function repriceLine(
  stored: InvoiceDraftLine,
  product: any,
  o: {
    customerTier: number;
    customerPrice?: number;
    lineTier: number;
    ladder?: UnitLadder;
    /** S19b: this product's rows in the flag-on customer price layer (`CustomerPriceLayerResponse.products[id]`). */
    layer?: readonly CustomerLayerUnit[];
  },
): Resolved {
  if (!product || !Number.isFinite(parseFloat(String(product.pricePerUnit)))) {
    return { line: stored, updated: false };
  }
  const layerLine = o.layer
    ? customerLinePrice({ product, tier: o.lineTier, layer: o.layer, unitLabel: null })
    : undefined;
  const fresh = catalogPricing(product, { ...o, layerLine });
  const typed = stored.priceEdited === true;
  const common: Partial<InvoiceDraftLine> = {
    pricing: fresh.pricing,
    tierPrices: fresh.tierPrices,
    ...(product.averageCost ? { avgCost: parseFloat(String(product.averageCost)) } : {}),
    ...(typeof product.category === "string" ? { category: product.category } : {}),
  };

  if (stored.unitLabel) {
    const ladder = o.ladder;
    if (!ladder || ladder.kind === "unchecked") {
      return { line: stored, updated: false, unchecked: !typed };
    }
    if (ladder.kind === "gone") return { line: null, updated: false, unitDropped: true };
    const want = stored.unitLabel.trim().toLowerCase();
    const opt = buildUnitOptions(product, ladder.levels, o.lineTier).find(
      (x) => x.value.trim().toLowerCase() === want,
    );
    if (!opt) return { line: null, updated: false, unitDropped: true };
    // S19b R3: when the line's unit is in the customer layer, the layer's price is the line's price.
    const unitRow = o.layer ? layerRowForLabel(product, o.layer, stored.unitLabel) : undefined;
    const unitLine = unitRow
      ? customerLinePrice({
          product,
          tier: o.lineTier,
          layer: o.layer,
          unitLabel: stored.unitLabel,
        })
      : undefined;
    const line: InvoiceDraftLine = {
      ...stored,
      ...common,
      listPrice: unitLine ? unitLine.listPrice : opt.listPrice,
    };
    if (!typed) {
      line.unitPrice = unitLine ? unitLine.price : opt.price;
      line.priceType = unitLine
        ? unitLine.priceType
        : opt.price !== opt.listPrice
          ? "SPECIAL"
          : "STANDARD";
      delete line.priceEdited;
    }
    return { line, updated: !typed && line.unitPrice !== stored.unitPrice };
  }

  const line: InvoiceDraftLine = {
    ...stored,
    ...common,
    unit: typeof product.unit === "string" && product.unit ? product.unit : (stored.unit ?? "each"),
    listPrice: fresh.listPrice,
  };
  // The server splits boxes / pieces with the LIVE pack size, so the line follows it (same units, re-split).
  const liveUpb = Number(product.unitsPerBox) > 1 ? Number(product.unitsPerBox) : undefined;
  if (liveUpb !== stored.unitsPerBox) {
    if (liveUpb === undefined) {
      delete line.unitsPerBox;
      delete line.boxes;
      delete line.pieces;
    } else {
      const n = normalizeBoxesPieces({ qty: stored.qty, unitsPerBox: liveUpb });
      line.unitsPerBox = liveUpb;
      line.boxes = n.boxes ?? 0;
      line.pieces = n.pieces ?? 0;
      line.qty = n.qty;
    }
  }
  if (!typed) {
    line.unitPrice = fresh.effectivePrice;
    line.priceType = fresh.priceType;
    line.isSpecialPrice = fresh.isSpecial || undefined;
    line.regularPrice = fresh.isSpecial ? fresh.listPrice : undefined;
    delete line.priceEdited;
  }
  if (line.isSpecialPrice === undefined) delete line.isSpecialPrice;
  if (line.regularPrice === undefined) delete line.regularPrice;
  return { line, updated: !typed && line.unitPrice !== stored.unitPrice };
}

export async function checkDraftReferences(
  snapshot: InvoiceDraftSnapshot,
  get: Get,
  /** S19b: `pricesV2` = flag.units_prices_v2 is on. Off (the default) fires no price-layer request and changes nothing. */
  opts?: { pricesV2?: boolean },
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
  // Only a 403 (the plan flag is off) means "no rows". Any other failure leaves customer prices unknown.
  let rowsUnknown = false;
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
    } catch (err) {
      const st = (err as { response?: { status?: number } } | null)?.response?.status;
      if (st !== 403) rowsUnknown = true;
    }
  }

  // S19b: the customer layer (billing's own resolved rows). A failed read means the prices are UNCONFIRMED: such lines
  // are kept as stored and counted unchecked, never re-priced at the tier.
  let layerProducts: Record<string, CustomerLayerUnit[]> | undefined;
  let layerComplete = true;
  let layerUnknown = false;
  if (opts?.pricesV2 && customer) {
    try {
      const res = await get(`/customers/${encodeURIComponent(customer.id)}/price-layer`);
      const d = res?.data as
        { complete?: boolean; products?: Record<string, CustomerLayerUnit[]> } | undefined;
      if (d && d.products && typeof d.products === "object") {
        layerProducts = d.products;
        layerComplete = d.complete !== false;
      } else {
        layerUnknown = true;
      }
    } catch {
      layerUnknown = true;
    }
  }

  const productById = new Map<string, unknown>();
  productIds.forEach((id, i) => {
    const r = productRes[i];
    if (r.status === "fulfilled") productById.set(id, r.value?.data);
  });
  // The ladder is read only for products that have a unit-level line.
  const unitProductIds = [
    ...new Set(
      snapshot.lines
        .filter((l) => l.unitLabel && l.productId && productById.has(l.productId))
        .map((l) => l.productId as string),
    ),
  ];
  const ladders = new Map<string, UnitLadder>();
  await Promise.all(
    unitProductIds.map(async (id) => {
      try {
        const res = await get(`/products/${encodeURIComponent(id)}/units`);
        ladders.set(
          id,
          Array.isArray(res?.data)
            ? { kind: "ok", levels: res.data as ProductUnitLevel[] }
            : { kind: "unchecked" },
        );
      } catch (err) {
        ladders.set(id, isGone(err) ? { kind: "gone" } : { kind: "unchecked" });
      }
    }),
  );
  let pricesUpdated = 0;
  let unitsDropped = 0;
  let pricesUnchecked = 0;
  const lines: InvoiceDraftLine[] = [];
  for (const l of snapshot.lines) {
    if (l.productId && gone.has(l.productId)) continue;
    if (!l.productId) {
      lines.push(l); // free-text line
      continue;
    }
    const layerMissing =
      !!opts?.pricesV2 &&
      !!customer &&
      (layerUnknown ||
        (!layerComplete &&
          !Object.prototype.hasOwnProperty.call(layerProducts ?? {}, l.productId)));
    if (!productById.has(l.productId) || ((rowsUnknown || layerMissing) && !l.priceEdited)) {
      // The product (or this customer's price rows) could not be read: keep the line as stored and say so.
      if (!l.priceEdited) pricesUnchecked += 1;
      lines.push(l);
      continue;
    }
    const r = repriceLine(l, productById.get(l.productId), {
      customerTier,
      customerPrice: customerPrice[l.productId],
      lineTier: lineTier[l.productId] ?? customerTier,
      ladder: ladders.get(l.productId),
      layer: layerProducts?.[l.productId],
    });
    if (r.unitDropped) unitsDropped += 1;
    if (r.unchecked) pricesUnchecked += 1;
    if (r.updated) pricesUpdated += 1;
    if (r.line) lines.push(r.line);
  }
  return {
    snapshot: { ...snapshot, customer, lines },
    droppedLines: snapshot.lines.length - lines.length - unitsDropped,
    customerCleared,
    pricesUpdated,
    unitsDropped,
    pricesUnchecked,
  };
}
