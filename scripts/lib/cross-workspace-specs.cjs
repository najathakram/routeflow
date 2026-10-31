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
function reachedDirs(src, { root, ws, specDir, dirs }) {
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
  const reads = FS_READ.test(src);
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

/**
 * { "apps/api": [{ spec: "src/common/x.spec.ts", reads: ["apps/web"] }], ... } — spec paths are relative to
 * the workspace and use "/". A workspace with none is absent.
 */
function findCrossWorkspaceSpecs(root) {
  const dirs = workspaceDirs(root);
  const result = {};
  for (const ws of dirs) {
    const files = [];
    walkSpecs(path.join(root, ws), files);
    for (const file of files) {
      const src = stripComments(fs.readFileSync(file, "utf8"));
      const reads = reachedDirs(src, { root, ws, specDir: path.dirname(file), dirs });
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
