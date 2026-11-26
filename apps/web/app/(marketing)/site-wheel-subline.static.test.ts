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
import { SITE_BRAND as BRAND } from "@routeflow/types/brand";
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

/** The page is served with this as the brand name: each place the file holds the name token shows it, a typed name does not. */
const SENTINEL = "ZZSENTINELNAMEZZ";
const NAME_TOKEN = SENTINEL;
const servedWithSentinel = () =>
  readServedSitePage("home", { brand: { ...BRAND, name: SENTINEL } });

/** The wheel still's sub line of the page served with the sentinel name: the file must carry the name token (once), not a name. */
export function rawPageSubLine(file: string): string {
  const scene = file.indexOf('data-scene="wheel"');
  if (scene < 0) throw new Error("home: no wheel scene found");
  const m = /<p class="rfw-sub">([^<]*)<[/]p>/.exec(file.slice(scene));
  if (!m) throw new Error("home: the wheel still has no sub line");
  return m[1];
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

  // The home page has no wheel still and no sub line any more: its one wheel is the story's ring, drawn by
  // home-scenes.js. What the page says about the name moved to the story's opening line, which reads the token.
  it("the page has no wheel still, and the story's opening line names the product from the token, once", () => {
    expect(home).not.toContain('data-scene="wheel"');
    const raw = servedWithSentinel();
    expect(raw.split(SENTINEL + " is an app for wholesalers.").length - 1).toBe(1);
    expect(raw).not.toContain(BRAND.name + " is an app for wholesalers.");
  });
});
