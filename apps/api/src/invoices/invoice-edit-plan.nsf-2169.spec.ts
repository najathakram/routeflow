import {
  buildEditedLines,
  inPlacePatch,
  matchEditLines,
  type StoredEditRow,
} from "./invoice-edit-plan";

/**
 * #2169 (SA-395, point 3) — the invoice edit path must never touch `systemKind`: an untouched
 * stamped row keeps it (no key in the patch at all — Prisma leaves an omitted column alone), a
 * CHANGED stamped row's re-price must not clear it either (again: no key in the patch), and a
 * brand-new line is created with no `systemKind` key (the column defaults to NULL). Exercises the
 * REAL pure functions `matchEditLines` / `buildEditedLines` / `inPlacePatch` that
 * `InvoicesService.update()` calls (invoices.service.ts ~3339-3434) — no DB, no service mock.
 */
describe("#2169 invoice edit path never writes systemKind (SA-395 point 3)", () => {
  const stampedRow: StoredEditRow = {
    id: "row-1",
    invoiceId: "inv-1",
    productId: null,
    description: "Bounce handling charge",
    qty: 1,
    unitPrice: 25,
    discount: 0,
    taxRate: 0,
    subtotal: 25,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    promoFreeUnits: null,
    notes: null,
    orderItemId: null,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
    categoryTaxAmount: 0,
    systemKind: "NSF_FEE",
  };

  const ctxFor = (items: any[], stored: StoredEditRow[]) => ({
    items,
    stored,
    matches: matchEditLines(items, stored),
    productMap: new Map(),
    categoryMap: new Map(),
    clampFreeUnits: (free: number | undefined) => free ?? 0,
    warn: () => undefined,
  });

  it("an UNTOUCHED stamped row: buildEditedLines carries systemKind in `data`, but inPlacePatch never puts it in the write", () => {
    const item = {
      id: "row-1",
      description: "Bounce handling charge",
      qty: 1,
      unitPrice: 25,
      discount: 0,
      taxRate: 0,
    };
    const [line] = buildEditedLines(ctxFor([item], [stampedRow]) as any);
    expect(line.untouched).toBe(true);
    // The in-memory plan line still carries the row's systemKind (it spreads `...row`) —
    // it is the WRITE that must omit it, checked next.
    expect(line.data.systemKind).toBe("NSF_FEE");
    const patch = inPlacePatch(line, stampedRow);
    expect(patch === null || !("systemKind" in patch)).toBe(true);
  });

  it("a CHANGED (re-priced) stamped row: the write patch has no systemKind key at all — a partial update never clears the stored value", () => {
    const item = {
      id: "row-1",
      description: "Bounce handling charge",
      qty: 2, // re-priced: qty differs from the stored row's 1
      unitPrice: 25,
      discount: 0,
      taxRate: 0,
    };
    const [line] = buildEditedLines(ctxFor([item], [stampedRow]) as any);
    expect(line.untouched).toBe(false);
    expect(line.data).not.toHaveProperty("systemKind");
    const patch = inPlacePatch(line, stampedRow);
    expect(patch).not.toBeNull();
    expect(patch).not.toHaveProperty("systemKind");
  });

  it("a NEWLY ADDED line (no stored row): created without a systemKind key (column defaults to NULL)", () => {
    const item = {
      description: "Custom freight",
      qty: 1,
      unitPrice: 15,
      discount: 0,
      taxRate: 0,
    };
    const [line] = buildEditedLines(ctxFor([item], []) as any);
    expect(line.rowId).toBeNull();
    expect(line.data).not.toHaveProperty("systemKind");
    // Mirrors invoices.service.ts's create-branch mapping exactly (`{ ...l.data, tenantId }`).
    const created = { ...line.data, tenantId: "tenant-1" };
    expect(created).not.toHaveProperty("systemKind");
  });
});
