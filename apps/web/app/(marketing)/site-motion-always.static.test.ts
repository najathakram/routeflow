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

  // Owner, phone screenshot: "On the mobile, these texts can be better and more cleaner." The phone's wheel names were
  // squashed flat onto the pieces, ran over their edges, were dark on deep colours, and the hub mark was a clipped smear.
  // The pixels are checked by eye on stills at 390 and 360 (and WebKit); these pin the rules the drawing follows.
  describe("the phone wheel's words", () => {
    const wheel = read("graphics/rf-wheel-up.js");
    it("names stay upright (no squash on a phone)", () => {
      expect(wheel).toContain("nq = phone ? 1 : sq");
      expect(wheel).not.toMatch(/nq = phone \? 0\.\d+/);
    });
    it("a name is fitted to the width of its own piece, never wider", () => {
      expect(wheel).toContain(
        "const wc = {}, wid = (t) => wc[t] || (wc[t] = ctx.measureText(t).width);",
      );
      expect(wheel).toContain("Math.min(ax - x0, x1 - ax)");
      expect(wheel).toContain("room / Math.max(1, ...w.lines.map(wid))");
      expect(wheel).toContain("for (const k in wc) delete wc[k];"); // font changes clear the measures
    });
    it("a long note wraps to two lines on a phone", () => {
      expect(wheel).toContain("const nt = phone && w.d.n && w.d.n.length > 9;");
      expect(wheel).toContain("lines2(w.d.n)");
    });
    it("ink is white (with a soft shadow) where white reads better than the piece's dark ink", () => {
      expect(wheel).toContain("const lf = lum(f), ld = lum(mix(INK, w.ink, p.c));");
      expect(wheel).toContain(
        "lit = 1.05 / (lf + 0.05) > (Math.max(lf, ld) + 0.05) / (Math.min(lf, ld) + 0.05);",
      );
      expect(wheel).toContain('ctx.shadowColor = "rgba(0,0,0,0.34)"');
    });
    it("the two back core names share one size and the front one fits its piece", () => {
      expect(wheel).toContain("uy < 0 ? 0.6 * cx : (x1 - x0) * 0.82");
      expect(wheel).toContain("Math.max(...list.map((v) => wid(v.d.t)))");
    });
    it("the hub mark stands upright on the puck's front while the lid is a sliver, and lies on it as the lid opens", () => {
      expect(wheel).toContain("let up = 0, ft = -1e9, fb = -1e9, lt = 1e9;");
      expect(wheel).toContain("if (up < 1) {");
      expect(wheel).toContain("if (up > 0) {");
    });
  });

  it("the home sections build for every visitor, with the short-window fallback kept", () => {
    const home = read("js/home-up.js");
    expect(home).toContain('mob: "(max-width: 899.98px), (max-height: 599.98px)"');
    expect(home).not.toMatch(/reduce\s*:|c\.reduce|userRM/);
    const site = read("js/site.js");
    // matchMedia runs its handler only when a key matches; the handler is what takes js-motion off. Below 900 px `desk`
    // is false, so without an always-matching key the words stay hidden (review-a, #4153).
    expect(site).toContain('mm.add({ all: "all", desk: "(min-width: 900px)" }');
    expect(site).not.toMatch(/ctx\.conditions\.motion|userRM/);
  });
});
