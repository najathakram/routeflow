import { BadRequestException } from "@nestjs/common";
import {
  AmbiguousLineError,
  buildLine,
  categoryTaxSnapshotOf,
  computeCategoryTax,
  roundMoney,
  type CategoryTaxType,
} from "@routeflow/pricing";
import { assertUnitLineSplit } from "../orders/unit-line-split";
import type { ResolvedLineUnits } from "../products/line-units";
import { MAX_LINE_QTY, MAX_LINE_SUBTOTAL } from "../orders/unit-line-build";
import type { CreateInvoiceItemDto } from "./dto/create-invoice.dto";

/**
 * units_v1 4c-1 — ONE manual-invoice line sold by a non-pack unit. Pure: `create()` resolves the unit
 * with `resolveLineUnits` (the ONE place a factor is decided). The PRICE is what staff typed (per
 * unit; the web prefills it from the ladder) — the server decides only the factor. `qty` on the
 * request counts the unit (a whole number); stored like a box-split line whose "box" is the unit:
 * `boxes = count`, `qty = count x factor` (base pieces), `unitsPerBox = factor`, `unitLabel`; a
 * factor-1 unit is per-piece and still snapshots 1. Refused, never guessed: boxes/pieces (the pack's
 * axis), promotions (pack lines only in v1), a fractional or oversize count.
 *
 * B682/SA-145: the count/split/pricing math is `@routeflow/pricing`'s `buildLine` (its `unit` axis)
 * — PR-1 of the buildLine migration, site 1 of 2 (`buildInvoiceItemData` is excluded; it prorates a
 * STORED subtotal and must never recompute from unitPrice). `buildLine`'s `AmbiguousLineError` is
 * mapped to the SAME 400 wording this endpoint already used for a non-whole count — near-zero
 * behaviour change here (this path already refused it), which is exactly why it goes first.
 */
export function buildInvoiceUnitLine(input: {
  item: CreateInvoiceItemDto;
  product: { trackedCategoryId?: string | null; trackedSubcategoryId?: string | null };
  resolved: ResolvedLineUnits;
  category: { taxType: unknown; rate: unknown; priceIncludesTax: boolean } | null | undefined;
  tenantId: string | null | undefined;
}) {
  const { item, product, resolved, category, tenantId } = input;
  const label = resolved.unitLabel;
  if (label == null) throw new Error("buildInvoiceUnitLine needs a unit-aware resolution");
  if ((item.boxes ?? 0) > 0 || (item.pieces ?? 0) > 0 || (item.promoFreeUnits ?? 0) > 0) {
    throw new BadRequestException(
      `A line sold by the ${label} takes a quantity of ${label} units and a price only — leave boxes, pieces and promotions out.`,
    );
  }
  const unitPrice = roundMoney(item.unitPrice); // round every monetary write, as the order path does
  let built;
  try {
    built = buildLine({
      axis: { kind: "unit", label, count: Number(item.qty), factorToBase: resolved.unitsPerBox },
      unitPrice,
    });
  } catch (e) {
    if (e instanceof AmbiguousLineError) {
      throw new BadRequestException(
        `A line sold by the ${label} needs a whole number of ${label}.`,
      );
    }
    throw e;
  }
  const { qty, boxes, pieces, unitsPerBox: factor } = built;
  if (qty > MAX_LINE_QTY) {
    throw new BadRequestException(
      `${item.qty} x ${label} is ${qty.toLocaleString("en-US")} pieces — over the ${MAX_LINE_QTY.toLocaleString("en-US")} a single line can hold.`,
    );
  }
  const lineSub = roundMoney(built.subtotal - (item.discount ?? 0));
  if (lineSub > MAX_LINE_SUBTOTAL) {
    throw new BadRequestException(
      `This line's total is over the ${MAX_LINE_SUBTOTAL} one line can hold.`,
    );
  }
  return assertUnitLineSplit(
    {
      description: item.description,
      productId: item.productId,
      qty,
      unitPrice,
      discount: item.discount ?? 0,
      taxRate: item.taxRate ?? 0,
      subtotal: lineSub,
      boxes,
      pieces,
      unitsPerBox: factor,
      unitLabel: label,
      promoFreeUnits: null as number | null,
      trackedCategoryId: product.trackedCategoryId ?? null,
      trackedSubcategoryId: product.trackedSubcategoryId ?? null,
      // regulated category tax on the NET sale, per-unit levies on the BASE piece count
      categoryTaxAmount: category
        ? computeCategoryTax({
            taxType: category.taxType as CategoryTaxType,
            rate: Number(category.rate),
            unitBasisQty: qty,
            lineSubtotal: lineSub,
            priceIncludesTax: category.priceIncludesTax,
          })
        : 0,
      // B297 (SA-088): the rate trio categoryTaxAmount above was computed from.
      ...categoryTaxSnapshotOf(
        category
          ? {
              taxType: category.taxType as CategoryTaxType,
              rate: category.rate as number | string,
              priceIncludesTax: category.priceIncludesTax,
            }
          : null,
      ),
      notes: item.notes ?? null,
      // MSRP snapshot — set by applyMsrpSnapshots (null when flag.msrp is off).
      msrp: null as number | null,
      tenantId, // nested creates bypass forTenant()
    },
    "buildInvoiceUnitLine",
  );
}
