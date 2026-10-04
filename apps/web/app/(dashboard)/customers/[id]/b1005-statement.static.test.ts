import * as fs from "fs";
import * as path from "path";

/** B1005: the customer page no longer renders a letterhead, a made-up $0 opening balance, or a window.print() statement,
 *  and no balance tile reads `statement?.x ?? 0` into a displayed figure (it shows an em dash until the data is real). */
describe("customers/[id]/page.tsx statement section (B1005)", () => {
  const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
  it("has no hard-coded letterhead, opening-balance tile or print action", () => {
    expect(src).not.toMatch(/Austin, TX/);
    expect(src).not.toMatch(/routeflow\.io/);
    expect(src).not.toMatch(/Opening Balance/);
    expect(src).not.toMatch(/window\.print\(\)/);
    expect(src).not.toMatch(/<BrandMark/);
  });
  it("renders the statement through CustomerStatementCard", () => {
    expect(src).toContain("<CustomerStatementCard");
  });
  it("never displays a statement balance as fmt(statement?.x ?? 0)", () => {
    expect(src).not.toMatch(/fmt\(\s*statement\?\.\w+\s*\?\?\s*0\s*\)/);
    expect(src).not.toMatch(/fmt\(\s*(?:outstandingTotal|overdueTotal)\s*\)/);
  });
});
