import { API_ERROR_CODES } from "@routeflow/types";
import { PIECE_LABEL, effectiveQty } from "@routeflow/pricing";
import type { LineState } from "./cart-line-state";
import { applyUnitOption } from "./default-unit-line";
import { invoiceLineDto, type InvoiceTotalsLine } from "./invoice-totals";
import type { CreateInvoiceItem } from "./api/invoices";
import type { CreateSaleItemInput } from "./api/orders";
import { isUnitLine, setLineUnits } from "./sale-line";
import { decideTrayPrice, saleLinePriceFields } from "./staff-price-override";
import { unitPriceBase, type UnitOption } from "./unit-options";
import type { UnitPickerLine } from "../components/UnitPickerRow";

/**
 * VU-4b: the staff unit picker on the New-invoice screen. Everything the screen needs beyond Create
 * Order's shared helpers (UnitPickerRow, applyUnitOption, the pending-unit adapter, sale-line) lives
 * HERE, so invoices/new.tsx holds call sites only. Money is @routeflow/pricing's: a pack line is
 * `computeLineSubtotal` proration, a unit (ladder level) line is a whole count at a per-unit price.
 *
 * Three kinds of line, never confused:
 *   - pack (Box): boxes/pieces split of the product's own box, priced per BOX; no unitLabel.
 *   - Piece: ALSO a pack line (sellBy "unit", pieces counted, prorated off the BOX price). It never
 *     carries a unitLabel: routing a boxed Piece through applyUnitOption would bill a ladder Piece
 *     price that differs from the pack proration by cents (the D1 drift the brief forbids).
 *   - level (factor > 1: Case, Pallet...): `unitLabel` + a whole count + a per-unit price; no boxes/pieces.
 */

/** The New-invoice line: Create Order's cart line plus the invoice-only exception fields. */
export type InvoiceLineState = LineState & {
  /** Flat dollars off this line, taken BEFORE tax. */
  discount?: number;
  /** Charged the tenant tax rate at submit. */
  taxable?: boolean;
};

type Upb = number | string | null | undefined;
const packSize = (unitsPerBox: Upb): number => {
  const n = Number(unitsPerBox ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Every unit choice CONSUMES the default-start flag (a later resolve never overrides it). */
const FLAG_CONSUMED = {
  startOnDefaultUnit: undefined,
  pendingTaps: undefined,
  pendingCode: undefined,
} as const;

/**
 * Where the price fields land when a line LEAVES a unit for the pack: a unit line's `unitPrice` is
 * per-unit and means nothing on a box, so it is dropped (a remembered pack price stashed on the way
 * in is restored, exactly as applyUnitOption does). A line already on the pack axis keeps its price.
 */
function packPriceFields(prev: InvoiceLineState) {
  if (!prev.unitLabel) {
    return {
      unitPrice: prev.unitPrice,
      priceSource: prev.priceSource,
      packUnitPrice: prev.packUnitPrice,
    };
  }
  const restore = prev.packUnitPrice != null;
  return {
    unitPrice: restore ? prev.packUnitPrice : undefined,
    priceSource: restore ? ("history" as const) : undefined,
    packUnitPrice: undefined,
  };
}

/**
 * The ONE writer of a picker choice on an invoice line.
 *   - level (factor > 1): applyUnitOption, unchanged. qty 1, unitLabel, unitBasePrice = the option's tier
 *     price, unitFactor; `unitPrice` stays UNSET (the option's price is a lookup, never a typed price).
 *   - Box: one whole box (boxes 1, qty = pack size), sold by "case"; no unit fields.
 *   - Piece on a boxed pack: one loose piece, sold by "unit"; no unit fields, the BOX price untouched.
 *   - a product with no box (pack size <= 1): a plain qty 1.
 */
export function chooseInvoiceUnit(
  prev: InvoiceLineState,
  option: UnitOption,
  unitsPerBox: Upb,
): InvoiceLineState {
  const upb = packSize(unitsPerBox);
  const isPack = option.value === "" || option.kind === "pack";
  const isPiece = !isPack && option.factorToBase === 1;
  if (!isPack && !isPiece) return applyUnitOption(prev, option, unitsPerBox) as InvoiceLineState;

  const base: InvoiceLineState = {
    ...prev,
    ...FLAG_CONSUMED,
    ...packPriceFields(prev),
    unitLabel: undefined,
    unitBasePrice: undefined,
    unitFactor: undefined,
  };
  if (!(upb > 1))
    return { ...base, qty: 1, boxes: undefined, pieces: undefined, sellBy: undefined };
  if (isPiece) return { ...base, sellBy: "unit", boxes: 0, pieces: 1, qty: 1 };
  return { ...base, sellBy: "case", boxes: 1, pieces: 0, qty: upb };
}

/**
 * The line as `UnitPickerRow` reads it. A Piece line stores no unitLabel, so the picker is told
 * "Piece" (it highlights the Piece row and prices the pack option fresh off the ladder).
 */
export function pickerLineOf(
  productId: string,
  line: InvoiceLineState,
  catalogPrice: number,
): UnitPickerLine {
  return {
    productId,
    unitPrice: invoiceLinePrice(line, catalogPrice),
    unitLabel: line.unitLabel ?? (line.sellBy === "unit" ? PIECE_LABEL : undefined),
  };
}

/**
 * The EFFECTIVE price per selling unit: a typed price, else the unit's own tier price (a unit line),
 * else the customer's catalog price (the pack). Per BOX on a pack line, per `unitLabel` on a unit line.
 */
export function invoiceLinePrice(line: InvoiceLineState, catalogPrice: number): number {
  return line.unitPrice != null ? line.unitPrice : unitPriceBase(line, catalogPrice);
}

/**
 * The line as `computeInvoiceTotals` / `saleModeGate` read it. A unit line is a whole count at its
 * per-unit price (boxes, pieces and the pack size all null, so nothing prorates it against the pack);
 * every other line is today's pack proration, unchanged.
 */
export function invoiceTotalsLine(
  line: InvoiceLineState,
  unitsPerBox: Upb,
  catalogPrice: number,
  taxRateFraction: number,
): InvoiceTotalsLine {
  const common = {
    unitPrice: invoiceLinePrice(line, catalogPrice),
    discount: line.discount ?? 0,
    taxRate: line.taxable ? taxRateFraction : 0,
  };
  if (isUnitLine(line)) {
    return { ...common, qty: line.qty, boxes: null, pieces: null, unitsPerBox: null };
  }
  return {
    ...common,
    qty: effectiveQty(line, unitsPerBox as number | null | undefined),
    boxes: line.boxes ?? null,
    pieces: line.pieces ?? null,
    unitsPerBox: (unitsPerBox as number | null | undefined) ?? null,
  };
}

/**
 * One catalog line -> a POST /invoices item. Standalone invoices ALWAYS send the effective price (the
 * server takes unitPrice verbatim there). A unit line carries `unitLabel` and a whole-count qty and
 * NO boxes/pieces; a pack line is byte-for-byte today's.
 */
export function invoiceItemDto(
  line: InvoiceLineState,
  meta: { id: string; description: string },
  catalogPrice: number,
  unitsPerBox: Upb,
  taxRateFraction: number,
): CreateInvoiceItem {
  const t = invoiceTotalsLine(line, unitsPerBox, catalogPrice, taxRateFraction);
  const dto = invoiceLineDto(
    {
      description: meta.description,
      productId: meta.id,
      qty: t.qty,
      unitPrice: t.unitPrice,
      boxes: t.boxes,
      pieces: t.pieces,
      unitsPerBox: t.unitsPerBox,
      discount: line.discount,
      taxable: line.taxable,
      notes: line.note,
    },
    taxRateFraction,
  );
  return isUnitLine(line) ? { ...dto, unitLabel: line.unitLabel as string } : dto;
}

/**
 * One catalog line -> a POST /orders/sell item (the server prices a unit line itself, off the ladder at
 * the customer's tier). A pack line keeps today's payload: the effective price (+ reason off a special
 * price) and the box split. A unit line sends the unit and count; `unitPrice` only when the operator
 * typed one off the unit's own price (>= half a cent), with the reason a special price requires.
 * Sending the tier price blindly would store it as a DISCOUNTED override, so it is never sent.
 * `{ refused: true }` = a price moved off a special price with no reason.
 */
export function saleItemDto(
  line: InvoiceLineState,
  product: { id: string; unitsPerBox?: Upb },
  ctx: { catalogPrice: number; listPrice: number; isSpecial: boolean },
): CreateSaleItemInput | { refused: true } {
  const note = line.note?.trim();
  if (isUnitLine(line)) {
    const d = decideTrayPrice({
      typed: line.unitPrice ?? null,
      base: unitPriceBase(line, ctx.catalogPrice),
      listPrice: ctx.listPrice,
      isSpecial: ctx.isSpecial,
      reason: line.overrideReason,
    });
    if (d.kind === "refused") return { refused: true };
    return {
      productId: product.id,
      qty: line.qty,
      unitLabel: line.unitLabel as string,
      ...(d.kind === "set"
        ? { unitPrice: d.price, ...(d.overrideReason ? { overrideReason: d.overrideReason } : {}) }
        : {}),
      ...(note ? { notes: note } : {}),
    };
  }
  const upb = packSize(product.unitsPerBox);
  const price = saleLinePriceFields({
    effective: invoiceLinePrice(line, ctx.catalogPrice),
    base: ctx.catalogPrice,
    listPrice: ctx.listPrice,
    isSpecial: ctx.isSpecial,
    reason: line.overrideReason,
  });
  if ("refused" in price) return { refused: true };
  return {
    productId: product.id,
    qty: effectiveQty(line, product.unitsPerBox as number | null | undefined),
    ...price,
    ...(upb > 1 && line.boxes != null ? { boxes: line.boxes } : {}),
    ...(upb > 1 && line.pieces != null ? { pieces: line.pieces } : {}),
    ...(note ? { notes: note } : {}),
  };
}

/** The pack option, for resetting a line. */
const PACK_OPTION: UnitOption = {
  value: "",
  label: "",
  factorToBase: 1,
  kind: "pack",
  price: 0,
  listPrice: 0,
};

/**
 * After the server says a unit is no longer offered: every unit-sold line goes back to ONE Box (its
 * per-unit price and count mean nothing against the pack). Lines with no unitLabel, including
 * Piece-as-pack lines, are returned as the SAME object.
 */
export function dropStaleUnitLines<T extends InvoiceLineState>(
  items: Record<string, T>,
  unitsPerBox: (productId: string) => Upb,
): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [id, line] of Object.entries(items)) {
    next[id] = isUnitLine(line)
      ? (chooseInvoiceUnit(line, PACK_OPTION, unitsPerBox(id)) as T)
      : line;
  }
  return next;
}

export const UNIT_NOT_OFFERED_MESSAGE =
  "That unit isn't offered for this product any more. Choose another unit, or ask an admin to add it back.";

/** True when a save failed because a unit was removed from the product's ladder meanwhile. */
export function unitNotOfferedCode(err: unknown): boolean {
  const code = (err as { response?: { data?: { code?: unknown } } } | null | undefined)?.response
    ?.data?.code;
  return code === API_ERROR_CODES.UNIT_NOT_OFFERED;
}

/**
 * Guard for the shared default-unit resolver (which writes through applyUnitOption, untouched): a
 * factor-1 "Piece" flagged as the default on a BOXED product would become a `unitLabel:"Piece"` unit
 * line, billed at the ladder piece price instead of the pack proration (the cent drift this screen
 * forbids). Such a line becomes the piece-as-pack line chooseInvoiceUnit's Piece branch makes: sold by
 * "unit", pieces counted (N default taps = N pieces, rolled into boxes), no unit fields. Everything
 * else, and any product we cannot see, is returned as the SAME object.
 */
export function normalizeInvoiceUnitLines<T extends InvoiceLineState>(
  items: Record<string, T>,
  productFor: (productId: string) => { unitsPerBox?: Upb } | undefined,
): Record<string, T> {
  let out = items;
  for (const [id, line] of Object.entries(items)) {
    if (!isUnitLine(line) || !(Number(line.unitFactor ?? 0) <= 1)) continue;
    const upb = packSize(productFor(id)?.unitsPerBox);
    if (!(upb > 1)) continue;
    const piece = chooseInvoiceUnit(
      line,
      { ...PACK_OPTION, value: PIECE_LABEL, kind: "piece" },
      upb,
    );
    const count = Math.max(1, Math.trunc(line.qty ?? 1));
    const fixed = (count === 1 ? piece : (setLineUnits(piece, count, upb) ?? piece)) as T;
    if (out === items) out = { ...items };
    out[id] = fixed;
  }
  return out;
}
