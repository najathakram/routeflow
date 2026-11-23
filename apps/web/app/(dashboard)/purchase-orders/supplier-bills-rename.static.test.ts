import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(__dirname, "..", "..", "..", rel), "utf8");

describe("Supplier Bills rename + Purchase Orders menu entry (PR-A2)", () => {
  it.each([
    "app/(dashboard)/vendor-bills/page.tsx",
    "app/(dashboard)/inventory/page.tsx",
    "components/CommandPalette.tsx",
    "app/(dashboard)/layout.tsx",
  ])("%s no longer says Bills & Purchasing as a UI label", (rel) => {
    expect(read(rel)).not.toMatch(/Bills (&|&amp;) Purchasing/);
  });

  it("the menu (which the command palette is generated from) lists /purchase-orders", () => {
    const src = read("app/(dashboard)/_components/nav-config.ts");
    expect(src).toMatch(/label: "Purchase orders"/);
    expect(src).toContain('href: "/purchase-orders"');
  });
});
