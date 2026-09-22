// ─── Inline return capture — pure state helpers, mobile mirror (PR 3) ───────────
//
// Sibling of apps/web/app/(dashboard)/returns/_components/inline-return-state.ts — same
// logic, same tests-in-spirit, ported rather than shared because each platform's copy lives
// under its own platform-specific tree (matching this codebase's existing convention: mobile's
// lib/returns-logic.ts and web's returns page logic are likewise separate per-platform files
// for "the same" standard-return flow, not a shared package). If either copy changes, check
// the other — see PR 1's SA-071b §8.1a(5) amendment, which binds identically here.
//
// Money is NEVER computed here — every subtotal/tax/total the screen renders comes verbatim
// from the quote response. The only "math" done client-side is summing already-rounded,
// already-server-priced chunk figures for display grouping, never deriving a new price.
import type {
  CaptureInlineReturnItem,
  CaptureInlineReturnRequest,
  InlineReturnQuoteChunk,
  InlineReturnQuoteResponse,
  QuoteInlineReturnItem,
  QuoteInlineReturnRequest,
  ReturnReason,
} from "@routeflow/types";

// ─── Step 1: line drafts ─────────────────────────────────────────────────────

/** One product row in "What came back". `boxes`/`pieces` are kept as STRINGS (raw input
 *  value) so an empty field reads as "nothing entered" rather than coercing to 0. */
export interface InlineReturnLineDraft {
  productId: string;
  productName: string;
  unit?: string | null;
  /** > 1 means this product sells in boxes — render the boxes+pieces pair, never a bare
   *  qty input (SA-071a #3). */
  unitsPerBox?: number | null;
  qtySold?: number;
  qtyAlreadyReturned?: number;
  boxes: string;
  pieces: string;
  /** Per-item reason override — optional; falls back to the capture-level reason. */
  reason: ReturnReason | "";
  note: string;
}

export function isBoxedProduct(line: Pick<InlineReturnLineDraft, "unitsPerBox">): boolean {
  return Number(line.unitsPerBox ?? 0) > 1;
}

function parseNonNegativeInt(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** "Get quote" enables when any line has boxes > 0 or pieces > 0. */
export function hasAnyQtyEntered(lines: InlineReturnLineDraft[]): boolean {
  return lines.some((l) => parseNonNegativeInt(l.boxes) > 0 || parseNonNegativeInt(l.pieces) > 0);
}

/**
 * Builds the quote request from Step 1's drafts. `boxes`/`pieces` are ALWAYS sent
 * explicitly (never a bare `qty`) — a bare `qty` on a boxed product means BOXES to the API
 * (SA-071a #3). `qty` is required by the DTO but IGNORED server-side whenever
 * `boxes`/`pieces` are present — set to `1` as a documented, unused-but-valid placeholder.
 */
export function buildQuoteRequest(
  customerId: string,
  lines: InlineReturnLineDraft[],
  routeRunStopId?: string,
): QuoteInlineReturnRequest {
  const items: QuoteInlineReturnItem[] = lines
    .map((l) => ({
      productId: l.productId,
      boxes: parseNonNegativeInt(l.boxes),
      pieces: parseNonNegativeInt(l.pieces),
    }))
    .filter((i) => i.boxes > 0 || i.pieces > 0)
    .map((i) => ({ productId: i.productId, qty: 1, boxes: i.boxes, pieces: i.pieces }));
  return routeRunStopId ? { customerId, items, routeRunStopId } : { customerId, items };
}

// ─── Step 2: quote chunk grouping (display only — no money math) ───────────────

export interface GroupedQuoteChunks {
  /** Newest-invoice-first, exactly as the quote returned them — never re-sorted. */
  covered: InlineReturnQuoteChunk[];
  /** Chunks matched to no invoice line at all ("Not on any invoice"). */
  excess: InlineReturnQuoteChunk[];
}

export function groupQuoteChunks(quote: InlineReturnQuoteResponse): GroupedQuoteChunks {
  const covered: InlineReturnQuoteChunk[] = [];
  const excess: InlineReturnQuoteChunk[] = [];
  for (const chunk of quote.chunks) {
    (chunk.sourceOrderId != null ? covered : excess).push(chunk);
  }
  return { covered, excess };
}

export interface ChunkTotals {
  subtotal: number;
  taxAmount: number;
  categoryTax: number;
  total: number;
}

/** Sums already-server-priced chunk figures for a display subtotal — never derives a new
 *  price. */
export function sumChunkTotals(chunks: InlineReturnQuoteChunk[]): ChunkTotals {
  const subtotal = chunks.reduce((s, c) => s + c.subtotal, 0);
  const taxAmount = chunks.reduce((s, c) => s + c.taxAmount, 0);
  const categoryTax = chunks.reduce((s, c) => s + c.categoryTax, 0);
  return { subtotal, taxAmount, categoryTax, total: subtotal + taxAmount + categoryTax };
}

// ─── Excess option (PR 1/3 ship exactly two — no "different price", no placeholder) ─────

export type ExcessOption = "CREDIT_AT_CURRENT_PRICE" | "RETURN_ONLY_PURCHASED";

export const DEFAULT_EXCESS_OPTION: ExcessOption = "CREDIT_AT_CURRENT_PRICE";

/** Sums each product's COVERED (matched) pieces from the quote — never the excess. */
export function coveredPiecesByProduct(quote: InlineReturnQuoteResponse): Map<string, number> {
  const byProduct = new Map<string, number>();
  for (const chunk of quote.chunks) {
    if (chunk.sourceOrderId == null) continue;
    byProduct.set(chunk.productId, (byProduct.get(chunk.productId) ?? 0) + chunk.pieces);
  }
  return byProduct;
}

/**
 * Option 3 — "Return only what was bought": drops the excess entirely and re-quotes at
 * exactly the pieces the FIRST quote actually matched to an invoice line per product.
 */
export function dropExcessAndRequote(
  customerId: string,
  quote: InlineReturnQuoteResponse,
  routeRunStopId?: string,
): QuoteInlineReturnRequest {
  const items: QuoteInlineReturnItem[] = [...coveredPiecesByProduct(quote).entries()]
    .filter(([, pieces]) => pieces > 0)
    .map(([productId, pieces]) => ({ productId, qty: 1, boxes: 0, pieces }));
  return routeRunStopId ? { customerId, items, routeRunStopId } : { customerId, items };
}

/**
 * SA-071b §8.1a(5) — applies a "return only what was bought" re-quote result back onto Step
 * 1's own line drafts, so a later `buildCaptureRequest` (which reads quantities from `lines`,
 * not from the quote) captures the SAME reduced amount the re-quoted screen showed — never
 * the original, larger request the excess option just dropped. THE SUBMITTED QUANTITIES MUST
 * ALWAYS DERIVE FROM THE SAME STATE THE DISPLAYED QUOTE WAS COMPUTED AGAINST, and every
 * re-quote must write back into the submit-state — "quantities only" alone is necessary but
 * not sufficient, since the server prices whatever quantity arrives correctly regardless of
 * whether it's stale (the ruling this amendment records, from PR 1's own self-found bug).
 * A product with zero covered pieces is removed from `lines` entirely.
 */
export function applyCoveredPiecesToLines(
  lines: InlineReturnLineDraft[],
  quote: InlineReturnQuoteResponse,
): InlineReturnLineDraft[] {
  const covered = coveredPiecesByProduct(quote);
  return lines
    .filter((l) => (covered.get(l.productId) ?? 0) > 0)
    .map((l) => ({ ...l, boxes: "0", pieces: String(covered.get(l.productId) ?? 0) }));
}

// ─── Capture request ────────────────────────────────────────────────────────────

/**
 * Builds the capture request. THE CLIENT SENDS QUANTITIES ONLY — boxes/pieces, reason codes,
 * notes, `returnKey`. Never a price the quote displayed; the server recomputes through the
 * same pricing engine at capture time. `returnKey` is passed in by the caller (derived via
 * `lib/inline-return-submit-key.ts` — never minted here).
 */
export function buildCaptureRequest(params: {
  customerId: string;
  orderId: string;
  lines: InlineReturnLineDraft[];
  returnKey: string;
  reason: ReturnReason;
  notes?: string;
  routeRunStopId?: string;
}): CaptureInlineReturnRequest {
  const items: CaptureInlineReturnItem[] = params.lines
    .map((l) => ({
      productId: l.productId,
      boxes: parseNonNegativeInt(l.boxes),
      pieces: parseNonNegativeInt(l.pieces),
      reason: l.reason || undefined,
      condition: l.note.trim() || undefined,
    }))
    .filter((i) => i.boxes > 0 || i.pieces > 0)
    .map((i) => ({
      productId: i.productId,
      qty: 1,
      boxes: i.boxes,
      pieces: i.pieces,
      ...(i.reason ? { reason: i.reason } : {}),
      ...(i.condition ? { condition: i.condition } : {}),
    }));

  return {
    customerId: params.customerId,
    orderId: params.orderId,
    items,
    returnKey: params.returnKey,
    reason: params.reason,
    ...(params.routeRunStopId ? { routeRunStopId: params.routeRunStopId } : {}),
    ...(params.notes ? { notes: params.notes } : {}),
  };
}

/** For `buildCaptureRequest`'s `items` — the exact shape `inlineReturnSubmitKey` needs, kept
 *  as a small adapter here so the submit-key module has no dependency on this one. */
export function submitKeyItemsFrom(
  lines: InlineReturnLineDraft[],
): Array<{ productId: string; boxes: number; pieces: number }> {
  return lines
    .map((l) => ({
      productId: l.productId,
      boxes: parseNonNegativeInt(l.boxes),
      pieces: parseNonNegativeInt(l.pieces),
    }))
    .filter((i) => i.boxes > 0 || i.pieces > 0);
}

// ─── Refusal rendering ───────────────────────────────────────────────────────────
//
// An entitlement-gate refusal (AddonGuard/PlanFlagGuard — code ADDON_GATE / PLAN_GATE /
// PLAN_GATE_UNAVAILABLE) always renders the fixed copy below, regardless of the guard's own
// wording. Every OTHER refusal renders the API's own message verbatim.

export const RETURNS_NOT_ENABLED_MESSAGE = "Returns are not enabled for this account";

const ENTITLEMENT_GATE_CODES = new Set(["ADDON_GATE", "PLAN_GATE", "PLAN_GATE_UNAVAILABLE"]);

interface ApiErrorLike {
  response?: {
    status?: number;
    data?: {
      code?: string;
      message?: string | string[];
    };
  };
}

export function extractRefusalMessage(error: unknown, fallback = "Something went wrong"): string {
  const body = (error as ApiErrorLike | undefined)?.response?.data;
  const status = (error as ApiErrorLike | undefined)?.response?.status;
  if (status === 403 && (body?.code == null || ENTITLEMENT_GATE_CODES.has(body.code))) {
    return RETURNS_NOT_ENABLED_MESSAGE;
  }
  if (!body?.message) return fallback;
  return Array.isArray(body.message) ? body.message.join(" ") : body.message;
}
