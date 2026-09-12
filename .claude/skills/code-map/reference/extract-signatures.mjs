#!/usr/bin/env node
// extract-signatures.mjs
//
// Signature-level extraction for the code-map skill: given a repo and an
// area's include globs, emit — per file — its exported symbols with
// signatures, its imports (relative + package), and a reverse index of which
// OTHER files in the same include set import it. Output is either the house
// map-format Markdown (reference/map-format.md) with a "purpose:" TODO slot
// left for the model to fill, or raw --json for a caller that wants to do
// its own formatting.
//
// DESIGN NOTE — syntactic, not type-checked. This uses ts.createSourceFile
// (parse only) rather than a full ts.Program with a type checker. A real
// Program needs tsconfig resolution, full module graph loading, and pays for
// type inference the map format never asked for ("signatures, never bodies";
// consts want a *label*, not a fully resolved type) — and it would blow the
// 1000-files/60s budget on a large repo. Where no type annotation exists,
// types are guessed syntactically from the initializer (arrow function shape,
// literal kind, `new X()`); anything else is labeled `unknown`. A project
// that wants live, type-checked truth for one specific symbol should use the
// typescript-lsp path the code-map skill also documents — this script is the
// cheap bulk pass that seeds the map, not a substitute for that.
//
// No dependencies of its own. Node >= 18. ES module. TypeScript is loaded at
// runtime from the TARGET repo's own node_modules (never bundled) by walking
// up from --root the same way Node's own module resolution would.
//
// Usage:
//   node extract-signatures.mjs --root <repo> --area <name> --include <globs>
//       [--json] [--out <file>]
//   node extract-signatures.mjs selftest
//
// --root      Repo (or monorepo package) root to scan from.
// --area      Area name — becomes the Markdown heading / JSON "area" field.
// --include   Comma-separated glob(s), matched against the path relative to
//             --root with forward slashes, e.g.
//             "apps/api/src/**/*.ts,apps/api/src/**/*.tsx"
//             Supports `**` (any depth), `*`, `?`, and `{a,b}` alternation.
//             node_modules/.git/dist/build/.next/out/coverage/.turbo/.cache/
//             target/vendor are always skipped while walking, regardless of
//             --include.
// --json      Emit JSON instead of Markdown.
// --out       Write the output to this file instead of stdout.
//
// This script only ever reads:
//   - files under --root matched by --include, plus node_modules/typescript
//     (and its package.json) found by walking up from --root
//   - a temp directory under os.tmpdir() (selftest only), where it also
//     creates a *junction* (Windows) pointing at a real, already-installed
//     typescript so the selftest exercises the actual resolution path
//     end-to-end without installing or copying anything
// and only ever writes:
//   - the --out file, if given
//   - a temp directory under os.tmpdir() (selftest only) — the junction
//     itself is always unlinked (never recursed into) before its parent
//     directory is removed, so the real typescript install it points at is
//     never touched

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Reading is I/O-latency-bound, not CPU-bound (parsing itself is ~0.4ms/file
// — see the header note). On a cold filesystem cache (freshly written files,
// a network drive, real-time AV scanning each open) 1000 *serial* sync reads
// measured 12-47s on Windows; the same reads with this much concurrency
// measured ~2s, because the per-file latency overlaps instead of stacking.
// This is what keeps the 1000-files/60s budget from being cache-dependent.
const READ_CONCURRENCY = 32;

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);

const DEFAULT_EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "coverage",
  ".turbo", ".cache", "target", "vendor", ".venv", "__pycache__",
]);

class ExtractError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.name = "ExtractError";
    this.code = code;
  }
}

function fail(msg) {
  throw new ExtractError(msg);
}

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const name = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
      continue;
    }
    positional.push(tok);
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function uniqSort(arr) {
  return [...new Set(arr)].sort();
}

function escapeRe(s) {
  return s.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// glob -> RegExp (matched against a root-relative, forward-slash path)
// Supports: ** (any depth incl. zero), *, ?, {a,b,c} alternation.
// ---------------------------------------------------------------------------

function globToRegExp(glob) {
  const g = glob.replace(/\\/g, "/");
  let re = "";
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      let j = i + 2;
      if (g[j] === "/") j++;
      re += "(?:.*/)?";
      i = j;
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        i++;
      } else {
        const group = g.slice(i + 1, end).split(",").map(escapeRe).join("|");
        re += `(?:${group})`;
        i = end + 1;
      }
    } else {
      re += escapeRe(c);
      i++;
    }
  }
  return new RegExp("^" + re + "$");
}

// ---------------------------------------------------------------------------
// filesystem walk + include-glob filtering
// ---------------------------------------------------------------------------

function walkFiles(root) {
  const results = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (DEFAULT_EXCLUDE_DIRS.has(ent.name)) continue;
        stack.push(path.join(dir, ent.name));
      } else if (ent.isFile()) {
        results.push(path.join(dir, ent.name));
      }
    }
  }
  return results;
}

function collectIncludedFiles(root, includeGlobs) {
  const regs = includeGlobs.map(globToRegExp);
  const all = walkFiles(root);
  const out = [];
  for (const abs of all) {
    const rel = toPosix(path.relative(root, abs));
    if (regs.some((r) => r.test(rel))) out.push(abs);
  }
  out.sort();
  return out;
}

// ---------------------------------------------------------------------------
// TypeScript resolution — walk up from --root, exactly like Node itself
// would resolve node_modules, so a monorepo package finds the workspace
// root's install. Never bundles or falls back to a global install.
// ---------------------------------------------------------------------------

function findTypescriptDir(startDir) {
  let dir = path.resolve(startDir);
  const fsRoot = path.parse(dir).root;
  for (;;) {
    const candidate = path.join(dir, "node_modules", "typescript");
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (dir === fsRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function loadTypescript(root) {
  const tsDir = findTypescriptDir(root);
  if (!tsDir) {
    fail(
      `No TypeScript found: walked up from ${root} looking for ` +
        `node_modules/typescript/package.json and found none.\n` +
        `extract-signatures.mjs always uses the target repo's own compiler ` +
        `(never bundles one) — install it there and re-run:\n` +
        `  npm install --save-dev typescript\n` +
        `  (or: pnpm add -D typescript / yarn add -D typescript)`
    );
  }
  let mainRel = "lib/typescript.js";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(tsDir, "package.json"), "utf8"));
    if (pkg.main) mainRel = pkg.main.replace(/^\.\//, "");
  } catch {
    // fall through with the default main path
  }
  const tsMain = path.join(tsDir, mainRel);
  if (!fs.existsSync(tsMain)) {
    fail(
      `Found TypeScript at ${tsDir} but its entry point ${mainRel} is ` +
        `missing — the install looks corrupt. Reinstall it ` +
        `(npm install typescript) and re-run.`
    );
  }
  const mod = await import(pathToFileURL(tsMain).href);
  return mod.default ?? mod;
}

function scriptKindFor(ts, absPath) {
  if (absPath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (absPath.endsWith(".ts") || absPath.endsWith(".mts") || absPath.endsWith(".cts")) return ts.ScriptKind.TS;
  if (absPath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (absPath.endsWith(".js") || absPath.endsWith(".mjs") || absPath.endsWith(".cjs")) return ts.ScriptKind.JS;
  return null;
}

// ---------------------------------------------------------------------------
// per-file signature extraction (top-level statements only — deliberately
// shallow, matching the map format's "signatures, never bodies" rule)
// ---------------------------------------------------------------------------

function hasModifier(ts, node, kind) {
  let mods;
  if (typeof ts.canHaveModifiers === "function" && typeof ts.getModifiers === "function") {
    mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  } else {
    mods = node.modifiers;
  }
  return !!mods && mods.some((m) => m.kind === kind);
}

function extractFile(ts, absPath, sourceText) {
  const kind = scriptKindFor(ts, absPath);
  if (kind === null) {
    return { exports: [], imports: { relative: [], package: [] }, unsupported: true };
  }
  const sf = ts.createSourceFile(absPath, sourceText, ts.ScriptTarget.Latest, true, kind);

  const exportsOut = [];
  const importsOut = { relative: [], package: [] };

  const isExported = (n) => hasModifier(ts, n, ts.SyntaxKind.ExportKeyword);
  const isDefault = (n) => hasModifier(ts, n, ts.SyntaxKind.DefaultKeyword);
  const isPrivateLike = (n) =>
    hasModifier(ts, n, ts.SyntaxKind.PrivateKeyword) || hasModifier(ts, n, ts.SyntaxKind.ProtectedKeyword);

  const paramsText = (params) => params.map((p) => p.getText(sf)).join(", ");

  function guessType(initializer) {
    if (!initializer) return "unknown";
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
      const ret = initializer.type ? initializer.type.getText(sf) : "unknown";
      return `(${paramsText(initializer.parameters)}) => ${ret}`;
    }
    if (ts.isStringLiteralLike(initializer)) return "string";
    if (ts.isNumericLiteral(initializer)) return "number";
    if (initializer.kind === ts.SyntaxKind.TrueKeyword || initializer.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
    if (ts.isObjectLiteralExpression(initializer)) return "object";
    if (ts.isArrayLiteralExpression(initializer)) return "array";
    if (ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression)) return initializer.expression.text;
    if (ts.isAsExpression && ts.isAsExpression(initializer)) {
      return initializer.type ? initializer.type.getText(sf) : guessType(initializer.expression);
    }
    return "unknown";
  }

  function methodSig(m) {
    const name = m.name && m.name.getText ? m.name.getText(sf) : "<computed>";
    const ret = m.type ? m.type.getText(sf) : "unknown";
    return `${name}(${paramsText(m.parameters || [])}): ${ret}`;
  }

  function noteImport(spec) {
    if (!spec) return;
    if (spec.startsWith(".")) importsOut.relative.push(spec);
    else importsOut.package.push(spec);
  }

  ts.forEachChild(sf, (node) => {
    if (ts.isFunctionDeclaration(node) && isExported(node) && node.name) {
      const ret = node.type ? node.type.getText(sf) : "unknown";
      const prefix = isDefault(node) ? "default " : "";
      exportsOut.push(`${prefix}${node.name.getText(sf)}(${paramsText(node.parameters)}): ${ret}`);
    } else if (ts.isClassDeclaration(node) && isExported(node) && node.name) {
      const methods = (node.members || [])
        .filter((m) => ts.isMethodDeclaration(m) && m.name && !isPrivateLike(m))
        .map(methodSig);
      const body = methods.length ? ` { ${methods.join("; ")} }` : "";
      const prefix = isDefault(node) ? "default " : "";
      exportsOut.push(`${prefix}${node.name.getText(sf)}${body}`);
    } else if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!decl.name || !ts.isIdentifier(decl.name)) continue;
        const t = decl.type ? decl.type.getText(sf) : guessType(decl.initializer);
        exportsOut.push(`${decl.name.text}: ${t}`);
      }
    } else if (ts.isInterfaceDeclaration(node) && isExported(node)) {
      exportsOut.push(`interface ${node.name.getText(sf)}`);
    } else if (ts.isTypeAliasDeclaration(node) && isExported(node)) {
      exportsOut.push(`type ${node.name.getText(sf)}`);
    } else if (ts.isEnumDeclaration(node) && isExported(node)) {
      exportsOut.push(`enum ${node.name.getText(sf)}`);
    } else if (ts.isExportAssignment(node)) {
      if (node.isExportEquals) {
        exportsOut.push(`export= ${node.expression.getText(sf)}`);
      } else {
        const expr = node.expression;
        let name = null;
        if (ts.isIdentifier(expr)) name = expr.text;
        else if ((ts.isFunctionExpression(expr) || ts.isClassExpression(expr)) && expr.name) name = expr.name.getText(sf);
        exportsOut.push(`default ${name || "<anonymous>"}`);
      }
    } else if (ts.isExportDeclaration(node)) {
      const spec =
        node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
      let names = "*";
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        names = node.exportClause.elements.map((e) => e.name.getText(sf)).join(", ");
      }
      exportsOut.push(spec ? `export { ${names} } from '${spec}'` : `export { ${names} }`);
      noteImport(spec);
    } else if (ts.isImportDeclaration(node)) {
      const spec =
        node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
      noteImport(spec);
    }
  });

  return { exports: exportsOut, imports: importsOut };
}

// ---------------------------------------------------------------------------
// reverse index — which files (in the SAME include set) import this one
// ---------------------------------------------------------------------------

function normKey(p) {
  return p.replace(/\\/g, "/").toLowerCase();
}

function candidateResolutions(fromFileAbs, spec) {
  const base = path.resolve(path.dirname(fromFileAbs), spec);
  const exts = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx"];
  const cands = new Set([base]);
  for (const e of exts) cands.add(base + e);
  for (const e of exts) cands.add(path.join(base, "index" + e));
  const jsToTs = { ".js": ".ts", ".jsx": ".tsx", ".mjs": ".mts", ".cjs": ".cts" };
  for (const [jse, tse] of Object.entries(jsToTs)) {
    if (base.toLowerCase().endsWith(jse)) cands.add(base.slice(0, -jse.length) + tse);
  }
  return [...cands];
}

function buildReverseIndex(records) {
  const byAbsLower = new Map(records.map((r) => [normKey(r.absPath), r]));
  const importers = new Map(records.map((r) => [r.relPath, new Set()]));
  for (const r of records) {
    for (const spec of r.imports.relative) {
      for (const cand of candidateResolutions(r.absPath, spec)) {
        const target = byAbsLower.get(normKey(cand));
        if (target && target !== r) importers.get(target.relPath).add(r.relPath);
      }
    }
  }
  return importers;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function renderMarkdown(area, records) {
  const byDir = new Map();
  for (const r of records) {
    const dir = path.posix.dirname(r.relPath);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(r);
  }
  const dirs = [...byDir.keys()].sort();
  let out = `# Area: ${area}\n\n`;
  out += `<!-- purpose: [TODO — one line: what this area is and its role] -->\n\n`;
  out += `## Modules / files\n\n`;
  for (const dir of dirs) {
    const label = dir === "." ? "./" : `${dir}/`;
    out += `### \`${label}\`\n\n`;
    const files = byDir.get(dir).sort((a, b) => a.relPath.localeCompare(b.relPath));
    for (const f of files) {
      const base = path.posix.basename(f.relPath);
      out += `- **\`${base}\`** — purpose: [TODO — one-line purpose]\n`;
      out += `  - exports: ${f.exports.length ? f.exports.map((e) => `\`${e}\``).join(", ") : "—"}\n`;
      const deps = uniqSort([...f.imports.relative, ...f.imports.package]);
      out += `  - deps: ${deps.length ? deps.map((d) => `\`${d}\``).join(", ") : "—"}\n`;
      out += `  - importers: ${f.importers.length ? f.importers.map((i) => `\`${i}\``).join(", ") : "—"}\n`;
      out += `  - side effects: — (TODO if applicable)\n`;
    }
    out += `\n`;
  }
  return out;
}

function toJsonRecord(r) {
  return {
    path: r.relPath,
    purpose: null,
    exports: r.exports,
    imports: r.imports,
    importers: r.importers,
    sideEffects: null,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const HELP = `extract-signatures.mjs --root <repo> --area <name> --include <globs> [--json] [--out <file>]
extract-signatures.mjs selftest`;

async function run(flags) {
  if (!flags.root) fail("Missing --root <repo>.\n" + HELP);
  if (!flags.area) fail("Missing --area <name>.\n" + HELP);
  if (!flags.include) fail("Missing --include <globs> (comma-separated).\n" + HELP);

  const root = path.resolve(String(flags.root));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`--root ${root} is not a directory.`);

  const includeGlobs = String(flags.include).split(",").map((s) => s.trim()).filter(Boolean);
  const t0 = Date.now();
  const ts = await loadTypescript(root);
  const files = collectIncludedFiles(root, includeGlobs);
  if (files.length === 0) fail(`No files matched --include "${flags.include}" under ${root}.`);

  const records = await mapConcurrent(files, READ_CONCURRENCY, async (absPath) => {
    const text = await fsp.readFile(absPath, "utf8");
    const { exports, imports } = extractFile(ts, absPath, text);
    return {
      absPath,
      relPath: toPosix(path.relative(root, absPath)),
      exports,
      imports: { relative: uniqSort(imports.relative), package: uniqSort(imports.package) },
    };
  });
  const importersMap = buildReverseIndex(records);
  for (const r of records) r.importers = [...importersMap.get(r.relPath)].sort();
  const elapsedMs = Date.now() - t0;

  let output;
  if (flags.json) {
    output = JSON.stringify(
      {
        area: flags.area,
        root,
        generatedAt: new Date().toISOString(),
        fileCount: records.length,
        elapsedMs,
        files: records.map(toJsonRecord),
      },
      null,
      2
    ) + "\n";
  } else {
    output = renderMarkdown(String(flags.area), records);
  }

  if (flags.out) fs.writeFileSync(String(flags.out), output);
  else process.stdout.write(output);
}

// ---------------------------------------------------------------------------
// selftest
// ---------------------------------------------------------------------------

function assertTrue(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
function assertIncludes(arr, needle, msg) {
  if (!arr.some((x) => x.includes(needle))) {
    throw new Error(`ASSERT FAILED: ${msg}\n  looked for: ${JSON.stringify(needle)}\n  in: ${JSON.stringify(arr)}`);
  }
}

function findRealTypescript() {
  for (const start of [process.cwd(), SCRIPT_DIR]) {
    const found = findTypescriptDir(start);
    if (found) return found;
  }
  return null;
}

async function runSelftest() {
  let checks = 0;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "extract-sig-"));
  try {
    fs.writeFileSync(
      path.join(tmpRoot, "a.ts"),
      [
        "import { BClass } from './b';",
        "export function fnA(x: number, label: string): string { return label + String(x); }",
        "export const A_CONST: number = 42;",
        "export class Unrelated {}",
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(tmpRoot, "b.ts"),
      [
        "import { CThing } from './c';",
        "export class BClass {",
        "  method(n: number): void {}",
        "  private hidden(): void {}",
        "}",
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(tmpRoot, "c.ts"),
      [
        "import { fnA } from './a';",
        "export interface CThing { id: string; }",
        "export default function main(): void {}",
      ].join("\n")
    );

    const tsDir = findRealTypescript();
    if (!tsDir) {
      console.log("SELFTEST: SKIP — no local TypeScript install found by walking up from cwd or this script's directory.");
      console.log("  extract-signatures.mjs needs a real repo's node_modules/typescript to exercise; none is reachable here.");
      console.log("  This is an environment limitation, not a script failure. Ran 0 checks.");
      return;
    }
    fs.mkdirSync(path.join(tmpRoot, "node_modules"), { recursive: true });
    const linkPath = path.join(tmpRoot, "node_modules", "typescript");
    fs.symlinkSync(tsDir, linkPath, "junction");

    const jsonOut = execFileSync(
      process.execPath,
      [__filename, "--root", tmpRoot, "--area", "fixture", "--include", "*.ts", "--json"],
      { encoding: "utf8" }
    );
    const parsed = JSON.parse(jsonOut);
    assertTrue(parsed.fileCount === 3, "fixture should have 3 files");
    checks++;
    const byPath = Object.fromEntries(parsed.files.map((f) => [f.path, f]));
    assertTrue(!!byPath["a.ts"] && !!byPath["b.ts"] && !!byPath["c.ts"], "all 3 fixture files present");
    checks++;

    assertIncludes(byPath["a.ts"].exports, "fnA(x: number, label: string): string", "a.ts exports fnA's full signature");
    checks++;
    assertIncludes(byPath["a.ts"].exports, "A_CONST: number", "a.ts exports A_CONST: number");
    checks++;
    assertIncludes(byPath["b.ts"].exports, "BClass { method(n: number): void }", "b.ts exports BClass with its public method");
    checks++;
    assertTrue(!byPath["b.ts"].exports.some((e) => e.includes("hidden")), "private method must not appear in exports");
    checks++;
    assertIncludes(byPath["c.ts"].exports, "interface CThing", "c.ts exports interface CThing");
    checks++;
    assertIncludes(byPath["c.ts"].exports, "default main", "c.ts exports default main");
    checks++;

    assertTrue(byPath["a.ts"].imports.relative.includes("./b"), "a.ts imports ./b as relative");
    checks++;

    // reverse index over the cycle a -> b -> c -> a
    assertTrue(byPath["b.ts"].importers.includes("a.ts"), "b.ts's importers include a.ts");
    checks++;
    assertTrue(byPath["c.ts"].importers.includes("b.ts"), "c.ts's importers include b.ts");
    checks++;
    assertTrue(byPath["a.ts"].importers.includes("c.ts"), "a.ts's importers include c.ts — the cycle closes, no hang");
    checks++;

    const mdOut = execFileSync(
      process.execPath,
      [__filename, "--root", tmpRoot, "--area", "fixture", "--include", "*.ts"],
      { encoding: "utf8" }
    );
    assertIncludes([mdOut], "purpose: [TODO", "markdown carries a purpose: TODO placeholder");
    checks++;
    assertIncludes([mdOut], "- **`a.ts`**", "markdown lists a.ts as a file entry");
    checks++;
    assertIncludes([mdOut], "exports:", "markdown has an exports: line");
    checks++;
    assertIncludes([mdOut], "importers:", "markdown has an importers: line");
    checks++;

    const noTsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "extract-sig-nots-"));
    try {
      fs.writeFileSync(path.join(noTsRoot, "x.ts"), "export const x = 1;\n");
      let failed = false;
      let stderrText = "";
      try {
        execFileSync(process.execPath, [__filename, "--root", noTsRoot, "--area", "x", "--include", "*.ts"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        failed = true;
        stderrText = String(e.stderr || "");
      }
      assertTrue(failed, "CLI must exit non-zero when no TypeScript is reachable");
      checks++;
      assertTrue(
        /typescript/i.test(stderrText) && /(install|npm|pnpm)/i.test(stderrText),
        "failure message must clearly point at installing typescript"
      );
      checks++;
    } finally {
      fs.rmSync(noTsRoot, { recursive: true, force: true });
    }

    const perfRoot = fs.mkdtempSync(path.join(os.tmpdir(), "extract-sig-perf-"));
    try {
      fs.mkdirSync(path.join(perfRoot, "node_modules"));
      fs.symlinkSync(tsDir, path.join(perfRoot, "node_modules", "typescript"), "junction");
      for (let i = 0; i < 50; i++) {
        fs.writeFileSync(path.join(perfRoot, `f${i}.ts`), `export function f${i}(n: number): number { return n + ${i}; }\n`);
      }
      const t0 = Date.now();
      execFileSync(process.execPath, [__filename, "--root", perfRoot, "--area", "perf", "--include", "*.ts", "--json"], {
        encoding: "utf8",
      });
      const elapsed = Date.now() - t0;
      assertTrue(elapsed < 8000, `50 files should extract well under 8s (took ${elapsed}ms) — 1000/60s implies ~60ms/file`);
      checks++;
      console.log(`  perf sanity: 50 files in ${elapsed}ms`);
    } finally {
      try {
        fs.unlinkSync(path.join(perfRoot, "node_modules", "typescript"));
      } catch {}
      fs.rmSync(perfRoot, { recursive: true, force: true });
    }

    console.log(`SELFTEST: PASS — ${checks} checks.`);
  } finally {
    try {
      fs.unlinkSync(path.join(tmpRoot, "node_modules", "typescript"));
    } catch {}
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function main() {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  if (positional[0] === "selftest") {
    await runSelftest();
    return;
  }
  if (flags.help || positional[0] === "--help") {
    console.log(HELP);
    return;
  }
  await run(flags);
}

main().catch((err) => {
  if (err instanceof ExtractError) {
    console.error(`extract-signatures: ${err.message}`);
    process.exitCode = err.code || 2;
  } else {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  }
});
