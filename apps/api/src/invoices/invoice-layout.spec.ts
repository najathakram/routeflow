import { INVOICE_LAYOUT_KEYS, parseInvoiceLayout, readInvoiceLayout } from "./invoice-layout";

const NAMES = Object.keys(INVOICE_LAYOUT_KEYS) as (keyof typeof INVOICE_LAYOUT_KEYS)[];

describe('parseInvoiceLayout (T1, guard: master\'s `=== "true"` rule)', () => {
  it.each(NAMES)('%s: only the string "true" hides', (name) => {
    const key = INVOICE_LAYOUT_KEYS[name];
    const cases: [Record<string, string | null | undefined>, boolean][] = [
      [{}, false],
      [{ [key]: "" }, false],
      [{ [key]: "false" }, false],
      [{ [key]: "TRUE" }, false],
      [{ [key]: "1" }, false],
      [{ [key]: null }, false],
      [{ [key]: undefined }, false],
      [{ [key]: "true" }, true],
    ];
    for (const [raw, expected] of cases) {
      const layout = parseInvoiceLayout(raw);
      expect(layout[name]).toBe(expected);
      // the other two switches are untouched by this key
      for (const other of NAMES.filter((n) => n !== name)) expect(layout[other]).toBe(false);
    }
  });

  it("keys keep their stored names", () => {
    expect(INVOICE_LAYOUT_KEYS).toEqual({
      hideOriginalPrice: "invoice.hideOriginalPrice",
      hideBarcodes: "invoice.hideBarcodes",
      hidePerPiece: "invoice.hidePerPiece",
    });
  });
});

describe("readInvoiceLayout (T2)", () => {
  it('issues one getAll("invoice.") and never a get', async () => {
    const getAll = jest.fn().mockResolvedValue({
      "invoice.hideBarcodes": "true",
      "invoice.defaultTerms": "Net 30",
    });
    const get = jest.fn();
    const layout = await readInvoiceLayout({ getAll, get } as never);
    expect(getAll).toHaveBeenCalledTimes(1);
    expect(getAll).toHaveBeenCalledWith("invoice.");
    expect(get).not.toHaveBeenCalled();
    expect(layout).toEqual({ hideOriginalPrice: false, hideBarcodes: true, hidePerPiece: false });
  });
});
