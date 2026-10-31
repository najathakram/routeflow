import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

/**
 * SA-1031 P-1: every barcode an invoice can print is drawn in ONE file, so the tenant's `invoice.hideBarcodes` choice has
 * one place to face. A new `bwip-js` importer, or a fourth `toBuffer` call (3 today: the line Code128, the piece barcode,
 * the order QR), fails here: it must read the setting (or be ruled outside it, like the QR) before this pin moves.
 */
const SRC = join(__dirname, "..");
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(join(dir, e.name))
      : /\.tsx?$/.test(e.name) && !/\.(spec|test)\.tsx?$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );

describe("P-1: one file draws every invoice barcode", () => {
  const importers = walk(SRC).filter((f) =>
    /from\s+["']bwip-js["']|require\(["']bwip-js["']\)/.test(readFileSync(f, "utf8")),
  );

  it("bwip-js is imported by exactly one non-spec file under apps/api/src", () => {
    expect(importers.map((f) => relative(SRC, f).replace(/\\/g, "/"))).toEqual([
      "invoices/invoice-pdf.service.ts",
    ]);
  });

  it("that file calls bwipjs.toBuffer exactly 3 times, and reads invoice.hideBarcodes", () => {
    const src = readFileSync(importers[0], "utf8");
    expect(src.split("bwipjs.toBuffer(").length - 1).toBe(3);
    expect(src).toContain('"invoice.hideBarcodes"');
  });

  it("MP-G5: the send fingerprint does not read which barcode source is drawn (a rendering rule, not data)", () => {
    const state = readFileSync(join(SRC, "invoices/invoice-send-state.ts"), "utf8");
    expect(state).not.toContain("invoiceBarcodeSource");
  });
});
