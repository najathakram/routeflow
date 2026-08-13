/**
 * Wedge-scanner search-field guards: Enter-as-scan and auto-add fire ONLY for
 * digit codes with exactly one exact match — a name search must never
 * auto-add, and a shared code must fall back to the human.
 */
import { findExactScanMatch, looksLikeScanCode } from "../lib/wedge-scan";

describe("looksLikeScanCode", () => {
  it.each([
    ["6971824065183", true], // EAN-13 (the reported wholesaler scan)
    ["12345678", true], // EAN-8 lower bound
    [" 042100005264 ", true], // wedge padding trimmed
    ["1234567", false], // too short
    ["cola", false],
    ["FOGER-45", false], // alnum SKU — suggestion list + tap, never auto
    ["", false],
  ] as const)("%j → %s", (term, expected) => {
    expect(looksLikeScanCode(term)).toBe(expected);
  });
});

describe("findExactScanMatch", () => {
  const products = [
    { id: "p1", barcode: "6971824065183", sku: "FOG-DF", unitSku: null },
    { id: "p2", barcode: null, sku: "COLA-12", unitSku: "COLA-1" },
    { id: "p3", barcode: "0042100005264", sku: null, unitSku: null },
  ];

  it("matches an exact barcode", () => {
    const r = findExactScanMatch("6971824065183", products);
    expect(r.match?.id).toBe("p1");
    expect(r.multiple).toBe(false);
  });

  it("matches through the normalizeScanCode candidate set (leading-zero variants)", () => {
    // A 12-digit UPC-A decode must find the 13-digit zero-padded stored code.
    const r = findExactScanMatch("042100005264", products);
    expect(r.match?.id).toBe("p3");
  });

  it("matches sku and unitSku case-insensitively", () => {
    expect(findExactScanMatch("cola-12", products).match?.id).toBe("p2");
    expect(findExactScanMatch("COLA-1", products).match?.id).toBe("p2");
  });

  it("returns nothing on a name-ish term", () => {
    expect(findExactScanMatch("cola", products)).toEqual({ match: null, multiple: false });
  });

  it("refuses to pick between two products sharing a code", () => {
    const dup = [...products, { id: "p4", barcode: "6971824065183" }];
    const r = findExactScanMatch("6971824065183", dup);
    expect(r.match).toBeNull();
    expect(r.multiple).toBe(true);
  });
});
