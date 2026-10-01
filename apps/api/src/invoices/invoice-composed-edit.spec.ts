import { API_ERROR_CODES } from "../common/api-error-codes";
import { applyComposedLineEdits } from "./invoice-composed-edit";

/**
 * #2717 M3 (SA-579 case 18, Q6): a DRAFT invoice edit and its composed lines. An untouched composed
 * row keeps its ids and rows; a price change re-stamps displayUnitPrice4 on the invoice line's own
 * net; a whole-box quantity change rebuilds the component rows from the stored ones; any other
 * quantity change is a 409; and a non-DRAFT invoice never has its component rows written.
 */
const stored = (o: Record<string, unknown> = {}) => ({
  id: "row-1",
  qty: 48,
  unitsPerBox: 24,
  subtotal: 60,
  compositionMode: "FIXED",
  ...o,
});
const comps = [
  {
    componentProductId: "a",
    qty: 24,
    name: "A",
    unitSku: "SA",
    unitBarcode: "1",
    barcodeSymbology: "CODE128",
    position: 0,
  },
  {
    componentProductId: "o",
    qty: 24,
    name: "O",
    unitSku: "SO",
    unitBarcode: "2",
    barcodeSymbology: "CODE128",
    position: 1,
  },
];
const edited = (data: Record<string, unknown>, untouched = false) => ({
  rowId: "row-1",
  untouched,
  data,
});

function tx() {
  return {
    invoiceItemComponent: {
      findMany: jest.fn().mockResolvedValue(comps),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
  };
}
const run = (t: ReturnType<typeof tx>, over: Record<string, unknown>) => {
  const o = {
    invoiceStatus: "DRAFT",
    storedRows: [stored()],
    editLines: [edited({ qty: 48, subtotal: 60, unitsPerBox: 24 })],
    ...over,
  } as { invoiceStatus: string; storedRows: unknown[]; editLines: unknown[] };
  return applyComposedLineEdits(
    t as never,
    { id: "inv-1", status: o.invoiceStatus, tenantId: "t-1" },
    o.editLines as never,
    o.storedRows as never,
  );
};
const noWrites = (t: ReturnType<typeof tx>) => {
  expect(t.invoiceItemComponent.updateMany).not.toHaveBeenCalled();
  expect(t.invoiceItemComponent.deleteMany).not.toHaveBeenCalled();
  expect(t.invoiceItemComponent.createMany).not.toHaveBeenCalled();
};

describe("applyComposedLineEdits (case 18)", () => {
  it("a non-DRAFT invoice refuses component writes, before any query", async () => {
    const t = tx();
    await expect(run(t, { invoiceStatus: "SENT" })).rejects.toThrow();
    expect(t.invoiceItemComponent.findMany).not.toHaveBeenCalled();
    noWrites(t);
  });

  it("no composed stored row: nothing is read or written", async () => {
    const t = tx();
    await run(t, { storedRows: [stored({ compositionMode: null })] });
    expect(t.invoiceItemComponent.findMany).not.toHaveBeenCalled();
    noWrites(t);
  });

  it("an untouched composed row keeps its ids: no writes", async () => {
    const t = tx();
    await run(t, { editLines: [edited({ qty: 48, subtotal: 60, unitsPerBox: 24 }, true)] });
    noWrites(t);
  });

  it("a price change re-stamps displayUnitPrice4 on the line's own net (90 / 48 = 1.875)", async () => {
    const t = tx();
    await run(t, { editLines: [edited({ qty: 48, subtotal: 90, unitsPerBox: 24 })] });
    expect(t.invoiceItemComponent.updateMany).toHaveBeenCalledWith({
      where: { invoiceItemId: "row-1", tenantId: "t-1" },
      data: { displayUnitPrice4: 1.875 },
    });
    expect(t.invoiceItemComponent.createMany).not.toHaveBeenCalled();
  });

  it("a whole-box quantity change rebuilds the rows from the stored ones (2 -> 3 boxes = [36,36] at 90 / 72)", async () => {
    const t = tx();
    await run(t, { editLines: [edited({ qty: 72, subtotal: 90, unitsPerBox: 24 })] });
    expect(t.invoiceItemComponent.deleteMany).toHaveBeenCalledWith({
      where: { invoiceItemId: "row-1", tenantId: "t-1" },
    });
    const rows = t.invoiceItemComponent.createMany.mock.calls[0][0].data;
    expect(rows.map((r: { qty: number }) => r.qty)).toEqual([36, 36]);
    expect(
      rows.every(
        (r: { displayUnitPrice4: number; tenantId: string; invoiceItemId: string }) =>
          r.displayUnitPrice4 === 1.25 && r.tenantId === "t-1" && r.invoiceItemId === "row-1",
      ),
    ).toBe(true);
    expect(rows[0]).toMatchObject({ componentProductId: "a", name: "A", unitSku: "SA" });
  });

  it("any other quantity change is a 409 COMPOSED_LINE_EDIT with no writes", async () => {
    for (const qty of [50, 12]) {
      const t = tx();
      await expect(
        run(t, { editLines: [edited({ qty, subtotal: 60, unitsPerBox: 24 })] }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: API_ERROR_CODES.COMPOSED_LINE_EDIT },
      });
      noWrites(t);
    }
  });

  it("a loose-pieces split on a whole-box quantity change is also a 409", async () => {
    const t = tx();
    await expect(
      run(t, { editLines: [edited({ qty: 72, pieces: 3, subtotal: 60, unitsPerBox: 24 })] }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
