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
 * from `@routeflow/pricing`; a matched chunk's price is `refundableLineShare`'s (SA-840 / SA-1091 A-1: what the
 * invoice charged, additive across slices and across the lines of an invoice) — never re-derived here.
 */
import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  computeLineSubtotal,
  normalizeBoxesPieces,
  refundableInvoiceOf,
  refundableLineShare,
  roundMoney,
  type RefundableInvoice,
  type StoredInvoice,
  type RefundableInvoiceLine,
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
  /** SA-1091 A-1: the WHOLE invoice as stored (every line in row order, the NSF fee line flagged), so a slice is priced as what
   * the invoice CHARGED (`refundableLineShare`), never re-derived from this one line. The quote reads and sets it. */
  invoice?: RefundableInvoice;
  /** SA-1091 A-1: the net / tax / levy earlier live INLINE returns already took on THIS line (the amounts that go with `priorPieces`). */
  priorAmounts?: TakenAmounts;
  /** SA-1091 A-1: the same, summed over EVERY line of the invoice and this request so far. ONE object shared by the invoice's lines,
   * so a slice also stops at what is left of each charge across the invoice (returns stored at an older price are not repriced). */
  invoiceTaken?: TakenAmounts;
}

/** Net (after the discount share), regular tax and category tax already taken from an invoice line or an invoice. */
export interface TakenAmounts {
  net: number;
  tax: number;
  categoryTax: number;
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
  /** W-1316: SOURCE_INVOICE only when the last paid price capped a sold-before chunk. */
  source: Extract<ReturnPriceSource, "SOURCE_INVOICE" | "CUSTOMER_PRICE" | "TIER" | "BASE">;
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
  /** SA-1060 PR-2: this customer has no live invoice line of the product in their whole history, so the goods did not come from
   * us. Such a chunk carries no sales tax and is never restocked; the quote sets it, the capture reads it, the client never
   * sends it. False on every matched and every sold-before chunk. */
  neverSold: boolean;
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
    // B905: a line offers only what earlier inline returns of ITS OWN left (the supply cap is per order and product, so
    // without this a fully returned line would take the chunk and price it at $0 while a sibling line still has the goods)
    const take = Math.min(left, cap, line.piecesQty - Math.max(0, Number(line.priorPieces ?? 0)));
    if (take <= 0) continue;
    chunks.push({ line, pieces: take });
    remaining.set(line.sourceOrderId, cap - take);
    left -= take;
  }

  if (left > 0) chunks.push({ line: null, pieces: left });
  return chunks;
}

// ─── §3.2 per-chunk pricing ─────────────────────────────────────────────────────

/**
 * SA-1091 A-1: the invoice a candidate line is priced against. The quote sets `invoice` (the whole invoice as stored, every
 * line in row order); a line read ALONE (a spec fixture) is a one-line invoice built from its own stored columns, so the helper
 * still does the pricing and there is no second formula.
 */
export function invoiceViewOf(line: CandidateInvoiceLine): RefundableInvoice {
  if (line.invoice) return line.invoice;
  // the rest of the invoice (its other lines, at this line's rate) is what the invoice header says is not this line
  const rest = roundMoney(line.invoiceSubtotal - line.subtotal);
  const own: RefundableInvoiceLine = {
    id: line.sourceInvoiceItemId,
    subtotal: line.subtotal,
    qty: line.qty,
    taxRate: line.taxRate,
    isNsf: false,
  };
  // a read-only view for the helper's input, not a stamp of the category-tax trio on a row (category-tax-trio-callsites.spec)
  own.categoryTaxAmount = line.categoryTax;
  return {
    taxAmount: line.invoiceTaxAmount,
    discount: line.invoiceDiscount,
    lines: [
      own,
      ...(rest > 0
        ? [{ id: "~rest", subtotal: rest, qty: 1, taxRate: line.taxRate, isNsf: false }]
        : []),
    ],
  };
}

/**
 * Case 1 — matched: priced as what the invoice CHARGED for the slice (SA-840 / SA-1091 A-1): `refundableLineShare` gives the
 * net (after the line's discount share), the regular-tax share and the category-tax (levy) share, so the lines of a whole sale
 * add up to the invoice exactly, in any order, and slices of one line add up to the line. Pack and pieces conversion stays
 * here (`inLineAxis`). The helper's refusal is refused (409), never priced at 0.
 */
export function priceMatchedChunk(
  line: CandidateInvoiceLine,
  chunkPieces: number,
  customerIsTaxExempt: boolean,
): PricedChunk {
  const boxSplit = line.boxes != null;
  const upb = Number(line.unitsPerBox ?? 0);
  const inLineAxis = (pieces: number) => (boxSplit ? pieces : upb > 1 ? pieces / upb : pieces);
  const priorPieces = Math.max(0, Number(line.priorPieces ?? 0));
  const prior = line.priorAmounts ?? { net: 0, tax: 0, categoryTax: 0 };
  const share = refundableLineShare({
    invoice: invoiceViewOf(line),
    lineId: line.sourceInvoiceItemId,
    returnedQty: inLineAxis(chunkPieces),
    prior: { qty: inLineAxis(priorPieces), ...prior },
    invoicePrior: line.invoiceTaken ?? prior,
  });
  if (share.refusal) {
    throw new ConflictException({
      code: API_ERROR_CODES.RETURN_REFUND_OVER_LINE_HEADROOM,
      message: "That return is more than the invoice line holds.",
    });
  }
  // m-7: no tax when the invoice itself charged none, or the customer is exempt — the invoice's stored tax is the only tax
  // that was charged (an exempt invoice stores 0), and an exempt customer today still gets no tax back.
  const taxExempt = line.invoiceTaxAmount === 0 || customerIsTaxExempt;
  // No levy snapshot (a non-regulated product) credits $0: the helper reads the stored levy column, this keeps the caller's
  // own "no known snapshot" reading.
  const categoryTax = line.categoryTax != null ? share.categoryTax : 0;

  return {
    sourceOrderId: line.sourceOrderId,
    sourceInvoiceItemId: line.sourceInvoiceItemId,
    sourceOrderItemId: line.sourceOrderItemId,
    productId: line.productId,
    pieces: chunkPieces,
    subtotal: share.net,
    taxAmount: taxExempt ? 0 : share.tax,
    categoryTax,
    priceSource: "SOURCE_INVOICE",
    unitPrice: chunkPieces > 0 ? roundMoney(share.net / chunkPieces) : null,
    neverSold: false,
  };
}

/** W-1316: the customer's newest live sale of a product: the line and the invoice it sits on (every line, row order). */
export interface LastSale {
  id: string;
  boxes: number | null;
  unitsPerBox: number | null;
  invoice: StoredInvoice;
}

/**
 * W-1316: what the customer last paid for ONE selling unit of the product (a box of a boxed product, else a piece), as the
 * invoice charged it: `refundableLineShare` on a fresh slice of one selling unit of that line (net after the discount share),
 * never `qty * unitPrice`. `null` when the helper refuses the slice: the caller then applies no cap (a cap only ever lowers).
 */
export function lastPaidPerSellingUnit(
  sale: LastSale,
  productUnitsPerBox: number | null,
): number | null {
  const lineQty = Number(sale.invoice?.items?.find((i) => i.id === sale.id)?.qty);
  if (!(lineQty > 0)) return null;
  const axisQty = Math.min(1, lineQty); // the line's own axis: pieces for a box split, else selling units
  const share = refundableLineShare({
    invoice: refundableInvoiceOf(sale.invoice),
    lineId: sale.id,
    returnedQty: axisQty,
    prior: { qty: 0, net: 0, tax: 0, categoryTax: 0 },
  });
  if (share.refusal) return null;
  const lineUpb = Number(sale.unitsPerBox ?? productUnitsPerBox ?? 0);
  const perAxis = share.net / axisQty;
  const perPiece = sale.boxes != null ? perAxis : lineUpb > 1 ? perAxis / lineUpb : perAxis;
  const productUpb = Number(productUnitsPerBox ?? 0);
  return roundMoney(productUpb > 1 ? perPiece * productUpb : perPiece);
}

/** SA-1091 A-1: records a priced chunk against its invoice's shared `invoiceTaken`, so the next line priced in the same request
 * stops at what is left. A line with no shared object (a spec fixture) has nothing to record. */
export function noteChunkTaken(
  line: CandidateInvoiceLine,
  chunk: Pick<PricedChunk, "subtotal" | "taxAmount" | "categoryTax">,
): void {
  const taken = line.invoiceTaken;
  if (!taken) return;
  taken.net = roundMoney(taken.net + chunk.subtotal);
  taken.tax = roundMoney(taken.tax + chunk.taxAmount);
  taken.categoryTax = roundMoney(taken.categoryTax + chunk.categoryTax);
}

/** Cases 2/3 — unreferenced: no matched invoice line for this piece, priced off the
 * customer's current tier/CustomerPrice (case 2) or the product's base price (case 3) —
 * the caller resolves which and supplies the label via `ctx.source`.
 * SA-1060 PR-2: a `neverSold` chunk (no live sale of the product to this customer, ever) credits no sales tax, at any rate: B463's
 * rule is never to credit a tax the sale did not charge, and there was no sale. */
export function priceUnreferencedChunk(
  productId: string,
  chunkPieces: number,
  ctx: UnreferencedPriceContext,
  taxRate: number,
  customerIsTaxExempt: boolean,
  neverSold: boolean,
): PricedChunk {
  const subtotal = priceSellingUnitChunk(ctx.unitPrice, chunkPieces, ctx.unitsPerBox);
  const taxAmount = customerIsTaxExempt || neverSold ? 0 : roundMoney(subtotal * taxRate);
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
    neverSold,
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
      // SA-1060 PR-2: a never-sold chunk stays untaxed at the lowered price too (keyed on the chunk, not on the rate).
      // SA-1091 AC-12: and a lowered price never takes more tax than the default chunk did (a line's rate can be stale
      // against what the invoice charged, e.g. tax that is the levy alone)
      taxAmount:
        basis.taxExempt || defaultChunk.neverSold
          ? 0
          : Math.min(defaultChunk.taxAmount, roundMoney(subtotal * basis.taxRate)),
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
