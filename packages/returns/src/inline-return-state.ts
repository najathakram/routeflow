// ─── RecordInlineReturnDialog — pure state helpers (no React) ──────────────────
//
// Everything here is pure data transformation so it can be unit-tested without mounting the
// dialog. Money is NEVER computed here — every subtotal/tax/total rendered by the dialog
// comes verbatim from the quote response (SA-071b item 5's sibling rule); the only "math"
// done client-side is summing already-rounded, already-server-priced chunk figures for
// display grouping (covered total, excess total), never deriving a NEW price from qty×rate.
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
 *  value) so an empty field reads as "nothing entered" rather than coercing to 0 and
 *  looking pre-filled. */
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
 * SA-101(2)/B3/B765 interim guard: merges request items that share a `productId` — BEFORE
 * they reach the wire — by summing `boxes`/`pieces`. `lines` is keyed by `productId`
 * throughout this dialog (`updateLine`/`removeLine`), so a source order with two lines of
 * one product (a Case line and a pack line, say) can hydrate two draft rows for the same
 * product; without this merge each would become its OWN request item, and the server's
 * per-item allocation (`allocateReturnedPieces`) rebuilds its remaining-supply view fresh
 * per item rather than decrementing a shared one — two items for the same product would
 * each draw against the SAME undiminished supply, silently crediting it twice. Other
 * per-item fields (a capture item's `reason`/`condition`) are kept from the FIRST
 * occurrence — only quantities are summed. The durable fix (carrying the specific source
 * line on the wire, so two lines of one product are never conflated into a single qty at
 * all) is a later PR; this only stops the silent double-count.
 */
function mergeDuplicateProductItems<T extends { productId: string; boxes: number; pieces: number }>(
  items: T[],
): T[] {
  const merged = new Map<string, T>();
  for (const item of items) {
    const existing = merged.get(item.productId);
    if (existing) {
      existing.boxes += item.boxes;
      existing.pieces += item.pieces;
    } else {
      merged.set(item.productId, { ...item });
    }
  }
  return [...merged.values()];
}

/**
 * Builds the quote request from Step 1's drafts. `boxes`/`pieces` are ALWAYS sent
 * explicitly (never a bare `qty`) — a bare `qty` on a boxed product means BOXES to the API
 * (SA-071a #3), so sending both fields explicitly for every line, boxed or not, removes the
 * ambiguity entirely rather than relying on the caller to know which products are boxed.
 * `qty` is required by the DTO (`@IsInt() @Min(1)`) but is IGNORED server-side whenever
 * `boxes`/`pieces` are present (`returnRequestPieces`) — set to `1` as a documented,
 * unused-but-valid placeholder, never a real quantity guess.
 */
export function buildQuoteRequest(
  customerId: string,
  lines: InlineReturnLineDraft[],
  routeRunStopId?: string,
): QuoteInlineReturnRequest {
  const items: QuoteInlineReturnItem[] = mergeDuplicateProductItems(
    lines
      .map((l) => ({
        productId: l.productId,
        boxes: parseNonNegativeInt(l.boxes),
        pieces: parseNonNegativeInt(l.pieces),
      }))
      .filter((i) => i.boxes > 0 || i.pieces > 0)
      .map((i) => ({ productId: i.productId, qty: 1, boxes: i.boxes, pieces: i.pieces })),
  );
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
 *  price. Each addend is a figure the quote already computed and rounded; this only groups
 *  figures that already exist. */
export function sumChunkTotals(chunks: InlineReturnQuoteChunk[]): ChunkTotals {
  const subtotal = chunks.reduce((s, c) => s + c.subtotal, 0);
  const taxAmount = chunks.reduce((s, c) => s + c.taxAmount, 0);
  const categoryTax = chunks.reduce((s, c) => s + c.categoryTax, 0);
  return { subtotal, taxAmount, categoryTax, total: subtotal + taxAmount + categoryTax };
}

// ─── Excess option (PR 1 ships exactly two — no "different price", no placeholder) ──────

export type ExcessOption = "CREDIT_AT_CURRENT_PRICE" | "RETURN_ONLY_PURCHASED";

export const DEFAULT_EXCESS_OPTION: ExcessOption = "CREDIT_AT_CURRENT_PRICE";

/**
 * Option 3 — "Return only what was bought": drops the excess entirely and re-quotes at
 * exactly the pieces the FIRST quote actually matched to an invoice line per product (never
 * the original requested amount). A product with zero covered pieces (nothing on file at
 * all) drops out of the request entirely — there is nothing to return of it.
 */
export function coveredPiecesByProduct(quote: InlineReturnQuoteResponse): Map<string, number> {
  const byProduct = new Map<string, number>();
  for (const chunk of quote.chunks) {
    if (chunk.sourceOrderId == null) continue;
    byProduct.set(chunk.productId, (byProduct.get(chunk.productId) ?? 0) + chunk.pieces);
  }
  return byProduct;
}

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
 * Applies a "return only what was bought" re-quote result back onto Step 1's own line
 * drafts, so a later `buildCaptureRequest` (which reads quantities from `lines`, not from
 * the quote) captures the SAME reduced amount the re-quoted screen showed — never the
 * original, larger request the excess option just dropped. A product with zero covered
 * pieces is removed from `lines` entirely, matching `dropExcessAndRequote`'s own request.
 */
export function applyCoveredPiecesToLines(
  lines: InlineReturnLineDraft[],
  quote: InlineReturnQuoteResponse,
): InlineReturnLineDraft[] {
  const covered = coveredPiecesByProduct(quote);
  // SA-108b (Opus review of #1293): `covered` is keyed by PRODUCT, but this dialog can carry
  // TWO rows for one product (see SA-108's lineKey fix — a source order with a Case line and
  // a pack line, say). Giving EVERY row of that product the FULL covered total, then letting
  // buildCaptureRequest's own (correct) productId merge sum them, doubled the credit — the
  // first row alone gets the product's covered amount; every sibling row is zeroed, never
  // duplicated. A row zeroed this way stays visible in the dialog (0 pieces) but drops out of
  // the wire request on its own (buildQuoteRequest/buildCaptureRequest already filter out any
  // item with boxes/pieces both 0).
  const seenProduct = new Set<string>();
  return lines
    .filter((l) => (covered.get(l.productId) ?? 0) > 0)
    .map((l) => {
      const isFirstForProduct = !seenProduct.has(l.productId);
      seenProduct.add(l.productId);
      const amount = isFirstForProduct ? (covered.get(l.productId) ?? 0) : 0;
      return { ...l, boxes: "0", pieces: String(amount) };
    });
}

// ─── Capture request ────────────────────────────────────────────────────────────

/**
 * Builds the capture request. THE CLIENT SENDS QUANTITIES ONLY (SA-071b item 5) —
 * boxes/pieces, reason codes, notes, `returnKey`. Never a price the quote displayed; the
 * server recomputes through the same pricing engine at capture time.
 */
export function buildCaptureRequest(params: {
  customerId: string;
  orderId: string;
  lines: InlineReturnLineDraft[];
  returnKey: string;
  reason: ReturnReason;
  /** Capture-level note (distinct from each line's own optional note, which maps to that
   *  item's `condition` — the DTO's only per-item free-text field). */
  notes?: string;
  routeRunStopId?: string;
}): CaptureInlineReturnRequest {
  const items: CaptureInlineReturnItem[] = mergeDuplicateProductItems(
    params.lines
      .map((l) => ({
        productId: l.productId,
        boxes: parseNonNegativeInt(l.boxes),
        pieces: parseNonNegativeInt(l.pieces),
        reason: l.reason || undefined,
        condition: l.note.trim() || undefined,
      }))
      .filter((i) => i.boxes > 0 || i.pieces > 0),
  ).map((i) => ({
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

// ─── returnKey — one UUID per capture ATTEMPT, stable across a retry ───────────

/** Mints a capture nonce. Called once per attempt (when the dialog opens Step 2 / is reset
 *  for a new capture) — NEVER on every render and NEVER regenerated on a retry of the same
 *  attempt (SA-071a #2: the same key re-sent unchanged is what makes a retry idempotent). */
export function mintReturnKey(): string {
  return crypto.randomUUID();
}

// ─── Refusal rendering ───────────────────────────────────────────────────────────
//
// An entitlement-gate refusal (AddonGuard/PlanFlagGuard — code ADDON_GATE / PLAN_GATE /
// PLAN_GATE_UNAVAILABLE) always renders the fixed copy below, regardless of the guard's own
// wording (`This feature requires the "orders_inline_returns" add-on.`) — the spec's copy.
// Every OTHER refusal (VOID invoice not a candidate, cancelled order, driver not owner, a
// returnKey collision) renders the API's own message verbatim — never a workaround, never a
// bypass, never a retry loop.

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

// ─── Money display helpers (formatting only — no math) ─────────────────────────

/**
 * The capture response's `refundAmount` is a Prisma Decimal, which JSON carries as a STRING
 * ("22.5000"); the shared type says `number`. A `typeof === "number"` check therefore never
 * held and the credit amount never showed (#2097). Accept both, and return null for anything
 * that is not a finite amount so the row is hidden rather than rendered as $NaN. Shared by
 * RecordInlineReturnDialog's own result screen and OrderReturnsPanel (#2406) — never a second
 * hand-rolled copy.
 */
export function refundAmountOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** #2424: the capture key was reused with DIFFERENT items; the earlier return WAS recorded. */
export const INLINE_RETURN_KEY_REUSED_CODE = "INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS";

/**
 * #2647: the return the server says was ALREADY recorded under this capture key (its 409 body
 * carries `returnId` / `returnNumber`), or null for any other error. Both clients use it to offer
 * "Open RET-…" and clear the draft, so the same goods are never re-entered as a "new" return and
 * credited twice. Shared by web and mobile: never a second hand-rolled copy.
 */
export function keyReusedReturnOf(
  error: unknown,
): { returnId: string; returnNumber: string | null } | null {
  const body = (error as ApiErrorLike | undefined)?.response?.data as
    { code?: string; returnId?: unknown; returnNumber?: unknown } | undefined;
  if (body?.code !== INLINE_RETURN_KEY_REUSED_CODE) return null;
  if (typeof body.returnId !== "string" || body.returnId === "") return null;
  return {
    returnId: body.returnId,
    returnNumber: typeof body.returnNumber === "string" ? body.returnNumber : null,
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
