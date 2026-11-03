// Owner ruling 2026-11-03: "The wheel does not explode on the desktop site. Also, avoid having reduce motion."
// The public site's motion runs for every visitor. A computer with animations off used to get no ScrollTriggers,
// a still dial and a page 8,000 px shorter. These pins keep the three old ways of turning it off from coming
// back: the OS media query, the footer switch (html.rm, the rf-rm key) and the review flag ?motion=on.
// The behaviour itself (same height, same trigger count, the wheel apart under "reduce") is e2e spec 36, T21.
import fs from "node:fs";
import path from "node:path";

const SITE = path.resolve(__dirname, "../../public/site");
const read = (rel: string) => fs.readFileSync(path.join(SITE, rel), "utf8");

const PAGES = [
  "home",
  "pricing",
  "product",
  "landing",
  "company",
  "contact",
  "data-in-and-out",
  "does-and-doesnt",
  "getting-started",
  "security",
].map((n) => `${n}.html`);
const SCRIPTS = [
  "js/home-up.js",
  "js/site.js",
  "js/product.js",
  "js/prices.js",
  "js/auth-nav.js",
  "graphics/rf-wheel-up.js",
];
const STYLES = [
  "css/site.css",
  "css/home.css",
  "css/home-up.css",
  "css/product.css",
  "css/does.css",
  "css/start.css",
  "css/company.css",
  "graphics/rf-graphics.css",
  "graphics/rf-wheel-up.css",
];

const OLD_WAYS: Array<[string, RegExp]> = [
  ["the OS reduced-motion media query", /prefers-reduced-motion/],
  ["the review flag ?motion=on", /motion=on|motion-on/],
  ["the footer switch", /rm-toggle|data-rm|Reduce motion/],
  ["the html.rm class", /classList\.(contains|toggle)\(\s*["']rm["']|html\.rm\b/],
  ["a read of the rf-rm key", /getItem\(\s*["']rf-rm["']|setItem\(\s*["']rf-rm["']/],
];

describe("the public site's motion does not depend on the visitor's motion setting", () => {
  for (const file of [...PAGES, ...SCRIPTS, ...STYLES]) {
    const text = read(file);
    for (const [what, re] of OLD_WAYS) {
      it(`${file} has no ${what}`, () => {
        expect(text).not.toMatch(re);
      });
    }
  }

  it("every page's head script turns the motion on without asking the browser", () => {
    const problems: string[] = [];
    for (const file of PAGES.filter((f) => f !== "landing.html")) {
      const html = read(file);
      const at = html.indexOf('<script>(function(d){d.className+=" js";');
      const head = at < 0 ? null : [html.slice(at, html.indexOf("</script>", at))];
      if (!head) {
        problems.push(`${file}: no head script`);
        continue;
      }
      const script = head[0];
      if (!script.includes('d.className+=" js-motion"')) problems.push(`${file}: no js-motion`);
      if (/matchMedia|location\.search|if\(!r/.test(script)) problems.push(`${file}: still asks`);
      // a leftover rf-rm=1 from the old switch is cleared, never read
      if (!script.includes('localStorage.removeItem("rf-rm")')) problems.push(`${file}: key kept`);
    }
    expect(problems).toEqual([]);
  });

  it("the wheel falls back to the still only for a window under 500 px tall", () => {
    const wheel = read("graphics/rf-wheel-up.js");
    expect(wheel).toContain('short: "(max-height: 499.98px)"');
    expect(wheel).toContain("if (c.conditions.short) { still(); return undefined; }");
    expect(wheel).toContain("const liveWanted = can;");
  });

  it("the home sections build for every visitor, with the short-window fallback kept", () => {
    const home = read("js/home-up.js");
    expect(home).toContain('mob: "(max-width: 899.98px), (max-height: 599.98px)"');
    expect(home).not.toMatch(/reduce\s*:|c\.reduce|userRM/);
    const site = read("js/site.js");
    expect(site).toContain('mm.add({ desk: "(min-width: 900px)" }');
    expect(site).not.toMatch(/ctx\.conditions\.motion|userRM/);
  });
});
