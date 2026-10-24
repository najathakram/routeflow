import * as fs from "fs";
import * as path from "path";

/**
 * SA-733r6 (option a): a buyer may still PAY a read-only seller, so the payment screens never show the "isn't taking
 * online orders right now" line and never disable themselves on `acceptingOrders`. That copy belongs to the shop and
 * the cart only. This reads the payments screen sources.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("buyer payment screens", () => {
  const files = walk(__dirname);

  it("exist (the scan is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("never reference the seller-unavailable line or acceptingOrders", () => {
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      expect(text).not.toMatch(/SellerUnavailable|acceptingOrders|isn't taking online orders/);
    }
  });
});
