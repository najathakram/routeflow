/** Insufficient-stock 409 shape + helpers (gap 05). Pure, import-free: mobile jest resolves this file
 *  directly (its `@routeflow/types` is a hand stub), so keep it that way. */
// ── Insufficient stock (gap 05) ─────────────────────────────────────────────────────────────
/** One product a stock-blocked order or edit could not cover. */
export interface InsufficientStockLine {
  productId: string;
  name?: string;
  available: number;
  requested: number;
}

/** The 409 body order create, DRAFT→PENDING promotion and order edit answer with when a buyer
 *  asks for more than is on hand. `productId`/`available`/`requested` mirror `lines[0]` (the
 *  edit path's original shape, kept for older clients). */
export interface InsufficientStockError {
  code: "INSUFFICIENT_STOCK";
  message: string;
  lines: InsufficientStockLine[];
  productId?: string;
  available?: number;
  requested?: number;
}

/** The InsufficientStockError inside an axios-shaped error (`response.data`) or a bare body, else
 *  null — a 409 for any other reason is NOT one. */
export function parseInsufficientStock(err: unknown): InsufficientStockError | null {
  const e = err as { response?: { data?: unknown } } | null | undefined;
  const body = (e?.response?.data ?? err) as Partial<InsufficientStockError> | null | undefined;
  if (!body || typeof body !== "object" || body.code !== "INSUFFICIENT_STOCK") return null;
  const lines = Array.isArray(body.lines)
    ? body.lines
    : body.productId != null && body.available != null && body.requested != null
      ? [{ productId: body.productId, available: body.available, requested: body.requested }]
      : [];
  return { code: "INSUFFICIENT_STOCK", message: body.message ?? "", lines };
}

/** A sentence a person can act on — never the server's raw text. "Only 4 Mango 5ct left." /
 *  "Mango 5ct is out of stock." / "Only 4 Mango 5ct and 2 Lime left." */
export function insufficientStockSentence(lines: InsufficientStockLine[]): string {
  if (lines.length === 0) return "Some items aren't available in the quantity you asked for.";
  const left = lines.filter((l) => l.available > 0);
  const out = lines.filter((l) => l.available <= 0);
  const parts: string[] = [];
  if (left.length > 0) {
    const list = left.map((l) =>
      l.name?.trim() ? `${l.available} ${l.name.trim()}` : `${l.available} of an item`,
    );
    parts.push(`Only ${joinAnd(list)} left.`);
  }
  if (out.length > 0) {
    const names = out.map((l) => l.name?.trim() || "An item");
    parts.push(`${joinAnd(names)} ${names.length === 1 ? "is" : "are"} out of stock.`);
  }
  return parts.join(" ");
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
