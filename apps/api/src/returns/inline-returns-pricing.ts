/**
 * Returns Inside Order Creation — PR-1b: pure quote/pricing engine.
 *
 * Matches a requested return quantity against a customer's invoiced sales (the
 * "matching set" — §3.1 of local-assets/handoff/2026-09-15/order-returns/design.md),
 * allocates it across candidate invoice lines newest-first, and prices each resulting
 * chunk per §3.2. Pure: every DB read (candidate invoice lines, prior-returned pieces,
 * tax-exemption, tier/CustomerPrice resolution) is the CALLER's job — this file only
 * does arithmetic, so the 8 §3.5 literal oracles can pin it without a database.
 *
 * Money discipline: every returned subtotal/tax figure is rounded via {@link roundMoney}
 * from `@routeflow/pricing`; the line-subtotal proration itself goes through
 * {@link prorateLineSubtotal} — never re-derived here — so this stays consistent with
 * every other partial-quantity money computation in the codebase.
 */
import {
  computeLineSubtotal,
  normalizeBoxesPieces,
  prorateLineSubtotal,
  roundMoney,
} from "@routeflow/pricing";

export type ReturnPriceSource = "SOURCE_INVOICE" | "CUSTOMER_PRICE" | "TIER" | "BASE" | "MANUAL";

/** One invoice line eligible to be matched against a return — already filtered to the
 * matching set (§3.1: REAL_INVOICE_STATUSES ∪ non-VOID DRAFT of DELIVERED/PARTIALLY_DELIVERED
 * orders, issueDate within the sold window) and sorted NEWEST invoice first by the caller. */
export interface CandidateInvoiceLine {
  sourceOrderId: string;
  sourceInvoiceItemId: string;
  sourceOrderItemId: string | null;
  productId: string;
  /** InvoiceItem.qty — the line's own axis (pieces for a box-split line, selling units
   * otherwise). Used ONLY as the proration axis inside `priceMatchedChunk` — never for
   * pooling/capping (a selling-unit line's `qty` is boxes, not pieces). */
  qty: number;
  /** This line's true piece count — `boxes != null ? qty : qty * (unitsPerBox || 1)`, computed
   * once by the caller. The ONLY field allocation/pooling caps against; mixing it up with `qty`
   * (a selling-unit line's own axis) under-caps a boxed return by a factor of unitsPerBox. */
  piecesQty: number;
  unitPrice: number;
  subtotal: number;
  /** Non-null on a box-split line; null on a "selling-unit" line (§3.2's axis rule). */
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
  /** InvoiceItem.promoFreeUnits — whole free SELLING units, already in the line's own axis. */
  promoFreeUnits: number | null;
  /** InvoiceItem.taxRate snapshot — NEVER the tenant's current rate (oracle: rate change). */
  taxRate: number;
  /** Per-line excise/category-tax snapshot, pro-rated and capped by the caller-supplied ledger cap. */
  categoryTax: number | null;
  invoiceSubtotal: number;
  invoiceDiscount: number;
  /** sourceInvoice.taxAmount — 0 means the invoice charged no tax at all (m-7 guard). */
  invoiceTaxAmount: number;
}

/** A caller-resolved "how much of (sourceOrderId, productId) is still uncredited" map —
 * sold pieces (from the matching-set invoice lines) minus `returnedPiecesByProduct` (PR-1a). */
export interface RemainingSupply {
  sourceOrderId: string;
  productId: string;
  remainingPieces: number;
}

export interface UnreferencedPriceContext {
  /** getTierPrice(product, tier) or a CustomerPrice override, resolved by the caller — the
   * canonical SELLING-UNIT price (one BOX when unitsPerBox > 1, matching @routeflow/pricing's
   * own convention), never a per-piece price. */
  unitPrice: number;
  source: Extract<ReturnPriceSource, "CUSTOMER_PRICE" | "TIER" | "BASE">;
  /** The product's box size, so a boxed product's SELLING-UNIT price is priced against whole
   * boxes (+ prorated loose pieces), never `unitPrice * chunkPieces` directly — that would
   * over-credit a boxed product by a factor of unitsPerBox (CLAUDE.md money discipline). */
  unitsPerBox?: number | null;
}

export interface ManualOverride {
  /** A typed box/piece price — same SELLING-UNIT convention as `UnreferencedPriceContext`. */
  unitPrice: number;
  reason: string;
  overriddenBy: string;
  unitsPerBox?: number | null;
}

/** Prices `chunkPieces` at a SELLING-UNIT rate (one box when `unitsPerBox > 1`, else one piece)
 * via the canonical `computeLineSubtotal` — never `unitPrice * chunkPieces` directly, which
 * would over-credit a boxed product by a factor of unitsPerBox. */
function priceSellingUnitChunk(
  unitPrice: number,
  chunkPieces: number,
  unitsPerBox?: number | null,
): number {
  const normalized = normalizeBoxesPieces({ qty: chunkPieces, unitsPerBox });
  return computeLineSubtotal({
    unitPrice,
    qty: normalized.qty,
    boxes: normalized.boxes,
    pieces: normalized.pieces,
    unitsPerBox,
  });
}

export interface PricedChunk {
  sourceOrderId: string | null;
  sourceInvoiceItemId: string | null;
  sourceOrderItemId: string | null;
  productId: string;
  /** Pieces this chunk covers. */
  pieces: number;
  subtotal: number;
  taxAmount: number;
  categoryTax: number;
  priceSource: ReturnPriceSource;
  /** Display-only per-piece rate implied by this chunk (null when pieces is 0). */
  unitPrice: number | null;
  originalPrice?: number | null;
  overrideReason?: string | null;
  overriddenBy?: string | null;
}

export interface QuoteBreakdown {
  chunks: PricedChunk[];
  subtotal: number;
  taxAmount: number;
  categoryTax: number;
  total: number;
}

// ─── §3.1 matching / allocation ────────────────────────────────────────────────

/** Converts a return-request DTO qty (raw qty, or an explicit boxes/pieces split) into
 * pieces, the SAME rule OrderItem/InvoiceItem storage already uses — `boxes != null` means
 * the DTO qty is already pieces; otherwise multiply by the unitsPerBox snapshot (falling
 * back to the raw qty when no box size is known). */
export function returnRequestPieces(input: {
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
}): number {
  if (input.boxes != null || input.pieces != null) {
    const upb = Number(input.unitsPerBox ?? 0);
    return Math.trunc(Number(input.boxes ?? 0)) * upb + Math.trunc(Number(input.pieces ?? 0));
  }
  const upb = Number(input.unitsPerBox ?? 0);
  return upb > 1 ? Math.trunc(Number(input.qty) * upb) : Math.trunc(Number(input.qty));
}

export interface AllocatedChunk {
  /** null = the unallocated remainder (over-return), priced unreferenced. */
  line: CandidateInvoiceLine | null;
  pieces: number;
}

/**
 * Allocates `requestedPieces` of one product across its candidate lines, newest invoice
 * first (the caller's own sort order), capped per (sourceOrderId, productId) by
 * `remainingByKey`. A line only ever contributes up to its OWN remaining-supply cap for
 * its order — multiple lines from the SAME order share that one remaining figure, drained
 * in the caller's given (newest-line-first) order. Any pieces left over after every
 * candidate line is exhausted become one unallocated chunk (`line: null`) — the over-return.
 */
export function allocateReturnedPieces(
  candidateLines: CandidateInvoiceLine[],
  remainingByKey: RemainingSupply[],
  productId: string,
  requestedPieces: number,
): AllocatedChunk[] {
  const remaining = new Map(
    remainingByKey
      .filter((r) => r.productId === productId)
      .map((r) => [r.sourceOrderId, r.remainingPieces] as const),
  );
  const chunks: AllocatedChunk[] = [];
  let left = Math.max(0, requestedPieces);

  for (const line of candidateLines) {
    if (left <= 0) break;
    if (line.productId !== productId) continue;
    const cap = remaining.get(line.sourceOrderId) ?? 0;
    if (cap <= 0) continue;
    const take = Math.min(left, cap, line.piecesQty);
    if (take <= 0) continue;
    chunks.push({ line, pieces: take });
    remaining.set(line.sourceOrderId, cap - take);
    left -= take;
  }

  if (left > 0) chunks.push({ line: null, pieces: left });
  return chunks;
}

// ─── §3.2 per-chunk pricing ─────────────────────────────────────────────────────

/** Case 1 — matched: priced off the SOURCE_INVOICE line's own stored rate. */
export function priceMatchedChunk(
  line: CandidateInvoiceLine,
  chunkPieces: number,
  customerIsTaxExempt: boolean,
): PricedChunk {
  const boxSplit = line.boxes != null;
  const upb = Number(line.unitsPerBox ?? 0);
  const chunkInLineAxis = boxSplit ? chunkPieces : upb > 1 ? chunkPieces / upb : chunkPieces;
  const freeUnits = Number(line.promoFreeUnits ?? 0);
  const freeUnitSize = boxSplit ? upb || 1 : 1;

  const prorated = prorateLineSubtotal(
    line.subtotal,
    chunkInLineAxis,
    line.qty,
    freeUnits,
    freeUnitSize,
  );

  // Discount share: the SAME fraction of the line's stored subtotal that `prorated`
  // represents, applied to this line's own share of the invoice's total discount.
  const chunkShare = line.subtotal > 0 ? prorated / line.subtotal : 0;
  const lineDiscountShare =
    line.invoiceSubtotal > 0
      ? roundMoney((line.invoiceDiscount * line.subtotal) / line.invoiceSubtotal)
      : 0;
  const discountForChunk = roundMoney(lineDiscountShare * chunkShare);

  const subtotal = roundMoney(prorated - discountForChunk);
  // m-7: no tax when the invoice itself charged none, or the customer is exempt — the
  // LINE's snapshot taxRate is otherwise used verbatim, never the tenant's current rate.
  const taxExempt = line.invoiceTaxAmount === 0 || customerIsTaxExempt;
  const taxAmount = taxExempt ? 0 : roundMoney(prorated * line.taxRate);

  // Category (excise) tax: pro-rated from the line's own snapshot, capped at what was
  // actually booked to the regulated ledger for this line — never invented. A line with
  // no categoryTax snapshot (non-regulated product) or no known ledger cap credits $0.
  const categoryTaxShare =
    line.categoryTax != null && line.qty > 0
      ? roundMoney((line.categoryTax * chunkInLineAxis) / line.qty)
      : 0;

  return {
    sourceOrderId: line.sourceOrderId,
    sourceInvoiceItemId: line.sourceInvoiceItemId,
    sourceOrderItemId: line.sourceOrderItemId,
    productId: line.productId,
    pieces: chunkPieces,
    subtotal,
    taxAmount,
    categoryTax: categoryTaxShare,
    priceSource: "SOURCE_INVOICE",
    unitPrice: chunkPieces > 0 ? roundMoney(subtotal / chunkPieces) : null,
  };
}

/** Cases 2/3 — unreferenced: no matched invoice line for this piece, priced off the
 * customer's current tier/CustomerPrice (case 2) or the product's base price (case 3) —
 * the caller resolves which and supplies the label via `ctx.source`. */
export function priceUnreferencedChunk(
  productId: string,
  chunkPieces: number,
  ctx: UnreferencedPriceContext,
  taxRate: number,
  customerIsTaxExempt: boolean,
): PricedChunk {
  const subtotal = priceSellingUnitChunk(ctx.unitPrice, chunkPieces, ctx.unitsPerBox);
  const taxAmount = customerIsTaxExempt ? 0 : roundMoney(subtotal * taxRate);
  return {
    sourceOrderId: null,
    sourceInvoiceItemId: null,
    sourceOrderItemId: null,
    productId,
    pieces: chunkPieces,
    subtotal,
    taxAmount,
    categoryTax: 0,
    priceSource: ctx.source,
    unitPrice: ctx.unitPrice,
  };
}

/** Case 4 — staff manual override: a typed box/piece price, reason required, kept for audit. */
export function priceManualChunk(
  productId: string,
  chunkPieces: number,
  override: ManualOverride,
  taxRate: number,
  customerIsTaxExempt: boolean,
): PricedChunk {
  const subtotal = priceSellingUnitChunk(override.unitPrice, chunkPieces, override.unitsPerBox);
  const taxAmount = customerIsTaxExempt ? 0 : roundMoney(subtotal * taxRate);
  return {
    sourceOrderId: null,
    sourceInvoiceItemId: null,
    sourceOrderItemId: null,
    productId,
    pieces: chunkPieces,
    subtotal,
    taxAmount,
    categoryTax: 0,
    priceSource: "MANUAL",
    unitPrice: override.unitPrice,
    originalPrice: override.unitPrice,
    overrideReason: override.reason,
    overriddenBy: override.overriddenBy,
  };
}

// ─── §3.3 totals ────────────────────────────────────────────────────────────────

/** `CreditNote.amount = Σ subtotal + Σ taxAmount + Σ categoryTax`, each already rounded
 * per-chunk — this sums and rounds once more so the aggregate never drifts a fraction of
 * a cent off the sum of its own already-rounded parts. */
export function totalChunks(chunks: PricedChunk[]): QuoteBreakdown {
  const subtotal = roundMoney(chunks.reduce((sum, c) => sum + c.subtotal, 0));
  const taxAmount = roundMoney(chunks.reduce((sum, c) => sum + c.taxAmount, 0));
  const categoryTax = roundMoney(chunks.reduce((sum, c) => sum + c.categoryTax, 0));
  return {
    chunks,
    subtotal,
    taxAmount,
    categoryTax,
    total: roundMoney(subtotal + taxAmount + categoryTax),
  };
}
