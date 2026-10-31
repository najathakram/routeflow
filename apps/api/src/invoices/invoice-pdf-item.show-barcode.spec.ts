import { pdfSubLine } from "./invoice-pdf-item";

/** SA-1031: `pdfSubLine` takes the tenant's barcode choice as a REQUIRED third argument (the compiler finds every caller). */
const view = {
  name: "Cola",
  unitSku: "SKU-1",
  unitBarcode: "036000291452",
  barcodeSymbology: "UPC_A",
  qty: 6,
  displayUnitPrice4: 0.625,
} as never;

describe("pdfSubLine(view, barcodeDataUri, showBarcode)", () => {
  it("shown: carries the digits and the image it was given", () => {
    expect(pdfSubLine(view, "data:image/png;base64,AAA", true)).toMatchObject({
      unitSku: "SKU-1",
      barcodeText: "036000291452",
      barcodeDataUri: "data:image/png;base64,AAA",
    });
  });

  it("hidden: no digits and no image, even if an image was passed; the SKU and price text stay", () => {
    expect(pdfSubLine(view, "data:image/png;base64,AAA", false)).toMatchObject({
      unitSku: "SKU-1",
      barcodeText: null,
      barcodeDataUri: null,
      qtyText: "x 6",
      priceText: "$0.63 (included)",
    });
  });
});
