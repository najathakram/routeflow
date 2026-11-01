"use strict";
// Derives, from the specs themselves, which Jest specs read ANOTHER workspace's source (an api spec walking apps/web,
// a web test reading packages/ui). Such a spec is invisible to `jest --changedSince` (it follows imports, not fs
// reads) and to an affected-scope push when only the OTHER workspace changed, so each workspace's `test:repo-truth`
// lane runs the specs found here on every fast and affected push. One derived list, no hand-kept one: a new
// cross-workspace spec is on the lane the day it is written. CommonJS so a Jest config can `require` it.
//
// A spec counts when (comments stripped) ANY of these puts another workspace's directory in its reach:
//   rel   a relative path literal ("../../web/lib", an import, jest.mock, require) that, resolved against THE SPEC'S
//         OWN DIRECTORY, lands inside another workspace. Resolved, never matched by name: how deep the spec sits
//         decides where "../.." goes.
//   join  join/resolve(__dirname | process.cwd(), "..", ...) with literal segments, resolved the same way.
//   name  (needs an fs read) the directory named as one string ("apps/web", "packages/ui") or joined segments
//         ("apps", "web").
//   root  (needs an fs read) join/resolve(<variable>, "web", ...): a literal first segment equal to another
//         workspace's folder name under a root the detector cannot resolve (const APPS = path.join(ROOT, "apps")).
// Heuristic by design: a false positive costs a few seconds on the lane; a miss is what
// cross-workspace-lane.spec.ts's canaries, fixture rows and its "every spec is on a lane" check pin.
const fs = require("fs");
const path = require("path");

const SPEC_FILE = /\.(spec|test)\.[cm]?[tj]sx?$/;
// e2e = Playwright, not Jest; the rest are build output or dependencies.
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".expo", "coverage", "e2e", ".turbo"]);
const FS_READ = /\b(readFileSync|readdirSync|existsSync|statSync|readFile|readdir|globSync|glob)\b/;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Workspace directories ("apps/api", "packages/ui") from the root package.json `workspaces` globs. */
function workspaceDirs(root) {
  const globs = (readJson(path.join(root, "package.json")) || {}).workspaces || [];
  const dirs = [];
  for (const g of globs) {
    if (!g.endsWith("/*")) continue; // only the `<parent>/*` shape this repo uses
    const parent = g.slice(0, -2);
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, parent), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && fs.existsSync(path.join(root, parent, e.name, "package.json"))) {
        dirs.push(`${parent}/${e.name}`);
      }
    }
  }
  return dirs.sort();
}

/** Workspace dirs whose package.json defines `scripts[script]`, with their package names. */
function workspacesWithScript(root, script) {
  return workspaceDirs(root)
    .map((dir) => ({ dir, pkg: readJson(path.join(root, dir, "package.json")) || {} }))
    .filter((w) => w.pkg.scripts && w.pkg.scripts[script])
    .map((w) => ({ dir: w.dir, name: w.pkg.name }));
}

function walkSpecs(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkSpecs(path.join(dir, e.name), out);
    } else if (SPEC_FILE.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function namesDir(src, dir) {
  const [parent, name] = dir.split("/");
  const joined = `["'\`/\\\\]${parent}[/\\\\]${name}\\b`;
  const segments = `["']${parent}["'],\\s*["']${name}["']`;
  return new RegExp(`${joined}|${segments}`).test(src);
}

const STRING_LITERAL = /"([^"\n\\]*)"|'([^'\n\\]*)'|`([^`\n\\$]*)`/g;
const literalText = (m) => m[1] ?? m[2] ?? m[3] ?? "";
// join( / resolve( with its argument list (one level of nested parentheses is enough for path.join(x, f(y))).
const PATH_CALL = /\b(?:join|resolve)\(((?:[^()]|\([^()]*\))*)\)/g;

/** The workspace dir (of `dirs`) that the absolute path `abs` is inside, or null. Longest match wins. */
function owningDir(root, abs, dirs) {
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (rel.startsWith("..")) return null;
  return (
    dirs
      .filter((d) => rel === d || rel.startsWith(`${d}/`))
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}

/** Workspace dirs (other than `ws`) that `src`, a spec living in `specDir`, can reach. */
function reachedDirs(src, { root, ws, specDir, dirs, fsRead }) {
  const others = dirs.filter((d) => d !== ws);
  const reached = new Set();
  const add = (abs) => {
    const owner = owningDir(root, abs, dirs);
    if (owner && owner !== ws) reached.add(owner);
  };
  // rel: every relative literal, resolved against the spec's directory.
  for (const m of src.matchAll(STRING_LITERAL)) {
    const text = literalText(m);
    if (/^\.\.?([/\\]|$)/.test(text)) add(path.resolve(specDir, text));
  }
  const reads = fsRead ?? FS_READ.test(src);
  for (const call of src.matchAll(PATH_CALL)) {
    const args = call[1].split(",").map((a) => a.trim());
    const literals = (a) => {
      const m = [...a.matchAll(STRING_LITERAL)];
      return m.length === 1 && m[0][0] === a ? literalText(m[0]) : null;
    };
    const head = args[0];
    // join: __dirname / process.cwd() followed by literal segments up to the first non-literal.
    if (head === "__dirname" || head === "process.cwd()") {
      const segments = [];
      for (const a of args.slice(1)) {
        const l = literals(a);
        if (l === null) break;
        segments.push(l);
      }
      add(path.resolve(head === "__dirname" ? specDir : path.join(root, ws), ...segments));
    } else if (reads && literals(head) === null) {
      // root: a variable root, then a literal that starts with another workspace's folder name.
      for (const a of args.slice(1)) {
        const l = literals(a);
        if (l === null) continue;
        const first = l.split(/[/\\]/)[0];
        for (const o of others) if (first === o.split("/")[1]) reached.add(o);
      }
    }
  }
  if (reads) for (const o of others) if (namesDir(src, o)) reached.add(o);
  return [...reached].sort();
}

// A relative import (static, dynamic, require) in comment-stripped source.
const LOCAL_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"'\n]+)["']/g;
const IMPORT_EXTS = ["", ".ts", ".tsx", ".js", ".cjs", ".mjs", "/index.ts", "/index.js"];

// The paths a source file imports by relative specifier (extension not yet resolved), read once per run: a spec's
// helpers are shared by every spec beside it, and most imports leave the spec's tree and are never looked up.
function sourceOf(file, cache) {
  let src = cache.sources.get(file);
  if (src === undefined) {
    try {
      src = stripComments(fs.readFileSync(file, "utf8"));
    } catch {
      src = "";
    }
    cache.sources.set(file, src);
  }
  return src;
}

function importedPaths(file, cache) {
  const hit = cache.imports.get(file);
  if (hit) return hit;
  let out = [];
  try {
    const src = sourceOf(file, cache);
    out = [...src.matchAll(LOCAL_IMPORT)].map((m) => path.resolve(path.dirname(file), m[1]));
  } catch {
    /* unreadable: no imports */
  }
  cache.imports.set(file, out);
  return out;
}

/** The file an extension-less import path names (a.ts, a/index.ts, ...), or null. Memoised. */
function resolveImport(stem, cache) {
  if (cache.files.has(stem)) return cache.files.get(stem);
  let found = null;
  for (const ext of IMPORT_EXTS) {
    try {
      if (fs.statSync(stem + ext).isFile()) {
        found = stem + ext;
        break;
      }
    } catch {
      /* not this extension */
    }
  }
  cache.files.set(stem, found);
  return found;
}

/**
 * The non-spec source files a spec imports that live in its OWN directory tree (beside it or below it), followed
 * transitively: its helpers. copier-contract.spec.ts names no other workspace itself; the client files it checks are
 * listed in copier-registry.ts beside it. A module outside the spec's tree is production code, not a helper, and is
 * not followed (it would flag every spec that imports a service which mentions a path).
 */
function helperFiles(specFile, cache) {
  const base = path.dirname(specFile);
  const seen = new Set();
  const queue = [specFile];
  while (queue.length) {
    const from = queue.shift();
    for (const stem of importedPaths(from, cache)) {
      if (!(stem === base || stem.startsWith(base + path.sep))) continue; // outside the tree: not looked up
      const cand = resolveImport(stem, cache);
      if (!cand || SPEC_FILE.test(cand) || seen.has(cand)) continue;
      seen.add(cand);
      queue.push(cand);
    }
  }
  return [...seen];
}

/**
 * { "apps/api": [{ spec: "src/common/x.spec.ts", reads: ["apps/web"] }], ... } — spec paths are relative to
 * the workspace and use "/". A workspace with none is absent.
 */
function findCrossWorkspaceSpecs(root) {
  const dirs = workspaceDirs(root);
  const result = {};
  const cache = { sources: new Map(), imports: new Map(), files: new Map(), reached: new Map() };
  for (const ws of dirs) {
    const files = [];
    walkSpecs(path.join(root, ws), files);
    for (const file of files) {
      const src = sourceOf(file, cache);
      const reached = new Set(reachedDirs(src, { root, ws, specDir: path.dirname(file), dirs }));
      // Its helpers' paths count when the SPEC (or the helper) reads the filesystem.
      const specReads = FS_READ.test(src);
      for (const helper of helperFiles(file, cache)) {
        const key = `${helper}|${specReads}`;
        if (!cache.reached.has(key)) {
          const hsrc = sourceOf(helper, cache);
          const fsRead = specReads || FS_READ.test(hsrc);
          cache.reached.set(
            key,
            reachedDirs(hsrc, { root, ws, specDir: path.dirname(helper), dirs, fsRead }),
          );
        }
        for (const d of cache.reached.get(key)) reached.add(d);
      }
      const reads = [...reached].sort();
      if (!reads.length) continue;
      const spec = path.relative(path.join(root, ws), file).split(path.sep).join("/");
      (result[ws] = result[ws] || []).push({ spec, reads });
    }
    if (result[ws]) result[ws].sort((a, b) => a.spec.localeCompare(b.spec));
  }
  return result;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A Jest testRegex alternation matching exactly these workspace-relative spec paths (either slash). */
function specPathsRegex(specs) {
  return specs.map((s) => escapeRegex(s).replace(/\//g, "[/\\\\]") + "$").join("|");
}

module.exports = {
  workspaceDirs,
  workspacesWithScript,
  findCrossWorkspaceSpecs,
  specPathsRegex,
};
