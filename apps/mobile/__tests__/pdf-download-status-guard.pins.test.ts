/**
 * Review finding F2 on PR #756: `FileSystem.downloadAsync` resolves (never
 * rejects) on a non-2xx HTTP response, so an error page/body would be saved
 * to disk and handed to `Print.printAsync`/`Sharing.shareAsync` as if it
 * were the real file. Both call sites must destructure `status` and check
 * it via the shared `isDownloadOk` (print-logic.test.ts covers the pure
 * predicate itself) BEFORE printing/sharing the downloaded uri. Source-text
 * pin — no native module can be loaded under Jest.
 */
import { readFileSync } from "fs";
import { join } from "path";

const PRINT_PDF_PATH = join(__dirname, "..", "lib", "print-pdf.ts");
const SHARE_PDF_PATH = join(__dirname, "..", "lib", "share-pdf.ts");

describe("pin: downloadAsync status is checked before printing/sharing (F2)", () => {
  const printPdfSrc = readFileSync(PRINT_PDF_PATH, "utf8");
  const sharePdfSrc = readFileSync(SHARE_PDF_PATH, "utf8");

  it("print-pdf.ts imports isDownloadOk and guards before Print.printAsync", () => {
    expect(printPdfSrc).toMatch(
      /import\s*\{[^}]*isDownloadOk[^}]*\}\s*from\s*["']\.\/print-logic["']/,
    );
    const downloadIdx = printPdfSrc.indexOf("FileSystem.downloadAsync(url, target)");
    const guardIdx = printPdfSrc.indexOf("if (!isDownloadOk(status))");
    const printIdx = printPdfSrc.indexOf("Print.printAsync({ uri })");
    expect(downloadIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(downloadIdx);
    expect(printIdx).toBeGreaterThan(guardIdx);
  });

  it("share-pdf.ts (sharePdfNative) imports isDownloadOk and guards before Sharing.shareAsync", () => {
    expect(sharePdfSrc).toMatch(/import\s*\{\s*isDownloadOk\s*\}\s*from\s*["']\.\/print-logic["']/);
    const downloadIdx = sharePdfSrc.indexOf("FileSystem.downloadAsync(url, target)");
    const guardIdx = sharePdfSrc.indexOf("if (!isDownloadOk(status))");
    const shareIdx = sharePdfSrc.indexOf("Sharing.shareAsync(uri,");
    expect(downloadIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(downloadIdx);
    expect(guardIdx).toBeLessThan(shareIdx);
  });
});
