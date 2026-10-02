/**
 * Declared-dependency pin: every package a control spec or control source file loads must be
 * declared in apps/control/package.json (dependencies or devDependencies).
 *
 * WHY. `.github/workflows/control.yml` installs ONLY control's own tree
 * (`npm ci -w @routeflow/control --include-workspace-root=false`). A package that resolves here
 * only because a SIBLING workspace pulled it into the hoisted root node_modules (jsdom, via
 * apps/web's jest-environment-jsdom) works on a developer machine and in the full-workspace
 * Verify job, then fails `Cannot find module` in the scoped CI install. The first Control CI run
 * went red that way; this spec catches it locally, before the push.
 *
 * Scope: `require("x")`, `require.resolve("x")`, static `from "x"` and dynamic `import("x")` with a
 * string-literal specifier, in apps/control/test/** and apps/control/src/** (.ts, .js, .mjs).
 * A `@jest-environment <name>` docblock loads the package `jest-environment-<name>` (the real
 * scoped install lacked jest-environment-jsdom: two suites died with "Test environment cannot be
 * found"), so it counts as a load too; `node` is Jest's own default and is not a package.
 * Relative paths, `node:` URLs and Node builtins are not packages. A specifier is reduced to its
 * package name (`pkg/sub` -> `pkg`, `@scope/pkg/sub` -> `@scope/pkg`).
 */
import * as fs from "fs";
import * as path from "path";
import { builtinModules } from "module";

const CONTROL_DIR = path.resolve(__dirname, "..");
const SCAN_DIRS = [path.join(CONTROL_DIR, "test"), path.join(CONTROL_DIR, "src")];
const EXTS = [".ts", ".js", ".mjs"];

/** Overridable so the parser can be proven on literals and on a package.json without jsdom. */
const SPECIFIER_PATTERNS: RegExp[] = [
  /\brequire\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g,
  /\brequire\.resolve\s*\(\s*(["'])([^"'\n]+)\1/g,
  /\bfrom\s+(["'])([^"'\n]+)\1/g,
  /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g,
];

/**
 * Loaded by a spec but deliberately NOT declared: it is a hard dependency of a declared devDependency,
 * so every scoped install contains it. Each entry names its provider; a new entry needs the same
 * proof, and the last test below fails when an entry stops being loaded (no stale exemptions).
 */
const TRANSITIVE_BY_DESIGN: Record<string, string> = {
  "js-yaml": "@eslint/eslintrc (dependency of eslint); workflow-triggers.spec.ts",
};

const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, "").split("/")[0]));

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...walk(p));
    else if (EXTS.includes(path.extname(p))) out.push(p);
  }
  return out;
}

/** The package a specifier names, or null for a relative path, a `node:` URL or a Node builtin. */
export function packageOf(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) {
    return null;
  }
  const segs = specifier.split("/");
  const name = specifier.startsWith("@") ? segs.slice(0, 2).join("/") : segs[0];
  if (!specifier.startsWith("@") && BUILTINS.has(name)) return null;
  return name;
}

/** `@jest-environment jsdom` in a docblock -> `jest-environment-jsdom` (`node` ships with Jest). */
const ENVIRONMENT_DOCBLOCK = /^\s*\*\s*@jest-environment\s+([\w.-]+)\s*$/gm;

export function specifiersOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ENVIRONMENT_DOCBLOCK)) {
    if (m[1] !== "node") out.push(`jest-environment-${m[1]}`);
  }
  for (const re of SPECIFIER_PATTERNS) {
    for (const m of text.matchAll(re)) out.push(m[2]);
  }
  return out;
}

/** package name -> the repo-relative files that load it. */
function loadedPackages(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      if (file === __filename) continue; // its own literals are parser fixtures, not loads
      for (const spec of specifiersOf(fs.readFileSync(file, "utf8"))) {
        const pkg = packageOf(spec);
        if (pkg === null) continue;
        const rel = path.relative(CONTROL_DIR, file).split(path.sep).join("/");
        found.set(pkg, [...(found.get(pkg) ?? []), rel]);
      }
    }
  }
  return found;
}

function declared(): Set<string> {
  const pkg = JSON.parse(fs.readFileSync(path.join(CONTROL_DIR, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
}

describe("every package control loads is declared in apps/control/package.json", () => {
  it("the specifier parser means what it says", () => {
    expect(packageOf("jsdom")).toBe("jsdom");
    expect(packageOf("jsdom/lib/api")).toBe("jsdom");
    expect(packageOf("@types/node")).toBe("@types/node");
    expect(packageOf("@eslint/js/sub/path")).toBe("@eslint/js");
    expect(packageOf("./x")).toBeNull();
    expect(packageOf("../x")).toBeNull();
    expect(packageOf("node:fs")).toBeNull();
    expect(packageOf("fs")).toBeNull();
    expect(packageOf("fs/promises")).toBeNull();
    expect(packageOf("child_process")).toBeNull();
    expect(
      specifiersOf(
        [
          'const a = require("one");',
          "const b = require('two/sub');",
          'const c = require.resolve("three/package.json");',
          'import d from "four";',
          'import { e } from "@five/six/seven";',
          'const f = await import("eight");',
          'const g = require("./rel");',
          "/**",
          " * @jest-environment jsdom",
          " */",
          " * @jest-environment node",
        ].join("\n"),
      ).sort(),
    ).toEqual(
      [
        "one",
        "two/sub",
        "three/package.json",
        "four",
        "@five/six/seven",
        "eight",
        "./rel",
        "jest-environment-jsdom",
      ].sort(),
    );
  });

  it("scans a non-empty set of files and finds the packages this service is known to load", () => {
    const found = loadedPackages();
    for (const known of ["jsdom", "js-yaml", "jest-environment-jsdom"])
      expect([...found.keys()]).toContain(known);
  });

  it("each one is a dependency or devDependency (a scoped CI install has no hoisted siblings)", () => {
    const have = declared();
    const missing = [...loadedPackages()]
      .filter(([pkg]) => !have.has(pkg) && !(pkg in TRANSITIVE_BY_DESIGN))
      .map(([pkg, files]) => ({ pkg, files: [...new Set(files)].sort() }));
    expect(missing).toEqual([]);
  });

  it("every TRANSITIVE_BY_DESIGN exemption is still loaded and still undeclared", () => {
    const found = loadedPackages();
    const have = declared();
    for (const pkg of Object.keys(TRANSITIVE_BY_DESIGN)) {
      expect([...found.keys()]).toContain(pkg);
      expect(have.has(pkg)).toBe(false);
    }
  });
});
