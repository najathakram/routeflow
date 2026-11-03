/**
 * @jest-environment node
 */
// Site audit 2026-11-02, section 6: pins for the phone menu and footer, and for the figures that
// moved while a visitor paused. Static scans of the ported pages in public/site (no rendering).
import * as fs from "fs";
import * as path from "path";

const SITE = path.resolve(__dirname, "../../public/site");
const read = (file: string) => fs.readFileSync(path.join(SITE, file), "utf8");
const PAGES = [
  "home.html",
  "product.html",
  "pricing.html",
  "getting-started.html",
  "does-and-doesnt.html",
  "data-in-and-out.html",
  "security.html",
  "company.html",
  "contact.html",
];
const DEPTH = ["does-and-doesnt", "data-in-and-out", "security"];

const mobileMenu = (html: string) => {
  const start = html.indexOf('class="mobile-menu"');
  return html.slice(start, html.indexOf("</nav>", start));
};
const footer = (html: string) => html.slice(html.indexOf('<footer class="site-footer"'));

describe("phone menu and footer reach the three depth pages", () => {
  it.each(PAGES)("%s: the phone menu links all three, and Pricing once", (file) => {
    const menu = mobileMenu(read(file));
    for (const slug of DEPTH) expect(menu).toContain(`href="/${slug}"`);
    expect(menu.match(/>Pricing<\/a>/g)).toHaveLength(1);
  });

  it.each(PAGES)("%s: footer links to the depth pages are marked for the phone", (file) => {
    const marked = footer(read(file)).match(/<li class="foot-depth">/g) ?? [];
    // a page does not link to itself in its own footer column
    expect(marked.length).toBeGreaterThanOrEqual(2);
  });

  it("the phone footer keeps only the marked items of the Explore column", () => {
    const css = read("css/site.css");
    expect(css).toContain(".footer-grid>:nth-child(2) li:not(.foot-depth){display:none}");
    expect(css).not.toMatch(/\.footer-grid>:nth-child\(2\),\.footer-grid>:nth-child\(3\)/);
  });

  it("the header Pricing pill steps aside while the phone menu is open", () => {
    expect(read("css/home-up.css")).toContain(
      ".js body.menu-open .site-header.hero-btn-in .nav-price{display:none}",
    );
  });
});

describe("no figure counts through a wrong value while scroll holds it", () => {
  const wheel = read("graphics/rf-wheel-up.js");

  it("the wheel's order total is the sum of its lines from the first frame", () => {
    expect(wheel).toContain('row("Total", "", "$111.00", "t")');
    expect(wheel).not.toContain('num(0, 111, "u")');
  });

  it("the wheel's paid invoice shows the zero balance beside the payment received", () => {
    expect(wheel).toContain('row("Balance due", "", "$0.00", "t")');
    expect(wheel).not.toContain('num(163.8, 0, "u")');
  });

  it("the plan cards' customer counts do not count up", () => {
    const home = read("js/home-up.js");
    expect(home).not.toContain("pm-n b[data-plan]");
    expect(home).not.toMatch(/e\.textContent = Math\.round\(q\.v\)/);
  });
});

describe("wheel pieces are explained and legible on a phone", () => {
  it("home lists what every wheel piece does, shown only when the moving wheel is mounted", () => {
    const html = read("home.html");
    const list = html.slice(html.indexOf('class="w sy-parts"'));
    const items = list.slice(0, list.indexOf("</div>")).match(/<li><b>/g) ?? [];
    expect(items).toHaveLength(15);
    expect(read("css/home-up.css")).toContain(
      "body:has(.rfw:not(.rfw--static)) .sy-parts{display:block",
    );
  });

  it("phone labels have a floor above 12 px", () => {
    const wheel = read("graphics/rf-wheel-up.js");
    expect(wheel).toContain("((phone ? 13 : 12) * dpr) / 31");
  });
});
