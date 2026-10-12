import { readFileSync } from "fs";
import { join } from "path";
import { invoiceTaxLines } from "../lib/invoice-tax-lines";

// Row 398: the operator invoice detail shows the regular tax and each regulated charge as their own rows.
describe("invoiceTaxLines (row 398)", () => {
  const crv = {
    categoryTaxAmount: "2.80",
    trackedCategoryId: "cat-crv",
    trackedCategory: { id: "cat-crv", name: "CRV", taxType: "DEPOSIT_PER_CONTAINER" },
  };

  it("header 5.40 with a 2.80 deposit is Tax 2.60 and 'CRV deposit' 2.80", () => {
    expect(invoiceTaxLines({ taxAmount: 5.4, items: [crv, { categoryTaxAmount: 0 }] })).toEqual({
      tax: 2.6,
      charges: [{ key: "cat-crv", label: "CRV deposit", amount: 2.8 }],
    });
  });

  it("names a levy from the snapshot type when the category row is not on the payload", () => {
    const out = invoiceTaxLines({
      taxAmount: "2",
      items: [
        { categoryTaxAmount: 2, trackedCategoryId: "cat-t", categoryTaxType: "EXCISE_PER_UNIT" },
      ],
    });
    expect(out).toEqual({ tax: 0, charges: [{ key: "cat-t", label: "Excise", amount: 2 }] });
  });

  it("no levy: the whole header is Tax and there are no charges; an exempt invoice is all zero", () => {
    expect(invoiceTaxLines({ taxAmount: 3.3, items: [{ categoryTaxAmount: 0 }] })).toEqual({
      tax: 3.3,
      charges: [],
    });
    expect(invoiceTaxLines({ taxAmount: 0, items: [] })).toEqual({ tax: 0, charges: [] });
    expect(invoiceTaxLines({ taxAmount: 0 })).toEqual({ tax: 0, charges: [] });
  });

  it("a header too small to hold its lines' levy is shown whole, never negative", () => {
    expect(invoiceTaxLines({ taxAmount: 1, items: [crv] })).toEqual({ tax: 1, charges: [] });
  });
});

describe("operator invoice detail screen wiring (source-pinned: RN screens are not renderable in this lane)", () => {
  const src = readFileSync(
    join(__dirname, "..", "app/(operator)/(tabs)/invoices/[id].tsx"),
    "utf8",
  );

  it("shows Tax from invoiceTaxLines and one row per named charge, not the raw header", () => {
    expect(src).toMatch(/invoiceTaxLines\(/);
    expect(src).toMatch(/charges\.map\(/);
    expect(src).not.toMatch(/fmtCurrency\(invoice\.taxAmount\)/);
  });
});
