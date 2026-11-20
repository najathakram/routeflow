/**
 * @jest-environment node
 */
// The pin ledger's guard (B1321). The static site tests carry literal pins; a pin deleted for a good reason is a row in
// site-pin-ledger.json, and nothing else may shrink the count. Counted with the TypeScript parser, never a text scan (L-377):
// every scan below asserts it found its targets (L-202), and a probe for each was seen red before this shipped.
// Also: the wheel's end-state button comes from one constant, and home.html carries exactly that markup.
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import * as ts from "typescript";

const HERE = __dirname;
const SITE = path.resolve(HERE, "../../public/site");
const E2E = path.resolve(HERE, "../../e2e");

type Row = { file: string; pin: string; guarded: string; bug: string; replacedBy: string };
type Ledger = { definition: string; baseline: Record<string, number>; rows: Row[] };

const ledger: Ledger = JSON.parse(fs.readFileSync(path.join(HERE, "site-pin-ledger.json"), "utf8"));

// Whitespace-normalised, so a pin that wrapped over several lines compares equal to its one-line ledger text.
const norm = (s: string) =>
  s.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").replace(/, \)/g, ")").trim();

// The ledger's own definition: expect(...)[.not].toContain|toMatch(literal), literal = string, plain template, regex.
function literalPins(file: string): string[] {
  const text = fs.readFileSync(path.join(HERE, file), "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const pins: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ["toContain", "toMatch"].includes(n.expression.name.text) &&
      n.arguments.length > 0
    ) {
      let recv = n.expression.expression;
      if (ts.isPropertyAccessExpression(recv) && recv.name.text === "not") recv = recv.expression;
      const arg = n.arguments[0];
      const literal =
        ts.isStringLiteral(arg) ||
        ts.isNoSubstitutionTemplateLiteral(arg) ||
        ts.isRegularExpressionLiteral(arg);
      if (
        literal &&
        ts.isCallExpression(recv) &&
        ts.isIdentifier(recv.expression) &&
        recv.expression.text === "expect"
      ) {
        pins.push(n.getText());
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return pins;
}

const e2eTitles = (): Set<string> => {
  const ids = new Set<string>();
  for (const f of [
    "36-marketing-site.spec.ts",
    "84-site-proof-wheel.spec.ts",
    "85-site-proof-pages.spec.ts",
  ]) {
    const text = fs.readFileSync(path.join(E2E, f), "utf8");
    for (const m of text.matchAll(/\b(?:test|it)(?:\.\w+)*\(\s*["'`](T\d+) /g)) ids.add(m[1]);
  }
  return ids;
};

describe("the pin ledger accounts for every literal pin the static site tests lost", () => {
  const files = Object.keys(ledger.baseline);

  it("finds the six baseline files and at least one row", () => {
    expect(files).toHaveLength(6);
    expect(ledger.rows.length).toBeGreaterThanOrEqual(1);
    for (const f of files) expect(fs.existsSync(path.join(HERE, f))).toBe(true);
  });

  it.each(files)("%s: pins now + ledger rows == the base count", (file) => {
    const now = literalPins(file).length;
    expect(now).toBeGreaterThan(0);
    const rows = ledger.rows.filter((r) => r.file === file).length;
    expect(`${file}: ${now} + ${rows}`).toBe(`${file}: ${ledger.baseline[file] - rows} + ${rows}`);
  });

  it("every row names a baseline file", () => {
    const stray = ledger.rows.filter((r) => !files.includes(r.file)).map((r) => r.file);
    expect(stray).toEqual([]);
  });

  it("a ledger row's pin is really gone from its file", () => {
    const back: string[] = [];
    for (const r of ledger.rows) {
      const text = norm(fs.readFileSync(path.join(HERE, r.file), "utf8"));
      if (text.includes(norm(r.pin))) back.push(`${r.file}: ${r.pin}`);
    }
    expect(back).toEqual([]);
  });

  it("every row is replaced by a test that exists in the e2e specs", () => {
    const ids = e2eTitles();
    expect(ids.size).toBeGreaterThan(0);
    const bad = ledger.rows
      .filter((r) => !/^T\d+$/.test(r.replacedBy) || !ids.has(r.replacedBy))
      .map((r) => `${r.file}: ${r.replacedBy}`);
    expect(bad).toEqual([]);
  });
});

// Names live in the legend, so the wheel script paints none on the canvas. The check is a function of the
// source text so a probe can run it on a copy with a planted draw call and see it red.
const textDraws = (src: string): string[] => src.match(/\b(?:fillText|strokeText)\s*\(/g) ?? [];

describe("the wheel paints no name on the canvas", () => {
  const src = fs.readFileSync(path.join(SITE, "graphics/rf-wheel-up.js"), "utf8");

  it("holds no fillText( and no strokeText(", () => {
    expect(src.length).toBeGreaterThan(10_000);
    expect(textDraws(src)).toEqual([]);
  });

  it("the check sees a planted draw call", () => {
    expect(textDraws(src + '\nctx.fillText("x",0,0);')).toHaveLength(1);
    expect(textDraws(src + '\nctx.strokeText("x",0,0);')).toHaveLength(1);
  });
});

describe("the end-state trial button has one source", () => {
  const home = fs.readFileSync(path.join(SITE, "home.html"), "utf8");
  const src = fs.readFileSync(path.join(SITE, "graphics/rf-wheel-up.js"), "utf8");

  // The module needs no document at load: with none it only registers itself on `globalThis`.
  const load = () => {
    const sandbox: Record<string, unknown> = {};
    vm.runInNewContext(src, sandbox, { filename: "rf-wheel-up.js" });
    const api = sandbox.RFWheel as { staticHTML(): string; goHTML(): string } | undefined;
    if (!api || typeof api.goHTML !== "function") throw new Error("RFWheel.goHTML not exported");
    return api;
  };
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;

  it("the module evaluates headlessly and the still holds the button once", () => {
    const api = load();
    const go = api.goHTML();
    expect(go).toContain('class="sy-go"');
    expect(count(api.staticHTML(), go)).toBe(1);
  });

  it("home.html holds the same markup once, inside the wheel scene", () => {
    const go = load().goHTML();
    expect(count(home, go)).toBe(1);
    const open = home.indexOf('data-scene="wheel"');
    expect(open).toBeGreaterThan(-1);
    const tag = home.indexOf(">", open);
    // the scene element's own contents: find the matching close by tag depth
    let depth = 1;
    let i = tag + 1;
    const re = /<(\/?)div\b[^>]*>/g;
    re.lastIndex = i;
    let end = -1;
    for (let m = re.exec(home); m; m = re.exec(home)) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) {
        end = m.index;
        break;
      }
    }
    expect(end).toBeGreaterThan(tag);
    expect(count(home.slice(tag + 1, end), go)).toBe(1);
  });

  it("home.html has exactly one sy-go class", () => {
    expect(home.match(/\bsy-go\b/g) ?? []).toHaveLength(1);
  });
});
