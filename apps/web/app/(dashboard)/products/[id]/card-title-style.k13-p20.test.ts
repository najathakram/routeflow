import * as fs from "fs";
import * as path from "path";

// K13 P20: one card-title style across the product-page cards (the Details / Image / Sales one).
const TITLE = "text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70";
const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

describe("product-page card titles (K13 P20)", () => {
  it.each([
    ["ProductLabelsCard.tsx", "Restriction labels"],
    ["ProductPortalVisibilityCard.tsx", "Buyer portal"],
    ["ProductMerchandising.tsx", "Buyer merchandising"],
  ])("%s titles %s in the shared style", (file, title) => {
    const src = read(file);
    const h3 = src.match(/<h3[^>]*>[\s\S]*?<\/h3>/)![0];
    expect(h3).toContain(title);
    expect(h3).toContain(TITLE);
  });
});

describe("K14 P16/P17/P04: family and product page tidy-ups", () => {
  const read = (p: string) =>
    require("fs").readFileSync(require("path").join(__dirname, p), "utf8") as string;
  it("the Variants card title uses the same eyebrow style as the other cards", () => {
    const src = read("../../../../components/family/FamilyVariantsEditor.tsx");
    const h3 = src.match(/<h3[^>]*>\s*Variants\s*<\/h3>/)![0];
    expect(h3).toContain("text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70");
    expect(h3).not.toContain("text-sm");
  });
  it("an empty description hides its heading outside edit mode, and a missing MSRP reads Not set", () => {
    const page = read("page.tsx");
    expect(page).toMatch(/\{\(isEditing \|\| product\.description\) && \(/);
    expect(page).toContain(">Not set</p>");
  });
});
