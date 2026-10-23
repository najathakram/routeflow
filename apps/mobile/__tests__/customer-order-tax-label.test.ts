import { readFileSync } from "fs";
import { join } from "path";

describe("customer order detail tax label (row 211, source-pinned)", () => {
  const src = readFileSync(
    join(__dirname, "..", "app", "(customer)", "orders", "[id].tsx"),
    "utf8",
  );
  it("does not hard-code a 10% GST rate next to the tax amount", () => {
    expect(src).not.toContain("GST (10%)");
    expect(src).toMatch(/Tax: \$\{Number\(order\.tax\)\.toFixed\(2\)\}/);
  });
});
