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
  UserRole,
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
  /** #2695 (SA-557): a staff-only CREDIT price per selling unit (one box when boxed), as typed —
   *  blank means none. Lower-only: the server refuses anything above its own default
   *  (`RETURN_CREDIT_OVER_CAP`). Only rendered for {@link canOverrideReturnCredit} roles. */
  creditUnitPrice?: string;
  /** #2695: why — required with `creditUnitPrice`. */
  overrideReason?: string;
  /** B961 / SA-071c: staff-only reason for crediting goods the quote flagged "already returned or credited". Sent on the CAPTURE
   *  only (the quote ignores it). */
  alreadyReturnedReason?: string;
}

// ─── #2695: staff credit price override ─────────────────────────────────────────

/** The roles the server lets override a return's credit price (SA-557). Every other caller
 *  that sends the fields is refused with a 400, so the input is never offered to them. */
// Checked against the shared `UserRole` enum at COMPILE time (a type-only import: `@routeflow/types`
// is TypeScript source with no runtime build, so this package never imports it at runtime). A
// typo or a renamed role is a type error here, not a silently-never-matching string.
export const CREDIT_OVERRIDE_ROLES = [
  "OPERATOR",
  "TENANT_ADMIN",
] as const satisfies readonly `${UserRole}`[];

export function canOverrideReturnCredit(role: string | null | undefined): boolean {
  return role != null && (CREDIT_OVERRIDE_ROLES as readonly string[]).includes(role);
}

export const CREDIT_OVERRIDE_REASON_MAX = 200;

export type CreditOverrideParse =
  | { kind: "none" }
  | { kind: "ok"; creditUnitPrice: number; overrideReason: string }
  | { kind: "invalid"; message: string };

/** A line's override as the wire will carry it: none (both blank), ok, or why it can't be sent.
 *  The quote and the capture both read THIS, so they always price the same chunks. */
export function parseCreditOverride(
  line: Pick<InlineReturnLineDraft, "creditUnitPrice" | "overrideReason">,
): CreditOverrideParse {
  const rawPrice = (line.creditUnitPrice ?? "").trim();
  const reason = (line.overrideReason ?? "").trim();
  if (rawPrice === "" && reason === "") return { kind: "none" };
  if (rawPrice === "") {
    return { kind: "invalid", message: "Enter a credit price, or clear the price reason." };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(rawPrice)) {
    return { kind: "invalid", message: "Enter the credit price as dollars and cents, like 4.50." };
  }
  if (reason === "") return { kind: "invalid", message: "Say why the credit price is lower." };
  if (reason.length > CREDIT_OVERRIDE_REASON_MAX) {
    return {
      kind: "invalid",
      message: `Keep the price reason to ${CREDIT_OVERRIDE_REASON_MAX} characters.`,
    };
  }
  return { kind: "ok", creditUnitPrice: Number(rawPrice), overrideReason: reason };
}

/** The first problem that stops the lines' overrides being sent, named — null when every line is
 *  sendable. A host disables "Get quote" on it (the server would refuse the same request with a
 *  400). Only rows that WILL be sent are judged: a row with no quantity (boxes and pieces both
 *  blank or 0) is filtered out of the request, so an untouched duplicate row, or an override typed
 *  on a row with no quantity, never blocks the quote. Two kinds of problem:
 *   - a sendable line whose own override is invalid (see {@link parseCreditOverride});
 *   - TWO SENDABLE ROWS OF ONE PRODUCT with different overrides (one priced, one not, or two
 *     different prices/reasons). The request merges same-product rows into ONE item that keeps the
 *     first row's override (`mergeDuplicateProductItems`), so a second, different override would be
 *     silently dropped — or would silently price the other row's pieces at the first row's price.
 *     It is refused here, visibly, instead: one price per product. */
export function creditOverrideProblem(
  lines: Pick<
    InlineReturnLineDraft,
    "productId" | "productName" | "boxes" | "pieces" | "creditUnitPrice" | "overrideReason"
  >[],
): string | null {
  const sendable = lines.filter(
    (l) => parseNonNegativeInt(l.boxes) > 0 || parseNonNegativeInt(l.pieces) > 0,
  );
  for (const line of sendable) {
    const parsed = parseCreditOverride(line);
    if (parsed.kind === "invalid") return `${line.productName}: ${parsed.message}`;
  }
  const seen = new Map<string, { name: string; key: string }>();
  for (const line of sendable) {
    const parsed = parseCreditOverride(line);
    const key =
      parsed.kind === "ok" ? `${parsed.creditUnitPrice}|${parsed.overrideReason}` : "none";
    const prior = seen.get(line.productId);
    if (!prior) {
      seen.set(line.productId, { name: line.productName, key });
    } else if (prior.key !== key) {
      return (
        `${prior.name}: two rows of this product have different credit prices. ` +
        "Use one credit price and reason for the product, or leave both blank."
      );
    }
  }
  return null;
}

/** A lowered credit, as the server priced it (`priceSource` MANUAL): the price, the default it
 *  replaced, and why — null for every other chunk. `money` is the host's own formatter. A MANUAL
 *  chunk's prices are per SELLING unit (one box when boxed), unlike a matched default's per-piece
 *  `unitPrice`, so the host says which: `boxed` labels them "per box", else "each". */
export function creditOverrideNote(
  chunk: Pick<
    InlineReturnQuoteChunk,
    "priceSource" | "unitPrice" | "originalPrice" | "overrideReason"
  >,
  money: (n: number) => string,
  boxed = false,
): string | null {
  if (chunk.priceSource !== "MANUAL") return null;
  const per = boxed ? " per box" : " each";
  return (
    `Credit lowered to ${money(chunk.unitPrice ?? 0)}${per}` +
    (chunk.originalPrice != null ? ` from ${money(chunk.originalPrice)}${per}` : "") +
    (chunk.overrideReason ? ` — ${chunk.overrideReason}` : "")
  );
}

/** The products a host should label "per box" in {@link creditOverrideNote}. */
export function boxedProductIds(
  lines: Pick<InlineReturnLineDraft, "productId" | "unitsPerBox">[],
): Set<string> {
  return new Set(lines.filter((l) => isBoxedProduct(l)).map((l) => l.productId));
}

function overrideFields(line: Pick<InlineReturnLineDraft, "creditUnitPrice" | "overrideReason">): {
  creditUnitPrice?: number;
  overrideReason?: string;
} {
  const parsed = parseCreditOverride(line);
  return parsed.kind === "ok"
    ? { creditUnitPrice: parsed.creditUnitPrice, overrideReason: parsed.overrideReason }
    : {};
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
  /** SA-740: the sale this return is from (a counter return sends the sale's order id; REQUIRED for a walk-in). */
  sourceOrderId?: string,
): QuoteInlineReturnRequest {
  const items: QuoteInlineReturnItem[] = mergeDuplicateProductItems(
    lines
      .map((l) => ({
        productId: l.productId,
        boxes: parseNonNegativeInt(l.boxes),
        pieces: parseNonNegativeInt(l.pieces),
        ...overrideFields(l),
      }))
      .filter((i) => i.boxes > 0 || i.pieces > 0)
      .map((i) => ({ ...i, qty: 1 })),
  ).map(({ productId, qty, boxes, pieces, creditUnitPrice, overrideReason }) => ({
    productId,
    qty,
    boxes,
    pieces,
    ...(creditUnitPrice !== undefined ? { creditUnitPrice, overrideReason } : {}),
  }));
  return quoteRequestOf(customerId, items, routeRunStopId, sourceOrderId);
}

/** The quote request envelope: routeRunStopId and sourceOrderId ride along only when supplied. */
function quoteRequestOf(
  customerId: string,
  items: QuoteInlineReturnItem[],
  routeRunStopId?: string,
  sourceOrderId?: string,
): QuoteInlineReturnRequest {
  return {
    customerId,
    items,
    ...(routeRunStopId ? { routeRunStopId } : {}),
    ...(sourceOrderId ? { sourceOrderId } : {}),
  };
}

// ─── B961 / SA-071c: goods already returned or credited ────────────────────────

/** The label of an over-return chunk of a product the customer DID buy and already returned/was credited for (NOT "Not on any invoice"). */
export const ALREADY_RETURNED_LABEL = "Already returned or credited";
export const ALREADY_RETURNED_NOTE =
  "The records show every unit of this product on this customer's invoices was already returned or credited. Crediting it again needs a reason.";
/** Shown to a DRIVER: their capture is held (nothing credited) until the office approves it with a reason. */
export const ALREADY_RETURNED_DRIVER_NOTE =
  "These goods were already returned or credited for this customer. Your return is recorded and held for the office to confirm; no credit is issued until staff approve it.";

/** The products whose over-return chunk the quote flagged `alreadyReturned`. */
export function alreadyReturnedProductIds(quote: InlineReturnQuoteResponse): Set<string> {
  return new Set(quote.chunks.filter((c) => c.alreadyReturned).map((c) => c.productId));
}

/** Staff must type a reason for EVERY flagged product before confirming: the product ids still missing one. */
export function missingAlreadyReturnedReasons(
  lines: ReadonlyArray<Pick<InlineReturnLineDraft, "productId" | "alreadyReturnedReason">>,
  quote: InlineReturnQuoteResponse,
): string[] {
  return [...alreadyReturnedProductIds(quote)].filter(
    (id) =>
      !lines.some((l) => l.productId === id && (l.alreadyReturnedReason ?? "").trim().length > 0),
  );
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

/**
 * #2693: the plain-words reason option 3 is unavailable (owner's wording: "the retailer has not
 * bought this item before"). Shown in place of the API's raw `items must contain at least 1
 * elements`, which is all an empty re-quote ever produced.
 */
export const NOTHING_BOUGHT_BEFORE_MESSAGE =
  "This customer hasn't bought these items before — there's no invoice to return them against.";

/**
 * #2693: option 3 is only possible when the quote matched at least one piece to an invoice line.
 * With zero covered pieces `dropExcessAndRequote` would build an EMPTY request, so the option is
 * disabled and the re-quote is never sent. The one predicate web and mobile both use.
 */
export function canReturnOnlyPurchased(quote: InlineReturnQuoteResponse): boolean {
  for (const pieces of coveredPiecesByProduct(quote).values()) if (pieces > 0) return true;
  return false;
}

/**
 * #2693: the products option 3 would drop entirely (excess on the quote, nothing covered), named
 * from the operator's own lines in line order, each once. For the "Not bought before: …" note
 * shown when option 3 is still possible for the other products.
 */
export function notBoughtBeforeNames(
  quote: InlineReturnQuoteResponse,
  lines: ReadonlyArray<Pick<InlineReturnLineDraft, "productId" | "productName">>,
): string[] {
  const covered = coveredPiecesByProduct(quote);
  const dropped = new Set(
    quote.chunks
      .filter(
        (c) => c.sourceOrderId == null && c.pieces > 0 && !((covered.get(c.productId) ?? 0) > 0),
      )
      .map((c) => c.productId),
  );
  const names: string[] = [];
  for (const line of lines) {
    if (dropped.has(line.productId) && !names.includes(line.productName)) {
      names.push(line.productName);
    }
  }
  return names;
}

export function dropExcessAndRequote(
  customerId: string,
  quote: InlineReturnQuoteResponse,
  routeRunStopId?: string,
  /** #2695: the lines the quote came from — a product's credit price override (its FIRST row's,
   *  the same rule the request merge uses) carries into the re-quote, so the reduced quote and
   *  the capture that follows price the same chunks. */
  lines: Pick<InlineReturnLineDraft, "productId" | "creditUnitPrice" | "overrideReason">[] = [],
  /** SA-740: the re-quote stays pinned to the same source sale the first quote was. */
  sourceOrderId?: string,
): QuoteInlineReturnRequest {
  const firstLine = (productId: string) => lines.find((l) => l.productId === productId);
  const items: QuoteInlineReturnItem[] = [...coveredPiecesByProduct(quote).entries()]
    .filter(([, pieces]) => pieces > 0)
    .map(([productId, pieces]) => {
      const line = firstLine(productId);
      return { productId, qty: 1, boxes: 0, pieces, ...(line ? overrideFields(line) : {}) };
    });
  return quoteRequestOf(customerId, items, routeRunStopId, sourceOrderId);
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
 * server recomputes through the same pricing engine at capture time. The one price it may carry
 * is a staff member's own typed credit override (#2695) — the same one its quote sent, and still
 * capped server-side at the engine's default.
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
  /** SA-740: the SAME source sale the quote priced (a walk-in defaults to `orderId` server-side when omitted). */
  sourceOrderId?: string;
}): CaptureInlineReturnRequest {
  const items: CaptureInlineReturnItem[] = mergeDuplicateProductItems(
    params.lines
      .map((l) => ({
        productId: l.productId,
        boxes: parseNonNegativeInt(l.boxes),
        pieces: parseNonNegativeInt(l.pieces),
        reason: l.reason || undefined,
        condition: l.note.trim() || undefined,
        alreadyReturnedReason: l.alreadyReturnedReason?.trim() || undefined,
        ...overrideFields(l),
      }))
      .filter((i) => i.boxes > 0 || i.pieces > 0),
  ).map((i) => ({
    productId: i.productId,
    qty: 1,
    boxes: i.boxes,
    pieces: i.pieces,
    ...(i.reason ? { reason: i.reason } : {}),
    ...(i.condition ? { condition: i.condition } : {}),
    ...(i.alreadyReturnedReason ? { alreadyReturnedReason: i.alreadyReturnedReason } : {}),
    ...(i.creditUnitPrice !== undefined
      ? { creditUnitPrice: i.creditUnitPrice, overrideReason: i.overrideReason }
      : {}),
  }));

  return {
    customerId: params.customerId,
    orderId: params.orderId,
    items,
    returnKey: params.returnKey,
    reason: params.reason,
    ...(params.routeRunStopId ? { routeRunStopId: params.routeRunStopId } : {}),
    ...(params.sourceOrderId ? { sourceOrderId: params.sourceOrderId } : {}),
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

/** B948: an inline return that would credit a source invoice line past its value (a credit note or an earlier return took part of it). */
export const INLINE_RETURN_OVER_LINE_HEADROOM_CODE = "RETURN_REFUND_OVER_LINE_HEADROOM";
export const INLINE_RETURN_OVER_LINE_HEADROOM_MESSAGE =
  "This return would credit more than the invoice line is worth, because part of it was already credited (by a credit note or an earlier return). Lower the quantity, or issue the credit note manually.";

/**
 * A write refused by a READ_ONLY workspace (403, code READ_ONLY). The sentence is the owner's read-only sentence,
 * web's `readOnlyLine(null, false)` (`READ_ONLY_SENTENCE`, packages/types/read-only-copy.ts), kept equal by a web
 * parity test; this package cannot import apps/web.
 */
export const INLINE_RETURN_READ_ONLY_MESSAGE =
  "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable.";

export function extractRefusalMessage(error: unknown, fallback = "Something went wrong"): string {
  const body = (error as ApiErrorLike | undefined)?.response?.data;
  const status = (error as ApiErrorLike | undefined)?.response?.status;
  // Before the 403 branch below: a READ_ONLY workspace has the permission; it is read-only, and the guard text is never shown.
  if (body?.code === "READ_ONLY") return INLINE_RETURN_READ_ONLY_MESSAGE;
  if (status === 403 && (body?.code == null || ENTITLEMENT_GATE_CODES.has(body.code))) {
    return RETURNS_NOT_ENABLED_MESSAGE;
  }
  // fixed copy by code, never the server message (house rule: no raw server strings in the UI)
  if (body?.code === INLINE_RETURN_OVER_LINE_HEADROOM_CODE) {
    return INLINE_RETURN_OVER_LINE_HEADROOM_MESSAGE;
  }
  if (!body?.message) return fallback;
  return Array.isArray(body.message) ? body.message.join(" ") : body.message;
}
