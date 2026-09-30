/**
 * WP3 — PINS for the operator invoice screen's Print tile
 * (`app/(operator)/(tabs)/invoices/[id].tsx`). Source-text pin (the RN
 * component can't be rendered under the mobile Jest env, which is
 * pure-logic/node only — see jest.config.js) mirroring the convention of
 * `session-teardown.pins.test.ts` / `f11-run-cancel-skip.pins.test.ts`.
 *
 * R6.1-R6.4: a Print tile sits after the Share tile, owns its own
 * `useInvoicePdf()` mutation + `printing` state (mirroring `handlePdf`,
 * [id].tsx:411-450), shows "Preparing PDF…" while pending, is
 * `disabled={printing}`, and calls the new `printPdf` helper inside a
 * try/finally that always clears `printing`.
 */
import { readFileSync } from "fs";
import { join } from "path";

const SCREEN_PATH = join(__dirname, "..", "app", "(operator)", "(tabs)", "invoices", "[id].tsx");

describe("pin: operator invoice screen Print tile", () => {
  const src = readFileSync(SCREEN_PATH, "utf8");

  it("imports printPdf from lib/print-pdf", () => {
    expect(src).toMatch(/import\s*\{[^}]*printPdf[^}]*\}\s*from\s*["'].*print-pdf["']/);
  });

  it("owns its own useInvoicePdf() mutation and printing state, distinct from the Share tile's", () => {
    const useInvoicePdfCalls = src.match(/=\s*useInvoicePdf\(\)/g) ?? [];
    // pdfMut (Share) + printPdfMut (Print) — two independent mutations.
    expect(useInvoicePdfCalls.length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/const \[printing, setPrinting\] = useState/);
  });

  it("wraps the print call in try/finally so `printing` always clears", () => {
    expect(src).toMatch(/finally\s*\{\s*setPrinting\(false\)/);
  });

  it("shows 'Preparing PDF…' while the print mutation/print call is pending, and disables the tile", () => {
    expect(src).toMatch(/Preparing PDF…/);
    expect(src).toMatch(/disabled=\{printing\}/);
  });

  it("places the Print tile after the Share tile", () => {
    const shareIdx = src.indexOf('icon="share-outline"');
    const printIdx = src.indexOf('icon="print-outline"');
    expect(shareIdx).toBeGreaterThan(-1);
    expect(printIdx).toBeGreaterThan(-1);
    expect(printIdx).toBeGreaterThan(shareIdx);
  });
});
