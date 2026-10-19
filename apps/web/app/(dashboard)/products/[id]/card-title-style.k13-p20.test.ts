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
