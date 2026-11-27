/**
 * @jest-environment node
 */
// SA-1203 A11-A13, the walk's fix round: no run-wide kill at module scope in any e2e spec, a run folder key that is
// never a process id, scroll-through stops that meet every band, and W7's light rows. Text only; no browser.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  lightRowPlantProblems,
  mintRunId,
  resolveRunId,
  rgbContrast,
  scrollStops,
  type RingRead,
} from "../../e2e/helpers/site-colour-walk-pure";

// ── a small scanner: the calls to `name(` that sit at module scope ─────────────────────────────────
const CALLBACK_CALLEE =
  /^test(\.(beforeAll|beforeEach|afterAll|afterEach)|\.describe(\.(serial|parallel|only|skip|fixme))?)?$/;

/** The source with comments, strings and regex literals blanked (length kept); template `${}` stays code. */
function blank(src: string): string {
  const out = src.split("");
  const wipe = (a: number, b: number) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const templates: number[] = []; // brace depth at which each open `${` began
  let braces = 0;
  let last = ""; // the last significant character of code
  let word = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      wipe(i, j);
      i = j - 1;
    } else if (c === "/" && n === "*") {
      const j = src.indexOf("*/", i + 2);
      const end = j < 0 ? src.length : j + 2;
      wipe(i, end);
      i = end - 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      wipe(i + 1, j);
      i = j;
      last = c;
    } else if (
      c === "`" ||
      (c === "}" && templates.length > 0 && templates[templates.length - 1] === braces)
    ) {
      // template literal text: from here to the next backtick or `${`
      if (c === "}") templates.pop();
      let j = i + 1;
      while (j < src.length && src[j] !== "`" && !(src[j] === "$" && src[j + 1] === "{"))
        j += src[j] === "\\" ? 2 : 1;
      wipe(i + 1, j);
      if (src[j] === "$") {
        templates.push(braces);
        i = j + 1;
      } else i = j;
      last = "`";
    } else if (c === "/" && (last === "" || "(,=:[!&|?{};".includes(last) || word === "return")) {
      let j = i + 1;
      let cls = false;
      while (j < src.length && src[j] !== "\n" && (cls || src[j] !== "/")) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        j++;
      }
      wipe(i + 1, j);
      i = j;
      last = "/";
    } else if (!/\s/.test(c)) {
      if (c === "{") braces++;
      else if (c === "}") braces--;
      word = /[\w$]/.test(c) ? word + c : "";
      last = c;
    }
  }
  return out.join("");
}

/** 1-based line numbers of `name(` calls that are not inside a test, hook or describe callback body. */
function moduleScopeCalls(src: string, name: string): number[] {
  const code = blank(src);
  type Frame = { kind: "(" | "{"; callee: string };
  const stack: Frame[] = [];
  const hits: number[] = [];
  const call = new RegExp(`(^|[^\\w$.])${name}\\s*$`);
  let line = 1;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "\n") line++;
    else if (c === "(") {
      const before = code.slice(Math.max(0, i - 80), i);
      if (call.test(before)) {
        const ok = stack.some(
          (f, k) =>
            f.kind === "(" &&
            CALLBACK_CALLEE.test(f.callee) &&
            stack.slice(k + 1).some((g) => g.kind === "{"),
        );
        if (!ok) hits.push(line);
      }
      const m = before.match(/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*$/);
      stack.push({ kind: "(", callee: m ? m[1].replace(/\s+/g, "") : "" });
    } else if (c === "{") stack.push({ kind: "{", callee: "" });
    else if (c === ")" || c === "}") {
      const want = c === ")" ? "(" : "{";
      for (let k = stack.length - 1; k >= 0; k--)
        if (stack[k].kind === want) {
          stack.length = k;
          break;
        }
    }
  }
  return hits;
}

const E2E = path.resolve(__dirname, "..", "..", "e2e");
const specs = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : specs(p);
    return e.name.endsWith(".spec.ts") ? [p] : [];
  });

describe("a run-wide kill is never armed at module scope (the runner and the non-walk tests carry none)", () => {
  it("the scanner: a module-scope call is red, one inside a test, hook or describe is not", () => {
    const planted = [
      'import { armRunKill } from "./h";',
      "armRunKill(900000);",
      'test("x", () => {});',
    ].join("\n");
    expect(moduleScopeCalls(planted, "armRunKill")).toEqual([2]);
    expect(moduleScopeCalls("if (flag) {\n  armRunKill(1);\n}\n", "armRunKill")).toEqual([2]);
    expect(moduleScopeCalls("function arm() {\n  armRunKill(1);\n}\n", "armRunKill")).toEqual([2]);
    const fine = [
      'test("a", async () => {',
      "  armRunKill(1);",
      "});",
      "test.beforeEach(() => {",
      "  armRunKill(2);",
      "});",
      'test.describe("d", () => {',
      "  test.afterAll(async () => {",
      "    armRunKill(3);",
      "  });",
      "});",
    ].join("\n");
    expect(moduleScopeCalls(fine, "armRunKill")).toEqual([]);
  });

  it("the scanner ignores strings, comments, regexes and templates, and sees a call after them", () => {
    const text = [
      "// armRunKill(1);",
      "/* armRunKill(2); */",
      'const a = "armRunKill(3)";',
      "const b = /[\"']armRunKill(4)/;",
      "const c = `x ${1} armRunKill(5) ${2}`;",
      'test("t", () => {',
      "  const s = '}';",
      "});",
      "armRunKill(6);",
    ].join("\n");
    expect(moduleScopeCalls(text, "armRunKill")).toEqual([9]);
    expect(moduleScopeCalls("const d = `${armRunKill(7)}`;", "armRunKill")).toEqual([1]);
  });

  it("the real e2e specs arm it nowhere at module scope", () => {
    const files = specs(E2E);
    expect(files.length).toBeGreaterThan(20);
    const bad = files.flatMap((f) =>
      moduleScopeCalls(fs.readFileSync(f, "utf8"), "armRunKill").map(
        (l) => `${path.relative(E2E, f)}:${l}`,
      ),
    );
    expect(bad).toEqual([]);
    // and the two walk specs do arm it, inside their tests
    for (const f of ["85-site-proof-pages.spec.ts", "96-site-t16-plants.spec.ts"])
      expect(fs.readFileSync(path.join(E2E, f), "utf8")).toMatch(/armRunKill\(WALK_RUN_HARD_MS\)/);
  });
});

describe("the run folder key is minted per run and never a process id", () => {
  it("T16_RUN_ID overrides; with none, each run mints a fresh key, even under the same parent pid", () => {
    expect(resolveRunId({ T16_RUN_ID: "mine" }, () => "minted")).toBe("mine");
    const ppid = 4242; // the same parent process for both runs: it must not matter
    let tick = 0;
    const mint = () => mintRunId(1_000 + tick++, "abcd12");
    const first = resolveRunId({}, mint);
    const second = resolveRunId({}, mint);
    expect(first).not.toBe(second);
    expect(`${first}${second}`).not.toContain(String(ppid));
    // the folders (and so the start time and the crop count in them) are separate
    expect(`run-${first}`).not.toBe(`run-${second}`);
  });

  it("the helper keys the folder on the run id, with no ppid anywhere", () => {
    const walk = fs.readFileSync(path.join(E2E, "helpers", "site-colour-walk.ts"), "utf8");
    expect(walk).not.toContain("process.ppid");
    expect(walk).toContain("run-${process.env.T16_RUN_ID}");
  });
});

describe("the scroll-through meets every band, whatever its height", () => {
  const gapsOk = (stops: number[], step: number) =>
    stops.every((s, i) => i === 0 || s - stops[i - 1] <= step);
  it("a 40 px band between two tall bands still gets a stop, and no step is over the bound", () => {
    const bands = [
      { top: 0, bottom: 1000 },
      { top: 1000, bottom: 1040 },
      { top: 1040, bottom: 2200 },
    ];
    const header = 64;
    const stops = scrollStops(1300, 200, bands, header);
    // a stop where the band's top meets the header bottom, and one inside the span the band is under it
    expect(stops).toContain(1000 - header);
    expect(stops.some((s) => s > 1000 - header && s < 1040 - header)).toBe(true);
    expect(stops[0]).toBe(0);
    expect(stops[stops.length - 1]).toBe(1300);
    expect(gapsOk(stops, 200)).toBe(true);
    expect(stops).toEqual([...stops].sort((a, b) => a - b));
  });
  it("with no bands the stops are the plain step walk to the end", () => {
    const stops = scrollStops(450, 200, [], 0);
    expect(stops[0]).toBe(0);
    expect(stops[stops.length - 1]).toBe(450);
    expect(gapsOk(stops, 200)).toBe(true);
  });
  it("an edge beyond the end of the page is clamped to it", () => {
    const stops = scrollStops(500, 200, [{ top: 900, bottom: 940 }], 64);
    expect(Math.max(...stops)).toBe(500);
    expect(Math.min(...stops)).toBe(0);
  });
});

describe("W7's light rows: red only where white is under 3:1, and the planted white is read", () => {
  const WHITE = "rgb(255, 255, 255)";
  const light = (over: Partial<RingRead>): RingRead =>
    ({
      sel: 'a.x "Go"',
      state: "measured",
      ring: { style: "solid", width: 3, color: WHITE, offset: 2 },
      backdrop: "rgb(255, 255, 255)",
      ringContrast: 1,
      bandDark: false,
      focusTok: WHITE,
      onPanel: WHITE,
      ...over,
    }) as RingRead;
  it("white on a light backdrop (under 3:1) must be red", () => {
    expect(rgbContrast(WHITE, "rgb(250, 250, 250)")).toBeLessThan(3);
    expect(
      lightRowPlantProblems(light({ backdrop: "rgb(250, 250, 250)", ringContrast: 1.04 })),
    ).toEqual([]);
    expect(
      lightRowPlantProblems(light({ backdrop: "rgb(250, 250, 250)", ringContrast: 9 })),
    ).toEqual([expect.stringContaining("is green")]);
  });
  it("white on a dark backdrop that is not a token (3:1 or more) may be green", () => {
    const dark = "rgb(40, 40, 40)";
    expect(rgbContrast(WHITE, dark)).toBeGreaterThanOrEqual(3);
    expect(lightRowPlantProblems(light({ backdrop: dark, ringContrast: 14 }))).toEqual([]);
  });
  it("a row with no local setter must read the planted white token", () => {
    const out = lightRowPlantProblems(light({ focusTok: "rgb(17, 17, 17)" }));
    expect(out.join(" ")).toContain("must read the planted white");
  });
});
