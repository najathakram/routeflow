import { legacyLinePieces, roundMoney } from "@routeflow/pricing";

/**
 * #2118 — the pure rules of the sales-facts layer (plan A3/A6/A7). Every reader in
 * `apps/api/src/sales-facts/` calls these; none restates them (L-167). No I/O here.
 */

// ─── Selling unit (plan A6) ──────────────────────────────────────────────────

/** The stored shape of a sold line this module reads. */
export interface SaleLineShape {
  boxes?: number | null;
  pieces?: number | null;
  /** The line's own sale-time pack snapshot. */
  unitsPerBox?: number | null;
}

/**
 * The line's piece count, or null when the stored line cannot say (the pack-snapshot rule: a
 * stored line's pack is its OWN snapshot; the live product pack never reinterprets it). Every
 * pieces total and every per-piece figure reads this — never `qty` directly.
 *
 * Classified by the ONE sanctioned classifier (`legacyLinePieces`, no source line): a split line
 * counts its qty as pieces; otherwise the "is it boxed" gate is the line's own snapshot when it
 * has one, and only a snapshot-less line falls back to the live pack — as a gate, never a
 * multiplier. So a no-split line with a boxed snapshot (B644: its qty may count boxes) is
 * unknown, whatever the product's pack is today. A zero qty is zero pieces on any axis.
 */
export function salePiecesOf(
  line: SaleLineShape & { qty: number },
  productPackNow: number | null | undefined,
): number | null {
  const qty = Number(line.qty);
  if (qty === 0) return 0;
  const snapshot = line.unitsPerBox == null ? null : Number(line.unitsPerBox);
  const gate =
    snapshot != null
      ? { productPackNow: snapshot }
      : productPackNow === undefined
        ? {}
        : { productPackNow };
  const res = legacyLinePieces(
    {
      qty,
      boxes: line.boxes ?? null,
      pieces: line.pieces ?? null,
      unitsPerBox: snapshot,
    },
    null,
    gate,
  );
  return "unknown" in res ? null : res.pieces;
}

/**
 * The line's selling unit in pieces (its sale-time pack), or null when it cannot be known.
 * Pieces (`InvoiceItem.qty`) are canonical; this only decides whether a line can also be
 * expressed in selling units. Never multiplies or guesses from today's pack:
 *
 * - A split line (`boxes`/`pieces` given) sells by its snapshot pack when that is > 1; a split
 *   without a usable snapshot is a pre-snapshot row — unknown.
 * - No split and snapshot 1: a factor-1 unit line — sells by the piece.
 * - No split and snapshot > 1: the ambiguous boxed shape (qty may count boxes, B644) — unknown.
 * - No split, no snapshot: writers store a null snapshot for a never-boxed product, so the
 *   CURRENT pack is consulted as a GATE only (as `legacyLinePieces` does): not boxed today →
 *   sells by the piece; boxed today, or the product was not supplied (`undefined`) → unknown.
 */
export function salePackOf(
  line: SaleLineShape,
  productPackNow: number | null | undefined,
): number | null {
  const snapshot = line.unitsPerBox == null ? null : Number(line.unitsPerBox);
  const hasSplit = line.boxes != null || line.pieces != null;
  if (hasSplit) return snapshot != null && snapshot > 1 ? snapshot : null;
  if (snapshot != null) return snapshot === 1 ? 1 : null;
  if (productPackNow === undefined) return null;
  return productPackNow == null || Number(productPackNow) <= 1 ? 1 : null;
}

/** Effective price per piece (subtotal ÷ pieces), in cents; null for a zero/negative qty. */
export function perPieceOf(subtotal: number, qtyPieces: number): number | null {
  return qtyPieces > 0 ? roundMoney(subtotal / qtyPieces) : null;
}

/**
 * A purchase event: one per order however many invoices billed it (partial invoicing), one per
 * invoice raised without an order.
 */
export function purchaseEventKey(orderId: string | null | undefined, invoiceId: string): string {
  return orderId ? `o:${orderId}` : `i:${invoiceId}`;
}

// ─── Credit attribution (plan A3: stored line facts only) ────────────────────

export interface CreditAttribution {
  /** productId → credited amount (cents). */
  byProduct: Map<string, number>;
  /** Items on an existing UNLISTED (ad-hoc, product-less) line: attributed, to no product. */
  unlisted: number;
  /**
   * The rest of the credit (cents): the amount-only part no stored item row carries (a header-
   * only note, the tax part of an INLINE refund, a STANDARD refund), plus an item whose line id
   * no longer exists (a delivered-basis reconcile rotates line ids) — never guessed.
   */
  unattributed: number;
}

function sumByProduct(parts: { productId: string | null | undefined; amount: number }[]) {
  const raw = new Map<string, number>();
  for (const p of parts) {
    if (!p.productId) continue;
    raw.set(p.productId, (raw.get(p.productId) ?? 0) + p.amount);
  }
  const byProduct = new Map<string, number>();
  let attributed = 0;
  for (const [productId, amount] of raw) {
    const rounded = roundMoney(amount);
    byProduct.set(productId, rounded);
    attributed += rounded;
  }
  return { byProduct, attributed };
}

/**
 * Splits one credit note by its stored `CreditNoteItem` rows (SA-289): EVERY item attributes
 * through its line, whatever the line's regulated category (`trackedCategoryId` is never read —
 * an ordinary-product line is a product line). An item whose `invoiceItemId` maps (through
 * `lineProduct`, built from the source invoice's lines) to a listed product counts for that
 * product; one on an existing unlisted line is `unlisted`. Only what no item carries (the
 * amount-only part) and an item whose line id no longer exists are `unattributed`. The three
 * parts always sum to the note's amount. Never prorates at read time.
 */
export function attributeCreditNote(
  cn: { amount: number; items: { invoiceItemId: string | null; amount: number }[] },
  lineProduct: Map<string, string | null>,
): CreditAttribution {
  const { byProduct, attributed } = sumByProduct(
    cn.items.map((it) => ({
      productId: it.invoiceItemId ? lineProduct.get(it.invoiceItemId) : null,
      amount: Number(it.amount),
    })),
  );
  let unlistedRaw = 0;
  for (const it of cn.items) {
    if (it.invoiceItemId && lineProduct.has(it.invoiceItemId)) {
      if (lineProduct.get(it.invoiceItemId) == null) unlistedRaw += Number(it.amount);
    }
  }
  const unlisted = roundMoney(unlistedRaw);
  return {
    byProduct,
    unlisted,
    unattributed: roundMoney(Number(cn.amount) - attributed - unlisted),
  };
}

/**
 * Splits one EXTERNAL_REFUND return. An INLINE return prices each line (`ReturnItem.subtotal`,
 * pre-tax), so those are attributed and the remainder (tax, rounding) is not. A STANDARD
 * return stores one lump `refundAmount` — wholly unattributed.
 */
export function attributeExternalRefund(ret: {
  kind: string;
  refundAmount: number;
  items: { productId: string | null; subtotal: number | null }[];
}): CreditAttribution {
  if (ret.kind !== "INLINE") {
    return {
      byProduct: new Map(),
      unlisted: 0,
      unattributed: roundMoney(Number(ret.refundAmount)),
    };
  }
  const { byProduct, attributed } = sumByProduct(
    ret.items
      .filter((it) => it.subtotal != null)
      .map((it) => ({ productId: it.productId, amount: Number(it.subtotal) })),
  );
  return {
    byProduct,
    unlisted: 0, // a return line always names its product
    unattributed: roundMoney(Number(ret.refundAmount) - attributed),
  };
}

/**
 * The instant a return's QUANTITY nets — the same event its money nets on (B440): an external
 * refund on `refundedAt` (the Return term); any other resolution through its credit note's
 * `createdAt` (the CreditNote term). `creditNotes` holds only notes that net: the readers build it
 * from reads that apply ACCRUAL_CREDIT_NOTE_FILTER, so a VOID note is simply absent (L-167 — the
 * status rule lives in that one predicate, never restated here). No netting event → null
 * (a RECEIVED return, or a resolution whose credit note never landed).
 */
export function returnNettingDate(
  ret: { refundMethod: string | null; refundedAt: Date | null; creditNoteId: string | null },
  creditNotes: Map<string, { createdAt: Date }>,
): Date | null {
  if (ret.refundMethod === "EXTERNAL_REFUND") return ret.refundedAt ?? null;
  if (!ret.creditNoteId) return null;
  const cn = creditNotes.get(ret.creditNoteId);
  return cn ? cn.createdAt : null;
}

// ─── Line cursor (plan §B: page by LINE, never by invoice) ───────────────────

/**
 * Sort key of one sold line, newest first: issue date, then invoice (createdAt, id), then line
 * (createdAt, id). Every page and every CSV chunk orders by exactly this key, and the cursor
 * carries all of it, so two pages never overlap or skip (SA-289). It is a stable PAGING order,
 * not the invoice's printed line order: lines written in one statement share a createdAt and
 * then fall back to id order.
 */
export interface LineKey {
  issueDate: Date;
  invoiceCreatedAt: Date;
  invoiceId: string;
  lineCreatedAt: Date;
  lineId: string;
}

/** A sold line's sort key (the cursor and every newest-first comparison use it). */
export function lineKeyOf(line: {
  issueDate: Date;
  invoiceCreatedAt: Date;
  invoiceId: string;
  lineCreatedAt: Date;
  lineId: string;
}): LineKey {
  return {
    issueDate: line.issueDate,
    invoiceCreatedAt: line.invoiceCreatedAt,
    invoiceId: line.invoiceId,
    lineCreatedAt: line.lineCreatedAt,
    lineId: line.lineId,
  };
}

export class InvalidLineCursorError extends Error {
  constructor() {
    super("cursor is not a cursor this endpoint issued");
    this.name = "InvalidLineCursorError";
  }
}

export function encodeLineCursor(key: LineKey): string {
  return Buffer.from(
    JSON.stringify([
      key.issueDate.toISOString(),
      key.invoiceCreatedAt.toISOString(),
      key.invoiceId,
      key.lineCreatedAt.toISOString(),
      key.lineId,
    ]),
    "utf8",
  ).toString("base64url");
}

export function decodeLineCursor(cursor: string): LineKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidLineCursorError();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 5 ||
    !parsed.every((v) => typeof v === "string" && v.length > 0 && v.length <= 64)
  ) {
    throw new InvalidLineCursorError();
  }
  const [issueDate, invoiceCreatedAt, invoiceId, lineCreatedAt, lineId] = parsed as string[];
  return {
    issueDate: exactInstant(issueDate),
    invoiceCreatedAt: exactInstant(invoiceCreatedAt),
    invoiceId,
    lineCreatedAt: exactInstant(lineCreatedAt),
    lineId,
  };
}

/** An ISO instant exactly as `encodeLineCursor` wrote it — anything else is a forged cursor. */
function exactInstant(iso: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.toISOString() !== iso) throw new InvalidLineCursorError();
  return d;
}

const time = (d: Date | null | undefined) => (d ? d.getTime() : 0);
const cmpDesc = (a: number | string, b: number | string) => (a > b ? -1 : a < b ? 1 : 0);

/** Comparator for newest-first order; negative when `a` is newer than `b`. */
export function compareLineKeysDesc(a: LineKey, b: LineKey): number {
  return (
    cmpDesc(time(a.issueDate), time(b.issueDate)) ||
    cmpDesc(time(a.invoiceCreatedAt), time(b.invoiceCreatedAt)) ||
    cmpDesc(a.invoiceId ?? "", b.invoiceId ?? "") ||
    cmpDesc(time(a.lineCreatedAt), time(b.lineCreatedAt)) ||
    cmpDesc(a.lineId ?? "", b.lineId ?? "")
  );
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

export { csvCell } from "../common/csv";
