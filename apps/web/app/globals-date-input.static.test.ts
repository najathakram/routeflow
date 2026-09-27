import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const DATE_INPUT_TYPES = new Set(["date", "time", "datetime-local", "month", "week"]);
/** A width utility (any breakpoint), or a flex grow that sizes the input from its row. */
const SIZES_ITSELF = /(^|[\s"'`])((sm|md|lg|xl):)?(w-|flex-1\b|flex-auto\b|grow\b)/;

/** Every string literal inside `node` (a `cn(...)` call, a ternary, a template), joined. */
function stringsIn(node: ts.Node): string {
  const out: string[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n)) out.push(n.text);
    ts.forEachChild(n, walk);
  };
  walk(node);
  return out.join(" ");
}

function findUnsizedDateInputs(webRoot: string): { scanned: number; unsized: string[] } {
  const unsized: string[] = [];
  let scanned = 0;
  const visitFile = (file: string) => {
    const sf = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    // Same-file class constants (`const fieldCls = "..."`, `const inputCls = (err) => cn(...)`).
    const consts = new Map<string, string>();
    const collect = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        consts.set(n.name.text, stringsIn(n.initializer));
      }
      ts.forEachChild(n, collect);
    };
    collect(sf);
    const visit = (n: ts.Node) => {
      const el = ts.isJsxSelfClosingElement(n) ? n : ts.isJsxOpeningElement(n) ? n : null;
      if (el && el.tagName.getText(sf) === "input") {
        const attr = (name: string) =>
          el.attributes.properties.find(
            (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === name,
          );
        const type = attr("type")?.initializer;
        if (type && ts.isStringLiteral(type) && DATE_INPUT_TYPES.has(type.text)) {
          scanned += 1;
          const cls = attr("className")?.initializer;
          let text = "";
          if (cls && ts.isStringLiteral(cls)) text = cls.text;
          else if (cls && ts.isJsxExpression(cls) && cls.expression) {
            text = stringsIn(cls.expression);
            ts.forEachChild(cls.expression, function refs(c: ts.Node) {
              if (ts.isIdentifier(c) && consts.has(c.text)) text += " " + consts.get(c.text);
              ts.forEachChild(c, refs);
            });
            if (ts.isIdentifier(cls.expression))
              text += " " + (consts.get(cls.expression.text) ?? "");
          }
          if (!SIZES_ITSELF.test(text)) {
            const { line } = sf.getLineAndCharacterOfPosition(el.getStart(sf));
            unsized.push(`${path.relative(webRoot, file).split(path.sep).join("/")}:${line + 1}`);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  };
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".next", "e2e", "test-results"].includes(e.name)) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith(".tsx") && !e.name.endsWith(".test.tsx")) visitFile(f);
    }
  };
  for (const top of ["app", "components"]) walk(path.join(webRoot, top));
  return { scanned, unsized };
}

// #2080: globals.css's date/time-input rule. A positive min-width there overrides a narrower
// `w-*` (width is not min-width) and overflows every date input in a narrow grid track; the
// iOS fix needs both the prefixed and unprefixed `appearance` (no autoprefixer runs here).
const css = fs.readFileSync(path.join(__dirname, "globals.css"), "utf8");
const DATE_TYPES = /input\[type="(date|time|datetime-local|month|week)"\]/;
const rules = Array.from(css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g))
  .filter(([, selector]) => DATE_TYPES.test(selector))
  .map(([, selector, body]) => ({ selector: selector.trim(), body }));

describe("globals.css date/time-input rule (#2080)", () => {
  it("exists", () => {
    expect(rules.length).toBeGreaterThan(0);
  });

  it("never sets a positive min-width on a date/time input", () => {
    const positive = rules.filter((r) =>
      Array.from(r.body.matchAll(/min-width\s*:\s*([^;]+)/g)).some(
        ([, v]) => !/^0(px)?$/.test(v.trim()),
      ),
    );
    expect(positive.map((r) => r.selector)).toEqual([]);
  });

  // With `appearance: none` + `min-width: 0` a date/time input with no width of its own shrinks to
  // its content on iOS, so EVERY one in apps/web must size itself. Repo-wide, no allow-list: the
  // TypeScript AST finds each `<input type="date|time|...">` (comments and strings can't fool it).
  it("every date/time <input> in apps/web sets its own width", () => {
    const missing = findUnsizedDateInputs(path.join(__dirname, ".."));
    expect(missing.scanned).toBeGreaterThan(50);
    expect(missing.unsized).toEqual([]);
  });

  it("switches off the native appearance with both the prefixed and unprefixed property", () => {
    const main = rules.find((r) => !r.selector.includes("::"));
    expect(main?.body).toMatch(/(^|[\s;])-webkit-appearance\s*:\s*none/);
    expect(main?.body).toMatch(/(^|[\s;])appearance\s*:\s*none/);
    expect(main?.body).toMatch(/box-sizing\s*:\s*border-box/);
  });
});
