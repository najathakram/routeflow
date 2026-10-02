import * as fs from "fs";
import * as path from "path";
import { BARCODE_SYMBOLOGY_VALUES } from "@routeflow/types";
// RED (M4a-1): ./barcode-symbology does not exist in packages/scanning yet (it lives in
// apps/api/src/common and imports @prisma/client). Fails on "Cannot find module".
import { inferBarcodeSymbology } from "./barcode-symbology";

// #2717 M1 T3 (R3), MOVED here from apps/api/src/common/barcode-symbology.spec.ts (M4a-1, SA-578 test 5):
// symbology inferred purely from the trimmed code's digit-length, typed by BARCODE_SYMBOLOGY_VALUES.
describe("inferBarcodeSymbology (#2717 M1, SA-572a; moved to @routeflow/scanning in M4a-1)", () => {
  it("infers UPC_A from a 12-digit numeric code", () => {
    expect(inferBarcodeSymbology("036000291452")).toBe("UPC_A");
  });

  it("infers EAN_13 from a 13-digit numeric code", () => {
    expect(inferBarcodeSymbology("4006381333931")).toBe("EAN_13");
  });

  it("infers GTIN_14 from a 14-digit numeric code", () => {
    expect(inferBarcodeSymbology("10012345678902")).toBe("GTIN_14");
  });

  it("infers EAN_8 from an 8-digit numeric code", () => {
    expect(inferBarcodeSymbology("96385074")).toBe("EAN_8");
  });

  it("falls back to CODE128 for non-digit codes", () => {
    expect(inferBarcodeSymbology("ABC-123")).toBe("CODE128");
  });

  it("falls back to CODE128 for a digit-only code of an unrecognized length (SA-572b Q1)", () => {
    expect(inferBarcodeSymbology("12345")).toBe("CODE128");
  });

  it("trims surrounding whitespace before inferring", () => {
    expect(inferBarcodeSymbology(" 036000291452 ")).toBe("UPC_A");
  });

  // ── M4a-1 extensions ──────────────────────────────────────────────────────────
  it("an empty / whitespace-only code falls back to CODE128 (never throws)", () => {
    expect(inferBarcodeSymbology("")).toBe("CODE128");
    expect(inferBarcodeSymbology("   ")).toBe("CODE128");
  });

  it("a mixed alphanumeric code of a UPC length is CODE128, not UPC_A (digits only)", () => {
    expect(inferBarcodeSymbology("03600029145X")).toBe("CODE128");
  });

  it("no check-digit validation: a 12-digit code with a wrong check digit is still UPC_A", () => {
    expect(inferBarcodeSymbology("036000291453")).toBe("UPC_A");
  });

  it("every return value is a member of BARCODE_SYMBOLOGY_VALUES (seeded sweep, lengths 0-20)", () => {
    let seed = 2717;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 300; i += 1) {
      const len = Math.floor(rnd() * 21);
      const alnum = rnd() < 0.3;
      let code = "";
      for (let j = 0; j < len; j += 1) {
        code +=
          alnum && rnd() < 0.5 ? "AZ-"[Math.floor(rnd() * 3)] : String(Math.floor(rnd() * 10));
      }
      expect(BARCODE_SYMBOLOGY_VALUES).toContain(inferBarcodeSymbology(code));
    }
  });

  it("the package source does not import @prisma/client (typed by BARCODE_SYMBOLOGY_VALUES, SA-578 test 5)", () => {
    const src = fs.readFileSync(path.join(__dirname, "barcode-symbology.ts"), "utf8");
    expect(src).not.toContain("@prisma/client");
    expect(src).toContain("BARCODE_SYMBOLOGY_VALUES");
  });

  it("is exported from the package index (the one import path api/web/mobile use)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const index = require("./index");
    expect(typeof index.inferBarcodeSymbology).toBe("function");
    expect(index.inferBarcodeSymbology("036000291452")).toBe("UPC_A");
  });
});
