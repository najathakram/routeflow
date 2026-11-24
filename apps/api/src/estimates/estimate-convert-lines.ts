import { BadRequestException } from "@nestjs/common";
import { packFromOwnSplit, roundMoney } from "@routeflow/pricing";
import { decideTierOverride } from "../orders/staff-override";
import type { LineOverrideCtx } from "../invoices/invoice-line-override";
import type { ManualLineItem } from "../invoices/manual-invoice-lines";
import { tenantTodayDay } from "../common/calendar-date";

/** The EstimateItem fields the conversion reads. */
export interface ConvertibleEstimateItem {
  description: string;
  productId: string | null;
  qty: unknown;
  unitPrice: unknown;
  subtotal: unknown;
  boxes: number | null;
  pieces: number | null;
  unitLabel?: string | null;
  unitsPerBox?: number | null;
}

/**
 * The box size an estimate line was QUOTED with (B659), never the live product's:
 *   1. the line's own `unitsPerBox` snapshot, whenever one was RECORDED at all — including a
 *      degenerate value <= 1 (SA-095: "1" genuinely means "no packaging", not "unknown"; a
 *      recorded value is a known fact, never conflated with "nothing recorded");
 *   2. else, for a line with boxes, EXACTLY derived from its own split via the shared
 *      `packFromOwnSplit` (an estimate stores `qty = boxes x pack + pieces`, so `(qty - pieces) /
 *      boxes`, accepted only when it is an integer greater than 1 — older estimates stored boxes
 *      but no pack);
 *   3. else null (nothing recorded and nothing derives).
 *
 * A caller that needs to know whether the value is USABLE for box math (`normalizeBoxesPieces`,
 * which only fires above 1) checks `pack > 1` itself — this function's own return no longer
 * implies that on its own.
 */
export function estimateLinePack(item: ConvertibleEstimateItem): number | null {
  if (item.unitsPerBox != null) return Number(item.unitsPerBox);
  return packFromOwnSplit({
    qty: Number(item.qty),
    boxes: item.boxes,
    pieces: item.pieces,
  });
}

/**
 * An accepted estimate's lines as `buildManualInvoiceLines` input, so the invoice is built through the SAME
 * path as an interactive invoice (levy, unit resolution, ledger snapshot) at the sale-date rate, on the
 * QUOTED price. A product line with a box split whose pack cannot be established refuses the conversion
 * (never the live pack): the caller runs this before reserving an invoice number.
 *
 * `packSnapshot` (B659) carries the line's own QUOTED pack unconditionally — not only for a box split. A
 * NO-SPLIT line (plain qty, no boxes/pieces) on a product quoted at a known box size still needs that same
 * pack for the per-piece levy basis (manual-invoice-lines.ts's `upbForPieces`) AND for the regulated
 * ledger's `packAtSale` (SA-095(b): stored back onto the built line's own `unitsPerBox`, which
 * `toSaleLedgerLines`/`applyPriceAdjustment` actually read — never the live product's, so
 * `estimateLinePack` runs for every line and the pack-unknown refusal below stays scoped to an actual split.
 *
 * A 0/0 "split" is NO split (B659 review finding 6): `boxes`/`pieces` are only ever forwarded when at
 * least one is genuinely positive. Forwarding a stray `boxes: 0, pieces: 0` would make
 * `buildManualInvoiceLines` run `normalizeBoxesPieces` on a boxed product and collapse the line's qty
 * to 0 pieces instead of leaving it as a plain qty line.
 *
 * When there IS a genuine split (boxes or pieces positive) and the recorded/derived pack is not USABLE
 * for box math (null, or a real but degenerate value <= 1), the line's OWN recorded `unitsPerBox` (never
 * the live product's) decides what happens next — three cases (B659 review round 2):
 *   1. A pack WAS recorded (even if <= 1, a degenerate, not-really-boxed "pack"): not a real box split at
 *      all — forward `packSnapshot` (the recorded value) but NO `boxes`/`pieces` at all, so
 *      `buildManualInvoiceLines` never runs its own SA-077(2) `unpackableSplit` refusal for this shape (it
 *      only fires when boxes/pieces are present) — the same rule as manual-invoice-lines.ts's finding-7
 *      fix. A web-created line with `unitsPerBox: 1` (estimates/page.tsx sends `boxes: N, pieces: 0`
 *      whenever a pack is set, including 1) must convert, not refuse forever (HIGH finding).
 *   2. Nothing was recorded AND `boxes` is not positive (all the quantity already sits in `pieces` — e.g.
 *      a legacy "0 boxes + 6 pieces" line): Senior Architect ruling SA-095(c) — convert WITHOUT a pack.
 *      `qty` is already the piece count (the levy basis is pieces = qty), and the money is the estimate
 *      line's OWN stored `subtotal`, copied verbatim as the agreed quote price and NEVER recomputed (a
 *      discount already baked into that subtotal can't be reconstructed from qty x unitPrice). boxes/pieces
 *      are a literal snapshot, never re-split; unitsPerBox stays null, never a derived value. Safe only
 *      because there are no whole boxes to lose: reinterpreting a REAL positive box count as pure pieces
 *      would silently drop quantity.
 *   3. Nothing was recorded AND `boxes` IS positive: genuinely unrecoverable — there is no safe reading of
 *      what those boxes were worth, and there is no estimate-update endpoint to fix the line in place.
 *      Refuses; the only remedy is a fresh estimate.
 *
 * `unitLabel` is never forwarded: a unit-aware estimate line is refused by the caller's pre-flight
 * (`assertNoUnitAwareLines`, run before this) — estimates cannot originate a unit-aware invoice line.
 */
export function estimateConvertLineItems(
  items: readonly ConvertibleEstimateItem[],
  lineTaxRate: number,
): ManualLineItem[] {
  return items.map((i, index) => {
    const hasSplit = i.productId != null && (Number(i.boxes ?? 0) > 0 || Number(i.pieces ?? 0) > 0);
    const pack = estimateLinePack(i);
    const packUsable = pack != null && pack > 1;

    if (hasSplit && !packUsable) {
      if (pack != null) {
        // Case 1: a REAL pack was recorded, just degenerate (<= 1) — not really boxed.
        return {
          description: i.description,
          productId: i.productId ?? undefined,
          qty: Number(i.qty),
          unitPrice: Number(i.unitPrice),
          discount: 0,
          taxRate: lineTaxRate,
          packSnapshot: pack,
        } as ManualLineItem;
      }
      if (Number(i.boxes ?? 0) <= 0) {
        // Case 2 (Senior Architect ruling SA-095(c)): 0 (or unset) boxes + genuine pieces, no
        // recorded or derivable pack. `subtotalSnapshot` tells buildManualInvoiceLines to copy the
        // money verbatim instead of recomputing it, and to snapshot boxes/pieces literally instead
        // of re-splitting them.
        return {
          description: i.description,
          productId: i.productId ?? undefined,
          qty: Number(i.qty),
          unitPrice: Number(i.unitPrice),
          boxes: 0,
          pieces: Number(i.pieces ?? 0),
          discount: 0,
          taxRate: lineTaxRate,
          packSnapshot: null,
          subtotalSnapshot: Number(i.subtotal),
        } as ManualLineItem;
      }
      // Case 3: a genuine positive box count with no way to know how many pieces each held. No
      // estimate-update endpoint exists to fix the line in place — the only remedy is a fresh one.
      throw new BadRequestException(
        `pack unknown for line ${index + 1}: void this estimate and create a new one`,
      );
    }

    return {
      description: i.description,
      productId: i.productId ?? undefined,
      qty: Number(i.qty),
      unitPrice: Number(i.unitPrice),
      boxes: hasSplit ? (i.boxes ?? undefined) : undefined,
      pieces: hasSplit ? (i.pieces ?? undefined) : undefined,
      discount: 0,
      taxRate: lineTaxRate,
      packSnapshot: pack,
    } as ManualLineItem;
  });
}

/**
 * SA-1260 section 1: the day the customer accepted the quote, as the tenant's calendar day (YYYY-MM-DD in the
 * tenant's zone, never the UTC date: an evening acceptance must not read as the next day). `Estimate` has no
 * `acceptedAt` column and SA-1182 K2 rules out a migration, so the date is `updatedAt` read at the convert
 * pre-flight, BEFORE the CONVERTED claim moves it; only an ACCEPTED row is read that way (accept() writes
 * nothing for a repeat accept, so it stays the first acceptance). null for any other status.
 * If an `acceptedAt` column is ever added, it replaces this one function body. The invoice PDF's own date
 * formatter (invoices/invoice-pdf-template.tsx:205) is UTC-anchored and takes no zone, so it cannot serve
 * an instant; this is the ISO form of SA-1260 G9.
 */
export function estimateAcceptedOn(
  existing: { status: string; updatedAt: Date },
  timezone: string | null | undefined,
): string | null {
  if (existing.status !== "ACCEPTED") return null;
  return tenantTodayDay(timezone, existing.updatedAt);
}

/**
 * W-1266 / SA-1182 K2: a converted line's QUOTED price judged again by the one staff-override rule
 * (`decideTierOverride` -> `decideStaffOverride`, @routeflow/pricing) against the customer's price TODAY (tier or
 * customer layer, the same baseline POST /invoices uses). A real override (DISCOUNTED or MANUAL) stamps the built
 * line: `priceType`, `originalPrice` (the list price), `overrideReason` and `overriddenBy` (the converting user).
 * A price at the customer's own price, a line with no catalog product, and a layer echo (not a staff override) get
 * no stamp. Only the four price columns are written: `unitPrice` and `subtotal` stay the quote's (B659). Convert
 * is a copy site: it never asks the price-edit right (SA-1034 rule 4), so this only reads.
 */
export function stampConvertedLinePrices(
  itemsData: Array<Record<string, unknown>>,
  lines: ReadonlyArray<{ productId?: string | null; unitPrice: number }>,
  productMap: ReadonlyMap<string, any>,
  ctx: Pick<LineOverrideCtx, "tierOf" | "layerOf"> & { reason: string; actorId: string | null },
): void {
  lines.forEach((line, idx) => {
    const product = line.productId ? productMap.get(line.productId) : undefined;
    if (!product) return;
    // The accepted quote is the reason (SA-1182 K2), so the decision is never refused for a missing one.
    const d = decideTierOverride(
      product,
      ctx.tierOf(product.id),
      roundMoney(line.unitPrice),
      ctx.reason,
      ctx.layerOf?.(product, null),
    );
    if (!d.overridden) return; // the customer's own price, or a layer echo: no stamp
    Object.assign(itemsData[idx], {
      priceType: d.priceType,
      originalPrice: d.originalPrice == null ? null : roundMoney(d.originalPrice),
      overrideReason: ctx.reason,
      overriddenBy: ctx.actorId,
    });
  });
}
