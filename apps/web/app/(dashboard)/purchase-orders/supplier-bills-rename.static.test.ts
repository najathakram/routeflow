import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(__dirname, "..", "..", "..", rel), "utf8");

describe("Supplier Bills rename + Purchase Orders palette entry (PR-A2)", () => {
  it.each([
    "app/(dashboard)/vendor-bills/page.tsx",
    "app/(dashboard)/inventory/page.tsx",
    "components/CommandPalette.tsx",
    "app/(dashboard)/layout.tsx",
  ])("%s no longer says Bills & Purchasing as a UI label", (rel) => {
    expect(read(rel)).not.toMatch(/Bills (&|&amp;) Purchasing/);
  });

  it("the command palette navigates to /purchase-orders", () => {
    const src = read("components/CommandPalette.tsx");
    expect(src).toMatch(/label: "Purchase Orders"/);
    expect(src).toMatch(/router\.push\("\/purchase-orders"\)/);
  });
});
