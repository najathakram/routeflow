import { isSpecialTier, PIECE_LABEL } from "@routeflow/pricing";
import { API_ERROR_CODES } from "@routeflow/types";
import {
  applyUnitToLines,
  keepsDefaultStart,
  mergeResolvedLines,
  pendingCount,
  type DefaultUnitLine,
  type UnitFold,
} from "@/lib/default-unit-line";
import { sameProductUnit, type PackBase, type UnitLine } from "@/lib/order-line-unit";
import type { OrderLineUnitPickerLine } from "@/components/OrderLineUnitPicker";
import type { UnitOption } from "@/lib/unit-options";
import type { CustomerLayerUnit } from "@routeflow/pricing";
import type { SaleLinePricing } from "@/lib/sale-line-pricing";
import { codedToastCopy } from "@/lib/generic-toast-copy";
import { bumpInvoiceLine } from "../invoice-scan-level";

/**
 * VU-4a (B1218): the ONE place the new-invoice line (`LineItemState` in page.tsx) is mapped to and from
 * the shared unit-line shape (`UnitLine` / `DefaultUnitLine`, lib/order-line-unit + lib/default-unit-line).
 * No pricing logic lives here: levels go through `applyUnitToLines` / `applyLineUnit`, money through
 * `@routeflow/pricing` in page.tsx's `toTotalsLine`.
 *
 * Box and Piece are BOTH the pack line (D1): Box is Case mode (boxes + loose pieces), Piece is Unit mode
 * (a total piece count, normalised, prorated by `computeLineSubtotal`). Only a LEVEL (factor > 1) is a
 * unit line carrying a `unitLabel`; the label "Piece" is never stored or sent.
 */

/** The invoice line fields this module reads/writes (structurally satisfied by page.tsx's LineItemState). */
export interface InvoiceUnitFields {
  key: string;
  productId?: string;
  description: string;
  qty: number;
  unitPrice: number;
  regularPrice?: number;
  isSpecialPrice?: boolean;
  avgCost?: number;
  unitsPerBox?: number;
  boxes?: number;
  pieces?: number;
  sellBy?: "case" | "unit";
  pricing?: SaleLinePricing;
  overrideReason?: string;
  // ── VU-4a ──
  /** The pack's label ("Box"). */
  unit?: string;
  /** The catalog price a typed price is compared against: the pack's, or the unit's tier-1 price. */
  listPrice?: number;
  priceType?: PackBase["priceType"];
  tierPrices?: UnitLine["tierPrices"];
  packBase?: PackBase;
  /** Set ONLY on a level line; never "Piece". */
  unitLabel?: string;
  /** What the pack line showed before a level replaced it: restored with the pack. */
  packDisplay?: { regularPrice?: number; isSpecialPrice?: boolean; pricing?: SaleLinePricing };
  /** Piece mode (a pack line): the ladder's Piece option value + its per-piece price, for display only. */
  pieceUnit?: string;
  pieceUnitPrice?: number;
  startOnDefaultUnit?: boolean;
  pendingTaps?: number;
  priceEdited?: boolean;
}

type View<T extends InvoiceUnitFields> = T &
  DefaultUnitLine & { unit: string; listPrice: number; priceType: PackBase["priceType"] } & {
    unitCost?: number;
    isUnlisted?: boolean;
  };

/** The shared-helper view of an invoice line. Extra invoice fields ride along untouched. */
export function toUnitLine<T extends InvoiceUnitFields>(
  it: T,
  opts: { dropTierPrices?: boolean } = {},
): View<T> {
  return {
    ...it,
    tempId: it.key,
    productId: it.productId ?? "",
    isUnlisted: !it.productId,
    unit: it.unit || "each",
    listPrice: it.listPrice ?? it.unitPrice,
    priceType: it.priceType ?? "STANDARD",
    unitCost: it.avgCost,
    ...(opts.dropTierPrices ? { tierPrices: undefined } : {}),
  } as View<T>;
}

const UNIT_KEYS = [
  "unitLabel",
  "packBase",
  "qty",
  "boxes",
  "pieces",
  "unitsPerBox",
  "sellBy",
  "unitPrice",
  "priceType",
  "listPrice",
  "unit",
  "startOnDefaultUnit",
  "pendingTaps",
  "priceEdited",
] as const;

/**
 * Back to an invoice line after a shared helper rewrote the view. When the unit CHANGED (a pick, the default
 * start, a tier refresh) the display and the sale-basis override inputs are recomputed from the view: the
 * view's `unitPrice` is the option's price and its `listPrice` the unit's tier-1 price (applyLineUnit).
 */
export function fromUnitLine<T extends InvoiceUnitFields>(
  orig: T,
  v: View<T>,
  tierOf: (productId: string) => number,
): T {
  const next = { ...orig } as unknown as Record<string, unknown>;
  for (const k of UNIT_KEYS) next[k] = (v as unknown as Record<string, unknown>)[k];
  next.avgCost = v.unitCost;
  const changed = v.unitLabel !== orig.unitLabel || v.unitPrice !== orig.unitPrice;
  if (v.unitLabel && changed) {
    // a level line: the price pre-filled from the ladder is the tier price this line is judged against (D9)
    const off = v.unitPrice !== v.listPrice;
    next.pricing = {
      tierPrice: v.unitPrice,
      listPrice: v.listPrice,
      isSpecialTier: isSpecialTier(tierOf(orig.productId ?? "")),
    };
    next.isSpecialPrice = off;
    next.regularPrice = off ? v.listPrice : undefined;
    next.overrideReason = undefined;
    next.priceEdited = false;
    next.packDisplay =
      orig.packDisplay ??
      (orig.unitLabel
        ? undefined
        : {
            regularPrice: orig.regularPrice,
            isSpecialPrice: orig.isSpecialPrice,
            pricing: orig.pricing,
          });
  } else if (orig.unitLabel) {
    // back on the pack: its own display, exactly as it was
    next.regularPrice = orig.packDisplay?.regularPrice;
    next.isSpecialPrice = orig.packDisplay?.isSpecialPrice;
    next.pricing = orig.packDisplay?.pricing;
    next.packDisplay = undefined;
    next.overrideReason = undefined;
  }
  return next as unknown as T;
}

const consume = <T extends InvoiceUnitFields>(it: T): T => ({
  ...it,
  startOnDefaultUnit: false,
  pendingTaps: undefined,
});

/**
 * The operator picked `option` on line `key`. A level goes through `applyUnitToLines` (qty 1, `unitLabel`,
 * the ladder price pre-filled, a twin of the same product + unit absorbs it). Box restores the pack snapshot
 * exactly (a customer-special pack price included: the view has no tier columns, so nothing re-prices it).
 * Piece stays a PACK line in Unit mode (D1): never a `unitLabel`, never per-piece price x qty.
 */
export function chooseUnit<T extends InvoiceUnitFields>(
  items: T[],
  key: string,
  option: UnitOption,
  refresh: boolean,
  tierOf: (productId: string) => number,
): T[] {
  const target = items.find((i) => i.key === key);
  if (!target) return items;
  const tier = tierOf(target.productId ?? "");
  const byKey = new Map(items.map((i) => [i.key, i]));
  const run = (list: T[], opt: UnitOption, keepTierPrices: boolean, refreshing: boolean): T[] => {
    const views = list.map((i) => toUnitLine(i, { dropTierPrices: !keepTierPrices }));
    return applyUnitToLines(views, key, opt, refreshing, tier).map((v) => {
      const orig = byKey.get(v.tempId)!;
      // dropped tier columns are put back from the original
      return { ...fromUnitLine(orig, v, tierOf), tierPrices: orig.tierPrices };
    });
  };
  if (option.kind === "level") return run(items, option, true, refresh);

  const packUpb = target.packBase?.unitsPerBox ?? target.unitsPerBox ?? 0;
  const piece = option.kind === "piece" && packUpb > 1;
  if (piece && refresh && !target.unitLabel) {
    // a tier refresh of the Piece option: only the informational per-piece price moves
    return items.map((i) => (i.key === key ? { ...i, pieceUnitPrice: option.price } : i));
  }
  // Box / Piece: leave a level line first (restoring the pack snapshot verbatim)
  let list = items;
  const wasLevel = !!target.unitLabel;
  if (wasLevel) {
    const packOption: UnitOption = { ...option, value: "", kind: "pack" };
    list = run(items, packOption, false, false);
    byKey.clear();
    list.forEach((i) => byKey.set(i.key, i));
  }
  return list.map((i) => {
    if (i.key !== key) return i;
    const done = consume(i);
    if (!piece)
      return { ...done, sellBy: "case" as const, pieceUnit: undefined, pieceUnitPrice: undefined };
    return {
      ...done,
      sellBy: "unit" as const,
      pieceUnit: option.value,
      pieceUnitPrice: option.price,
      ...(wasLevel ? { boxes: 0, pieces: 1, qty: 1 } : {}),
    };
  });
}

/**
 * What `OrderLineUnitPicker` is fed. A pack line in Piece mode is shown as "Piece" at the Piece option's price
 * (information only); the stored line keeps its unitsPerBox + BOX price and no unitLabel.
 */
export function pickerLineOf(it: InvoiceUnitFields): OrderLineUnitPickerLine {
  const pieceMode = !it.unitLabel && it.sellBy === "unit" && (it.unitsPerBox ?? 0) > 1;
  return {
    productId: it.productId ?? "",
    productName: it.description,
    isUnlisted: !it.productId,
    unit: it.unit || "each",
    unitsPerBox: it.unitsPerBox,
    listPrice: it.listPrice ?? it.unitPrice,
    unitPrice: pieceMode ? (it.pieceUnitPrice ?? it.unitPrice) : it.unitPrice,
    priceType: pieceMode ? "STANDARD" : (it.priceType ?? "STANDARD"),
    qty: it.qty,
    unitLabel: pieceMode ? (it.pieceUnit ?? PIECE_LABEL) : it.unitLabel,
    packBase: it.packBase,
    tierPrices: it.tierPrices,
    priceEdited: it.priceEdited,
  };
}

/**
 * The layer rows the unit picker may use for this line. A unit line with no pack snapshot (an old or corrupt draft) gets
 * none: with no snapshot the picker reads the line's own unit as the pack, so its unit would take the PACK's layer price.
 */
export function pickerLayerFor(
  it: InvoiceUnitFields,
  rows: readonly CustomerLayerUnit[] | null | undefined,
): readonly CustomerLayerUnit[] | undefined {
  if (!rows) return undefined;
  return it.unitLabel && !it.packBase ? undefined : rows;
}

/** A typed price: shapes the line (consumes the default start, survives a tier refresh: #2381). */
export function withTypedPrice<T extends InvoiceUnitFields>(it: T, unitPrice: number): T {
  return { ...consume(it), unitPrice, priceEdited: true, priceType: "MANUAL" };
}

/** Lines still waiting for their default unit (the shared predicate over the views). */
export const unitViews = <T extends InvoiceUnitFields>(items: T[]): Array<View<T>> =>
  items.map((i) => toUnitLine(i));

/** Fold the resolver's answer back without overwriting what the operator did meanwhile. */
export function mergeResolvedInvoiceLines<T extends InvoiceUnitFields>(
  cur: T[],
  before: T[],
  done: Array<View<T>>,
  folds: ReadonlyArray<UnitFold<View<T>>>,
  tierOf: (productId: string) => number,
): T[] {
  const merged = mergeResolvedLines(
    cur.map((i) => toUnitLine(i)),
    before.map((i) => toUnitLine(i)),
    done,
    folds,
  );
  const byKey = new Map(cur.map((i) => [i.key, i]));
  return merged.map((v) => fromUnitLine(byKey.get(v.tempId)!, v, tierOf));
}

/** Run a hook-style `(prev views) => views` updater over invoice lines. */
export function updateViews<T extends InvoiceUnitFields>(
  prev: T[],
  fn: (views: Array<View<T>>) => Array<View<T>>,
  tierOf: (productId: string) => number,
): T[] {
  const byKey = new Map(prev.map((i) => [i.key, i]));
  return fn(prev.map((i) => toUnitLine(i))).map((v) =>
    fromUnitLine(byKey.get(v.tempId) ?? (v as unknown as T), v, tierOf),
  );
}

/**
 * A second add of a product that is already on the invoice, as a PACK line (the unit-aware path; flag-off
 * keeps page.tsx's own `findIndex(productId)`): a default-start tap on a still-pending line records one more tap,
 * anything else bumps the pack line by a case / piece and consumes the flag. Null = refuse (a scan of a different
 * level while the default unit is still loading).
 */
export function mergeIntoPackLine<T extends InvoiceUnitFields>(
  it: T,
  scanLevel: Parameters<typeof bumpInvoiceLine>[1],
  dfltStart: boolean,
): T {
  const view = toUnitLine(it);
  if (keepsDefaultStart(view, dfltStart)) return { ...it, pendingTaps: pendingCount(view) + 1 };
  return consume(bumpInvoiceLine(it, scanLevel));
}

export const matchesPackLine = (
  it: Pick<InvoiceUnitFields, "productId" | "unitLabel">,
  productId: string,
): boolean =>
  sameProductUnit({ productId: it.productId ?? "", unitLabel: it.unitLabel }, { productId });

/** The wire fields of a line's unit: present only on a level line (never "Piece"). */
export const unitPayload = (it: { unitLabel?: string }): { unitLabel?: string } =>
  it.unitLabel ? { unitLabel: it.unitLabel } : {};

/**
 * Sale basis: the server prices a unit line from the ladder at the customer's tier and treats a typed price
 * below the unit's tier-1 price as DISCOUNTED, above as MANUAL. So `unitPrice` is sent only when the operator
 * moved it off the picked option's price (D9: `pricing.tierPrice`). A pack line always sends it, as today.
 */
export function saleUnitPriceField(it: InvoiceUnitFields): { unitPrice?: number } {
  const picked = it.unitLabel ? it.pricing?.tierPrice : undefined;
  return picked != null && Number(it.unitPrice) === picked
    ? {}
    : { unitPrice: Number(it.unitPrice) };
}

/** A UNIT_NOT_OFFERED refusal: the toast description; null for any other error (the generic text stays). */
export function unitRefusalCopy(err: unknown): string | null {
  const code = (err as { response?: { data?: { code?: string } } } | null)?.response?.data?.code;
  return code === API_ERROR_CODES.UNIT_NOT_OFFERED ? codedToastCopy(err) : null;
}

/** The product ids of the lines sold by a unit (their ladder cache is stale after a refusal). */
export const unitProductIds = (items: InvoiceUnitFields[]): string[] => [
  ...new Set(items.filter((i) => i.unitLabel && i.productId).map((i) => i.productId!)),
];
