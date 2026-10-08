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
 * {@link creditedThrough} (B894/SA-576: a credit is a LINEAR slice of the billed line, additive
 * across slices) — never re-derived here.
 */
import {
  computeLineSubtotal,
  normalizeBoxesPieces,
  creditedThrough,
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
  /** B905: PIECES of THIS line already credited by earlier live INLINE returns (their `ReturnItem.sourceInvoiceItemId` = this
   * line). The chunk is priced as credit(prior + now) - credit(prior), so the slices of a line sum to its billed amount
   * exactly. Absent / 0 = a first slice. STANDARD returns carry no line link, so they never count here. */
  priorPieces?: number;
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

/** #2695 (SA-557): a staff member's per-line CREDIT price, LOWER-ONLY — see {@link applyCreditOverride}. */
export interface CreditOverride {
  /** A typed box/piece price — same SELLING-UNIT convention as `UnreferencedPriceContext`. */
  unitPrice: number;
  /** Trimmed, 1..200 chars — validated by the caller. */
  reason: string;
  /** `user.sub` of the OPERATOR/TENANT_ADMIN who typed it. */
  overriddenBy: string;
}

/** What priced the chunk an override REPLACES: the pack its default was priced against (so the
 * override is compared per the same selling unit) and its tax basis — a matched chunk's
 * `InvoiceItem.taxRate` snapshot (exempt when the invoice charged no tax), an unreferenced
 * chunk's quote rate. Never the tenant's current rate for a matched chunk. */
export interface ReplacedChunkBasis {
  unitsPerBox: number | null;
  taxRate: number;
  taxExempt: boolean;
}

/** An override within this of the default per-selling-unit price is the default itself. */
export const CREDIT_OVERRIDE_EQUAL_TOLERANCE = 0.005;

export type CreditOverrideResult =
  { overCap: false; chunk: PricedChunk } | { overCap: true; defaultUnitPrice: number };

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
  /** B961 / SA-071c: an over-return chunk of a product WITH prior sales on this customer's candidate invoices (all returned or
   * credited): "already returned or credited". Absent otherwise (a never-invoiced product stays "not on any invoice"). */
  alreadyReturned?: boolean;
}

export interface QuoteBreakdown {
  chunks: PricedChunk[];
  subtotal: number;
  taxAmount: number;
  categoryTax: number;
  total: number;
}

/** Result of {@link resolveReturnPackFactor}. */
export interface ReturnPackFactorResult {
  /** The pack size to use, or null when none is known at all (no candidate line has one
   * and the product itself has no box size). */
  factor: number | null;
  /** Non-null (2+ distinct values, ascending) when the candidate lines DISAGREE on pack
   * size — the caller must refuse the whole item rather than guess which one applies. */
  conflictingPacks: number[] | null;
}

/**
 * SA-101(2) interim guard (B3/B765): resolves the pack (unitsPerBox) factor for one
 * return-request item from ALL of its product's candidate invoice lines, not just the
 * newest. Before this fix, the caller picked `matchingSet.find(l => l.productId ===
 * productId)?.unitsPerBox` — the newest invoice's line — and silently applied that pack
 * size even when an OLDER line (the one the operator actually saw) used a different one:
 * a product with a 12-pack line and a newer 48-unit Case line would price a return typed
 * against the 12-pack order at the Case's factor instead, a 4x mis-credit. This function
 * makes that ambiguity an explicit, reported conflict instead of a silent guess — the
 * caller throws (see `inline-returns-quote.service.ts`). The durable fix (carrying the
 * actual `sourceOrderItemId` on the wire, so the factor is never guessed at all) is a
 * later PR; this only stops the silent wrong guess.
 *
 * SA-108 precision: a pack of exactly 1 (or null) means "no packaging" (R-029) — the same
 * convention `isBoxedProduct`/`ResolveParkedRestockDto` use elsewhere (only `> 1` is a real
 * box size). A candidate line legitimately carrying `unitsPerBox: 1` must never conflict
 * with a genuinely boxed sibling at, say, 12 — it is not a competing PACK claim, it is a
 * line that was never boxed in the first place. Only distinct values `> 1` count toward a
 * conflict; a lone `1` among the candidates is simply ignored, exactly like `null`.
 */
export function resolveReturnPackFactor(
  candidatePacks: ReadonlyArray<number | null | undefined>,
  productUnitsPerBox: number | null,
): ReturnPackFactorResult {
  const distinct = [...new Set(candidatePacks.filter((p): p is number => p != null && p > 1))].sort(
    (a, b) => a - b,
  );
  if (distinct.length > 1) {
    return { factor: null, conflictingPacks: distinct };
  }
  return { factor: distinct[0] ?? productUnitsPerBox ?? null, conflictingPacks: null };
}

// ─── §3.1 matching / allocation ────────────────────────────────────────────────

/** Converts a return-request DTO qty (raw qty, or an explicit boxes/pieces split) into
 * pieces, the SAME rule OrderItem/InvoiceItem storage already uses — `boxes != null` (or
 * `pieces != null`) means the caller supplied an explicit split: `qty` is IGNORED entirely
 * and the piece count is `boxes * unitsPerBox + pieces`. Otherwise (a bare `qty`, no split),
 * a boxed product's `qty` means BOXES (multiplied by the unitsPerBox snapshot) and a
 * non-boxed product's `qty` is already pieces. */
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
  // B661-sweep: a box-unaware multiply — follow-up PR converts this to
  // @routeflow/pricing's regulatedUnitBasis; see no-second-legacy-line-pieces.spec.ts's allowlist.
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
  const inLineAxis = (pieces: number) => (boxSplit ? pieces : upb > 1 ? pieces / upb : pieces);
  const priorPieces = Math.max(0, Number(line.priorPieces ?? 0));
  const chunkInLineAxis = inLineAxis(chunkPieces);
  // B894 (SA-576): a credit prices a SLICE of the already-billed line from scratch, so it is LINEAR
  // (additive: the slices of one line credit at most its stored subtotal). The invoice's floored
  // free-unit telescope (prorateLineSubtotal) is non-monotone and over-credits per slice.
  // B905: and TELESCOPED over the pieces the line already had credited: every figure below is the cumulative credit through
  // (prior + now) minus the cumulative credit through (prior), each cumulative rounded once, so the slices sum to the whole.
  const through = (pieces: number) => creditedThrough(line.subtotal, inLineAxis(pieces), line.qty);
  const prorated = roundMoney(through(priorPieces + chunkPieces) - through(priorPieces));

  // Discount share: the SAME fraction of the line's stored subtotal that the credited slice
  // represents, applied to this line's own share of the invoice's total discount.
  const lineDiscountShare =
    line.invoiceSubtotal > 0
      ? roundMoney((line.invoiceDiscount * line.subtotal) / line.invoiceSubtotal)
      : 0;
  const netThrough = (pieces: number) => {
    const gross = through(pieces);
    const share = line.subtotal > 0 ? gross / line.subtotal : 0;
    return roundMoney(gross - roundMoney(lineDiscountShare * share));
  };
  const subtotal = roundMoney(netThrough(priorPieces + chunkPieces) - netThrough(priorPieces));
  // m-7: no tax when the invoice itself charged none, or the customer is exempt — the
  // LINE's snapshot taxRate is otherwise used verbatim, never the tenant's current rate.
  const taxExempt = line.invoiceTaxAmount === 0 || customerIsTaxExempt;
  const taxAmount = taxExempt
    ? 0
    : roundMoney(
        roundMoney(through(priorPieces + chunkPieces) * line.taxRate) -
          roundMoney(through(priorPieces) * line.taxRate),
      );

  // Category (excise) tax: pro-rated from the line's own snapshot, capped at what was
  // actually booked to the regulated ledger for this line — never invented. A line with
  // no categoryTax snapshot (non-regulated product) or no known ledger cap credits $0.
  const categoryTaxThrough = (pieces: number) =>
    line.categoryTax != null && line.qty > 0
      ? roundMoney((line.categoryTax * Math.min(inLineAxis(pieces), line.qty)) / line.qty)
      : 0;
  const categoryTaxShare = roundMoney(
    categoryTaxThrough(priorPieces + chunkPieces) - categoryTaxThrough(priorPieces),
  );

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

/**
 * Case 4 — #2695 (SA-557) staff credit-price override, LOWER-ONLY, applied to a chunk the engine
 * has ALREADY priced (matched or unreferenced). The cap is that chunk's own DEFAULT per selling
 * unit (its subtotal over its selling units — a matched chunk's is the source line's NET price),
 * so there is no uncapped path:
 *  - within {@link CREDIT_OVERRIDE_EQUAL_TOLERANCE} of the default: NOT an override — the default
 *    chunk comes back untouched (no MANUAL source, nothing to audit);
 *  - above it (or a subtotal above the default's): `overCap` — the caller refuses with a 400;
 *  - below it: the pieces re-priced at the override via `computeLineSubtotal`, taxed at the
 *    REPLACED chunk's basis, the category (excise) tax and source ids CARRIED (the same goods
 *    went back; only the credit per unit changed), `originalPrice` = the default replaced.
 */
export function applyCreditOverride(
  defaultChunk: PricedChunk,
  override: CreditOverride,
  basis: ReplacedChunkBasis,
): CreditOverrideResult {
  const upb = Number(basis.unitsPerBox ?? 0);
  const sellingUnits = upb > 1 ? defaultChunk.pieces / upb : defaultChunk.pieces;
  if (!(sellingUnits > 0)) return { overCap: false, chunk: defaultChunk };
  const defaultPerUnit = defaultChunk.subtotal / sellingUnits;
  const defaultUnitPrice = roundMoney(defaultPerUnit);
  // + 1e-9: the tolerance is inclusive, and 10.005 - 10 is 0.005000000000000782 in floats.
  if (Math.abs(override.unitPrice - defaultPerUnit) <= CREDIT_OVERRIDE_EQUAL_TOLERANCE + 1e-9) {
    return { overCap: false, chunk: defaultChunk };
  }
  if (override.unitPrice > defaultPerUnit) return { overCap: true, defaultUnitPrice };
  const subtotal = priceSellingUnitChunk(
    override.unitPrice,
    defaultChunk.pieces,
    basis.unitsPerBox,
  );
  if (subtotal > defaultChunk.subtotal) return { overCap: true, defaultUnitPrice };
  return {
    overCap: false,
    chunk: {
      ...defaultChunk,
      subtotal,
      taxAmount: basis.taxExempt ? 0 : roundMoney(subtotal * basis.taxRate),
      priceSource: "MANUAL",
      unitPrice: override.unitPrice,
      originalPrice: defaultUnitPrice,
      overrideReason: override.reason,
      overriddenBy: override.overriddenBy,
    },
  };
}

/** #2695: the per-chunk entries of the `inline_return.price_override` audit row. Kept out of
 * `captureInTx`'s body: the copier contract scans that body for ReturnItem column writes, and
 * these are audit-meta keys, not columns. */
export function creditOverrideAuditItems(chunks: readonly PricedChunk[]) {
  return chunks.map((c) => ({
    productId: c.productId,
    pieces: c.pieces,
    defaultUnitPrice: c.originalPrice ?? null,
    unitPrice: c.unitPrice,
    reason: c.overrideReason ?? null,
  }));
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
