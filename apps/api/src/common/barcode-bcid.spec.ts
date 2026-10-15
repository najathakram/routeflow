import { bcidFor } from "./barcode-bcid";

/**
 * #2717 M3 (SA-579 Q4): the bwip-js `bcid` for a unit barcode. Native UPC-A / EAN-13 / EAN-8 only
 * when the code's check digit validates; everything else prints as code128 so a bad check digit
 * never makes the renderer throw. Codes below are hand-checked (mod-10, weights 3/1 from the right).
 */
describe("bcidFor", () => {
  it("UPC_A with a valid check digit -> upca", () => {
    expect(bcidFor("UPC_A", "036000291452")).toBe("upca");
  });
  it("UPC_A with a bad check digit -> code128", () => {
    expect(bcidFor("UPC_A", "036000291453")).toBe("code128");
  });
  it("EAN_13 with a valid check digit -> ean13, bad -> code128", () => {
    expect(bcidFor("EAN_13", "4006381333931")).toBe("ean13");
    expect(bcidFor("EAN_13", "4006381333932")).toBe("code128");
  });
  it("EAN_8 with a valid check digit -> ean8, bad -> code128", () => {
    expect(bcidFor("EAN_8", "96385074")).toBe("ean8");
    expect(bcidFor("EAN_8", "96385075")).toBe("code128");
  });
  it("a symbology that does not match the digit length -> code128", () => {
    expect(bcidFor("UPC_A", "4006381333931")).toBe("code128");
  });
  it("GTIN_14, CODE128, null and unknown symbologies -> code128", () => {
    expect(bcidFor("GTIN_14", "10036000291459")).toBe("code128");
    expect(bcidFor("CODE128", "ABC-123")).toBe("code128");
    expect(bcidFor(null, "036000291452")).toBe("code128");
    expect(bcidFor("QR", "036000291452")).toBe("code128");
  });
});
