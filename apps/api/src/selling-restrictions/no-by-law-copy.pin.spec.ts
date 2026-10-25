/**
 * W-806 (SA-947 §2 MUST 4): the system does not know that any selling rule is a law, and staff may override every
 * rule it shows them (row 510), so no copy staff can read says "by law" or calls a rule a "legal ban". The business's
 * own reason is the text. This pin reads the staff-facing source (apps/web without the marketing site, apps/mobile,
 * apps/api/src/selling-restrictions) with comments removed and goes red on any such wording. The marketing terms page
 * is real legal text and is never scanned. A future non-overridable rule (SA-947 §3, LATER) adds its own copy and
 * decides then.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..", "..", "..");
const SCAN = [
  path.join(ROOT, "web"),
  path.join(ROOT, "mobile"),
  path.join(ROOT, "api", "src", "selling-restrictions"),
];
const SKIP_DIR = new Set([
  "node_modules",
  ".next",
  "dist",
  "e2e",
  "__tests__",
  "(marketing)",
  "coverage",
  ".expo",
]);
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js)$/;
const BANNED = /by law|legal (state )?bans?\b/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (/\.(ts|tsx|js)$/.test(e.name) && !TEST_FILE.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** Block comments, then line comments (not `://`). Strings and JSX text stay. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

describe("W-806 pin: no staff-facing copy says 'by law' or 'legal ban'", () => {
  const files = SCAN.flatMap((d) => walk(d));

  it("scans the staff surfaces", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("finds no hit", () => {
    const hits = files.flatMap((f) =>
      stripComments(fs.readFileSync(f, "utf8"))
        .split("\n")
        .map((line, i) => ({ f: path.relative(ROOT, f), n: i + 1, line }))
        .filter(({ line }) => BANNED.test(line))
        .map(({ f: rel, n, line }) => `${rel}:${n}: ${line.trim().slice(0, 100)}`),
    );
    expect(hits).toEqual([]);
  });
});
