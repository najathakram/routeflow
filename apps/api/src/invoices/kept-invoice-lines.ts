/**
 * B297 PR4 (SA-734r2 R6): which of a draft's existing InvoiceItem rows a rebuild may KEEP in place.
 *
 * `rebuildSiblingDrafts` used to delete every order-derived line and re-create it under a NEW id, so the
 * regulated ledger's `invoiceItemId` pointers (void, price correction, the return bridge all key on it) could
 * only be re-written by reversing and re-booking every line. A line whose LEDGER-RELEVANT shape (the columns
 * a SALE row is derived from: product, category, qty, split, pack, unit, subtotal and category tax) is
 * unchanged is now kept as the SAME row, with any other changed column (a note, a description, a price
 * label) written in place: its ledger rows stay valid, and a ledger re-sync of it writes nothing
 * (`RegulatedLedgerService.syncInvoiceEntries`). A line whose ledger-relevant shape changed is deleted and
 * re-created exactly as before, so it gets its one REVERSAL + SALE pair.
 *
 * Matched on `orderItemId` (the stable identity of an order-derived line). A line the rebuild writes with a
 * nested object (a composition line's `components`) is never kept: it is re-created as before.
 */
export function splitKeptItems(
  existing: Array<Record<string, any>>,
  itemsData: Array<Record<string, any>>,
): {
  keepIds: string[];
  /** Kept rows whose non-ledger columns changed: written in place under the same id. */
  updates: Array<{ id: string; data: Record<string, any> }>;
  create: Array<Record<string, any>>;
} {
  const used = new Set<string>();
  const keepIds: string[] = [];
  const updates: Array<{ id: string; data: Record<string, any> }> = [];
  const create: Array<Record<string, any>> = [];
  for (const data of itemsData) {
    const match =
      data.orderItemId && !hasNested(data)
        ? existing.find(
            (e) =>
              !used.has(e.id) && e.orderItemId === data.orderItemId && sameLedgerShape(e, data),
          )
        : undefined;
    if (!match) {
      create.push(data);
      continue;
    }
    used.add(match.id);
    keepIds.push(match.id);
    if (!sameLine(match, data)) updates.push({ id: match.id, data });
  }
  return { keepIds, updates, create };
}

/** The columns a regulated SALE row is derived from (`toSaleLedgerLines`): equal => the ledger rows stay valid. */
const LEDGER_KEYS = [
  "productId",
  "trackedCategoryId",
  "trackedSubcategoryId",
  "qty",
  "boxes",
  "pieces",
  "unitsPerBox",
  "unitLabel",
  "subtotal",
  "categoryTaxAmount",
] as const;

/**
 * SA-938: a Prisma nested (relation) write is always an object, so a value is nested when it is an object other
 * than a Date or a Decimal, or an array holding any such object. A top-level array of primitives (a scalar list
 * such as `restrictionOverrideRuleIds`, null elements allowed) is a VALUE: compared element-wise, never nested.
 */
export function isNestedWrite(v: unknown): boolean {
  if (Array.isArray(v)) return v.some((e) => isObjectWrite(e));
  return isObjectWrite(v);
}

function isObjectWrite(v: unknown): boolean {
  return (
    v != null &&
    typeof v === "object" &&
    !(v instanceof Date) &&
    typeof (v as { toNumber?: unknown }).toNumber !== "function"
  );
}

function hasNested(data: Record<string, any>): boolean {
  return Object.values(data).some(isNestedWrite);
}

function sameLedgerShape(row: Record<string, any>, data: Record<string, any>): boolean {
  return LEDGER_KEYS.every((k) => k in row && same(row[k], data[k]));
}

const norm = (v: unknown): unknown => {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "object") {
    const d = v as { toNumber?: () => number };
    return typeof d.toNumber === "function" ? d.toNumber() : undefined; // any other object: not comparable
  }
  return v;
};

function same(x: unknown, y: unknown): boolean {
  // SA-938 MUST 2: a scalar list compares element-wise IN ORDER (a reorder, or NULL vs [], is a change: one
  // in-place write, never a rebuild, as no list is a LEDGER_KEY).
  if (Array.isArray(x) || Array.isArray(y)) {
    return (
      Array.isArray(x) &&
      Array.isArray(y) &&
      x.length === y.length &&
      x.every((e, i) => same(e, y[i]))
    );
  }
  const a = norm(x);
  const b = norm(y);
  if (a === undefined || b === undefined) return false;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return a === b;
}

function sameLine(row: Record<string, any>, data: Record<string, any>): boolean {
  return Object.entries(data).every(([k, v]) => k in row && same(row[k], v));
}
