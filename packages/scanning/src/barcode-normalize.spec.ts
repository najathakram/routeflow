import {
  MAX_SCAN_CANDIDATES,
  normalizeScanCode,
  pickBestScanMatch,
  upcEToUpcA,
} from "./barcode-normalize";

describe("upcEToUpcA", () => {
  it("expands the 5-9 branch (last data digit carries into position 11)", () => {
    expect(upcEToUpcA("01234565")).toBe("012345000065");
  });

  it("expands the 0/1/2 branch", () => {
    // d = 123450, last digit 0 -> S d1 d2 d6 0000 d3 d4 d5 C
    expect(upcEToUpcA("01234500")).toBe("012000003450");
  });

  it("expands the 3 branch", () => {
    // d = 123453 -> "123" + "00000" + "45"
    expect(upcEToUpcA("01234530")).toBe("012300000450");
  });

  it("expands the 4 branch", () => {
    // d = 123454 -> "1234" + "00000" + "5"
    expect(upcEToUpcA("01234540")).toBe("012340000050");
  });

  it("keeps number system 1", () => {
    expect(upcEToUpcA("11234565")).toMatch(/^1/);
  });

  it("rejects non-UPC-E input", () => {
    expect(upcEToUpcA("21234565")).toBeNull(); // number system 2 isn't compressible
    expect(upcEToUpcA("1234567")).toBeNull(); // 7 digits
    expect(upcEToUpcA("ABCDEFGH")).toBeNull(); // not numeric
    expect(upcEToUpcA("")).toBeNull();
  });
});

describe("normalizeScanCode", () => {
  it("returns nothing for blank input", () => {
    expect(normalizeScanCode("")).toEqual([]);
    expect(normalizeScanCode("   ")).toEqual([]);
    expect(normalizeScanCode(undefined as unknown as string)).toEqual([]);
  });

  it("trims and keeps the literal first", () => {
    const out = normalizeScanCode("  0012345678905  ");
    expect(out[0]).toBe("0012345678905");
  });

  it("bridges EAN-13 to UPC-A (the iPhone-vs-web decoder mismatch)", () => {
    expect(normalizeScanCode("0012345678905")).toContain("012345678905");
  });

  it("bridges UPC-A to EAN-13 (the same mismatch, other direction)", () => {
    expect(normalizeScanCode("012345678905")).toContain("0012345678905");
  });

  it("expands UPC-E to both UPC-A and EAN-13", () => {
    const out = normalizeScanCode("01234565");
    expect(out).toContain("012345000065");
    expect(out).toContain("0012345000065");
  });

  it("unwraps a GTIN-14 / ITF-14 case code", () => {
    const out = normalizeScanCode("00123456789012");
    expect(out).toContain("0123456789012");
    expect(out).toContain("123456789012");
  });

  it("covers a scanner that dropped leading zeros", () => {
    const out = normalizeScanCode("0012345678905");
    expect(out).toContain("12345678905");
  });

  it("uppercases and strips punctuation from alpha SKUs, literal first", () => {
    expect(normalizeScanCode("tom-001")).toEqual(["tom-001", "TOM-001", "TOM001"]);
  });

  it("does not emit a redundant uppercase duplicate", () => {
    expect(normalizeScanCode("TOM-001")).toEqual(["TOM-001", "TOM001"]);
  });

  it("ranks the check-digit-stripped form last", () => {
    const out = normalizeScanCode("012345678905");
    expect(out[out.length - 1]).toBe("01234567890");
  });

  it("always returns a bounded, deduplicated, non-empty-string list", () => {
    const inputs = [
      "0012345678905",
      "012345678905",
      "01234565",
      "00123456789012",
      "12345678905",
      "tom-001",
      "  A B-C_1  ",
      "0",
      "00000000",
    ];
    for (const input of inputs) {
      const out = normalizeScanCode(input);
      expect(out.length).toBeLessThanOrEqual(MAX_SCAN_CANDIDATES);
      expect(new Set(out).size).toBe(out.length);
      expect(out.every((c) => c.length > 0)).toBe(true);
    }
  });
});

describe("pickBestScanMatch", () => {
  const candidates = ["0012345678905", "012345678905"];

  it("prefers the earlier candidate over the earlier column", () => {
    const skuOnSecond = { id: "b", sku: "012345678905" };
    const barcodeOnFirst = { id: "a", barcode: "0012345678905" };
    expect(pickBestScanMatch([skuOnSecond, barcodeOnFirst], candidates).id).toBe("a");
  });

  it("prefers barcode over sku over unitSku within one candidate", () => {
    const rows = [
      { id: "u", unitSku: "SHARED" },
      { id: "s", sku: "SHARED" },
      { id: "b", barcode: "SHARED" },
    ];
    expect(pickBestScanMatch(rows, ["SHARED"]).id).toBe("b");
    expect(pickBestScanMatch([rows[0], rows[1]], ["SHARED"]).id).toBe("s");
  });

  it("matches case-insensitively", () => {
    expect(pickBestScanMatch([{ id: "a", sku: "tom001" }], ["TOM001"]).id).toBe("a");
  });

  it("breaks ties on id, stably across calls", () => {
    const rows = [
      { id: "zz", barcode: "SHARED" },
      { id: "aa", barcode: "SHARED" },
    ];
    expect(pickBestScanMatch(rows, ["SHARED"]).id).toBe("aa");
    expect(pickBestScanMatch(rows, ["SHARED"]).id).toBe("aa");
    expect(pickBestScanMatch([...rows].reverse(), ["SHARED"]).id).toBe("aa");
  });

  it("does not mutate the caller's array", () => {
    const rows = [
      { id: "zz", barcode: "SHARED" },
      { id: "aa", barcode: "SHARED" },
    ];
    pickBestScanMatch(rows, ["SHARED"]);
    expect(rows.map((r) => r.id)).toEqual(["zz", "aa"]);
  });

  it("still returns a row when nothing ranks (server matched on a column we don't rank)", () => {
    expect(pickBestScanMatch([{ id: "only" }], ["NOPE"]).id).toBe("only");
  });
});
