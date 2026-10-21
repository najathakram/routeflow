/**
 * `InvoicesService.duplicate`'s line copy, moved verbatim out of the service (behaviour-neutral extraction; the
 * invoices.service.ts size ratchet). Each stored line is carried with its already-correct subtotal and snapshots; the
 * NSF fee line is never taxed even when copied (#2656). `tenantId` is the caller's.
 */
import { isNsfLine, roundMoney } from "@routeflow/pricing";

export function duplicateLineData(items: ReadonlyArray<any>, tenantId: string) {
  return items.map((i) => ({
    description: i.description,
    productId: i.productId,
    qty: i.qty,
    unitPrice: i.unitPrice,
    discount: i.discount,
    taxRate: isNsfLine(i) ? 0 : i.taxRate, // #2656: the NSF line is never taxed, even when copied
    boxes: (i as any).boxes ?? null,
    pieces: (i as any).pieces ?? null,
    // The sale-time box size travels with the boxes/pieces: without it the copy depends on the LIVE
    // pack, and a client that rebuilds the line from it re-prices per piece (B644 sibling).
    unitsPerBox: (i as any).unitsPerBox ?? null,
    // Price markers and the per-line note travel too (a copy must not reset DISCOUNTED to STANDARD).
    originalPrice: (i as any).originalPrice != null ? Number((i as any).originalPrice) : null,
    priceType: (i as any).priceType ?? undefined, // undefined -> the schema default (STANDARD)
    overrideReason: (i as any).overrideReason ?? null, // H3b: travels with the override price
    overriddenBy: (i as any).overriddenBy ?? null,
    notes: (i as any).notes ?? null,
    // BUY_N_GET_M snapshot travels with the copy — the subtotal is verbatim, and
    // without the snapshot the copy's first edit would re-price the line to full.
    promoFreeUnits: (i as any).promoFreeUnits ?? null,
    // MSRP is copied VERBATIM, not re-resolved — a duplicate must show what the
    // source line showed, never a live re-read of the (possibly since-changed)
    // product/customer MSRP.
    msrp: (i as any).msrp != null ? Number((i as any).msrp) : null,
    subtotal: roundMoney(Number(i.subtotal)),
    // RF-4/B297: category tax + regulated snapshots (incl. the rate trio) travel to the copy.
    trackedCategoryId: (i as any).trackedCategoryId ?? null,
    trackedSubcategoryId: (i as any).trackedSubcategoryId ?? null,
    categoryTaxAmount: roundMoney(Number((i as any).categoryTaxAmount ?? 0)),
    categoryTaxType: (i as any).categoryTaxType ?? null,
    categoryTaxRate: (i as any).categoryTaxRate != null ? Number((i as any).categoryTaxRate) : null,
    categoryPriceIncludesTax: (i as any).categoryPriceIncludesTax ?? null,
    // #2169 (SA-395): a duplicated NSF fee line is still a real system-written NSF line —
    // carried verbatim, like every other snapshot column above.
    systemKind: i.systemKind ?? null,
    tenantId: tenantId,
  }));
}
