/**
 * Mobile mirror of `apps/api/src/common/barcode-normalize.spec.ts`.
 *
 * Two jobs: prove the mobile copy behaves correctly for the in-memory scan
 * fast path, and fail loudly if the two copies drift — the same role
 * `pricing` mirrors play across api / web / mobile.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  MAX_SCAN_CANDIDATES,
  normalizeScanCode,
  pickBestScanMatch,
  upcEToUpcA,
} from "../lib/barcode-normalize";

describe("upcEToUpcA", () => {
  it("expands each compression branch", () => {
    expect(upcEToUpcA("01234565")).toBe("012345000065"); // last data digit 5-9
    expect(upcEToUpcA("01234500")).toBe("012000003450"); // 0/1/2
    expect(upcEToUpcA("01234530")).toBe("012300000450"); // 3
    expect(upcEToUpcA("01234540")).toBe("012340000050"); // 4
  });

  it("rejects non-UPC-E input", () => {
    expect(upcEToUpcA("21234565")).toBeNull();
    expect(upcEToUpcA("1234567")).toBeNull();
    expect(upcEToUpcA("ABCDEFGH")).toBeNull();
  });
});

describe("normalizeScanCode", () => {
  it("returns nothing for blank input", () => {
    expect(normalizeScanCode("")).toEqual([]);
    expect(normalizeScanCode("   ")).toEqual([]);
  });

  it("bridges UPC-A and EAN-13 in both directions", () => {
    expect(normalizeScanCode("0012345678905")).toContain("012345678905");
    expect(normalizeScanCode("012345678905")).toContain("0012345678905");
  });

  it("expands UPC-E to UPC-A and EAN-13", () => {
    const out = normalizeScanCode("01234565");
    expect(out).toContain("012345000065");
    expect(out).toContain("0012345000065");
  });

  it("unwraps a GTIN-14 case code", () => {
    expect(normalizeScanCode("00123456789012")).toContain("0123456789012");
  });

  it("keeps the literal first for alpha SKUs", () => {
    expect(normalizeScanCode("tom-001")).toEqual(["tom-001", "TOM-001", "TOM001"]);
  });

  it("stays bounded and deduplicated", () => {
    for (const input of ["0012345678905", "01234565", "00123456789012", "tom-001"]) {
      const out = normalizeScanCode(input);
      expect(out.length).toBeLessThanOrEqual(MAX_SCAN_CANDIDATES);
      expect(new Set(out).size).toBe(out.length);
    }
  });
});

describe("pickBestScanMatch", () => {
  it("prefers the earlier candidate, then barcode over sku over unitSku", () => {
    const rows = [
      { id: "u", unitSku: "SHARED" },
      { id: "s", sku: "SHARED" },
      { id: "b", barcode: "SHARED" },
    ];
    expect(pickBestScanMatch(rows, ["SHARED"]).id).toBe("b");
    expect(
      pickBestScanMatch(
        [
          { id: "second", sku: "012345678905" },
          { id: "first", barcode: "0012345678905" },
        ],
        ["0012345678905", "012345678905"],
      ).id,
    ).toBe("first");
  });

  it("breaks ties on id, stably", () => {
    const rows = [
      { id: "zz", barcode: "SHARED" },
      { id: "aa", barcode: "SHARED" },
    ];
    expect(pickBestScanMatch(rows, ["SHARED"]).id).toBe("aa");
    expect(pickBestScanMatch([...rows].reverse(), ["SHARED"]).id).toBe("aa");
  });
});

describe("mirror integrity", () => {
  /** Everything after the leading file-level block comment, whitespace-normalised. */
  const body = (source: string) =>
    source
      .replace(/^\/\*\*[\s\S]*?\*\//, "")
      .replace(/\r\n/g, "\n")
      .trim();

  it("matches apps/api/src/common/barcode-normalize.ts below the header", () => {
    const mobile = readFileSync(join(__dirname, "..", "lib", "barcode-normalize.ts"), "utf8");
    const api = readFileSync(
      join(__dirname, "..", "..", "api", "src", "common", "barcode-normalize.ts"),
      "utf8",
    );
    // Only the header block may differ (each names the other as its mirror).
    // Any behavioural drift fails here — fix BOTH copies, don't relax this.
    expect(body(mobile)).toBe(body(api));
  });
});
