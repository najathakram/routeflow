/**
 * @jest-environment node
 */
// K14a: the home page's wheel sub line is written twice, in the still the page carries (home.html) and in the
// script that builds the live wheel (graphics/rf-wheel-up.js, HERO). A visitor must read the same sentence
// whether the wheel is live or not. This test takes the sub line from each file, swaps the brand name on each
// side for one marker, checks each side holds exactly one marker and compares the rest byte for byte. It
// never types the sentence or the name: the page side is read as the route serves it (the name filled in from
// the brand file) and the script side keeps its name variable, which reads the page's og:site_name.
import * as fs from "fs";
import * as path from "path";
import { BRAND } from "@routeflow/types/brand";
import { readServedSitePage } from "@/lib/read-site-page";

const WHEEL = path.resolve(__dirname, "../../public/site/graphics/rf-wheel-up.js");
const MARK = "\u0001NAME\u0001";

/** The script's name variable: the one identifier its sub-line expression may use. */
const NAME_VAR = "NAME";

/** The sub line the script builds: the two HERO lines' `s` values joined by one space, with the name variable as the marker. */
export function scriptSubLine(src: string): string {
  const hero = /const HERO = \[([\s\S]*?)\n {2}\];/.exec(src);
  if (!hero) throw new Error("rf-wheel-up.js: no HERO list found");
  const lines = [...hero[1].matchAll(/\bs: (.+?) \},?\s*$/gm)].map((m) => m[1]);
  if (lines.length !== 2)
    throw new Error(`rf-wheel-up.js: expected 2 HERO sub lines, found ${lines.length}`);
  const part = (expr: string) =>
    expr
      .split(/\s\+\s/)
      .map((t) => (t === NAME_VAR ? MARK : (JSON.parse(t) as string)))
      .join("");
  return lines.map(part).join(" ");
}

/** The sub line of the still inside the wheel scene of a served home page, name swapped for the marker. */
export function pageSubLine(html: string, name: string): string {
  const scene = html.indexOf('data-scene="wheel"');
  if (scene < 0) throw new Error("home: no wheel scene found");
  const m = /<p class="rfw-sub">([^<]*)<\/p>/.exec(html.slice(scene));
  if (!m) throw new Error("home: the wheel still has no sub line");
  if (!name) throw new Error("the brand name is empty");
  return m[1].split(name).join(MARK);
}

const markers = (s: string) => s.split(MARK).length - 1;

/** The whole check on two sub lines: one marker each, the rest equal. Returns "" when they agree. */
export function compareSubLines(page: string, script: string): string {
  if (markers(page) !== 1) return `the page's sub line holds ${markers(page)} name markers, not 1`;
  if (markers(script) !== 1)
    return `the script's sub line holds ${markers(script)} name markers, not 1`;
  return page === script
    ? ""
    : `the two sub lines differ:\n  page   ${JSON.stringify(page)}\n  script ${JSON.stringify(script)}`;
}

describe("K14a: the wheel's sub line is one string in home.html and rf-wheel-up.js", () => {
  const src = fs.readFileSync(WHEEL, "utf8");
  const home = readServedSitePage("home");

  it("the served home page carries no unfilled token (it was read as served)", () => {
    expect(home).not.toContain("{{brand:");
  });

  it("the script reads its name from the page's og:site_name and builds the still's line from the two HERO lines", () => {
    expect(src).toMatch(/const NAME = [^;]*og:site_name/);
    expect(src).toContain("${HERO[0].s} ${HERO[1].s}");
  });

  it("the page and the script say the same sentence, the name aside, once each", () => {
    expect(compareSubLines(pageSubLine(home, BRAND.name), scriptSubLine(src))).toBe("");
  });

  describe("the comparison goes red when it should", () => {
    const page = pageSubLine(home, BRAND.name);
    const script = scriptSubLine(src);
    const flip = (s: string, at: number) =>
      s.slice(0, at) + (s[at] === "x" ? "y" : "x") + s.slice(at + 1);

    it("one character changed on the page side", () => {
      expect(compareSubLines(flip(page, 3), script)).toMatch(/differ/);
    });

    it("one character changed on the script side", () => {
      expect(compareSubLines(page, flip(script, 3))).toMatch(/differ/);
    });

    it("a sub line with no name marker, or two", () => {
      expect(compareSubLines(page.split(MARK).join("x"), script)).toMatch(/holds 0 name markers/);
      expect(compareSubLines(page, `${script} ${MARK}`)).toMatch(/holds 2 name markers/);
    });

    it("a script that types the name instead of reading it holds no marker", () => {
      const typed = src.replace(
        `" + ${NAME_VAR} + ", start`,
        `" + ${JSON.stringify(BRAND.name)} + ", start`,
      );
      expect(typed).not.toBe(src);
      expect(compareSubLines(page, scriptSubLine(typed))).toMatch(/holds 0 name markers/);
    });

    it("a page or a script with no sub line throws instead of passing", () => {
      expect(() => pageSubLine("<p>nothing</p>", BRAND.name)).toThrow(/no wheel scene/);
      expect(() => scriptSubLine("const X = 1;")).toThrow(/no HERO list/);
    });
  });
});
