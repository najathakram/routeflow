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
  "css/home-color.css",
  "css/color-deep.css",
  "css/mobile.css",
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

  it("the wheel runs on every height: no still for a short window, and a sideways phone takes the wide layout", () => {
    const wheel = read("graphics/rf-wheel-up.js");
    // a window under 500 px tall is a condition for the names and the burst (`low`), never a reason for the still
    expect(wheel).not.toContain('short: "(max-height: 499.98px)"');
    expect(wheel).toContain('low: "(max-height: 499.98px)"');
    expect(wheel).not.toContain("c.conditions.short");
    expect(wheel).toContain(
      `land: "(max-width: 899.98px) and (max-height: 599.98px) and (min-aspect-ratio: 1/1)"`,
    );
    expect(wheel).toContain("!c.conditions.wide && !c.conditions.land");
    expect(wheel).toContain("const liveWanted = can;");
    // the still stays for no JavaScript and a browser that cannot run the wheel
    expect(wheel).toContain("if (!can) return still();");
    // the page CSS follows the same shape: no 500 px height gate left on the wheel or the hero
    for (const css of ["css/home-up.css", "graphics/rf-wheel-up.css"]) {
      expect(read(css)).not.toContain("min-height:500px");
    }
    expect(read("css/home-up.css")).toContain(
      "@media (min-width:900px),(max-width:899.98px) and (max-height:599.98px) and (min-aspect-ratio:1/1){",
    );
  });

  it("a turn of the phone puts the visitor back at the same place in the story", () => {
    const wheel = read("graphics/rf-wheel-up.js");
    expect(wheel).toContain("const trackKeep = () => {");
    expect(wheel).toContain("inst.keep = ");
    expect(wheel).toContain("if (k && inst.rebuilt) {");
    expect(wheel).toContain(`root.removeEventListener("scroll", trackKeep);`);
  });

  // Owner, phone screenshot: "On the mobile, these texts can be better and more cleaner." The phone's wheel names were
  // squashed flat onto the pieces, ran over their edges, were dark on deep colours, and the hub mark was a clipped smear.
  // The pixels are checked by eye on stills at 390 and 360 (and WebKit); these pin the rules the drawing follows.
  describe("the phone wheel's words", () => {
    const wheel = read("graphics/rf-wheel-up.js");
    it("phone names are never squashed (the squash factor is not set per phone)", () => {
      expect(wheel).not.toMatch(/nq = phone \? 0\.\d+/);
    });
    it("the hub mark stands upright on the puck's front while the lid is a sliver, and lies on it as the lid opens", () => {
      expect(wheel).toContain("let up = 0, ft = -1e9, fb = -1e9, lt = 1e9;");
      // straight down (the page at rest) the base sits inside the lid: no front face, so the mark lies flat (review-a, #4153)
      expect(wheel).toContain("up = fb - ft > 1 ? clamp(0, 1,");
      expect(wheel).not.toContain("0.8 * (fb - ft) + 1e-6");
      expect(wheel).toContain("if (hubF < 0.5) {");
      expect(wheel).toContain("if (hubF > 0.5) {");
    });
    // review-a, #4153 note 1: a page can rest anywhere, so a fade tied to the scroll's geometry rested half done (a grey logo).
    it("which mark stands is chosen with a margin, and the fade between them runs on the clock, not on the scroll", () => {
      expect(wheel).toContain("if (up > 0.55) hubUp = 1; else if (up < 0.45) hubUp = 0;");
      expect(wheel).toContain(
        "hubF = hubF < hubUp ? Math.min(hubUp, hubF + dt * 8) : Math.max(hubUp, hubF - dt * 8);",
      );
      expect(wheel).not.toContain("(up - 0.5) / 0.2");
      expect(wheel).not.toContain("(0.5 - up) / 0.2");
    });
  });

  it("the home sections build for every visitor, with the short-window fallback kept", () => {
    const home = read("js/home-up.js");
    expect(home).not.toMatch(/reduce\s*:|c\.reduce|userRM/);
    const site = read("js/site.js");
    // matchMedia runs its handler only when a key matches; the handler is what takes js-motion off. Below 900 px `desk`
    // is false, so without a key that matches every screen the words stay hidden (review-a, #4153). The key that does it
    // is pinned by the screen-only condition test below.
    expect(site).not.toMatch(/ctx\.conditions\.motion|userRM/);
  });

  // B1324: every motion condition is screen-only, so print matches none and GSAP reverts all motion. The objects are
  // parsed out of the source at test time (L-206); finding none throws (L-202).
  const parseConditions = (src: string, open: RegExp, label: string) => {
    const m = open.exec(src);
    if (!m) throw new Error(`condition object not found: ${label}`);
    const pairs = [...m[1].matchAll(/(\w+)\s*:\s*"([^"]*)"/g)].map((x) => [x[1], x[2]] as const);
    return Object.fromEntries(pairs) as Record<string, string>;
  };
  const conditionSets = () => {
    const q = parseConditions(read("js/home-up.js"), /var Q = \{([^}]*)\}/, "home-up.js Q");
    const mm = parseConditions(read("js/site.js"), /mm\.add\(\{([^}]*)\}/, "site.js mm.add");
    return { q, mm };
  };

  it("T1 R1 every motion condition is screen-only, so print reverts all motion", () => {
    const { q, mm } = conditionSets();
    expect(Object.keys(q).length).toBe(3);
    expect(Object.keys(mm).length).toBe(2);
    const parts = [...Object.values(q), ...Object.values(mm)].flatMap((v) =>
      v.split(",").map((x) => x.trim()),
    );
    expect(parts.filter((x) => !x.startsWith("screen"))).toEqual([]);
    expect(Object.keys(q).concat(Object.keys(mm)).includes("all")).toBe(false);
    expect(Object.values(mm).includes("screen")).toBe(true);
    expect(q.mob.includes("max-height: 599.98px")).toBe(true);
    // the breakpoints themselves: parsed values, compared exactly
    expect(q.desk).toBe("screen and (min-width: 900px) and (min-height: 600px)");
    expect(q.mob).toBe("screen and (max-width: 899.98px), screen and (max-height: 599.98px)");
    expect(q.pin).toBe("screen and (max-width: 899.98px) and (min-height: 600px)");
    expect(mm.desk).toBe("screen and (min-width: 900px)");
  });

  // B1324: the print toggle is the same code in both scripts (only the variable names differ), so one fix reaches both.
  it("T1 R1 the print toggle block is identical in home-up.js and site.js", () => {
    const block = (file: string) => {
      const m = /\/\* paper:start \*\/([^]*?)\/\* paper:end \*\//.exec(read(file));
      if (!m) throw new Error(`print toggle block not found in ${file}`);
      return m[1].replace(/\bwindow\b/g, "W").replace(/\bdoc\b/g, "html");
    };
    const home = block("js/home-up.js");
    const site = block("js/site.js");
    expect(home.trim().length > 0).toBe(true);
    expect(site).toEqual(home);
  });
});
