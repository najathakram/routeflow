import type { CreateInvoiceDto } from "./dto/create-invoice.dto";
import type { ResolvedLineUnits } from "../products/line-units";
import { isUnitAware } from "../orders/unit-line-build";
import { buildInvoiceUnitLine } from "./invoice-unit-line";
import {
  computeCategoryTax,
  computeLineSubtotal,
  normalizeBoxesPieces,
  roundMoney,
  type CategoryTaxType,
} from "@routeflow/pricing";

/**
 * The line builder of `InvoicesService.create()` (a manual invoice), lifted VERBATIM into its own file
 * (units_v1 step 4c-1 prefactor: `invoices.service.ts` sits exactly at its size ratchet and create()
 * must grow to sell by a unit). Behaviour identical: the only edits are `this.clampLineFreeUnits` ->
 * the injected `clampFreeUnits`, `this.prisma.getTenantId()` -> the injected `tenantId`, and the
 * running subtotal returned instead of closed over.
 */
/**
 * A line to build. `packSnapshot` (B659) is the box size an EXISTING line was priced with (an estimate line
 * converted to an invoice): when set it replaces the LIVE product's `unitsPerBox` for the box split, so a
 * pack change since the quote cannot re-prorate the agreed subtotal. Absent = the live pack (a NEW line).
 */
export type ManualLineItem = CreateInvoiceDto["items"][number] & { packSnapshot?: number | null };

export function buildManualInvoiceLines(
  items: ManualLineItem[],
  ctx: {
    productMap: ReadonlyMap<string, any>;
    categoryMap: ReadonlyMap<string, any>;
    tenantId: string | null | undefined;
    clampFreeUnits: (free: number | undefined, boxes: number | null, qty: number) => number;
    /** units_v1: `resolveLineUnits` per item, index-aligned with `items` (the caller resolves). */
    resolved?: ReadonlyArray<ResolvedLineUnits>;
  },
) {
  const { productMap, categoryMap, tenantId, clampFreeUnits, resolved } = ctx;
  let subtotal = 0;
  const itemsData = items.map((item, index) => {
    const product = item.productId ? productMap.get(item.productId) : undefined;
    // units_v1 (4c-1): a non-pack unit is built from the SERVER ladder's factor; the pack falls
    // through to the unchanged branch below.
    const unitResolution = resolved?.[index];
    if (product && unitResolution && isUnitAware(unitResolution)) {
      const category = product.trackedCategoryId
        ? categoryMap.get(product.trackedCategoryId)
        : null;
      const unitLine = buildInvoiceUnitLine({
        item,
        product,
        resolved: unitResolution,
        category,
        tenantId,
      });
      subtotal += unitLine.subtotal;
      return unitLine;
    }
    let qty = item.qty;
    let boxes: number | null = null;
    let pieces: number | null = null;
    let unitsPerBox: number | undefined;
    if (item.productId && (item.boxes != null || item.pieces != null)) {
      const pack = item.packSnapshot ?? product?.unitsPerBox;
      // B659 (review finding 7): truthy, not `> 1`, let a pack of 1 through — `normalizeBoxesPieces`
      // itself only does box math when unitsPerBox > 1 (its own `hasBoxPackaging` gate) and otherwise
      // falls back to an `input.qty` this caller never passes, so a pack-1 product's split silently
      // zeroed to qty 0 / $0. Match normalizeBoxesPieces's own threshold so a pack of 1 (or 0) skips
      // the split entirely and the line's original qty survives untouched.
      if (Number(pack) > 1) {
        unitsPerBox = pack;
        // Force integer boxes/pieces and roll pieces >= unitsPerBox into boxes.
        const split = normalizeBoxesPieces({
          boxes: item.boxes,
          pieces: item.pieces,
          unitsPerBox,
        });
        boxes = split.boxes;
        pieces = split.pieces;
        qty = split.qty;
      }
    }
    // BUY_N_GET_M: free whole selling units come off the subtotal BEFORE pricing
    // (never a rounded net unit price). 0 for every other line.
    const freeUnits = clampFreeUnits(item.promoFreeUnits, boxes, qty);
    const beforeDiscount = computeLineSubtotal({
      unitPrice: item.unitPrice,
      qty,
      boxes,
      pieces,
      unitsPerBox,
      freeUnits,
    });
    const lineSub = roundMoney(beforeDiscount - (item.discount ?? 0));
    subtotal += lineSub;
    // RF-4: per-line regulated category tax on the NET (post-discount) sale — the
    // same basis as the regular line tax. Piece count is the basis for per-unit
    // levies; a boxed selling-unit line expands via the product's box size.
    const category = product?.trackedCategoryId ? categoryMap.get(product.trackedCategoryId) : null;
    // B659 (review finding 2): a NO-SPLIT line (boxes == null, so the branch above never ran) still
    // needs the QUOTED pack for its per-piece levy basis, never a live repack — same snapshot the
    // box-split branch above already honours via `pack` (item.packSnapshot ?? product?.unitsPerBox).
    const upbForPieces = Number(item.packSnapshot ?? product?.unitsPerBox ?? 0);
    const pieceQty = boxes != null ? qty : upbForPieces > 1 ? qty * upbForPieces : qty;
    const categoryTaxAmount = category
      ? computeCategoryTax({
          taxType: category.taxType as CategoryTaxType,
          rate: Number(category.rate),
          unitBasisQty: pieceQty,
          lineSubtotal: lineSub,
          priceIncludesTax: category.priceIncludesTax,
        })
      : 0;
    return {
      description: item.description,
      productId: item.productId,
      qty,
      unitPrice: item.unitPrice,
      discount: item.discount ?? 0,
      taxRate: item.taxRate ?? 0,
      subtotal: lineSub,
      boxes,
      pieces,
      // Snapshot the box size when this line was priced as a box split, so a later
      // edit/PDF recompute uses the sale-time size (mirrors order-derived lines).
      unitsPerBox: boxes != null && unitsPerBox ? unitsPerBox : null,
      // BUY_N_GET_M snapshot — stored so the next edit re-prices off it.
      promoFreeUnits: freeUnits > 0 ? freeUnits : null,
      // Snapshot the regulated category/subcategory AT SALE TIME (never re-read the
      // live product later — it may drift), so the ledger and filings attribute this
      // line even if the product is re-classified afterward.
      trackedCategoryId: product?.trackedCategoryId ?? null,
      trackedSubcategoryId: product?.trackedSubcategoryId ?? null,
      // RF-4: per-line category tax snapshot (folded into taxTotal below).
      categoryTaxAmount,
      notes: item.notes ?? null,
      // MSRP snapshot — set below by applyMsrpSnapshots (null when flag.msrp is off).
      msrp: null as number | null,
      tenantId: tenantId, // nested creates bypass forTenant() extension
    };
  });
  return { itemsData, subtotal };
}
