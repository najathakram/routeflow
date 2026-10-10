import * as fs from "fs";
import * as path from "path";
// RED (M4a-1, SA-578 amendment "test 14"): the additive scan-response shape must live in the SHARED
// type package, not a web-local interface. `ScanMatchView` does not exist in packages/types yet.
import type { ProductBarcodeView, ScanMatchView } from "@routeflow/types";

const REPO = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("scan response additions are additive in packages/types (M4a-1)", () => {
  it("packages/types/api/products.ts exports ScanMatchView { code, levels } beside ProductBarcodeView", () => {
    const src = read("packages/types/api/products.ts");
    expect(src).toMatch(/export interface ScanMatchView\s*\{/);
    expect(src).toMatch(/levels:\s*\S/);
    const ok: ScanMatchView = { code: "X", levels: ["BOX", "UNIT"] };
    const view: Pick<ProductBarcodeView, "code"> = { code: ok.code };
    expect(view.code).toBe("X");
  });

  it("web and mobile import it from @routeflow/types — neither app declares its own ScanMatch shape (L-072)", () => {
    for (const rel of ["apps/web/lib/barcode-resolve.ts", "apps/mobile/lib/barcode-resolve.ts"]) {
      const src = read(rel);
      expect(src).not.toMatch(/interface\s+ScanMatch\w*\s*\{/);
      expect(src).toContain("ScanMatchView");
    }
  });
});
